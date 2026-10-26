import { describe, it, expect } from 'vitest';
import { matchProductToStandard, suggestConfig, skuToStandardId, WEBHOOK_EVENTS } from './surecart-setup.js';

// The setup aid must read the store the way the Worker does (lib/purchases.ts)
// and must ask for exactly the events workers/surecart.ts handles.

const STANDARDS = [
  { id: 'RP-8-25+E2', buy_url: 'https://store.ies.org/product/recommended-practice-lighting-roadway-and-parking-facilities/', status: 'Active' },
  { id: 'RP-8-25+E1', buy_url: null, status: 'Deprecated' },
  { id: 'LM-79-24', buy_url: 'https://store.ies.org/product/lm-79-24-approved-method/', status: 'Active' },
];
const product = (over = {}) => ({ id: 'prod1', name: 'RP-8', sku: 'ANSI/IES RP-8-25+E2', slug: 'recommended-practice-lighting-roadway-and-parking-facilities', recurring: false, archived: false, prices: [{ id: 'pr1', amount: 42500, recurring: false, archived: false }], ...over });

describe('matchProductToStandard', () => {
  it('matches the lease link slug, then the SKU, then the newest printing of the edition', () => {
    expect(matchProductToStandard(product(), STANDARDS)).toEqual({ id: 'RP-8-25+E2', via: 'lease link' });
    expect(matchProductToStandard(product({ slug: 'other', sku: 'ANSI/IES LM-79-24' }), STANDARDS)).toEqual({ id: 'LM-79-24', via: 'sku' });
    expect(matchProductToStandard(product({ slug: 'other', sku: 'ANSI/IES RP-8-25' }), STANDARDS)).toEqual({ id: 'RP-8-25+E2', via: 'sku edition' });
    expect(matchProductToStandard(product({ slug: 'acp', sku: 'IES-2017-ACP' }), STANDARDS)).toBeNull();
    expect(skuToStandardId('ANSI/IES LM-49-20(R2023)')).toBe('LM-49-20');
  });
});

describe('suggestConfig', () => {
  it('splits leases, subscriptions and unmapped, and only proposes lease prices when a standard has several', () => {
    const products = [
      product(),
      product({ id: 'sub', name: 'Lighting Library Subscription', sku: null, slug: 'lighting-library', recurring: true, prices: [{ id: 'pr-sub', amount: 50000, recurring: true, archived: false }] }),
      product({ id: 'acp', name: 'IES 2017 Annual Conference Proceedings', sku: 'IES-2017-ACP', slug: 'acp' }),
      product({ id: 'old', name: 'Archived', archived: true }),
    ];
    const s = suggestConfig(products, STANDARDS);
    expect(s.leases.map(l => l.standard.id)).toEqual(['RP-8-25+E2']);
    expect(s.subscriptionProducts).toEqual(['sub']);
    expect(s.unmapped.map(u => u.product.id)).toEqual(['acp']);
    expect(s.leasePrices).toEqual([]);

    const twoPrices = suggestConfig([product({ prices: [{ id: 'pr-lease', amount: 42500, recurring: false }, { id: 'pr-pdf', amount: 20000, recurring: false }] })], STANDARDS);
    expect(twoPrices.multiPrice).toHaveLength(1);
    expect(twoPrices.leasePrices).toEqual(['pr-lease', 'pr-pdf']);
  });
});

describe('WEBHOOK_EVENTS', () => {
  it('names exactly the events the Worker handles', () => {
    expect(WEBHOOK_EVENTS).toEqual([
      'purchase.created', 'purchase.updated', 'purchase.invoked', 'purchase.revoked',
      'subscription.renewed', 'subscription.updated', 'subscription.made_active', 'subscription.canceled', 'subscription.completed',
    ]);
  });
});
