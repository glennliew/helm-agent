import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { HelmPaths } from '../paths.ts';
import { pluginDataDir, readJsonSync, writeJsonAtomicSync } from '../paths.ts';
import type { HostConfig, Manifest, PluginRecord } from '../types.ts';
import type { StateStore } from '../store.ts';
import type { AuditLog, HostBus } from '../audit.ts';
import type { SecretStore } from './secrets.ts';
import { redactor } from './secrets.ts';
import { HelmError, ErrorCode } from '../errors.ts';
import { checkPath, resolvePathScope } from './catalog.ts';
import type { ScopeContext } from './catalog.ts';
import { findGrant } from './grants.ts';
import { brokerFetch } from '../host-api/net.ts';
import type { NetTransport } from '../host-api/net.ts';
import { buildChildLaunch } from '../runtime/launch.ts';

export interface ApprovalRequest {
  kind: 'tool' | 'permission';
  plugin: string;
  title: string;
  detail: string;
  tool?: string;
  permission?: string;
  target?: string;
  sessionId?: string;
}
export type ApprovalDecision = 'allow' | 'deny' | 'always';
export interface Approver {
  request(req: ApprovalRequest): Promise<ApprovalDecision>;
}

export const denyAllApprover: Approver = { request: async () => 'deny' };
export const allowAllApprover: Approver = { request: async () => 'allow' };

export interface BrokerHost {
  paths: HelmPaths;
  state: StateStore;
  config(): HostConfig;
  secrets: SecretStore;
  audit: AuditLog;
  bus: HostBus;
  workspace: string;
  approver: Approver;
  netTransport?: NetTransport;
  llmComplete?(pluginId: string, params: { messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>; maxTokens?: number }): Promise<{ content: string; model?: string }>;
  pluginEvent?(pluginId: string, name: string, payload: unknown): void;
}

const MAX_READ = 2 * 1024 * 1024;
const MAX_STORAGE = 5 * 1024 * 1024;

class Bucket {
  private tokens: number;
  private last = Date.now();
  private rate: number;
  private burst: number;
  constructor(rate: number, burst: number) {
    this.rate = rate;
    this.burst = burst;
    this.tokens = burst;
  }
  take(): boolean {
    const now = Date.now();
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.rate);
    this.last = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

/**
 * Implements every `host/*` method for one plugin. Each call re-reads the plugin's grants from
 * the shared state, so a revoke from another Helm process takes effect on the very next call.
 */
export class Broker {
  private host: BrokerHost;
  private id: string;
  private manifest: Manifest;
  private bucket = new Bucket(2000, 4000);
  private sessionAllow = new Set<string>();
  sessionId?: string;

  constructor(host: BrokerHost, manifest: Manifest) {
    this.host = host;
    this.id = manifest.id;
    this.manifest = manifest;
  }

  private record(): PluginRecord {
    const r = this.host.state.get(this.id);
    if (!r) throw new HelmError(ErrorCode.PLUGIN_NOT_FOUND, `${this.id} is no longer installed`);
    return r;
  }

  private ctx(): ScopeContext {
    return { workspace: this.host.workspace, pluginData: pluginDataDir(this.host.paths, this.id).files };
  }

  private audit(action: string, permission: string | undefined, target: string | undefined, decision: 'allowed' | 'denied', reason?: string) {
    this.host.audit.write({ plugin: this.id, kind: 'broker', action, permission, target, decision, reason, session: this.sessionId });
  }

  /** Throws PERMISSION_DENIED/REVOKED unless granted (prompting the user for "ask" grants). */
  private async require(permission: string, action: string, target: string, scopeOk?: (scope: string[]) => boolean) {
    const r = this.record();
    const g = findGrant(r, permission);
    const declared = (this.manifest.permissions ?? []).some((p) => p.id === permission);
    if (!g) {
      const why = !declared ? `${this.id} did not declare "${permission}"` : r.declined.includes(permission) ? `you declined "${permission}" for ${this.id}` : `"${permission}" is not granted (it may have been revoked)`;
      this.audit(action, permission, target, 'denied', why);
      throw new HelmError(declared && !r.declined.includes(permission) ? ErrorCode.PERMISSION_REVOKED : ErrorCode.PERMISSION_DENIED, `Permission denied: ${why}`, { details: { permission, target } });
    }
    if (scopeOk && !scopeOk(g.scope ?? [])) {
      const shown = (g.scope ?? []).map((s) => (s.includes('${') ? `${s} = ${resolvePathScope(s, this.ctx())}` : s));
      const why = `${target} is outside the granted ${permission} scope (${shown.join(', ') || 'none'})`;
      this.audit(action, permission, target, 'denied', why);
      throw new HelmError(ErrorCode.PERMISSION_DENIED, `Permission denied: ${why}`, { details: { permission, target } });
    }
    if (g.mode === 'ask' && !this.sessionAllow.has(permission)) {
      const d = await this.host.approver.request({ kind: 'permission', plugin: this.id, permission, target, title: `${this.manifest.name} wants to ${action}`, detail: target, sessionId: this.sessionId });
      if (d === 'deny') {
        this.audit(action, permission, target, 'denied', 'user declined at prompt');
        throw new HelmError(ErrorCode.PERMISSION_DENIED, `You declined ${permission} for ${target}`);
      }
      if (d === 'always') this.sessionAllow.add(permission);
    }
    this.audit(action, permission, target, 'allowed');
    return g;
  }

