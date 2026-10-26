import { describe, it, expect, afterEach } from 'vitest';
import { handleAdminPurchases, handleAdminPurchasesCsv, effectivePurchaseStatus } from './purchases-admin';

// The staff view of SureCart purchases (2026-10-26): every endpoint sits
// behind the admin gate; the list fails soft when migration 0024 is missing;
// a staff revoke follows through to AuthIES; reinstate and retry re-sync from
// SureCart; import walks SureCart's pages.

// ─── Stubs ─────────────────────────────────────────────────────────────────────

const CATALOG = [
  { id: 'RP-8-25+E2', full_designation: 'ANSI/IES RP-8-25+E2', title: 'Roadway', status: 'Active',
    buy_url: 'https://store.ies.org/product/rp-8/', vitrium_doc_id: 'doc-guid-rp8', vitrium_web_url: 'https://view.protectedpdf.com/2H4QTw' },
];

const ROW = {
  id: 7, surecart_purchase_id: 'p1', surecart_order_id: 'o1', surecart_order_number: '0042', surecart_customer_id: 'c1',
  surecart_product_id: 'prod-rp8', surecart_price_id: 'price1', surecart_subscription_id: null, live_mode: 1,
  email: 'buyer@example.org', name: 'Pat', product_name: 'RP-8', product_sku: 'ANSI/IES RP-8-25+E2', product_slug: 'rp-8',
  kind: 'lease', standard_id: 'RP-8-25+E2', start_date: '2026-11-02', end_date: '2029-11-01', status: 'active', revoked_reason: null,
  authies_applied_at: '2026-11-02 14:00:01', authies_error: null, notify_sent_at: '2026-11-02 14:00:02', notify_error: null,
  last_event_type: 'purchase.created', last_event_at: '2026-11-02 14:00:00', synced_at: '2026-11-02 14:00:00',
  created_at: '2026-11-02 14:00:00', updated_at: '2026-11-02 14:00:02',
};

function makeDb(route) {
  const calls = [];
  return {
    calls,
    prepare(sql) {
      const stmt = {
        sql, bindings: [],
        bind(...b) { stmt.bindings = b; calls.push({ sql, bindings: b }); return stmt; },
        async first() { return route(sql, stmt.bindings) ?? null; },
        async all() { return { results: route(sql, stmt.bindings) || [] }; },
        async run() { return route(sql, stmt.bindings) || { meta: { changes: 1 } }; },
      };
      return stmt;
    },
  };
}

function makeRoute(rows = [ROW]) {
  return function route(sql, b) {
    if (/FROM standards/.test(sql)) return CATALOG;
    if (/SELECT \* FROM purchases WHERE id = \?/.test(sql)) return rows.find(r => r.id === b[0]) ?? null;
    if (/SELECT \* FROM purchases WHERE surecart_purchase_id = \?/.test(sql)) return rows.find(r => r.surecart_purchase_id === b[0]) ?? null;
    if (/INSERT INTO purchases/.test(sql)) return { ...ROW, surecart_purchase_id: b[0], email: b[8] };
    if (/FROM purchases/.test(sql)) return rows;
    if (/UPDATE purchases/.test(sql)) return { meta: { changes: 1 } };
    throw new Error(`unrouted SQL: ${sql}`);
  };
}

function makeEnv(route, over = {}) {
  return {
    DB: makeDb(route),
    SESSIONS: { get: async () => null, put: async () => {} },
    SEND_EMAIL: { async send() {} },
    AUTH_IDP_BASE_URL: 'https://auth.ies.org', COMP_GRANTS_API_SECRET: 's3cret', SURECART_API_KEY: 'sk',
    ...over,
  };
}

