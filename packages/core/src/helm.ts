import fs from 'node:fs';
import path from 'node:path';
import type { ChatMessage, HostConfig, Manifest, PluginRecord, ProviderResult, ProviderToolDef, ToolResult, UINode } from './types.ts';
import { helmPaths, resolveHome, ensureDirSync } from './paths.ts';
import type { HelmPaths } from './paths.ts';
import { ConfigStore, StateStore, initHome } from './store.ts';
import { AuditLog, HostBus } from './audit.ts';
import { openSecretStore, redactor } from './permissions/secrets.ts';
import type { SecretStore } from './permissions/secrets.ts';
import { denyAllApprover } from './permissions/broker.ts';
import type { Approver } from './permissions/broker.ts';
import type { NetTransport } from './host-api/net.ts';
import { PluginProcess } from './runtime/supervisor.ts';
import type { SupervisorHost } from './runtime/supervisor.ts';
import { readManifest, ajv } from './manifest/manifest.ts';
import { collectContributions, pluginAvailability } from './contributions.ts';
import type { ToolEntry } from './contributions.ts';
import { HelmError, ErrorCode, toHelmError } from './errors.ts';
import * as installer from './installer.ts';
import type { GrantDecision } from './permissions/grants.ts';
import { effectiveConfig, validateConfig } from './plugin-config.ts';
import type { ValidateFunction } from 'ajv';

export interface HelmOptions {
  home?: string;
  workspace?: string;
  approver?: Approver;
  netTransport?: NetTransport;
  trace?: SupervisorHost['trace'];
  onStderr?: SupervisorHost['onStderr'];
  configOverrides?: Partial<HostConfig>;
}

const UI_TYPES = new Set(['stack', 'heading', 'text', 'markdown', 'keyValue', 'table', 'list', 'badge', 'button']);

/** Validate and bound a plugin-supplied UI tree. Plugins never ship HTML or JS to the host UI. */
export function sanitizeUI(node: unknown, depth = 0, budget = { n: 0 }): UINode {
  if (++budget.n > 600 || depth > 8) return { type: 'text', text: '[panel truncated]', tone: 'warning' };
  const n = node as Record<string, unknown>;
  if (!n || typeof n !== 'object' || !UI_TYPES.has(String(n.type))) return { type: 'text', text: `[unsupported UI node: ${String(n?.type)}]`, tone: 'warning' };
  const s = (v: unknown, max = 10_000) => redactor.redact(String(v ?? '')).slice(0, max);
  switch (n.type) {
    case 'stack': return { type: 'stack', children: (Array.isArray(n.children) ? n.children : []).slice(0, 200).map((c) => sanitizeUI(c, depth + 1, budget)) };
    case 'heading': return { type: 'heading', text: s(n.text, 200) };
    case 'text': return { type: 'text', text: s(n.text), tone: n.tone as any };
    case 'markdown': return { type: 'markdown', text: s(n.text, 20_000) };
    case 'keyValue': return { type: 'keyValue', items: (Array.isArray(n.items) ? n.items : []).slice(0, 100).map((i: any) => ({ key: s(i?.key, 200), value: s(i?.value, 2000) })) };
    case 'table': return { type: 'table', columns: (Array.isArray(n.columns) ? n.columns : []).slice(0, 20).map((c) => s(c, 100)), rows: (Array.isArray(n.rows) ? n.rows : []).slice(0, 300).map((r: any) => (Array.isArray(r) ? r : []).slice(0, 20).map((c) => s(c, 1000))) };
    case 'list': return { type: 'list', items: (Array.isArray(n.items) ? n.items : []).slice(0, 300).map((i) => s(i, 2000)) };
    case 'badge': return { type: 'badge', text: s(n.text, 60), tone: n.tone as any };
    case 'button': return { type: 'button', label: s(n.label, 60), command: s(n.command, 60), args: (n.args && typeof n.args === 'object') ? (n.args as Record<string, unknown>) : undefined };
  }
  return { type: 'text', text: '' };
}

export class Helm implements SupervisorHost, installer.InstallerHost {
  readonly paths: HelmPaths;
  readonly state: StateStore;
  readonly configStore: ConfigStore;
  readonly audit: AuditLog;
  readonly bus = new HostBus();
  readonly secrets: SecretStore;
  workspace: string;
  approver: Approver;
  netTransport?: NetTransport;
  trace?: SupervisorHost['trace'];
  onStderr?: SupervisorHost['onStderr'];
  private processes = new Map<string, { proc: PluginProcess; fingerprint: string }>();
  private manifestCache = new Map<string, { key: string; manifest?: Manifest }>();
  private validators = new Map<string, ValidateFunction>();

