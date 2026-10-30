import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { Manifest, PluginRecord } from '../types.ts';
import type { HelmPaths } from '../paths.ts';
import { PROTOCOL_VERSION, SDK_NODE_DIR, SDK_PYTHON_DIR, ensureDirSync, pluginDataDir, realpathLoose } from '../paths.ts';
import { resolvedPaths } from '../permissions/grants.ts';

export type Isolation = 'strict' | 'runtime' | 'basic';

export interface LaunchSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  isolation: Isolation;
  profilePath?: string;
  layers: string[];
}

let sandboxProbe: { available: boolean; reason?: string } | undefined;

/** Can we apply a macOS sandbox profile from this process? (Fails when already inside a sandbox.) */
export function sandboxAvailability(): { available: boolean; reason?: string } {
  if (process.env.HELM_FORCE_NO_SANDBOX === '1') return { available: false, reason: 'disabled by HELM_FORCE_NO_SANDBOX' };
  if (sandboxProbe) return sandboxProbe;
  if (process.platform !== 'darwin') sandboxProbe = { available: false, reason: `OS sandbox is only implemented for macOS (this is ${process.platform})` };
  else if (!fs.existsSync('/usr/bin/sandbox-exec')) sandboxProbe = { available: false, reason: '/usr/bin/sandbox-exec not found' };
  else {
    const r = spawnSync('/usr/bin/sandbox-exec', ['-p', '(version 1)(allow default)', '/usr/bin/true'], { encoding: 'utf8', timeout: 5000 });
    sandboxProbe = r.status === 0
      ? { available: true }
      : { available: false, reason: /Operation not permitted/.test(r.stderr) ? 'sandbox_apply was refused — Helm itself is running inside another sandbox (e.g. an IDE or agent terminal)' : `sandbox-exec failed: ${r.stderr.trim() || r.status}` };
  }
  return sandboxProbe;
}

export function resetSandboxProbe() {
  sandboxProbe = undefined;
}

const runtimeCache = new Map<string, { exe: string; prefix: string; version: string }>();

export function nodeRuntime() {
  const exe = realpathLoose(process.execPath);
  return { exe, prefix: path.dirname(path.dirname(exe)), version: process.versions.node };
}

export function pythonRuntime(): { exe: string; prefix: string; version: string } | undefined {
  const cached = runtimeCache.get('python');
  if (cached) return cached;
  const candidates = [process.env.HELM_PYTHON, 'python3'].filter(Boolean) as string[];
  for (const c of candidates) {
    const r = spawnSync(c, ['-c', 'import sys,json;print(json.dumps([sys.executable,sys.base_prefix,"%d.%d.%d"%sys.version_info[:3]]))'], { encoding: 'utf8', timeout: 5000 });
    if (r.status === 0) {
      const [exe, prefix, version] = JSON.parse(r.stdout) as [string, string, string];
      const info = { exe, prefix: realpathLoose(prefix), version };
      runtimeCache.set('python', info);
      return info;
    }
  }
  return undefined;
}

const sb = (s: string) => JSON.stringify(s); // SBPL string literal (same escaping rules as JSON for our paths)

export interface ProfileInput {
  readPaths: string[];
  writePaths: string[];
  execPrefixes: string[] | 'any';
}

/**
 * Generate a sandbox profile. Rules are last-match-wins, so we first deny broad areas and then
 * re-allow exactly what the grants permit. Direct network sockets are always denied: plugins
 * reach the network only through the host broker, which enforces host allowlists.
 */
export function buildProfile(input: ProfileInput): string {
  const home = os.homedir();
  const sensitive = [home, '/Volumes', '/private/var/folders', '/private/tmp', '/Users'];
  const lines = [
    '(version 1)',
    '(allow default)',
    ';; No direct network access: use the host broker (host/net.fetch).',
    '(deny network*)',
    ';; Reading user data is denied except for granted paths.',
    `(deny file-read-data ${sensitive.map((p) => `(subpath ${sb(p)})`).join(' ')})`,
  ];
  if (input.readPaths.length) lines.push(`(allow file-read-data ${input.readPaths.map((p) => `(subpath ${sb(p)})`).join(' ')})`);
  lines.push(';; Writes only to the plugin data folder and granted paths.', '(deny file-write*)');
  lines.push(`(allow file-write* (literal "/dev/null") (literal "/dev/zero") (literal "/dev/tty") (regex #"^/dev/fd/")${input.writePaths.map((p) => ` (subpath ${sb(p)})`).join('')})`);
  if (input.execPrefixes !== 'any') {
    lines.push(';; Only the plugin runtime itself may be executed.', '(deny process-exec*)');
    lines.push(`(allow process-exec ${input.execPrefixes.map((p) => `(subpath ${sb(p)})`).join(' ')})`);
  }
  return lines.join('\n') + '\n';
}

export interface LaunchInput {
  manifest: Manifest;
  record: PluginRecord;
  paths: HelmPaths;
  workspace: string;
  memoryMb: number;
}

export function pluginEnv(paths: HelmPaths, id: string, extra: Record<string, string> = {}): Record<string, string> {
  const d = pluginDataDir(paths, id);
  return {
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    HOME: d.home,
    TMPDIR: d.tmp + '/',
    LANG: 'en_US.UTF-8',
    LC_ALL: 'en_US.UTF-8',
    HELM_PLUGIN_ID: id,
    HELM_PLUGIN_DATA: d.files,
    HELM_PROTOCOL: PROTOCOL_VERSION,
    ...extra,
  };
}

