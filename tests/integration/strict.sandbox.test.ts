// Strict isolation: these run only where the macOS sandbox can be applied (a normal terminal, not an
// IDE/agent sandbox). Plugins are NOT trusted here, so they get the full profile.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { makeHelm, install, tool, text, FIXTURES, strictAvailable } from '../helpers.ts';
import type { TestHelm } from '../helpers.ts';

const skip = !strictAvailable() && 'macOS sandbox unavailable here (run `npm run test:sandbox` from a normal terminal)';
let t: TestHelm;
before(async () => {
  if (skip) return;
  t = makeHelm({ files: { 'inside.txt': 'inside' } });
  await install(t.helm, path.join(FIXTURES, 'echo'), { link: true, trust: false });
});
after(async () => { if (!skip) await t.cleanup(); });

const call = async (name: string, input: Record<string, unknown> = {}) => text(await t.helm.invokeTool(tool(t.helm, name), input));

test('untrusted plugins start with strict isolation', { skip }, async () => {
  await call('echo__echo', { text: 'x' });
  const d = t.helm.runningProcess('test.echo')!.describe();
  assert.equal(d.isolation, 'strict');
  assert.ok(d.layers.includes('macos-sandbox'));
});

test('direct file reads outside the grant are blocked by the OS, not just the SDK', { skip }, async () => {
  const secret = path.join(os.homedir(), '.helm-sandbox-probe');
  fs.writeFileSync(secret, 'top secret');
  try {
    assert.match(await call('echo__read_home', { path: secret }), /blocked: (EPERM|EACCES|ERR_ACCESS_DENIED)/);
    assert.match(await call('echo__read_home', { path: '/etc/master.passwd' }), /blocked/);
  } finally { fs.rmSync(secret, { force: true }); }
});

test('direct network access is blocked (only the host broker may make requests)', { skip }, async () => {
  assert.match(await call('echo__direct_net'), /blocked/);
});

test('spawning processes directly is blocked', { skip }, async () => {
  assert.match(await call('echo__spawn'), /blocked/);
});

test('the plugin environment is scrubbed of host secrets', { skip }, async () => {
  const names: string[] = JSON.parse(await call('echo__env'));
  for (const n of names) assert.doesNotMatch(n, /KEY|TOKEN|SECRET|PASSWORD|AWS_|OPENROUTER|GITHUB/i, n);
  assert.ok(names.length < 15, `unexpectedly large environment: ${names.join(', ')}`);
});

test('a strict plugin refuses to start when the sandbox is required but unavailable', { skip: !skip && 'sandbox is available here; covered by the CLI in agent terminals' }, async () => {
  const x = makeHelm();
  try {
    await install(x.helm, path.join(FIXTURES, 'echo'), { link: true, trust: false });
    await assert.rejects(x.helm.invokeTool(tool(x.helm, 'echo__echo'), { text: 'x' }), /sandbox|ISOLATION/i);
    assert.equal(x.helm.availability('test.echo').code, 'ISOLATION_UNAVAILABLE');
  } finally { await x.cleanup(); }
});
