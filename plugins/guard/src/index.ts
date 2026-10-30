import { definePlugin, ui } from '@helm-agent/plugin-sdk';
import type { CallContext, HookResult, PluginContext, ToolAfterPayload, ToolBeforePayload, ToolResult } from '@helm-agent/plugin-sdk';

interface Rule { id: string; tools?: string[]; effects?: string[]; match?: string; action: 'block' | 'ask' | 'allow'; reason?: string }
interface Cfg { mode: 'enforce' | 'monitor'; rules: Rule[]; redactPatterns: string[] }
interface Activity { ts: string; tool: string; decision: string; rule?: string; reason?: string; session?: string }

const MAX_ACTIVITY = 200;
let activity: Activity[] = [];

const globRe = (g: string) => new RegExp('^' + g.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 'i');

function strings(v: unknown, out: string[] = []): string[] {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => strings(x, out));
  else if (v && typeof v === 'object') Object.values(v).forEach((x) => strings(x, out));
  return out;
}

function matchRule(rule: Rule, p: ToolBeforePayload): boolean {
  if (rule.tools?.length && !rule.tools.some((g) => globRe(g).test(p.exposedName))) return false;
  if (rule.effects?.length && !rule.effects.includes(p.effect)) return false;
  if (rule.match) {
    let re: RegExp;
    try { re = new RegExp(rule.match, 'i'); } catch { return false; }
    return strings(p.input).some((s) => re.test(s));
  }
  return true;
}

async function record(ctx: PluginContext, a: Omit<Activity, 'ts'>) {
  activity.push({ ts: new Date().toISOString(), ...a });
  if (activity.length > MAX_ACTIVITY) activity = activity.slice(-MAX_ACTIVITY);
  await ctx.storage.set('activity', activity);
  ctx.ui.refresh('activity');
}

function redact(output: ToolResult, patterns: string[]): { output: ToolResult; count: number } {
  let count = 0;
  const res = patterns.flatMap((p) => { try { return [new RegExp(p, 'g')]; } catch { return []; } });
  const scrub = (s: string) => res.reduce((acc, re) => acc.replace(re, () => { count++; return '[redacted by Guard]'; }), s);
  const content = output.content.map((b) => (b.type === 'json' ? { type: 'json' as const, data: JSON.parse(scrub(JSON.stringify(b.data))) } : { ...b, text: scrub(b.text) }));
  return { output: { ...output, content }, count };
}

export default definePlugin({
  async activate(ctx) {
    activity = ((await ctx.storage.get<Activity[]>('activity')) ?? []).slice(-MAX_ACTIVITY);
    ctx.log.info(`Guard active in ${(ctx.config as Cfg).mode} mode with ${(ctx.config as Cfg).rules.length} rules`);
  },

  hooks: {
    async 'tool.before'(p: ToolBeforePayload, ctx): Promise<HookResult> {
      const c = ctx.config as Cfg;
      for (const rule of c.rules) {
        if (!matchRule(rule, p)) continue;
        if (rule.action === 'allow') return { action: 'continue' };
        const reason = `${rule.reason ?? rule.id} [rule ${rule.id}]`;
        if (c.mode === 'monitor') {
          await record(ctx, { tool: p.exposedName, decision: `would ${rule.action}`, rule: rule.id, reason, session: p.sessionId });
          return { action: 'continue' };
        }
        await record(ctx, { tool: p.exposedName, decision: rule.action, rule: rule.id, reason, session: p.sessionId });
        if (rule.action === 'block') await ctx.events.emit('blocked', { tool: p.exposedName, rule: rule.id });
        return { action: rule.action, reason };
      }
      return { action: 'continue' };
    },

    async 'tool.after'(p: ToolAfterPayload, ctx): Promise<HookResult> {
      const { output, count } = redact(p.output, (ctx.config as Cfg).redactPatterns);
      if (!count) return { action: 'continue' };
      await record(ctx, { tool: p.exposedName, decision: 'redacted', reason: `${count} credential(s) removed from output`, session: p.sessionId });
      return { action: 'modify', output, reason: `redacted ${count} credential(s)` };
    },

    async 'session.end'(p: { sessionId: string }, ctx) {
      const n = activity.filter((a) => a.session === p.sessionId).length;
      if (n) ctx.log.info(`session ${p.sessionId} ended with ${n} Guard decision(s)`);
    },
  },

  commands: {
    report(_args, ctx: CallContext) {
      const counts = activity.reduce<Record<string, number>>((acc, a) => { acc[a.decision] = (acc[a.decision] ?? 0) + 1; return acc; }, {});
      return ui.stack(
        ui.heading('Guard report'),
        ui.keyValue({ mode: (ctx.config as Cfg).mode, decisions: activity.length, ...counts }),
        activity.length ? ui.table(['time', 'tool', 'decision', 'reason'], activity.slice(-15).reverse().map((a) => [a.ts.slice(11, 19), a.tool, a.decision, a.reason ?? ''])) : ui.text('Nothing blocked, asked or redacted yet.', 'muted'),
      );
    },
    rules(_args, ctx: CallContext) {
      const c = ctx.config as Cfg;
      return ui.stack(
        ui.heading(`Guard rules (${c.mode})`),
        ui.table(['id', 'action', 'tools', 'match', 'reason'], c.rules.map((r) => [r.id, r.action, (r.tools ?? ['*']).join(', '), r.match ?? '(any input)', r.reason ?? ''])),
        ui.text(`${c.redactPatterns.length} redaction pattern(s) applied to tool output.`, 'muted'),
      );
    },
    async clear(_args, ctx: CallContext) {
      activity = [];
      await ctx.storage.set('activity', activity);
      ctx.ui.refresh('activity');
      return 'Guard activity cleared.';
    },
  },

  panels: {
    activity(ctx) {
      const recent = activity.slice(-25).reverse();
      const tone = (d: string) => (d === 'block' ? 'danger' : d === 'ask' ? 'warning' : d === 'redacted' ? 'success' : 'muted') as 'danger' | 'warning' | 'success' | 'muted';
      return ui.stack(
        ui.keyValue({ mode: (ctx.config as Cfg).mode, rules: (ctx.config as Cfg).rules.length, decisions: activity.length }),
        recent.length
          ? ui.stack(...recent.map((a) => ui.stack(ui.badge(a.decision, tone(a.decision)), ui.text(`${a.ts.slice(11, 19)} ${a.tool} — ${a.reason ?? ''}`))))
          : ui.text('No decisions yet. Guard checks every tool call the agent makes.', 'muted'),
        ui.button('Clear log', 'clear'),
      );
    },
  },
});
