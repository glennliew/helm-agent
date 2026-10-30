import type { Manifest, PluginLimits, PluginRecord } from './types.ts';
import { ajv } from './manifest/manifest.ts';
import { HelmError, ErrorCode } from './errors.ts';

export const DEFAULT_LIMITS: Required<PluginLimits> = {
  callTimeoutMs: 30_000,
  activationTimeoutMs: 10_000,
  maxConcurrency: 4,
  memoryMb: 256,
  idleTimeoutMs: 10 * 60_000,
};

export function effectiveLimits(m: Manifest, r?: PluginRecord): Required<PluginLimits> {
  return { ...DEFAULT_LIMITS, ...(m.limits ?? {}), ...(r?.limitOverrides ?? {}) };
}

/** Config = schema defaults + user values. Throws CONFIG_INVALID with readable messages. */
export function effectiveConfig(m: Manifest, values: Record<string, unknown> = {}): Record<string, unknown> {
  const schema = m.contributes?.configuration;
  const cfg = structuredClone(values);
  if (!schema) return cfg;
  const validate = ajv.compile(schema);
  if (!validate(cfg)) {
    const msg = (validate.errors ?? []).map((e) => `${e.instancePath || '(root)'} ${e.message}`).join('; ');
    throw new HelmError(ErrorCode.CONFIG_INVALID, `Invalid config for ${m.id}: ${msg}`);
  }
  return cfg;
}

export function validateConfig(m: Manifest, values: Record<string, unknown>): string[] {
  try {
    effectiveConfig(m, values);
    return [];
  } catch (e) {
    return [(e as Error).message];
  }
}

/** Describe the configuration schema as rows for CLI/web rendering. */
export function configFields(m: Manifest, values: Record<string, unknown> = {}) {
  const schema = (m.contributes?.configuration ?? {}) as { properties?: Record<string, any> };
  const eff = (() => { try { return effectiveConfig(m, values); } catch { return values; } })();
  return Object.entries(schema.properties ?? {}).map(([key, s]) => ({
    key,
    type: Array.isArray(s.type) ? s.type.join('|') : (s.type ?? 'any'),
    description: s.description ?? '',
    enum: s.enum as unknown[] | undefined,
    default: s.default,
    value: eff[key],
    isSet: key in values,
  }));
}
