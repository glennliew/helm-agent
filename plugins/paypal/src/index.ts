// helm.paypal — PayPal sandbox tools for the agent: invoices, checkout orders, captures, refunds
// and transaction reporting. Tool names and inputs follow PayPal's Agent Toolkit
// (github.com/paypal/agent-toolkit) so prompts written for it work here too.
//
// The plugin never opens a socket itself: every request goes through the host broker
// (ctx.net.fetch), which only lets it reach api-m.sandbox.paypal.com. Credentials come from
// the secrets grant and are never returned to the model. Money-moving tools are marked
// approval: "ask" in the manifest, and this file adds per-action and daily spend limits.

import { definePlugin, PluginError, ui } from '@helm-agent/plugin-sdk';
import type { CallContext, PluginContext } from '@helm-agent/plugin-sdk';

interface Cfg { baseUrl: string; maxAmountPerAction: number; dailyLimit: number; allowedCurrencies: string[] }
export interface Activity { ts: string; action: string; amount?: number; currency?: string; ref?: string; status: string; link?: string }
interface Ledger { day: string; total: number }

const MAX_ACTIVITY = 100;
const cfg = (ctx: PluginContext) => ctx.config as Cfg;
const base = (ctx: PluginContext) => cfg(ctx).baseUrl.replace(/\/$/, '');
const today = () => new Date().toISOString().slice(0, 10);

// ------------------------------------------------------------------ money helpers

/** Parse a positive decimal amount ("250", 250, "250.5") into PayPal's two-decimal string. */
export function money(v: unknown, field = 'amount'): { value: string; n: number } {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\s*\d+(\.\d{1,2})?\s*$/.test(v) ? Number(v) : NaN;
  if (!Number.isFinite(n) || n <= 0) throw new PluginError(`${field} must be a positive amount with at most 2 decimals (got ${JSON.stringify(v)})`, 'INVALID_INPUT');
  return { value: n.toFixed(2), n: Math.round(n * 100) / 100 };
}

function currency(ctx: PluginContext, code = 'USD'): string {
  const c = code.toUpperCase();
  if (!cfg(ctx).allowedCurrencies.includes(c)) {
    throw new PluginError(`Currency ${c} is not allowed`, 'PERMISSION_DENIED', `Allowed: ${cfg(ctx).allowedCurrencies.join(', ')}. Change with: helm plugin config helm.paypal set allowedCurrencies '["USD","${c}"]'`);
  }
  return c;
}

// ------------------------------------------------------------------ spend limits

async function ledger(ctx: PluginContext): Promise<Ledger> {
  const l = await ctx.storage.get<Ledger>('ledger');
  return l && l.day === today() ? l : { day: today(), total: 0 };
}

/** Refuse before calling PayPal if the amount breaks a limit; otherwise reserve it for today. */
export async function reserve(ctx: PluginContext, amount: number, cur: string, what: string): Promise<() => Promise<void>> {
  const c = cfg(ctx);
  if (amount > c.maxAmountPerAction) {
    await record(ctx, { action: what, amount, currency: cur, status: 'blocked: over per-action limit' });
    throw new PluginError(`${what} for ${amount.toFixed(2)} ${cur} is over the per-action limit of ${c.maxAmountPerAction}`, 'PERMISSION_DENIED',
      `Split it, or raise the limit yourself: helm plugin config helm.paypal set maxAmountPerAction <amount>. Do not retry with the same amount.`);
  }
  const l = await ledger(ctx);
  if (l.total + amount > c.dailyLimit) {
    await record(ctx, { action: what, amount, currency: cur, status: 'blocked: daily limit' });
    throw new PluginError(`${what} for ${amount.toFixed(2)} ${cur} would take today's total to ${(l.total + amount).toFixed(2)}, over the daily limit of ${c.dailyLimit}`, 'PERMISSION_DENIED',
      'The limit resets at 00:00 UTC, or the user can raise it: helm plugin config helm.paypal set dailyLimit <amount>. Do not retry.');
  }
  l.total = Math.round((l.total + amount) * 100) / 100;
  await ctx.storage.set('ledger', l);
  // Release the reservation if PayPal refuses the request.
  return async () => {
    const cur2 = await ledger(ctx);
    cur2.total = Math.max(0, Math.round((cur2.total - amount) * 100) / 100);
    await ctx.storage.set('ledger', cur2);
  };
}

