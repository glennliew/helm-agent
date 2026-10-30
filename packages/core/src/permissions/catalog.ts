import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { isWithin, realpathLoose } from '../paths.ts';

export type Risk = 'low' | 'medium' | 'high';
export type ScopeKind = 'path' | 'host' | 'command' | 'secret' | 'none';

export interface PermissionDef {
  id: string;
  title: string;
  scopeKind: ScopeKind;
  enforcedBy: string;
  risk(scope?: string[]): Risk;
  describe(scope?: string[]): string;
}

const list = (s?: string[]) => (s && s.length ? s.join(', ') : '(none)');

export const PERMISSIONS: Record<string, PermissionDef> = {
  'fs.read': {
    id: 'fs.read', title: 'Read files', scopeKind: 'path', enforcedBy: 'broker + macOS sandbox + Node permission model',
    risk: (s) => (s?.some((p) => p === '${home}' || p === '/' || p.startsWith('${home}')) ? 'high' : 'medium'),
    describe: (s) => `read files in ${list(s)}`,
  },
  'fs.write': {
    id: 'fs.write', title: 'Write files', scopeKind: 'path', enforcedBy: 'broker + macOS sandbox + Node permission model',
    risk: () => 'high', describe: (s) => `create, modify and delete files in ${list(s)}`,
  },
  'net.http': {
    id: 'net.http', title: 'Make HTTP requests', scopeKind: 'host', enforcedBy: 'broker (direct sockets are blocked by the sandbox)',
    risk: (s) => (s?.includes('*') ? 'high' : 'medium'),
    describe: (s) => (s?.includes('*') ? 'contact any internet host' : `contact ${list(s)}`),
  },
  'net.local': {
    id: 'net.local', title: 'Reach localhost and private networks', scopeKind: 'none', enforcedBy: 'broker',
    risk: () => 'high', describe: () => 'reach localhost, LAN and other private addresses',
  },
  'process.exec': {
    id: 'process.exec', title: 'Run programs', scopeKind: 'command', enforcedBy: 'broker spawns inside a sandbox; the plugin itself cannot exec',
    risk: () => 'high', describe: (s) => `run ${list(s)} (with any arguments) inside the sandbox`,
  },
  secrets: {
    id: 'secrets', title: 'Read secrets', scopeKind: 'secret', enforcedBy: 'broker; values are redacted from logs',
    risk: () => 'high', describe: (s) => `read the secret(s) ${list(s)} that you store for it`,
  },
  'conversation.read': {
    id: 'conversation.read', title: 'Read the conversation', scopeKind: 'none', enforcedBy: 'host filters event payloads',
    risk: () => 'medium', describe: () => 'see the messages you and the model exchange',
  },
  'tool.intercept': {
    id: 'tool.intercept', title: 'Intercept tool calls', scopeKind: 'none', enforcedBy: 'hook dispatcher',
    risk: () => 'high', describe: () => 'inspect, block or modify every tool call and its result',
  },
  'llm.invoke': {
    id: 'llm.invoke', title: 'Use the model', scopeKind: 'none', enforcedBy: 'broker',
    risk: () => 'medium', describe: () => 'send its own prompts to your model provider (uses your tokens)',
  },
};

export function permissionDef(id: string): PermissionDef | undefined {
  return PERMISSIONS[id];
}

export interface ScopeContext {
  workspace: string;
  pluginData: string;
  home?: string;
}

/** Expand ${workspace}/${home}/${pluginData} and canonicalise a declared path scope. */
export function resolvePathScope(entry: string, ctx: ScopeContext): string {
  let p = entry
    .replaceAll('${workspace}', ctx.workspace)
    .replaceAll('${pluginData}', ctx.pluginData)
    .replaceAll('${home}', ctx.home ?? os.homedir());
  if (p.startsWith('~/')) p = path.join(ctx.home ?? os.homedir(), p.slice(2));
  return realpathLoose(p);
}

/**
 * Check a requested path against granted roots. The path is resolved relative to the workspace,
 * then canonicalised (symlinks, `..`) before comparison, so escapes via links or traversal fail.
 */
export function checkPath(requested: string, roots: string[], ctx: ScopeContext): { ok: boolean; resolved: string } {
  const abs = path.isAbsolute(requested) ? requested : path.join(ctx.workspace, requested);
  const resolved = realpathLoose(abs);
  const ok = roots.some((r) => isWithin(resolved, resolvePathScope(r, ctx)));
  return { ok, resolved };
}

export function hostMatches(host: string, patterns: string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  return patterns.some((raw) => {
    const p = raw.toLowerCase().trim();
    if (p === '*') return true;
    if (p.startsWith('*.')) return h.endsWith(p.slice(1)) && h.length > p.length - 1;
    return h === p;
  });
}

export function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number) as [number, number];
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (v === '::1' || v === '::') return true;
    if (v.startsWith('::ffff:')) return isPrivateAddress(v.slice(7));
    return v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe8') || v.startsWith('fe9') || v.startsWith('fea') || v.startsWith('feb') || v.startsWith('ff');
  }
  return true;
}

export function riskOf(id: string, scope?: string[]): Risk {
  return permissionDef(id)?.risk(scope) ?? 'high';
}
