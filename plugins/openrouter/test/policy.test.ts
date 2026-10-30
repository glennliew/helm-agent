import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { blockReason, assertAllowed } from '../src/policy.ts';

const manifest = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '../helm-plugin.json'), 'utf8'));
const rules: string[] = manifest.contributes.configuration.properties.blockedModels.default;
const cfg = manifest.contributes.configuration.properties;

test('blocks GPT-6 and newer, including variants and suffixes', () => {
  for (const id of ['openai/gpt-6', 'openai/gpt-6.1-mini', 'openai/gpt-7', 'openai/gpt-6:thinking', 'OpenAI/GPT-6-Pro', 'openai/gpt6']) assert.ok(blockReason(id, rules), id);
});

test('blocks Claude Fable 5 and newer', () => {
  for (const id of ['anthropic/claude-fable-5', 'anthropic/claude-fable-5.1', 'anthropic/claude-fable-6:beta']) assert.ok(blockReason(id, rules), id);
});

test('blocks moving aliases and auto-routers that could resolve to a blocked model', () => {
  assert.ok(blockReason('~anthropic/claude-opus-latest', rules));
  assert.ok(blockReason('openrouter/auto', rules));
});

test('allows everything else, including older OpenAI models and other Claude families', () => {
  for (const id of ['openai/gpt-5.5', 'openai/gpt-4o', 'openai/gpt-oss-120b', 'openai/o3', 'anthropic/claude-opus-5.5', 'anthropic/claude-sonnet-5.5', 'anthropic/claude-fable-4.5', 'google/gemini-4-argon', 'x-ai/grok-5']) {
    assert.equal(blockReason(id, rules), undefined, id);
  }
});

test('shipped defaults (default, fallback and fast models) are themselves allowed', () => {
  const provider = manifest.contributes.providers[0];
  for (const id of [provider.defaultModel, ...cfg.fallbackModels.default, cfg.fastModel.default]) assertAllowed(id, rules);
});

test('assertAllowed explains which rule matched', () => {
  assert.throws(() => assertAllowed('openai/gpt-6', rules), /gpt>=6/);
});
