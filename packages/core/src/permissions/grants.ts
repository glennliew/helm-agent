import type { Grant, Manifest, PermissionRequest, PluginRecord } from '../types.ts';
import { permissionDef, resolvePathScope, riskOf } from './catalog.ts';
import type { Risk, ScopeContext } from './catalog.ts';

export interface ConsentItem {
  id: string;
  title: string;
  scope?: string[];
  reason: string;
  optional: boolean;
  userExtensible: boolean;
  risk: Risk;
  description: string;
  /** For updates: why this needs (re-)consent. */
  change?: 'new' | 'wider';
  addedScope?: string[];
}

export function consentItems(m: Manifest): ConsentItem[] {
  return (m.permissions ?? []).map((p) => toItem(p));
}

function toItem(p: PermissionRequest): ConsentItem {
  const def = permissionDef(p.id)!;
  return {
    id: p.id, title: def.title, scope: p.scope, reason: p.reason, optional: !!p.optional,
    userExtensible: !!p.userExtensible, risk: riskOf(p.id, p.scope), description: humanizeScope(def.describe(p.scope)),
  };
}

/** `${workspace}` is symbolic on purpose (it follows whichever workspace Helm is opened on); say so in words. */
export function humanizeScope(s: string) {
  return s
    .replaceAll('${workspace}/', 'the workspace\u2019s ')
    .replaceAll('${workspace}', 'the current workspace')
    .replaceAll('${pluginData}', 'its own data folder')
    .replaceAll('${home}', '~');
}

/** Permissions in the new manifest that are not covered by existing grants (for updates). */
export function permissionDiff(next: Manifest, current: PluginRecord): ConsentItem[] {
  const out: ConsentItem[] = [];
  for (const p of next.permissions ?? []) {
    const g = current.grants.find((x) => x.id === p.id);
    const wasDeclined = current.declined.includes(p.id);
    if (!g) {
      if (wasDeclined && p.optional) continue; // user already said no to this optional permission
      out.push({ ...toItem(p), change: 'new' });
      continue;
    }
    // Wider = something the current grant does not already cover ("*" covers "api.x.com", so that is not wider).
    const kind = permissionDef(p.id)?.scopeKind ?? 'none';
    const added = (p.scope ?? []).filter((s) => !isNarrowerOrEqual(s, g.scope ?? [], kind));
    // Only flag wider scope if the user had granted the full previously-declared scope.
    if (added.length) out.push({ ...toItem(p), change: 'wider', addedScope: added });
  }
  return out;
}

export interface GrantDecision {
  id: string;
  granted: boolean;
  scope?: string[];
  mode?: 'allow' | 'ask';
}

/** Turn consent decisions into grant records, validating narrowing/extension rules. */
export function buildGrants(m: Manifest, decisions: GrantDecision[], version: string): { grants: Grant[]; declined: string[]; errors: string[] } {
  const grants: Grant[] = [];
  const declined: string[] = [];
  const errors: string[] = [];
  for (const p of m.permissions ?? []) {
    const d = decisions.find((x) => x.id === p.id);
    if (!d || !d.granted) {
      if (!p.optional) errors.push(`"${p.id}" is required by ${m.id}; the plugin cannot be enabled without it`);
      declined.push(p.id);
      continue;
    }
    const def = permissionDef(p.id)!;
    let scope = def.scopeKind === 'none' ? undefined : d.scope ?? p.scope;
    if (scope && p.scope && !p.userExtensible) {
      const extra = scope.filter((s) => !isNarrowerOrEqual(s, p.scope!, def.scopeKind));
      if (extra.length) errors.push(`"${p.id}" scope ${extra.join(', ')} is outside what ${m.id} declared (${p.scope.join(', ')})`);
      scope = scope.filter((s) => !extra.includes(s));
    }
    grants.push({ id: p.id, scope, mode: d.mode ?? 'allow', grantedAt: new Date().toISOString(), version });
  }
  return { grants, declined, errors };
}

/** A user may narrow a declared scope (e.g. "*" → "*.wikipedia.org", "${home}" → "${home}/notes"). */
export function isNarrowerOrEqual(entry: string, declared: string[], kind: string): boolean {
  if (declared.includes(entry)) return true;
  if (kind === 'host') {
    return declared.some((d) => d === '*' || (d.startsWith('*.') && (entry.endsWith(d.slice(1)) || entry === d.slice(2))));
  }
  if (kind === 'path') {
    return declared.some((d) => entry.startsWith(d.endsWith('/') ? d : d + '/'));
  }
  return false;
}

export function findGrant(r: PluginRecord, id: string): Grant | undefined {
  return r.grants.find((g) => g.id === id);
}

export function resolvedPaths(r: PluginRecord, id: 'fs.read' | 'fs.write', ctx: ScopeContext): string[] {
  const g = findGrant(r, id);
  return g?.scope?.map((s) => resolvePathScope(s, ctx)) ?? [];
}

export function missingRequired(m: Manifest, r: PluginRecord): string[] {
  return (m.permissions ?? []).filter((p) => !p.optional && !findGrant(r, p.id)).map((p) => p.id);
}
