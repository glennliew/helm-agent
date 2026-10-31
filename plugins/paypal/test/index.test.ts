// Run with: helm plugin test plugins/paypal   (or npm test)
// A fake PayPal sandbox stands in for api-m.sandbox.paypal.com, so these tests run offline.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createTestContext, callTool, runCommand, renderPanel, resultText, configDefaults } from '@helm-agent/plugin-sdk/testing';
import plugin, { money, explain } from '../src/index.ts';

const manifest = JSON.parse(readFileSync(new URL('../helm-plugin.json', import.meta.url), 'utf8'));
const API = 'https://api-m.sandbox.paypal.com';
const grants = [{ id: 'net.http', scope: ['api-m.sandbox.paypal.com'] }, { id: 'secrets', scope: ['CLIENT_ID', 'CLIENT_SECRET'] }];
const secrets = { CLIENT_ID: 'sb-client-id-123456', CLIENT_SECRET: 'sb-secret' };

type Call = { method: string; path: string; body: any; headers: Record<string, string> };

/** Minimal in-memory PayPal sandbox. */
function fakePayPal(opts: { tokenStatus?: number; expireFirstToken?: boolean } = {}) {
  const calls: Call[] = [];
  const invoices = new Map<string, any>();
  const orders = new Map<string, any>();
  let tokens = 0;
  const r = (status: number, data?: unknown) => ({ status, ok: status < 400, body: data === undefined ? '' : JSON.stringify(data) });
  const fetch = (url: string, o: { method?: string; headers?: Record<string, string>; body?: string }) => {
    const u = new URL(url);
    const method = o.method ?? 'GET';
    const body = o.body && o.headers?.['content-type'] === 'application/json' ? JSON.parse(o.body) : o.body;
    calls.push({ method, path: u.pathname + u.search, body, headers: o.headers ?? {} });
    if (u.pathname === '/v1/oauth2/token') {
      if (opts.tokenStatus) return r(opts.tokenStatus, { error: 'invalid_client' });
      tokens++;
      return r(200, { access_token: `A21AA-token-${tokens}`, expires_in: 32400 });
    }
    if (opts.expireFirstToken && o.headers?.authorization === 'Bearer A21AA-token-1') return r(401, { name: 'AUTHENTICATION_FAILURE' });
    let m: RegExpMatchArray | null;
    if (method === 'POST' && u.pathname === '/v2/invoicing/invoices') {
      const id = `INV2-${invoices.size + 1}`;
      const total = body.items.reduce((s: number, i: any) => s + Number(i.unit_amount.value) * Number(i.quantity), 0);
      const inv = { id, status: 'DRAFT', detail: { ...body.detail, invoice_number: `000${invoices.size + 1}` }, primary_recipients: body.primary_recipients, items: body.items, amount: { value: total.toFixed(2), currency_code: body.detail.currency_code } };
      invoices.set(id, inv);
      return r(201, inv);
    }
    if ((m = u.pathname.match(/^\/v2\/invoicing\/invoices\/([^/]+)\/send$/))) {
      invoices.get(m[1]).status = 'SENT';
      return r(200, { href: `https://www.sandbox.paypal.com/invoice/p/#${m[1]}` });
    }
    if ((m = u.pathname.match(/^\/v2\/invoicing\/invoices\/([^/]+)$/))) {
      const inv = invoices.get(m[1]);
      return inv ? r(200, inv) : r(404, { name: 'RESOURCE_NOT_FOUND', details: [{ issue: 'INVALID_RESOURCE_ID', description: 'Requested resource ID was not found.' }], debug_id: 'abc123' });
    }
    if (method === 'POST' && u.pathname === '/v2/checkout/orders') {
      const id = `ORDER${orders.size + 1}`;
      orders.set(id, { id, status: 'CREATED', purchase_units: body.purchase_units });
      return r(201, { id, status: 'CREATED', links: [{ rel: 'approve', href: `https://www.sandbox.paypal.com/checkoutnow?token=${id}` }] });
    }
    if ((m = u.pathname.match(/^\/v2\/checkout\/orders\/([^/]+)\/capture$/))) {
      const o2 = orders.get(m[1]);
      if (o2.status !== 'APPROVED') return r(422, { name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'ORDER_NOT_APPROVED', description: 'Payer has not yet approved the Order for payment.' }] });
      return r(201, { id: m[1], status: 'COMPLETED', purchase_units: [{ payments: { captures: [{ id: 'CAP1', status: 'COMPLETED', amount: o2.purchase_units[0].amount }] } }] });
    }
    if ((m = u.pathname.match(/^\/v2\/payments\/captures\/([^/]+)$/))) return r(200, { id: m[1], amount: { value: '80.00', currency_code: 'USD' } });
    if ((m = u.pathname.match(/^\/v2\/payments\/captures\/([^/]+)\/refund$/))) return r(201, { id: 'REF1', status: 'COMPLETED' });
    return r(404, { name: 'NOT_FOUND' });
  };
  return { fetch, calls, orders, invoices };
}

