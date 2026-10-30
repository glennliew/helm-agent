import type { Readable, Writable } from 'node:stream';
import { HelmError, ErrorCode, toHelmError } from '../errors.ts';

/**
 * JSON-RPC 2.0 over newline-delimited JSON. One JSON object per line.
 * - Lines longer than maxLineBytes are a protocol violation (protects host memory).
 * - Non-JSON lines are reported via onProtocolNoise (usually a plugin printing to stdout).
 * - Requests support timeouts and cancellation; cancellation sends `$/cancelRequest`.
 */

export interface RpcError { code: number; message: string; data?: { code?: string; hint?: string; details?: unknown } }
interface Pending { resolve: (v: unknown) => void; reject: (e: unknown) => void; timer?: NodeJS.Timeout; method: string }
export type RequestHandler = (params: any, ctx: { id: string | number; signal: AbortSignal }) => Promise<unknown> | unknown;
export type NotificationHandler = (params: any) => void;

export interface RpcPeerOptions {
  name: string;
  maxLineBytes?: number;
  onProtocolNoise?: (line: string) => void;
  onProtocolViolation?: (reason: string) => void;
  onTrace?: (dir: 'in' | 'out', msg: unknown) => void;
}

export const HELM_RPC_ERROR = -32000;

export function toRpcError(e: unknown): RpcError {
  const he = toHelmError(e);
  return { code: HELM_RPC_ERROR, message: he.message, data: { code: he.code, hint: he.hint, details: he.details } };
}

export function fromRpcError(e: RpcError, fallback: ErrorCode = ErrorCode.PROTOCOL_ERROR): HelmError {
  const code = (e.data?.code as ErrorCode | undefined) ?? (e.code === -32601 ? ErrorCode.NOT_IMPLEMENTED : fallback);
  return new HelmError(code in ErrorCode ? code : fallback, e.message, { details: e.data?.details, hint: e.data?.hint });
}

export class RpcPeer {
  private pending = new Map<string | number, Pending>();
  private handlers = new Map<string, RequestHandler>();
  private notifs = new Map<string, NotificationHandler>();
  private incoming = new Map<string | number, AbortController>();
  private buf = '';
  private discarding = false;
  private nextId = 1;
  private closed = false;
  private out: Writable;
  private opts: Required<Pick<RpcPeerOptions, 'maxLineBytes'>> & RpcPeerOptions;

  constructor(input: Readable, output: Writable, opts: RpcPeerOptions) {
    this.out = output;
    this.opts = { maxLineBytes: 8 * 1024 * 1024, ...opts };
    input.setEncoding('utf8');
    input.on('data', (chunk: string) => this.onData(chunk));
    output.on('error', () => { /* EPIPE when the other side died; exit handling covers it */ });
    this.onNotification('$/cancelRequest', (p: { id: string | number }) => this.incoming.get(p?.id)?.abort());
  }

  private onData(chunk: string) {
    this.buf += chunk;
    for (;;) {
      const nl = this.buf.indexOf('\n');
      if (nl === -1) {
        if (this.buf.length > this.opts.maxLineBytes) {
          this.buf = '';
          this.discarding = true;
          this.opts.onProtocolViolation?.(`message larger than ${Math.round(this.opts.maxLineBytes / 1024 / 1024)} MB`);
        }
        return;
      }
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      if (this.discarding) { this.discarding = false; continue; }
      if (line.trim()) this.onLine(line);
    }
  }

  private onLine(line: string) {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      this.opts.onProtocolNoise?.(line);
      return;
    }
    if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0') {
      this.opts.onProtocolNoise?.(line);
      return;
    }
    this.opts.onTrace?.('in', msg);
    try {
      if (typeof msg.method === 'string') {
        if (msg.id !== undefined && msg.id !== null) void this.onRequest(msg);
        else this.notifs.get(msg.method)?.(msg.params);
      } else if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (p.timer) clearTimeout(p.timer);
        if (msg.error) p.reject(fromRpcError(msg.error));
        else p.resolve(msg.result);
      }
    } catch (e) {
      // A single bad message must never take down the peer.
      this.opts.onProtocolViolation?.(`handler error: ${(e as Error).message}`);
    }
  }

  private async onRequest(msg: { id: string | number; method: string; params?: unknown }) {
    const h = this.handlers.get(msg.method);
    if (!h) {
      this.send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}`, data: { code: ErrorCode.NOT_IMPLEMENTED } } });
      return;
    }
    const ac = new AbortController();
    this.incoming.set(msg.id, ac);
    try {
      const result = await h(msg.params ?? {}, { id: msg.id, signal: ac.signal });
      this.send({ jsonrpc: '2.0', id: msg.id, result: result ?? null });
    } catch (e) {
      this.send({ jsonrpc: '2.0', id: msg.id, error: toRpcError(e) });
    } finally {
      this.incoming.delete(msg.id);
    }
  }

  private send(msg: unknown) {
    if (this.closed) return;
    this.opts.onTrace?.('out', msg);
    try {
      this.out.write(JSON.stringify(msg) + '\n');
    } catch {
      /* stream closed */
    }
  }

  handle(method: string, h: RequestHandler) {
    this.handlers.set(method, h);
  }

  onNotification(method: string, h: NotificationHandler) {
    this.notifs.set(method, h);
  }

  notify(method: string, params?: unknown) {
    this.send({ jsonrpc: '2.0', method, params });
  }

  request<T = unknown>(method: string, params: unknown, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<T> {
    if (this.closed) return Promise.reject(new HelmError(ErrorCode.PLUGIN_CRASHED, 'Connection to plugin is closed'));
    const id = `h${this.nextId++}`;
    return new Promise<T>((resolve, reject) => {
      const p: Pending = { resolve: resolve as (v: unknown) => void, reject, method };
      if (opts.timeoutMs) {
        p.timer = setTimeout(() => {
          this.pending.delete(id);
          this.notify('$/cancelRequest', { id });
          reject(new HelmError(ErrorCode.CALL_TIMEOUT, `${method} did not answer within ${Math.round(opts.timeoutMs! / 100) / 10}s`));
        }, opts.timeoutMs);
      }
      if (opts.signal) {
        if (opts.signal.aborted) { reject(new HelmError(ErrorCode.CANCELLED)); return; }
        opts.signal.addEventListener('abort', () => {
          if (!this.pending.has(id)) return;
          this.pending.delete(id);
          if (p.timer) clearTimeout(p.timer);
          this.notify('$/cancelRequest', { id });
          reject(new HelmError(ErrorCode.CANCELLED, `${method} was cancelled`));
        }, { once: true });
      }
      this.pending.set(id, p);
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  get pendingCount() {
    return this.pending.size;
  }

  /** Reject every in-flight request with the given error and stop accepting new ones. */
  close(err: HelmError) {
    if (this.closed) return;
    this.closed = true;
    for (const [, p] of this.pending) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
    for (const [, ac] of this.incoming) ac.abort();
  }
}
