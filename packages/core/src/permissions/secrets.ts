import fs from 'node:fs';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import type { HelmPaths } from '../paths.ts';
import { readJsonSync, writeJsonAtomicSync } from '../paths.ts';

/**
 * Secret values are never placed in plugin environment variables or logs. Plugins can only
 * obtain a value through the `host/secrets.get` broker call, and only for names they declared
 * and the user granted. Every value that passes through the host is registered with the
 * redactor so it is scrubbed from logs, transcripts, audit entries and tool output.
 */
export interface SecretStore {
  readonly backend: 'keychain' | 'file';
  get(pluginId: string, name: string): string | undefined;
  set(pluginId: string, name: string, value: string): void;
  delete(pluginId: string, name: string): void;
  list(pluginId: string): string[];
}

class Redactor {
  private values = new Map<string, string>();
  add(value: string, label: string) {
    if (value && value.length >= 6) this.values.set(value, label);
  }
  redact(text: string): string {
    let out = text;
    for (const [v, label] of this.values) if (out.includes(v)) out = out.split(v).join(`[secret:${label}]`);
    return out;
  }
  redactDeep<T>(value: T): T {
    if (this.values.size === 0) return value;
    return JSON.parse(this.redact(JSON.stringify(value))) as T;
  }
}
export const redactor = new Redactor();

const SERVICE = 'helm-agent';

/** Names are tracked in a plain index (names are not secret, values are). */
class SecretIndex {
  private file: string;
  constructor(file: string) {
    this.file = file;
  }
  read(): Record<string, string[]> {
    return readJsonSync<Record<string, string[]>>(this.file, {});
  }
  add(pluginId: string, name: string) {
    const idx = this.read();
    idx[pluginId] = Array.from(new Set([...(idx[pluginId] ?? []), name])).sort();
    writeJsonAtomicSync(this.file, idx);
  }
  remove(pluginId: string, name: string) {
    const idx = this.read();
    idx[pluginId] = (idx[pluginId] ?? []).filter((n) => n !== name);
    writeJsonAtomicSync(this.file, idx);
  }
}

export class KeychainSecretStore implements SecretStore {
  readonly backend = 'keychain' as const;
  private index: SecretIndex;
  constructor(paths: HelmPaths) {
    this.index = new SecretIndex(paths.secretsFile.replace(/\.json$/, '-index.json'));
  }
  static available(): boolean {
    if (process.platform !== 'darwin') return false;
    const r = spawnSync('/usr/bin/security', ['list-keychains'], { encoding: 'utf8' });
    return r.status === 0;
  }
  private account(pluginId: string, name: string) {
    return `${pluginId}/${name}`;
  }
  get(pluginId: string, name: string) {
    const r = spawnSync('/usr/bin/security', ['find-generic-password', '-s', SERVICE, '-a', this.account(pluginId, name), '-w'], { encoding: 'utf8' });
    if (r.status !== 0) return undefined;
    const v = r.stdout.replace(/\n$/, '');
    redactor.add(v, `${pluginId}/${name}`);
    return v;
  }
  set(pluginId: string, name: string, value: string) {
    // Use `security -i` and pass the command on stdin so the value never appears in argv/ps.
    const q = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    const cmd = `add-generic-password -U -s ${q(SERVICE)} -a ${q(this.account(pluginId, name))} -l ${q(`Helm: ${pluginId} ${name}`)} -w ${q(value)}\n`;
    const r = spawnSync('/usr/bin/security', ['-i'], { input: cmd, encoding: 'utf8' });
    if (r.status !== 0 || /error/i.test(r.stderr)) throw new Error(`Keychain write failed: ${r.stderr.trim() || r.status}`);
    this.index.add(pluginId, name);
    redactor.add(value, `${pluginId}/${name}`);
  }
  delete(pluginId: string, name: string) {
    spawnSync('/usr/bin/security', ['delete-generic-password', '-s', SERVICE, '-a', this.account(pluginId, name)], { encoding: 'utf8' });
    this.index.remove(pluginId, name);
  }
  list(pluginId: string) {
    return this.index.read()[pluginId] ?? [];
  }
}

interface EncryptedEntry { iv: string; tag: string; data: string }

/** AES-256-GCM encrypted file with a 0600 key file. Protects against accidental disclosure
 *  (backups, grep, screen sharing) — not against an attacker who can read your home folder. */
export class FileSecretStore implements SecretStore {
  readonly backend = 'file' as const;
  private paths: HelmPaths;
  constructor(paths: HelmPaths) {
    this.paths = paths;
  }
  private key(): Buffer {
    try {
      return Buffer.from(fs.readFileSync(this.paths.secretsKey, 'utf8').trim(), 'hex');
    } catch {
      const k = crypto.randomBytes(32);
      fs.writeFileSync(this.paths.secretsKey, k.toString('hex'), { mode: 0o600 });
      return k;
    }
  }
  private read(): Record<string, EncryptedEntry> {
    return readJsonSync<Record<string, EncryptedEntry>>(this.paths.secretsFile, {});
  }
  get(pluginId: string, name: string) {
    const e = this.read()[`${pluginId}/${name}`];
    if (!e) return undefined;
    const d = crypto.createDecipheriv('aes-256-gcm', this.key(), Buffer.from(e.iv, 'base64'));
    d.setAuthTag(Buffer.from(e.tag, 'base64'));
    const v = Buffer.concat([d.update(Buffer.from(e.data, 'base64')), d.final()]).toString('utf8');
    redactor.add(v, `${pluginId}/${name}`);
    return v;
  }
  set(pluginId: string, name: string, value: string) {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', this.key(), iv);
    const data = Buffer.concat([c.update(value, 'utf8'), c.final()]);
    const all = this.read();
    all[`${pluginId}/${name}`] = { iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') };
    writeJsonAtomicSync(this.paths.secretsFile, all);
    redactor.add(value, `${pluginId}/${name}`);
  }
  delete(pluginId: string, name: string) {
    const all = this.read();
    delete all[`${pluginId}/${name}`];
    writeJsonAtomicSync(this.paths.secretsFile, all);
  }
  list(pluginId: string) {
    return Object.keys(this.read()).filter((k) => k.startsWith(`${pluginId}/`)).map((k) => k.slice(pluginId.length + 1)).sort();
  }
}

export function openSecretStore(paths: HelmPaths, backend: 'keychain' | 'file'): SecretStore {
  if (backend === 'keychain' && KeychainSecretStore.available()) return new KeychainSecretStore(paths);
  return new FileSecretStore(paths);
}
