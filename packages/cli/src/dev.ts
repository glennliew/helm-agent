import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import readline from 'node:readline/promises';
import { spawnSync } from 'node:child_process';
import type { Helm } from '../../core/src/helm.ts';
import { readManifest, formatProblems, compatibilityProblem } from '../../core/src/manifest/manifest.ts';
import { expectedIsolation, pythonRuntime } from '../../core/src/runtime/launch.ts';
import { TEMPLATES_DIR, SDK_NODE_DIR, REPO_ROOT, sha256File } from '../../core/src/paths.ts';
import { HelmError, ErrorCode } from '../../core/src/errors.ts';
import { permissionDef } from '../../core/src/permissions/catalog.ts';
import { c, out, json, printError, renderUI, sym, table } from './ui.ts';
import { Prompter, collectConsent, printConsent } from './prompt.ts';

// ------------------------------------------------------------------ new
export function newPlugin(name: string, opts: { lang?: string; dir?: string; id?: string }) {
  const lang = opts.lang === 'python' || opts.lang === 'py' ? 'python' : 'typescript';
  const slug = name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!slug) throw new HelmError(ErrorCode.INPUT_INVALID, 'Give the plugin a name, e.g. `helm plugin new word-tools`');
  const id = opts.id ?? `local.${slug}`;
  const dest = path.resolve(opts.dir ?? slug);
  if (fs.existsSync(dest) && fs.readdirSync(dest).length) throw new HelmError(ErrorCode.INPUT_INVALID, `${dest} already exists and is not empty`);
  const title = slug.split('-').map((w) => w[0]!.toUpperCase() + w.slice(1)).join(' ');
  const vars: Record<string, string> = { id, title, packageName: slug, sdkDir: SDK_NODE_DIR, schemaUrl: pathToFileURL(path.join(REPO_ROOT, 'docs/schemas/plugin-manifest-v1.json')).href };
  const src = path.join(TEMPLATES_DIR, lang);
  const copy = (from: string, to: string) => {
    for (const e of fs.readdirSync(from, { withFileTypes: true })) {
      const a = path.join(from, e.name);
      const b = path.join(to, e.name);
      if (e.isDirectory()) { fs.mkdirSync(b, { recursive: true }); copy(a, b); }
      else fs.writeFileSync(b, fs.readFileSync(a, 'utf8').replace(/\{\{(\w+)\}\}/g, (m, k) => vars[k] ?? m));
    }
  };
  fs.mkdirSync(dest, { recursive: true });
  copy(src, dest);
  out(`${c.green(sym.ok)} Created ${c.bold(id)} (${lang}) in ${dest}`);
  out();
  out(`  ${c.dim('next:')}`);
  out(`  cd ${path.relative(process.cwd(), dest) || '.'}`);
  out(`  helm plugin dev .      ${c.dim('# link + hot reload + interactive console')}`);
  out(`  helm plugin test .     ${c.dim('# unit tests with the fake host')}`);
  return dest;
}

// ------------------------------------------------------------------ validate
export function validatePlugin(dir: string, opts: { json?: boolean } = {}) {
  const abs = path.resolve(dir);
  const { manifest, problems } = readManifest(abs);
  const compat = manifest ? compatibilityProblem(manifest) : undefined;
  const iso = manifest ? expectedIsolation(manifest) : undefined;
  const errors = problems.filter((p) => p.severity === 'error');
  if (opts.json) {
    json({ ok: !!manifest && !errors.length && !compat, id: manifest?.id, version: manifest?.version, problems, compatibility: compat ?? 'ok', isolation: iso });
    return !!manifest && !compat;
  }
  if (!manifest) {
    out(`${c.red(sym.fail)} ${abs} is not a valid Helm plugin:\n${formatProblems(problems)}`);
    return false;
  }
  out(`${c.green(sym.ok)} ${c.bold(manifest.id)}@${manifest.version} manifest is valid`);
  if (problems.length) out(formatProblems(problems));
  out(compat ? `${c.red(sym.fail)} ${compat}` : `${c.green(sym.ok)} compatible with this Helm (${manifest.engines.helm}, protocol ${manifest.engines.protocol})`);
  if (manifest.runtime.type === 'python' && !pythonRuntime()) out(`${c.red(sym.fail)} python3 (3.9+) not found on this machine`);
  out(iso!.level === 'strict' ? `${c.green(sym.ok)} runs with strict isolation here` : `${c.yellow(sym.warn)} isolation here: ${iso!.level} (${iso!.reason})`);
  const perms = manifest.permissions ?? [];
  out(perms.length ? `  permissions: ${perms.map((p) => `${p.id}${p.optional ? '?' : ''}${p.scope ? `(${p.scope.join(', ')})` : ''}`).join(' · ')}` : '  permissions: none');
  const contrib = manifest.contributes ?? {};
  out(`  contributes: ${(['tools', 'commands', 'hooks', 'panels', 'providers'] as const).map((k) => `${(contrib[k] ?? []).length} ${k}`).join(', ')}${contrib.configuration ? ', configuration' : ''}`);
  return !compat;
}

