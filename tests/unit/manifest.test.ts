import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { readManifest, validateManifest, compatibilityProblem } from '../../packages/core/src/manifest/manifest.ts';
import { REPO, FIXTURES } from '../helpers.ts';

const base = () => JSON.parse(fs.readFileSync(path.join(FIXTURES, 'echo/helm-plugin.json'), 'utf8'));

test('every bundled plugin and fixture manifest is valid', () => {
  const dirs = [...fs.readdirSync(path.join(REPO, 'plugins')).map((d) => path.join(REPO, 'plugins', d)), ...fs.readdirSync(FIXTURES).map((d) => path.join(FIXTURES, d))];
  for (const dir of dirs) {
    const { manifest, problems } = readManifest(dir);
    assert.ok(manifest, `${dir}: ${JSON.stringify(problems)}`);
    assert.equal(compatibilityProblem(manifest!), undefined, dir);
  }
});

test('reports schema and semantic problems together, with JSON paths', () => {
  const m = base();
  m.version = 'one';
  m.contributes.tools[0].effect = 'reed';
  const { manifest, problems } = validateManifest(m);
  assert.equal(manifest, undefined);
  const paths = problems.map((p) => p.path);
  assert.ok(paths.includes('/version'), JSON.stringify(problems));
  assert.ok(paths.includes('/contributes/tools/0/effect'), JSON.stringify(problems));
});

test('unknown permissions and undeclared intercept permission are rejected', () => {
  const m = base();
  m.permissions = [{ id: 'fs.everything', reason: 'x' }];
  m.contributes.hooks = [{ event: 'tool.before', mode: 'intercept' }];
  const { problems } = validateManifest(m);
  const msgs = problems.map((p) => p.message).join('\n');
  assert.match(msgs, /fs\.everything/);
  assert.match(msgs, /tool\.intercept/);
});

test('duplicate tool names and bad ids are caught', () => {
  const m = base();
  m.id = 'Not Valid';
  m.contributes.tools.push({ ...m.contributes.tools[0] });
  const { problems } = validateManifest(m);
  assert.ok(problems.some((p) => p.path === '/id'), JSON.stringify(problems));
  assert.ok(problems.some((p) => /duplicate|twice|more than once/i.test(p.message)), JSON.stringify(problems));
});

test('version compatibility: host range and protocol major', () => {
  const m = base();
  m.engines.helm = '>=2.0.0';
  assert.match(compatibilityProblem(m) ?? '', /2\.0\.0|Helm/);
  const p = base();
  p.engines.protocol = '^2.0';
  assert.match(compatibilityProblem(p) ?? '', /protocol/i);
});

test('missing manifest gives a helpful hint', () => {
  const { manifest, problems } = readManifest(path.join(REPO, 'docs-does-not-exist'));
  assert.equal(manifest, undefined);
  assert.match(problems[0]!.hint ?? '', /helm plugin new/);
});

test('the published JSON Schema (docs/schemas) matches the schema the host validates with', async () => {
  const { publishedSchema, SCHEMA_FILE } = await import('../../scripts/gen-schema.ts');
  const fsm = await import('node:fs');
  assert.deepEqual(JSON.parse(fsm.readFileSync(SCHEMA_FILE, 'utf8')), JSON.parse(JSON.stringify(publishedSchema())), 'run: node scripts/gen-schema.ts');
});
