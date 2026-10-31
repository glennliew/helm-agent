// End to end through the real CLI binary: a fresh Helm home, the bundled registry and the offline
// mock provider. Every step is what a user would type.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { tempDir, strictAvailable, REPO } from '../helpers.ts';

const FAKE_KEY = 'sk-or-v1-' + 'c'.repeat(48);
let root: string;
let ws: string;
const helm = (...args: string[]) => {
  const r = spawnSync(path.join(REPO, 'bin/helm'), args, {
    cwd: ws, encoding: 'utf8', timeout: 60_000,
    env: { ...process.env, HELM_AGENT_HOME: path.join(root, 'home'), NO_COLOR: '1', FORCE_COLOR: '0' },
  });
  return { code: r.status, out: r.stdout, err: r.stderr, all: r.stdout + r.stderr };
};
const json = (...args: string[]) => {
  const r = helm(...args, '--json');
  assert.equal(r.code, 0, r.all);
  return JSON.parse(r.out);
};

before(() => {
  root = tempDir('helm-e2e-');
  ws = path.join(root, 'ws');
  fs.mkdirSync(ws);
  fs.writeFileSync(path.join(ws, 'a.txt'), 'hello from a\n');
  fs.writeFileSync(path.join(ws, '.env'), `OPENROUTER_API_KEY=${FAKE_KEY}\n`);
});
after(() => fs.rmSync(root, { recursive: true, force: true }));

test('helm init installs the registry starter set with consent and explains the next step', () => {
  const r = helm('init', '--yes', '--secrets', 'file');
  assert.equal(r.code, 0, r.all);
  for (const id of ['helm.files', 'helm.git', 'helm.web', 'helm.guard', 'helm.openrouter', 'helm.mock-model']) assert.match(r.out, new RegExp(`installed ${id.replace('.', '\\.')}@`));
  assert.match(r.out, /helm secrets set helm\.openrouter API_KEY/);
  if (!strictAvailable()) {
    // Restricted terminal: the OS sandbox cannot be applied, so untrusted plugins refuse to run.
    const before = helm('run', 'call files__read_file {"path":"a.txt"}', '-p', 'helm.mock-model/mock');
    assert.notEqual(before.code, 0);
    assert.match(before.all, /sandbox|trust/i);
    for (const id of ['helm.files', 'helm.guard', 'helm.mock-model']) assert.equal(helm('plugin', 'trust', id).code, 0);
  }
  assert.equal(helm('provider', 'use', 'helm.mock-model/mock').code, 0);
});

test('plugin list and info describe what is installed', () => {
  const list = json('plugin', 'list');
  assert.equal(list.length, 7); // the seven bundled starter plugins
  const files = list.find((p: any) => p.id === 'helm.files');
  assert.ok(files.status.available, JSON.stringify(files.status));
  const info = helm('plugin', 'info', 'helm.files');
  assert.match(info.out, /fs\.read/);
  assert.match(info.out, /read_file/);
});

test('helm run uses plugin tools, Guard blocks secrets, and audit shows the decisions', () => {
  const ok = helm('run', 'call files__read_file {"path":"a.txt"}');
  assert.equal(ok.code, 0, ok.all);
  assert.match(ok.out, /hello from a/);
  const blocked = helm('run', 'call files__read_file {"path":".env"}');
  assert.match(blocked.all, /blocked|helm\.guard/i);
  assert.ok(!blocked.all.includes(FAKE_KEY), 'the secret must never be printed');
  const audit = json('audit', '-n', '200');
  assert.ok(audit.some((e: any) => e.plugin === 'helm.files' && e.permission === 'fs.read' && e.decision === 'allowed'), 'broker reads are audited');
  assert.ok(audit.some((e: any) => e.kind === 'hook' && e.decision === 'denied' && /helm\.guard/.test(JSON.stringify(e))), 'the Guard block is audited');
});

test('revoking a permission hides the tool with a reason; granting brings it back', () => {
  assert.equal(helm('plugin', 'revoke', 'helm.files', 'fs.write').code, 0);
  let w = json('tools').find((t: any) => t.name === 'files__write_file');
  assert.equal(w.available, false);
  assert.match(w.reason, /fs\.write/);
  const g = helm('plugin', 'grant', 'helm.files', 'fs.write');
  assert.equal(g.code, 0, g.all);
  w = json('tools').find((t: any) => t.name === 'files__write_file');
  assert.equal(w.available, true);
});

test('doctor reports runtimes, isolation and every plugin', () => {
  const d = json('doctor');
  const checks = Array.isArray(d) ? d : d.checks;
  for (const c of ['node', 'python', 'sandbox', 'provider']) assert.ok(checks.some((x: any) => x.check === c), `missing ${c}`);
  assert.ok(checks.some((x: any) => String(x.check).includes('helm.files')));
});

test('errors explain what happened and what to do', () => {
  const r = helm('plugin', 'info', 'helm.nope');
  assert.notEqual(r.code, 0);
  assert.match(r.err, /not installed/i);
  assert.match(r.err, /helm plugin (search|install|list)/);
});