// ------------------------------------------------------------------ pack
export async function packPlugin(dir: string, opts: { out?: string } = {}) {
  const abs = path.resolve(dir);
  const { manifest, problems } = readManifest(abs);
  if (!manifest) throw new HelmError(ErrorCode.MANIFEST_INVALID, `Cannot pack an invalid plugin:\n${formatProblems(problems)}`);
  const file = path.resolve(opts.out ?? `${manifest.id}-${manifest.version}.hplugin.tgz`);
  const r = spawnSync('/usr/bin/tar', ['-czf', file, '--exclude', 'node_modules', '--exclude', '.git', '--exclude', '__pycache__', '--exclude', '*.hplugin.tgz', '--exclude', '.DS_Store', '-C', abs, '.'], { encoding: 'utf8', env: { ...process.env, COPYFILE_DISABLE: '1' } });
  if (r.status !== 0) throw new HelmError(ErrorCode.INSTALL_FAILED, `tar failed: ${r.stderr}`);
  const sha = await sha256File(file);
  out(`${c.green(sym.ok)} Packed ${manifest.id}@${manifest.version} → ${file}`);
  out(c.dim(`  sha256 ${sha} · ${(fs.statSync(file).size / 1024).toFixed(1)} KB`));
  out(c.dim(`  install with: helm plugin install ${path.relative(process.cwd(), file)}`));
  return { file, sha256: sha };
}

// ------------------------------------------------------------------ test
export function testPlugin(dir: string, opts: { stdio?: 'inherit' | 'pipe' } = {}) {
  const stdio = opts.stdio ?? 'inherit';
  const abs = path.resolve(dir);
  const { manifest } = readManifest(abs);
  if (manifest?.runtime.type === 'python') {
    const py = pythonRuntime();
    if (!py) throw new HelmError(ErrorCode.INSTALL_FAILED, 'python3 not found');
    const sdk = path.join(SDK_NODE_DIR, '../../sdk-python');
    return spawnSync(py.exe, ['-m', 'unittest', 'discover', '-s', abs, '-p', 'test_*.py'], { stdio, cwd: abs, env: { ...process.env, PYTHONPATH: sdk } }).status ?? 1;
  }
  const testDir = path.join(abs, 'test');
  const files = fs.existsSync(testDir) ? fs.readdirSync(testDir).filter((f) => /\.test\.(ts|js|mjs)$/.test(f)).map((f) => path.join(testDir, f)) : [];
  if (!files.length) { out(c.yellow(`${sym.warn} no test/*.test.ts files in ${abs}`)); return 0; }
  return spawnSync(process.execPath, ['--import', path.join(SDK_NODE_DIR, 'register.ts'), '--test', ...files], { stdio, cwd: abs }).status ?? 1;
}

