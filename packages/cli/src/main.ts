import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { Command } from 'commander';
import { Helm } from '../../core/src/helm.ts';
import { HOST_VERSION, PROTOCOL_VERSION } from '../../core/src/paths.ts';
import { getDotted, setDotted, parseCliValue } from '../../core/src/store.ts';
import { HelmError, ErrorCode, explain } from '../../core/src/errors.ts';
import { permissionDef, riskOf } from '../../core/src/permissions/catalog.ts';
import { sandboxAvailability, expectedIsolation, pythonRuntime, nodeRuntime } from '../../core/src/runtime/launch.ts';
import { configFields } from '../../core/src/plugin-config.ts';
import { formatProblems } from '../../core/src/manifest/manifest.ts';
import { registryDefaults } from '../../core/src/installer.ts';
import { c, out, json, table, printError, renderUI, sym, stateBadge, riskBadge, ago } from './ui.ts';
import { Prompter, collectConsent, printConsent, cliApprover } from './prompt.ts';

const program = new Command();
program
  .name('helm')
  .description('Helm — a local AI agent harness where every capability is a sandboxed plugin.')
  .version(`${HOST_VERSION} (protocol ${PROTOCOL_VERSION})`)
  .option('--home <dir>', 'Helm home directory (default: $HELM_AGENT_HOME or ~/.helm-agent)')
  .option('-C, --workspace <dir>', 'workspace the agent and plugins operate on (default: current directory)')
  .showHelpAfterError();

let helmInstance: Helm | undefined;
const prompter = new Prompter();
function helm(opts: { yes?: boolean } = {}): Helm {
  if (!helmInstance) {
    const g = program.opts<{ home?: string; workspace?: string }>();
    helmInstance = Helm.open({ home: g.home, workspace: g.workspace });
  }
  helmInstance.approver = cliApprover(prompter, { yes: opts.yes });
  return helmInstance;
}

function act<A extends unknown[]>(fn: (...args: A) => Promise<unknown> | unknown) {
  return async (...args: A) => {
    try {
      const code = await fn(...args);
      if (typeof code === 'number') process.exitCode = code;
    } catch (e) {
      const maybeId = args.find((a) => typeof a === 'string' && /^[a-z0-9]+(\.[a-z0-9-]+)+$/.test(a)) as string | undefined;
      const jsonMode = args.some((a) => a && typeof a === 'object' && (a as { json?: boolean }).json);
      printError(e, { pluginId: maybeId, json: jsonMode });
      process.exitCode = 1;
    } finally {
      prompter.close();
      await helmInstance?.shutdown();
    }
  };
}

const collect = (v: string, prev: string[] = []) => [...prev, v];

function kvArgs(parts: string[]): Record<string, unknown> {
  const joined = parts.join(' ').trim();
  if (joined.startsWith('{')) return JSON.parse(joined);
  const o: Record<string, unknown> = {};
  for (const p of parts) {
    const i = p.indexOf('=');
    if (i > 0) o[p.slice(0, i)] = parseCliValue(p.slice(i + 1));
  }
  return o;
}

function statusOf(h: Helm, id: string) {
  const a = h.availability(id);
  if (a.available) return c.green('ready');
  if (a.code === 'PLUGIN_DISABLED') return c.gray('disabled');
  if (a.code === 'PLUGIN_QUARANTINED') return c.red('quarantined');
  return c.yellow(`unavailable: ${a.reason}`);
}

// ================================================================== top level
program.command('status', { isDefault: true }).description('overview of plugins, provider and isolation')
  .action(act(() => {
    const h = helm();
    const sb = sandboxAvailability();
    out(`${c.bold('Helm')} ${HOST_VERSION} ${c.dim(`· home ${h.paths.home} · workspace ${h.workspace}`)}`);
    out(`  sandbox: ${sb.available ? c.green('macOS sandbox available (strict isolation)') : c.yellow(`unavailable — ${sb.reason}`)}`);
    const installed = h.installed();
    if (!installed.length) {
      out(`\n  No plugins installed. Start with:\n    helm init            ${c.dim('# install the bundled plugins')}\n    helm plugin search`);
      return;
    }
    try {
      const { entry, model } = h.resolveProvider();
      out(`  provider: ${c.bold(entry.qualified)} ${c.dim(`model ${model ?? '(default)'}`)}`);
    } catch (e) { out(`  provider: ${c.yellow((e as Error).message)}`); }
    const tools = h.contributions().tools;
    out(`  tools: ${tools.filter((t) => t.available).length} ready / ${tools.length} contributed\n`);
    out(table(['plugin', 'version', 'status'], installed.map(({ record }) => [record.id, record.version, statusOf(h, record.id)])));
    out(c.dim('\n  helm chat · helm plugin list · helm doctor · helm serve'));
  }));

