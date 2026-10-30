import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Helm } from '../../core/src/helm.ts';
import { Session } from '../../core/src/agent/session.ts';
import type { SessionEvent } from '../../core/src/agent/session.ts';
import type { Approver, ApprovalRequest, ApprovalDecision } from '../../core/src/permissions/broker.ts';
import type { InstallPlan } from '../../core/src/installer.ts';
import { HelmError, ErrorCode, toHelmError, explain } from '../../core/src/errors.ts';
import { HOST_VERSION, REPO_ROOT } from '../../core/src/paths.ts';
import { sandboxAvailability, expectedIsolation } from '../../core/src/runtime/launch.ts';
import { configFields } from '../../core/src/plugin-config.ts';
import { permissionDef, riskOf } from '../../core/src/permissions/catalog.ts';
import { redactor } from '../../core/src/permissions/secrets.ts';
import { humanizeScope } from '../../core/src/permissions/grants.ts';

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '../public');
const VENDOR: Record<string, string> = {
  'preact.mjs': 'node_modules/preact/dist/preact.module.js',
  'hooks.mjs': 'node_modules/preact/hooks/dist/hooks.module.js',
  'htm.mjs': 'node_modules/htm/dist/htm.module.js',
};
const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

interface Client { res: http.ServerResponse }
type Handler = (req: http.IncomingMessage, params: Record<string, string>, body: any, url: URL) => Promise<unknown> | unknown;

export interface ServerOptions { home?: string; workspace?: string; port?: number; open?: boolean; token?: string; quiet?: boolean }