  static open(opts: HelmOptions = {}): Helm {
    return new Helm(opts);
  }

  constructor(opts: HelmOptions = {}) {
    const home = resolveHome(opts.home);
    initHome(home, opts.configOverrides);
    this.paths = helmPaths(home);
    this.state = new StateStore(this.paths);
    this.configStore = new ConfigStore(this.paths);
    this.audit = new AuditLog(this.paths);
    this.secrets = openSecretStore(this.paths, this.configStore.read().secrets.backend);
    this.workspace = fs.realpathSync.native(path.resolve(opts.workspace ?? process.cwd()));
    this.approver = opts.approver ?? denyAllApprover;
    this.netTransport = opts.netTransport;
    this.trace = opts.trace;
    this.onStderr = opts.onStderr;
    this.bus.setMaxListeners(100);
  }

  config(): HostConfig {
    return this.configStore.read();
  }

  // ------------------------------------------------------------ manifests & contributions
  manifestOf(r: PluginRecord): Manifest | undefined {
    const file = path.join(r.dir, 'helm-plugin.json');
    let mtime = 0;
    try { mtime = fs.statSync(file).mtimeMs; } catch { /* missing */ }
    const key = `${r.dir}:${r.version}:${mtime}`;
    const c = this.manifestCache.get(r.id);
    if (c && c.key === key) return c.manifest;
    const { manifest } = readManifest(r.dir);
    this.manifestCache.set(r.id, { key, manifest });
    return manifest;
  }

  requireManifest(id: string): { record: PluginRecord; manifest: Manifest } {
    const record = this.state.require(id);
    const manifest = this.manifestOf(record);
    if (!manifest) throw new HelmError(ErrorCode.MANIFEST_INVALID, `${id}'s manifest is missing or invalid at ${record.dir}`, { hint: `Run: helm plugin validate ${record.dir}` });
    return { record, manifest };
  }

  installed() {
    return this.state.list().map((record) => ({ record, manifest: this.manifestOf(record) }));
  }

  contributions() {
    return collectContributions(this.installed(), this.config());
  }

  availability(id: string) {
    const r = this.state.require(id);
    return pluginAvailability(this.manifestOf(r), r, this.config());
  }

  // ------------------------------------------------------------ processes
  /** Get (or lazily create) the process wrapper; recreated when version/grants/trust change. */
  process(id: string): PluginProcess {
    const { record, manifest } = this.requireManifest(id);
    const fingerprint = JSON.stringify([record.version, record.dir, record.trusted, record.grants.map((g) => [g.id, g.scope, g.mode]), fs.statSync(path.join(record.dir, 'helm-plugin.json')).mtimeMs]);
    const cur = this.processes.get(id);
    if (cur && cur.fingerprint === fingerprint) return cur.proc;
    if (cur) void cur.proc.stop('configuration changed');
    const proc = new PluginProcess(this, manifest, record);
    this.processes.set(id, { proc, fingerprint });
    return proc;
  }

  runningProcess(id: string): PluginProcess | undefined {
    return this.processes.get(id)?.proc;
  }

  async stopPlugin(id: string, reason = 'stopped') {
    const cur = this.processes.get(id);
    this.processes.delete(id);
    if (cur) await cur.proc.stop(reason);
  }

  async shutdown() {
    await Promise.all([...this.processes.keys()].map((id) => this.stopPlugin(id, 'host shutting down')));
  }

  // ------------------------------------------------------------ tools
  findTool(name: string): ToolEntry {
    const tools = this.contributions().tools;
    const t = tools.find((x) => x.exposedName === name) ?? tools.find((x) => `${x.pluginId}/${x.tool.name}` === name || `${x.pluginId}.${x.tool.name}` === name);
    if (!t) throw new HelmError(ErrorCode.NOT_IMPLEMENTED, `No tool named "${name}"`, { hint: 'List tools with `helm tools`.' });
    return t;
  }

  validateInput(entry: ToolEntry, input: unknown) {
    const key = `${entry.pluginId}/${entry.tool.name}`;
    let v = this.validators.get(key);
    if (!v) { v = ajv.compile(entry.tool.inputSchema); this.validators.set(key, v); }
    if (!v(input)) {
      const msg = (v.errors ?? []).map((e) => `${e.instancePath || '(input)'} ${e.message}`).join('; ');
      throw new HelmError(ErrorCode.INPUT_INVALID, `Invalid input for ${entry.exposedName}: ${msg}`);
    }
  }

