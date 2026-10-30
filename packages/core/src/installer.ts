import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import semver from 'semver';
import type { Manifest, PluginRecord, PluginSource } from './types.ts';
import type { HelmPaths } from './paths.ts';
import { ensureDirSync, pluginDataDir, readJsonSync, sha256File } from './paths.ts';
import type { StateStore } from './store.ts';
import type { AuditLog } from './audit.ts';
import type { SecretStore } from './permissions/secrets.ts';
import { HelmError, ErrorCode } from './errors.ts';
import { compatibilityProblem, formatProblems, readManifest } from './manifest/manifest.ts';
import type { ManifestProblem } from './manifest/manifest.ts';
import { buildGrants, consentItems, isNarrowerOrEqual, permissionDiff } from './permissions/grants.ts';
import type { ConsentItem, GrantDecision } from './permissions/grants.ts';
import { permissionDef } from './permissions/catalog.ts';
import { validateConfig } from './plugin-config.ts';
import type { HostConfig } from './types.ts';

export interface InstallerHost {
  paths: HelmPaths;
  state: StateStore;
  audit: AuditLog;
  secrets: SecretStore;
  config(): HostConfig;
  stopPlugin(id: string, reason: string): Promise<void>;
}

export interface RegistryEntry {
  id: string;
  name: string;
  description: string;
  version: string;
  source: string;
  tags?: string[];
  sha256?: string;
  /** Installed by `helm init` unless --only is given. */
  starter?: boolean;
  registry: string;
}

export interface InstallPlan {
  manifest: Manifest;
  dir: string;
  source: PluginSource;
  consent: ConsentItem[];
  existing?: PluginRecord;
  isUpdate: boolean;
  diff: ConsentItem[];
  warnings: ManifestProblem[];
  cleanup(): void;
}

// ------------------------------------------------------------------ registries
/** Registry-level defaults: which plugins `helm init` installs and which provider it prefers. */
export function registryDefaults(cfg: HostConfig): { starter: string[]; preferredProvider?: string } {
  const starter: string[] = [];
  let preferredProvider: string | undefined;
  for (const reg of cfg.registries) {
    if (/^https?:/.test(reg)) continue;
    const idx = readJsonSync<{ preferredProvider?: string; plugins?: Array<{ id: string; starter?: boolean }> }>(reg, {});
    preferredProvider ??= idx.preferredProvider;
    for (const e of idx.plugins ?? []) if (e.starter && !starter.includes(e.id)) starter.push(e.id);
  }
  return { starter, preferredProvider };
}

export function readRegistries(cfg: HostConfig): RegistryEntry[] {
  const out: RegistryEntry[] = [];
  for (const reg of cfg.registries) {
    if (/^https?:/.test(reg)) continue; // remote registries are fetched by `helm plugin search --refresh` (not needed for bundled)
    const idx = readJsonSync<{ plugins?: Array<Omit<RegistryEntry, 'registry'>> }>(reg, {});
    for (const e of idx.plugins ?? []) {
      out.push({ ...e, source: /^(https?:|git\+|file:)/.test(e.source) ? e.source : path.resolve(path.dirname(reg), e.source), registry: reg });
    }
  }
  return out;
}

export function searchRegistry(cfg: HostConfig, query = ''): Array<RegistryEntry & { permissions: string[] }> {
  const q = query.toLowerCase();
  const latest = new Map<string, RegistryEntry>();
  for (const e of readRegistries(cfg)) {
    const hay = `${e.id} ${e.name} ${e.description} ${(e.tags ?? []).join(' ')}`.toLowerCase();
    if (q && !hay.includes(q)) continue;
    const cur = latest.get(e.id);
    if (!cur || semver.gt(e.version, cur.version)) latest.set(e.id, e);
  }
  return [...latest.values()].map((e) => {
    // Read (never execute) the manifest so users see permissions before installing.
    const m = fs.existsSync(e.source) ? readManifest(e.source).manifest : undefined;
    return { ...e, permissions: (m?.permissions ?? []).map((p) => `${p.id}${p.scope ? `(${p.scope.join(',')})` : ''}${p.optional ? '?' : ''}`) };
  }).sort((a, b) => a.id.localeCompare(b.id));
}