export async function startServer(opts: ServerOptions = {}) {
  const token = opts.token ?? crypto.randomBytes(24).toString('hex');
  const tokenBuf = Buffer.from(token);
  const tokenMatches = (p: unknown) => typeof p === 'string' && p.length === token.length && crypto.timingSafeEqual(Buffer.from(p), tokenBuf);
  const clients = new Set<Client>();
  const broadcast = (type: string, data: unknown) => {
    const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of clients) c.res.write(msg);
  };

  // ---- approvals are answered in the browser ----
  const pending = new Map<string, { req: ApprovalRequest; resolve: (d: ApprovalDecision) => void; timer: NodeJS.Timeout }>();
  const approver: Approver = {
    request(req) {
      return new Promise((resolve) => {
        const id = crypto.randomBytes(6).toString('hex');
        const timer = setTimeout(() => { pending.delete(id); broadcast('approval.resolved', { id, decision: 'deny', reason: 'timed out' }); resolve('deny'); }, 5 * 60_000);
        pending.set(id, { req, resolve, timer });
        broadcast('approval', { id, ...req });
      });
    },
  };

  const helm = Helm.open({ home: opts.home, workspace: opts.workspace, approver });
  const sessions = new Map<string, { session: Session; events: SessionEvent[]; busy: boolean; controller?: AbortController }>();
  const plans = new Map<string, { plan: InstallPlan; kind: 'install' | 'update'; at: number }>();
  setInterval(() => { for (const [k, v] of plans) if (Date.now() - v.at > 10 * 60_000) { v.plan.cleanup(); plans.delete(k); } }, 60_000).unref();

  helm.bus.on('*', (e: { name: string; payload: unknown }) => {
    if (e.name === 'plugin.log') return; // high volume; fetched on demand
    broadcast(e.name, e.payload);
  });
  let lastState = '';
  fs.watchFile(helm.paths.state, { interval: 1000 }, () => {
    const s = fs.readFileSync(helm.paths.state, 'utf8');
    if (s !== lastState) { lastState = s; broadcast('changed', {}); }
  });
  const changed = (plugin?: string) => broadcast('changed', { plugin });

  // ---- views ----
  const pluginSummary = (id: string) => {
    const record = helm.state.require(id);
    const manifest = helm.manifestOf(record);
    const a = helm.availability(id);
    const proc = helm.runningProcess(id)?.describe();
    const k = manifest?.contributes ?? {};
    return {
      id, name: manifest?.name ?? id, version: record.version, description: manifest?.description ?? '', runtime: manifest?.runtime.type,
      enabled: record.enabled, trusted: record.trusted, availability: a, isolation: manifest ? expectedIsolation(manifest) : undefined,
      process: proc, source: record.source, health: record.health,
      counts: { tools: k.tools?.length ?? 0, commands: k.commands?.length ?? 0, hooks: k.hooks?.length ?? 0, panels: k.panels?.length ?? 0, providers: k.providers?.length ?? 0 },
    };
  };

  const pluginDetail = (id: string) => {
    const { record, manifest } = helm.requireManifest(id);
    const contrib = helm.contributions();
    const mine = <T extends { pluginId: string }>(xs: T[]) => xs.filter((x) => x.pluginId === id);
    const secretDecl = (manifest.permissions ?? []).find((p) => p.id === 'secrets')?.scope ?? [];
    const stored = new Set(helm.secrets.list(id));
    return {
      ...pluginSummary(id),
      manifest: { publisher: manifest.publisher, license: manifest.license, homepage: manifest.homepage, engines: manifest.engines, runtime: manifest.runtime, activation: manifest.activation, limits: manifest.limits },
      installedAt: record.installedAt, dir: record.dir, previous: record.previous ? { version: record.previous.version } : undefined, limitOverrides: record.limitOverrides,
      permissions: (manifest.permissions ?? []).map((p) => {
        const g = record.grants.find((x) => x.id === p.id);
        const def = permissionDef(p.id);
        return { id: p.id, title: def?.title, requested: p.scope, reason: p.reason, optional: !!p.optional, userExtensible: !!p.userExtensible, granted: g ? { scope: g.scope, mode: g.mode, at: g.grantedAt } : undefined, declined: record.declined.includes(p.id), risk: riskOf(p.id, g?.scope ?? p.scope), description: def ? humanizeScope(def.describe(g?.scope ?? p.scope)) : '', enforcedBy: def?.enforcedBy };
      }),
      secrets: secretDecl.map((n) => ({ name: n, stored: stored.has(n) })),
      config: configFields(manifest, record.config),
      contributions: {
        tools: mine(contrib.tools).map((t) => ({ name: t.tool.name, exposedName: t.exposedName, description: t.tool.description, effect: t.tool.effect, available: t.available, reason: t.reason, inputSchema: t.tool.inputSchema })),
        commands: mine(contrib.commands).map((x) => ({ name: x.command.name, qualified: x.qualified, title: x.command.title, available: x.available, reason: x.reason })),
        hooks: mine(contrib.hooks).map((x) => ({ ...x.hook, available: x.available, reason: x.reason })),
        panels: mine(contrib.panels).map((x) => ({ id: x.panel.id, qualified: x.qualified, title: x.panel.title, available: x.available, reason: x.reason })),
        providers: mine(contrib.providers).map((x) => ({ id: x.provider.id, qualified: x.qualified, title: x.provider.title, defaultModel: x.provider.defaultModel, available: x.available, reason: x.reason })),
      },
      logs: helm.readLog(id, 120).map((l) => redactor.redact(l)),
      audit: helm.audit.query({ plugin: id, limit: 40 }).reverse(),
      lastErrorHint: record.health.lastError ? explain(record.health.lastError.code).hint.replaceAll('<id>', id) : undefined,
    };
  };

  const planView = (planId: string, plan: InstallPlan) => ({
    planId,
    manifest: { id: plan.manifest.id, name: plan.manifest.name, version: plan.manifest.version, description: plan.manifest.description, publisher: plan.manifest.publisher, runtime: plan.manifest.runtime.type, contributes: plan.manifest.contributes },
    isolation: expectedIsolation(plan.manifest), source: plan.source, isUpdate: plan.isUpdate, from: plan.existing?.version,
    consent: plan.isUpdate ? plan.diff : plan.consent, warnings: plan.warnings,
  });

  // ---- routes ----
  const routes: Array<[string, RegExp, Handler]> = [];
  const route = (method: string, pattern: string, h: Handler) => {
    routes.push([method, new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), h]);
  };

  route('GET', '/api/overview', () => {
    let provider: unknown;
    try { const { entry, model } = helm.resolveProvider(); provider = { qualified: entry.qualified, title: entry.provider.title, model }; } catch (e) { provider = { error: toHelmError(e).toJSON() }; }
    const tools = helm.contributions().tools;
    return {
      host: { version: HOST_VERSION, home: helm.paths.home, workspace: helm.workspace, sandbox: sandboxAvailability() },
      provider, config: helm.config(),
      plugins: helm.state.list().map((r) => pluginSummary(r.id)),
      tools: { ready: tools.filter((t) => t.available).length, total: tools.length },
      pendingApprovals: [...pending.entries()].map(([id, p]) => ({ id, ...p.req })),
    };
  });
  route('GET', '/api/plugins/:id', (_r, p) => pluginDetail(p.id!));
  route('GET', '/api/plugins/:id/logs', (_r, p, _b, url) => ({ lines: helm.readLog(p.id!, Number(url.searchParams.get('n') ?? 200)).map((l) => redactor.redact(l)) }));
  for (const action of ['enable', 'disable', 'trust', 'untrust', 'reset'] as const) {
    route('POST', `/api/plugins/:id/${action}`, async (_r, p) => {
      const id = p.id!;
      if (action === 'enable') await helm.enable(id);
      else if (action === 'disable') await helm.disable(id);
      else if (action === 'trust') await helm.setTrusted(id, true);
      else if (action === 'untrust') await helm.setTrusted(id, false);
      else await helm.reset(id);
      changed(id);
      return pluginDetail(id);
    });
  }
  route('POST', '/api/plugins/:id/grant', async (_r, p, b) => { await helm.grant(p.id!, b.permission, { scope: b.scope, mode: b.mode }); changed(p.id); return pluginDetail(p.id!); });
  route('POST', '/api/plugins/:id/revoke', async (_r, p, b) => { await helm.revoke(p.id!, b.permission, { scope: b.scope }); changed(p.id); return pluginDetail(p.id!); });
  route('PUT', '/api/plugins/:id/config', async (_r, p, b) => { await helm.setConfig(p.id!, b.values ?? {}); changed(p.id); return pluginDetail(p.id!); });
  route('PUT', '/api/plugins/:id/limits', async (_r, p, b) => { await helm.setLimit(p.id!, b.key, b.value === null || b.value === '' ? undefined : Number(b.value)); changed(p.id); return pluginDetail(p.id!); });
  route('POST', '/api/plugins/:id/secrets', (_r, p, b) => { helm.setSecret(p.id!, b.name, String(b.value ?? '')); changed(p.id); return pluginDetail(p.id!); });
  route('DELETE', '/api/plugins/:id/secrets/:name', (_r, p) => { helm.secrets.delete(p.id!, p.name!); changed(p.id); return pluginDetail(p.id!); });
  route('POST', '/api/plugins/:id/uninstall', async (_r, p, b) => { await helm.uninstall(p.id!, { purge: !!b.purge }); changed(p.id); return { ok: true }; });
  route('POST', '/api/plugins/:id/rollback', async (_r, p) => { await helm.rollback(p.id!); changed(p.id); return pluginDetail(p.id!); });
  route('POST', '/api/plugins/:id/update/prepare', async (_r, p, b) => {
    const plan = await helm.prepareUpdate(p.id!, b.spec || undefined);
    if (plan.upToDate) { plan.cleanup(); return { upToDate: true, version: plan.manifest.version }; }
    const planId = crypto.randomBytes(6).toString('hex');
    plans.set(planId, { plan, kind: 'update', at: Date.now() });
    return planView(planId, plan);
  });
  route('GET', '/api/registry', (_r, _p, _b, url) => helm.search(url.searchParams.get('q') ?? '').map((e) => ({ ...e, installed: helm.state.get(e.id)?.version })));
  route('POST', '/api/install/prepare', async (_r, _p, b) => {
    const plan = await helm.prepareInstall(String(b.spec ?? ''), { link: !!b.link });
    if (plan.isUpdate) { plan.cleanup(); throw new HelmError(ErrorCode.INSTALL_FAILED, `${plan.manifest.id} is already installed (${plan.existing!.version}); use Update`); }
    const planId = crypto.randomBytes(6).toString('hex');
    plans.set(planId, { plan, kind: 'install', at: Date.now() });
    return planView(planId, plan);
  });
  route('POST', '/api/plans/:planId/commit', async (_r, p, b) => {
    const entry = plans.get(p.planId!);
    if (!entry) throw new HelmError(ErrorCode.INSTALL_FAILED, 'This install request expired; start again');
    plans.delete(p.planId!);
    const res = entry.kind === 'install' ? await helm.commitInstall(entry.plan, b.decisions ?? [], { enable: b.enable !== false }) : await helm.commitUpdate(entry.plan, b.decisions ?? []);
    changed(res.record.id);
    return { plugin: pluginDetail(res.record.id), notes: res.notes };
  });
  route('POST', '/api/plans/:planId/cancel', (_r, p) => { plans.get(p.planId!)?.plan.cleanup(); plans.delete(p.planId!); return { ok: true }; });

  route('GET', '/api/tools', () => helm.contributions().tools.map((t) => ({ name: t.exposedName, plugin: t.pluginId, pluginName: t.pluginName, effect: t.tool.effect, description: t.tool.description, available: t.available, reason: t.reason })));
  route('GET', '/api/commands', () => helm.contributions().commands.map((x) => ({ plugin: x.pluginId, name: x.command.name, qualified: x.qualified, title: x.command.title, args: x.command.args, available: x.available, reason: x.reason })));
  route('POST', '/api/commands/run', async (_r, _p, b) => helm.runCommand(b.plugin, b.command, b.args ?? {}));
  route('GET', '/api/panels', () => helm.contributions().panels.map((x) => ({ plugin: x.pluginId, id: x.panel.id, qualified: x.qualified, title: x.panel.title, available: x.available, reason: x.reason })));
  route('GET', '/api/panels/:plugin/:panel', async (_r, p) => ({ ui: await helm.renderPanel(p.plugin!, p.panel!) }));
  route('GET', '/api/providers', () => helm.providers().map((x) => ({ qualified: x.qualified, plugin: x.pluginId, title: x.provider.title, description: x.provider.description, defaultModel: x.provider.defaultModel, available: x.available, reason: x.reason })));
  route('GET', '/api/models', async (_r, _p, _b, url) => helm.listModels(url.searchParams.get('provider') ?? undefined));
  route('PUT', '/api/settings', (_r, _p, b) => {
    helm.configStore.update((cfg) => {
      if ('provider' in b) cfg.provider = b.provider || undefined;
      if ('model' in b) cfg.model = b.model || undefined;
      if (b.approvals) for (const k of ['read', 'write', 'external', 'exec'] as const) if (['allow', 'ask', 'deny'].includes(b.approvals[k])) cfg.approvals[k] = b.approvals[k];
      if (typeof b.requireStrictIsolation === 'boolean') cfg.security.requireStrictIsolation = b.requireStrictIsolation;
      if (Number.isInteger(b.maxSteps)) cfg.agent.maxSteps = Math.max(1, Math.min(100, b.maxSteps));
    });
    changed();
    return helm.config();
  });
  route('GET', '/api/audit', (_r, _p, _b, url) => helm.audit.query({ plugin: url.searchParams.get('plugin') || undefined, denied: url.searchParams.get('denied') === '1', limit: Number(url.searchParams.get('limit') ?? 200) }).reverse());

  route('POST', '/api/sessions', (_r, _p, b) => {
    const session = new Session(helm, { model: b.model || undefined, provider: b.provider || undefined });
    sessions.set(session.id, { session, events: [], busy: false });
    return { id: session.id };
  });
  route('GET', '/api/sessions/:id', (_r, p) => {
    const s = sessions.get(p.id!);
    if (!s) throw new HelmError(ErrorCode.PLUGIN_NOT_FOUND, 'Session not found (the server restarted?)');
    return { id: p.id, busy: s.busy, events: s.events, model: s.session.model };
  });
  route('POST', '/api/sessions/:id/messages', (_r, p, b) => {
    const s = sessions.get(p.id!);
    if (!s) throw new HelmError(ErrorCode.PLUGIN_NOT_FOUND, 'Session not found');
    if (s.busy) throw new HelmError(ErrorCode.INPUT_INVALID, 'The agent is still working on the previous message');
    if (b.model) s.session.model = b.model;
    const text = String(b.text ?? '').trim();
    if (!text) throw new HelmError(ErrorCode.INPUT_INVALID, 'Empty message');
    s.busy = true;
    s.controller = new AbortController();
    const userEv = { type: 'user', text } as unknown as SessionEvent;
    s.events.push(userEv);
    broadcast('session', { sessionId: p.id, event: userEv });
    s.session.send(text, (event) => { if (event.type !== 'status') s.events.push(event); broadcast('session', { sessionId: p.id, event }); }, s.controller.signal)
      .catch((e) => { const err = toHelmError(e).toJSON(); const ev = { type: 'error', error: err } as SessionEvent; s.events.push(ev); broadcast('session', { sessionId: p.id, event: ev }); })
      .finally(() => { s.busy = false; s.controller = undefined; broadcast('session', { sessionId: p.id, event: { type: 'idle' } }); });
    return { accepted: true };
  });
  route('POST', '/api/sessions/:id/cancel', (_r, p) => { sessions.get(p.id!)?.controller?.abort(); return { ok: true }; });
  route('POST', '/api/approvals/:id', (_r, p, b) => {
    const a = pending.get(p.id!);
    if (!a) throw new HelmError(ErrorCode.INPUT_INVALID, 'This approval is no longer pending');
    clearTimeout(a.timer);
    pending.delete(p.id!);
    const decision: ApprovalDecision = b.decision === 'always' ? 'always' : b.decision === 'allow' ? 'allow' : 'deny';
    a.resolve(decision);
    broadcast('approval.resolved', { id: p.id, decision });
    return { ok: true };
  });

  // ---- server ----
  const port = opts.port ?? 4317;
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const send = (res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
    res.end(data);
  };
  const securityHeaders = {
    'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY',
  };

  const server = http.createServer(async (req, res) => {
    try {
      // DNS-rebinding defence: only answer to our own loopback host names.
      if (!allowedHosts.has(String(req.headers.host))) return send(res, 421, { error: { code: 'FORBIDDEN', message: 'Unexpected Host header' } });
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
      if (!url.pathname.startsWith('/api/')) return serveStatic(url.pathname, res);
      const presented = req.headers['x-helm-token'] ?? url.searchParams.get('token');
      if (!tokenMatches(presented)) return send(res, 401, { error: { code: 'UNAUTHORIZED', message: 'Missing or wrong console token. Open the URL printed by `helm serve`.' } });
      if (req.method !== 'GET' && req.headers.origin && !allowedHosts.has(req.headers.origin.replace(/^https?:\/\//, ''))) return send(res, 403, { error: { code: 'FORBIDDEN', message: 'Cross-origin request refused' } });
      if (url.pathname === '/api/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
        res.write(`event: hello\ndata: {}\n\n`);
        const client = { res };
        clients.add(client);
        const ping = setInterval(() => res.write(': ping\n\n'), 20_000);
        req.on('close', () => { clearInterval(ping); clients.delete(client); });
        return;
      }
      const match = routes.find(([m, re]) => m === req.method && re.test(url.pathname));
      if (!match) return send(res, 404, { error: { code: 'NOT_FOUND', message: `${req.method} ${url.pathname}` } });
      let body: any = {};
      if (req.method !== 'GET') {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const ch of req) { size += (ch as Buffer).length; if (size > 2 * 1024 * 1024) throw new HelmError(ErrorCode.INPUT_INVALID, 'Request body too large'); chunks.push(ch as Buffer); }
        const raw = Buffer.concat(chunks).toString('utf8');
        body = raw ? JSON.parse(raw) : {};
      }
      const params = Object.fromEntries(Object.entries(match[1].exec(url.pathname)!.groups ?? {}).map(([k, v]) => [k, decodeURIComponent(v)]));
      const result = await match[2](req, params, body, url);
      send(res, 200, result ?? { ok: true });
    } catch (e) {
      const err = toHelmError(e);
      send(res, err.code === ErrorCode.INTERNAL ? 500 : 400, { error: err.toJSON() });
    }
  });

  function serveStatic(p: string, res: http.ServerResponse) {
    if (p.startsWith('/vendor/')) {
      const rel = VENDOR[p.slice(8)];
      if (!rel) return send(res, 404, 'not found', { 'content-type': 'text/plain' });
      // Rewrite bare `preact` imports so no import map (inline script) is needed under our CSP.
      const code = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8').replace(/from\s*["']preact["']/g, 'from"/vendor/preact.mjs"');
      res.writeHead(200, { 'content-type': MIME['.mjs']!, 'cache-control': 'max-age=3600', ...securityHeaders });
      return res.end(code);
    }
    const file = path.normalize(path.join(PUBLIC, p === '/' ? 'index.html' : p));
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      const index = path.join(PUBLIC, 'index.html');
      res.writeHead(200, { 'content-type': MIME['.html']!, 'cache-control': 'no-store', ...securityHeaders });
      return res.end(fs.readFileSync(index));
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store', ...securityHeaders });
    res.end(fs.readFileSync(file));
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', (e: NodeJS.ErrnoException) => reject(e.code === 'EADDRINUSE' ? new HelmError(ErrorCode.INPUT_INVALID, `Port ${port} is in use`, { hint: 'Pass --port <n>.' }) : e));
    server.listen(port, '127.0.0.1', () => resolve());
  });
  const url = `http://127.0.0.1:${port}/#token=${token}`;
  if (!opts.quiet) {
    process.stdout.write(`\n  Helm console running at\n  ${url}\n\n  Bound to 127.0.0.1 only; the token in the URL is required for every API call.\n  Press Ctrl+C to stop.\n\n`);
  }
  if (opts.open) spawn('open', [url], { stdio: 'ignore', detached: true }).unref();

  const stop = async () => {
    fs.unwatchFile(helm.paths.state);
    for (const c of clients) c.res.end();
    server.close();
    await helm.shutdown();
  };
  if (!opts.quiet) {
    process.once('SIGINT', () => { void stop().then(() => process.exit(0)); });
    process.once('SIGTERM', () => { void stop().then(() => process.exit(0)); });
  }
  return { url, token, port, helm, stop, server };
}
