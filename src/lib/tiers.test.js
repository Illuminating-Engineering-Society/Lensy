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
  resolveTier, liteEnabled, liteContentTypes, isNonSubscriberTier, TIER_RANK, LITE_BLOCKED_FILTERS, LITE_NOTICE,
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

  it('gives anyone else a free-account Guest (10/16/26)', () => {
    expect(resolveTier({ isMember: false, roles: [] }, ON)).toBe('guest');
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

  it('makes an IES account that is neither member nor subscriber a Guest', () => {
    expect(resolveTier({ isMember: false, roles: ['user'] }, PROD)).toBe('guest');
  });
});

// An invitation is a grant in its own right — the whole point of an allowlist
// is reaching people the IES directory knows nothing about.
describe('what an invitation grants', () => {
  const PROD = { LENSY_LITE: 'on', LENSY_SUBSCRIBER_ROLES: 'lighting-library-full-access' };

  it('admits a total stranger at the tier the row names', () => {
    // No membership, no subscription, no roles: without the invite this is
    // 'guest' (it used to be 'none' — in and shown nothing).
    const stranger = { isMember: false, roles: [] };
    expect(resolveTier(stranger, PROD)).toBe('guest');
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
    // And it cannot lift someone with nothing above a free account.
    expect(resolveTier({ isMember: false, roles: [], inviteTier: 'nonsense' }, PROD)).toBe('guest');
  });

  it('is inert while tiering is off', () => {
    expect(resolveTier({ isMember: false, inviteTier: 'lite' }, OFF)).toBe('full');
  });
});

describe('liteContentTypes', () => {
  // 10/16/26: the Guide answers a non-subscriber from the subscriber's pool, so
  // retrieval keeps Tables — only the cards are cut down (nonSubscriberCards).
  it('drops only Document Comparison', () => {
    const out = liteContentTypes(new Set(['tables', 'body', 'references', 'compare']));
    expect([...out].sort()).toEqual(['body', 'references', 'tables']);
  });

  it('never leaves a search with nothing selected', () => {
    expect([...liteContentTypes(new Set(['compare']))]).toEqual(['body']);
  });

  it('leaves the kinds LensyLite includes alone', () => {
    expect([...liteContentTypes(new Set(['definitions']))]).toEqual(['definitions']);
  });
});

describe('the locked tools', () => {
  // DO999 turned the AI Guide into a metered trial for non-subscribers, so it
  // left this list: what remains is what the client still sells as a
  // subscriber unlock ("browse illuminance table values", "compare versions"),
  // plus Documents since 2026-09-23 ("AI Guide, reference cards and definition
  // cards only").
  it('are exactly the ones the client named', () => {
    expect([...LITE_BLOCKED_FILTERS]).toEqual(['tables', 'body', 'compare']);
  });

  it('still RETRIEVES document passages for the Guide to answer from', () => {
    // The lock is on the cards, applied in search.ts after the Guide ran.
    expect(liteContentTypes(new Set(['body', 'definitions'])).has('body')).toBe(true);
  });

  it('never blocks the AI Guide, which the daily cap meters instead', () => {
    expect([...LITE_BLOCKED_FILTERS]).not.toContain('guide');
  });

  it('has the banner in the client\'s own words', () => {
    // DO111: a subscription is always called the Lighting Library, and the
    // separate LensyLite product name is gone.
    // 10/09/26 #1B2/B3: the collection line is gone; what a subscription adds is in.
    expect(LITE_NOTICE).not.toContain('You are searching');
    expect(LITE_NOTICE).toContain('Subscribe to the Lighting Library');
    expect(LITE_NOTICE).toContain('any current or deprecated document in the Lighting Library');
    expect(LITE_NOTICE).not.toMatch(/lensy/i);
  });
});

// 10/16/26: a free IES account is a Non-Subscriber Guest. In IES Lens it
// searches exactly like a member; the Lighting Library behind it differs.
describe('Non-Subscriber Guest vs Member', () => {
  it('both search as Non-Subscribers; nobody else does', () => {
    expect(isNonSubscriberTier('lite')).toBe(true);
    expect(isNonSubscriberTier('guest')).toBe(true);
    expect(isNonSubscriberTier('full')).toBe(false);
    expect(isNonSubscriberTier('none')).toBe(false);
    expect(isNonSubscriberTier(undefined)).toBe(false);
  });

  it('ranks a guest above no session and below a member', () => {
    expect(TIER_RANK.none).toBeLessThan(TIER_RANK.guest);
    expect(TIER_RANK.guest).toBeLessThan(TIER_RANK.lite);
    expect(TIER_RANK.lite).toBeLessThan(TIER_RANK.full);
  });

  it('a lite invitation still lifts a guest to member', () => {
    expect(resolveTier({ isMember: false, roles: [], inviteTier: 'lite' }, ON)).toBe('lite');
  });
});