function registryLookup(cfg: HostConfig, spec: string): RegistryEntry | undefined {
  const [id, range] = spec.split('@') as [string, string | undefined];
  const matches = readRegistries(cfg).filter((e) => e.id === id && (!range || semver.satisfies(e.version, range)));
  return matches.sort((a, b) => semver.rcompare(a.version, b.version))[0];
}

// ------------------------------------------------------------------ sources
function tmpDir(prefix: string) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function isGitSpec(s: string) {
  // Require URL syntax: an id such as "acme.git" is a plugin id, not a repository.
  return s.startsWith('git+') || s.startsWith('git@') || (/^(https?|ssh|file):\/\//.test(s) && s.endsWith('.git'));
}

/** Resolve an install spec into a local folder containing helm-plugin.json. */
async function materialize(cfg: HostConfig, spec: string, link: boolean): Promise<{ dir: string; source: PluginSource; cleanup(): void }> {
  const noop = () => {};
  const abs = path.resolve(spec);
  if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
    return { dir: abs, source: { type: link ? 'link' : 'dir', location: abs }, cleanup: noop };
  }
  if (fs.existsSync(abs) && /\.(tgz|tar\.gz)$/.test(abs)) {
    const t = tmpDir('helm-pkg-');
    const r = spawnSync('/usr/bin/tar', ['-xzf', abs, '-C', t], { encoding: 'utf8' });
    if (r.status !== 0) throw new HelmError(ErrorCode.INSTALL_FAILED, `Could not extract ${spec}: ${r.stderr.trim()}`);
    const inner = fs.existsSync(path.join(t, 'helm-plugin.json')) ? t : path.join(t, fs.readdirSync(t)[0] ?? '');
    return { dir: inner, source: { type: 'tgz', location: abs, sha256: await sha256File(abs) }, cleanup: () => fs.rmSync(t, { recursive: true, force: true }) };
  }
  if (isGitSpec(spec)) {
    const url = spec.replace(/^git\+/, '');
    const t = tmpDir('helm-git-');
    const r = spawnSync('git', ['clone', '--depth', '1', '--quiet', url, t], { encoding: 'utf8', timeout: 120_000 });
    if (r.status !== 0) throw new HelmError(ErrorCode.INSTALL_FAILED, `git clone failed: ${r.stderr.trim()}`);
    fs.rmSync(path.join(t, '.git'), { recursive: true, force: true });
    return { dir: t, source: { type: 'git', location: url }, cleanup: () => fs.rmSync(t, { recursive: true, force: true }) };
  }
  const entry = registryLookup(cfg, spec);
  if (entry) {
    const inner = await materialize(cfg, entry.source, false);
    if (entry.sha256 && inner.source.sha256 && entry.sha256 !== inner.source.sha256) {
      inner.cleanup();
      throw new HelmError(ErrorCode.INSTALL_FAILED, `Checksum mismatch for ${entry.id}@${entry.version}: the package does not match the registry`);
    }
    return { ...inner, source: { type: 'registry', location: entry.id, registry: entry.registry, sha256: inner.source.sha256 } };
  }
  throw new HelmError(ErrorCode.PLUGIN_NOT_FOUND, `"${spec}" is not a folder, a .tgz package, a git URL, or a plugin id in your registries`, { hint: 'Try `helm plugin search`.' });
}

// ------------------------------------------------------------------ install / update
export async function prepareInstall(host: InstallerHost, spec: string, opts: { link?: boolean } = {}): Promise<InstallPlan> {
  const mat = await materialize(host.config(), spec, !!opts.link);
  try {
    const { manifest, problems } = readManifest(mat.dir);
    if (!manifest) throw new HelmError(ErrorCode.MANIFEST_INVALID, `Invalid plugin manifest in ${spec}:\n${formatProblems(problems)}`, { details: problems });
    const compat = compatibilityProblem(manifest);
    if (compat) throw new HelmError(ErrorCode.INCOMPATIBLE_VERSION, `${manifest.id}@${manifest.version} ${compat}`);
    const existing = host.state.get(manifest.id);
    return {
      manifest, dir: mat.dir, source: mat.source, consent: consentItems(manifest), existing, isUpdate: !!existing,
      diff: existing ? permissionDiff(manifest, existing) : [], warnings: problems.filter((p) => p.severity === 'warning'), cleanup: mat.cleanup,
    };
  } catch (e) {
    mat.cleanup();
    throw e;
  }
}