/** Build the exact command line for a plugin, wrapping it in the strongest isolation available. */
export function buildLaunch(input: LaunchInput): LaunchSpec {
  const { manifest: m, record: r, paths, workspace } = input;
  const d = pluginDataDir(paths, m.id);
  for (const dir of [d.root, d.files, d.home, d.tmp]) ensureDirSync(dir);
  const ctx = { workspace, pluginData: d.files };
  const reads = resolvedPaths(r, 'fs.read', ctx);
  const writes = resolvedPaths(r, 'fs.write', ctx);
  const pluginDir = realpathLoose(r.dir);
  const sandbox = sandboxAvailability();
  const layers: string[] = ['broker', 'env-scrub', 'limits'];
  let command: string;
  let args: string[];
  let execPrefixes: string[] = [];
  const env = pluginEnv(paths, m.id);
  const baseReads = [pluginDir, realpathLoose(d.root)];

  if (m.runtime.type === 'node') {
    const node = nodeRuntime();
    const sdkRoot = realpathLoose(path.dirname(SDK_NODE_DIR));
    command = node.exe;
    const fsRead = [...baseReads, sdkRoot, ...reads, ...writes];
    const fsWrite = [realpathLoose(d.root), ...writes];
    args = [
      '--permission',
      ...fsRead.map((p) => `--allow-fs-read=${p}`),
      ...fsWrite.map((p) => `--allow-fs-write=${p}`),
      `--max-old-space-size=${input.memoryMb}`,
      '--disable-warning=ExperimentalWarning',
      '--no-deprecation',
      path.join(SDK_NODE_DIR, 'bootstrap.ts'),
      path.join(pluginDir, m.runtime.entry!),
    ];
    baseReads.push(sdkRoot);
    execPrefixes = [node.prefix];
    layers.unshift('node-permission-model');
  } else if (m.runtime.type === 'python') {
    const py = pythonRuntime();
    if (!py) throw new Error('No Python 3 interpreter found (set HELM_PYTHON to its path)');
    command = py.exe;
    args = ['-u', '-s', '-B', path.join(pluginDir, m.runtime.entry!)];
    Object.assign(env, { PYTHONPATH: realpathLoose(SDK_PYTHON_DIR), PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1', PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' });
    baseReads.push(realpathLoose(SDK_PYTHON_DIR));
    execPrefixes = [py.prefix, path.dirname(realpathLoose(py.exe))];
  } else {
    const [cmd, ...rest] = m.runtime.command!;
    command = path.isAbsolute(cmd!) ? cmd! : path.resolve(pluginDir, cmd!);
    args = rest;
    execPrefixes = [pluginDir];
  }

  let isolation: Isolation = m.runtime.type === 'node' ? 'runtime' : 'basic';
  let profilePath: string | undefined;
  if (sandbox.available) {
    const profile = buildProfile({ readPaths: [...new Set([...baseReads, ...execPrefixes, ...reads, ...writes])], writePaths: [realpathLoose(d.root), ...writes], execPrefixes });
    ensureDirSync(paths.sandbox);
    profilePath = path.join(paths.sandbox, `${m.id}.sb`);
    fs.writeFileSync(profilePath, profile, { mode: 0o600 });
    args = ['-f', profilePath, command, ...args];
    command = '/usr/bin/sandbox-exec';
    isolation = 'strict';
    layers.unshift('macos-sandbox');
  }
  return { command, args, env, cwd: d.home, isolation, profilePath, layers };
}

/** Isolation level a plugin would get on this machine, without launching it. */
export function expectedIsolation(m: Manifest): { level: Isolation; reason?: string } {
  const s = sandboxAvailability();
  if (s.available) return { level: 'strict' };
  return { level: m.runtime.type === 'node' ? 'runtime' : 'basic', reason: s.reason };
}

/** Wrap an allowlisted child program (process.exec) in a sandbox derived from the plugin's grants. */
export function buildChildLaunch(opts: { exe: string; args: string[]; record: PluginRecord; paths: HelmPaths; workspace: string; id: string }) {
  const d = pluginDataDir(opts.paths, opts.id);
  const ctx = { workspace: opts.workspace, pluginData: d.files };
  const reads = resolvedPaths(opts.record, 'fs.read', ctx);
  const writes = resolvedPaths(opts.record, 'fs.write', ctx);
  if (!sandboxAvailability().available) return { command: opts.exe, args: opts.args, sandboxed: false };
  const profile = buildProfile({
    readPaths: [...new Set([realpathLoose(d.root), ...reads, ...writes, '/private/var/folders'])],
    writePaths: [realpathLoose(d.root), ...writes, '/private/var/folders'],
    execPrefixes: 'any',
  });
  const profilePath = path.join(opts.paths.sandbox, `${opts.id}.child.sb`);
  fs.writeFileSync(profilePath, profile, { mode: 0o600 });
  return { command: '/usr/bin/sandbox-exec', args: ['-f', profilePath, opts.exe, ...opts.args], sandboxed: true };
}