  /** Invoke a tool directly (no approvals/hooks — the agent session adds those). */
  async invokeTool(entry: ToolEntry, input: Record<string, unknown>, opts: { callId?: string; sessionId?: string; signal?: AbortSignal } = {}): Promise<ToolResult> {
    if (!entry.available) throw new HelmError((entry.code as ErrorCode) ?? ErrorCode.PLUGIN_DISABLED, `${entry.exposedName} is unavailable: ${entry.reason}`);
    this.validateInput(entry, input);
    const proc = this.process(entry.pluginId);
    proc.broker.sessionId = opts.sessionId;
    const res = await proc.call<ToolResult>('tool/invoke', { tool: entry.tool.name, input, callId: opts.callId, sessionId: opts.sessionId }, { timeoutMs: entry.tool.timeoutMs, signal: opts.signal });
    return this.boundResult(res);
  }

  boundResult(res: ToolResult): ToolResult {
    const max = this.config().agent.maxToolOutputChars;
    if (!res || !Array.isArray(res.content)) throw new HelmError(ErrorCode.PROTOCOL_ERROR, 'Tool returned a malformed result (expected { content: [...] })');
    let used = 0;
    const content = res.content.map((b) => {
      const raw = b.type === 'json' ? JSON.stringify(b.data, null, 2) : String((b as { text?: string }).text ?? '');
      const room = Math.max(0, max - used);
      used += raw.length;
      if (raw.length <= room) return b.type === 'json' ? { type: 'json' as const, data: redactor.redactDeep(b.data) } : { ...b, text: redactor.redact(raw) };
      return { type: 'text' as const, text: redactor.redact(raw.slice(0, room)) + `\n…[truncated ${raw.length - room} chars by Helm]` };
    });
    return { content, isError: res.isError };
  }

  // ------------------------------------------------------------ commands & panels
  findCommand(spec: string) {
    const cmds = this.contributions().commands;
    const c = cmds.find((x) => x.qualified === spec) ?? cmds.find((x) => `${x.pluginId}.${x.command.name}` === spec) ?? cmds.find((x) => x.command.name === spec);
    if (!c) throw new HelmError(ErrorCode.NOT_IMPLEMENTED, `No command "${spec}"`, { hint: 'List commands with `helm cmd`.' });
    return c;
  }

  async runCommand(pluginId: string, command: string, args: Record<string, unknown> = {}): Promise<{ content?: ToolResult['content']; ui?: UINode }> {
    const c = this.contributions().commands.find((x) => x.pluginId === pluginId && x.command.name === command);
    if (!c) throw new HelmError(ErrorCode.NOT_IMPLEMENTED, `${pluginId} has no command "${command}"`);
    if (!c.available) throw new HelmError((c.code as ErrorCode) ?? ErrorCode.PLUGIN_DISABLED, `${c.qualified} is unavailable: ${c.reason}`);
    if (c.command.args) {
      const v = ajv.compile(c.command.args);
      if (!v(args)) throw new HelmError(ErrorCode.INPUT_INVALID, (v.errors ?? []).map((e) => `${e.instancePath || 'args'} ${e.message}`).join('; '));
    }
    const res = await this.process(pluginId).call<{ content?: ToolResult['content']; ui?: UINode }>('command/run', { command, args });
    return { content: res?.content ? this.boundResult({ content: res.content }).content : undefined, ui: res?.ui ? sanitizeUI(res.ui) : undefined };
  }

  async renderPanel(pluginId: string, panel: string): Promise<UINode> {
    const p = this.contributions().panels.find((x) => x.pluginId === pluginId && x.panel.id === panel);
    if (!p) throw new HelmError(ErrorCode.NOT_IMPLEMENTED, `${pluginId} has no panel "${panel}"`);
    if (!p.available) throw new HelmError((p.code as ErrorCode) ?? ErrorCode.PLUGIN_DISABLED, `${p.qualified} is unavailable: ${p.reason}`);
    const res = await this.process(pluginId).call<{ ui: UINode }>('panel/render', { panel }, { timeoutMs: 10_000 });
    return sanitizeUI(res?.ui);
  }

