import { describe, it, expect, afterEach } from 'vitest';
import { syncPurchaseById, syncSubscription } from './surecart';

// The reconcile core of SureCart purchases (2026-10-26). What matters: the
// same event twice converges on ONE row and ONE AuthIES grant; a renewal
// moves the grant's end date under the same source_ref; a standard with no
// Vitrium id grants nothing and says why; test-mode grants nothing; a SureCart
// outage is reported as retryable with nothing written.

// ─── Stubs ─────────────────────────────────────────────────────────────────────

const CATALOG = [
  { id: 'RP-8-25+E2', full_designation: 'ANSI/IES RP-8-25+E2', title: 'Roadway', status: 'Active',
    buy_url: 'https://store.ies.org/product/rp-8/', vitrium_doc_id: 'doc-guid-rp8', vitrium_web_url: 'https://view.protectedpdf.com/2H4QTw' },
  { id: 'LM-79-24', full_designation: 'ANSI/IES LM-79-24', title: 'Electrical', status: 'Active',
    buy_url: 'https://store.ies.org/product/lm-79/', vitrium_doc_id: null, vitrium_web_url: null },
];

/** In-memory `purchases` keyed by surecart_purchase_id, driven by the SQL shapes lib/purchases.ts emits. */
function makeDb() {
  const rows = new Map();
  let nextId = 1;
  const COLS = ['surecart_purchase_id', 'surecart_order_id', 'surecart_order_number', 'surecart_customer_id', 'surecart_product_id', 'surecart_price_id',
    'surecart_subscription_id', 'live_mode', 'email', 'name', 'product_name', 'product_sku', 'product_slug',
    'kind', 'standard_id', 'start_date', 'end_date', 'status', 'revoked_reason', 'last_event_type'];
  const byId = (id) => [...rows.values()].find(r => r.id === id);
  function route(sql, b) {
    if (/FROM standards/.test(sql)) return { all: CATALOG };
    if (/INSERT INTO purchases/.test(sql)) {
      const incoming = Object.fromEntries(COLS.map((c, i) => [c, b[i]]));
      const prev = rows.get(incoming.surecart_purchase_id);
      const row = prev
        ? { ...prev, ...incoming, synced_at: 'now' }
        : { id: nextId++, authies_applied_at: null, authies_error: null, notify_sent_at: null, notify_error: null, created_at: 'now', ...incoming };
      rows.set(row.surecart_purchase_id, row);
      return { first: { ...row } };
    }
    if (/SELECT \* FROM purchases WHERE surecart_purchase_id = \?/.test(sql)) return { first: rows.get(b[0]) ? { ...rows.get(b[0]) } : null };
    if (/SELECT \* FROM purchases WHERE surecart_subscription_id = \?/.test(sql)) return { all: [...rows.values()].filter(r => r.surecart_subscription_id === b[0]).map(r => ({ ...r })) };
    if (/UPDATE purchases SET authies_applied_at = datetime/.test(sql)) { const r = byId(b[0]); r.authies_applied_at = 'now'; r.authies_error = null; return { run: {} }; }
    if (/UPDATE purchases SET authies_error = \?/.test(sql)) { const r = byId(b[1]); r.authies_error = b[0]; return { run: {} }; }
    if (/UPDATE purchases SET notify_sent_at = datetime/.test(sql)) { const r = byId(b[0]); r.notify_sent_at = 'now'; r.notify_error = null; return { run: {} }; }
    if (/UPDATE purchases SET notify_error = \?/.test(sql)) { const r = byId(b[1]); r.notify_error = b[0]; return { run: {} }; }
    if (/UPDATE purchases SET status = \?/.test(sql)) { const r = byId(b[2]); r.status = b[0]; r.revoked_reason = b[1]; return { run: {} }; }
    throw new Error(`unrouted SQL: ${sql}`);
  }
  return {
    rows,
    prepare(sql) {
      const stmt = {
        bindings: [],
        bind(...b) { stmt.bindings = b; return stmt; },
        async first() { return route(sql, stmt.bindings).first ?? null; },
        async all() { return { results: route(sql, stmt.bindings).all || [] }; },
        async run() { return route(sql, stmt.bindings).run || { meta: {} }; },
      };
      return stmt;
    },
  };
}

