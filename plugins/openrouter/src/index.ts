import { definePlugin, PluginError, ui } from '@helm-agent/plugin-sdk';
import type { CallContext, ModelInfo, ProviderMessage, ProviderRequest, ProviderResponse } from '@helm-agent/plugin-sdk';
import { assertAllowed, blockReason } from './policy.ts';

const RECOMMENDED: Record<string, string> = {
  'anthropic/claude-opus-5.5': 'agent (default)',
  'anthropic/claude-sonnet-5.5': 'fallback',
  'anthropic/claude-haiku-5.5': 'fast',
};

interface Cfg { baseUrl: string; fallbackModels: string[]; fastModel: string; reasoningEffort: string; maxTokens: number; temperature?: number; blockedModels: string[]; appTitle: string }

const cfg = (ctx: CallContext) => ctx.config as Cfg;

function toOpenAI(m: ProviderMessage) {
  if (m.role === 'tool') return { role: 'tool', tool_call_id: m.toolCallId, content: m.content ?? '' };
  if (m.role === 'assistant') {
    const out: Record<string, unknown> = { role: 'assistant', content: m.content ?? '' };
    if (m.toolCalls?.length) out.tool_calls = m.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.arguments ?? {}) } }));
    // Reasoning models need their reasoning blocks echoed back unmodified across tool calls.
    const rd = (m.providerData as { reasoning_details?: unknown } | undefined)?.reasoning_details;
    if (rd) out.reasoning_details = rd;
    return out;
  }
  return { role: m.role, content: m.content ?? '' };
}

function explainHttp(status: number, body: string): PluginError {
  let detail = body.slice(0, 300);
  try { detail = JSON.parse(body)?.error?.message ?? detail; } catch { /* not JSON */ }
  const hints: Record<number, string> = {
    401: 'Your API key was rejected. Set a valid one: helm secrets set helm.openrouter API_KEY',
    402: 'Your OpenRouter account is out of credits: https://openrouter.ai/settings/credits',
    403: 'The request was refused (moderation or key restrictions).',
    404: 'The model id may be wrong. List models: helm cmd openrouter.models',
    429: 'Rate limited by OpenRouter or the upstream provider. Wait and retry.',
  };
  return new PluginError(`OpenRouter error ${status}: ${detail}`, status === 429 ? 'RATE_LIMITED' : 'PROVIDER_ERROR', hints[status] ?? (status >= 500 ? 'The upstream provider had a problem; Helm will use fallbacks when configured.' : undefined));
}