  // ------------------------------------------------------------ providers
  providers() {
    return this.contributions().providers;
  }
  /** Secret names a plugin declared (and was granted) but that are not stored yet. */
  missingSecrets(id: string): string[] {
    const r = this.state.get(id);
    const g = r?.grants.find((x) => x.id === 'secrets');
    if (!g) return [];
    const have = new Set(this.secrets.list(id));
    return (g.scope ?? []).filter((n) => !have.has(n));
  }

  resolveProvider(override?: { provider?: string; model?: string }) {
    const cfg = this.config();
    const all = this.providers();
    const wanted = override?.provider ?? cfg.provider;
    let p = wanted ? all.find((x) => x.qualified === wanted || x.pluginId === wanted) : all.find((x) => x.available);
    if (!p) throw new HelmError(ErrorCode.NO_PROVIDER, wanted ? `Provider "${wanted}" is not installed` : 'No model provider plugin is installed');
    if (!p.available) throw new HelmError((p.code as ErrorCode) ?? ErrorCode.NO_PROVIDER, `Provider ${p.qualified} is unavailable: ${p.reason}`);
    const model = override?.model ?? (wanted && cfg.provider === p.qualified ? cfg.model : undefined) ?? cfg.model ?? p.provider.defaultModel;
    return { entry: p, model };
  }

  async complete(req: { messages: ChatMessage[]; tools: ProviderToolDef[]; provider?: string; model?: string; options?: Record<string, unknown>; signal?: AbortSignal }): Promise<ProviderResult & { provider: string }> {
    const { entry, model } = this.resolveProvider({ provider: req.provider, model: req.model });
    const res = await this.process(entry.pluginId).call<ProviderResult>('provider/complete', {
      provider: entry.provider.id, model, messages: req.messages, tools: req.tools, options: req.options ?? {},
    }, { timeoutMs: entry.provider.timeoutMs ?? 180_000, signal: req.signal });
    if (!res || !res.message) throw new HelmError(ErrorCode.PROVIDER_ERROR, `${entry.qualified} returned a malformed response`);
    return { ...res, provider: entry.qualified };
  }

  async listModels(provider?: string) {
    const { entry } = this.resolveProvider({ provider });
    const res = await this.process(entry.pluginId).call<{ models: unknown[] }>('provider/models', { provider: entry.provider.id }, { timeoutMs: 60_000 });
    return { provider: entry.qualified, models: res.models ?? [] };
  }

  /** host/llm.complete: plugins with llm.invoke use the user's provider in "fast" role. */
  async llmComplete(_pluginId: string, p: { messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>; maxTokens?: number }) {
    const res = await this.complete({ messages: p.messages as ChatMessage[], tools: [], options: { maxTokens: p.maxTokens ?? 1024, role: 'fast' } });
    return { content: res.message.content ?? '', model: res.model };
  }

  /** Route plugin-emitted events to plugins that watch them. */
  pluginEvent(source: string, name: string, payload: unknown) {
    for (const h of this.contributions().hooks) {
      if (h.available && h.hook.event === name && h.pluginId !== source) {
        this.process(h.pluginId).call('hook/dispatch', { event: name, payload: { source, payload } }, { timeoutMs: h.hook.timeoutMs ?? 5000 }).catch(() => {});
      }
    }
  }

  // ------------------------------------------------------------ management
  prepareInstall(spec: string, opts: { link?: boolean } = {}) { return installer.prepareInstall(this, spec, opts); }
  commitInstall(plan: installer.InstallPlan, decisions: GrantDecision[], opts: { enable?: boolean } = {}) { return installer.commitInstall(this, plan, decisions, opts); }
  prepareUpdate(id: string, spec?: string) { return installer.prepareUpdate(this, id, spec); }
  commitUpdate(plan: installer.InstallPlan, decisions: GrantDecision[]) { return installer.commitUpdate(this, plan, decisions); }
  rollback(id: string) { return installer.rollback(this, id); }
  uninstall(id: string, opts: { purge?: boolean } = {}) { return installer.uninstall(this, id, opts); }
  search(query?: string) { return installer.searchRegistry(this.config(), query); }

  async grant(id: string, permission: string, opts: { scope?: string[]; mode?: 'allow' | 'ask' } = {}) {
    const { manifest } = this.requireManifest(id);
    await installer.grant(this, manifest, id, permission, opts);
  }
  async revoke(id: string, permission: string, opts: { scope?: string[] } = {}) {
    await installer.revoke(this, id, permission, opts);
  }

