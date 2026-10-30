import { definePlugin, PluginError, ui } from '@helm-agent/plugin-sdk';
import type { CallContext } from '@helm-agent/plugin-sdk';

interface Cfg { authorName: string; authorEmail: string; coAuthor: string; maxDiffChars: number }
const cfg = (ctx: CallContext) => ctx.config as Cfg;

// Every invocation goes through host/process.exec: the plugin itself cannot spawn programs.
// Flags make git deterministic and non-interactive regardless of user config.
const BASE = ['-c', 'core.pager=cat', '-c', 'color.ui=never', '-c', 'core.quotepath=off', '--no-optional-locks'];

async function git(ctx: CallContext, args: string[], opts: { allowFail?: boolean } = {}) {
  const c = cfg(ctx);
  const r = await ctx.process.exec('git', [...BASE, ...args], {
    timeoutMs: 30_000,
    env: {
      GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0',
      GIT_AUTHOR_NAME: c.authorName, GIT_AUTHOR_EMAIL: c.authorEmail, GIT_COMMITTER_NAME: c.authorName, GIT_COMMITTER_EMAIL: c.authorEmail,
    },
  });
  if (r.timedOut) throw new PluginError(`git ${args[0]} timed out`, 'CALL_TIMEOUT');
  if (r.code !== 0 && !opts.allowFail) {
    const msg = r.stderr.trim() || r.stdout.trim() || `exit code ${r.code}`;
    if (/not a git repository/i.test(msg)) throw new PluginError(`The workspace is not a git repository (${ctx.workspace})`, 'TOOL_ERROR', 'Run `git init` there, or start Helm in a repository.');
    throw new PluginError(`git ${args.filter((a) => !a.startsWith('-c') && !a.includes('=')).slice(0, 2).join(' ')} failed: ${msg.slice(0, 800)}`, 'TOOL_ERROR');
  }
  return r;
}