  private pathIn(perm: 'fs.read' | 'fs.write', p: string) {
    return (scope: string[]) => checkPath(p, scope, this.ctx()).ok;
  }

  private resolve(p: string) {
    if (typeof p !== 'string' || !p) throw new HelmError(ErrorCode.INPUT_INVALID, 'path must be a non-empty string');
    return checkPath(p, [], this.ctx()).resolved;
  }

  /** Map of method name → handler, registered on the plugin's RPC peer. */
  handlers(): Record<string, (params: any) => Promise<unknown>> {
    const guard = <T>(fn: (p: any) => Promise<T>) => async (p: any) => {
      if (!this.bucket.take()) throw new HelmError(ErrorCode.RATE_LIMITED, `${this.id} exceeded 2000 host calls/second`);
      return fn(p ?? {});
    };
    return {
      'host/workspace.info': guard(async () => ({ workspace: this.host.workspace, dataDir: pluginDataDir(this.host.paths, this.id).files })),
      'host/fs.read': guard(async (p) => this.fsRead(p)),
      'host/fs.list': guard(async (p) => this.fsList(p)),
      'host/fs.stat': guard(async (p) => this.fsStat(p)),
      'host/fs.write': guard(async (p) => this.fsWrite(p)),
      'host/fs.mkdir': guard(async (p) => this.fsMkdir(p)),
      'host/fs.remove': guard(async (p) => this.fsRemove(p)),
      'host/net.fetch': guard(async (p) => this.netFetch(p)),
      'host/process.exec': guard(async (p) => this.processExec(p)),
      'host/secrets.get': guard(async (p) => this.secretGet(p)),
      'host/storage.get': guard(async (p) => ({ value: this.storage()[p.key] ?? null })),
      'host/storage.set': guard(async (p) => this.storageSet(p.key, p.value)),
      'host/storage.delete': guard(async (p) => this.storageSet(p.key, undefined)),
      'host/storage.list': guard(async () => ({ keys: Object.keys(this.storage()) })),
      'host/llm.complete': guard(async (p) => this.llm(p)),
      'host/events.emit': guard(async (p) => this.emit(p)),
    };
  }

  private async fsRead(p: { path: string; encoding?: 'utf8' | 'base64'; maxBytes?: number }) {
    const resolved = this.resolve(p.path);
    await this.require('fs.read', 'read a file', resolved, this.pathIn('fs.read', p.path));
    const max = Math.min(p.maxBytes ?? MAX_READ, MAX_READ);
    const st = await fsp.stat(resolved).catch((e) => { throw new HelmError(ErrorCode.TOOL_ERROR, e.code === 'ENOENT' ? `No such file: ${p.path}` : e.message); });
    if (st.isDirectory()) throw new HelmError(ErrorCode.TOOL_ERROR, `${p.path} is a directory`);
    const fh = await fsp.open(resolved, 'r');
    try {
      const buf = Buffer.alloc(Math.min(st.size, max));
      await fh.read(buf, 0, buf.length, 0);
      return { content: buf.toString(p.encoding ?? 'utf8'), size: st.size, truncated: st.size > max, path: resolved };
    } finally {
      await fh.close();
    }
  }

