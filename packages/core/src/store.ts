import fs from 'node:fs';
import type { HostConfig, PluginRecord, StateFile } from './types.ts';
import { BUNDLED_REGISTRY, ensureDirSync, helmPaths, readJsonSync, withLockSync, writeJsonAtomicSync } from './paths.ts';
import type { HelmPaths } from './paths.ts';
import { HelmError, ErrorCode } from './errors.ts';

const EMPTY_STATE: StateFile = { version: 1, plugins: {} };

/**
 * Plugin state shared by every Helm process (CLI, web console, chat sessions).
 * Reads are lock-free (atomic renames guarantee whole files); writes take a lock.
 */
export class StateStore {
  readonly paths: HelmPaths;
  constructor(paths: HelmPaths) {
    this.paths = paths;
  }

  read(): StateFile {
    const s = readJsonSync<StateFile>(this.paths.state, EMPTY_STATE);
    return { version: 1, plugins: s.plugins ?? {} };
  }

  get(id: string): PluginRecord | undefined {
    return this.read().plugins[id];
  }

  require(id: string): PluginRecord {
    const r = this.get(id);
    if (!r) throw new HelmError(ErrorCode.PLUGIN_NOT_FOUND, `Plugin "${id}" is not installed`);
    return r;
  }

  list(): PluginRecord[] {
    return Object.values(this.read().plugins).sort((a, b) => a.id.localeCompare(b.id));
  }

  update<T>(fn: (s: StateFile) => T): T {
    return withLockSync(this.paths.lock, () => {
      const s = this.read();
      const out = fn(s);
      writeJsonAtomicSync(this.paths.state, s);
      return out;
    });
  }

  patch(id: string, fn: (r: PluginRecord) => void) {
    this.update((s) => {
      const r = s.plugins[id];
      if (!r) throw new HelmError(ErrorCode.PLUGIN_NOT_FOUND, `Plugin "${id}" is not installed`);
      fn(r);
      r.updatedAt = new Date().toISOString();
    });
  }

  /** mtime used by long-lived processes to notice changes made by other processes. */
  stamp(): number {
    try { return fs.statSync(this.paths.state).mtimeMs; } catch { return 0; }
  }
}

export function defaultConfig(): HostConfig {
  return {
    approvals: { read: 'allow', external: 'allow', write: 'ask', exec: 'ask' },
    security: { requireStrictIsolation: true },
    agent: { maxSteps: 16, maxToolOutputChars: 64_000 },
    registries: [BUNDLED_REGISTRY],
    secrets: { backend: process.platform === 'darwin' ? 'keychain' : 'file' },
  };
}

export class ConfigStore {
  readonly paths: HelmPaths;
  constructor(paths: HelmPaths) {
    this.paths = paths;
  }
  read(): HostConfig {
    const d = defaultConfig();
    const c = readJsonSync<Partial<HostConfig>>(this.paths.config, {});
    return {
      ...d, ...c,
      approvals: { ...d.approvals, ...(c.approvals ?? {}) },
      security: { ...d.security, ...(c.security ?? {}) },
      agent: { ...d.agent, ...(c.agent ?? {}) },
      registries: c.registries ?? d.registries,
      secrets: { ...d.secrets, ...(c.secrets ?? {}) },
    };
  }
  exists() {
    return fs.existsSync(this.paths.config);
  }
  write(c: HostConfig) {
    writeJsonAtomicSync(this.paths.config, c);
  }
  update(fn: (c: HostConfig) => void) {
    const c = this.read();
    fn(c);
    this.write(c);
    return c;
  }
}

/** Create the HELM_AGENT_HOME layout. Idempotent. */
export function initHome(home: string, overrides: Partial<HostConfig> = {}): HelmPaths {
  const p = helmPaths(home);
  for (const d of [p.home, p.plugins, p.data, p.logs, p.sessions, p.sandbox]) ensureDirSync(d);
  const cfg = new ConfigStore(p);
  if (!cfg.exists()) cfg.write({ ...defaultConfig(), ...overrides });
  if (!fs.existsSync(p.state)) writeJsonAtomicSync(p.state, EMPTY_STATE);
  return p;
}

/** Read nested config values with dotted keys, e.g. "approvals.write". */
export function getDotted(obj: unknown, key: string): unknown {
  return key.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), obj);
}

export function setDotted(obj: Record<string, unknown>, key: string, value: unknown) {
  const parts = key.split('.');
  let o: Record<string, unknown> = obj;
  for (const k of parts.slice(0, -1)) {
    if (!o[k] || typeof o[k] !== 'object') o[k] = {};
    o = o[k] as Record<string, unknown>;
  }
  const last = parts.at(-1)!;
  if (value === undefined) delete o[last];
  else o[last] = value;
}

/** Parse a CLI string into JSON when possible ("true" → true, "42" → 42, '["a"]' → array). */
export function parseCliValue(v: string): unknown {
  try { return JSON.parse(v); } catch { return v; }
}
