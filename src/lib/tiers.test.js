/**
 * Access tiers — Lensy vs LensyLite (client DO53).
 *
 * The rule the client wrote:
 *   Lighting Library subscription        → Lensy
 *   IES member without a subscription    → LensyLite
 *   any other IES account                → a shared collection only
 *
 * The first line of these tests is the safety one: with the feature off, which
 * is how it ships, nobody's access changes.
 */

import { describe, it, expect } from 'vitest';
import {
  resolveTier, liteEnabled, liteContentTypes, LITE_BLOCKED_FILTERS, LITE_NOTICE,
} from './tiers';

const ON = { LENSY_LITE: 'on' };
const OFF = {};

describe('liteEnabled', () => {
  it('is off unless explicitly switched on', () => {
    expect(liteEnabled({})).toBe(false);
    expect(liteEnabled({ LENSY_LITE: 'off' })).toBe(false);
    expect(liteEnabled({ LENSY_LITE: 'true' })).toBe(false);   // only "on" counts
    expect(liteEnabled({ LENSY_LITE: 'on' })).toBe(true);
    expect(liteEnabled({ LENSY_LITE: 'ON' })).toBe(true);
  });
});

describe('resolveTier', () => {
  it('gives everyone full access while the feature is off', () => {
    // The reviewers running the beta are IES members without the subscription
    // role; switching tiering on before the entitlement exists would demote them.
    expect(resolveTier({ isMember: true }, OFF)).toBe('full');
    expect(resolveTier({ isMember: false }, OFF)).toBe('full');
  });

  it('gives a Lighting Library subscriber the full product', () => {
    expect(resolveTier({ isMember: true, roles: ['member', 'lighting-library'] }, ON)).toBe('full');
    expect(resolveTier({ isMember: true, memberTier: 'Lighting Library Subscriber' }, ON)).toBe('full');
  });

  it('honours a configured role slug', () => {
    const env = { ...ON, LENSY_SUBSCRIBER_ROLES: 'll-2026,library' };
    expect(resolveTier({ isMember: true, roles: ['ll-2026'] }, env)).toBe('full');
    // …and only that list once it is configured.
    expect(resolveTier({ isMember: true, roles: ['subscriber'] }, env)).toBe('lite');
  });

  it('gives an IES member without a subscription LensyLite', () => {
    expect(resolveTier({ isMember: true, roles: ['member'] }, ON)).toBe('lite');
  });

  it('gives anyone else neither', () => {
    expect(resolveTier({ isMember: false, roles: [] }, ON)).toBe('none');
  });

  it('never demotes staff or an invited subscriber', () => {
    expect(resolveTier({ isMember: false, admin: true }, ON)).toBe('full');
    expect(resolveTier({ isMember: true, inviteRole: 'admin' }, ON)).toBe('full');
    expect(resolveTier({ isMember: true, inviteRole: 'subscriber' }, ON)).toBe('full');
    // A plain invited guest is still a Lite user unless they subscribe.
    expect(resolveTier({ isMember: true, inviteRole: 'member' }, ON)).toBe('lite');
  });

  it('does not read a membership tier as a subscription just for saying "member"', () => {
    expect(resolveTier({ isMember: true, memberTier: 'Individual Member' }, ON)).toBe('lite');
  });
});

describe('liteContentTypes', () => {
  it('drops Illuminance Tables and Document Comparison', () => {
    const out = liteContentTypes(new Set(['tables', 'body', 'references', 'compare']));
    expect([...out].sort()).toEqual(['body', 'references']);
  });

  it('never leaves a search with nothing selected', () => {
    expect([...liteContentTypes(new Set(['tables']))]).toEqual(['body']);
  });

  it('leaves the kinds LensyLite includes alone', () => {
    expect([...liteContentTypes(new Set(['definitions']))]).toEqual(['definitions']);
  });
});

describe('the three locked tools', () => {
  it('are exactly the ones the client named', () => {
    expect([...LITE_BLOCKED_FILTERS]).toEqual(['tables', 'guide', 'compare']);
  });

  it('has the banner in the client\'s own words', () => {
    expect(LITE_NOTICE).toContain('IES Members receive limited access to Lighting Science Collection');
    expect(LITE_NOTICE).toContain('Subscribe to unlock full Lensy');
  });
});