  private async fsList(p: { path: string }) {
    const resolved = this.resolve(p.path ?? '.');
    await this.require('fs.read', 'list a folder', resolved, this.pathIn('fs.read', p.path ?? '.'));
    const entries = await fsp.readdir(resolved, { withFileTypes: true }).catch((e) => { throw new HelmError(ErrorCode.TOOL_ERROR, e.message); });
    const out = [];
    for (const e of entries.slice(0, 5000)) {
      let size = 0;
      if (e.isFile()) { try { size = fs.statSync(path.join(resolved, e.name)).size; } catch { /* raced */ } }
      out.push({ name: e.name, type: e.isFile() ? 'file' : e.isDirectory() ? 'dir' : e.isSymbolicLink() ? 'symlink' : 'other', size });
    }
    return { path: resolved, entries: out, truncated: entries.length > 5000 };
  }

  private async fsStat(p: { path: string }) {
    const resolved = this.resolve(p.path);
    await this.require('fs.read', 'inspect a file', resolved, this.pathIn('fs.read', p.path));
    try {
      const st = await fsp.stat(resolved);
      return { exists: true, type: st.isFile() ? 'file' : st.isDirectory() ? 'dir' : 'other', size: st.size, mtimeMs: st.mtimeMs, path: resolved };
    } catch {
      return { exists: false, path: resolved };
    }
  }

  private async fsWrite(p: { path: string; content: string; encoding?: 'utf8' | 'base64'; createDirs?: boolean }) {
    const resolved = this.resolve(p.path);
    await this.require('fs.write', 'write a file', resolved, this.pathIn('fs.write', p.path));
    if (typeof p.content !== 'string') throw new HelmError(ErrorCode.INPUT_INVALID, 'content must be a string');
    if (p.createDirs) await fsp.mkdir(path.dirname(resolved), { recursive: true });
    const tmp = `${resolved}.helm-${process.pid}.tmp`;
    await fsp.writeFile(tmp, Buffer.from(p.content, p.encoding ?? 'utf8'));
    await fsp.rename(tmp, resolved);
    return { path: resolved, bytes: Buffer.byteLength(p.content, p.encoding ?? 'utf8') };
  }

  private async fsMkdir(p: { path: string }) {
    const resolved = this.resolve(p.path);
    await this.require('fs.write', 'create a folder', resolved, this.pathIn('fs.write', p.path));
    await fsp.mkdir(resolved, { recursive: true });
    return { path: resolved };
  }

  private async fsRemove(p: { path: string; recursive?: boolean }) {
    const resolved = this.resolve(p.path);
    await this.require('fs.write', 'delete a file', resolved, this.pathIn('fs.write', p.path));
    const roots = (findGrant(this.record(), 'fs.write')?.scope ?? []).map((s) => resolvePathScope(s, this.ctx()));
    if (roots.includes(resolved)) throw new HelmError(ErrorCode.PERMISSION_DENIED, 'Refusing to delete the root of a granted folder');
    await fsp.rm(resolved, { recursive: !!p.recursive, force: false });
    return { path: resolved };
  }

  private async netFetch(p: { url: string; method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number; maxBytes?: number }) {
    let host = '';
    try { host = new URL(p.url).hostname; } catch { throw new HelmError(ErrorCode.INPUT_INVALID, `Invalid URL: ${p.url}`); }
    const g = await this.require('net.http', `contact ${host}`, `${(p.method ?? 'GET').toUpperCase()} ${p.url.split('?')[0]}`);
    const allowLocal = !!findGrant(this.record(), 'net.local');
    try {
      return await brokerFetch(p, { hosts: g.scope ?? [], allowLocal }, this.host.netTransport);
    } catch (e) {
      if (e instanceof HelmError && e.code === ErrorCode.PERMISSION_DENIED) this.audit('contact host', 'net.http', p.url.split('?')[0], 'denied', e.message);
      throw e;
    }
  }

