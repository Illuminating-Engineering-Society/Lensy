import { describe, it, expect } from 'vitest';
import { hasActiveLensComp, compSourceRef, compGrantsConfigured } from './comp-grants';

// Client 10/16/26 #6: a complimentary FULL IES Lens grant raises the session to
// tier 'full' for its window. The check runs on every gated request.
describe('hasActiveLensComp', () => {
  const env = (first) => {
    const calls = [];
    return {
      calls,
      DB: { prepare: (sql) => ({ bind: (...b) => { calls.push({ sql, b }); return { first: async () => first(sql, b) }; } }) },
    };
  };

  it('asks for a live lens-scope row by lowercased email', async () => {
    const e = env(() => ({ ok: 1 }));
    expect(await hasActiveLensComp(e, ' Guest@Example.com ')).toBe(true);
    expect(e.calls[0].b).toEqual(['guest@example.com']);
    expect(e.calls[0].sql).toMatch(/scope = 'lens'/);
    expect(e.calls[0].sql).toMatch(/status = 'active'/);
    expect(e.calls[0].sql).toMatch(/start_date <= date\('now'\) AND end_date >= date\('now'\)/);
  });

  it('is false without a row, without an email, and when D1 fails (a comp only ever adds)', async () => {
    expect(await hasActiveLensComp(env(() => null), 'a@b.org')).toBe(false);
    expect(await hasActiveLensComp(env(() => ({ ok: 1 })), '')).toBe(false);
    expect(await hasActiveLensComp(env(() => { throw new Error('no such column: scope'); }), 'a@b.org')).toBe(false);
  });

  it('names the AuthIES source_ref after the row, and needs the shared secret', () => {
    expect(compSourceRef(42)).toBe('lens-comp-42');
    expect(compGrantsConfigured({})).toBe(false);
    expect(compGrantsConfigured({ COMP_GRANTS_API_SECRET: ' x ' })).toBe(true);
  });
});

// ─── SureCart purchases (2026-10-26) ──────────────────────────────────────────
// A webstore purchase rides the same AuthIES API as a staff comp, with
// source = 'surecart' and a source_ref derived from SureCart's purchase id, so
// a resync or a renewal UPDATES the grant instead of stacking a second one.

import { pushPurchaseGrant, revokePurchaseGrant, purchaseSourceRef, hasActivePurchasedSubscription } from './comp-grants';

function stubFetch(status = 201) {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), auth: init.headers.Authorization, body: JSON.parse(init.body) });
    return new Response(JSON.stringify(status < 300 ? { grants: [] } : { error: 'nope' }), { status });
  };
  return { calls, restore: () => { globalThis.fetch = real; } };
}
const AUTH_ENV = { COMP_GRANTS_API_SECRET: 's3cret', AUTH_IDP_BASE_URL: 'https://auth.ies.org' };

