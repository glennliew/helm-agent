import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

/** Root of the Helm source tree (used to locate the SDKs, templates and bundled registry). */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const SDK_NODE_DIR = path.join(REPO_ROOT, 'packages/sdk-node/src');
export const SDK_PYTHON_DIR = path.join(REPO_ROOT, 'packages/sdk-python');
export const TEMPLATES_DIR = path.join(REPO_ROOT, 'templates');
export const BUNDLED_REGISTRY = path.join(REPO_ROOT, 'registry/index.json');
export const HOST_VERSION = '0.1.0';
export const PROTOCOL_VERSION = '1.0';

export interface HelmPaths {
  home: string;
  config: string;
  state: string;
  lock: string;
  audit: string;
  plugins: string;
  data: string;
  logs: string;
  sessions: string;
  sandbox: string;
  secretsFile: string;
  secretsKey: string;
}

export function resolveHome(explicit?: string): string {
  const raw = explicit ?? process.env.HELM_AGENT_HOME ?? path.join(os.homedir(), '.helm-agent');
  return path.resolve(raw);
}

export function helmPaths(home: string): HelmPaths {
  return {
    home,
    config: path.join(home, 'config.json'),
    state: path.join(home, 'state.json'),
    lock: path.join(home, 'state.lock'),
    audit: path.join(home, 'audit.jsonl'),
    plugins: path.join(home, 'plugins'),
    data: path.join(home, 'data'),
    logs: path.join(home, 'logs'),
    sessions: path.join(home, 'sessions'),
    sandbox: path.join(home, 'sandbox'),
    secretsFile: path.join(home, 'secrets.json'),
    secretsKey: path.join(home, 'secrets.key'),
  };
}

export function pluginDataDir(paths: HelmPaths, id: string) {
  const root = path.join(paths.data, id);
  return { root, files: path.join(root, 'files'), home: path.join(root, 'home'), tmp: path.join(root, 'tmp'), storage: path.join(root, 'storage.json') };
}

export function ensureDirSync(dir: string, mode = 0o700) {
  fs.mkdirSync(dir, { recursive: true, mode });
}

export function readJsonSync<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
    throw e;
  }
}

/** Write JSON atomically: temp file + fsync + rename, so readers never see a torn file. */
export function writeJsonAtomicSync(file: string, value: unknown, mode = 0o600) {
  ensureDirSync(path.dirname(file));
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  const fd = fs.openSync(tmp, 'w', mode);
  try {
    fs.writeSync(fd, JSON.stringify(value, null, 2) + '\n');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

/**
 * Cross-process lock based on O_EXCL lock files. Stale locks (dead pid or older than 30 s)
 * are broken automatically so a crashed CLI never wedges the store.
 */
export function withLockSync<T>(lockFile: string, fn: () => T, timeoutMs = 10_000): T {
  ensureDirSync(path.dirname(lockFile));
  const start = Date.now();
  for (;;) {
    try {
      const fd = fs.openSync(lockFile, 'wx', 0o600);
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
      fs.closeSync(fd);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      if (isStaleLock(lockFile)) {
        try { fs.unlinkSync(lockFile); } catch { /* raced */ }
        continue;
      }
      if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for lock ${lockFile}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15);
    }
  }
  try {
    return fn();
  } finally {
    try { fs.unlinkSync(lockFile); } catch { /* already gone */ }
  }
}

function isStaleLock(lockFile: string): boolean {
  try {
    const info = JSON.parse(fs.readFileSync(lockFile, 'utf8')) as { pid: number; at: number };
    if (Date.now() - info.at > 30_000) return true;
    try { process.kill(info.pid, 0); return false; } catch (e) { return (e as NodeJS.ErrnoException).code === 'ESRCH'; }
  } catch {
    return true;
  }
}

export async function sha256File(file: string): Promise<string> {
  const h = crypto.createHash('sha256');
  h.update(await fsp.readFile(file));
  return h.digest('hex');
}

export function shortId(n = 8) {
  return crypto.randomBytes(n).toString('base64url').slice(0, n);
}

/** Resolve symlinks for as much of the path as exists, then re-append the missing tail. */
export function realpathLoose(p: string): string {
  const abs = path.resolve(p);
  let cur = abs;
  const tail: string[] = [];
  for (;;) {
    try {
      const real = fs.realpathSync.native(cur);
      return tail.length ? path.join(real, ...tail.reverse()) : real;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return abs;
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
}

export function isWithin(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export function tailLines(text: string, n: number): string[] {
  const lines = text.split('\n').filter((l) => l.length > 0);
  return lines.slice(-n);
}
