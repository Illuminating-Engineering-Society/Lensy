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

  it('never demotes staff', () => {
    expect(resolveTier({ isMember: false, admin: true }, ON)).toBe('full');
  });

  it('does not read a membership tier as a subscription just for saying "member"', () => {
    expect(resolveTier({ isMember: true, memberTier: 'Individual Member' }, ON)).toBe('lite');
  });
});

// What production actually runs on since 2026-08-12. The cases above were
// written against slugs that were GUESSES; Wicket emits none of them. These use
// the real tier names, slugified by the AuthIES import into roles_json.
describe('the live production configuration', () => {
  const PROD = { LENSY_LITE: 'on', LENSY_SUBSCRIBER_ROLES: 'lighting-library-full-access' };

  it('gives the 546 Lighting Library Full Access holders everything', () => {
    expect(resolveTier(
      { isMember: true, memberTier: 'Member Grade', roles: ['member', 'user', 'lighting-library-full-access'] },
      PROD,
    )).toBe('full');
  });

  it('gives a plain member LensyLite, which is the entire point', () => {
    expect(resolveTier(
      { isMember: true, memberTier: 'Member Grade', roles: ['member', 'user'] },
      PROD,
    )).toBe('lite');
  });

  it('keeps the four activated reviewer accounts on full', () => {
    // Verified against production D1: all four hold administrator AND the
    // subscription slug, so BOTH routes to 'full' cover them.
    const reviewer = {
      isMember: true, admin: true, memberTier: 'Diamond',
      roles: ['member', 'user', 'administrator', 'lighting-library-full-access'],
    };
    expect(resolveTier(reviewer, PROD)).toBe('full');
    expect(resolveTier({ ...reviewer, admin: false }, PROD)).toBe('full');
  });

  it('does NOT promote the narrower products — the open product question', () => {
    // If IES decides these cohorts deserve more, it is a LENSY_SUBSCRIBER_ROLES
    // change, and this test is the thing that should fail first.
    for (const slug of [
      'the-illuminance-selector',
      'lighting-science-collection',
      'lighting-practice-collection',
      'lighting-applications-collection',
      'roadway-lighting-collection',
      'lighting-testing-and-measurements-collection',
    ]) {
      expect(resolveTier({ isMember: true, roles: ['member', slug] }, PROD)).toBe('lite');
    }
  });

  it('locks out an IES account that is neither member nor subscriber', () => {
    expect(resolveTier({ isMember: false, roles: ['user'] }, PROD)).toBe('none');
  });
});

// An invitation is a grant in its own right — the whole point of an allowlist
// is reaching people the IES directory knows nothing about.
describe('what an invitation grants', () => {
  const PROD = { LENSY_LITE: 'on', LENSY_SUBSCRIBER_ROLES: 'lighting-library-full-access' };

  it('admits a total stranger at the tier the row names', () => {
    // No membership, no subscription, no roles: without the invite this is
    // 'none', which is what a plain 'guest' used to get — in and shown nothing.
    const stranger = { isMember: false, roles: [] };
    expect(resolveTier(stranger, PROD)).toBe('none');
    expect(resolveTier({ ...stranger, inviteTier: 'full' }, PROD)).toBe('full');
    expect(resolveTier({ ...stranger, inviteTier: 'lite' }, PROD)).toBe('lite');
  });

  it('can only ever ADD access, never take it away', () => {
    // A 'lite' invitation must not demote somebody who pays for the Library.
    const subscriber = { isMember: true, roles: ['member', 'lighting-library-full-access'] };
    expect(resolveTier({ ...subscriber, inviteTier: 'lite' }, PROD)).toBe('full');
    // …nor an admin.
    expect(resolveTier({ isMember: false, admin: true, inviteTier: 'lite' }, PROD)).toBe('full');
  });

  it('lifts a plain member to full when the row says so', () => {
    expect(resolveTier({ isMember: true, roles: ['member'], inviteTier: 'full' }, PROD)).toBe('full');
  });

  it('ignores an unrecognized or missing tier rather than granting on it', () => {
    const member = { isMember: true, roles: ['member'] };
    expect(resolveTier({ ...member, inviteTier: 'premium' }, PROD)).toBe('lite');
    expect(resolveTier({ ...member, inviteTier: '' }, PROD)).toBe('lite');
    expect(resolveTier({ ...member, inviteTier: null }, PROD)).toBe('lite');
    // And it cannot conjure access for someone with nothing.
    expect(resolveTier({ isMember: false, roles: [], inviteTier: 'nonsense' }, PROD)).toBe('none');
  });

  it('is inert while tiering is off', () => {
    expect(resolveTier({ isMember: false, inviteTier: 'lite' }, OFF)).toBe('full');
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
