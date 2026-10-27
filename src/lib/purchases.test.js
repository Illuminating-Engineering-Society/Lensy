import { describe, it, expect } from 'vitest';
import {
  resolveStandardForProduct, skuToStandardId, upsertPurchase, findPurchaseBySurecartId,
  listPurchasesBySubscription, stampAuthies, stampNotify, setPurchaseStatus,
} from './purchases';
import { normalizePurchase } from './surecart';

// The D1 half of SureCart purchases (2026-10-26): which standard a store
// product is, and the purchases table as the sync and the dashboard read it.

/** SQL-shape-routed D1 stub (the comp-access test pattern). */
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

const CATALOG = [
  { id: 'RP-8-25+E2', full_designation: 'ANSI/IES RP-8-25+E2', title: 'Recommended Practice: Lighting Roadway and Parking Facilities', status: 'Active',
    buy_url: 'https://store.ies.org/product/recommended-practice-lighting-roadway-and-parking-facilities/', vitrium_doc_id: 'doc-guid-rp8', vitrium_web_url: 'https://view.protectedpdf.com/2H4QTw' },
  { id: 'RP-8-25+E1', full_designation: 'ANSI/IES RP-8-25+E1', title: 'Older printing', status: 'Deprecated', buy_url: null, vitrium_doc_id: 'doc-guid-rp8-e1', vitrium_web_url: null },
  { id: 'LM-49-20', full_designation: 'IES LM-49-20', title: 'LM-49-20', status: 'Active', buy_url: null, vitrium_doc_id: 'doc-guid-lm49', vitrium_web_url: null },
  { id: 'LM-79-24', full_designation: 'ANSI/IES LM-79-24', title: 'Optical and Electrical Measurements', status: 'Active',
    buy_url: 'https://store.ies.org/product/lm-79-24-approved-method/', vitrium_doc_id: null, vitrium_web_url: 'https://view.protectedpdf.com/abc123' },
  // The reaffirmed-and-errata printing id shape the catalogue actually holds.
  { id: 'LS-4-20+R2023+E1', full_designation: 'ANSI/IES LS-4-20(R2023)+E1', title: 'Measurement of Light', status: 'Active',
    buy_url: 'https://store.ies.org/product/lighting-science-measurement-of-light-the-science-of-photometry/?v=0b3b97fa6688', vitrium_doc_id: 'doc-guid-ls4', vitrium_web_url: null },
];
const catalogDb = () => makeDb((sql) => (/FROM standards/.test(sql) ? CATALOG : null));

describe('skuToStandardId', () => {
  it('turns the store SKU into an id', () => {
    expect(skuToStandardId('ANSI/IES RP-8-25+E2')).toBe('RP-8-25+E2');
    expect(skuToStandardId('ANSI/IES LM-49-20(R2023)')).toBe('LM-49-20');
    expect(skuToStandardId('IES LM-49-20 (R2023)')).toBe('LM-49-20');
    expect(skuToStandardId('ANSI/ASHRAE/IES 90.1-2025')).toBe('ASHRAE-IES-90.1-2025');
    expect(skuToStandardId('IES-2017-ACP')).toBeNull();
    expect(skuToStandardId(null)).toBeNull();
  });

  // The live store (read 2026-10-27): member/non-member duplicates carry a
  // "-MEMBER" / "-NONMEMBER" suffix, reaffirmations print as "(R25)" as well
  // as "(R2023)", joint standards carry the partner body after IES, and the
  // 90.1 product appends "-Lighting Only".
  it('reads the store\'s suffixes, two-digit reaffirmations and joint prefixes', () => {
    expect(skuToStandardId('ANSI/IES LM-9-20 (R2023)-MEMBER')).toBe('LM-9-20');
    expect(skuToStandardId('ANSI/IES LM-66-20(R2023)-MEMBER')).toBe('LM-66-20');
    expect(skuToStandardId('ANSI/IES RP-30-25-MEMBER')).toBe('RP-30-25');
    expect(skuToStandardId('ANSI/IES LM-91-22-NONMEMBER')).toBe('LM-91-22');
    expect(skuToStandardId('IES TM-18-18-MEMBER')).toBe('TM-18-18');
    expect(skuToStandardId('ANSI/IES LS-6-20(R25)')).toBe('LS-6-20');
    expect(skuToStandardId('ANSI/IES TM-25-20(R25)')).toBe('TM-25-20');
    expect(skuToStandardId('ANSI/IES/IUVA LM-92-22')).toBe('LM-92-22');
    expect(skuToStandardId('ANSI/IES/ALA RP-11-26')).toBe('RP-11-26');
    expect(skuToStandardId('ANSI/IES/AVIXA RP-38-17 (R2022)')).toBe('RP-38-17');
    expect(skuToStandardId('ANSI/ASHRAE/IES-90.1-2025-Lighting Only')).toBe('ASHRAE-IES-90.1-2025');
  });
});

