// Shared type definitions for the Helm host. Kept in one place so the CLI, web console
// and tests all speak the same vocabulary.

export type JsonSchema = Record<string, unknown>;
export type ToolEffect = 'read' | 'write' | 'external' | 'exec';
export type RuntimeType = 'node' | 'python' | 'exec';

export interface PermissionRequest {
  id: string;
  scope?: string[];
  reason: string;
  optional?: boolean;
  /** The user may add scope entries beyond what is declared (e.g. extra API hosts). */
  userExtensible?: boolean;
}

export interface ToolContribution {
  name: string;
  title?: string;
  description: string;
  effect: ToolEffect;
  requires?: string[];
  approval?: 'auto' | 'ask';
  inputSchema: JsonSchema;
  timeoutMs?: number;
}

export interface CommandContribution {
  name: string;
  title: string;
  description?: string;
  args?: JsonSchema;
  requires?: string[];
}

export interface HookContribution {
  event: string;
  mode: 'watch' | 'intercept';
  priority?: number;
  onError?: 'continue' | 'block';
  timeoutMs?: number;
}

export interface PanelContribution {
  id: string;
  title: string;
  description?: string;
}

export interface ProviderContribution {
  id: string;
  title: string;
  description?: string;
  defaultModel?: string;
  timeoutMs?: number;
}

export interface PluginLimits {
  callTimeoutMs?: number;
  activationTimeoutMs?: number;
  maxConcurrency?: number;
  memoryMb?: number;
  idleTimeoutMs?: number;
}

export interface Manifest {
  manifestVersion: 1;
  id: string;
  name: string;
  version: string;
  description: string;
  publisher?: string;
  license?: string;
  homepage?: string;
  engines: { helm: string; protocol: string };
  runtime: { type: RuntimeType; entry?: string; command?: string[] };
  activation?: Array<'onTool' | 'onCommand' | 'onSession' | 'onStartup' | 'onProvider'>;
  permissions?: PermissionRequest[];
  contributes?: {
    tools?: ToolContribution[];
    commands?: CommandContribution[];
    hooks?: HookContribution[];
    panels?: PanelContribution[];
    providers?: ProviderContribution[];
    configuration?: JsonSchema;
  };
  limits?: PluginLimits;
}

export interface Grant {
  id: string;
  /** Scope actually granted (may be narrower than requested). Undefined = permission has no scope. */
  scope?: string[];
  mode: 'allow' | 'ask';
  grantedAt: string;
  version: string;
}

export interface PluginHealth {
  crashes: number[];
  quarantinedAt?: string;
  lastError?: { code: string; message: string; at: string; stderrTail?: string[] };
}

export interface PluginSource {
  type: 'dir' | 'link' | 'tgz' | 'git' | 'registry';
  location: string;
  registry?: string;
  sha256?: string;
}

export interface PluginRecord {
  id: string;
  version: string;
  dir: string;
  source: PluginSource;
  enabled: boolean;
  trusted: boolean;
  installedAt: string;
  updatedAt: string;
  grants: Grant[];
  declined: string[];
  config: Record<string, unknown>;
  limitOverrides?: PluginLimits;
  health: PluginHealth;
  previous?: { version: string; dir: string; grants: Grant[]; config: Record<string, unknown> };
}

export interface StateFile {
  version: 1;
  plugins: Record<string, PluginRecord>;
}

export type ApprovalPolicy = 'allow' | 'ask' | 'deny';

export interface HostConfig {
  provider?: string;
  model?: string;
  approvals: Record<ToolEffect, ApprovalPolicy>;
  security: { requireStrictIsolation: boolean };
  agent: { maxSteps: number; maxToolOutputChars: number; systemPrompt?: string };
  registries: string[];
  secrets: { backend: 'keychain' | 'file' };
}

// ---- Conversation model (provider-neutral) ----

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | null; toolCalls?: ToolCall[]; providerData?: unknown }
  | { role: 'tool'; toolCallId: string; name: string; content: string };

export interface ProviderToolDef {
  name: string;
  description: string;
  parameters: JsonSchema;
}

export interface ProviderResult {
  message: { content: string | null; toolCalls?: ToolCall[]; providerData?: unknown };
  model?: string;
  finishReason?: string;
  usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number };
}

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'markdown'; text: string }
  | { type: 'json'; data: unknown };

export interface ToolResult {
  content: ContentBlock[];
  isError?: boolean;
}

// ---- Declarative UI (panels) ----
export type UINode =
  | { type: 'stack'; children: UINode[] }
  | { type: 'heading'; text: string }
  | { type: 'text'; text: string; tone?: 'muted' | 'warning' | 'danger' | 'success' }
  | { type: 'markdown'; text: string }
  | { type: 'keyValue'; items: Array<{ key: string; value: string }> }
  | { type: 'table'; columns: string[]; rows: string[][] }
  | { type: 'list'; items: string[] }
  | { type: 'badge'; text: string; tone?: 'muted' | 'warning' | 'danger' | 'success' }
  | { type: 'button'; label: string; command: string; args?: Record<string, unknown> };