  async enable(id: string) {
    const { manifest, record } = this.requireManifest(id);
    const missing = (manifest.permissions ?? []).filter((p) => !p.optional && !record.grants.some((g) => g.id === p.id)).map((p) => p.id);
    if (missing.length) throw new HelmError(ErrorCode.CONSENT_REQUIRED, `${id} cannot be enabled without: ${missing.join(', ')}`, { hint: missing.map((p) => `helm plugin grant ${id} ${p}`).join('  &&  ') });
    this.state.patch(id, (r) => { r.enabled = true; });
    this.audit.write({ plugin: id, kind: 'lifecycle', action: 'enabled', decision: 'info' });
    this.bus.emitEvent('plugin.state', { plugin: id, from: 'disabled', to: 'stopped', reason: 'enabled' });
  }

  async disable(id: string) {
    this.state.patch(id, (r) => { r.enabled = false; });
    await this.stopPlugin(id, 'disabled');
    this.audit.write({ plugin: id, kind: 'lifecycle', action: 'disabled', decision: 'info' });
    this.bus.emitEvent('plugin.state', { plugin: id, from: 'stopped', to: 'disabled', reason: 'disabled' });
  }

  async setTrusted(id: string, trusted: boolean) {
    this.state.patch(id, (r) => { r.trusted = trusted; });
    await this.stopPlugin(id, trusted ? 'trusted' : 'untrusted');
    this.audit.write({ plugin: id, kind: 'grant', action: trusted ? 'trusted: may run with reduced isolation' : 'trust removed', decision: trusted ? 'allowed' : 'denied' });
  }

  async reset(id: string) {
    this.state.patch(id, (r) => { r.health = { crashes: [] }; });
    await this.stopPlugin(id, 'reset');
    this.audit.write({ plugin: id, kind: 'lifecycle', action: 'health reset (quarantine cleared)', decision: 'info' });
  }

  async setConfig(id: string, values: Record<string, unknown>) {
    const { manifest } = this.requireManifest(id);
    const problems = validateConfig(manifest, values);
    if (problems.length) throw new HelmError(ErrorCode.CONFIG_INVALID, problems.join('; '));
    this.state.patch(id, (r) => { r.config = values; });
    const proc = this.runningProcess(id);
    if (proc?.state === 'active') proc.notify('config/didChange', { config: effectiveConfig(manifest, values) });
  }

  setSecret(id: string, name: string, value: string) {
    const { manifest } = this.requireManifest(id);
    void manifest;
    return this.setSecretChecked(id, name, value);
  }

  async setLimit(id: string, key: string, value: number | undefined) {
    const allowed = ['callTimeoutMs', 'activationTimeoutMs', 'maxConcurrency', 'memoryMb', 'idleTimeoutMs'];
    if (!allowed.includes(key)) throw new HelmError(ErrorCode.CONFIG_INVALID, `Unknown limit "${key}"`, { hint: `Limits: ${allowed.join(', ')}` });
    if (value !== undefined && (!Number.isInteger(value) || value < 1)) throw new HelmError(ErrorCode.CONFIG_INVALID, `${key} must be a positive integer`);
    this.state.patch(id, (r) => {
      const o: Record<string, number> = { ...(r.limitOverrides ?? {}) } as Record<string, number>;
      if (value === undefined) delete o[key]; else o[key] = value;
      r.limitOverrides = o;
    });
    this.audit.write({ plugin: id, kind: 'lifecycle', action: `limit ${key} = ${value ?? '(default)'}`, decision: 'info' });
    await this.stopPlugin(id, 'limits changed');
  }

  private setSecretChecked(id: string, name: string, value: string) {
    const { manifest } = this.requireManifest(id);
    const decl = (manifest.permissions ?? []).find((p) => p.id === 'secrets');
    if (!decl?.scope?.includes(name)) throw new HelmError(ErrorCode.PERMISSION_DENIED, `${id} does not declare a secret named "${name}"`, { hint: `Declared secrets: ${decl?.scope?.join(', ') ?? 'none'}` });
    this.secrets.set(id, name, value);
    this.audit.write({ plugin: id, kind: 'grant', action: 'secret stored', target: name, decision: 'info' });
  }

  logFile(id: string) {
    return path.join(this.paths.logs, `${id}.log`);
  }

  readLog(id: string, lines = 50): string[] {
    try { return fs.readFileSync(this.logFile(id), 'utf8').split('\n').filter(Boolean).slice(-lines); } catch { return []; }
  }

  ensureDirs() {
    ensureDirSync(this.paths.sessions);
  }

  explainError(e: unknown) {
    return toHelmError(e).toJSON();
  }
}
