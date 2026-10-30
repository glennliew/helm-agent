import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { newPlugin, testPlugin } from '../../packages/cli/src/dev.ts';
import { output } from '../../packages/cli/src/ui.ts';
import { makeHelm, install, tool, text, fakeTransport, tempDir, REPO } from '../helpers.ts';
import type { TestHelm } from '../helpers.ts';

const cleanups: Array<() => Promise<void> | void> = [];
after(async () => { for (const c of cleanups) await c(); });
const silently = <T>(fn: () => T): T => { const w = output.write; output.write = () => {}; try { return fn(); } finally { output.write = w; } };

// ---------------------------------------------------------------- developer loop: scaffold → test
for (const lang of ['typescript', 'python'] as const) {
  test(`a freshly scaffolded ${lang} plugin passes its own tests (helm plugin new → helm plugin test)`, () => {
    const dir = path.join(tempDir('helm-new-'), `word-tools-${lang}`);
    cleanups.push(() => fs.rmSync(path.dirname(dir), { recursive: true, force: true }));
    silently(() => newPlugin(`word-tools-${lang}`, { lang, dir }));
    assert.equal(testPlugin(dir, { stdio: 'pipe' }), 0);
  });
}

test('the Python Web plugin unit tests pass', () => {
  assert.equal(testPlugin(path.join(REPO, 'plugins/web'), { stdio: 'pipe' }), 0);
});

// ---------------------------------------------------------------- Web (Python) through the real broker
test('Web (Python plugin): searches through the host broker; private addresses are refused', async () => {
  const fake = fakeTransport([
    ['wikipedia.org/w/api.php', () => ({ body: { query: { search: [{ title: 'Helm (watercraft)', snippet: 'a <b>steering</b> device' }] } } })],
  ]);
  const t = makeHelm({ netTransport: fake.transport });
  cleanups.push(() => t.cleanup());
  await install(t.helm, 'helm.web');
  const out = text(await t.helm.invokeTool(tool(t.helm, 'web__web_search'), { query: 'ship helm' }));
  assert.match(out, /Helm \(watercraft\)/);
  assert.equal(fake.requests.length, 1);
  assert.match(fake.requests[0]!.url, /^https:\/\/en\.wikipedia\.org\//);
  await assert.rejects(t.helm.invokeTool(tool(t.helm, 'web__fetch_url'), { url: 'http://127.0.0.1:9/admin' }), /private|loopback|local/i);
  assert.equal(fake.requests.length, 1, 'the refused request never reached the network');
  const denied = t.helm.audit.query({ plugin: 'helm.web', denied: true });
  assert.ok(denied.length >= 1);
});

// ---------------------------------------------------------------- Git through a sandboxed process.exec
function gitRepo(t: TestHelm) {
  const g = (...a: string[]) => spawnSync('git', a, { cwd: t.workspace, encoding: 'utf8' });
  g('init', '-q', '-b', 'main');
  g('config', 'user.name', 'Helm Test');
  g('config', 'user.email', 'test@example.com');
  fs.writeFileSync(path.join(t.workspace, 'a.txt'), 'one\n');
  g('add', '-A');
  g('commit', '-q', '-m', 'first');
  return g;
}

test('Git plugin: status, diff and commit run git inside the workspace only', async () => {
  const t = makeHelm();
  cleanups.push(() => t.cleanup());
  const g = gitRepo(t);
  await install(t.helm, 'helm.git');
  fs.writeFileSync(path.join(t.workspace, 'a.txt'), 'one\ntwo\n');
  assert.match(text(await t.helm.invokeTool(tool(t.helm, 'git__git_status'), {})), /a\.txt/);
  assert.match(text(await t.helm.invokeTool(tool(t.helm, 'git__git_diff'), {})), /\+two/);
  const commit = text(await t.helm.invokeTool(tool(t.helm, 'git__git_commit'), { message: 'add two', all: true }));
  assert.match(commit, /add two|committed/i);
  assert.match(g('log', '--oneline', '-1').stdout, /add two/);
  const execs = t.helm.audit.query({ plugin: 'helm.git' }).filter((e) => e.permission === 'process.exec');
  assert.ok(execs.length >= 3, 'every git invocation goes through the broker and is audited');
});

test('Git plugin without the optional fs.write grant can read history but cannot commit', async () => {
  const t = makeHelm();
  cleanups.push(() => t.cleanup());
  gitRepo(t);
  await install(t.helm, 'helm.git', { deny: ['fs.write'] });
  assert.match(text(await t.helm.invokeTool(tool(t.helm, 'git__git_log'), {})), /first/);
  const commitTool = t.helm.contributions().tools.find((x) => x.exposedName === 'git__git_commit')!;
  assert.equal(commitTool.available, false);
  assert.match(commitTool.reason ?? '', /fs\.write/);
});
