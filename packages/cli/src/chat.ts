import readline from 'node:readline/promises';
import type { Helm } from '../../core/src/helm.ts';
import { Session } from '../../core/src/agent/session.ts';
import type { SessionEvent } from '../../core/src/agent/session.ts';
import { c, out, renderUI, sym, table, printError } from './ui.ts';
import { Prompter, cliApprover } from './prompt.ts';

class StatusLine {
  private active = false;
  set(text: string) {
    if (!process.stdout.isTTY) return;
    process.stdout.write(`\r\x1b[2K${c.dim(`… ${text}`)}`);
    this.active = true;
  }
  clear() {
    if (this.active) process.stdout.write('\r\x1b[2K');
    this.active = false;
  }
}

export function eventPrinter(status = new StatusLine(), opts: { verbose?: boolean } = {}) {
  return (e: SessionEvent) => {
    if (e.type !== 'status') status.clear();
    switch (e.type) {
      case 'status': status.set(e.message); break;
      case 'tool.start': out(c.dim(`  ${sym.gear} ${e.tool} ${JSON.stringify(e.input).slice(0, 140)}`)); break;
      case 'tool.end':
        if (e.ok) out(`  ${c.green(sym.ok)} ${c.dim(`${e.tool} · ${e.durationMs} ms`)}${opts.verbose ? c.dim(` · ${e.summary}`) : ''}`);
        else out(`  ${e.blocked ? c.yellow(sym.warn) : c.red(sym.fail)} ${e.tool}: ${e.blocked ? c.yellow(e.summary) : c.red(e.summary)}${e.error?.hint && !e.blocked ? c.dim(`\n    ${sym.arrow} ${e.error.hint}`) : ''}`);
        break;
      case 'assistant': out(`\n${e.text}\n`); break;
      case 'model': {
        const u = e.usage;
        const cost = u?.costUsd ? ` · $${u.costUsd.toFixed(4)}` : '';
        if (opts.verbose || u?.costUsd) out(c.dim(`  (${e.model ?? e.provider}${u?.inputTokens ? ` · ${u.inputTokens} in / ${u.outputTokens ?? 0} out` : ''}${cost})`));
        break;
      }
      case 'warning': out(c.yellow(`  ${sym.warn} ${e.message}`)); break;
      case 'error': out(`${c.red(`${sym.fail} ${e.error.message}`)} ${c.dim(`[${e.error.code}]`)}${e.error.hint ? `\n  ${c.cyan(sym.arrow)} ${e.error.hint}` : ''}`); break;
      case 'done': break;
    }
  };
}

const HELP = `
  ${c.bold('Chat commands')}
  /tools               tools the agent can use right now (and why others are unavailable)
  /plugins             installed plugins and their state
  /model [id]          show or switch the model for this chat
  /cmd <plugin.cmd> [k=v ...]   run a plugin command
  /panel <plugin.panel>         render a plugin panel
  /clear               start a fresh conversation
  /exit                quit (Ctrl+D). Ctrl+C cancels the running turn.
`;

function parseKv(parts: string[]) {
  const args: Record<string, unknown> = {};
  for (const p of parts) {
    const i = p.indexOf('=');
    if (i < 0) continue;
    const v = p.slice(i + 1);
    args[p.slice(0, i)] = /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v === 'true' ? true : v === 'false' ? false : v;
  }
  return args;
}