program.command('init').description('set up Helm and install the bundled plugins')
  .option('-y, --yes', 'grant every requested permission without asking')
  .option('--secrets <backend>', 'secret storage: keychain (macOS default) or file')
  .option('--only <ids>', 'comma-separated bundled plugin ids to install')
  .action(act(async (o: { yes?: boolean; secrets?: string; only?: string }) => {
    const h = helm(o);
    if (o.secrets) h.configStore.update((cfg) => { cfg.secrets.backend = o.secrets === 'file' ? 'file' : 'keychain'; });
    out(`${c.bold('Helm init')} ${c.dim(`home ${h.paths.home}`)}`);
    const defaults = registryDefaults(h.config());
    const wanted = o.only ? o.only.split(',').map((s) => s.trim()) : defaults.starter;
    if (!wanted.length) out(c.yellow(`  ${sym.warn} your registries mark no starter plugins; browse with: helm plugin search`));
    for (const id of wanted) {
      if (h.state.get(id)) { out(c.dim(`  ${sym.ok} ${id} already installed`)); continue; }
      const plan = await h.prepareInstall(id);
      printConsent(plan.manifest, plan.consent);
      const decisions = await collectConsent(plan.consent, { yes: o.yes, prompter });
      const { record, notes } = await h.commitInstall(plan, decisions);
      notes.forEach((n) => out(c.yellow(`  ${sym.warn} ${n}`)));
      out(`${c.green(sym.ok)} installed ${record.id}@${record.version}${record.enabled ? '' : c.yellow(' (disabled)')}`);
    }
    // Pick a default provider among installed provider plugins (the registry may express a preference).
    // A provider that only lacks the OS sandbox still counts: the user can run from a normal terminal or trust it.
    const usable = (p: { available: boolean; code?: string }) => p.available || p.code === ErrorCode.ISOLATION_UNAVAILABLE;
    const providers = h.providers().filter(usable);
    if (!h.config().provider && providers.length) {
      const pick = providers.find((p) => p.qualified === defaults.preferredProvider) ?? providers[0]!;
      h.configStore.update((cfg) => { cfg.provider = pick.qualified; });
    }
    const entry = providers.find((p) => p.qualified === h.config().provider);
    if (!entry) {
      out(`\n  ${c.bold('Next')}: install a model provider plugin: helm plugin search provider`);
      return;
    }
    if (!entry.available) {
      out(c.yellow(`\n  ${sym.warn} The OS sandbox cannot be applied here (${sandboxAvailability().reason ?? 'unavailable'}).`));
      out(c.yellow(`    Untrusted plugins will refuse to start. Run Helm from a normal terminal, or trust specific plugins: helm plugin trust <id>`));
    }
    const missing = h.missingSecrets(entry.pluginId);
    out(`\n  ${c.bold('Next')}: ${missing.length ? `add credentials for ${entry.provider.title ?? entry.qualified}, then start chatting` : 'start chatting'}:`);
    for (const n of missing) out(`    helm secrets set ${entry.pluginId} ${n}`);
    out(`    helm chat`);
    const ready = providers.find((p) => p.qualified !== entry.qualified && h.missingSecrets(p.pluginId).length === 0);
    if (missing.length && ready) out(c.dim(`  (no credentials yet? use ${ready.provider.title ?? ready.qualified}: helm provider use ${ready.qualified})`));
  }));
program.command('explain [code]').description('what an error code means and what to do about it')
  .action((code?: string) => {
    const codes = Object.keys(ErrorCode);
    const k = code?.toUpperCase().replace(/-/g, '_');
    if (!k || !codes.includes(k)) {
      if (code) { out(`${c.red('Unknown error code')} ${code}.`); process.exitCode = 1; }
      out(table(['code', 'meaning'], codes.map((x) => [x, explain(x).title])));
      return;
    }
    const info = explain(k);
    out(`${c.bold(k)}  ${info.title}`);
    if (info.hint) out(`\n${info.hint}`);
  });

