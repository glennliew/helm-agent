import { definePlugin, PluginError, ui } from '@helm-agent/plugin-sdk';
import type { CallContext } from '@helm-agent/plugin-sdk';

interface Cfg { ignore: string[]; maxFiles: number; maxFileKb: number }
const cfg = (ctx: CallContext) => ctx.config as Cfg;
const join = (a: string, b: string) => (a === '.' || a === '' ? b : `${a.replace(/\/$/, '')}/${b}`);
const human = (n: number) => (n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`);

/** Walk the tree through the host broker (every list/read is permission-checked and audited). */
async function* walk(ctx: CallContext, root: string, maxDepth = 32): AsyncGenerator<{ path: string; size: number }> {
  const ignore = new Set(cfg(ctx).ignore);
  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  let visited = 0;
  while (stack.length) {
    const { dir, depth } = stack.pop()!;
    if (ctx.signal.aborted) return;
    const { entries } = await ctx.fs.list(dir);
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (ignore.has(e.name)) continue;
      const p = join(dir, e.name);
      if (e.type === 'dir' && depth < maxDepth) stack.push({ dir: p, depth: depth + 1 });
      else if (e.type === 'file') {
        if (++visited > cfg(ctx).maxFiles) return;
        yield { path: p, size: e.size };
      }
    }
  }
}

async function listTree(ctx: CallContext, path: string, depth: number, indent = ''): Promise<string[]> {
  const ignore = new Set(cfg(ctx).ignore);
  const { entries, truncated } = await ctx.fs.list(path);
  const lines: string[] = [];
  const sorted = entries.filter((e) => !ignore.has(e.name)).sort((a, b) => Number(b.type === 'dir') - Number(a.type === 'dir') || a.name.localeCompare(b.name));
  for (const e of sorted.slice(0, 400)) {
    lines.push(`${indent}${e.name}${e.type === 'dir' ? '/' : `  (${human(e.size)})`}`);
    if (e.type === 'dir' && depth > 1) lines.push(...(await listTree(ctx, join(path, e.name), depth - 1, indent + '  ')));
  }
  if (sorted.length > 400 || truncated) lines.push(`${indent}… ${sorted.length - 400} more`);
  return lines;
}

export default definePlugin({
  tools: {
    async list_dir({ path = '.', depth = 1 }: { path?: string; depth?: number }, ctx) {
      const lines = await listTree(ctx, path, depth);
      return lines.length ? `${path}:\n${lines.join('\n')}` : `${path} is empty`;
    },

    async read_file({ path, startLine, endLine }: { path: string; startLine?: number; endLine?: number }, ctx) {
      const max = cfg(ctx).maxFileKb * 1024;
      const r = await ctx.fs.read(path, { maxBytes: max });
      if (r.content.includes('\u0000')) throw new PluginError(`${path} looks like a binary file`, 'TOOL_ERROR');
      const all = r.content.split('\n');
      const from = Math.max(1, startLine ?? 1);
      const to = Math.min(all.length, endLine ?? Math.min(all.length, from + 1999));
      const body = all.slice(from - 1, to).map((l, i) => `${String(from + i).padStart(5)}  ${l}`).join('\n');
      const notes = [to < all.length ? `[lines ${from}-${to} of ${all.length}; pass startLine/endLine for more]` : '', r.truncated ? `[file truncated at ${cfg(ctx).maxFileKb} KB of ${human(r.size)}]` : ''].filter(Boolean);
      return `${path}\n${body}${notes.length ? '\n' + notes.join('\n') : ''}`;
    },

    async search_text({ query, path = '.', regex = false, caseSensitive = false, maxResults = 80 }: { query: string; path?: string; regex?: boolean; caseSensitive?: boolean; maxResults?: number }, ctx) {
      let re: RegExp;
      try { re = new RegExp(regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), caseSensitive ? '' : 'i'); } catch (e) {
        throw new PluginError(`Invalid regular expression: ${(e as Error).message}`, 'INPUT_INVALID');
      }
      const maxBytes = cfg(ctx).maxFileKb * 1024;
      const hits: string[] = [];
      let files = 0;
      for await (const f of walk(ctx, path)) {
        if (f.size > maxBytes) continue;
        files++;
        if (files % 200 === 0) ctx.progress(`searched ${files} files`);
        const { content } = await ctx.fs.read(f.path, { maxBytes });
        if (content.includes('\u0000')) continue;
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (re.test(lines[i]!)) {
            hits.push(`${f.path}:${i + 1}: ${lines[i]!.trim().slice(0, 200)}`);
            if (hits.length >= maxResults) return `${hits.join('\n')}\n[stopped at ${maxResults} matches]`;
          }
        }
      }
      return hits.length ? hits.join('\n') : `No matches for "${query}" in ${files} files.`;
    },

    async write_file({ path, content }: { path: string; content: string }, ctx) {
      const r = await ctx.fs.write(path, content, { createDirs: true });
      return `Wrote ${human(r.bytes)} to ${path}`;
    },

    async edit_file({ path, find, replace, all = false }: { path: string; find: string; replace: string; all?: boolean }, ctx) {
      const original = await ctx.fs.readText(path);
      const count = original.split(find).length - 1;
      if (count === 0) throw new PluginError(`The text to find does not occur in ${path}`, 'TOOL_ERROR');
      if (count > 1 && !all) throw new PluginError(`The text occurs ${count} times in ${path}; add more context or pass all=true`, 'TOOL_ERROR');
      const updated = all ? original.split(find).join(replace) : original.replace(find, () => replace);
      await ctx.fs.write(path, updated);
      return `Edited ${path}: replaced ${all ? count : 1} occurrence(s)`;
    },
  },

  commands: {
    async stats({ path = '.' }: { path?: string }, ctx) {
      const byExt = new Map<string, { files: number; bytes: number }>();
      let total = 0;
      for await (const f of walk(ctx, path)) {
        const ext = /\.([a-z0-9]+)$/i.exec(f.path)?.[1]?.toLowerCase() ?? '(none)';
        const cur = byExt.get(ext) ?? { files: 0, bytes: 0 };
        cur.files++;
        cur.bytes += f.size;
        byExt.set(ext, cur);
        total++;
      }
      const rows = [...byExt.entries()].sort((a, b) => b[1].files - a[1].files).slice(0, 20).map(([ext, v]) => [ext, v.files, human(v.bytes)]);
      return ui.stack(ui.heading(`Files in ${path === '.' ? 'workspace' : path}`), ui.keyValue({ files: total, workspace: ctx.workspace }), ui.table(['extension', 'files', 'size'], rows));
    },
  },
});
