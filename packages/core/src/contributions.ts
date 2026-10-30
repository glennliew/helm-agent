import type { Manifest, PluginRecord, ToolContribution, CommandContribution, PanelContribution, ProviderContribution, HookContribution } from './types.ts';
import { compatibilityProblem } from './manifest/manifest.ts';
import { findGrant, missingRequired } from './permissions/grants.ts';
import { expectedIsolation } from './runtime/launch.ts';
import type { HostConfig } from './types.ts';

export interface Availability {
  available: boolean;
  reason?: string;
  code?: string;
}

/** Why a plugin can or cannot run right now — the single source of truth for every UI. */
export function pluginAvailability(m: Manifest | undefined, r: PluginRecord, cfg: HostConfig): Availability {
  if (!m) return { available: false, reason: 'manifest missing or invalid', code: 'MANIFEST_INVALID' };
  if (!r.enabled) return { available: false, reason: 'disabled', code: 'PLUGIN_DISABLED' };
  const compat = compatibilityProblem(m);
  if (compat) return { available: false, reason: compat, code: 'INCOMPATIBLE_VERSION' };
  if (r.health.quarantinedAt) return { available: false, reason: `quarantined: ${r.health.lastError?.message ?? 'repeated crashes'}`, code: 'PLUGIN_QUARANTINED' };
  const missing = missingRequired(m, r);
  if (missing.length) return { available: false, reason: `missing required permission(s): ${missing.join(', ')}`, code: 'PERMISSION_DENIED' };
  const iso = expectedIsolation(m);
  if (iso.level !== 'strict' && cfg.security.requireStrictIsolation && !r.trusted) {
    return { available: false, reason: `needs the macOS sandbox (${iso.reason}); trust it to run with ${iso.level} isolation`, code: 'ISOLATION_UNAVAILABLE' };
  }
  return { available: true };
}

export function shortName(id: string): string {
  const parts = id.split('.');
  return (parts.length > 1 ? parts.slice(1).join('_') : id).replace(/[^a-zA-Z0-9_-]/g, '_');
}

export interface ToolEntry extends Availability {
  pluginId: string;
  pluginName: string;
  tool: ToolContribution;
  exposedName: string;
}
export interface CommandEntry extends Availability { pluginId: string; command: CommandContribution; qualified: string }
export interface PanelEntry extends Availability { pluginId: string; panel: PanelContribution; qualified: string }
export interface ProviderEntry extends Availability { pluginId: string; provider: ProviderContribution; qualified: string }
export interface HookEntry extends Availability { pluginId: string; hook: HookContribution }

export interface Installed {
  record: PluginRecord;
  manifest?: Manifest;
}

export function collectContributions(installed: Installed[], cfg: HostConfig) {
  const tools: ToolEntry[] = [];
  const commands: CommandEntry[] = [];
  const panels: PanelEntry[] = [];
  const providers: ProviderEntry[] = [];
  const hooks: HookEntry[] = [];
  const shortCounts = new Map<string, number>();
  for (const { manifest } of installed) if (manifest) shortCounts.set(shortName(manifest.id), (shortCounts.get(shortName(manifest.id)) ?? 0) + 1);
  for (const { record: r, manifest: m } of installed) {
    if (!m) continue;
    const avail = pluginAvailability(m, r, cfg);
    const prefix = (shortCounts.get(shortName(m.id)) ?? 0) > 1 ? m.id.replace(/[^a-zA-Z0-9]/g, '_') : shortName(m.id);
    for (const t of m.contributes?.tools ?? []) {
      let a: Availability = avail;
      if (avail.available) {
        const missing = (t.requires ?? []).filter((p) => !findGrant(r, p));
        if (missing.length) a = { available: false, reason: `needs ${missing.join(', ')} (not granted)`, code: 'PERMISSION_DENIED' };
      }
      tools.push({ ...a, pluginId: m.id, pluginName: m.name, tool: t, exposedName: `${prefix}__${t.name}`.slice(0, 64) });
    }
    for (const c of m.contributes?.commands ?? []) commands.push({ ...avail, pluginId: m.id, command: c, qualified: `${shortName(m.id)}.${c.name}` });
    for (const p of m.contributes?.panels ?? []) panels.push({ ...avail, pluginId: m.id, panel: p, qualified: `${shortName(m.id)}.${p.id}` });
    for (const p of m.contributes?.providers ?? []) providers.push({ ...avail, pluginId: m.id, provider: p, qualified: `${m.id}/${p.id}` });
    for (const h of m.contributes?.hooks ?? []) {
      let a: Availability = avail;
      if (avail.available && h.mode === 'intercept' && !findGrant(r, 'tool.intercept')) a = { available: false, reason: 'tool.intercept not granted', code: 'PERMISSION_DENIED' };
      if (avail.available && ['message.user', 'model.response'].includes(h.event) && !findGrant(r, 'conversation.read')) a = { available: false, reason: 'conversation.read not granted', code: 'PERMISSION_DENIED' };
      hooks.push({ ...a, pluginId: m.id, hook: h });
    }
  }
  return { tools, commands, panels, providers, hooks };
}