program.command('doctor').description('check the environment, isolation and every plugin')
  .option('--json', 'machine-readable output')
  .action(act((o: { json?: boolean }) => {
    const h = helm();
    const checks: Array<{ check: string; ok: boolean | 'warn'; detail: string; fix?: string }> = [];
    const nodeMajor = Number(process.versions.node.split('.')[0]);
    checks.push({ check: 'node', ok: nodeMajor >= 22, detail: `${process.version} at ${nodeRuntime().exe}`, fix: nodeMajor >= 22 ? undefined : 'Install Node 22.18+' });
    const py = pythonRuntime();
    checks.push({ check: 'python', ok: py ? true : 'warn', detail: py ? `${py.version} at ${py.exe}` : 'python3 not found — Python plugins cannot run', fix: py ? undefined : 'Install Python 3.9+' });
    const sb = sandboxAvailability();
    checks.push({ check: 'sandbox', ok: sb.available ? true : 'warn', detail: sb.available ? 'macOS sandbox-exec works: strict isolation' : sb.reason ?? 'unavailable', fix: sb.available ? undefined : 'Run Helm from a normal terminal. Untrusted plugins will refuse to start until then.' });
    const git = spawnSync('git', ['--version'], { encoding: 'utf8' });
    checks.push({ check: 'git', ok: git.status === 0 ? true : 'warn', detail: git.status === 0 ? git.stdout.trim() : 'git not found (needed to install plugins from git URLs, and by plugins that run git)' });
    const st = fs.statSync(h.paths.home);
    checks.push({ check: 'home', ok: (st.mode & 0o077) === 0 ? true : 'warn', detail: `${h.paths.home} mode ${(st.mode & 0o777).toString(8)}`, fix: (st.mode & 0o077) === 0 ? undefined : `chmod 700 ${h.paths.home}` });
    checks.push({ check: 'secrets', ok: true, detail: `backend: ${h.config().secrets.backend}` });
    try {
      const { entry, model } = h.resolveProvider();
      const missing = h.missingSecrets(entry.pluginId);
      checks.push({ check: 'provider', ok: missing.length ? 'warn' : true, detail: `${entry.qualified} · ${model ?? 'default'}${missing.length ? ` · missing secret(s): ${missing.join(', ')}` : ''}`, fix: missing.length ? missing.map((n) => `helm secrets set ${entry.pluginId} ${n}`).join(' && ') : undefined });
    } catch (e) { checks.push({ check: 'provider', ok: 'warn', detail: (e as Error).message, fix: 'helm init, then helm provider use <plugin/provider>' }); }
    for (const { record, manifest } of h.installed()) {
      const a = h.availability(record.id);
      const last = record.health.lastError;
      checks.push({
        check: record.id, ok: a.available ? true : a.code === 'PLUGIN_DISABLED' ? 'warn' : false,
        detail: `${record.version} · ${a.available ? `ready · ${manifest ? expectedIsolation(manifest).level : '?'} isolation` : a.reason}${last ? ` · last error ${ago(last.at)}: ${last.message}` : ''}`,
        fix: a.available ? undefined : a.code === 'PLUGIN_QUARANTINED' ? `helm plugin logs ${record.id} && helm plugin reset ${record.id}` : a.code === 'PLUGIN_DISABLED' ? `helm plugin enable ${record.id}` : a.code === 'ISOLATION_UNAVAILABLE' ? `run from a normal terminal, or helm plugin trust ${record.id}` : `helm plugin info ${record.id}`,
      });
    }
    if (o.json) return json(checks);
    for (const ch of checks) {
      const icon = ch.ok === true ? c.green(sym.ok) : ch.ok === 'warn' ? c.yellow(sym.warn) : c.red(sym.fail);
      out(`${icon} ${c.bold(ch.check.padEnd(18))} ${ch.detail}${ch.fix ? `\n  ${''.padEnd(19)}${c.cyan(sym.arrow)} ${ch.fix}` : ''}`);
    }
    return checks.some((x) => x.ok === false) ? 1 : 0;
  }));

program.command('chat').description('interactive agent session')
  .option('-m, --model <id>', 'model id for this session')
  .option('-p, --provider <plugin/provider>', 'provider for this session')
  .option('-y, --yes', 'approve every tool call without asking (careful)')
  .option('-v, --verbose', 'show tool output summaries and token usage')
  .action(act(async (o: { model?: string; provider?: string; yes?: boolean; verbose?: boolean }) => {
    const { runChat } = await import('./chat.ts');
    await runChat(helm(o), o);
  }));

program.command('run').description('run one prompt non-interactively').argument('<prompt...>')
  .option('-m, --model <id>').option('-p, --provider <plugin/provider>')
  .option('-y, --yes', 'approve tool calls that need approval')
  .option('--json', 'print the full event log as JSON').option('-v, --verbose')
  .action(act(async (words: string[], o: { model?: string; provider?: string; yes?: boolean; json?: boolean; verbose?: boolean }) => {
    const { runOnce } = await import('./chat.ts');
    return runOnce(helm(o), words.join(' '), o);
  }));

program.command('serve').description('start the local web console')
  .option('--port <n>', 'port', '4317').option('--open', 'open in the browser')
  .action(async (o: { port: string; open?: boolean }) => {
    try {
      const { startServer } = await import('../../web/src/server.ts');
      const g = program.opts<{ home?: string; workspace?: string }>();
      await startServer({ home: g.home, workspace: g.workspace, port: Number(o.port), open: o.open });
    } catch (e) { printError(e); process.exitCode = 1; }
  });

program.command('tools').description('list tools contributed by plugins (and why some are unavailable)')
  .option('--json')
  .action(act((o: { json?: boolean }) => {
    const tools = helm().contributions().tools;
    if (o.json) return json(tools.map((t) => ({ name: t.exposedName, plugin: t.pluginId, effect: t.tool.effect, available: t.available, reason: t.reason, description: t.tool.description })));
    out(table(['tool', 'plugin', 'effect', 'status'], tools.map((t) => [t.exposedName, t.pluginId, t.tool.effect, t.available ? c.green('ready') : c.yellow(t.reason ?? '')])));
  }));

program.command('cmd').description('list or run plugin commands').argument('[command]', 'e.g. guard.report').argument('[args...]', 'key=value or JSON')
  .option('--json')
  .action(act(async (spec: string | undefined, args: string[], o: { json?: boolean }) => {
    const h = helm();
    if (!spec) {
      out(table(['command', 'title', 'status'], h.contributions().commands.map((x) => [x.qualified, x.command.title, x.available ? c.green('ready') : c.yellow(x.reason ?? '')])));
      return;
    }
    const ce = h.findCommand(spec);
    const r = await h.runCommand(ce.pluginId, ce.command.name, kvArgs(args));
    if (o.json) return json(r);
    if (r.ui) out(renderUI(r.ui));
    for (const b of r.content ?? []) out(b.type === 'json' ? JSON.stringify(b.data, null, 2) : b.text);
  }));

