// In-process test harness: call your plugin's handlers with a fake host. No sandbox, no
// processes — fast unit tests. Use `helm plugin dev` or the integration tests for the real thing.
//
//   import plugin from '../src/index.ts';
//   import { createTestContext, callTool } from '@helm-agent/plugin-sdk/testing';
//   const ctx = createTestContext({ files: { 'a.txt': 'hello' } });
//   const out = await callTool(plugin, 'read_file', { path: 'a.txt' }, ctx);

import type { CallContext, FetchResponse, PluginDefinition, ToolResult, UINode } from './index.ts';
import { PluginError, toToolResult } from './index.ts';

export interface TestContextOptions {
  config?: Record<string, unknown>;
  files?: Record<string, string>;
  workspace?: string;
  secrets?: Record<string, string>;
  grants?: Array<{ id: string; scope?: string[] }>;
  fetch?: (url: string, opts: { method?: string; headers?: Record<string, string>; body?: string }) => Partial<FetchResponse> | Promise<Partial<FetchResponse>>;
  exec?: (command: string, args: string[]) => { code?: number; stdout?: string; stderr?: string };
}

export interface TestContext extends CallContext {
  /** Everything the plugin logged, notified or emitted — assert on these. */
  readonly logs: Array<{ level: string; message: string }>;
  readonly events: CallContext['events'] & { emitted: Array<{ name: string; payload: unknown }> };
  readonly files: Map<string, string>;
}

export function createTestContext(opts: TestContextOptions = {}): TestContext {
  const files = new Map(Object.entries(opts.files ?? {}));
  const store = new Map<string, unknown>();
  const logs: Array<{ level: string; message: string }> = [];
  const emitted: Array<{ name: string; payload: unknown }> = [];
  const norm = (p: string) => p.replace(/^\.\//, '').replace(/^\.$/, '');
  const log = (level: string) => (...a: unknown[]) => logs.push({ level, message: a.map(String).join(' ') });
  const ctx = {
    plugin: { id: 'test.plugin', version: '0.0.0', dataDir: '/tmp/helm-test' },
    workspace: opts.workspace ?? '/workspace',
    grants: opts.grants ?? [],
    isolation: 'test',
    config: opts.config ?? {},
    signal: new AbortController().signal,
    callId: 'test-call',
    sessionId: 'test-session',
    progress: (m: string) => logs.push({ level: 'progress', message: m }),
    logs,
    files,
    log: { debug: log('debug'), info: log('info'), warn: log('warn'), error: log('error') },
    fs: {
      async read(path: string) {
        const c = files.get(norm(path));
        if (c === undefined) throw new PluginError(`No such file: ${path}`);
        return { content: c, size: c.length, truncated: false, path };
      },
      async readText(path: string) { return (await ctx.fs.read(path)).content; },
      async list(path: string) {
        const prefix = norm(path) ? norm(path).replace(/\/$/, '') + '/' : '';
        const names = new Map<string, 'file' | 'dir'>();
        for (const f of files.keys()) {
          if (!f.startsWith(prefix)) continue;
          const rest = f.slice(prefix.length).split('/');
          names.set(rest[0]!, rest.length > 1 ? 'dir' : 'file');
        }
        return { path, truncated: false, entries: [...names].map(([name, type]) => ({ name, type, size: type === 'file' ? files.get(prefix + name)!.length : 0 })) };
      },
      async stat(path: string) {
        const c = files.get(norm(path));
        return c === undefined ? { exists: false, path } : { exists: true, type: 'file' as const, size: c.length, path };
      },
      async write(path: string, content: string) { files.set(norm(path), content); return { path, bytes: content.length }; },
      async mkdir(path: string) { return { path }; },
      async remove(path: string) { files.delete(norm(path)); return { path }; },
    },
    net: {
      async fetch(url: string, o: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
        if (!opts.fetch) throw new PluginError(`Unexpected network call to ${url} (pass fetch to createTestContext)`, 'PERMISSION_DENIED');
        const r = await opts.fetch(url, o);
        const status = r.status ?? 200;
        const body = r.body ?? '';
        return { status, ok: status >= 200 && status < 300, headers: r.headers ?? {}, body, encoding: 'utf8' as const, url, truncated: false, json: () => JSON.parse(body) };
      },
    },
    process: {
      async exec(command: string, args: string[] = []) {
        if (!opts.exec) throw new PluginError(`Unexpected exec of ${command}`, 'PERMISSION_DENIED');
        const r = opts.exec(command, args);
        return { code: r.code ?? 0, signal: null, stdout: r.stdout ?? '', stderr: r.stderr ?? '', timedOut: false, sandboxed: false };
      },
    },
    secrets: {
      async get(name: string) {
        const v = opts.secrets?.[name];
        if (v === undefined) throw new PluginError(`Secret ${name} is not set`);
        return v;
      },
    },
    storage: {
      async get(key: string) { return (store.get(key) ?? null) as never; },
      async set(key: string, value: unknown) { store.set(key, value); },
      async delete(key: string) { store.delete(key); },
      async list() { return [...store.keys()]; },
    },
    llm: { async complete() { return { content: '(test llm)' }; } },
    events: { emitted, async emit(name: string, payload?: unknown) { emitted.push({ name, payload }); } },
    ui: { notify: (m: string, level = 'info') => logs.push({ level: `notify:${level}`, message: m }), refresh: () => {} },
  };
  return ctx as unknown as TestContext;
}

export async function callTool(def: PluginDefinition, name: string, input: Record<string, unknown>, ctx: CallContext = createTestContext()): Promise<ToolResult> {
  const h = def.tools?.[name];
  if (!h) throw new Error(`Plugin has no tool "${name}"`);
  return toToolResult(await h(input, ctx));
}

export async function runCommand(def: PluginDefinition, name: string, args: Record<string, unknown> = {}, ctx: CallContext = createTestContext()) {
  const h = def.commands?.[name];
  if (!h) throw new Error(`Plugin has no command "${name}"`);
  return h(args, ctx);
}

export async function renderPanel(def: PluginDefinition, id: string, ctx: CallContext = createTestContext()): Promise<UINode> {
  const h = def.panels?.[id];
  if (!h) throw new Error(`Plugin has no panel "${id}"`);
  return h(ctx);
}

/** Concatenate the text of a ToolResult — handy for assertions. */
export function resultText(r: ToolResult): string {
  return r.content.map((b) => (b.type === 'json' ? JSON.stringify(b.data) : b.text)).join('\n');
}