async function complete(req: ProviderRequest, ctx: CallContext): Promise<ProviderResponse> {
  const c = cfg(ctx);
  const primary = req.options?.role === 'fast' ? c.fastModel : req.model ?? 'anthropic/claude-opus-5.5';
  const models = [primary, ...(req.options?.role === 'fast' ? [] : c.fallbackModels)].filter((m, i, a) => a.indexOf(m) === i);
  for (const m of models) assertAllowed(m, c.blockedModels);
  let key: string;
  try { key = await ctx.secrets.get('API_KEY'); } catch (e) {
    throw new PluginError('No OpenRouter API key is set', 'PROVIDER_ERROR', 'Run: helm secrets set helm.openrouter API_KEY');
  }
  const body: Record<string, unknown> = {
    model: primary,
    messages: req.messages.map(toOpenAI),
    max_tokens: req.options?.maxTokens ?? c.maxTokens,
    usage: { include: true },
  };
  if (models.length > 1) body.models = models;
  if (req.tools.length) {
    body.tools = req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
    body.tool_choice = 'auto';
  }
  if (c.reasoningEffort && c.reasoningEffort !== 'none' && req.options?.role !== 'fast') body.reasoning = { effort: c.reasoningEffort };
  if (c.temperature !== undefined) body.temperature = c.temperature;

  ctx.progress(`calling ${primary}`);
  const res = await ctx.net.fetch(`${c.baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', 'http-referer': 'https://github.com/helm-agent/helm', 'x-title': c.appTitle },
    body: JSON.stringify(body),
    timeoutMs: 290_000,
    maxBytes: 10 * 1024 * 1024,
  });
  if (!res.ok) throw explainHttp(res.status, res.body);
  const data = res.json<any>();
  if (data.error) throw new PluginError(`OpenRouter error: ${data.error.message ?? JSON.stringify(data.error)}`, 'PROVIDER_ERROR');
  const choice = data.choices?.[0];
  if (!choice) throw new PluginError('OpenRouter returned no choices', 'PROVIDER_ERROR');
  // Defence in depth: the routed model must also satisfy the policy.
  if (data.model) assertAllowed(data.model, c.blockedModels, 'OpenRouter routed to model');
  const msg = choice.message ?? {};
  const toolCalls = (msg.tool_calls ?? []).map((tc: any) => {
    let args: Record<string, unknown> = {};
    try { args = tc.function?.arguments ? JSON.parse(tc.function.arguments) : {}; } catch { args = { __invalid_json: String(tc.function?.arguments).slice(0, 500) }; }
    return { id: tc.id, name: tc.function?.name, arguments: args };
  });
  return {
    message: { content: msg.content || null, toolCalls: toolCalls.length ? toolCalls : undefined, providerData: msg.reasoning_details ? { reasoning_details: msg.reasoning_details } : undefined },
    model: data.model,
    finishReason: choice.finish_reason,
    usage: { inputTokens: data.usage?.prompt_tokens, outputTokens: data.usage?.completion_tokens, costUsd: data.usage?.cost },
  };
}

async function listModels(ctx: CallContext): Promise<ModelInfo[]> {
  const c = cfg(ctx);
  const res = await ctx.net.fetch(`${c.baseUrl.replace(/\/$/, '')}/models`, { timeoutMs: 30_000, maxBytes: 20 * 1024 * 1024 });
  if (!res.ok) throw explainHttp(res.status, res.body);
  const data = res.json<{ data: any[] }>().data ?? [];
  return data
    .filter((m) => (m.supported_parameters ?? []).includes('tools'))
    .map((m) => {
      const reason = blockReason(m.id, c.blockedModels);
      return {
        id: m.id, name: m.name, contextLength: m.context_length,
        pricing: { inputPerM: Number(m.pricing?.prompt ?? 0) * 1e6, outputPerM: Number(m.pricing?.completion ?? 0) * 1e6 },
        blocked: !!reason, reason, recommended: RECOMMENDED[m.id],
      };
    })
    .sort((a, b) => Number(!!b.recommended) - Number(!!a.recommended) || a.id.localeCompare(b.id));
}

export default definePlugin({
  providers: {
    openrouter: { complete, models: listModels },
  },
  commands: {
    async models({ filter }: { filter?: string }, ctx) {
      const all = await listModels(ctx);
      const rows = all.filter((m) => !m.blocked && (!filter || m.id.includes(filter.toLowerCase())))
        .slice(0, 60)
        .map((m) => [m.id, m.recommended ?? '', String(m.contextLength ?? ''), `$${m.pricing!.inputPerM!.toFixed(2)} / $${m.pricing!.outputPerM!.toFixed(2)}`]);
      const blocked = all.filter((m) => m.blocked).length;
      return ui.stack(ui.heading('OpenRouter models with tool support'), ui.table(['model', 'role', 'context', 'per 1M in / out'], rows), ui.text(`${blocked} model(s) hidden by the blockedModels policy.`, 'muted'));
    },
    check({ model }: { model: string }, ctx) {
      const why = blockReason(model, cfg(ctx).blockedModels);
      return why ? ui.stack(ui.badge('blocked', 'danger'), ui.text(`${model} ${why}`)) : ui.stack(ui.badge('allowed', 'success'), ui.text(`${model} is allowed by the policy.`));
    },
  },
});
