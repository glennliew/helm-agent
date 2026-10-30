import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ErrorCode } from '../../packages/core/src/errors.ts';
import { pluginDataDir } from '../../packages/core/src/paths.ts';
import { packPlugin } from '../../packages/cli/src/dev.ts';
import { output } from '../../packages/cli/src/ui.ts';
import { makeHelm, install, tool, text, copyFixture, strictAvailable, tempDir } from '../helpers.ts';
import type { TestHelm } from '../helpers.ts';

let t: TestHelm;
before(() => { t = makeHelm({ files: { 'a.txt': 'alpha\n' } }); });
after(() => t.cleanup());

const quiet = <T>(fn: () => Promise<T>) => { const w = output.write; output.write = () => {}; return fn().finally(() => { output.write = w; }); };

test('declining an optional permission disables only the tools that need it', async () => {
  const { record } = await install(t.helm, 'helm.files', { deny: ['fs.write'] });
  assert.equal(record.enabled, true);
  assert.deepEqual(record.declined, ['fs.write']);
  const write = tool(t.helm, 'files__write_file');
  assert.equal(write.available, false);
  assert.match(write.reason ?? '', /fs\.write/);
  assert.equal(tool(t.helm, 'files__read_file').available, true);
  await assert.rejects(t.helm.invokeTool(write, { path: 'b.txt', content: 'x' }), (e: any) => e.code === ErrorCode.PERMISSION_DENIED);
  assert.equal(fs.existsSync(path.join(t.workspace, 'b.txt')), false);
});

test('revoking a permission takes effect on the very next call, without a restart', async () => {
  const read = () => t.helm.invokeTool(tool(t.helm, 'files__read_file'), { path: 'a.txt' });
  assert.match(text(await read()), /alpha/);
  await t.helm.revoke('helm.files', 'fs.read');
  const a = tool(t.helm, 'files__read_file');
  assert.equal(a.available, false, 'a required permission was revoked, so the plugin is unavailable');
  await assert.rejects(read());
  await t.helm.grant('helm.files', 'fs.read');
  assert.match(text(await read()), /alpha/);
  const audit = t.helm.audit.query({ plugin: 'helm.files' }).map((e) => `${e.kind}:${e.action}`).join('\n');
  assert.match(audit, /revoke/);
});

test('declining a required permission installs the plugin disabled, with an explanation', async () => {
  const dir = copyFixture('echo', (m) => { m.id = 'test.needs-read'; m.permissions = [{ id: 'fs.read', scope: ['${workspace}'], reason: 'read things' }]; });
  const { record, notes } = await install(t.helm, dir, { deny: ['fs.read'] });
  assert.equal(record.enabled, false);
  assert.match(notes.join('\n'), /required.*fs\.read|fs\.read.*required/);
  assert.equal(t.helm.availability('test.needs-read').available, false);
});

test('config is validated against the plugin schema before it is saved', async () => {
  await assert.rejects(t.helm.setConfig('helm.files', { maxFiles: 'lots' }), (e: any) => e.code === ErrorCode.CONFIG_INVALID);
  await t.helm.setConfig('helm.files', { maxFiles: 10 });
  assert.equal(t.helm.state.require('helm.files').config.maxFiles, 10);
});

test('secrets: a plugin reads only the names it declared, scoped to itself', async () => {
  const dir = copyFixture('echo', (m) => { m.id = 'test.secretive'; m.permissions = [{ id: 'secrets', scope: ['MY_TOKEN'], reason: 'auth' }]; });
  await install(t.helm, dir);
  t.helm.setSecret('test.secretive', 'MY_TOKEN', 'tok_1234567890');
  const peek = (name: string) => t.helm.invokeTool(tool(t.helm, 'secretive__peek_secret'), { name }).then(text);
  assert.equal(await peek('MY_TOKEN'), 'got 14 chars');
  assert.match(await peek('OTHER'), /denied/);
  // The echo fixture without the permission cannot read anything.
  await install(t.helm, copyFixture('echo'));
  assert.match(await t.helm.invokeTool(tool(t.helm, 'echo__peek_secret'), { name: 'MY_TOKEN' }).then(text), /denied/);
});

test('update asks only for new permissions, resets trust, and rollback restores the previous grants', async () => {
  const v1 = copyFixture('echo', (m) => { m.id = 'test.versioned'; m.permissions = [{ id: 'fs.read', scope: ['${workspace}'], reason: 'read' }]; });
  await install(t.helm, v1, { trust: true });
  const v2 = copyFixture('echo', (m) => {
    m.id = 'test.versioned'; m.version = '1.1.0';
    m.permissions = [{ id: 'fs.read', scope: ['${workspace}'], reason: 'read' }, { id: 'net.http', scope: ['api.example.com'], reason: 'new sync feature' }];
  });
  const plan = await t.helm.prepareUpdate('test.versioned', v2);
  assert.equal(plan.upToDate, false);
  assert.deepEqual(plan.diff.map((d) => [d.id, d.change]), [['net.http', 'new']]);
  const { record, notes } = await t.helm.commitUpdate(plan, [{ id: 'net.http', granted: true }]);
  assert.equal(record.version, '1.1.0');
  assert.deepEqual(record.grants.map((g) => g.id).sort(), ['fs.read', 'net.http']);
  assert.equal(record.trusted, false);
  assert.match(notes.join('\n'), /Trust was reset/);
  assert.ok(record.previous);
  const back = await t.helm.rollback('test.versioned');
  assert.equal(back.version, '1.0.0');
  assert.deepEqual(back.grants.map((g) => g.id), ['fs.read']);
  if (!strictAvailable()) await t.helm.setTrusted('test.versioned', true);
  assert.equal(text(await t.helm.invokeTool(tool(t.helm, 'versioned__echo'), { text: 'v1' })), 'echo: v1');
});

test('disable and enable change what the agent can use, with reasons', async () => {
  await t.helm.disable('test.versioned');
  const e = tool(t.helm, 'versioned__echo');
  assert.equal(e.available, false);
  assert.equal(e.code, ErrorCode.PLUGIN_DISABLED);
  await t.helm.enable('test.versioned');
  assert.equal(tool(t.helm, 'versioned__echo').available, true);
});

test('pack → install from archive records a checksum; uninstall --purge removes data', async () => {
  const src = copyFixture('echo', (m) => { m.id = 'test.packed'; });
  const out = path.join(tempDir(), 'packed.hplugin.tgz');
  const { sha256 } = await quiet(() => packPlugin(src, { out }));
  const { record } = await install(t.helm, out);
  assert.equal(record.source.type, 'tgz');
  assert.equal(record.source.sha256, sha256);
  assert.ok(record.dir.startsWith(t.helm.paths.plugins));
  const data = pluginDataDir(t.helm.paths, 'test.packed').root;
  assert.ok(fs.existsSync(data));
  await t.helm.uninstall('test.packed', { purge: true });
  assert.equal(t.helm.state.get('test.packed'), undefined);
  assert.equal(fs.existsSync(data), false);
  assert.equal(fs.existsSync(record.dir), false);
});

test('installing something that is not a plugin explains what is wrong', async () => {
  const empty = tempDir();
  await assert.rejects(t.helm.prepareInstall(empty), (e: any) => e.code === ErrorCode.MANIFEST_INVALID && /helm-plugin\.json/.test(e.message));
  await assert.rejects(t.helm.prepareInstall('helm.does-not-exist'), (e: any) => /not found|no plugin|registr/i.test(e.message));
});