function purchaseFixture(over = {}) {
  return {
    id: 'p1', object: 'purchase', live_mode: true, revoked: false, created_at: Date.UTC(2026, 10, 2, 14) / 1000,
    customer: { id: 'c1', object: 'customer', email: 'Buyer@Example.org', name: 'Pat' },
    product: { id: 'prod-rp8', object: 'product', name: 'RP-8', sku: 'ANSI/IES RP-8-25+E2', slug: 'rp-8', recurring: false },
    price: { id: 'price1' }, subscription: null, initial_order: { id: 'o1', number: '0042' },
    ...over,
  };
}

/** Routes api.surecart.com → the fixture, auth.ies.org → records the push. */
function stubFetch(surecart) {
  const authies = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.startsWith('https://api.surecart.com/')) {
      const r = typeof surecart === 'function' ? surecart(u) : surecart;
      if (r instanceof Response) return r;
      return new Response(JSON.stringify(r), { status: 200 });
    }
    if (u.startsWith('https://auth.ies.org/')) {
      authies.push({ path: new URL(u).pathname, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ grants: [] }), { status: 201 });
    }
    throw new Error(`unexpected fetch ${u}`);
  };
  return { authies, restore: () => { globalThis.fetch = real; } };
}

function makeEnv(db, over = {}) {
  const sent = [];
  return {
    sent, DB: db,
    SEND_EMAIL: { async send(m) { sent.push(m); } },
    AUTH_IDP_BASE_URL: 'https://auth.ies.org', COMP_GRANTS_API_SECRET: 's3cret', SURECART_API_KEY: 'sk',
    ...over,
  };
}
const URL_ = 'https://lens.ies.org/api/webhooks/surecart';