async function call(handler, env, path, init = {}) {
  const { headers = { Authorization: 'Bearer test' }, body, method = 'GET' } = init;
  const request = new Request(`http://localhost${path}`, {
    method, headers: { 'Content-Type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { res: await handler(request, env, new URL(request.url)) };
}
async function callJson(handler, env, path, init) {
  const { res } = await call(handler, env, path, init);
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

function stubFetch(surecart) {
  const authies = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.startsWith('https://api.surecart.com/')) {
      const r = typeof surecart === 'function' ? surecart(u) : surecart;
      return r instanceof Response ? r : new Response(JSON.stringify(r), { status: 200 });
    }
    if (u.startsWith('https://auth.ies.org/')) {
      authies.push({ path: new URL(u).pathname, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ grants: [] }), { status: 201 });
    }
    throw new Error(`unexpected fetch ${u}`);
  };
  return { authies, restore: () => { globalThis.fetch = real; } };
}
const PURCHASE = {
  id: 'p1', object: 'purchase', live_mode: true, revoked: false, created_at: Date.UTC(2026, 10, 2, 14) / 1000,
  customer: { id: 'c1', email: 'buyer@example.org', name: 'Pat' },
  product: { id: 'prod-rp8', name: 'RP-8', sku: 'ANSI/IES RP-8-25+E2', slug: 'rp-8', recurring: false },
  price: { id: 'price1' }, subscription: null, initial_order: { id: 'o1', number: '0042' },
};

let f;
afterEach(() => f?.restore());

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('gate', () => {
  it('refuses a caller with no bearer and no session', async () => {
    const env = makeEnv(makeRoute());
    const { status } = await callJson(handleAdminPurchases, env, '/api/admin/purchases', { headers: {} });
    expect([401, 403, 503]).toContain(status);
    const { res } = await call(handleAdminPurchasesCsv, env, '/api/admin/purchases.csv', { headers: {} });
    expect([401, 403, 503]).toContain(res.status);
  });
});

describe('GET /api/admin/purchases', () => {
  it('lists rows with the standard resolved, counts bucketed, and effective status', async () => {
    const rows = [
      ROW,
      { ...ROW, id: 8, surecart_purchase_id: 'p2', status: 'revoked', revoked_reason: 'surecart' },
      { ...ROW, id: 9, surecart_purchase_id: 'p3', kind: 'unmapped', standard_id: null, status: 'ignored', revoked_reason: 'unmapped', authies_applied_at: null },
      { ...ROW, id: 10, surecart_purchase_id: 'p4', authies_applied_at: null, authies_error: 'AuthIES unreachable' },
      { ...ROW, id: 11, surecart_purchase_id: 'p5', end_date: '2020-01-01' },
    ];
    const { status, body } = await callJson(handleAdminPurchases, makeEnv(makeRoute(rows)), '/api/admin/purchases');
    expect(status).toBe(200);
    expect(body.counts).toEqual({ all: 5, active: 2, revoked: 1, ignored: 1, expired: 1, unmapped: 1, pendingAuthies: 1 });
    expect(body.purchases[0]).toMatchObject({
      id: 7, email: 'buyer@example.org', kind: 'lease', effective_status: 'active',
      standard: { id: 'RP-8-25+E2', designation: 'ANSI/IES RP-8-25+E2', title: 'Roadway', libraryUrl: 'https://lighting.ies.org/2H4QTw' },
    });
    expect(body.purchases[2].standard).toBeNull();
    expect(body.purchases[4].effective_status).toBe('expired');
    expect(body.note).toBeUndefined();
  });

  it('filters by status and by text', async () => {
    const rows = [ROW, { ...ROW, id: 8, surecart_purchase_id: 'p2', email: 'other@example.org', status: 'revoked' }];
    const env = makeEnv(makeRoute(rows));
    expect((await callJson(handleAdminPurchases, env, '/api/admin/purchases?status=revoked')).body.purchases.map(p => p.id)).toEqual([8]);
    expect((await callJson(handleAdminPurchases, env, '/api/admin/purchases?q=other@')).body.purchases.map(p => p.id)).toEqual([8]);
    expect((await callJson(handleAdminPurchases, env, '/api/admin/purchases?pending=1')).body.purchases).toEqual([]);
  });

  it('fails soft with a note when the table is missing', async () => {
    const env = makeEnv((sql) => { if (/FROM purchases/.test(sql)) throw new Error('no such table: purchases'); return CATALOG; });
    const { status, body } = await callJson(handleAdminPurchases, env, '/api/admin/purchases');
    expect(status).toBe(200);
    expect(body.purchases).toEqual([]);
    expect(body.note).toMatch(/migration 0024/);
  });
});

describe('PATCH /api/admin/purchases/:id', () => {
  it('a staff revoke withdraws the AuthIES grant and marks the row revoked by staff', async () => {
    const env = makeEnv(makeRoute());
    f = stubFetch(PURCHASE);
    const { status, body } = await callJson(handleAdminPurchases, env, '/api/admin/purchases/7', { method: 'PATCH', body: { status: 'revoked', by: 'zoe@ies.org' } });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(f.authies).toEqual([{ path: '/api/comp-grants/revoke', body: { source: 'surecart', source_ref: 'surecart-p1', email: 'buyer@example.org', revoked_by: 'surecart' } }]);
    const update = env.DB.calls.find(c => /UPDATE purchases SET status = \?/.test(c.sql));
    expect(update.bindings).toEqual(['revoked', 'staff', 7]);
  });

  it('reinstate and retry re-sync the purchase from SureCart with force', async () => {
    const env = makeEnv(makeRoute([{ ...ROW, status: 'revoked', revoked_reason: 'staff' }]));
    f = stubFetch(PURCHASE);
    const { status, body } = await callJson(handleAdminPurchases, env, '/api/admin/purchases/7', { method: 'PATCH', body: { status: 'active' } });
    expect(status).toBe(200);
    expect(body.action).toBe('granted');
    expect(f.authies[0].path).toBe('/api/comp-grants');
    const again = await callJson(handleAdminPurchases, env, '/api/admin/purchases/7', { method: 'PATCH', body: { retry: true } });
    expect(again.body.action).toBe('granted');
    expect(f.authies).toHaveLength(2);
  });

  it('refuses an unknown id and an empty patch', async () => {
    const env = makeEnv(makeRoute());
    expect((await callJson(handleAdminPurchases, env, '/api/admin/purchases/99', { method: 'PATCH', body: { retry: true } })).status).toBe(404);
    expect((await callJson(handleAdminPurchases, env, '/api/admin/purchases/7', { method: 'PATCH', body: {} })).status).toBe(400);
  });
});

describe('POST sync and import', () => {
  it('sync by SureCart purchase id runs a forced sync', async () => {
    const env = makeEnv(makeRoute([]));
    f = stubFetch(PURCHASE);
    const { status, body } = await callJson(handleAdminPurchases, env, '/api/admin/purchases/sync', { method: 'POST', body: { purchase_id: 'p1' } });
    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true, action: 'granted' });
    expect((await callJson(handleAdminPurchases, env, '/api/admin/purchases/sync', { method: 'POST', body: {} })).status).toBe(400);
  });

  it('import walks one SureCart page, syncs each purchase, and reports hasMore', async () => {
    const env = makeEnv(makeRoute([]));
    const data = [PURCHASE, { ...PURCHASE, id: 'p2' }];
    f = stubFetch((u) => (u.includes('/purchases?') || u.endsWith('/purchases')
      ? { object: 'list', data }
      : data.find(p => u.includes(`/purchases/${p.id}`))));
    const { status, body } = await callJson(handleAdminPurchases, env, '/api/admin/purchases/import', { method: 'POST', body: { page: 1, limit: 2 } });
    expect(status).toBe(200);
    expect(body).toMatchObject({ page: 1, processed: 2, hasMore: true, errors: [] });
    expect(f.authies).toHaveLength(2);
  });

  it('import without an API key is refused with the reason', async () => {
    const env = makeEnv(makeRoute([]), { SURECART_API_KEY: '' });
    const { status, body } = await callJson(handleAdminPurchases, env, '/api/admin/purchases/import', { method: 'POST', body: { page: 1 } });
    expect(status).toBe(409);
    expect(body.error).toMatch(/SURECART_API_KEY/);
  });
});

describe('CSV', () => {
  it('exports formula-safe rows', async () => {
    const env = makeEnv(makeRoute([{ ...ROW, name: '=HYPERLINK("x")' }]));
    const { res } = await call(handleAdminPurchasesCsv, env, '/api/admin/purchases.csv');
    const text = await res.text();
    expect(res.headers.get('Content-Type')).toMatch(/text\/csv/);
    expect(text.split('\r\n')[0]).toMatch(/^email,name,kind,standard,/);
    expect(text).toContain("'=HYPERLINK");
    expect(text).toContain('ANSI/IES RP-8-25+E2');
  });
});

describe('effectivePurchaseStatus', () => {
  it('derives expired from the end date', () => {
    expect(effectivePurchaseStatus({ status: 'active', end_date: '2020-01-01' }, '2026-11-02')).toBe('expired');
    expect(effectivePurchaseStatus({ status: 'active', end_date: '2029-11-01' }, '2026-11-02')).toBe('active');
    expect(effectivePurchaseStatus({ status: 'revoked', end_date: '2029-11-01' }, '2026-11-02')).toBe('revoked');
    expect(effectivePurchaseStatus({ status: 'ignored', end_date: '2020-01-01' }, '2026-11-02')).toBe('ignored');
  });
});
