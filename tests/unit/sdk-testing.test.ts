// The in-process SDK harness that plugin authors use, exercised against the real bundled plugins.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createTestContext, callTool, callHook, resultText, configDefaults } from '../../packages/sdk-node/src/testing.ts';
import guard from '../../plugins/guard/src/index.ts';
import files from '../../plugins/files/src/index.ts';

const manifest = (p: string) => JSON.parse(fs.readFileSync(new URL(`../../plugins/${p}/helm-plugin.json`, import.meta.url), 'utf8'));
const before = (input: Record<string, unknown>) => ({ tool: 'read_file', plugin: 'helm.files', exposedName: 'files__read_file', effect: 'read', input });

test('callHook: Guard blocks credential files and lets ordinary files through', async () => {
  const ctx = createTestContext({ config: configDefaults(manifest('guard')) });
  const blocked = await callHook(guard, 'tool.before', before({ path: '.env' }), ctx);
  assert.equal(blocked.action, 'block');
  assert.match((blocked as { reason: string }).reason, /credential/i);
  assert.equal((await callHook(guard, 'tool.before', before({ path: 'README.md' }), ctx)).action, 'continue');
});

test('createTestContext enforces grants when given, like the broker', async () => {
  const cfg = configDefaults(manifest('files'));
  const ctx = createTestContext({ config: cfg, files: { 'a.txt': 'hello' }, grants: [{ id: 'fs.read', scope: ['${workspace}'] }] });
  assert.match(resultText(await callTool(files, 'read_file', { path: 'a.txt' }, ctx)), /hello/);
  await assert.rejects(callTool(files, 'read_file', { path: '/etc/hosts' }, ctx), /needs fs\.read/);
  await assert.rejects(callTool(files, 'write_file', { path: 'b.txt', content: 'x' }, ctx), /needs fs\.write/);
  const open = createTestContext({ config: cfg, files: {} });
  await callTool(files, 'write_file', { path: 'b.txt', content: 'x' }, open);
  assert.equal(open.files.get('b.txt'), 'x', 'without grants the fake host is permissive');
});
