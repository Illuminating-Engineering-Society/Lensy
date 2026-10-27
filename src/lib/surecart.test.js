import { describe, it, expect } from 'vitest';
import {
  verifyWebhookSignature, readSurecartConfig, parseWebhookEvent, normalizePurchase,
  planPurchase, slugFromStoreUrl, dayUtc, addDays,
} from './surecart';

// The pure half of the SureCart integration (2026-10-26): the signature rule
// SureCart documents (hex HMAC-SHA256 over "<timestamp>.<body>"), the config
// defaults, and how a purchase becomes a lease / subscription / nothing.

async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}

const NOW = new Date('2026-11-02T15:00:00Z');
const CFG = readSurecartConfig({});

/** An expanded SureCart purchase, as /v1/purchases/:id?expand[]=… returns it. */
function purchase(over = {}) {
  return normalizePurchase({
    id: 'p1', object: 'purchase', live_mode: true, revoked: false, revoked_at: null,
    created_at: Date.UTC(2026, 10, 2, 14, 30) / 1000,
    customer: { id: 'c1', object: 'customer', email: 'Buyer@Example.org', name: 'Pat Buyer' },
    product: { id: 'prod1', object: 'product', name: 'Recommended Practice: Lighting Roadway and Parking Facilities', sku: 'ANSI/IES RP-8-25+E2', slug: 'recommended-practice-lighting-roadway-and-parking-facilities', recurring: false },
    price: { id: 'price1', object: 'price' },
    subscription: null,
    initial_order: { id: 'o1', object: 'order', number: '0042' },
    ...over,
  });
}

describe('verifyWebhookSignature', () => {
  it('accepts the documented signature within the tolerance, and refuses stale, altered or missing ones', async () => {
    const body = '{"id":"evt"}';
    const ts = '1641873601';
    const sig = await hmacHex('whsec', `${ts}.${body}`);
    expect(await verifyWebhookSignature('whsec', ts, body, sig, 1641873601 + 60)).toBe('ok');
    expect(await verifyWebhookSignature('whsec', ts, body, sig, 1641873601 + 600)).toBe('stale');
    expect(await verifyWebhookSignature('whsec', ts, body + ' ', sig, 1641873601)).toBe('mismatch');
    expect(await verifyWebhookSignature('other', ts, body, sig, 1641873601)).toBe('mismatch');
    expect(await verifyWebhookSignature('whsec', null, body, sig, 1641873601)).toBe('missing');
    expect(await verifyWebhookSignature('whsec', ts, body, null, 1641873601)).toBe('missing');
    expect(await verifyWebhookSignature('whsec', 'not-a-number', body, sig, 1641873601)).toBe('stale');
  });
});

describe('readSurecartConfig', () => {
  it('reads defaults and overrides', () => {
    expect(readSurecartConfig({})).toEqual({
      leaseDays: 1096, subscriptionDays: 365, subscriptionProducts: new Set(), leasePrices: new Set(),
      purchasesSince: '2026-11-02', acceptTestMode: false, notify: true,
    });
    const c = readSurecartConfig({
      SURECART_LEASE_DAYS: '30', SURECART_SUBSCRIPTION_DAYS: 'nope',
      SURECART_SUBSCRIPTION_PRODUCTS: ' p1, p2 ,', SURECART_ACCEPT_TEST_MODE: 'on', SURECART_NOTIFY: 'off',
    });
    expect(c.leaseDays).toBe(30);
    expect(c.subscriptionDays).toBe(365);
    expect([...c.subscriptionProducts]).toEqual(['p1', 'p2']);
    expect(c.acceptTestMode).toBe(true);
    expect(c.notify).toBe(false);
  });
});

describe('parseWebhookEvent / normalizePurchase', () => {
  it('reads the event envelope', () => {
    expect(parseWebhookEvent({ id: 'e', object: 'event', type: 'purchase.created', data: { object: { id: 'p1', object: 'purchase', live_mode: false } } }))
      .toEqual({ type: 'purchase.created', objectId: 'p1', objectType: 'purchase', liveMode: false });
    expect(parseWebhookEvent({ type: 'order.paid' })).toBeNull();
    expect(parseWebhookEvent('nope')).toBeNull();
  });

  it('needs an expanded customer email, and lowercases it', () => {
    expect(purchase().email).toBe('buyer@example.org');
    expect(purchase().name).toBe('Pat Buyer');
    expect(purchase().orderNumber).toBe('0042');
    expect(normalizePurchase({ id: 'p1', object: 'purchase', customer: 'c1' })).toBeNull();
    expect(normalizePurchase({ id: 'p1', object: 'order' })).toBeNull();
  });

  it('tolerates unexpanded product and subscription ids', () => {
    const p = purchase({ product: 'prod9', subscription: 'sub9' });
    expect(p.product).toEqual({ id: 'prod9', name: null, sku: null, slug: null, recurring: null });
    expect(p.subscription).toEqual({ id: 'sub9', status: null, currentPeriodStartAt: null, currentPeriodEndAt: null, cancelAtPeriodEnd: null });
  });
});

