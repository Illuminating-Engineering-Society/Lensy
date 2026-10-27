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

  it('reads the live store\'s SKU shapes and "-member" slugs like lib/purchases.ts', () => {
    expect(skuToStandardId('ANSI/IES LM-9-20 (R2023)-MEMBER')).toBe('LM-9-20');
    expect(skuToStandardId('ANSI/IES LS-6-20(R25)')).toBe('LS-6-20');
    expect(skuToStandardId('ANSI/IES/IUVA LM-92-22')).toBe('LM-92-22');
    expect(skuToStandardId('ANSI/ASHRAE/IES-90.1-2025-Lighting Only')).toBe('ASHRAE-IES-90.1-2025');
    expect(matchProductToStandard(product({ slug: 'lm-79-24-approved-method-member', sku: null }), STANDARDS)).toEqual({ id: 'LM-79-24', via: 'lease link' });
    const withR = [...STANDARDS, { id: 'LS-4-20+R2023+E1', buy_url: null, status: 'Active' }];
    expect(matchProductToStandard(product({ slug: 'x', sku: 'ANSI/IES LS-4-20(R2023)' }), withR)).toEqual({ id: 'LS-4-20+R2023+E1', via: 'sku edition' });
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

  // RP-4-26 is titled "Recommended Practice: Lighting Library Spaces" — a
  // standard, not the subscription; and IES memberships (Bronze, Student…)
  // are recurring without being Library subscriptions, so only the products
  // whose NAME says Lighting Library are proposed, split by "IES Lens".
  it('a standard whose title says "Library" is a lease; subscriptions are the Lighting Library products, Lens ones apart', () => {
    const products = [
      product({ id: 'rp4', name: 'Recommended Practice: Lighting Library Spaces', sku: 'ANSI/IES RP-4-26', slug: 'rp-4' }),
      product({ id: 'lib', name: 'Lighting Library (Full Access)', sku: null, slug: 'lighting-library', recurring: true, prices: [{ id: 'pr-lib', amount: 54900, recurring: true }] }),
      product({ id: 'lens', name: 'Lighting Library with IES Lens (Full Access)', sku: null, slug: 'x1', recurring: true, prices: [{ id: 'pr-lens', amount: 64900, recurring: true }] }),
      product({ id: 'bronze', name: 'Bronze', sku: null, slug: 'bronze', recurring: true, prices: [{ id: 'pr-b', amount: 135000, recurring: true }] }),
    ];
    const withRp4 = [...STANDARDS, { id: 'RP-4-26', buy_url: null, status: 'Active' }];
    const s = suggestConfig(products, withRp4);
    expect(s.leases.map(l => l.standard.id)).toEqual(['RP-4-26']);
    expect(s.subscriptionProducts).toEqual(['lib', 'lens']);
    expect(s.lensProducts).toEqual(['lens']);
    expect(s.otherRecurring.map(x => x.product.id)).toEqual(['bronze']);
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