program.command('panel').description('list or render plugin panels').argument('[panel]', 'e.g. git.repo')
  .action(act(async (spec?: string) => {
    const h = helm();
    const panels = h.contributions().panels;
    if (!spec) { out(table(['panel', 'title', 'status'], panels.map((p) => [p.qualified, p.panel.title, p.available ? c.green('ready') : c.yellow(p.reason ?? '')]))); return; }
    const p = panels.find((x) => x.qualified === spec);
    if (!p) throw new HelmError(ErrorCode.NOT_IMPLEMENTED, `No panel ${spec}`);
    out(c.bold(p.panel.title));
    out(renderUI(await h.renderPanel(p.pluginId, p.panel.id)));
  }));

program.command('audit').description('security audit trail: grants, broker decisions, hooks, approvals')
  .option('-n, --limit <n>', 'entries', '40').option('--plugin <id>').option('--denied', 'only denials').option('--json')
  .action(act((o: { limit: string; plugin?: string; denied?: boolean; json?: boolean }) => {
    const rows = helm().audit.query({ plugin: o.plugin, denied: o.denied, limit: Number(o.limit) });
    if (o.json) return json(rows);
    if (!rows.length) return out(c.dim('  no audit entries'));
    out(table(['time', 'plugin', 'kind', 'action', 'target', 'decision'], rows.map((r) => [r.ts.slice(5, 19).replace('T', ' '), r.plugin, r.kind, `${r.permission ? `${r.permission}: ` : ''}${r.action}`, r.target ?? '', r.decision === 'denied' ? c.red(`denied${r.reason ? ` (${r.reason})` : ''}`) : r.decision === 'allowed' ? c.green('allowed') : c.dim('info')]), { maxCol: 50 }));
  }));

program.command('config').description('get or set host configuration (dotted keys)')
  .argument('[action]', 'get | set | unset').argument('[key]').argument('[value]')
  .action(act((action?: string, key?: string, value?: string) => {
    const h = helm();
    if (!action || (action === 'get' && !key)) return json(h.config());
    if (action === 'get') return json(getDotted(h.config(), key!));
    if (action === 'set' && key && value !== undefined) {
      h.configStore.update((cfg) => setDotted(cfg as unknown as Record<string, unknown>, key, parseCliValue(value)));
      out(`${c.green(sym.ok)} ${key} = ${JSON.stringify(getDotted(h.config(), key))}`);
      return;
    }
    if (action === 'unset' && key) {
      h.configStore.update((cfg) => setDotted(cfg as unknown as Record<string, unknown>, key, undefined));
      out(`${c.green(sym.ok)} ${key} reset`);
      return;
    }
    throw new HelmError(ErrorCode.INPUT_INVALID, 'usage: helm config [get <key> | set <key> <value> | unset <key>]');
  }));

// ================================================================== provider
const provider = program.command('provider').description('model providers (contributed by plugins)');
provider.command('list').description('list providers').action(act(() => {
  const h = helm();
  const cfg = h.config();
  out(table(['provider', 'title', 'default model', 'status'], h.providers().map((p) => [(cfg.provider === p.qualified ? c.green('● ') : '  ') + p.qualified, p.provider.title, p.provider.defaultModel ?? '', p.available ? c.green('ready') : c.yellow(p.reason ?? '')])));
  if (cfg.model) out(c.dim(`  model override: ${cfg.model}`));
}));
provider.command('use').description('choose the default provider (and optionally model)').argument('<provider>', 'qualified provider id: <plugin-id>/<provider-id> (see helm provider list)')
  .option('-m, --model <id>', 'default model id')
  .action(act((spec: string, o: { model?: string }) => {
    const h = helm();
    const p = h.providers().find((x) => x.qualified === spec || x.pluginId === spec);
    if (!p) throw new HelmError(ErrorCode.NO_PROVIDER, `No provider "${spec}"`, { hint: `Available: ${h.providers().map((x) => x.qualified).join(', ') || 'none'}` });
    h.configStore.update((cfg) => { cfg.provider = p.qualified; cfg.model = o.model; });
    out(`${c.green(sym.ok)} provider ${p.qualified}${o.model ? ` · model ${o.model}` : ` · model ${p.provider.defaultModel ?? '(provider default)'}`}`);
    if (!p.available) out(c.yellow(`  ${sym.warn} currently unavailable: ${p.reason}`));
  }));
provider.command('models').description('list models from a provider').argument('[provider]')
  .option('--filter <text>').option('--all', 'include models blocked by policy').option('--json')
  .action(act(async (spec: string | undefined, o: { filter?: string; all?: boolean; json?: boolean }) => {
    const { provider: q, models } = await helm().listModels(spec);
    const list = (models as Array<{ id: string; name?: string; contextLength?: number; pricing?: { inputPerM?: number; outputPerM?: number }; blocked?: boolean; reason?: string; recommended?: string }>)
      .filter((m) => (o.all || !m.blocked) && (!o.filter || m.id.includes(o.filter)));
    if (o.json) return json(list);
    out(c.dim(`  ${q}: ${list.length} model(s)`));
    out(table(['model', 'role', 'context', '$/1M in', '$/1M out', o.all ? 'policy' : ''], list.slice(0, 80).map((m) => [m.id, m.recommended ?? '', m.contextLength ?? '', m.pricing?.inputPerM?.toFixed(2) ?? '', m.pricing?.outputPerM?.toFixed(2) ?? '', m.blocked ? c.red(`blocked: ${m.reason}`) : ''])));
  }));