describe('pushPurchaseGrant / revokePurchaseGrant', () => {
  it('a lease lands as a documents grant with source surecart', async () => {
    const f = stubFetch();
    try {
      const out = await pushPurchaseGrant(AUTH_ENV, 'https://lens.ies.org/api/webhooks/surecart', {
        surecartPurchaseId: 'p1', email: 'buyer@example.org', kind: 'documents',
        documents: ['doc-guid-rp8'], labels: ['RP-8-25+E2'],
        startDate: '2026-11-02', endDate: '2029-11-01', note: 'SureCart order #0042',
      });
      expect(out).toEqual({ ok: true });
      expect(f.calls[0].url).toBe('https://auth.ies.org/api/comp-grants');
      expect(f.calls[0].auth).toBe('Bearer s3cret');
      expect(f.calls[0].body).toEqual({
        email: 'buyer@example.org', kind: 'documents', documents: ['doc-guid-rp8'], labels: ['RP-8-25+E2'],
        starts_at: '2026-11-02', expires_at: '2029-11-01',
        source: 'surecart', source_ref: 'surecart-p1', granted_by: 'surecart', note: 'SureCart order #0042',
      });
    } finally { f.restore(); }
  });

  it('a subscription lands as a subscriber grant with no documents', async () => {
    const f = stubFetch();
    try {
      await pushPurchaseGrant(AUTH_ENV, 'https://lens.ies.org/', {
        surecartPurchaseId: 'p2', email: 'buyer@example.org', kind: 'subscriber', documents: [], labels: [],
        startDate: '2026-11-02', endDate: '2027-11-02', note: null,
      });
      expect(f.calls[0].body.kind).toBe('subscriber');
      expect(f.calls[0].body.documents).toBeUndefined();
      expect(f.calls[0].body.source_ref).toBe('surecart-p2');
    } finally { f.restore(); }
  });

  it('revokes by source + source_ref + email, and reports a refusal without throwing', async () => {
    const f = stubFetch();
    try {
      expect(await revokePurchaseGrant(AUTH_ENV, 'https://lens.ies.org/', 'p1')).toEqual({ ok: true });
      expect(f.calls[0].url).toBe('https://auth.ies.org/api/comp-grants/revoke');
      expect(f.calls[0].body).toEqual({ source: 'surecart', source_ref: 'surecart-p1', revoked_by: 'surecart' });
    } finally { f.restore(); }
    const g = stubFetch(400);
    try {
      const out = await pushPurchaseGrant(AUTH_ENV, 'https://lens.ies.org/', {
        surecartPurchaseId: 'p1', email: 'buyer@example.org', kind: 'documents', documents: ['d'], labels: [],
        startDate: '2026-11-02', endDate: '2029-11-01', note: null,
      });
      expect(out).toEqual({ ok: false, error: 'AuthIES answered 400: nope' });
    } finally { g.restore(); }
    expect(purchaseSourceRef('abc')).toBe('surecart-abc');
  });
});

describe('hasActivePurchasedSubscription', () => {
  const env = (first) => {
    const calls = [];
    return {
      calls,
      DB: { prepare: (sql) => ({ bind: (...b) => { calls.push({ sql, b }); return { first: async () => first(sql, b) }; } }) },
    };
  };

  it('asks for a live subscription purchase by lowercased email', async () => {
    const e = env(() => ({ ok: 1 }));
    expect(await hasActivePurchasedSubscription(e, ' Buyer@Example.org ')).toBe(true);
    expect(e.calls[0].b).toEqual(['buyer@example.org']);
    expect(e.calls[0].sql).toMatch(/FROM purchases/);
    expect(e.calls[0].sql).toMatch(/kind = 'subscription'/);
    expect(e.calls[0].sql).toMatch(/status = 'active'/);
    expect(e.calls[0].sql).toMatch(/start_date <= date\('now'\) AND end_date >= date\('now'\)/);
  });

  // The store sells "Lighting Library (Full Access)" AND "Lighting Library
  // with IES Lens (Full Access)" (read 2026-10-27): both are Library
  // subscriptions in Vitrium, only the second includes IES Lens.
  it('with SURECART_LENS_PRODUCTS set, only those subscription products lift the Lens tier', async () => {
    const e = env(() => ({ ok: 1 }));
    e.SURECART_LENS_PRODUCTS = ' prod-lens, prod-lens-2 ,';
    expect(await hasActivePurchasedSubscription(e, 'buyer@example.org')).toBe(true);
    expect(e.calls[0].sql).toMatch(/surecart_product_id IN \(\?, \?\)/);
    expect(e.calls[0].b).toEqual(['buyer@example.org', 'prod-lens', 'prod-lens-2']);
    const plain = env(() => ({ ok: 1 }));
    await hasActivePurchasedSubscription(plain, 'buyer@example.org');
    expect(plain.calls[0].sql).not.toMatch(/surecart_product_id/);
  });

  it('is false without a row, without an email, and when D1 fails (a purchase only ever adds)', async () => {
    expect(await hasActivePurchasedSubscription(env(() => null), 'a@b.org')).toBe(false);
    expect(await hasActivePurchasedSubscription(env(() => ({ ok: 1 })), '')).toBe(false);
    expect(await hasActivePurchasedSubscription(env(() => { throw new Error('no such table: purchases'); }), 'a@b.org')).toBe(false);
  });
});