let f;
afterEach(() => f?.restore());

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('syncPurchaseById — a lease', () => {
  it('records one row, pushes one documents grant for three years, and emails the buyer once', async () => {
    const db = makeDb(); const env = makeEnv(db);
    f = stubFetch(purchaseFixture());
    const r = await syncPurchaseById(env, URL_, 'p1', { eventType: 'purchase.created' });
    expect(r.ok).toBe(true);
    expect(r.action).toBe('granted');
    expect(r.row).toMatchObject({ email: 'buyer@example.org', kind: 'lease', standard_id: 'RP-8-25+E2', start_date: '2026-11-02', end_date: '2029-11-01', status: 'active', authies_applied_at: 'now', notify_sent_at: 'now' });
    expect(f.authies).toEqual([{ path: '/api/comp-grants', body: expect.objectContaining({
      email: 'buyer@example.org', kind: 'documents', documents: ['doc-guid-rp8'], labels: ['RP-8-25+E2'],
      starts_at: '2026-11-02', expires_at: '2029-11-01', source: 'surecart', source_ref: 'surecart-p1', note: 'SureCart order #0042',
    }) }]);
    expect(env.sent).toHaveLength(1);
    expect(env.sent[0].subject).toBe('Your 3-year lease is ready: ANSI/IES RP-8-25+E2');
  });

  it('the same event twice converges: one row, one push, one email', async () => {
    const db = makeDb(); const env = makeEnv(db);
    f = stubFetch(purchaseFixture());
    await syncPurchaseById(env, URL_, 'p1', { eventType: 'purchase.created' });
    const again = await syncPurchaseById(env, URL_, 'p1', { eventType: 'purchase.created' });
    expect(again.action).toBe('unchanged');
    expect(db.rows.size).toBe(1);
    expect(f.authies).toHaveLength(1);
    expect(env.sent).toHaveLength(1);
  });

  it('force re-pushes under the same source_ref and never re-emails', async () => {
    const db = makeDb(); const env = makeEnv(db);
    f = stubFetch(purchaseFixture());
    await syncPurchaseById(env, URL_, 'p1', {});
    const r = await syncPurchaseById(env, URL_, 'p1', { force: true });
    expect(r.action).toBe('granted');
    expect(f.authies).toHaveLength(2);
    expect(f.authies[1].body.source_ref).toBe('surecart-p1');
    expect(env.sent).toHaveLength(1);
  });

  it('a standard with no Vitrium id records the row, pushes nothing, and says why', async () => {
    const db = makeDb(); const env = makeEnv(db);
    f = stubFetch(purchaseFixture({ product: { id: 'prod-lm79', name: 'LM-79', sku: 'ANSI/IES LM-79-24', slug: 'lm-79' } }));
    const r = await syncPurchaseById(env, URL_, 'p1', {});
    expect(r.ok).toBe(true);
    expect(r.action).toBe('skipped');
    expect(r.row.authies_error).toMatch(/No Vitrium document id synced for LM-79-24/);
    expect(r.row.authies_applied_at).toBeNull();
    expect(f.authies).toHaveLength(0);
    expect(env.sent).toHaveLength(0);
  });

  it('a revoked purchase revokes the grant it had pushed', async () => {
    const db = makeDb(); const env = makeEnv(db);
    let fixture = purchaseFixture();
    f = stubFetch(() => fixture);
    await syncPurchaseById(env, URL_, 'p1', {});
    fixture = purchaseFixture({ revoked: true, revoked_at: 1 });
    const r = await syncPurchaseById(env, URL_, 'p1', { eventType: 'purchase.revoked' });
    expect(r.action).toBe('revoked');
    expect(r.row).toMatchObject({ status: 'revoked', revoked_reason: 'surecart' });
    expect(f.authies[1]).toEqual({ path: '/api/comp-grants/revoke', body: { source: 'surecart', source_ref: 'surecart-p1', email: 'buyer@example.org', revoked_by: 'surecart' } });
  });

  it('a test-mode purchase is recorded as ignored and grants nothing', async () => {
    const db = makeDb(); const env = makeEnv(db);
    f = stubFetch(purchaseFixture({ live_mode: false }));
    const r = await syncPurchaseById(env, URL_, 'p1', {});
    expect(r.action).toBe('skipped');
    expect(r.row).toMatchObject({ status: 'ignored', revoked_reason: 'test_mode', live_mode: 0 });
    expect(f.authies).toHaveLength(0);
    expect(env.sent).toHaveLength(0);
  });

  it('an unmapped product is recorded and grants nothing', async () => {
    const db = makeDb(); const env = makeEnv(db);
    f = stubFetch(purchaseFixture({ product: { id: 'prod-acp', name: 'Proceedings', sku: 'IES-2017-ACP', slug: 'ies-2017-acp' } }));
    const r = await syncPurchaseById(env, URL_, 'p1', {});
    expect(r.row).toMatchObject({ kind: 'unmapped', status: 'ignored', revoked_reason: 'unmapped' });
    expect(f.authies).toHaveLength(0);
  });

  it('a SureCart outage is retryable and writes nothing; a 404 is not retryable', async () => {
    const db = makeDb(); const env = makeEnv(db);
    f = stubFetch(() => new Response('oops', { status: 500 }));
    expect(await syncPurchaseById(env, URL_, 'p1', {})).toMatchObject({ ok: false, retryable: true });
    expect(db.rows.size).toBe(0);
    f.restore();
    f = stubFetch(() => new Response('{}', { status: 404 }));
    expect(await syncPurchaseById(env, URL_, 'p1', {})).toMatchObject({ ok: false, retryable: false });
    expect(await syncPurchaseById(makeEnv(db, { SURECART_API_KEY: '' }), URL_, 'p1', {})).toMatchObject({ ok: false, retryable: false, error: expect.stringMatching(/SURECART_API_KEY/) });
  });

  it('notification off: grants but does not email', async () => {
    const db = makeDb(); const env = makeEnv(db, { SURECART_NOTIFY: 'off' });
    f = stubFetch(purchaseFixture());
    const r = await syncPurchaseById(env, URL_, 'p1', {});
    expect(r.action).toBe('granted');
    expect(env.sent).toHaveLength(0);
  });
});

