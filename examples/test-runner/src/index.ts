import { definePlugin, ui } from '@helm-agent/plugin-sdk';
import type { PluginContext } from '@helm-agent/plugin-sdk';

// Everything here is declared in helm-plugin.json: the run_tests tool, the "run" command and
// the "tests" panel. The plugin never touches the disk or spawns processes itself: it asks the
// host to run python3 through ctx.process.exec, which only works while the user's
// process.exec grant includes "python3".

export interface TestCase { name: string; where: string; status: string }
export interface TestRun {
  at: string;
  ok: boolean;
  ran: number;
  failed: number;
  errors: number;
  skipped: number;
  seconds: number;
  cases: TestCase[];
  details: string;
  pattern?: string;
  timedOut: boolean;
  exitCode: number | null;
}

const MAX_DETAILS = 6000;

/** Parse `python3 -m unittest -v` output (3.10 and 3.11+ formats). */
export function parseUnittest(output: string): Omit<TestRun, 'at' | 'pattern' | 'timedOut' | 'exitCode'> {
  const lines = output.split('\n');
  const cases: TestCase[] = [];
  for (let i = 0; i < lines.length; i++) {
    // "test_zero (tests.test_units.UnitsTest) ... ok"            (3.10)
    // "test_zero (tests.test_units.UnitsTest.test_zero) ... ok"  (3.11+)
    // A docstring moves " ... ok" onto the following line.
    const m = /^(test\w*) \(([\w.]+)\)(.*)$/.exec(lines[i]!);
    if (!m) continue;
    let rest = m[3]!;
    if (!rest.includes(' ... ') && i + 1 < lines.length && lines[i + 1]!.includes(' ... ')) rest = lines[++i]!;
    const status = /\.\.\. (.+)$/.exec(rest)?.[1]?.trim();
    if (!status) continue;
    const where = m[2]!.endsWith(`.${m[1]}`) ? m[2]!.slice(0, -(m[1]!.length + 1)) : m[2]!;
    cases.push({ name: m[1]!, where, status: status.startsWith('skipped') ? 'skipped' : status });
  }
  const ran = Number(/^Ran (\d+) tests? in/m.exec(output)?.[1] ?? cases.length);
  const seconds = Number(/^Ran \d+ tests? in ([\d.]+)s/m.exec(output)?.[1] ?? 0);
  const verdict = /^(OK|FAILED)(?: \((.*)\))?\s*$/m.exec(output);
  const count = (k: string) => Number(new RegExp(`${k}=(\\d+)`).exec(verdict?.[2] ?? '')?.[1] ?? 0);
  const start = output.search(/^={20,}$/m);
  const end = output.search(/^-{20,}\nRan /m);
  let details = start >= 0 ? output.slice(start, end > start ? end : undefined).trim() : '';
  if (details.length > MAX_DETAILS) details = details.slice(0, MAX_DETAILS) + '\n… (truncated)';
  return { ok: verdict?.[1] === 'OK', ran, failed: count('failures'), errors: count('errors'), skipped: count('skipped'), seconds, cases, details };
}

async function runTests(ctx: PluginContext, pattern?: string): Promise<TestRun> {
  const cfg = ctx.config as { startDir: string; timeoutSeconds: number };
  const args = ['-m', 'unittest', 'discover', '-s', cfg.startDir, '-t', '.', '-v'];
  if (pattern) args.push('-k', pattern);
  const r = await ctx.process.exec('python3', args, { timeoutMs: cfg.timeoutSeconds * 1000, env: { PYTHONDONTWRITEBYTECODE: '1' } });
  const output = `${r.stderr}\n${r.stdout}`;
  const parsed = parseUnittest(output);
  // No "Ran N tests" line usually means the suite could not even be imported.
  if (!/^Ran \d+ tests? in/m.test(output)) parsed.details = output.trim().slice(-MAX_DETAILS);
  const run: TestRun = { ...parsed, ok: parsed.ok && r.code === 0 && !r.timedOut, at: new Date().toISOString(), pattern, timedOut: r.timedOut, exitCode: r.code };
  await ctx.storage.set('lastRun', run);
  ctx.log.info(`ran ${run.ran} tests: ${run.ok ? 'OK' : 'FAILED'}${r.sandboxed ? ' (sandboxed)' : ''}`);
  return run;
}

export function summarize(run: TestRun): string {
  if (run.timedOut) return `The test run was stopped after the time limit. Partial output:\n${run.details}`;
  const bad = run.failed + run.errors;
  const head = `python3 -m unittest${run.pattern ? ` -k ${run.pattern}` : ''}: ${run.ran - bad - run.skipped} passed, ${bad} failed${run.skipped ? `, ${run.skipped} skipped` : ''} (${run.ran} tests, ${run.seconds}s)`;
  if (run.ran === 0 && !run.cases.length) return `${head}\nNo tests ran. Output:\n${run.details || '(none)'}`;
  const list = run.cases.map((c) => `${c.status === 'ok' ? '✓' : c.status === 'skipped' ? '-' : '✗'} ${c.where}.${c.name}${c.status === 'ok' ? '' : ` (${c.status})`}`).join('\n');
  return [head, list, run.ok ? '' : `\nFailure details:\n${run.details}`].filter(Boolean).join('\n');
}

function view(run: TestRun | null) {
  if (!run) return ui.stack(ui.text('No test run yet. Ask the agent to run the tests, or run them here.', 'muted'), ui.button('Run tests', 'run'));
  const bad = run.cases.filter((c) => c.status !== 'ok' && c.status !== 'skipped');
  return ui.stack(
    ui.badge(run.timedOut ? 'timed out' : run.ok ? 'passing' : 'failing', run.ok ? 'success' : 'danger'),
    ui.keyValue({ tests: run.ran, failed: run.failed + run.errors, took: `${run.seconds}s`, when: new Date(run.at).toLocaleTimeString() }),
    bad.length ? ui.table(['failing test', 'result'], bad.map((c) => [`${c.where.split('.').pop()}.${c.name}`, c.status])) : ui.text(run.ok ? 'All tests pass.' : 'See the run output for details.', run.ok ? 'success' : 'warning'),
    ui.button('Run again', 'run'),
  );
}

export default definePlugin({
  tools: {
    async run_tests({ pattern }: { pattern?: string }, ctx) {
      ctx.progress('running python3 -m unittest');
      return summarize(await runTests(ctx, pattern));
    },
  },
  commands: {
    async run(_args, ctx) {
      return view(await runTests(ctx));
    },
  },
  panels: {
    async tests(ctx) {
      return view(await ctx.storage.get<TestRun>('lastRun'));
    },
  },
});