export async function runChat(helm: Helm, opts: { model?: string; provider?: string; yes?: boolean; verbose?: boolean }) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, historySize: 200 });
  const prompter = new Prompter(rl);
  const status = new StatusLine();
  helm.approver = cliApprover(prompter, { yes: opts.yes, onBeforePrompt: () => status.clear() });
  let session = new Session(helm, { model: opts.model, provider: opts.provider });
  let controller: AbortController | undefined;
  rl.on('SIGINT', () => {
    if (controller) { controller.abort(); out(c.yellow('\n  cancelled')); }
    else { rl.close(); }
  });
  helm.bus.onEvent('plugin.notify', (n) => { status.clear(); out(c.cyan(`  [${n.plugin}] ${n.message}`)); });
  helm.bus.onEvent('plugin.state', (s) => {
    if (s.to === 'crashed' || s.to === 'quarantined') { status.clear(); out(c.red(`  ${sym.fail} ${s.plugin} ${s.to}: ${s.reason ?? ''}`)); }
  });

  try {
    const { entry, model } = helm.resolveProvider({ provider: opts.provider, model: opts.model });
    const tools = session.availableTools();
    out(`${c.bold('Helm')} ${c.dim(`· ${entry.qualified} · ${model ?? 'default model'} · ${tools.length} tools from ${new Set(tools.map((t) => t.pluginId)).size} plugins · workspace ${helm.workspace}`)}`);
  } catch (e) {
    printError(e);
    rl.close();
    return;
  }
  out(c.dim('  Type a message, or /help.'));

  for (;;) {
    let line: string;
    try { line = (await rl.question(c.cyan('\nhelm› '))).trim(); } catch { break; }
    if (!line) continue;
    if (line.startsWith('/')) {
      const [cmd, ...rest] = line.slice(1).split(/\s+/);
      try {
        if (cmd === 'exit' || cmd === 'quit') break;
        else if (cmd === 'help') out(HELP);
        else if (cmd === 'clear') { await session.end(); session = new Session(helm, { model: session.model, provider: session.provider }); out(c.dim('  new conversation')); }
        else if (cmd === 'model') {
          if (rest[0]) { session.model = rest[0]; out(c.dim(`  model → ${rest[0]}`)); }
          else out(`  ${helm.resolveProvider({ provider: session.provider, model: session.model }).model}`);
        } else if (cmd === 'tools') {
          const tools = helm.contributions().tools;
          out(table(['tool', 'effect', 'status'], tools.map((t) => [t.exposedName, t.tool.effect, t.available ? c.green('ready') : c.yellow(t.reason ?? 'unavailable')])));
        } else if (cmd === 'plugins') {
          out(table(['plugin', 'version', 'status'], helm.installed().map(({ record }) => { const a = helm.availability(record.id); return [record.id, record.version, a.available ? c.green('ready') : c.yellow(a.reason ?? '')]; })));
        } else if (cmd === 'cmd' && rest[0]) {
          const ce = helm.findCommand(rest[0]);
          const r = await helm.runCommand(ce.pluginId, ce.command.name, parseKv(rest.slice(1)));
          if (r.ui) out(renderUI(r.ui));
          for (const b of r.content ?? []) out(b.type === 'json' ? JSON.stringify(b.data, null, 2) : b.text);
        } else if (cmd === 'panel' && rest[0]) {
          const p = helm.contributions().panels.find((x) => x.qualified === rest[0]);
          if (!p) out(c.yellow(`  no panel ${rest[0]}; panels: ${helm.contributions().panels.map((x) => x.qualified).join(', ')}`));
          else out(renderUI(await helm.renderPanel(p.pluginId, p.panel.id)));
        } else out(c.yellow(`  unknown command /${cmd}; try /help`));
      } catch (e) { printError(e); }
      continue;
    }
    controller = new AbortController();
    try {
      await session.send(line, eventPrinter(status, { verbose: opts.verbose }), controller.signal);
    } catch (e) {
      status.clear();
      printError(e);
    } finally {
      controller = undefined;
    }
  }
  await session.end();
  rl.close();
}

export async function runOnce(helm: Helm, prompt: string, opts: { model?: string; provider?: string; yes?: boolean; json?: boolean; verbose?: boolean }) {
  const prompter = new Prompter();
  const status = new StatusLine();
  helm.approver = cliApprover(prompter, { yes: opts.yes, onBeforePrompt: () => status.clear() });
  const session = new Session(helm, { model: opts.model, provider: opts.provider });
  const events: SessionEvent[] = [];
  const print = eventPrinter(status, { verbose: opts.verbose });
  const text = await session.send(prompt, (e) => { events.push(e); if (!opts.json) print(e); });
  await session.end();
  prompter.close();
  const failed = events.find((e) => e.type === 'error');
  if (opts.json) process.stdout.write(JSON.stringify({ session: session.id, text, events: events.filter((e) => e.type !== 'status') }, null, 2) + '\n');
  return failed ? 1 : 0;
}