const setup = (over: Record<string, unknown> = {}, pp = fakePayPal()) => ({
  pp,
  ctx: createTestContext({ config: { ...configDefaults(manifest), ...over }, grants, secrets, fetch: pp.fetch }),
});
const data = (r: { content: Array<{ type: string; data?: unknown; text?: string }> }) => JSON.parse(resultText(r as any));

test('manifest: money-moving tools ask for approval; network is sandbox-only', () => {
  const ask = manifest.contributes.tools.filter((t: any) => t.approval === 'ask').map((t: any) => t.name).sort();
  assert.deepEqual(ask, ['cancel_sent_invoice', 'create_refund', 'pay_order', 'send_invoice']);
  assert.deepEqual(manifest.permissions.find((p: any) => p.id === 'net.http').scope, ['api-m.sandbox.paypal.com']);
});

test('money() normalises amounts and rejects bad ones', () => {
  assert.deepEqual(money('250'), { value: '250.00', n: 250 });
  assert.deepEqual(money(19.5), { value: '19.50', n: 19.5 });
  for (const bad of ['-1', '0', 'ten', '1.234', null]) assert.throws(() => money(bad), /positive amount/);
});

test('create_invoice signs in with client credentials and creates a draft', async () => {
  const { pp, ctx } = setup();
  const out = data(await callTool(plugin, 'create_invoice', {
    recipient_email: 'acme@example.com', recipient_name: 'Ada Lovelace',
    items: [{ name: 'October retainer', unit_amount: '250' }, { name: 'Hosting', quantity: 2, unit_amount: 10 }],
  }, ctx));
  assert.equal(out.status, 'DRAFT');
  assert.equal(out.total, '270.00 USD');
  const tokenCall = pp.calls.find((c) => c.path === '/v1/oauth2/token')!;
  assert.equal(tokenCall.headers.authorization, `Basic ${btoa('sb-client-id-123456:sb-secret')}`);
  assert.equal(tokenCall.body, 'grant_type=client_credentials');
  const create = pp.calls.find((c) => c.path === '/v2/invoicing/invoices')!;
  assert.ok(create.headers['paypal-request-id'], 'POSTs carry an idempotency key');
  assert.deepEqual(create.body.primary_recipients[0].billing_info.name, { given_name: 'Ada', surname: 'Lovelace' });
  assert.equal(create.body.items[1].quantity, '2');
  assert.equal(create.body.items[1].unit_amount.value, '10.00');
  assert.ok(!resultText(await callTool(plugin, 'get_invoice', { invoice_id: out.invoice_id }, ctx)).includes('sb-secret'), 'secrets never reach the model');
});

test('send_invoice returns the payer link; get_invoice and list_invoices summarise', async () => {
  const { ctx } = setup();
  const inv = data(await callTool(plugin, 'create_invoice', { recipient_email: 'a@b.co', items: [{ name: 'x', unit_amount: 5 }] }, ctx));
  const sent = data(await callTool(plugin, 'send_invoice', { invoice_id: inv.invoice_id }, ctx));
  assert.equal(sent.status, 'SENT');
  assert.match(sent.payer_link, /sandbox\.paypal\.com\/invoice/);
  const got = data(await callTool(plugin, 'get_invoice', { invoice_id: inv.invoice_id }, ctx));
  assert.equal(got.total, '5.00 USD');
  assert.deepEqual(got.items, ['1 × x @ 5.00 USD']);
});

test('per-action limit refuses before PayPal is called', async () => {
  const { pp, ctx } = setup({ maxAmountPerAction: 100 });
  await assert.rejects(callTool(plugin, 'create_order', { amount: '150' }, ctx), (e: any) => e.code === 'PERMISSION_DENIED' && /per-action limit of 100/.test(e.message));
  assert.equal(pp.calls.length, 0, 'no request reached PayPal');
});

test('daily limit counts across actions and is released when PayPal refuses', async () => {
  const { pp, ctx } = setup({ dailyLimit: 300 });
  await callTool(plugin, 'create_order', { amount: 200 }, ctx);
  await assert.rejects(callTool(plugin, 'create_invoice', { recipient_email: 'a@b.co', items: [{ name: 'x', unit_amount: 150 }] }, ctx), /over the daily limit of 300/);
  // A failed PayPal call must not use up the allowance.
  pp.orders.clear();
  let failNext = true;
  const failing = createTestContext({ config: { ...configDefaults(manifest), dailyLimit: 300 }, grants, secrets, fetch: (u, o) => {
    if (u.endsWith('/v2/checkout/orders') && failNext) { failNext = false; return { status: 500, ok: false, body: '{"name":"INTERNAL_SERVER_ERROR"}' }; }
    return pp.fetch(u, o);
  } });
  await assert.rejects(callTool(plugin, 'create_order', { amount: 250 }, failing), /PayPal 500/);
  await callTool(plugin, 'create_order', { amount: 250 }, failing); // would fail if 250 had stayed reserved
  await assert.rejects(callTool(plugin, 'create_order', { amount: 100 }, failing), /daily limit/);
});

