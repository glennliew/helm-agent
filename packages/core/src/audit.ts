import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import type { HelmPaths } from './paths.ts';
import { redactor } from './permissions/secrets.ts';

export interface AuditEntry {
  ts: string;
  plugin: string;
  kind: 'broker' | 'grant' | 'revoke' | 'approval' | 'hook' | 'lifecycle' | 'install';
  action: string;
  permission?: string;
  target?: string;
  decision: 'allowed' | 'denied' | 'info';
  reason?: string;
  session?: string;
}

/** Append-only JSONL audit trail of every security-relevant decision. */
export class AuditLog {
  private file: string;
  constructor(paths: HelmPaths) {
    this.file = paths.audit;
  }
  write(e: Omit<AuditEntry, 'ts'>) {
    const entry: AuditEntry = { ts: new Date().toISOString(), ...e };
    if (entry.target && entry.target.length > 300) entry.target = entry.target.slice(0, 300) + '…';
    try {
      fs.appendFileSync(this.file, redactor.redact(JSON.stringify(entry)) + '\n', { mode: 0o600 });
    } catch {
      /* the audit log must never take the host down */
    }
  }
  query(opts: { plugin?: string; denied?: boolean; limit?: number } = {}): AuditEntry[] {
    let lines: string[];
    try {
      lines = fs.readFileSync(this.file, 'utf8').split('\n').filter(Boolean);
    } catch {
      return [];
    }
    let entries = lines.map((l) => { try { return JSON.parse(l) as AuditEntry; } catch { return undefined; } }).filter((e): e is AuditEntry => !!e);
    if (opts.plugin) entries = entries.filter((e) => e.plugin === opts.plugin);
    if (opts.denied) entries = entries.filter((e) => e.decision === 'denied');
    return entries.slice(-(opts.limit ?? 50));
  }
}

/** Events the host emits for UIs (CLI renderer, web console SSE). */
export interface HostEvents {
  'plugin.state': { plugin: string; from: string; to: string; reason?: string; code?: string };
  'plugin.log': { plugin: string; level: string; message: string };
  'plugin.notify': { plugin: string; level: string; message: string };
  'plugin.progress': { plugin: string; callId?: string; message: string };
  'plugin.event': { plugin: string; event: string; payload: unknown };
  'panel.refresh': { plugin: string; panel?: string };
}

export class HostBus extends EventEmitter {
  emitEvent<K extends keyof HostEvents>(name: K, payload: HostEvents[K]) {
    this.emit(name, payload);
    this.emit('*', { name, payload });
  }
  onEvent<K extends keyof HostEvents>(name: K, fn: (p: HostEvents[K]) => void) {
    this.on(name, fn);
    return () => this.off(name, fn);
  }
}