// ------------------------------------------------------------------ dev
function parseInput(rest: string): Record<string, unknown> {
  const t = rest.trim();
  if (!t) return {};
  if (t.startsWith('{')) return JSON.parse(t);
  const args: Record<string, unknown> = {};
  for (const kv of t.match(/(\w+)=("[^"]*"|\S+)/g) ?? []) {
    const i = kv.indexOf('=');
    let v: unknown = kv.slice(i + 1);
    if (typeof v === 'string' && v.startsWith('"')) v = v.slice(1, -1);
    else if (/^-?\d+(\.\d+)?$/.test(v as string)) v = Number(v);
    else if (v === 'true' || v === 'false') v = v === 'true';
    args[kv.slice(0, i)] = v;
  }
  return args;
}

const DEV_HELP = `
  ${c.bold('dev console')}
  tools                       list this plugin's tools and their availability
  call <tool> [json|k=v ...]  invoke a tool through the real host (sandbox, broker, limits)
  cmd <command> [k=v ...]     run a command        panel <id>   render a panel
  hook <event> [json]         send a hook event    grants       show granted permissions
  logs [n]                    plugin log tail      trace on|off show every protocol message
  reload                      restart the plugin   quit         stop (the link stays installed)
`;

export async function devPlugin(helm: Helm, dir: string, opts: { yes?: boolean; trace?: boolean }) {
  const abs = path.resolve(dir);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const prompter = new Prompter(rl);
  let id: string | undefined;

  const ensureLinked = async (): Promise<boolean> => {
    const { manifest, problems } = readManifest(abs);
    if (!manifest) { out(`${c.red(sym.fail)} manifest invalid:\n${formatProblems(problems)}\n${c.dim('  waiting for changes…')}`); return false; }
    if (problems.length) out(formatProblems(problems));
    id = manifest.id;
    const rec = helm.state.get(manifest.id);
    if (rec && rec.source.type !== 'link') throw new HelmError(ErrorCode.INSTALL_FAILED, `${manifest.id} is already installed from ${rec.source.type}:${rec.source.location}`, { hint: `Uninstall it first (helm plugin uninstall ${manifest.id}) or change the id in helm-plugin.json.` });
    if (rec && path.resolve(rec.dir) !== abs) throw new HelmError(ErrorCode.INSTALL_FAILED, `${manifest.id} is linked from another folder (${rec.dir})`, { hint: `helm plugin uninstall ${manifest.id}` });
    if (!rec) {
      const plan = await helm.prepareInstall(abs, { link: true });
      printConsent(plan.manifest, plan.consent);
      const decisions = await collectConsent(plan.consent, { yes: opts.yes, prompter });
      const { notes } = await helm.commitInstall(plan, decisions);
      notes.forEach((n) => out(c.yellow(`  ${sym.warn} ${n}`)));
      out(`${c.green(sym.ok)} linked ${manifest.id} → ${abs}`);
    } else {
      const plan = await helm.prepareUpdate(manifest.id);
      if (plan.diff.length) {
        printConsent(plan.manifest, plan.diff, '  The manifest now asks for more:');
        const decisions = await collectConsent(plan.diff, { yes: opts.yes, prompter });
        const { notes } = await helm.commitUpdate(plan, decisions);
        notes.forEach((n) => out(c.yellow(`  ${sym.warn} ${n}`)));
      } else if (plan.manifest.version !== rec.version) {
        await helm.commitUpdate(plan, []);
      } else plan.cleanup();
      if (!helm.state.require(manifest.id).enabled) {
        try { await helm.enable(manifest.id); } catch (e) { printError(e, { pluginId: manifest.id }); }
      }
    }
    return true;
  };

  const start = async (label: string) => {
    if (!id) return;
    const t0 = Date.now();
    await helm.stopPlugin(id, 'reloading');
    if (helm.state.get(id)?.health.quarantinedAt) await helm.reset(id);
    try {
      const avail = helm.availability(id);
      if (!avail.available) { out(`${c.yellow(sym.warn)} ${id} is not runnable: ${avail.reason}`); return; }
      const proc = helm.process(id);
      await proc.ensureStarted();
      const d = proc.describe();
      out(`${c.green(sym.ok)} ${label} ${c.bold(id)} in ${Date.now() - t0} ms ${c.dim(`· pid ${d.pid} · ${d.isolation} isolation (${d.layers.join(', ')})`)}`);
      for (const w of d.warnings) out(c.yellow(`  ${sym.warn} ${w}`));
    } catch (e) {
      printError(e, { pluginId: id });
    }
  };

  helm.onStderr = (pid, line) => { if (pid === id) out(c.yellow(`  ${c.dim('stderr |')} ${line}`)); };
  helm.bus.onEvent('plugin.log', (l) => { if (l.plugin === id && !l.message.startsWith('[helm]')) out(c.dim(`  log:${l.level} | ${l.message}`)); });
  helm.bus.onEvent('plugin.notify', (n) => { if (n.plugin === id) out(c.cyan(`  notify | ${n.message}`)); });
  helm.bus.onEvent('plugin.state', (s) => { if (s.plugin === id && ['crashed', 'quarantined'].includes(s.to)) out(c.red(`  ${sym.fail} ${s.to}: ${s.reason ?? ''}`)); });
  const tracer = (pid: string, dir2: 'in' | 'out', msg: unknown) => { if (pid === id) out(c.magenta(`  ${dir2 === 'out' ? 'host→plugin' : 'plugin→host'} ${JSON.stringify(msg).slice(0, 300)}`)); };
  if (opts.trace) helm.trace = tracer;

  out(`${c.bold('helm plugin dev')} ${c.dim(abs)}`);
  if (await ensureLinked()) await start('started');
  out(c.dim('  watching for changes · type help'));

  let timer: NodeJS.Timeout | undefined;
  const watcher = fs.watch(abs, { recursive: true }, (_ev, file) => {
    if (!file || /(^|\/)(node_modules|\.git|__pycache__)(\/|$)|\.hplugin\.tgz$/.test(String(file))) return;
    clearTimeout(timer);
    timer = setTimeout(async () => {
      out(c.dim(`\n  changed: ${file}`));
      try { if (await ensureLinked()) await start('reloaded'); } catch (e) { printError(e, { pluginId: id }); }
      rl.prompt();
    }, 250);
  });

  rl.setPrompt(c.cyan('dev› '));
  rl.prompt();
  for await (const raw of rl) {
    const line = raw.trim();
    const [cmd, ...restParts] = line.split(/\s+/);
    const rest = line.slice((cmd ?? '').length).trim();
    try {
      if (!cmd) { /* empty */ }
      else if (cmd === 'quit' || cmd === 'exit') break;
      else if (cmd === 'help') out(DEV_HELP);
      else if (!id) out(c.yellow('  fix the manifest first'));
      else if (cmd === 'tools') {
        const tools = helm.contributions().tools.filter((t) => t.pluginId === id);
        out(table(['tool', 'exposed as', 'effect', 'status'], tools.map((t) => [t.tool.name, t.exposedName, t.tool.effect, t.available ? c.green('ready') : c.yellow(t.reason ?? '')])));
      } else if (cmd === 'call') {
        const tool = restParts[0];
        if (!tool) { out('  usage: call <tool> [json | k=v ...]'); }
        else {
          const entry = helm.contributions().tools.find((t) => t.pluginId === id && (t.tool.name === tool || t.exposedName === tool));
          if (!entry) out(c.yellow(`  no tool ${tool}`));
          else {
            const t0 = Date.now();
            const res = await helm.invokeTool(entry, parseInput(rest.slice(tool.length)), { sessionId: 'dev' });
            for (const b of res.content) out(b.type === 'json' ? JSON.stringify(b.data, null, 2) : b.text);
            out(c.dim(`  ${res.isError ? c.red('isError') : sym.ok} ${Date.now() - t0} ms`));
          }
        }
      } else if (cmd === 'cmd') {
        const name = restParts[0]!;
        const r = await helm.runCommand(id, name, parseInput(rest.slice(name.length)));
        if (r.ui) out(renderUI(r.ui));
        for (const b of r.content ?? []) out(b.type === 'json' ? JSON.stringify(b.data, null, 2) : b.text);
      } else if (cmd === 'panel') out(renderUI(await helm.renderPanel(id, restParts[0]!)));
      else if (cmd === 'hook') {
        const ev = restParts[0]!;
        const res = await helm.process(id).call('hook/dispatch', { event: ev, payload: parseInput(rest.slice(ev.length)) });
        out(JSON.stringify(res, null, 2));
      } else if (cmd === 'grants') {
        const r = helm.state.require(id);
        out(table(['permission', 'scope', 'mode'], r.grants.map((g) => [g.id, (g.scope ?? []).join(', '), g.mode])));
        if (r.declined.length) out(c.dim(`  declined: ${r.declined.join(', ')}`));
        out(c.dim(`  ${(r.grants.map((g) => permissionDef(g.id)?.title).filter(Boolean)).join(' · ')}`));
      } else if (cmd === 'logs') out(helm.readLog(id, Number(restParts[0] ?? 30)).join('\n') || c.dim('  (empty)'));
      else if (cmd === 'trace') { helm.trace = restParts[0] === 'off' ? undefined : tracer; out(c.dim(`  trace ${helm.trace ? 'on' : 'off'}`)); }
      else if (cmd === 'reload') await start('reloaded');
      else out(c.yellow(`  unknown: ${cmd} (type help)`));
    } catch (e) {
      printError(e, { pluginId: id });
    }
    rl.prompt();
  }
  watcher.close();
  rl.close();
  await helm.shutdown();
}