function copyPlugin(src: string, dest: string) {
  fs.rmSync(dest, { recursive: true, force: true });
  ensureDirSync(path.dirname(dest));
  fs.cpSync(src, dest, {
    recursive: true,
    filter: (p) => !/(^|\/)(node_modules|\.git|__pycache__|\.DS_Store)(\/|$)/.test(path.relative(src, p)),
  });
}

/** Commit a fresh install. Required permissions that were declined leave the plugin installed but disabled. */
export async function commitInstall(host: InstallerHost, plan: InstallPlan, decisions: GrantDecision[], opts: { enable?: boolean } = {}): Promise<{ record: PluginRecord; notes: string[] }> {
  const m = plan.manifest;
  if (plan.existing) throw new HelmError(ErrorCode.INSTALL_FAILED, `${m.id} is already installed (${plan.existing.version}); use \`helm plugin update ${m.id}\``);
  const { grants, declined, errors } = buildGrants(m, decisions, m.version);
  const notes: string[] = [];
  const dest = plan.source.type === 'link' ? plan.dir : path.join(host.paths.plugins, m.id, m.version);
  if (plan.source.type !== 'link') copyPlugin(plan.dir, dest);
  plan.cleanup();
  const enabled = (opts.enable ?? true) && errors.length === 0;
  if (errors.length) notes.push(...errors, `${m.id} was installed but left disabled. Grant the permission and enable it: helm plugin grant ${m.id} <permission> && helm plugin enable ${m.id}`);
  const now = new Date().toISOString();
  const record: PluginRecord = {
    id: m.id, version: m.version, dir: dest, source: plan.source, enabled, trusted: false, installedAt: now, updatedAt: now,
    grants, declined, config: {}, health: { crashes: [] },
  };
  host.state.update((s) => { s.plugins[m.id] = record; });
  ensureDirSync(pluginDataDir(host.paths, m.id).files);
  host.audit.write({ plugin: m.id, kind: 'install', action: `installed ${m.version} from ${plan.source.type}:${plan.source.location}`, decision: 'info', reason: `granted: ${grants.map((g) => g.id).join(', ') || 'none'}; declined: ${declined.join(', ') || 'none'}` });
  for (const g of grants) host.audit.write({ plugin: m.id, kind: 'grant', action: 'granted at install', permission: g.id, target: g.scope?.join(', '), decision: 'allowed' });
  return { record, notes };
}

export async function prepareUpdate(host: InstallerHost, id: string, spec?: string): Promise<InstallPlan & { upToDate: boolean }> {
  const r = host.state.require(id);
  const s = spec ?? (r.source.type === 'registry' ? r.source.location : r.source.location);
  const plan = await prepareInstall(host, s, { link: r.source.type === 'link' });
  if (plan.manifest.id !== id) {
    plan.cleanup();
    throw new HelmError(ErrorCode.INSTALL_FAILED, `${s} contains ${plan.manifest.id}, not ${id}`);
  }
  const upToDate = !semver.gt(plan.manifest.version, r.version) && r.source.type !== 'link';
  return { ...plan, upToDate };
}

