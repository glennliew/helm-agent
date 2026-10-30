import readline from 'node:readline/promises';
import type { Manifest } from '../../core/src/types.ts';
import type { ConsentItem, GrantDecision } from '../../core/src/permissions/grants.ts';
import type { Approver, ApprovalRequest } from '../../core/src/permissions/broker.ts';
import { HelmError, ErrorCode } from '../../core/src/errors.ts';
import { expectedIsolation } from '../../core/src/runtime/launch.ts';
import { c, out, riskBadge, sym } from './ui.ts';

export const isInteractive = () => !!(process.stdin.isTTY && process.stdout.isTTY);

export class Prompter {
  rl?: readline.Interface;
  constructor(rl?: readline.Interface) { this.rl = rl; }

  private iface() {
    if (!this.rl) this.rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return this.rl;
  }

  async ask(q: string): Promise<string> {
    return (await this.iface().question(q)).trim();
  }

  async confirm(q: string, def = true): Promise<boolean> {
    const a = (await this.ask(`${q} ${c.dim(def ? '[Y/n]' : '[y/N]')} `)).toLowerCase();
    return a === '' ? def : a.startsWith('y');
  }

  /** Read a line without echoing it (API keys). */
  async secret(q: string): Promise<string> {
    if (!process.stdin.isTTY) {
      const chunks: Buffer[] = [];
      for await (const ch of process.stdin) chunks.push(ch as Buffer);
      return Buffer.concat(chunks).toString('utf8').trim();
    }
    this.rl?.pause();
    process.stdout.write(q);
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    return new Promise((resolve) => {
      let buf = '';
      const onData = (d: Buffer) => {
        for (const ch of d.toString('utf8')) {
          if (ch === '\r' || ch === '\n') {
            stdin.setRawMode(false);
            stdin.off('data', onData);
            stdin.pause();
            process.stdout.write('\n');
            this.rl?.resume();
            return resolve(buf.trim());
          }
          if (ch === '\u0003') { process.stdout.write('\n'); process.exit(130); }
          if (ch === '\u007f' || ch === '\b') { if (buf.length) { buf = buf.slice(0, -1); process.stdout.write('\b \b'); } continue; }
          buf += ch;
          process.stdout.write('•');
        }
      };
      stdin.on('data', onData);
    });
  }

  close() {
    this.rl?.close();
    this.rl = undefined;
  }
}

// ------------------------------------------------------------------ consent
export function printConsent(m: Manifest, items: ConsentItem[], header?: string) {
  const iso = expectedIsolation(m);
  out();
  out(`${c.bold(m.name)} ${c.dim(`${m.id}@${m.version}`)}${m.publisher ? c.dim(` by ${m.publisher}`) : ''}`);
  out(`  ${m.description}`);
  const contrib = m.contributes ?? {};
  const parts = [
    contrib.tools?.length ? `tools: ${contrib.tools.map((t) => t.name).join(', ')}` : '',
    contrib.commands?.length ? `commands: ${contrib.commands.map((x) => x.name).join(', ')}` : '',
    contrib.hooks?.length ? `hooks: ${contrib.hooks.map((h) => `${h.event} (${h.mode})`).join(', ')}` : '',
    contrib.panels?.length ? `panels: ${contrib.panels.map((p) => p.id).join(', ')}` : '',
    contrib.providers?.length ? `model providers: ${contrib.providers.map((p) => p.id).join(', ')}` : '',
  ].filter(Boolean);
  if (parts.length) out(c.dim(`  adds ${parts.join(' · ')}`));
  out(c.dim(`  runtime: ${m.runtime.type} · isolation here: `) + (iso.level === 'strict' ? c.green('strict (macOS sandbox)') : c.yellow(`${iso.level} — ${iso.reason}`)));
  out();
  if (!items.length) {
    out(`  ${c.green(sym.ok)} ${header ?? 'Requests no permissions.'}`);
    return;
  }
  out(header ?? `  It asks for ${items.length} permission(s):`);
  items.forEach((it, i) => {
    const tag = [it.optional ? c.dim('optional') : c.bold('required'), riskBadge(it.risk), it.change ? c.magenta(it.change === 'new' ? 'NEW' : 'WIDER') : ''].filter(Boolean).join(' · ');
    out(`  ${i + 1}. ${c.bold(it.id)}  ${tag}`);
    out(`     ${it.description}`);
    if (it.change === 'wider' && it.addedScope?.length) out(`     ${c.magenta(`adds: ${it.addedScope.join(', ')}`)}`);
    out(c.dim(`     why: ${it.reason}`));
  });
  out();
}