describe('planPurchase', () => {
  it('a lease runs 1096 days inclusive from the purchase day', () => {
    expect(planPurchase(purchase(), { id: 'RP-8-25+E2' }, CFG, NOW)).toEqual({
      kind: 'lease', standardId: 'RP-8-25+E2', startDate: '2026-11-02', endDate: '2029-11-01',
      status: 'active', revokedReason: null,
    });
  });

  it('a subscription ends on the SureCart period end', () => {
    const p = purchase({ subscription: { id: 's1', object: 'subscription', status: 'active', current_period_end_at: Date.UTC(2027, 10, 2, 3) / 1000, cancel_at_period_end: false } });
    const plan = planPurchase(p, null, CFG, NOW);
    expect(plan.kind).toBe('subscription');
    expect(plan.standardId).toBeNull();
    expect(plan.endDate).toBe('2027-11-02');
    expect(plan.status).toBe('active');
  });

  it('a subscription with no period falls back to the configured days', () => {
    const p = purchase({ product: { id: 'sub-prod', name: 'Lighting Library', sku: null, slug: 'lighting-library', recurring: false } });
    const cfg = readSurecartConfig({ SURECART_SUBSCRIPTION_PRODUCTS: 'sub-prod' });
    expect(planPurchase(p, null, cfg, NOW)).toMatchObject({ kind: 'subscription', endDate: '2027-11-01' });
  });

  // The live store (2026-10-27) sells IES memberships (Bronze $1,350, Student
  // $35, Diamond $25,000…) and the Illuminance Selector as recurring products
  // too. Once the Library subscription products are listed, nothing else
  // recurring may grant Library access.
  it('with SURECART_SUBSCRIPTION_PRODUCTS set, a recurring product NOT listed is unmapped, not a subscription', () => {
    const cfg = readSurecartConfig({ SURECART_SUBSCRIPTION_PRODUCTS: 'sub-prod' });
    const bronze = purchase({
      product: { id: 'bronze', name: 'Bronze', sku: null, slug: 'bronze', recurring: true },
      subscription: { id: 's9', status: 'active', current_period_end_at: Date.UTC(2027, 10, 2) / 1000 },
    });
    expect(planPurchase(bronze, null, cfg, NOW)).toMatchObject({ kind: 'unmapped', status: 'ignored', revokedReason: 'unmapped' });
    const listed = purchase({
      product: { id: 'sub-prod', name: 'Lighting Library (Full Access)', sku: null, slug: 'lighting-library', recurring: true },
      subscription: { id: 's1', status: 'active', current_period_end_at: Date.UTC(2027, 10, 2) / 1000 },
    });
    expect(planPurchase(listed, null, cfg, NOW).kind).toBe('subscription');
  });

  it('a listed subscription product is a subscription even when it maps to a standard', () => {
    const cfg = readSurecartConfig({ SURECART_SUBSCRIPTION_PRODUCTS: 'prod1' });
    expect(planPurchase(purchase(), { id: 'RP-8-25+E2' }, cfg, NOW).kind).toBe('subscription');
  });

  it('a revoked purchase plans as revoked by surecart', () => {
    expect(planPurchase(purchase({ revoked: true, revoked_at: 1 }), { id: 'RP-8-25+E2' }, CFG, NOW))
      .toMatchObject({ kind: 'lease', status: 'revoked', revokedReason: 'surecart' });
  });

  it('a canceled subscription stays active until its period ends', () => {
    const sub = (end, status) => purchase({ subscription: { id: 's1', status, current_period_end_at: end, cancel_at_period_end: true } });
    const future = Date.UTC(2027, 0, 1) / 1000;
    const past = Date.UTC(2026, 9, 1) / 1000;
    expect(planPurchase(sub(future, 'canceled'), null, CFG, NOW).status).toBe('active');
    expect(planPurchase(sub(past, 'canceled'), null, CFG, NOW)).toMatchObject({ status: 'revoked', revokedReason: 'surecart' });
    expect(planPurchase(sub(past, 'completed'), null, CFG, NOW).status).toBe('revoked');
    expect(planPurchase(sub(past, 'active'), null, CFG, NOW).status).toBe('active');
  });

  it('a test-mode purchase is ignored unless accepted', () => {
    const p = purchase({ live_mode: false });
    expect(planPurchase(p, { id: 'RP-8-25+E2' }, CFG, NOW)).toMatchObject({ kind: 'lease', status: 'ignored', revokedReason: 'test_mode' });
    expect(planPurchase(p, { id: 'RP-8-25+E2' }, readSurecartConfig({ SURECART_ACCEPT_TEST_MODE: 'on' }), NOW).status).toBe('active');
  });

  it('an unmapped product grants nothing', () => {
    expect(planPurchase(purchase(), null, CFG, NOW)).toMatchObject({ kind: 'unmapped', standardId: null, status: 'ignored', revokedReason: 'unmapped' });
  });
});

