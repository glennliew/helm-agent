// Static proof that capabilities live in plugins, not in the host: the host packages never mention
// a bundled plugin id or tool name, and plugins never import host internals (only the SDK).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO } from '../helpers.ts';

const HOST_DIRS = ['packages/core/src', 'packages/cli/src', 'packages/web/src', 'packages/web/public'];

function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? files(p) : /\.(ts|js|html|css|py)$/.test(e.name) ? [p] : [];
  });
}

const registry = JSON.parse(fs.readFileSync(path.join(REPO, 'registry/index.json'), 'utf8'));
const pluginDirs = fs.readdirSync(path.join(REPO, 'plugins')).map((d) => path.join(REPO, 'plugins', d));
const manifests = pluginDirs.map((d) => JSON.parse(fs.readFileSync(path.join(d, 'helm-plugin.json'), 'utf8')));
const ids: string[] = [...new Set([...registry.plugins.map((p: { id: string }) => p.id), ...manifests.map((m) => m.id)])];
const toolNames: string[] = manifests.flatMap((m) => (m.contributes?.tools ?? []).map((t: { name: string }) => t.name));
const providerIds: string[] = manifests.flatMap((m) => (m.contributes?.providers ?? []).map((p: { id: string }) => `${m.id}/${p.id}`));

test('host code never names a bundled plugin, tool or provider', () => {
  const hits: string[] = [];
  for (const f of HOST_DIRS.flatMap((d) => files(path.join(REPO, d)))) {
    const src = fs.readFileSync(f, 'utf8');
    for (const needle of [...ids, ...providerIds]) if (src.includes(needle)) hits.push(`${path.relative(REPO, f)}: ${needle}`);
    for (const name of toolNames) if (new RegExp(`\\b${name}\\b`).test(src)) hits.push(`${path.relative(REPO, f)}: tool ${name}`);
  }
  assert.deepEqual(hits, [], `host code must stay plugin-agnostic:\n${hits.join('\n')}`);
});

test('host code never imports from a plugin folder', () => {
  for (const f of HOST_DIRS.flatMap((d) => files(path.join(REPO, d)))) {
    assert.doesNotMatch(fs.readFileSync(f, 'utf8'), /from\s+['"][^'"]*\/plugins\//, f);
  }
});

test('plugins talk to the host only through the SDK and the protocol', () => {
  for (const dir of pluginDirs) {
    for (const f of files(dir)) {
      const src = fs.readFileSync(f, 'utf8');
      assert.doesNotMatch(src, /packages\/(core|cli|web)/, `${path.relative(REPO, f)} imports host internals`);
      if (!/\.(ts|js)$/.test(f)) continue; // Python plugins cannot import the (Node) host at all
      for (const m of src.matchAll(/^\s*import[^'"]*['"]([^'"]+)['"]/gm)) {
        const spec = m[1]!;
        const ok = spec.startsWith('node:') || spec.startsWith('.') || spec.startsWith('@helm-agent/plugin-sdk');
        assert.ok(ok, `${path.relative(REPO, f)} imports "${spec}" (only node:*, relative files and the SDK are allowed)`);
      }
    }
  }
});

test('at least two plugins in different languages extend different contribution points', () => {
  const runtimes = new Set(manifests.map((m) => m.runtime.type));
  assert.ok(runtimes.has('node') && runtimes.has('python'));
  const kinds = new Set(manifests.flatMap((m) => Object.keys(m.contributes ?? {}).filter((k) => (m.contributes[k]?.length ?? 1) > 0)));
  for (const k of ['tools', 'hooks', 'commands', 'panels', 'providers', 'configuration']) assert.ok(kinds.has(k), `no bundled plugin contributes ${k}`);
});
