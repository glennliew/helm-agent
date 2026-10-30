import { definePlugin } from '@helm-agent/plugin-sdk';
import type { ProviderRequest, ProviderResponse } from '@helm-agent/plugin-sdk';

// A scripted "model" so the whole agent loop (tools, approvals, hooks) can be tested offline.
//   "call files__read_file {"path":"README.md"}"  → emits that exact tool call
//   "use read_file path=README.md"                 → fuzzy tool match + key=value args
//   "call a {..} then call b {..}"                 → several tool calls in one turn
//   anything else                                  → "Mock reply: <text>"
// After tool results arrive it summarises them, so a run always terminates.

let counter = 0;

function findTool(req: ProviderRequest, name: string) {
  return req.tools.find((t) => t.name === name) ?? req.tools.find((t) => t.name.endsWith(`__${name}`)) ?? req.tools.find((t) => t.name.includes(name));
}

function parseDirectives(req: ProviderRequest, text: string) {
  const calls: Array<{ id: string; name: string; arguments: Record<string, unknown> }> = [];
  const re = /\bcall\s+([\w-]+)(?:\s+(\{.*?\}))?(?=\s+then\s+|\s*$)/gs;
  for (const m of text.matchAll(re)) {
    const tool = findTool(req, m[1]!);
    let args: Record<string, unknown> = {};
    if (m[2]) { try { args = JSON.parse(m[2]); } catch { args = { __invalid_json: m[2] }; } }
    if (tool) calls.push({ id: `call_${++counter}`, name: tool.name, arguments: args });
  }
  const use = /\buse\s+([\w-]+)((?:\s+\w+=\S+)*)/.exec(text);
  if (!calls.length && use) {
    const tool = findTool(req, use[1]!);
    const args: Record<string, unknown> = {};
    for (const kv of (use[2] ?? '').trim().split(/\s+/).filter(Boolean)) {
      const [k, ...v] = kv.split('=');
      const raw = v.join('=');
      args[k!] = /^-?\d+$/.test(raw) ? Number(raw) : raw === 'true' ? true : raw === 'false' ? false : raw;
    }
    if (tool) calls.push({ id: `call_${++counter}`, name: tool.name, arguments: args });
  }
  return calls;
}

export default definePlugin({
  providers: {
    mock: {
      async complete(req): Promise<ProviderResponse> {
        const last = req.messages.at(-1);
        const usage = { inputTokens: JSON.stringify(req.messages).length / 4 | 0, outputTokens: 20, costUsd: 0 };
        if (last?.role === 'tool') {
          const results = [];
          for (let i = req.messages.length - 1; i >= 0 && req.messages[i]!.role === 'tool'; i--) results.unshift(req.messages[i]!);
          const lines = results.map((r) => `- ${r.name}: ${String(r.content ?? '').replace(/\s+/g, ' ').slice(0, 300)}`);
          return { message: { content: `Mock summary of ${results.length} tool result(s):\n${lines.join('\n')}` }, model: req.model ?? 'mock-1', finishReason: 'stop', usage };
        }
        const text = String(last?.content ?? '');
        const calls = parseDirectives(req, text);
        if (calls.length) return { message: { content: null, toolCalls: calls }, model: req.model ?? 'mock-1', finishReason: 'tool_calls', usage };
        return { message: { content: `Mock reply: ${text} (tools available: ${req.tools.length})` }, model: req.model ?? 'mock-1', finishReason: 'stop', usage };
      },
      async models() {
        return [{ id: 'mock-1', name: 'Mock 1 (scripted, offline)', recommended: 'agent' }];
      },
    },
  },
});