describe('syncPurchaseById / syncSubscription — a subscription', () => {
  const sub = (end, over = {}) => purchaseFixture({
    product: { id: 'prod-sub', name: 'Lighting Library', sku: null, slug: 'lighting-library', recurring: true },
    subscription: { id: 'sub1', object: 'subscription', status: 'active', current_period_end_at: end, cancel_at_period_end: false },
    ...over,
  });

  it('lands as a subscriber grant through the billing period', async () => {
    const db = makeDb(); const env = makeEnv(db);
    f = stubFetch(sub(Date.UTC(2027, 10, 2) / 1000));
    const r = await syncPurchaseById(env, URL_, 'p1', {});
    expect(r.row).toMatchObject({ kind: 'subscription', end_date: '2027-11-02', surecart_subscription_id: 'sub1' });
    expect(f.authies[0].body).toMatchObject({ kind: 'subscriber', expires_at: '2027-11-02', source_ref: 'surecart-p1' });
    expect(f.authies[0].body.documents).toBeUndefined();
    expect(env.sent[0].subject).toBe('Your Lighting Library subscription is active');
  });

  it('a renewal extends the same grant instead of stacking one', async () => {
    const db = makeDb(); const env = makeEnv(db);
    let fixture = sub(Date.UTC(2027, 10, 2) / 1000);
    f = stubFetch(() => fixture);
    await syncPurchaseById(env, URL_, 'p1', {});
    fixture = sub(Date.UTC(2028, 10, 2) / 1000);
    const results = await syncSubscription(env, URL_, 'sub1', 'subscription.renewed');
    expect(results).toHaveLength(1);
    expect(results[0].action).toBe('granted');
    expect(results[0].row.end_date).toBe('2028-11-02');
    expect(f.authies).toHaveLength(2);
    expect(f.authies[1].body).toMatchObject({ source_ref: 'surecart-p1', expires_at: '2028-11-02' });
    expect(env.sent).toHaveLength(1);
  });

  it('an unknown subscription id syncs nothing', async () => {
    const db = makeDb(); const env = makeEnv(db);
    f = stubFetch(sub(1));
    expect(await syncSubscription(env, URL_, 'sub-unknown', 'subscription.renewed')).toEqual([]);
  });
});

// ─── The webhook endpoint ──────────────────────────────────────────────────────

import { handleSurecartWebhook } from './surecart';

async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function signedRequest(secret, event, { timestamp, signature } = {}) {
  const body = JSON.stringify(event);
  const ts = timestamp ?? String(Math.floor(Date.now() / 1000));
  const sig = signature ?? await hmacHex(secret, `${ts}.${body}`);
  return new Request(URL_, {
    method: 'POST', body,
    headers: { 'Content-Type': 'application/json', 'x-webhook-timestamp': ts, 'x-webhook-signature': sig },
  });
}
const EVENT = (type, object) => ({ id: 'evt1', object: 'event', type, data: { object } });