/** Apply an update: keep existing grants, ask only for the permission diff, keep the old version for rollback. */
export async function commitUpdate(host: InstallerHost, plan: InstallPlan, decisions: GrantDecision[]): Promise<{ record: PluginRecord; notes: string[] }> {
  const m = plan.manifest;
  const r = host.state.require(m.id);
  const notes: string[] = [];
  const dest = plan.source.type === 'link' ? plan.dir : path.join(host.paths.plugins, m.id, m.version);
  await host.stopPlugin(m.id, 'updating');
  if (plan.source.type !== 'link' && path.resolve(dest) !== path.resolve(r.dir)) copyPlugin(plan.dir, dest);
  plan.cleanup();
  // Copies: r.grants becomes the rollback snapshot and must not change.
  const kept = r.grants.filter((g) => (m.permissions ?? []).some((p) => p.id === g.id)).map((g) => ({ ...g, scope: g.scope ? [...g.scope] : undefined }));
  const dropped = r.grants.filter((g) => !kept.some((k) => k.id === g.id)).map((g) => g.id);
  if (dropped.length) notes.push(`Permissions no longer requested were removed: ${dropped.join(', ')}`);
  // A release that asks for less gets less: narrow kept grants to the new declared scope
  // (unless the user is allowed to extend that scope themselves).
  for (const g of kept) {
    const p = (m.permissions ?? []).find((x) => x.id === g.id)!;
    const kind = permissionDef(g.id)?.scopeKind ?? 'none';
    if (!g.scope || !p.scope || p.userExtensible || kind === 'none') continue;
    const next = Array.from(new Set([...g.scope.filter((s) => isNarrowerOrEqual(s, p.scope!, kind)), ...p.scope.filter((s) => isNarrowerOrEqual(s, g.scope!, kind))]));
    if (next.length !== g.scope.length || next.some((s) => !g.scope!.includes(s))) {
      notes.push(`Narrowed "${g.id}" to what ${m.version} declares: ${next.join(', ') || '(nothing)'}`);
      g.scope = next;
    }
  }
  const grants = [...kept];
  const declined = [...r.declined];
  for (const item of plan.diff) {
    const d = decisions.find((x) => x.id === item.id);
    const existing = grants.find((g) => g.id === item.id);
    if (d?.granted) {
      const scope = d.scope ?? item.scope;
      if (existing) existing.scope = Array.from(new Set([...(existing.scope ?? []), ...(scope ?? [])]));
      else grants.push({ id: item.id, scope: permissionDef(item.id)?.scopeKind === 'none' ? undefined : scope, mode: d.mode ?? 'allow', grantedAt: new Date().toISOString(), version: m.version });
      const i = declined.indexOf(item.id);
      if (i >= 0) declined.splice(i, 1);
    } else if (!existing) {
      declined.push(item.id);
      if (!item.optional) notes.push(`${m.id}@${m.version} requires "${item.id}"; without it the plugin is disabled.`);
    } else {
      notes.push(`Kept the previous "${item.id}" scope (${(existing.scope ?? []).join(', ')}); the new scope was not granted.`);
    }
  }
  const missingRequired = (m.permissions ?? []).filter((p) => !p.optional && !grants.some((g) => g.id === p.id));
  const cfgProblems = validateConfig(m, r.config);
  if (cfgProblems.length) notes.push(`Your saved config is not valid for ${m.version}: ${cfgProblems.join('; ')}. Fix it with \`helm plugin config ${m.id}\`.`);
  host.state.patch(m.id, (rec) => {
    rec.previous = { version: r.version, dir: r.dir, grants: r.grants, config: r.config, source: r.source };
    rec.version = m.version;
    rec.dir = dest;
    rec.source = plan.source;
    rec.grants = grants;
    rec.declined = Array.from(new Set(declined));
    rec.health = { crashes: [] };
    if (missingRequired.length) rec.enabled = false;
    // Trust covers the code the user reviewed, not whatever replaces it.
    if (rec.trusted && plan.source.type !== 'link') rec.trusted = false;
  });
  if (r.trusted && plan.source.type !== 'link') notes.push(`Trust was reset because the code changed; review ${m.version} and run \`helm plugin trust ${m.id}\` again if you still want it to run without the full sandbox.`);
  host.audit.write({ plugin: m.id, kind: 'install', action: `updated ${r.version} → ${m.version}`, decision: 'info', reason: plan.diff.length ? `permission changes: ${plan.diff.map((d) => `${d.id}(${d.change})`).join(', ')}` : 'no permission changes' });
  return { record: host.state.require(m.id), notes };
}