describe('resolveStandardForProduct', () => {
  it('matches the store permalink slug first, carrying the Vitrium id and the branded Library link', async () => {
    const r = await resolveStandardForProduct(catalogDb(), { slug: 'recommended-practice-lighting-roadway-and-parking-facilities', sku: 'ANSI/IES LM-49-20' });
    expect(r).toEqual({
      id: 'RP-8-25+E2', designation: 'ANSI/IES RP-8-25+E2', title: 'Recommended Practice: Lighting Roadway and Parking Facilities',
      vitriumDocId: 'doc-guid-rp8', libraryUrl: 'https://lighting.ies.org/2H4QTw',
    });
  });

  it('falls back to the SKU, with the reaffirmation marker stripped and a bare title turned null', async () => {
    const r = await resolveStandardForProduct(catalogDb(), { slug: 'nothing-like-it', sku: 'ANSI/IES LM-49-20(R2023)' });
    expect(r).toMatchObject({ id: 'LM-49-20', title: null, libraryUrl: null });
  });

  it('a SKU naming an edition with no row resolves to the newest Active printing of that edition', async () => {
    const r = await resolveStandardForProduct(catalogDb(), { slug: null, sku: 'ANSI/IES RP-8-25' });
    expect(r?.id).toBe('RP-8-25+E2');
  });

  // SureCart's product slug and the WordPress permalink in buy_url usually
  // agree; the store's member-priced duplicates add "-member" to the slug.
  it('a "-member" / "-non-member" product slug still finds the lease link', async () => {
    const r = await resolveStandardForProduct(catalogDb(), { slug: 'recommended-practice-lighting-roadway-and-parking-facilities-member', sku: null });
    expect(r?.id).toBe('RP-8-25+E2');
    const r2 = await resolveStandardForProduct(catalogDb(), { slug: 'lm-79-24-approved-method-non-member', sku: null });
    expect(r2?.id).toBe('LM-79-24');
  });

  it('a reaffirmed SKU resolves to the catalogue\'s "+R2023+E1" printing of that edition', async () => {
    const r = await resolveStandardForProduct(catalogDb(), { slug: 'nothing-like-it', sku: 'ANSI/IES LS-4-20(R2023)' });
    expect(r?.id).toBe('LS-4-20+R2023+E1');
  });

  it('an unknown product is null; a D1 failure throws (never "unmapped")', async () => {
    expect(await resolveStandardForProduct(catalogDb(), { slug: 'ies-2017-acp', sku: 'IES-2017-ACP' })).toBeNull();
    await expect(resolveStandardForProduct(makeDb(() => { throw new Error('boom'); }), { slug: 'x', sku: 'ANSI/IES RP-8-25+E2' })).rejects.toThrow('boom');
  });
});