describe('handleSurecartWebhook', () => {
  it('a correctly signed purchase.created is processed once', async () => {
    const db = makeDb(); const env = makeEnv(db, { SURECART_WEBHOOK_SECRET: 'whsec' });
    f = stubFetch(purchaseFixture());
    const res = await handleSurecartWebhook(await signedRequest('whsec', EVENT('purchase.created', { id: 'p1', object: 'purchase', live_mode: true })), env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ recorded: true, action: 'granted', purchase: 'p1', kind: 'lease', status: 'active' });
    expect(f.authies).toHaveLength(1);
  });

  it('a bad signature is refused before SureCart is asked anything', async () => {
    const db = makeDb(); const env = makeEnv(db, { SURECART_WEBHOOK_SECRET: 'whsec' });
    f = stubFetch(() => { throw new Error('must not be called'); });
    const wrong = await handleSurecartWebhook(await signedRequest('other', EVENT('purchase.created', { id: 'p1', object: 'purchase' })), env);
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toEqual({ error: 'bad_signature', reason: 'mismatch' });
    const stale = await handleSurecartWebhook(await signedRequest('whsec', EVENT('purchase.created', { id: 'p1', object: 'purchase' }), { timestamp: '1641873601' }), env);
    expect((await stale.json()).reason).toBe('stale');
    expect(db.rows.size).toBe(0);
  });

  it('an event this integration does not act on is acknowledged with 202', async () => {
    const env = makeEnv(makeDb(), { SURECART_WEBHOOK_SECRET: 'whsec' });
    const res = await handleSurecartWebhook(await signedRequest('whsec', EVENT('order.paid', { id: 'o1', object: 'order' })), env);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ignored: 'order.paid' });
  });

  it('no signing secret → 503; a non-event body → 400', async () => {
    const res = await handleSurecartWebhook(await signedRequest('whsec', EVENT('purchase.created', { id: 'p1' })), makeEnv(makeDb()));
    expect(res.status).toBe(503);
    const env = makeEnv(makeDb(), { SURECART_WEBHOOK_SECRET: 'whsec' });
    const bad = await handleSurecartWebhook(await signedRequest('whsec', { hello: 'world' }), env);
    expect(bad.status).toBe(400);
  });

  it('a SureCart outage answers 500 so SureCart retries; an unmapped product answers 200 so it does not', async () => {
    const db = makeDb(); const env = makeEnv(db, { SURECART_WEBHOOK_SECRET: 'whsec' });
    f = stubFetch(() => new Response('oops', { status: 503 }));
    const down = await handleSurecartWebhook(await signedRequest('whsec', EVENT('purchase.created', { id: 'p1', object: 'purchase' })), env);
    expect(down.status).toBe(500);
    f.restore();
    f = stubFetch(purchaseFixture({ product: { id: 'x', name: 'Proceedings', sku: 'IES-2017-ACP', slug: 'acp' } }));
    const unmapped = await handleSurecartWebhook(await signedRequest('whsec', EVENT('purchase.created', { id: 'p1', object: 'purchase' })), env);
    expect(unmapped.status).toBe(200);
    expect(await unmapped.json()).toMatchObject({ recorded: true, action: 'skipped', kind: 'unmapped' });
  });

  it('a subscription.renewed re-syncs the purchases of that subscription', async () => {
    const db = makeDb(); const env = makeEnv(db, { SURECART_WEBHOOK_SECRET: 'whsec' });
    let fixture = purchaseFixture({ subscription: { id: 'sub1', status: 'active', current_period_end_at: Date.UTC(2027, 10, 2) / 1000 }, product: { id: 'prod-sub', name: 'LL', sku: null, slug: 'll' } });
    f = stubFetch(() => fixture);
    await syncPurchaseById(env, URL_, 'p1', {});
    fixture = { ...fixture, subscription: { ...fixture.subscription, current_period_end_at: Date.UTC(2028, 10, 2) / 1000 } };
    const res = await handleSurecartWebhook(await signedRequest('whsec', EVENT('subscription.renewed', { id: 'sub1', object: 'subscription' })), env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ recorded: true, subscription: 'sub1', purchases: 1, actions: ['granted'] });
    expect(f.authies[1].body.expires_at).toBe('2028-11-02');
  });
});
