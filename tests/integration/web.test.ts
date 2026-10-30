import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { startServer } from '../../packages/web/src/server.ts';
import { makeHelm } from '../helpers.ts';
import type { TestHelm } from '../helpers.ts';

const TOKEN = 'a'.repeat(48);
const port = 41000 + Math.floor(Math.random() * 8000);
let t: TestHelm;
let srv: Awaited<ReturnType<typeof startServer>>;

before(async () => {
  t = makeHelm(); // initialises the home with the file secret backend
  srv = await startServer({ home: path.join(t.root, 'home'), workspace: t.workspace, port, token: TOKEN, quiet: true });
});
after(async () => { await srv.stop(); await t.cleanup(); });

function req(p: string, opts: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: p, method: opts.method ?? 'GET', headers: { host: `127.0.0.1:${port}`, ...opts.headers } }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode!, body }));
    });
    r.on('error', reject);
    r.end(opts.body);
  });
}

test('binds to loopback and serves the console shell', async () => {
  const r = await req('/');
  assert.equal(r.status, 200);
  assert.match(r.body, /Helm/);
  assert.ok(srv.url.startsWith(`http://127.0.0.1:${port}/`));
});

test('API calls need the console token', async () => {
  assert.equal((await req('/api/overview')).status, 401);
  assert.equal((await req('/api/overview', { headers: { 'x-helm-token': 'b'.repeat(48) } })).status, 401);
  assert.equal((await req('/api/overview', { headers: { 'x-helm-token': 'short' } })).status, 401);
  const ok = await req('/api/overview', { headers: { 'x-helm-token': TOKEN } });
  assert.equal(ok.status, 200);
  assert.ok(JSON.parse(ok.body));
});

test('a foreign Host header is refused (DNS-rebinding protection)', async () => {
  const r = await req('/api/overview', { headers: { host: 'evil.example:80', 'x-helm-token': TOKEN } });
  assert.equal(r.status, 421);
});

test('state-changing requests from another origin are refused', async () => {
  const r = await req('/api/plugins/helm.files/disable', { method: 'POST', headers: { 'x-helm-token': TOKEN, origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{}' });
  assert.equal(r.status, 403);
});
