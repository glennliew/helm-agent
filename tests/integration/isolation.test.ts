import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { ErrorCode } from '../../packages/core/src/errors.ts';
import { makeHelm, install, tool, text, copyFixture, FIXTURES } from '../helpers.ts';
import type { TestHelm } from '../helpers.ts';

let t: TestHelm;
before(async () => {
  t = makeHelm({ files: { 'notes.txt': 'one\ntwo\n' } });
  await install(t.helm, path.join(FIXTURES, 'echo'), { link: true });
  await install(t.helm, 'helm.files');
});
after(() => t.cleanup());

const call = (name: string, input: Record<string, unknown> = {}, opts = {}) => t.helm.invokeTool(tool(t.helm, name), input, opts);

test('a plugin tool runs in its own process and returns content', async () => {
  const r = await call('echo__echo', { text: 'ahoy' });
  assert.equal(text(r), 'echo: ahoy');
  const pid = t.helm.runningProcess('test.echo')!.describe().pid;
  assert.ok(pid && pid !== process.pid);
});

test('input is validated against the tool schema before reaching the plugin', async () => {
  await assert.rejects(call('echo__echo', { text: 42 }), (e: any) => e.code === ErrorCode.INPUT_INVALID);
});

test('a crashing plugin fails its call, leaves other plugins untouched, and restarts on demand', async () => {
  await assert.rejects(call('echo__crash'), (e: any) => e.code === ErrorCode.PLUGIN_CRASHED && /exit|crash/i.test(e.message));
  // Another plugin keeps working while echo is down.
  assert.match(text(await call('files__read_file', { path: 'notes.txt' })), /one/);
  // Echo comes back on the next call (after a short backoff).
  assert.equal(text(await call('echo__echo', { text: 'back' })), 'echo: back');
  const rec = t.helm.state.require('test.echo');
  assert.equal(rec.health.lastError?.code, ErrorCode.PLUGIN_CRASHED);
});

test('a wedged plugin is killed when the call times out, then recovers', async () => {
  await t.helm.reset('test.echo');
  const t0 = Date.now();
  await assert.rejects(call('echo__spin'), (e: any) => e.code === ErrorCode.CALL_TIMEOUT);
  assert.ok(Date.now() - t0 < 8000, 'timeout should honour the manifest limit (3 s)');
  assert.equal(text(await call('echo__echo', { text: 'alive' })), 'echo: alive');
});

test('cancellation reaches the plugin and the call ends promptly', async () => {
  const ac = new AbortController();
  const p = call('echo__slow', { ms: 20_000 }, { signal: ac.signal });
  setTimeout(() => ac.abort(), 300);
  const t0 = Date.now();
  await assert.rejects(p);
  assert.ok(Date.now() - t0 < 3000);
  assert.equal(text(await call('echo__echo', { text: 'still here' })), 'echo: still here');
});

test('garbage on stdout does not corrupt the protocol or crash the host', async () => {
  await t.helm.reset('test.echo');
  const r = await call('echo__noisy').catch((e) => e);
  // Either the call succeeds (garbage was diverted to the log) or fails cleanly as a protocol error.
  if (r instanceof Error) assert.equal((r as any).code, ErrorCode.PROTOCOL_ERROR);
  else assert.equal(text(r), 'done');
  assert.equal(text(await call('echo__echo', { text: 'ok' })), 'echo: ok');
});

test('repeated crashes quarantine the plugin; reset brings it back', async () => {
  await t.helm.reset('test.echo');
  for (let i = 0; i < 3; i++) await call('echo__crash').catch(() => {});
  const a = t.helm.availability('test.echo');
  assert.equal(a.available, false);
  assert.equal(a.code, ErrorCode.PLUGIN_QUARANTINED);
  assert.equal(tool(t.helm, 'echo__echo').available, false);
  await t.helm.reset('test.echo');
  assert.equal(text(await call('echo__echo', { text: 'reset' })), 'echo: reset');
});

test('version-incompatible plugins are refused at install with an explanation', async () => {
  const dir = copyFixture('echo', (m) => { m.id = 'test.future'; m.engines.helm = '>=9.0.0'; });
  await assert.rejects(t.helm.prepareInstall(dir), (e: any) => e.code === ErrorCode.INCOMPATIBLE_VERSION && /9\.0\.0/.test(e.message));
  const proto = copyFixture('echo', (m) => { m.id = 'test.proto2'; m.engines.protocol = '^2.0'; });
  await assert.rejects(t.helm.prepareInstall(proto), (e: any) => e.code === ErrorCode.INCOMPATIBLE_VERSION);
});

test('memory limit kills a runaway plugin without hurting the host', { timeout: 30_000 }, async () => {
  await t.helm.reset('test.echo');
  await assert.rejects(call('echo__hog'), (e: any) => [ErrorCode.PLUGIN_CRASHED, ErrorCode.MEMORY_LIMIT, ErrorCode.CALL_TIMEOUT].includes(e.code));
  await t.helm.reset('test.echo');
  assert.equal(text(await call('echo__echo', { text: 'after hog' })), 'echo: after hog');
});
