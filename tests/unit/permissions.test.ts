import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { checkPath, hostMatches, isPrivateAddress, riskOf } from '../../packages/core/src/permissions/catalog.ts';
import { buildGrants, permissionDiff } from '../../packages/core/src/permissions/grants.ts';
import { checkUrl } from '../../packages/core/src/host-api/net.ts';
import { redactor } from '../../packages/core/src/permissions/secrets.ts';
import type { Manifest, PluginRecord } from '../../packages/core/src/types.ts';
import { tempDir } from '../helpers.ts';

const root = tempDir();
const ws = path.join(root, 'ws');
const outside = path.join(root, 'outside');
fs.mkdirSync(path.join(ws, 'src'), { recursive: true });
fs.mkdirSync(outside);
fs.mkdirSync(path.join(root, 'ws-evil'));
fs.writeFileSync(path.join(outside, 'secret.txt'), 'x');
fs.symlinkSync(outside, path.join(ws, 'link-out'));
const ctx = { workspace: ws, pluginData: path.join(root, 'data') };

test('paths inside the granted root are allowed', () => {
  assert.ok(checkPath('src/a.ts', ['${workspace}'], ctx).ok);
  assert.ok(checkPath(path.join(ws, 'new-file.txt'), ['${workspace}'], ctx).ok);
});

test('traversal, absolute escapes, sibling-prefix tricks and symlink escapes are refused', () => {
  assert.equal(checkPath('../outside/secret.txt', ['${workspace}'], ctx).ok, false);
  assert.equal(checkPath('/etc/hosts', ['${workspace}'], ctx).ok, false);
  assert.equal(checkPath(path.join(root, 'ws-evil', 'x'), ['${workspace}'], ctx).ok, false);
  const viaLink = checkPath('link-out/secret.txt', ['${workspace}'], ctx);
  assert.equal(viaLink.ok, false, `symlink resolved to ${viaLink.resolved}`);
  assert.equal(checkPath('link-out/not-yet-created.txt', ['${workspace}'], ctx).ok, false);
});

test('host patterns match exactly or by subdomain wildcard, never by suffix', () => {
  assert.ok(hostMatches('openrouter.ai', ['openrouter.ai']));
  assert.ok(hostMatches('en.wikipedia.org', ['*.wikipedia.org']));
  assert.equal(hostMatches('evilwikipedia.org', ['*.wikipedia.org']), false);
  assert.equal(hostMatches('openrouter.ai.evil.com', ['openrouter.ai']), false);
  assert.ok(hostMatches('anything.example', ['*']));
});

test('private and loopback addresses are recognised (SSRF guard)', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.9', '192.168.1.1', '169.254.169.254', '0.0.0.0', '::1', 'fd12::1', 'fe80::1', '::ffff:127.0.0.1', '100.64.0.1']) assert.ok(isPrivateAddress(ip), ip);
  for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700::1111']) assert.equal(isPrivateAddress(ip), false, ip);
});

test('checkUrl enforces scheme, host grant and local-address rules', () => {
  const policy = { hosts: ['*'], allowLocal: false };
  assert.throws(() => checkUrl('file:///etc/passwd', policy), /http/);
  assert.throws(() => checkUrl('http://127.0.0.1:8080/', policy), /local|private/);
  assert.throws(() => checkUrl('http://localhost/', policy), /local|private/);
  assert.throws(() => checkUrl('http://[::1]/', policy), /local|private/);
  assert.throws(() => checkUrl('https://api.example.com/', { hosts: ['openrouter.ai'], allowLocal: false }), /does not allow/);
  assert.equal(checkUrl('https://openrouter.ai/api/v1', { hosts: ['openrouter.ai'], allowLocal: false }).hostname, 'openrouter.ai');
});

const manifest = (perms: Manifest['permissions']): Manifest => ({
  manifestVersion: 1, id: 'test.p', name: 'P', version: '1.0.0', description: 'p', engines: { helm: '>=0.1.0', protocol: '^1.0' },
  runtime: { type: 'node', entry: 'index.ts' }, permissions: perms, contributes: {},
} as Manifest);

test('users may narrow a declared scope but not widen it (unless userExtensible)', () => {
  const m = manifest([
    { id: 'net.http', scope: ['*'], reason: 'r' },
    { id: 'fs.read', scope: ['${workspace}'], reason: 'r' },
  ]);
  const ok = buildGrants(m, [{ id: 'net.http', granted: true, scope: ['*.wikipedia.org'] }, { id: 'fs.read', granted: true, scope: ['${workspace}/docs'] }], '1.0.0');
  assert.deepEqual(ok.errors, []);
  const bad = buildGrants(m, [{ id: 'net.http', granted: true }, { id: 'fs.read', granted: true, scope: ['/etc'] }], '1.0.0');
  assert.match(bad.errors.join(), /outside what/);
  assert.equal(bad.grants.find((g) => g.id === 'fs.read')!.scope!.length, 0);
});

test('declining a required permission is reported; optional ones are just declined', () => {
  const m = manifest([{ id: 'fs.read', scope: ['${workspace}'], reason: 'r' }, { id: 'fs.write', scope: ['${workspace}'], reason: 'r', optional: true }]);
  const r = buildGrants(m, [{ id: 'fs.read', granted: false }, { id: 'fs.write', granted: false }], '1.0.0');
  assert.equal(r.errors.length, 1);
  assert.deepEqual(r.declined.sort(), ['fs.read', 'fs.write']);
});

test('updates only ask about new or wider permissions', () => {
  const current = { grants: [{ id: 'net.http', scope: ['openrouter.ai'], mode: 'allow', grantedAt: '', version: '1.0.0' }], declined: ['secrets'] } as unknown as PluginRecord;
  const next = manifest([
    { id: 'net.http', scope: ['openrouter.ai', 'api.example.com'], reason: 'r' },
    { id: 'secrets', scope: ['API_KEY'], reason: 'r', optional: true },
    { id: 'fs.read', scope: ['${workspace}'], reason: 'r' },
  ]);
  const diff = permissionDiff(next, current);
  assert.deepEqual(diff.map((d) => [d.id, d.change]), [['net.http', 'wider'], ['fs.read', 'new']]);
  assert.deepEqual(diff[0]!.addedScope, ['api.example.com']);
});

test('risk levels reflect scope breadth', () => {
  assert.equal(riskOf('net.http', ['*']), 'high');
  assert.notEqual(riskOf('net.http', ['openrouter.ai']), 'high');
  assert.equal(riskOf('process.exec', ['*']), 'high');
});

test('registered secret values are redacted everywhere', () => {
  redactor.add('sk-test-1234567890', 'helm.openrouter/API_KEY');
  assert.equal(redactor.redact('key=sk-test-1234567890!'), 'key=[secret:helm.openrouter/API_KEY]!');
  assert.deepEqual(redactor.redactDeep({ a: ['sk-test-1234567890'] }), { a: ['[secret:helm.openrouter/API_KEY]'] });
});
