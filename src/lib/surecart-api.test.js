import { describe, it, expect, afterEach } from 'vitest';
import { fetchPurchase, listPurchases, surecartConfigured, SURECART_API } from './surecart-api';

// The SureCart API client (2026-10-26). Read-only: purchases, expanded. The
// webhook body is a trigger; what these calls return is the truth a grant is
// built from, so the exact expand list matters.

const PURCHASE = {
  id: 'p1', object: 'purchase', live_mode: true, revoked: false, created_at: 1762093800,
  customer: { id: 'c1', object: 'customer', email: 'buyer@example.org', name: 'Pat' },
  product: { id: 'prod1', object: 'product', name: 'RP-8', sku: 'ANSI/IES RP-8-25+E2', slug: 'rp-8', recurring: false },
  price: { id: 'price1' }, subscription: null, initial_order: { id: 'o1', number: '0042' },
};

function stubFetch(responder) {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), headers: init.headers || {} });
    return responder(String(url));
  };
  return { calls, restore: () => { globalThis.fetch = real; } };
}
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const ENV = { SURECART_API_KEY: 'sk_test' };
let f;
afterEach(() => f?.restore());

describe('fetchPurchase', () => {
  it('asks for the purchase with the five expansions and the bearer', async () => {
    f = stubFetch(() => json(PURCHASE));
    const r = await fetchPurchase(ENV, 'p1');
    expect(r.ok).toBe(true);
    expect(r.purchase.email).toBe('buyer@example.org');
    const u = new URL(f.calls[0].url);
    expect(`${u.origin}${u.pathname}`).toBe(`${SURECART_API}/purchases/p1`);
    expect(u.searchParams.getAll('expand[]')).toEqual(['customer', 'product', 'price', 'subscription', 'initial_order']);
    expect(f.calls[0].headers.Authorization).toBe('Bearer sk_test');
  });

  it('reports a missing key, a 404, and a body without a customer email', async () => {
    f = stubFetch(() => json({ error: 'nope' }, 404));
    expect(await fetchPurchase({}, 'p1')).toEqual({ ok: false, error: 'SURECART_API_KEY is not set' });
    expect(f.calls).toHaveLength(0);
    expect(await fetchPurchase(ENV, 'p1')).toMatchObject({ ok: false, status: 404 });
    f.restore();
    f = stubFetch(() => json({ ...PURCHASE, customer: 'c1' }));
    const r = await fetchPurchase(ENV, 'p1');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/customer/);
  });

  it('never throws when the network fails', async () => {
    f = stubFetch(() => { throw new Error('ECONNRESET'); });
    expect(await fetchPurchase(ENV, 'p1')).toMatchObject({ ok: false, error: expect.stringMatching(/ECONNRESET/) });
  });
});

describe('listPurchases', () => {
  it('pages through /purchases and reports hasMore from the page size', async () => {
    f = stubFetch(() => json({ object: 'list', pagination: { count: 1, limit: 100, page: 2 }, data: [PURCHASE] }));
    const r = await listPurchases(ENV, 2);
    expect(r.ok).toBe(true);
    expect(r.purchases.map(p => p.id)).toEqual(['p1']);
    expect(r.hasMore).toBe(false);
    const u = new URL(f.calls[0].url);
    expect(u.pathname).toBe('/v1/purchases');
    expect(u.searchParams.get('page')).toBe('2');
    expect(u.searchParams.get('limit')).toBe('100');
    expect(u.searchParams.getAll('expand[]')).toContain('customer');
  });

  it('a full page means there may be more, and unexpandable rows are skipped and counted', async () => {
    const data = Array.from({ length: 3 }, (_, i) => ({ ...PURCHASE, id: `p${i}` }));
    data[1] = { ...data[1], customer: 'c-unexpanded' };
    f = stubFetch(() => json({ object: 'list', data }));
    const r = await listPurchases(ENV, 1, 3);
    expect(r.purchases.map(p => p.id)).toEqual(['p0', 'p2']);
    expect(r.skipped).toBe(1);
    expect(r.hasMore).toBe(true);
  });
});

describe('surecartConfigured', () => {
  it('needs the API key', () => {
    expect(surecartConfigured({})).toBe(false);
    expect(surecartConfigured({ SURECART_API_KEY: ' ' })).toBe(false);
    expect(surecartConfigured(ENV)).toBe(true);
  });
});