export async function rollback(host: InstallerHost, id: string) {
  const r = host.state.require(id);
  if (!r.previous) throw new HelmError(ErrorCode.INSTALL_FAILED, `${id} has no previous version to roll back to`);
  if (!fs.existsSync(r.previous.dir)) throw new HelmError(ErrorCode.INSTALL_FAILED, `The previous version folder ${r.previous.dir} is gone`);
  await host.stopPlugin(id, 'rolling back');
  const prev = r.previous;
  host.state.patch(id, (rec) => {
    rec.previous = { version: rec.version, dir: rec.dir, grants: rec.grants, config: rec.config, source: rec.source };
    rec.version = prev.version;
    if (prev.source) rec.source = prev.source;
    rec.dir = prev.dir;
    rec.grants = prev.grants;
    rec.config = prev.config;
    rec.health = { crashes: [] };
    if (rec.source.type !== 'link') rec.trusted = false;
  });
  host.audit.write({ plugin: id, kind: 'install', action: `rolled back ${r.version} → ${prev.version}`, decision: 'info' });
  return host.state.require(id);
}

export async function uninstall(host: InstallerHost, id: string, opts: { purge?: boolean } = {}) {
  const r = host.state.require(id);
  await host.stopPlugin(id, 'uninstalling');
  host.state.update((s) => { delete s.plugins[id]; });
  if (r.source.type !== 'link') fs.rmSync(path.join(host.paths.plugins, id), { recursive: true, force: true });
  if (opts.purge) {
    fs.rmSync(pluginDataDir(host.paths, id).root, { recursive: true, force: true });
    for (const n of host.secrets.list(id)) host.secrets.delete(id, n);
  }
  host.audit.write({ plugin: id, kind: 'install', action: `uninstalled ${r.version}${opts.purge ? ' (data and secrets purged)' : ''}`, decision: 'info' });
}

// ------------------------------------------------------------------ grants
export async function grant(host: InstallerHost, m: Manifest, id: string, permission: string, opts: { scope?: string[]; mode?: 'allow' | 'ask' } = {}) {
  const req = (m.permissions ?? []).find((p) => p.id === permission);
  if (!req) throw new HelmError(ErrorCode.PERMISSION_DENIED, `${id} does not declare "${permission}", so it cannot be granted`, { hint: `Declared: ${(m.permissions ?? []).map((p) => p.id).join(', ') || 'none'}` });
  const def = permissionDef(permission)!;
  let scope = def.scopeKind === 'none' ? undefined : opts.scope ?? req.scope;
  if (scope && req.scope && !req.userExtensible) {
    const { errors } = buildGrants({ ...m, permissions: [req] }, [{ id: permission, granted: true, scope }], m.version);
    if (errors.length) throw new HelmError(ErrorCode.PERMISSION_DENIED, errors.join('; '), { hint: 'You can only narrow a declared scope for this permission.' });
  }
  host.state.patch(id, (r) => {
    const g = r.grants.find((x) => x.id === permission);
    if (g) {
      if (scope) g.scope = opts.scope ? Array.from(new Set([...(g.scope ?? []), ...scope])) : scope;
      if (opts.mode) g.mode = opts.mode;
    } else r.grants.push({ id: permission, scope, mode: opts.mode ?? 'allow', grantedAt: new Date().toISOString(), version: m.version });
    r.declined = r.declined.filter((d) => d !== permission);
  });
  host.audit.write({ plugin: id, kind: 'grant', action: 'granted by user', permission, target: scope?.join(', '), decision: 'allowed' });
  await host.stopPlugin(id, 'permissions changed');
}

export async function revoke(host: InstallerHost, id: string, permission: string, opts: { scope?: string[] } = {}) {
  let removed = false;
  host.state.patch(id, (r) => {
    const g = r.grants.find((x) => x.id === permission);
    if (!g) return;
    removed = true;
    if (opts.scope?.length && g.scope) {
      g.scope = g.scope.filter((s) => !opts.scope!.includes(s));
      if (g.scope.length === 0) r.grants = r.grants.filter((x) => x !== g);
    } else r.grants = r.grants.filter((x) => x !== g);
    if (!r.grants.some((x) => x.id === permission)) r.declined = Array.from(new Set([...r.declined.filter((d) => d !== permission)]));
  });
  if (!removed) throw new HelmError(ErrorCode.PERMISSION_DENIED, `${id} has no "${permission}" grant to revoke`);
  host.audit.write({ plugin: id, kind: 'revoke', action: 'revoked by user', permission, target: opts.scope?.join(', '), decision: 'denied' });
  // Restart so the OS sandbox profile and Node permission flags shrink too, not just broker checks.
  await host.stopPlugin(id, 'permissions changed');
}
