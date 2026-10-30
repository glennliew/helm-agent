import { styleText } from 'node:util';
import type { UINode } from '../../core/src/types.ts';
import { toHelmError, explain } from '../../core/src/errors.ts';

const useColor = () => !process.env.NO_COLOR && (process.stdout.isTTY || process.env.FORCE_COLOR === '1');
type Fmt = Parameters<typeof styleText>[0];
const paint = (fmt: Fmt) => (s: string | number) => (useColor() ? styleText(fmt, String(s)) : String(s));

export const c = {
  bold: paint('bold'),
  dim: paint('dim'),
  red: paint('red'),
  green: paint('green'),
  yellow: paint('yellow'),
  blue: paint('blue'),
  cyan: paint('cyan'),
  magenta: paint('magenta'),
  gray: paint('gray'),
};

export const sym = { ok: '✓', fail: '✖', warn: '!', dot: '•', arrow: '→', gear: '⚙' };

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
const width = (s: string) => [...stripAnsi(s)].length;

export function table(headers: string[], rows: Array<Array<string | number | undefined>>, opts: { maxCol?: number } = {}): string {
  const max = opts.maxCol ?? 60;
  const cells = rows.map((r) => r.map((v) => {
    const s = String(v ?? '');
    return width(s) > max ? stripAnsi(s).slice(0, max - 1) + '…' : s;
  }));
  const w = headers.map((h, i) => Math.max(width(h), ...cells.map((r) => width(r[i] ?? ''))));
  const line = (r: string[]) => r.map((v, i) => v + ' '.repeat(Math.max(0, w[i]! - width(v)))).join('  ').trimEnd();
  return [c.dim(line(headers)), ...cells.map(line)].join('\n');
}

export function toneColor(tone?: string) {
  return tone === 'danger' ? c.red : tone === 'warning' ? c.yellow : tone === 'success' ? c.green : tone === 'muted' ? c.dim : (s: string) => s;
}

export function riskBadge(risk: string) {
  return risk === 'high' ? c.red('high') : risk === 'medium' ? c.yellow('medium') : c.green('low');
}

export function stateBadge(state: string) {
  const map: Record<string, (s: string) => string> = {
    active: c.green, ready: c.green, enabled: c.green, stopped: c.dim, starting: c.yellow,
    crashed: c.red, quarantined: c.red, disabled: c.gray, unavailable: c.yellow,
  };
  return (map[state] ?? ((s: string) => s))(state);
}

/** Render a plugin's declarative UI tree as terminal text. */
export function renderUI(node: UINode, indent = ''): string {
  switch (node.type) {
    case 'stack': return node.children.map((ch) => renderUI(ch, indent)).filter(Boolean).join('\n');
    case 'heading': return indent + c.bold(node.text);
    case 'text': return indent + toneColor(node.tone)(node.text);
    case 'markdown': return node.text.split('\n').map((l) => indent + l).join('\n');
    case 'keyValue': {
      const kw = Math.max(0, ...node.items.map((i) => width(i.key)));
      return node.items.map((i) => `${indent}${c.dim(i.key.padEnd(kw))}  ${i.value}`).join('\n');
    }
    case 'table': return table(node.columns, node.rows).split('\n').map((l) => indent + l).join('\n');
    case 'list': return node.items.map((i) => `${indent}${sym.dot} ${i}`).join('\n');
    case 'badge': return indent + toneColor(node.tone)(`[${node.text}]`);
    case 'button': return indent + c.cyan(`[${node.label}]`) + c.dim(`  (run: ${node.command})`);
  }
}

export function printError(e: unknown, opts: { pluginId?: string; json?: boolean } = {}) {
  const err = toHelmError(e);
  if (opts.json) {
    process.stdout.write(JSON.stringify({ error: err.toJSON() }, null, 2) + '\n');
    return;
  }
  const info = explain(err.code);
  const hint = (err.hint ?? info.hint).replaceAll('<id>', opts.pluginId ?? '<id>');
  process.stderr.write(`${c.red(`${sym.fail} ${info.title}`)} ${c.dim(`[${err.code}]`)}\n`);
  if (err.message && err.message !== info.title) process.stderr.write(`  ${err.message.split('\n').join('\n  ')}\n`);
  const details = err.details as { stderrTail?: string[] } | undefined;
  if (details?.stderrTail?.length) {
    process.stderr.write(c.dim('  last plugin output:\n') + details.stderrTail.slice(-8).map((l) => c.dim(`    | ${l}`)).join('\n') + '\n');
  }
  if (hint) process.stderr.write(`  ${c.cyan(sym.arrow)} ${hint}\n`);
}

/** Replaceable so embedders and tests can capture CLI output without touching process.stdout. */
export const output = { write: (s: string): void => { process.stdout.write(s); } };
export function out(s = '') {
  output.write(s + '\n');
}

export function json(v: unknown) {
  process.stdout.write(JSON.stringify(v, null, 2) + '\n');
}

export function ago(iso?: string | number) {
  if (!iso) return '';
  const ms = Date.now() - (typeof iso === 'number' ? iso : Date.parse(iso));
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  return `${Math.round(ms / 86_400_000)}d ago`;
}
