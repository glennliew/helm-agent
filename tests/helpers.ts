import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Helm } from '../packages/core/src/helm.ts';
import type { HelmOptions } from '../packages/core/src/helm.ts';
import { sandboxAvailability } from '../packages/core/src/runtime/launch.ts';
import type { NetTransport } from '../packages/core/src/host-api/net.ts';
import type { Session, SessionEvent } from '../packages/core/src/agent/session.ts';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const FIXTURES = path.join(REPO, 'tests/fixtures/plugins');
export const strictAvailable = () => sandboxAvailability().available;

export function tempDir(prefix = 'helm-test-') {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

export interface TestHelm {
  helm: Helm;
  root: string;
  workspace: string;
  cleanup(): Promise<void>;
}

/** A Helm with its own temporary home and workspace. Secrets use the file backend (no Keychain prompts). */
export function makeHelm(opts: Partial<HelmOptions> & { files?: Record<string, string> } = {}): TestHelm {
  const root = tempDir();
  const workspace = path.join(root, 'ws');
  fs.mkdirSync(workspace);
  for (const [f, content] of Object.entries(opts.files ?? {})) {
    fs.mkdirSync(path.dirname(path.join(workspace, f)), { recursive: true });
    fs.writeFileSync(path.join(workspace, f), content);
  }
  const { files: _f, ...rest } = opts;
  const helm = Helm.open({ home: path.join(root, 'home'), workspace, configOverrides: { secrets: { backend: 'file' } }, ...rest });
  return {
    helm, root, workspace,
    async cleanup() {
      await helm.shutdown();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

/**
 * Install a plugin granting what it asks for (minus `deny`). When the macOS sandbox is unavailable
 * (CI, IDE terminals) the plugin is explicitly trusted so the suite still exercises real processes
 * with runtime isolation; `npm run test:sandbox` covers strict isolation.
 */
export async function install(helm: Helm, spec: string, opts: { link?: boolean; deny?: string[]; trust?: boolean; scope?: Record<string, string[]> } = {}) {
  const plan = await helm.prepareInstall(spec, { link: opts.link });
  const decisions = plan.consent.map((c) => ({ id: c.id, granted: !(opts.deny ?? []).includes(c.id), scope: opts.scope?.[c.id] ?? c.scope }));
  const res = await helm.commitInstall(plan, decisions);
  if (opts.trust ?? !strictAvailable()) await helm.setTrusted(res.record.id, true);
  return res;
}

/** Copy a fixture to a temp dir, optionally rewriting its manifest, so tests can mutate it. */
export function copyFixture(name: string, edit?: (m: any) => void): string {
  const dest = path.join(tempDir('helm-fixture-'), name);
  fs.cpSync(path.join(FIXTURES, name), dest, { recursive: true });
  if (edit) {
    const file = path.join(dest, 'helm-plugin.json');
    const m = JSON.parse(fs.readFileSync(file, 'utf8'));
    edit(m);
    fs.writeFileSync(file, JSON.stringify(m, null, 2));
  }
  return dest;
}

export function tool(helm: Helm, name: string) {
  const t = helm.contributions().tools.find((x) => x.exposedName === name || x.tool.name === name);
  if (!t) throw new Error(`no tool ${name}; have ${helm.contributions().tools.map((x) => x.exposedName).join(', ')}`);
  return t;
}

export const text = (r: { content: Array<{ type: string; text?: string; data?: unknown }> }) =>
  r.content.map((b) => (b.type === 'json' ? JSON.stringify(b.data) : b.text)).join('\n');

export async function run(session: Session, prompt: string) {
  const events: SessionEvent[] = [];
  const reply = await session.send(prompt, (e) => events.push(e));
  return { reply, events, ends: events.filter((e): e is Extract<SessionEvent, { type: 'tool.end' }> => e.type === 'tool.end') };
}

/** Fake HTTP for provider/web plugins: route by URL substring, record requests. */
export function fakeTransport(routes: Array<[string, (req: { url: string; method: string; headers?: Record<string, string>; body?: string }) => { status?: number; body: unknown }]>) {
  const requests: Array<{ url: string; method: string; headers?: Record<string, string>; body?: string }> = [];
  const transport: NetTransport = async (req) => {
    requests.push(req);
    const route = routes.find(([m]) => req.url.includes(m));
    if (!route) return { status: 404, headers: { 'content-type': 'application/json' }, body: '{"error":{"message":"no fake route"}}', encoding: 'utf8' };
    const r = route[1](req);
    return { status: r.status ?? 200, headers: { 'content-type': 'application/json' }, body: typeof r.body === 'string' ? r.body : JSON.stringify(r.body), encoding: 'utf8' };
  };
  return { transport, requests };
}
