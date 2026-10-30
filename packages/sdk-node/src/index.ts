// @helm-agent/plugin-sdk — the public API for Helm plugins written in TypeScript/JavaScript.
// The host injects this module at runtime (see bootstrap.ts), so plugins have no dependencies.

export type JsonSchema = Record<string, unknown>;
export type ContentBlock = { type: 'text'; text: string } | { type: 'markdown'; text: string } | { type: 'json'; data: unknown };
export interface ToolResult { content: ContentBlock[]; isError?: boolean }
export type Tone = 'muted' | 'warning' | 'danger' | 'success';
export type UINode =
  | { type: 'stack'; children: UINode[] }
  | { type: 'heading'; text: string }
  | { type: 'text'; text: string; tone?: Tone }
  | { type: 'markdown'; text: string }
  | { type: 'keyValue'; items: Array<{ key: string; value: string }> }
  | { type: 'table'; columns: string[]; rows: string[][] }
  | { type: 'list'; items: string[] }
  | { type: 'badge'; text: string; tone?: Tone }
  | { type: 'button'; label: string; command: string; args?: Record<string, unknown> };

export interface FetchResponse {
  status: number;
  ok: boolean;
  headers: Record<string, string>;
  body: string;
  encoding: 'utf8' | 'base64';
  url: string;
  truncated: boolean;
  json<T = unknown>(): T;
}

export interface ExecResult { code: number | null; signal: string | null; stdout: string; stderr: string; timedOut: boolean; sandboxed: boolean }

export interface PluginContext {
  readonly plugin: { id: string; version: string; dataDir: string };
  readonly workspace: string;
  readonly grants: Array<{ id: string; scope?: string[] }>;
  readonly isolation: string;
  config: Record<string, any>;
  log: { debug(...a: unknown[]): void; info(...a: unknown[]): void; warn(...a: unknown[]): void; error(...a: unknown[]): void };
  fs: {
    read(path: string, opts?: { encoding?: 'utf8' | 'base64'; maxBytes?: number }): Promise<{ content: string; size: number; truncated: boolean; path: string }>;
    readText(path: string): Promise<string>;
    list(path: string): Promise<{ path: string; entries: Array<{ name: string; type: 'file' | 'dir' | 'symlink' | 'other'; size: number }>; truncated: boolean }>;
    stat(path: string): Promise<{ exists: boolean; type?: 'file' | 'dir' | 'other'; size?: number; mtimeMs?: number; path: string }>;
    write(path: string, content: string, opts?: { encoding?: 'utf8' | 'base64'; createDirs?: boolean }): Promise<{ path: string; bytes: number }>;
    mkdir(path: string): Promise<{ path: string }>;
    remove(path: string, opts?: { recursive?: boolean }): Promise<{ path: string }>;
  };
  net: { fetch(url: string, opts?: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number; maxBytes?: number }): Promise<FetchResponse> };
  process: { exec(command: string, args?: string[], opts?: { cwd?: string; timeoutMs?: number; input?: string; env?: Record<string, string> }): Promise<ExecResult> };
  secrets: { get(name: string): Promise<string> };
  storage: { get<T = unknown>(key: string): Promise<T | null>; set(key: string, value: unknown): Promise<void>; delete(key: string): Promise<void>; list(): Promise<string[]> };
  llm: { complete(req: { messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>; maxTokens?: number }): Promise<{ content: string; model?: string }> };
  events: { emit(name: string, payload?: unknown): Promise<void> };
  ui: { notify(message: string, level?: 'info' | 'warning' | 'error'): void; refresh(panel?: string): void };
}

/** Per-call context: everything in PluginContext plus cancellation and progress. */
export interface CallContext extends PluginContext {
  readonly signal: AbortSignal;
  readonly callId?: string;
  readonly sessionId?: string;
  progress(message: string): void;
}

export type HookResult =
  | { action: 'continue' }
  | { action: 'block'; reason: string }
  | { action: 'ask'; reason: string }
  | { action: 'modify'; input?: Record<string, unknown>; output?: ToolResult; reason?: string };