  private async processExec(p: { command: string; args?: string[]; cwd?: string; timeoutMs?: number; input?: string; env?: Record<string, string> }) {
    const name = String(p.command ?? '');
    if (!/^[A-Za-z0-9._+-]+$/.test(name)) throw new HelmError(ErrorCode.INPUT_INVALID, 'command must be a bare program name (no paths)');
    const args = (p.args ?? []).map(String);
    await this.require('process.exec', `run ${name}`, `${name} ${args.join(' ')}`.slice(0, 200), (scope) => scope.includes(name));
    const exe = whichSync(name);
    if (!exe) throw new HelmError(ErrorCode.TOOL_ERROR, `${name} was not found on PATH`);
    const cwd = p.cwd ? this.resolve(p.cwd) : this.host.workspace;
    const r = this.record();
    if (p.cwd && !checkPath(cwd, findGrant(r, 'fs.read')?.scope ?? [], this.ctx()).ok) throw new HelmError(ErrorCode.PERMISSION_DENIED, `cwd ${cwd} is outside the granted fs.read scope`);
    const env: Record<string, string> = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: pluginDataDir(this.host.paths, this.id).home, TMPDIR: pluginDataDir(this.host.paths, this.id).tmp + '/', LANG: 'en_US.UTF-8' };
    for (const [k, v] of Object.entries(p.env ?? {})) {
      if (!/^[A-Z_][A-Z0-9_]*$/.test(k) || ['PATH', 'HOME'].includes(k) || k.startsWith('DYLD_') || k.startsWith('LD_')) throw new HelmError(ErrorCode.INPUT_INVALID, `env var ${k} is not allowed`);
      env[k] = String(v);
    }
    const launch = buildChildLaunch({ exe, args, record: r, paths: this.host.paths, workspace: this.host.workspace, id: this.id });
    const timeoutMs = Math.min(p.timeoutMs ?? 30_000, 120_000);
    const cap = 1024 * 1024;
    return await new Promise((resolve, reject) => {
      const child = spawn(launch.command, launch.args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '', stderr = '', timedOut = false;
      child.stdout.on('data', (d: Buffer) => { if (stdout.length < cap) stdout += d.toString('utf8'); });
      child.stderr.on('data', (d: Buffer) => { if (stderr.length < cap) stderr += d.toString('utf8'); });
      const t = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
      child.on('error', (e) => { clearTimeout(t); reject(new HelmError(ErrorCode.TOOL_ERROR, `Failed to run ${name}: ${e.message}`)); });
      child.on('close', (code, signal) => {
        clearTimeout(t);
        resolve({ code, signal, stdout: stdout.slice(0, cap), stderr: stderr.slice(0, cap), timedOut, sandboxed: launch.sandboxed });
      });
      if (p.input) child.stdin.write(p.input);
      child.stdin.end();
    });
  }

  private async secretGet(p: { name: string }) {
    const name = String(p.name ?? '');
    await this.require('secrets', 'read a secret', name, (scope) => scope.includes(name));
    const value = this.host.secrets.get(this.id, name);
    if (value === undefined) throw new HelmError(ErrorCode.TOOL_ERROR, `Secret ${name} is not set`, { hint: `Set it with: helm secrets set ${this.id} ${name}` });
    redactor.add(value, `${this.id}/${name}`);
    return { value };
  }

  private storageFile() {
    return pluginDataDir(this.host.paths, this.id).storage;
  }
  private storage(): Record<string, unknown> {
    return readJsonSync<Record<string, unknown>>(this.storageFile(), {});
  }
  private storageSet(key: string, value: unknown) {
    if (typeof key !== 'string' || !key || key.length > 200) throw new HelmError(ErrorCode.INPUT_INVALID, 'storage key must be a string of 1-200 chars');
    const s = this.storage();
    if (value === undefined || value === null) delete s[key];
    else s[key] = value;
    const size = Buffer.byteLength(JSON.stringify(s));
    if (size > MAX_STORAGE) throw new HelmError(ErrorCode.RESULT_TOO_LARGE, `Plugin storage would exceed ${MAX_STORAGE / 1024 / 1024} MB`);
    writeJsonAtomicSync(this.storageFile(), s);
    return { ok: true };
  }

  private async llm(p: { messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>; maxTokens?: number }) {
    await this.require('llm.invoke', 'use the model', `${p.messages?.length ?? 0} message(s)`);
    if (!this.host.llmComplete) throw new HelmError(ErrorCode.NO_PROVIDER);
    return this.host.llmComplete(this.id, p);
  }

  private async emit(p: { name: string; payload?: unknown }) {
    if (typeof p.name !== 'string' || !/^[a-z][a-z0-9_.-]{0,60}$/.test(p.name)) throw new HelmError(ErrorCode.INPUT_INVALID, 'event name must be lowercase letters, digits, . _ -');
    const full = `plugin.${this.id}.${p.name}`;
    this.host.bus.emitEvent('plugin.event', { plugin: this.id, event: full, payload: p.payload });
    this.host.pluginEvent?.(this.id, full, p.payload);
    return { event: full };
  }
}

export function whichSync(name: string): string | undefined {
  for (const dir of (process.env.PATH ?? '/usr/bin:/bin').split(':')) {
    const f = path.join(dir, name);
    try {
      fs.accessSync(f, fs.constants.X_OK);
      if (fs.statSync(f).isFile()) return f;
    } catch { /* next */ }
  }
  return undefined;
}
