// Run with: helm plugin test .
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestContext, callTool, resultText } from '@helm-agent/plugin-sdk/testing';
import plugin from '../src/index.ts';

test('hello greets with the configured word', async () => {
  const ctx = createTestContext({ config: { greeting: 'Ahoy' } });
  assert.equal(resultText(await callTool(plugin, 'hello', { name: 'Ada' }, ctx)), 'Ahoy, Ada!');
});

test('count_lines reads through ctx.fs', async () => {
  const ctx = createTestContext({ files: { 'notes.txt': 'a\nb\nc' } });
  assert.equal(resultText(await callTool(plugin, 'count_lines', { path: 'notes.txt' }, ctx)), 'notes.txt has 3 lines');
});