describe('dates and slugs', () => {
  it('dayUtc / addDays', () => {
    expect(dayUtc(Date.UTC(2026, 10, 2, 23, 59) / 1000)).toBe('2026-11-02');
    expect(addDays('2026-11-02', 1095)).toBe('2029-11-01');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
  });

  it('slugFromStoreUrl reads the permalink', () => {
    expect(slugFromStoreUrl('https://store.ies.org/product/recommended-practice-lighting-roadway-and-parking-facilities/'))
      .toBe('recommended-practice-lighting-roadway-and-parking-facilities');
    expect(slugFromStoreUrl('https://store.ies.org/product/rp-1-24')).toBe('rp-1-24');
    expect(slugFromStoreUrl('https://store.ies.org/?s=RP-8')).toBeNull();
    expect(slugFromStoreUrl(null)).toBeNull();
  });
});

// ─── Review fixes (2026-10-26) ────────────────────────────────────────────────

describe('the cutover floor and the lease price allowlist (review C1)', () => {
  it('a purchase made before SURECART_PURCHASES_SINCE is recorded as ignored and grants nothing', () => {
    expect(readSurecartConfig({}).purchasesSince).toBe('2026-11-02');
    const early = purchase({ created_at: Date.UTC(2026, 9, 15) / 1000 });
    expect(planPurchase(early, { id: 'RP-8-25+E2' }, CFG, NOW)).toMatchObject({ kind: 'lease', status: 'ignored', revokedReason: 'before_cutover' });
    const cfg = readSurecartConfig({ SURECART_PURCHASES_SINCE: '2026-10-01' });
    expect(planPurchase(early, { id: 'RP-8-25+E2' }, cfg, NOW).status).toBe('active');
  });

  // The floor exists because a standard bought before 11/2 was a PDF. A
  // Library SUBSCRIPTION bought before 11/2 is a subscription all the same
  // (the store sold "Lighting Library (Full Access)" on 2026-10-27): its
  // window is its current billing period, so only a live period grants.
  it('the cutover floor applies to leases only — an earlier subscription purchase is live for its period', () => {
    const cfg = readSurecartConfig({ SURECART_SUBSCRIPTION_PRODUCTS: 'sub-prod' });
    const early = purchase({
      created_at: Date.UTC(2026, 9, 27) / 1000,
      product: { id: 'sub-prod', name: 'Lighting Library (Full Access)', sku: null, slug: 'lighting-library', recurring: true },
      subscription: { id: 's1', status: 'active', current_period_start_at: Date.UTC(2026, 9, 27) / 1000, current_period_end_at: Date.UTC(2027, 9, 27) / 1000 },
    });
    expect(planPurchase(early, null, cfg, NOW)).toMatchObject({ kind: 'subscription', status: 'active', startDate: '2026-10-27', endDate: '2027-10-27' });
  });

  it('with SURECART_LEASE_PRICES set, only a listed price is a lease; another price of the same product is not', () => {
    const cfg = readSurecartConfig({ SURECART_LEASE_PRICES: 'price-lease' });
    expect(planPurchase(purchase({ price: { id: 'price-lease' } }), { id: 'RP-8-25+E2' }, cfg, NOW).kind).toBe('lease');
    expect(planPurchase(purchase({ price: { id: 'price-pdf' } }), { id: 'RP-8-25+E2' }, cfg, NOW))
      .toMatchObject({ kind: 'unmapped', status: 'ignored', revokedReason: 'not_a_lease' });
    expect(planPurchase(purchase({ price: { id: 'price-pdf' } }), { id: 'RP-8-25+E2' }, CFG, NOW).kind).toBe('lease');
  });
});

describe('a subscription window follows the current period (review I2)', () => {
  it('starts at current_period_start_at when SureCart reports one', () => {
    const p = purchase({ subscription: {
      id: 's1', status: 'active',
      current_period_start_at: Date.UTC(2029, 10, 2) / 1000, current_period_end_at: Date.UTC(2030, 10, 2) / 1000,
    } });
    expect(p.subscription.currentPeriodStartAt).toBe(Date.UTC(2029, 10, 2) / 1000);
    const plan = planPurchase(p, null, CFG, new Date('2029-11-03T00:00:00Z'));
    expect(plan).toMatchObject({ kind: 'subscription', startDate: '2029-11-02', endDate: '2030-11-02', status: 'active' });
  });

  it('a purchase with no numeric created_at is refused', () => {
    expect(normalizePurchase({ id: 'p1', object: 'purchase', customer: { email: 'a@b.co' }, created_at: 'yesterday' })).toBeNull();
  });
});