// ================================================================== secrets
const secrets = program.command('secrets').description('API keys and tokens for plugins (stored outside plugins, injected per call)');
secrets.command('set').argument('<plugin>').argument('<name>')
  .option('--from-env <VAR>', 'read the value from an environment variable')
  .option('--from-dotenv <file>', 'read from a .env file (key = --var or <name>)').option('--var <VAR>', 'variable name inside the .env file')
  .action(act(async (id: string, name: string, o: { fromEnv?: string; fromDotenv?: string; var?: string }) => {
    const h = helm();
    let value: string | undefined;
    if (o.fromEnv) value = process.env[o.fromEnv];
    else if (o.fromDotenv) {
      const want = o.var ?? name;
      for (const line of fs.readFileSync(o.fromDotenv, 'utf8').split('\n')) {
        const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
        if (m && m[1] === want) value = m[2]!.replace(/^['"]|['"]$/g, '');
      }
    } else value = await prompter.secret(`${name} for ${id}: `);
    if (!value) throw new HelmError(ErrorCode.INPUT_INVALID, 'No value provided');
    h.setSecret(id, name, value);
    out(`${c.green(sym.ok)} stored ${name} for ${id} ${c.dim(`(${h.config().secrets.backend}; the plugin can read it only via its "secrets" grant)`)}`);
  }));
secrets.command('list').argument('[plugin]').action(act((id?: string) => {
  const h = helm();
  const ids = id ? [id] : h.state.list().map((r) => r.id);
  const rows = ids.flatMap((pid) => h.secrets.list(pid).map((n) => [pid, n, '••••••••']));
  out(rows.length ? table(['plugin', 'secret', 'value'], rows) : c.dim('  no secrets stored'));
}));
secrets.command('delete').argument('<plugin>').argument('<name>').action(act((id: string, name: string) => {
  helm().secrets.delete(id, name);
  out(`${c.green(sym.ok)} deleted ${name} for ${id}`);
}));

// ================================================================== plugin
const plugin = program.command('plugin').alias('plugins').description('install, inspect, configure and develop plugins');

plugin.command('list').alias('ls').description('installed plugins').option('--json')
  .action(act((o: { json?: boolean }) => {
    const h = helm();
    const rows = h.installed().map(({ record, manifest }) => {
      const a = h.availability(record.id);
      const k = manifest?.contributes ?? {};
      const contrib = [k.tools?.length ? `${k.tools.length} tools` : '', k.commands?.length ? `${k.commands.length} cmds` : '', k.hooks?.length ? `${k.hooks.length} hooks` : '', k.panels?.length ? `${k.panels.length} panels` : '', k.providers?.length ? `provider` : ''].filter(Boolean).join(' · ');
      return { id: record.id, version: record.version, runtime: manifest?.runtime.type, status: a, contributes: contrib, isolation: manifest ? expectedIsolation(manifest).level : '?', trusted: record.trusted, source: `${record.source.type}` };
    });
    if (o.json) return json(rows);
    if (!rows.length) return out(c.dim('  no plugins installed — try `helm init` or `helm plugin search`'));
    out(table(['plugin', 'version', 'runtime', 'status', 'contributes', 'isolation', 'source'], rows.map((r) => [r.id, r.version, r.runtime, statusOf(h, r.id), r.contributes, r.isolation + (r.trusted ? c.yellow(' (trusted)') : ''), r.source]), { maxCol: 48 }));
  }));

plugin.command('search').description('search configured registries').argument('[query]').option('--json')
  .action(act((q: string | undefined, o: { json?: boolean }) => {
    const h = helm();
    const res = h.search(q);
    if (o.json) return json(res);
    out(table(['plugin', 'version', 'installed', 'permissions', 'description'], res.map((r) => [r.id, r.version, h.state.get(r.id)?.version ?? '', r.permissions.join(' ') || 'none', r.description]), { maxCol: 54 }));
  }));

plugin.command('info').description('everything about one plugin').argument('<id>').option('--json')
  .action(act((id: string, o: { json?: boolean }) => {
    const h = helm();
    const { record, manifest } = h.requireManifest(id);
    const a = h.availability(id);
    const contributions = h.contributions();
    if (o.json) return json({ record, manifest, availability: a, isolation: expectedIsolation(manifest), config: configFields(manifest, record.config) });
    out(`${c.bold(manifest.name)} ${c.dim(`${manifest.id}@${manifest.version}`)} ${a.available ? c.green('ready') : c.yellow(a.reason ?? '')}`);
    out(`  ${manifest.description}`);
    const iso = expectedIsolation(manifest);
    out(table(['', ''], [
      ['runtime', `${manifest.runtime.type} · ${manifest.runtime.entry ?? manifest.runtime.command?.join(' ')}`],
      ['isolation', iso.level === 'strict' ? c.green('strict') : `${c.yellow(iso.level)} (${iso.reason})${record.trusted ? c.yellow(' · trusted') : ''}`],
      ['source', `${record.source.type}: ${record.source.location}`],
      ['folder', record.dir],
      ['installed', `${record.installedAt.slice(0, 19).replace('T', ' ')}${record.previous ? ` · rollback available → ${record.previous.version}` : ''}`],
      ['health', record.health.lastError ? c.red(`${record.health.lastError.code} ${ago(record.health.lastError.at)}: ${record.health.lastError.message}`) : c.green('no errors')],
      ['log', h.logFile(id)],
    ]).split('\n').slice(1).join('\n'));
    out(`\n${c.bold('Permissions')}`);
    for (const p of manifest.permissions ?? []) {
      const g = record.grants.find((x) => x.id === p.id);
      out(`  ${g ? c.green(sym.ok) : c.dim('·')} ${p.id.padEnd(18)} ${g ? `${(g.scope ?? []).join(', ')}${g.mode === 'ask' ? c.yellow(' (ask)') : ''}` : c.dim(record.declined.includes(p.id) ? 'declined' : 'not granted')}${p.optional ? c.dim(' · optional') : ''}`);
    }
    if (!(manifest.permissions ?? []).length) out(c.dim('  none'));
    const mine = <T extends { pluginId: string }>(xs: T[]) => xs.filter((x) => x.pluginId === id);
    out(`\n${c.bold('Contributes')}`);
    for (const t of mine(contributions.tools)) out(`  tool     ${t.exposedName.padEnd(26)} ${c.dim(t.tool.effect)} ${t.available ? '' : c.yellow(t.reason ?? '')}`);
    for (const x of mine(contributions.commands)) out(`  command  ${x.qualified.padEnd(26)} ${c.dim(x.command.title)}`);
    for (const x of mine(contributions.hooks)) out(`  hook     ${x.hook.event.padEnd(26)} ${c.dim(`${x.hook.mode}${x.hook.onError === 'block' ? ', fail-closed' : ''}`)} ${x.available ? '' : c.yellow(x.reason ?? '')}`);
    for (const x of mine(contributions.panels)) out(`  panel    ${x.qualified.padEnd(26)} ${c.dim(x.panel.title)}`);
    for (const x of mine(contributions.providers)) out(`  provider ${x.qualified.padEnd(26)} ${c.dim(x.provider.defaultModel ?? '')}`);
    const fields = configFields(manifest, record.config);
    if (fields.length) {
      out(`\n${c.bold('Configuration')} ${c.dim(`(helm plugin config ${id} set <key> <value>)`)}`);
      for (const f of fields) out(`  ${f.key.padEnd(18)} ${JSON.stringify(f.value)?.slice(0, 70)}${f.isSet ? '' : c.dim(' (default)')}`);
    }
    const recent = h.audit.query({ plugin: id, limit: 5 });
    if (recent.length) {
      out(`\n${c.bold('Recent activity')}`);
      for (const r of recent) out(c.dim(`  ${r.ts.slice(11, 19)} ${r.kind} ${r.permission ?? ''} ${r.action} ${r.target ?? ''} → ${r.decision}`));
    }
  }));

plugin.command('install').description('install from a registry id, folder, .tgz or git URL').argument('<spec>')
  .option('--link', 'link a local folder (live; for development)')
  .option('-y, --yes', 'grant every requested permission')
  .option('--grant <perm[=scope,...]>', 'grant a permission (optionally narrowing its scope)', collect)
  .option('--deny <perm>', 'decline an (optional) permission', collect)
  .option('--no-enable', 'install but keep disabled')
  .action(act(async (spec: string, o: { link?: boolean; yes?: boolean; grant?: string[]; deny?: string[]; enable: boolean }) => {
    const h = helm(o);
    const plan = await h.prepareInstall(spec, { link: o.link });
    if (plan.isUpdate) { plan.cleanup(); throw new HelmError(ErrorCode.INSTALL_FAILED, `${plan.manifest.id} is already installed (${plan.existing!.version})`, { hint: `helm plugin update ${plan.manifest.id}${spec !== plan.manifest.id ? ` ${spec}` : ''}` }); }
    if (plan.warnings.length) out(formatProblems(plan.warnings));
    printConsent(plan.manifest, plan.consent);
    const decisions = await collectConsent(plan.consent, { yes: o.yes, grant: o.grant, deny: o.deny, prompter });
    const { record, notes } = await h.commitInstall(plan, decisions, { enable: o.enable });
    notes.forEach((n) => out(c.yellow(`  ${sym.warn} ${n}`)));
    out(`${c.green(sym.ok)} installed ${c.bold(record.id)}@${record.version} ${record.enabled ? c.green('enabled') : c.yellow('disabled')}`);
    const a = h.availability(record.id);
    if (record.enabled && !a.available) out(c.yellow(`  ${sym.warn} not runnable yet: ${a.reason}`));
  }));

plugin.command('update').description('update to a newer version (asks only about new permissions)').argument('<id>').argument('[spec]', 'source (default: where it was installed from)')
  .option('-y, --yes').option('--grant <perm[=scope,...]>', '', collect).option('--deny <perm>', '', collect)
  .action(act(async (id: string, spec: string | undefined, o: { yes?: boolean; grant?: string[]; deny?: string[] }) => {
    const h = helm(o);
    const before = h.state.require(id).version;
    const plan = await h.prepareUpdate(id, spec);
    if (plan.upToDate) { plan.cleanup(); out(`${c.green(sym.ok)} ${id} is up to date (${before})`); return; }
    out(`${c.bold(id)} ${before} ${sym.arrow} ${c.bold(plan.manifest.version)}`);
    if (plan.diff.length) printConsent(plan.manifest, plan.diff, `  This version asks for ${plan.diff.length} new or wider permission(s):`);
    else out(c.green(`  ${sym.ok} no new permissions`));
    const decisions = await collectConsent(plan.diff, { yes: o.yes, grant: o.grant, deny: o.deny, prompter });
    const { record, notes } = await h.commitUpdate(plan, decisions);
    notes.forEach((n) => out(c.yellow(`  ${sym.warn} ${n}`)));
    out(`${c.green(sym.ok)} updated ${id} to ${record.version}${record.enabled ? '' : c.yellow(' (disabled)')} ${c.dim(`· undo with: helm plugin rollback ${id}`)}`);
  }));

plugin.command('rollback').description('return to the previously installed version').argument('<id>')
  .action(act(async (id: string) => {
    const r = await helm().rollback(id);
    out(`${c.green(sym.ok)} ${id} rolled back to ${r.version} (grants and config restored)`);
  }));

plugin.command('uninstall').alias('remove').argument('<id>').option('--purge', 'also delete its data and secrets')
  .action(act(async (id: string, o: { purge?: boolean }) => {
    await helm().uninstall(id, o);
    out(`${c.green(sym.ok)} uninstalled ${id}${o.purge ? ' (data and secrets deleted)' : c.dim(' (data kept; --purge to delete)')}`);
  }));

for (const [name, desc] of [['enable', 'allow the plugin to run'], ['disable', 'stop and hide the plugin'], ['trust', 'allow running with reduced isolation when the sandbox is unavailable'], ['untrust', 'require full isolation again'], ['reset', 'clear crash history / quarantine']] as const) {
  plugin.command(name).description(desc).argument('<id>').action(act(async (id: string) => {
    const h = helm();
    h.state.require(id);
    if (name === 'trust') {
      out(c.yellow(`  ${sym.warn} Trusting ${id} lets it run without the OS sandbox when strict isolation is unavailable.`));
      out(c.dim('    Node plugins keep the Node permission model; Python/exec plugins keep only the broker and a scrubbed environment.'));
    }
    if (name === 'enable') await h.enable(id);
    else if (name === 'disable') await h.disable(id);
    else if (name === 'trust') await h.setTrusted(id, true);
    else if (name === 'untrust') await h.setTrusted(id, false);
    else await h.reset(id);
    const done = { enable: 'enabled', disable: 'disabled', trust: 'trusted', untrust: 'untrusted', reset: 'health reset' }[name];
    out(`${c.green(sym.ok)} ${id}: ${done} ${c.dim(`→ ${statusOf(h, id)}`)}`);
  }));
}

plugin.command('permissions').alias('perms').description('declared vs granted permissions').argument('<id>')
  .action(act((id: string) => {
    const h = helm();
    const { record, manifest } = h.requireManifest(id);
    out(table(['permission', 'risk', 'requested', 'granted', 'enforced by'], (manifest.permissions ?? []).map((p) => {
      const g = record.grants.find((x) => x.id === p.id);
      return [p.id + (p.optional ? c.dim('?') : ''), riskBadge(riskOf(p.id, g?.scope ?? p.scope)), (p.scope ?? []).join(', ') || '—', g ? `${(g.scope ?? ['yes']).join(', ')}${g.mode === 'ask' ? c.yellow(' (ask)') : ''}` : c.dim(record.declined.includes(p.id) ? 'declined' : 'no'), permissionDef(p.id)?.enforcedBy ?? ''];
    }), { maxCol: 44 }));
    out(c.dim(`\n  grant:  helm plugin grant ${id} <permission> [--scope a,b] [--ask]\n  revoke: helm plugin revoke ${id} <permission> [--scope a]`));
  }));

plugin.command('grant').argument('<id>').argument('<permission>').option('--scope <list>', 'comma-separated scope').option('--ask', 'ask me each time it is used')
  .action(act(async (id: string, perm: string, o: { scope?: string; ask?: boolean }) => {
    await helm().grant(id, perm, { scope: o.scope?.split(',').map((s) => s.trim()), mode: o.ask ? 'ask' : undefined });
    out(`${c.green(sym.ok)} granted ${perm} to ${id}${o.scope ? ` (${o.scope})` : ''} ${c.dim('· the broker allows it from the next call; the OS sandbox widens when the plugin next starts')}`);
  }));

plugin.command('revoke').argument('<id>').argument('<permission>').option('--scope <list>', 'revoke only these scope entries')
  .action(act(async (id: string, perm: string, o: { scope?: string }) => {
    await helm().revoke(id, perm, { scope: o.scope?.split(',').map((s) => s.trim()) });
    out(`${c.green(sym.ok)} revoked ${perm}${o.scope ? ` (${o.scope})` : ''} from ${id} ${c.dim('· denied from the next call; a running plugin is restarted so its OS sandbox shrinks too')}`);
  }));

plugin.command('config').description('show or change plugin settings').argument('<id>').argument('[action]', 'set | unset').argument('[key]').argument('[value]')
  .option('--json')
  .action(act(async (id: string, action: string | undefined, key: string | undefined, value: string | undefined, o: { json?: boolean }) => {
    const h = helm();
    const { record, manifest } = h.requireManifest(id);
    if (!action) {
      const fields = configFields(manifest, record.config);
      if (o.json) return json(fields);
      if (!fields.length) return out(c.dim(`  ${id} has no settings`));
      for (const f of fields) {
        out(`${c.bold(f.key)} ${c.dim(f.type)}${f.enum ? c.dim(` one of ${f.enum.join('|')}`) : ''}  = ${JSON.stringify(f.value)}${f.isSet ? '' : c.dim(' (default)')}`);
        if (f.description) out(c.dim(`  ${f.description}`));
      }
      return;
    }
    const next = { ...record.config };
    if (action === 'set' && key && value !== undefined) next[key] = parseCliValue(value);
    else if (action === 'unset' && key) delete next[key];
    else throw new HelmError(ErrorCode.INPUT_INVALID, `usage: helm plugin config ${id} [set <key> <value> | unset <key>]`);
    await h.setConfig(id, next);
    out(`${c.green(sym.ok)} ${id} ${key} = ${action === 'unset' ? '(default)' : JSON.stringify(next[key!])}`);
  }));

plugin.command('limit').description('override a resource limit').argument('<id>').argument('<key>', 'callTimeoutMs | activationTimeoutMs | maxConcurrency | memoryMb | idleTimeoutMs').argument('[value]', 'omit to restore the default')
  .action(act(async (id: string, key: string, value?: string) => {
    await helm().setLimit(id, key, value === undefined ? undefined : Number(value));
    out(`${c.green(sym.ok)} ${id} ${key} = ${value ?? '(default)'}`);
  }));

plugin.command('logs').description('plugin log (stderr, SDK logs, lifecycle)').argument('<id>').option('-n, --lines <n>', 'lines', '60').option('-f, --follow')
  .action(act(async (id: string, o: { lines: string; follow?: boolean }) => {
    const h = helm();
    h.state.require(id);
    const lines = h.readLog(id, Number(o.lines));
    out(lines.length ? lines.join('\n') : c.dim(`  (no log yet at ${h.logFile(id)})`));
    if (o.follow) {
      let size = fs.existsSync(h.logFile(id)) ? fs.statSync(h.logFile(id)).size : 0;
      await new Promise<void>(() => {
        fs.watchFile(h.logFile(id), { interval: 500 }, (cur) => {
          if (cur.size > size) {
            const fd = fs.openSync(h.logFile(id), 'r');
            const buf = Buffer.alloc(cur.size - size);
            fs.readSync(fd, buf, 0, buf.length, size);
            fs.closeSync(fd);
            process.stdout.write(buf.toString('utf8'));
          }
          size = cur.size;
        });
      });
    }
  }));

plugin.command('call').description('invoke a plugin tool directly (debugging)').argument('<id>').argument('<tool>').argument('[input...]', 'JSON or key=value')
  .option('-y, --yes').option('--json')
  .action(act(async (id: string, tool: string, input: string[], o: { yes?: boolean; json?: boolean }) => {
    const h = helm(o);
    const entry = h.contributions().tools.find((t) => t.pluginId === id && (t.tool.name === tool || t.exposedName === tool));
    if (!entry) throw new HelmError(ErrorCode.NOT_IMPLEMENTED, `${id} has no tool "${tool}"`);
    const res = await h.invokeTool(entry, kvArgs(input), { sessionId: 'cli' });
    if (o.json) return json(res);
    for (const b of res.content) out(b.type === 'json' ? JSON.stringify(b.data, null, 2) : b.text);
    return res.isError ? 1 : 0;
  }));

plugin.command('new').description('scaffold a new plugin').argument('<name>')
  .option('--lang <lang>', 'typescript (default) or python').option('--dir <path>').option('--id <id>', 'plugin id (default local.<name>)')
  .action(act(async (name: string, o: { lang?: string; dir?: string; id?: string }) => {
    const { newPlugin } = await import('./dev.ts');
    newPlugin(name, o);
  }));

plugin.command('dev').description('link a plugin folder, hot-reload on save, and open a dev console').argument('[path]', 'plugin folder', '.')
  .option('-y, --yes', 'grant requested permissions without asking').option('--trace', 'print every protocol message')
  .action(act(async (dir: string, o: { yes?: boolean; trace?: boolean }) => {
    const { devPlugin } = await import('./dev.ts');
    await devPlugin(helm(o), dir, o);
  }));

plugin.command('validate').description('check a plugin folder without running it').argument('[path]', 'plugin folder', '.').option('--json')
  .action(act(async (dir: string, o: { json?: boolean }) => {
    const { validatePlugin } = await import('./dev.ts');
    return validatePlugin(dir, o) ? 0 : 1;
  }));

plugin.command('test').description("run a plugin's unit tests with the SDK test harness").argument('[path]', 'plugin folder', '.')
  .action(act(async (dir: string) => {
    const { testPlugin } = await import('./dev.ts');
    return testPlugin(dir);
  }));

plugin.command('pack').description('package a plugin as .hplugin.tgz').argument('[path]', 'plugin folder', '.').option('-o, --out <file>')
  .action(act(async (dir: string, o: { out?: string }) => {
    const { packPlugin } = await import('./dev.ts');
    await packPlugin(dir, o);
  }));

// Friendlier unknown-command handling.
program.on('command:*', (ops: string[]) => {
  printError(new HelmError(ErrorCode.INPUT_INVALID, `Unknown command "${ops[0]}"`, { hint: 'Run `helm --help`.' }));
  process.exitCode = 1;
});

await program.parseAsync(process.argv);
