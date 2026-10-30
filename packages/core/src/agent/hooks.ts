import type { Helm } from '../helm.ts';
import type { ToolResult } from '../types.ts';
import { toHelmError } from '../errors.ts';
import { findGrant } from '../permissions/grants.ts';

export interface HookOutcome {
  action: 'continue' | 'block' | 'ask';
  input?: Record<string, unknown>;
  output?: ToolResult;
  reasons: Array<{ plugin: string; action: string; reason?: string }>;
  warnings: string[];
}

/**
 * Intercept hooks run in priority order (highest first). Each can continue, block, ask the user,
 * or modify the input/output. If a hook fails and declared onError:"block", the tool call is
 * blocked (fail-closed) — a crashed guard must not silently turn into "allow everything".
 */
export async function runIntercept(helm: Helm, event: 'tool.before' | 'tool.after', payload: Record<string, unknown>): Promise<HookOutcome> {
  const hooks = helm.contributions().hooks
    .filter((h) => h.hook.event === event && h.hook.mode === 'intercept')
    .sort((a, b) => (b.hook.priority ?? 0) - (a.hook.priority ?? 0));
  const out: HookOutcome = { action: 'continue', reasons: [], warnings: [] };
  let current = { ...payload };
  for (const h of hooks) {
    if (!h.available) {
      // Disabled by the user = intentionally off. Broken (quarantined, isolation, revoked) = fail-closed if declared.
      if (h.code !== 'PLUGIN_DISABLED' && h.hook.onError === 'block') {
        out.action = 'block';
        out.reasons.push({ plugin: h.pluginId, action: 'block', reason: `required ${event} hook from ${h.pluginId} is unavailable (${h.reason}); blocking to be safe` });
        return out;
      }
      continue;
    }
    try {
      const res = await helm.process(h.pluginId).call<{ action: string; reason?: string; input?: Record<string, unknown>; output?: ToolResult }>('hook/dispatch', { event, payload: current }, { timeoutMs: h.hook.timeoutMs ?? 2000 });
      const action = res?.action ?? 'continue';
      helm.audit.write({ plugin: h.pluginId, kind: 'hook', action: `${event} → ${action}`, target: String(current.exposedName ?? ''), decision: action === 'block' ? 'denied' : 'info', reason: res?.reason, session: current.sessionId as string | undefined });
      if (action === 'block') {
        out.action = 'block';
        out.reasons.push({ plugin: h.pluginId, action, reason: res.reason });
        return out;
      }
      if (action === 'ask') {
        out.action = 'ask';
        out.reasons.push({ plugin: h.pluginId, action, reason: res.reason });
      }
      if (action === 'modify') {
        out.reasons.push({ plugin: h.pluginId, action, reason: res.reason });
        if (event === 'tool.before' && res.input && typeof res.input === 'object') { current = { ...current, input: res.input }; out.input = res.input; }
        if (event === 'tool.after' && res.output && Array.isArray(res.output.content)) { current = { ...current, output: res.output }; out.output = res.output; }
      }
    } catch (e) {
      const err = toHelmError(e);
      if (h.hook.onError === 'block') {
        out.action = 'block';
        out.reasons.push({ plugin: h.pluginId, action: 'block', reason: `${event} hook failed (${err.code}: ${err.message}); blocking to be safe` });
        return out;
      }
      out.warnings.push(`${h.pluginId} ${event} hook failed: ${err.message}`);
    }
  }
  return out;
}

/** Payload fields that carry conversation content: only plugins granted conversation.read see them. */
const CONTENT_FIELDS = ['text', 'input', 'output'] as const;

/** What a watcher may see: content fields are removed (and listed in `redacted`) without conversation.read. */
export function payloadFor(helm: Helm, pluginId: string, payload: Record<string, unknown>): Record<string, unknown> {
  const record = helm.state.get(pluginId);
  if (record && findGrant(record, 'conversation.read')) return payload;
  const redacted = CONTENT_FIELDS.filter((f) => payload[f] !== undefined);
  if (!redacted.length) return payload;
  const copy: Record<string, unknown> = { ...payload, redacted };
  for (const f of redacted) delete copy[f];
  return copy;
}

/** Fire-and-forget notification to watch hooks. Never blocks or fails the session. */
export function notifyWatchers(helm: Helm, event: string, payload: Record<string, unknown>) {
  for (const h of helm.contributions().hooks) {
    if (h.hook.event !== event || h.hook.mode !== 'watch' || !h.available) continue;
    helm.process(h.pluginId).call('hook/dispatch', { event, payload: payloadFor(helm, h.pluginId, payload) }, { timeoutMs: h.hook.timeoutMs ?? 5000 }).catch(() => { /* logged by supervisor */ });
  }
}

/**
 * plugin.state events go only to watchers that are already running (they never start a plugin) and
 * never to the plugin the event is about — otherwise an idle stop would restart the plugin forever.
 */
export function notifyStateWatchers(helm: Helm, payload: Record<string, unknown>) {
  for (const h of helm.contributions().hooks) {
    if (h.hook.event !== 'plugin.state' || h.hook.mode !== 'watch' || !h.available || h.pluginId === payload.plugin) continue;
    const proc = helm.process(h.pluginId);
    if (proc.state !== 'active') continue;
    proc.call('hook/dispatch', { event: 'plugin.state', payload }, { timeoutMs: h.hook.timeoutMs ?? 5000 }).catch(() => { /* logged by supervisor */ });
  }
}

/** Start plugins that have session hooks so the first tool call isn't delayed by cold start. */
export async function warmSessionPlugins(helm: Helm) {
  const ids = new Set(helm.contributions().hooks.filter((h) => h.available).map((h) => h.pluginId));
  await Promise.all([...ids].map((id) => helm.process(id).ensureStarted().catch(() => {})));
}