async function record(ctx: PluginContext, a: Omit<Activity, 'ts'>) {
  const list = (await ctx.storage.get<Activity[]>('activity')) ?? [];
  list.push({ ts: new Date().toISOString(), ...a });
  await ctx.storage.set('activity', list.slice(-MAX_ACTIVITY));
  ctx.ui.refresh('activity');
}

// ------------------------------------------------------------------ PayPal REST client

let token: { value: string; expires: number; key: string } | null = null;

async function credentials(ctx: PluginContext) {
  try {
    return { id: await ctx.secrets.get('CLIENT_ID'), secret: await ctx.secrets.get('CLIENT_SECRET') };
  } catch {
    throw new PluginError('PayPal sandbox credentials are not set', 'PERMISSION_DENIED',
      'Create a sandbox app at developer.paypal.com → Apps & Credentials, then run: helm secrets set helm.paypal CLIENT_ID && helm secrets set helm.paypal CLIENT_SECRET');
  }
}

async function accessToken(ctx: PluginContext, force = false): Promise<string> {
  const { id, secret } = await credentials(ctx);
  const key = `${id.slice(0, 12)}:${base(ctx)}`;
  if (!force && token && token.key === key && token.expires > Date.now() + 60_000) return token.value;
  const res = await ctx.net.fetch(`${base(ctx)}/v1/oauth2/token`, {
    method: 'POST',
    headers: { authorization: `Basic ${btoa(`${id}:${secret}`)}`, 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: 'grant_type=client_credentials',
    timeoutMs: 20_000,
  });
  if (!res.ok) {
    token = null;
    throw new PluginError(`PayPal sign-in failed (HTTP ${res.status})`, 'PERMISSION_DENIED',
      res.status === 401 ? 'The client ID or secret is wrong, or belongs to a Live app. Use the Sandbox credentials: helm secrets set helm.paypal CLIENT_ID' : undefined);
  }
  const data = res.json<{ access_token: string; expires_in: number }>();
  token = { value: data.access_token, expires: Date.now() + (data.expires_in ?? 3000) * 1000, key };
  return token.value;
}

/** Turn a PayPal error body into a short message the model (and user) can act on. */
export function explain(status: number, body: string): PluginError {
  let msg = body.slice(0, 300);
  let debugId = '';
  try {
    const e = JSON.parse(body);
    const d = e.details?.[0];
    msg = [e.name, d?.issue, d?.description ?? e.message].filter(Boolean).join(': ');
    debugId = e.debug_id ? ` (debug_id ${e.debug_id})` : '';
  } catch { /* not JSON */ }
  const hints: Record<string, string> = {
    ORDER_NOT_APPROVED: 'The buyer has not approved this order yet. Send them the approve link from create_order and try again after they pay.',
    ORDER_ALREADY_CAPTURED: 'This order was already captured; use get_order to see the capture ID.',
    CAPTURE_FULLY_REFUNDED: 'This payment has already been fully refunded.',
    REFUND_AMOUNT_EXCEEDED: 'The refund is larger than what is left on the capture.',
    RESOURCE_NOT_FOUND: 'Check the ID; sandbox and live IDs are different.',
    INVALID_RESOURCE_ID: 'Check the ID; sandbox and live IDs are different.',
  };
  let hint = Object.entries(hints).find(([k]) => msg.includes(k))?.[1];
  // A PayPal 403 is about the PayPal app's features, not a Helm grant, so don't use
  // PERMISSION_DENIED (the host would suggest `helm plugin grant`, which can't fix it).
  if (!hint && status === 403) hint = 'Your PayPal sandbox app lacks this feature. In developer.paypal.com → Apps & Credentials → (Sandbox) your app → Features, enable it (e.g. Invoicing), save, then retry in a few minutes. Tell the user; do not retry now.';
  const code = status === 404 ? 'NOT_FOUND' : status === 401 ? 'PERMISSION_DENIED' : status === 429 ? 'RATE_LIMITED' : 'TOOL_ERROR';
  return new PluginError(`PayPal ${status}: ${msg}${debugId}`, code, hint);
}

async function api<T = any>(ctx: CallContext, method: string, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<T> {
  const send = async (force: boolean) => ctx.net.fetch(`${base(ctx)}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${await accessToken(ctx, force)}`,
      'content-type': 'application/json',
      accept: 'application/json',
      // Idempotency: a retried POST never creates a second invoice, order or refund.
      ...(method === 'POST' ? { 'paypal-request-id': crypto.randomUUID() } : {}),
      ...extra,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    timeoutMs: 30_000,
    maxBytes: 4 * 1024 * 1024,
  });
  let res = await send(false);
  if (res.status === 401) res = await send(true); // token expired early: refresh once
  if (!res.ok) throw explain(res.status, res.body);
  return (res.body ? res.json<T>() : ({} as T));
}

const link = (links: Array<{ rel: string; href: string }> | undefined, ...rels: string[]) => links?.find((l) => rels.includes(l.rel))?.href;
const invoiceUrl = (id: string) => `https://www.sandbox.paypal.com/invoice/p/#${id}`;

// ------------------------------------------------------------------ tools

interface Item { name: string; quantity?: number; unit_amount: string | number; description?: string }

export default definePlugin({
  tools: {
    async create_invoice(i: { recipient_email: string; recipient_name?: string; currency_code?: string; items: Item[]; note?: string; due_in_days?: number }, ctx) {
      const cur = currency(ctx, i.currency_code);
      const items = i.items.map((it, n) => {
        const unit = money(it.unit_amount, `items[${n}].unit_amount`);
        const qty = it.quantity ?? 1;
        return { line: { name: it.name, description: it.description, quantity: String(qty), unit_amount: { currency_code: cur, value: unit.value } }, total: unit.n * qty };
      });
      const total = Math.round(items.reduce((s, x) => s + x.total, 0) * 100) / 100;
      const release = await reserve(ctx, total, cur, 'invoice');
      const [given, ...rest] = (i.recipient_name ?? '').trim().split(/\s+/);
      const detail: Record<string, unknown> = { currency_code: cur, note: i.note };
      if (i.due_in_days !== undefined) detail.payment_term = { due_date: new Date(Date.now() + i.due_in_days * 86_400_000).toISOString().slice(0, 10) };
      let inv: any;
      try {
        inv = await api(ctx, 'POST', '/v2/invoicing/invoices', {
          detail,
          primary_recipients: [{ billing_info: { email_address: i.recipient_email, ...(given ? { name: { given_name: given, surname: rest.join(' ') || undefined } } : {}) } }],
          items: items.map((x) => x.line),
        }, { prefer: 'return=representation' });
      } catch (e) { await release(); throw e; }
      // Older API versions answer 201 with only a link; fetch the invoice so the model sees it.
      if (!inv.id && inv.href) inv = await api(ctx, 'GET', new URL(inv.href).pathname);
      await record(ctx, { action: 'invoice created (draft)', amount: total, currency: cur, ref: inv.id, status: inv.status ?? 'DRAFT' });
      return { invoice_id: inv.id, invoice_number: inv.detail?.invoice_number, status: inv.status, total: `${total.toFixed(2)} ${cur}`, recipient: i.recipient_email, next: 'Draft only. Call send_invoice to email it to the customer.' };
    },

    async send_invoice(i: { invoice_id: string; subject?: string; note?: string }, ctx) {
      const r = await api(ctx, 'POST', `/v2/invoicing/invoices/${encodeURIComponent(i.invoice_id)}/send`, { subject: i.subject, note: i.note, send_to_invoicer: true, send_to_recipient: true });
      const payLink = r.href && !r.href.includes('/v2/') ? r.href : invoiceUrl(i.invoice_id);
      const inv = await api(ctx, 'GET', `/v2/invoicing/invoices/${encodeURIComponent(i.invoice_id)}`);
      const amt = inv.amount;
      await record(ctx, { action: 'invoice sent', amount: amt ? Number(amt.value) : undefined, currency: amt?.currency_code, ref: i.invoice_id, status: inv.status, link: payLink });
      return { invoice_id: i.invoice_id, status: inv.status, total: amt ? `${amt.value} ${amt.currency_code}` : undefined, payer_link: payLink };
    },

    async list_invoices(i: { page?: number; page_size?: number }, ctx) {
      const r = await api(ctx, 'GET', `/v2/invoicing/invoices?page=${i.page ?? 1}&page_size=${i.page_size ?? 10}&total_required=true`);
      return {
        total: r.total_items,
        invoices: (r.items ?? []).map((v: any) => ({
          invoice_id: v.id, number: v.detail?.invoice_number, status: v.status,
          total: v.amount ? `${v.amount.value} ${v.amount.currency_code}` : undefined,
          recipient: v.primary_recipients?.[0]?.billing_info?.email_address, date: v.detail?.invoice_date,
        })),
      };
    },

    async get_invoice(i: { invoice_id: string }, ctx) {
      const v = await api(ctx, 'GET', `/v2/invoicing/invoices/${encodeURIComponent(i.invoice_id)}`);
      return {
        invoice_id: v.id, number: v.detail?.invoice_number, status: v.status,
        total: v.amount ? `${v.amount.value} ${v.amount.currency_code}` : undefined,
        paid: v.payments?.paid_amount ? `${v.payments.paid_amount.value} ${v.payments.paid_amount.currency_code}` : undefined,
        due: v.due_amount ? `${v.due_amount.value} ${v.due_amount.currency_code}` : undefined,
        recipient: v.primary_recipients?.[0]?.billing_info?.email_address,
        items: (v.items ?? []).map((x: any) => `${x.quantity} × ${x.name} @ ${x.unit_amount?.value} ${x.unit_amount?.currency_code}`),
        payer_link: v.status === 'DRAFT' ? undefined : link(v.links, 'payer-view') ?? invoiceUrl(v.id),
      };
    },

    async cancel_sent_invoice(i: { invoice_id: string; note?: string }, ctx) {
      await api(ctx, 'POST', `/v2/invoicing/invoices/${encodeURIComponent(i.invoice_id)}/cancel`, { note: i.note, send_to_recipient: true, send_to_invoicer: true });
      await record(ctx, { action: 'invoice cancelled', ref: i.invoice_id, status: 'CANCELLED' });
      return { invoice_id: i.invoice_id, status: 'CANCELLED' };
    },

    async create_order(i: { amount: string | number; currency_code?: string; description?: string }, ctx) {
      const cur = currency(ctx, i.currency_code);
      const amt = money(i.amount);
      const release = await reserve(ctx, amt.n, cur, 'order');
      let o: any;
      try {
        o = await api(ctx, 'POST', '/v2/checkout/orders', {
          intent: 'CAPTURE',
          purchase_units: [{ amount: { currency_code: cur, value: amt.value }, description: i.description }],
        });
      } catch (e) { await release(); throw e; }
      const approve = link(o.links, 'approve', 'payer-action');
      await record(ctx, { action: 'order created', amount: amt.n, currency: cur, ref: o.id, status: o.status, link: approve });
      return { order_id: o.id, status: o.status, amount: `${amt.value} ${cur}`, approve_link: approve, next: 'Send approve_link to the buyer. After they approve, call pay_order to capture the payment.' };
    },

    async get_order(i: { order_id: string }, ctx) {
      const o = await api(ctx, 'GET', `/v2/checkout/orders/${encodeURIComponent(i.order_id)}`);
      const pu = o.purchase_units?.[0];
      return {
        order_id: o.id, status: o.status,
        amount: pu?.amount ? `${pu.amount.value} ${pu.amount.currency_code}` : undefined,
        payer: o.payer?.email_address,
        captures: (pu?.payments?.captures ?? []).map((c: any) => ({ capture_id: c.id, status: c.status, amount: `${c.amount?.value} ${c.amount?.currency_code}` })),
        approve_link: o.status === 'CREATED' ? link(o.links, 'approve', 'payer-action') : undefined,
      };
    },

    async pay_order(i: { order_id: string }, ctx) {
      const o = await api(ctx, 'POST', `/v2/checkout/orders/${encodeURIComponent(i.order_id)}/capture`, {});
      const cap = o.purchase_units?.[0]?.payments?.captures?.[0];
      await record(ctx, { action: 'payment captured', amount: cap ? Number(cap.amount?.value) : undefined, currency: cap?.amount?.currency_code, ref: cap?.id ?? i.order_id, status: cap?.status ?? o.status });
      return { order_id: o.id, status: o.status, capture_id: cap?.id, capture_status: cap?.status, amount: cap ? `${cap.amount?.value} ${cap.amount?.currency_code}` : undefined, payer: o.payer?.email_address };
    },

    async create_refund(i: { capture_id: string; amount?: string | number; currency_code?: string; note_to_payer?: string }, ctx) {
      const id = encodeURIComponent(i.capture_id);
      let amt: { value: string; n: number };
      let cur: string;
      if (i.amount !== undefined) {
        amt = money(i.amount);
        cur = currency(ctx, i.currency_code);
      } else {
        // Full refund: look the capture up so the spend limit counts the real amount.
        const c = await api(ctx, 'GET', `/v2/payments/captures/${id}`);
        amt = money(c.amount?.value, 'capture amount');
        cur = currency(ctx, c.amount?.currency_code);
      }
      const release = await reserve(ctx, amt.n, cur, 'refund');
      let r: any;
      try {
        r = await api(ctx, 'POST', `/v2/payments/captures/${id}/refund`, {
          ...(i.amount !== undefined ? { amount: { value: amt.value, currency_code: cur } } : {}),
          note_to_payer: i.note_to_payer,
        });
      } catch (e) { await release(); throw e; }
      await record(ctx, { action: 'refund issued', amount: amt.n, currency: cur, ref: r.id, status: r.status });
      return { refund_id: r.id, status: r.status, amount: `${amt.value} ${cur}`, capture_id: i.capture_id };
    },

    async list_transactions(i: { days?: number }, ctx) {
      const end = new Date();
      const start = new Date(end.getTime() - Math.min(31, i.days ?? 7) * 86_400_000);
      const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
      const r = await api(ctx, 'GET', `/v1/reporting/transactions?start_date=${iso(start)}&end_date=${iso(end)}&fields=transaction_info,payer_info&page_size=50`);
      const rows = (r.transaction_details ?? []).map((t: any) => ({
        id: t.transaction_info?.transaction_id, date: t.transaction_info?.transaction_initiation_date,
        amount: `${t.transaction_info?.transaction_amount?.value} ${t.transaction_info?.transaction_amount?.currency_code}`,
        status: t.transaction_info?.transaction_status, payer: t.payer_info?.email_address,
      }));
      return { count: rows.length, transactions: rows, note: rows.length ? undefined : 'No transactions yet. Sandbox activity can take up to a few hours to show in reporting.' };
    },
  },

  commands: {
    async status(_a, ctx: CallContext) {
      const c = cfg(ctx);
      const l = await ledger(ctx);
      let conn: string;
      try { await accessToken(ctx, true); conn = 'connected'; } catch (e) { conn = (e as Error).message; }
      return ui.stack(
        ui.heading('PayPal sandbox'),
        ui.badge(conn === 'connected' ? 'connected' : 'not connected', conn === 'connected' ? 'success' : 'danger'),
        ui.keyValue({ api: base(ctx), 'per-action limit': c.maxAmountPerAction, 'daily limit': c.dailyLimit, 'used today': l.total.toFixed(2), currencies: c.allowedCurrencies.join(', ') }),
        ...(conn === 'connected' ? [] : [ui.text(conn, 'warning')]),
      );
    },
    async clear(_a, ctx: CallContext) {
      await ctx.storage.set('activity', []);
      ctx.ui.refresh('activity');
      return 'PayPal activity log cleared. Today\'s spend total is kept, so limits still apply.';
    },
  },

  panels: {
    async activity(ctx) {
      const c = cfg(ctx);
      const l = await ledger(ctx);
      const list = ((await ctx.storage.get<Activity[]>('activity')) ?? []).slice(-12).reverse();
      const pct = c.dailyLimit ? Math.round((l.total / c.dailyLimit) * 100) : 0;
      return ui.stack(
        ui.keyValue({ environment: 'sandbox', 'used today': `${l.total.toFixed(2)} / ${c.dailyLimit} (${pct}%)`, 'per action': `≤ ${c.maxAmountPerAction}` }),
        list.length
          ? ui.table(['time', 'action', 'amount', 'status'], list.map((a) => [a.ts.slice(11, 16), a.action, a.amount !== undefined ? `${a.amount.toFixed(2)} ${a.currency ?? ''}` : '', a.status]))
          : ui.text('No PayPal activity yet. Ask the agent to invoice someone.', 'muted'),
        ui.button('Check connection', 'status'),
      );
    },
  },
});