const cap = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}\n…[diff truncated: ${s.length - n} more chars]` : s);

function safePath(p: string) {
  if (p.startsWith('-')) throw new PluginError(`Invalid path "${p}"`, 'INPUT_INVALID');
  return p;
}

async function status(ctx: CallContext) {
  const r = await git(ctx, ['status', '--porcelain=v2', '--branch', '--untracked-files=normal']);
  const info = { branch: '(detached)', upstream: '', ahead: 0, behind: 0 };
  const files: Array<{ status: string; path: string }> = [];
  for (const line of r.stdout.split('\n')) {
    if (line.startsWith('# branch.head ')) info.branch = line.slice(14);
    else if (line.startsWith('# branch.upstream ')) info.upstream = line.slice(18);
    else if (line.startsWith('# branch.ab ')) { const [a, b] = line.slice(12).split(' '); info.ahead = Number(a); info.behind = -Number(b); }
    else if (line.startsWith('1 ') || line.startsWith('2 ')) { const parts = line.split(' '); files.push({ status: describeXY(parts[1]!), path: parts.slice(8).join(' ').split('\t')[0]! }); }
    else if (line.startsWith('? ')) files.push({ status: 'untracked', path: line.slice(2) });
    else if (line.startsWith('u ')) files.push({ status: 'conflict', path: line.split(' ').slice(10).join(' ') });
  }
  return { ...info, files };
}

function describeXY(xy: string) {
  const m: Record<string, string> = { M: 'modified', A: 'added', D: 'deleted', R: 'renamed', C: 'copied', T: 'type changed' };
  const staged = xy[0] !== '.' ? `staged ${m[xy[0]!] ?? xy[0]}` : '';
  const unstaged = xy[1] !== '.' ? `${m[xy[1]!] ?? xy[1]}` : '';
  return [staged, unstaged].filter(Boolean).join(', ');
}

async function log(ctx: CallContext, limit: number, path?: string) {
  const r = await git(ctx, ['log', `-n${limit}`, '--date=short', '--pretty=format:%h\x1f%an\x1f%ad\x1f%s', ...(path ? ['--', safePath(path)] : [])], { allowFail: true });
  if (r.code !== 0) return [];
  return r.stdout.split('\n').filter(Boolean).map((l) => l.split('\x1f') as [string, string, string, string]);
}

export default definePlugin({
  tools: {
    async git_status(_input, ctx) {
      const s = await status(ctx);
      const head = `On branch ${s.branch}${s.upstream ? ` (tracking ${s.upstream}, ahead ${s.ahead}, behind ${s.behind})` : ''}`;
      return s.files.length ? `${head}\n${s.files.map((f) => `  ${f.status.padEnd(24)} ${f.path}`).join('\n')}` : `${head}\nWorking tree clean.`;
    },
    async git_diff({ staged = false, path }: { staged?: boolean; path?: string }, ctx) {
      const r = await git(ctx, ['diff', '--no-ext-diff', ...(staged ? ['--cached'] : []), '--stat', '--patch', ...(path ? ['--', safePath(path)] : [])]);
      return r.stdout.trim() ? cap(r.stdout, cfg(ctx).maxDiffChars) : `No ${staged ? 'staged' : 'unstaged'} changes${path ? ` in ${path}` : ''}.`;
    },
    async git_log({ limit = 10, path }: { limit?: number; path?: string }, ctx) {
      const rows = await log(ctx, limit, path);
      return rows.length ? rows.map(([h, a, d, s]) => `${h}  ${d}  ${a.padEnd(16).slice(0, 16)}  ${s}`).join('\n') : 'No commits yet.';
    },
    async git_show({ rev = 'HEAD' }: { rev?: string }, ctx) {
      if (!/^[\w./~^@{}-]{1,100}$/.test(rev) || rev.startsWith('-')) throw new PluginError(`Invalid revision "${rev}"`, 'INPUT_INVALID');
      const r = await git(ctx, ['show', '--no-ext-diff', '--stat', '--patch', rev]);
      return cap(r.stdout, cfg(ctx).maxDiffChars);
    },
    async git_commit({ message, paths = [], all = false }: { message: string; paths?: string[]; all?: boolean }, ctx) {
      if (!all && !paths.length) throw new PluginError('Pass the paths to commit, or all=true to commit every change', 'INPUT_INVALID');
      await git(ctx, ['add', ...(all ? ['-A'] : ['--', ...paths.map(safePath)])]);
      const staged = await git(ctx, ['diff', '--cached', '--name-only']);
      if (!staged.stdout.trim()) return 'Nothing to commit: no changes in the given paths.';
      const c = cfg(ctx);
      const full = c.coAuthor ? `${message.trim()}\n\nCo-authored-by: ${c.coAuthor}` : message.trim();
      await git(ctx, ['commit', '--no-verify', '-q', '-m', full]);
      const [h] = await log(ctx, 1);
      ctx.ui.refresh('repo');
      return `Committed ${staged.stdout.trim().split('\n').length} file(s) as ${h?.[0]}: ${message.split('\n')[0]}`;
    },
  },
  commands: {
    async summary(_args, ctx) {
      const s = await status(ctx);
      const commits = await log(ctx, 5);
      return ui.stack(ui.heading(`Branch ${s.branch}`), ui.keyValue({ changed: s.files.length, ahead: s.ahead, behind: s.behind, upstream: s.upstream || '(none)' }), ui.table(['commit', 'date', 'subject'], commits.map(([h, , d, sub]) => [h, d, sub])));
    },
  },
  panels: {
    async repo(ctx) {
      try {
        const s = await status(ctx);
        const commits = await log(ctx, 8);
        return ui.stack(
          ui.keyValue({ branch: s.branch, upstream: s.upstream || '(none)', 'ahead / behind': `${s.ahead} / ${s.behind}` }),
          s.files.length ? ui.table(['status', 'file'], s.files.slice(0, 50).map((f) => [f.status, f.path])) : ui.badge('clean', 'success'),
          ui.heading('Recent commits'),
          commits.length ? ui.table(['commit', 'date', 'author', 'subject'], commits.map(([h, a, d, sub]) => [h, d, a, sub])) : ui.text('No commits yet.', 'muted'),
        );
      } catch (e) {
        return ui.text((e as Error).message, 'warning');
      }
    },
  },
});
