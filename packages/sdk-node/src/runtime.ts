// Plugin-side runtime: speaks the Helm protocol (JSON-RPC 2.0 over NDJSON stdio) on behalf of
// a PluginDefinition. Self-contained on purpose: the sandbox only lets plugins read the SDK folder.
import util from 'node:util';
import type { CallContext, PluginContext, PluginDefinition } from './index.ts';
import { PluginError, toToolResult } from './index.ts';

type Json = any;
interface Pending { resolve: (v: Json) => void; reject: (e: Error) => void }

export function runPlugin(def: PluginDefinition, io: { write: (s: string) => void; input: NodeJS.ReadableStream; exit?: (code: number) => void } ) {
  const pending = new Map<string, Pending>();
  const inflight = new Map<string | number, AbortController>();
  let nextId = 1;
  let ctx: PluginContext | undefined;
  const exit = io.exit ?? ((c: number) => process.exit(c));

  const send = (msg: Json) => io.write(JSON.stringify(msg) + '\n');
  const notify = (method: string, params: Json) => send({ jsonrpc: '2.0', method, params });
  const request = (method: string, params: Json): Promise<Json> =>
    new Promise((resolve, reject) => {
      const id = `p${nextId++}`;
      pending.set(id, { resolve, reject });
      send({ jsonrpc: '2.0', id, method, params });
    });

  const fmt = (a: unknown[]) => a.map((x) => (typeof x === 'string' ? x : util.inspect(x, { depth: 4, breakLength: 120 }))).join(' ');
  const log = {
    debug: (...a: unknown[]) => notify('host/log', { level: 'debug', message: fmt(a) }),
    info: (...a: unknown[]) => notify('host/log', { level: 'info', message: fmt(a) }),
    warn: (...a: unknown[]) => notify('host/log', { level: 'warn', message: fmt(a) }),
    error: (...a: unknown[]) => notify('host/log', { level: 'error', message: fmt(a) }),
  };

  function makeContext(init: Json): PluginContext {
    return {
      plugin: init.plugin,
      workspace: init.workspace,
      grants: init.grants ?? [],
      isolation: init.isolation,
      config: init.config ?? {},
      log,
      fs: {
        read: (path, opts) => request('host/fs.read', { path, ...opts }),
        readText: async (path) => (await request('host/fs.read', { path })).content,
        list: (path) => request('host/fs.list', { path }),
        stat: (path) => request('host/fs.stat', { path }),
        write: (path, content, opts) => request('host/fs.write', { path, content, ...opts }),
        mkdir: (path) => request('host/fs.mkdir', { path }),
        remove: (path, opts) => request('host/fs.remove', { path, ...opts }),
      },
      net: {
        fetch: async (url, opts = {}) => {
          const r = await request('host/net.fetch', { url, ...opts });
          return { ...r, ok: r.status >= 200 && r.status < 300, json: () => JSON.parse(r.body) };
        },
      },
      process: { exec: (command, args = [], opts = {}) => request('host/process.exec', { command, args, ...opts }) },
      secrets: { get: async (name) => (await request('host/secrets.get', { name })).value },
      storage: {
        get: async (key) => (await request('host/storage.get', { key })).value,
        set: async (key, value) => { await request('host/storage.set', { key, value }); },
        delete: async (key) => { await request('host/storage.delete', { key }); },
        list: async () => (await request('host/storage.list', {})).keys,
      },
      llm: { complete: (req) => request('host/llm.complete', req) },
      events: { emit: async (name, payload) => { await request('host/events.emit', { name, payload }); } },
      ui: {
        notify: (message, level = 'info') => notify('host/ui.notify', { message, level }),
        refresh: (panel) => notify('host/ui.refresh', { panel }),
      },
    };
  }

  function callCtx(signal: AbortSignal, callId?: string, sessionId?: string): CallContext {
    return Object.assign(Object.create(ctx!), {
      signal, callId, sessionId,
      progress: (message: string) => notify('host/progress', { callId, message }),
    }) as CallContext;
  }

  const notImpl = (kind: string, name: string) => new PluginError(`This plugin does not implement ${kind} "${name}"`, 'NOT_IMPLEMENTED');

  const methods: Record<string, (p: Json, signal: AbortSignal) => Promise<Json>> = {
    async initialize(p) {
      ctx = makeContext(p);
      await def.activate?.(ctx);
      return {
        protocolVersion: '1.0',
        capabilities: {
          tools: Object.keys(def.tools ?? {}),
          commands: Object.keys(def.commands ?? {}),
          hooks: Object.keys(def.hooks ?? {}),
          panels: Object.keys(def.panels ?? {}),
          providers: Object.keys(def.providers ?? {}),
        },
      };
    },
    async 'tool/invoke'(p, signal) {
      const h = def.tools?.[p.tool];
      if (!h) throw notImpl('tool', p.tool);
      return toToolResult(await h(p.input ?? {}, callCtx(signal, p.callId, p.sessionId)));
    },
    async 'command/run'(p, signal) {
      const h = def.commands?.[p.command];
      if (!h) throw notImpl('command', p.command);
      const out = await h(p.args ?? {}, callCtx(signal));
      if (out && typeof out === 'object' && 'type' in (out as object)) return { ui: out };
      if (out && typeof out === 'object' && 'ui' in (out as object)) return out;
      return toToolResult(out);
    },
    async 'hook/dispatch'(p, signal) {
      const h = def.hooks?.[p.event];
      if (!h) return { action: 'continue' };
      return (await h(p.payload, callCtx(signal, undefined, p.payload?.sessionId))) ?? { action: 'continue' };
    },
    async 'panel/render'(p, signal) {
      const h = def.panels?.[p.panel];
      if (!h) throw notImpl('panel', p.panel);
      return { ui: await h(callCtx(signal)) };
    },
    async 'provider/complete'(p, signal) {
      const h = def.providers?.[p.provider];
      if (!h) throw notImpl('provider', p.provider);
      return h.complete(p, callCtx(signal));
    },
    async 'provider/models'(p, signal) {
      const h = def.providers?.[p.provider];
      if (!h) throw notImpl('provider', p.provider);
      return { models: h.models ? await h.models(callCtx(signal)) : [] };
    },
    async '$/ping'() {
      return { ok: true };
    },
    async shutdown() {
      if (ctx) await def.deactivate?.(ctx);
      return { ok: true };
    },
  };

  async function onRequest(msg: Json) {
    const fn = methods[msg.method];
    if (!fn) {
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}`, data: { code: 'NOT_IMPLEMENTED' } } });
      return;
    }
    const ac = new AbortController();
    inflight.set(msg.id, ac);
    try {
      const result = await fn(msg.params ?? {}, ac.signal);
      send({ jsonrpc: '2.0', id: msg.id, result: result ?? null });
    } catch (e) {
      const err = e as PluginError & { data?: { code?: string; hint?: string } };
      const code = err?.code && /^[A-Z_]+$/.test(err.code) ? err.code : err?.data?.code ?? (msg.method === 'initialize' ? 'ACTIVATION_FAILED' : 'TOOL_ERROR');
      if (code !== 'TOOL_ERROR' && code !== 'PERMISSION_DENIED') log.error(`${msg.method} failed:`, err?.stack ?? String(e));
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: err?.message ?? String(e), data: { code, hint: err?.hint ?? err?.data?.hint } } });
    } finally {
      inflight.delete(msg.id);
    }
  }

  function onMessage(msg: Json) {
    if (typeof msg.method === 'string') {
      if (msg.id !== undefined && msg.id !== null) { void onRequest(msg); return; }
      if (msg.method === '$/cancelRequest') inflight.get(msg.params?.id)?.abort();
      else if (msg.method === 'exit') exit(0);
      else if (msg.method === 'config/didChange' && ctx) {
        ctx.config = msg.params?.config ?? {};
        Promise.resolve(def.onConfigChange?.(ctx.config, ctx)).catch((e) => log.error('onConfigChange failed:', e));
      }
      return;
    }
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.error) {
      const e = new PluginError(msg.error.message, msg.error.data?.code ?? 'TOOL_ERROR', msg.error.data?.hint);
      p.reject(e);
    } else p.resolve(msg.result);
  }

  let buf = '';
  io.input.setEncoding?.('utf8');
  io.input.on('data', (chunk: string) => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      try { onMessage(JSON.parse(line)); } catch (e) { log.error('bad message from host:', String(e)); }
    }
  });
  io.input.on('end', () => exit(0));
}
