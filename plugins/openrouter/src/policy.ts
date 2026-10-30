// Model allow/block policy. Pure functions so they can be unit-tested without a host.
//
// Rule syntax:
//   "openai/gpt>=6"            blocks openai/gpt-6, gpt-6.1-mini, gpt-7 … (major version ≥ 6)
//   "anthropic/claude-fable>=5" blocks claude-fable-5, claude-fable-5.1 …
//   "~*"                        blocks every "~vendor/model-latest" alias (they can move to a blocked model)
//   "openrouter/*"              blocks routers such as openrouter/auto (they choose the model for you)
//   "x-ai/*"                    any glob

export function normalizeModelId(id: string): string {
  return id.trim().toLowerCase().replace(/:[a-z0-9-]+$/, ''); // strip ":free", ":thinking" … variants
}

function globToRegex(glob: string): RegExp {
  return new RegExp('^' + glob.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
}

export function blockReason(modelId: string, rules: string[]): string | undefined {
  const id = normalizeModelId(modelId);
  for (const rule of rules) {
    const r = rule.trim().toLowerCase();
    const ver = /^(.+?)>=(\d+)$/.exec(r);
    if (ver) {
      const family = ver[1]!;
      const min = Number(ver[2]);
      const plain = id.replace(/^~/, '');
      if (plain.startsWith(family)) {
        const m = new RegExp(`^${family.replace(/[.+?^${}()|[\]\\]/g, '\\$&')}-?(\\d+)`).exec(plain);
        if (m && Number(m[1]) >= min) return `matches policy rule "${rule}" (major version ${m[1]} ≥ ${min})`;
      }
      continue;
    }
    if (globToRegex(r).test(id)) return `matches policy rule "${rule}"`;
  }
  return undefined;
}

export function assertAllowed(modelId: string, rules: string[], what = 'Model'): void {
  const why = blockReason(modelId, rules);
  if (why) {
    const e = new Error(`${what} "${modelId}" is blocked by the model policy: ${why}`) as Error & { code: string; hint: string };
    e.code = 'PROVIDER_ERROR';
    e.hint = 'Pick an allowed model (see `helm cmd openrouter.models`) with `helm provider use helm.openrouter/openrouter --model <id>` or `-m <id>`; the policy itself is the blockedModels setting of helm.openrouter.';
    throw e;
  }
}