function parseGrantFlags(flags: string[] = []) {
  const map = new Map<string, string[] | undefined>();
  for (const f of flags) {
    const [id, scope] = f.split('=', 2) as [string, string | undefined];
    map.set(id.trim(), scope ? scope.split(',').map((s) => s.trim()).filter(Boolean) : undefined);
  }
  return map;
}

export async function collectConsent(items: ConsentItem[], opts: { yes?: boolean; grant?: string[]; deny?: string[]; prompter: Prompter }): Promise<GrantDecision[]> {
  const grants = parseGrantFlags(opts.grant);
  const denies = new Set(opts.deny ?? []);
  const decisions: GrantDecision[] = [];
  const undecided: ConsentItem[] = [];
  for (const it of items) {
    if (denies.has(it.id)) decisions.push({ id: it.id, granted: false });
    else if (grants.has(it.id)) decisions.push({ id: it.id, granted: true, scope: grants.get(it.id) ?? it.scope });
    else if (opts.yes) decisions.push({ id: it.id, granted: true, scope: it.scope });
    else undecided.push(it);
  }
  if (!undecided.length) return decisions;
  if (!isInteractive()) {
    throw new HelmError(ErrorCode.CONSENT_REQUIRED, `Consent needed for: ${undecided.map((u) => u.id).join(', ')}`, {
      hint: 'Re-run in a terminal, pass --yes to grant as requested, or --grant <perm>[=scope,...] / --deny <perm> for each.',
    });
  }
  for (const it of undecided) {
    const choices = it.scope?.length ? '[Y]es / [n]o / [e]dit scope / [a]sk each time' : '[Y]es / [n]o / [a]sk each time';
    const a = (await opts.prompter.ask(`  Grant ${c.bold(it.id)}${it.scope?.length ? c.dim(` (${it.scope.join(', ')})`) : ''}? ${c.dim(choices)} `)).toLowerCase();
    if (a.startsWith('n')) decisions.push({ id: it.id, granted: false });
    else if (a.startsWith('a')) decisions.push({ id: it.id, granted: true, scope: it.scope, mode: 'ask' });
    else if (a.startsWith('e') && it.scope?.length) {
      const s = await opts.prompter.ask(`    scope for ${it.id} ${c.dim(`(comma-separated, requested: ${it.scope.join(', ')})`)}: `);
      decisions.push({ id: it.id, granted: true, scope: s ? s.split(',').map((x) => x.trim()).filter(Boolean) : it.scope });
    } else decisions.push({ id: it.id, granted: true, scope: it.scope });
  }
  return decisions;
}

// ------------------------------------------------------------------ approvals
export function cliApprover(prompter: Prompter, opts: { yes?: boolean; onBeforePrompt?: () => void } = {}): Approver {
  return {
    async request(req: ApprovalRequest) {
      if (opts.yes) return 'allow';
      opts.onBeforePrompt?.();
      if (!isInteractive()) {
        process.stderr.write(`${c.yellow(sym.warn)} ${req.title} — denied (no terminal to ask; pass --yes to allow)\n`);
        return 'deny';
      }
      out(`\n${c.yellow('┌ approval needed')} ${c.bold(req.title)}`);
      for (const l of req.detail.split('\n').slice(0, 14)) out(`${c.yellow('│')} ${c.dim(l)}`);
      const a = (await prompter.ask(`${c.yellow('└')} allow? ${c.dim('[y]es / [N]o / [a]lways this session')} `)).toLowerCase();
      return a.startsWith('a') ? 'always' : a.startsWith('y') ? 'allow' : 'deny';
    },
  };
}