const PURCHASE = normalizePurchase({
  id: 'p1', object: 'purchase', live_mode: true, revoked: false, created_at: 1762093800,
  customer: { id: 'c1', email: 'Buyer@Example.org', name: 'Pat' },
  product: { id: 'prod1', name: 'RP-8', sku: 'ANSI/IES RP-8-25+E2', slug: 'rp-8', recurring: false },
  price: { id: 'price1' }, subscription: { id: 'sub1', status: 'active', current_period_end_at: 1793629800 },
  initial_order: { id: 'o1', number: '0042' },
});
const PLAN = { kind: 'lease', standardId: 'RP-8-25+E2', startDate: '2026-11-02', endDate: '2029-11-01', status: 'active', revokedReason: null };

describe('upsertPurchase', () => {
  it('writes one row per SureCart purchase id, lowercased email, and keeps the push/notify stamps on conflict', async () => {
    const db = makeDb((sql, b) => (/INSERT INTO purchases/.test(sql) ? { id: 7, surecart_purchase_id: b[0], email: b[8] } : null));
    const row = await upsertPurchase(db, PURCHASE, PLAN, 'purchase.created');
    expect(row).toMatchObject({ id: 7, email: 'buyer@example.org' });
    const { sql, bindings } = db.calls[0];
    expect(sql).toMatch(/ON CONFLICT\s*\(surecart_purchase_id\) DO UPDATE/);
    expect(sql).not.toMatch(/authies_applied_at = excluded/);
    expect(sql).not.toMatch(/notify_sent_at = excluded/);
    expect(sql).toMatch(/RETURNING \*/);
    expect(bindings).toEqual([
      'p1', 'o1', '0042', 'c1', 'prod1', 'price1', 'sub1', 1,
      'buyer@example.org', 'Pat', 'RP-8', 'ANSI/IES RP-8-25+E2', 'rp-8',
      'lease', 'RP-8-25+E2', '2026-11-02', '2029-11-01', 'active', null, 'purchase.created',
    ]);
  });
});

describe('reads and stamps', () => {
  it('finds by SureCart id and by subscription', async () => {
    const db = makeDb((sql, b) => {
      if (/WHERE surecart_purchase_id = \?/.test(sql)) return { id: 1, surecart_purchase_id: b[0] };
      if (/WHERE surecart_subscription_id = \?/.test(sql)) return [{ id: 1 }, { id: 2 }];
      return null;
    });
    expect(await findPurchaseBySurecartId(db, 'p1')).toMatchObject({ id: 1 });
    expect((await listPurchasesBySubscription(db, 'sub1')).map(r => r.id)).toEqual([1, 2]);
  });

  it('stampAuthies: success clears the error and stamps the time; failure writes only the error', async () => {
    const db = makeDb(() => ({ meta: { changes: 1 } }));
    await stampAuthies(db, 7, { ok: true });
    expect(db.calls[0].sql).toMatch(/authies_applied_at = datetime\('now'\), authies_error = NULL/);
    await stampAuthies(db, 7, { ok: false, error: 'AuthIES answered 400: nope' });
    expect(db.calls[1].sql).toMatch(/SET authies_error = \?/);
    expect(db.calls[1].sql).not.toMatch(/authies_applied_at/);
    expect(db.calls[1].bindings).toEqual(['AuthIES answered 400: nope', 7]);
  });

  it('stampNotify and setPurchaseStatus', async () => {
    const db = makeDb(() => ({ meta: { changes: 1 } }));
    await stampNotify(db, 7, { sent: true });
    expect(db.calls[0].sql).toMatch(/notify_sent_at = datetime\('now'\), notify_error = NULL/);
    await stampNotify(db, 7, { sent: false, error: 'bounced' });
    expect(db.calls[1].bindings).toEqual(['bounced', 7]);
    await setPurchaseStatus(db, 7, 'revoked', 'staff');
    expect(db.calls[2].bindings).toEqual(['revoked', 'staff', 7]);
  });
});