test('currencies outside the allowlist are refused', async () => {
  const { ctx } = setup();
  await assert.rejects(callTool(plugin, 'create_order', { amount: 5, currency_code: 'JPY' }, ctx), /Currency JPY is not allowed/);
});

test('order flow: approve link, capture refused until approved, then captured and refunded', async () => {
  const { pp, ctx } = setup();
  const o = data(await callTool(plugin, 'create_order', { amount: '80', description: 'Sticker pack' }, ctx));
  assert.match(o.approve_link, /checkoutnow\?token=ORDER1/);
  await assert.rejects(callTool(plugin, 'pay_order', { order_id: o.order_id }, ctx), (e: any) => /ORDER_NOT_APPROVED/.test(e.message) && /approve link/.test(e.hint));
  pp.orders.get(o.order_id).status = 'APPROVED'; // the buyer approves in the browser
  const paid = data(await callTool(plugin, 'pay_order', { order_id: o.order_id }, ctx));
  assert.equal(paid.capture_id, 'CAP1');
  const refund = data(await callTool(plugin, 'create_refund', { capture_id: 'CAP1' }, ctx));
  assert.equal(refund.amount, '80.00 USD', 'full refund looks up the captured amount');
  const panel = JSON.stringify(await renderPanel(plugin, 'activity', ctx));
  assert.match(panel, /refund issued/);
  assert.match(panel, /160\.00 \/ 2000/, 'order + refund count toward today');
});

test('expired token is refreshed once and the call retried', async () => {
  const pp = fakePayPal({ expireFirstToken: true });
  const { ctx } = setup({}, pp);
  // Use a distinct client id so the module-level token cache from other tests is not reused.
  const ctx2 = createTestContext({ config: configDefaults(manifest), grants, secrets: { ...secrets, CLIENT_ID: 'sb-other-client' }, fetch: pp.fetch });
  const out = data(await callTool(plugin, 'create_order', { amount: 1 }, ctx2));
  assert.equal(out.status, 'CREATED');
  assert.equal(pp.calls.filter((c) => c.path === '/v1/oauth2/token').length, 2);
  void ctx;
});

test('bad credentials and missing secrets give actionable errors', async () => {
  const bad = createTestContext({ config: configDefaults(manifest), grants, secrets: { CLIENT_ID: 'sb-wrong-id-0000', CLIENT_SECRET: 'x' }, fetch: fakePayPal({ tokenStatus: 401 }).fetch });
  await assert.rejects(callTool(plugin, 'list_invoices', {}, bad), (e: any) => /sign-in failed/.test(e.message) && /Sandbox credentials/.test(e.hint));
  const none = createTestContext({ config: configDefaults(manifest), grants, fetch: fakePayPal().fetch });
  await assert.rejects(callTool(plugin, 'list_invoices', {}, none), (e: any) => /helm secrets set helm.paypal CLIENT_ID/.test(e.hint));
  const status = JSON.stringify(await runCommand(plugin, 'status', {}, bad));
  assert.match(status, /not connected/);
});

test('the broker scope keeps the plugin off live PayPal', async () => {
  const { ctx } = setup({ baseUrl: 'https://api-m.paypal.com' });
  await assert.rejects(callTool(plugin, 'list_invoices', {}, ctx), (e: any) => e.code === 'PERMISSION_DENIED' && /api-m\.paypal\.com/.test(e.message));
});

test('a PayPal 403 points at the app features, not at Helm grants', () => {
  const e = explain(403, JSON.stringify({ name: 'NOT_AUTHORIZED', details: [{ issue: 'NOT_AUTHORIZED', description: 'Authorization failed due to insufficient permissions.' }], debug_id: 'f35' }));
  assert.equal(e.code, 'TOOL_ERROR');
  assert.match(e.hint!, /Apps & Credentials .* Features/);
});

test('explain() keeps PayPal debug ids and maps 404', () => {
  const e = explain(404, JSON.stringify({ name: 'RESOURCE_NOT_FOUND', details: [{ issue: 'INVALID_RESOURCE_ID', description: 'not found' }], debug_id: 'f00' }));
  assert.equal(e.code, 'NOT_FOUND');
  assert.match(e.message, /RESOURCE_NOT_FOUND: INVALID_RESOURCE_ID: not found \(debug_id f00\)/);
});