export interface ToolBeforePayload { tool: string; plugin: string; exposedName: string; effect: string; input: Record<string, unknown>; sessionId?: string }
export interface ToolAfterPayload extends ToolBeforePayload { output: ToolResult; durationMs: number }

export interface ProviderMessage { role: 'system' | 'user' | 'assistant' | 'tool'; content: string | null; toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>; toolCallId?: string; name?: string; providerData?: unknown }
export interface ProviderRequest {
  provider: string;
  model?: string;
  messages: ProviderMessage[];
  tools: Array<{ name: string; description: string; parameters: JsonSchema }>;
  options?: { maxTokens?: number; reasoningEffort?: string; temperature?: number; role?: 'agent' | 'fast' };
}
export interface ProviderResponse {
  message: { content: string | null; toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>; providerData?: unknown };
  model?: string;
  finishReason?: string;
  usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number };
}
export interface ModelInfo { id: string; name?: string; contextLength?: number; pricing?: { inputPerM?: number; outputPerM?: number }; blocked?: boolean; reason?: string; recommended?: string }

export type ToolHandler = (input: any, ctx: CallContext) => Promise<unknown> | unknown;
export type CommandHandler = (args: any, ctx: CallContext) => Promise<unknown> | unknown;
export type HookHandler = (payload: any, ctx: CallContext) => Promise<HookResult | void> | HookResult | void;
export type PanelHandler = (ctx: CallContext) => Promise<UINode> | UINode;
export interface ProviderHandler {
  complete(req: ProviderRequest, ctx: CallContext): Promise<ProviderResponse>;
  models?(ctx: CallContext): Promise<ModelInfo[]>;
}

export interface PluginDefinition {
  activate?(ctx: PluginContext): Promise<void> | void;
  deactivate?(ctx: PluginContext): Promise<void> | void;
  onConfigChange?(config: Record<string, any>, ctx: PluginContext): Promise<void> | void;
  tools?: Record<string, ToolHandler>;
  commands?: Record<string, CommandHandler>;
  hooks?: Record<string, HookHandler>;
  panels?: Record<string, PanelHandler>;
  providers?: Record<string, ProviderHandler>;
}

/** Identity helper that gives plugin authors full type inference. */
export function definePlugin<T extends PluginDefinition>(def: T): T {
  return def;
}

/** Throw this to return a structured error (code from the Helm error catalog). */
export class PluginError extends Error {
  code: string;
  hint?: string;
  constructor(message: string, code = 'TOOL_ERROR', hint?: string) {
    super(message);
    this.code = code;
    this.hint = hint;
  }
}

export const text = (t: string): ToolResult => ({ content: [{ type: 'text', text: t }] });
export const markdown = (t: string): ToolResult => ({ content: [{ type: 'markdown', text: t }] });
export const json = (data: unknown): ToolResult => ({ content: [{ type: 'json', data }] });

export const ui = {
  stack: (...children: UINode[]): UINode => ({ type: 'stack', children }),
  heading: (t: string): UINode => ({ type: 'heading', text: t }),
  text: (t: string, tone?: Tone): UINode => ({ type: 'text', text: t, tone }),
  markdown: (t: string): UINode => ({ type: 'markdown', text: t }),
  keyValue: (items: Record<string, string | number | boolean>): UINode => ({ type: 'keyValue', items: Object.entries(items).map(([key, v]) => ({ key, value: String(v) })) }),
  table: (columns: string[], rows: Array<Array<string | number>>): UINode => ({ type: 'table', columns, rows: rows.map((r) => r.map(String)) }),
  list: (items: string[]): UINode => ({ type: 'list', items }),
  badge: (t: string, tone?: Tone): UINode => ({ type: 'badge', text: t, tone }),
  button: (label: string, command: string, args?: Record<string, unknown>): UINode => ({ type: 'button', label, command, args }),
};

/** Normalise whatever a handler returned into a ToolResult. */
export function toToolResult(v: unknown): ToolResult {
  if (v === undefined || v === null) return { content: [{ type: 'text', text: '(no output)' }] };
  if (typeof v === 'string') return { content: [{ type: 'text', text: v }] };
  if (typeof v === 'object' && Array.isArray((v as ToolResult).content)) return v as ToolResult;
  return { content: [{ type: 'json', data: v }] };
}
