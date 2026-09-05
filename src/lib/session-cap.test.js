/**
 * One concurrent Lensy session per account (client, 2026-09-04).
 *
 * The rules under test:
 *   - the seat is claimed by whoever arrives first, and kept by its sid;
 *   - a NEWER sign-in (larger cookie iat) takes it over;
 *   - an older-or-equal one is superseded — including a re-mint of the same
 *     IdP session, whose iat never advances (that is what makes sign-out →
 *     sign-in the only takeover gesture);
 *   - an active session re-arms the idle TTL at most every
 *     SLOT_REFRESH_SECONDS, so the cap costs ~1 KV write per 5 minutes;
 *   - KV trouble fails OPEN.
 */

import { describe, it, expect } from 'vitest';
import {
  decideSessionSlot,
  enforceSessionCap,
  sessionCapEnabled,
  sessionCapIdleSeconds,
  SLOT_REFRESH_SECONDS,
} from './session-cap';

const NOW = 1_760_000_000; // unix seconds

describe('sessionCapEnabled', () => {
  it('is on by default and only "off" disables it', () => {
    expect(sessionCapEnabled({})).toBe(true);
    expect(sessionCapEnabled({ LENSY_SESSION_CAP: 'on' })).toBe(true);
    expect(sessionCapEnabled({ LENSY_SESSION_CAP: '1' })).toBe(true);
    expect(sessionCapEnabled({ LENSY_SESSION_CAP: 'off' })).toBe(false);
  });
});

describe('sessionCapIdleSeconds', () => {
  it('defaults to 30 minutes and refuses junk', () => {
    expect(sessionCapIdleSeconds({})).toBe(30 * 60);
    expect(sessionCapIdleSeconds({ LENSY_SESSION_CAP_IDLE_MINUTES: '10' })).toBe(600);
    expect(sessionCapIdleSeconds({ LENSY_SESSION_CAP_IDLE_MINUTES: 'soon' })).toBe(30 * 60);
    expect(sessionCapIdleSeconds({ LENSY_SESSION_CAP_IDLE_MINUTES: '-5' })).toBe(30 * 60);
  });

  it('never goes below the KV minimum TTL of 60s', () => {
    expect(sessionCapIdleSeconds({ LENSY_SESSION_CAP_IDLE_MINUTES: '1' })).toBe(60);
  });
});

describe('decideSessionSlot', () => {
  const holder = { sid: 'sess-a', iat: NOW - 3600 };

  it('claims a free seat', () => {
    const d = decideSessionSlot(null, holder, NOW);
    expect(d.outcome).toBe('ok');
    expect(d.write).toEqual({ sid: 'sess-a', iat: NOW - 3600, seenAt: NOW });
  });

  it('claims a seat whose record is malformed', () => {
    const d = decideSessionSlot({ sid: 42, iat: 'x' }, holder, NOW);
    expect(d.outcome).toBe('ok');
    expect(d.write).not.toBe(null);
  });

  it('keeps the seat for its own sid without rewriting every request', () => {
    const slot = { sid: 'sess-a', iat: NOW - 3600, seenAt: NOW - 10 };
    const d = decideSessionSlot(slot, holder, NOW);
    expect(d.outcome).toBe('ok');
    expect(d.write).toBe(null);
  });

  it('re-arms the idle TTL once the refresh window has passed', () => {
    const slot = { sid: 'sess-a', iat: NOW - 3600, seenAt: NOW - SLOT_REFRESH_SECONDS };
    const d = decideSessionSlot(slot, holder, NOW);
    expect(d.outcome).toBe('ok');
    expect(d.write).toEqual({ sid: 'sess-a', iat: NOW - 3600, seenAt: NOW });
  });

  it('lets a newer sign-in take the seat over', () => {
    const slot = { sid: 'sess-a', iat: NOW - 3600, seenAt: NOW - 30 };
    const d = decideSessionSlot(slot, { sid: 'sess-b', iat: NOW - 60 }, NOW);
    expect(d.outcome).toBe('ok');
    expect(d.write).toEqual({ sid: 'sess-b', iat: NOW - 60, seenAt: NOW });
  });

  it('supersedes an older session', () => {
    const slot = { sid: 'sess-b', iat: NOW - 60, seenAt: NOW - 30 };
    const d = decideSessionSlot(slot, { sid: 'sess-a', iat: NOW - 3600 }, NOW);
    expect(d.outcome).toBe('superseded');
  });

  it('supersedes a re-mint of a displaced session (same iat, different sid loses ties)', () => {
    // The IdP reuses a live session on /login, so a displaced browser bouncing
    // through the IdP presents the SAME iat again — it must stay displaced.
    const slot = { sid: 'sess-b', iat: NOW - 3600, seenAt: NOW - 30 };
    const d = decideSessionSlot(slot, { sid: 'sess-a', iat: NOW - 3600 }, NOW);
    expect(d.outcome).toBe('superseded');
  });
});

// ── the KV wrapper ────────────────────────────────────────────────────────────

function fakeKv(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    async get(key) {
      const v = store.get(key);
      return v === undefined ? null : JSON.parse(v);
    },
    async put(key, value, opts) {
      store.set(key, value);
      this.lastPutOpts = opts;
    },
  };
}

const userA = { sub: 'person-1', sid: 'sess-a', iat: NOW - 3600 };
const userB = { sub: 'person-1', sid: 'sess-b', iat: NOW - 60 };

describe('enforceSessionCap', () => {
  it('claims, keeps, takes over, supersedes — end to end', async () => {
    const kv = fakeKv();
    const env = { SESSIONS: kv };

    expect(await enforceSessionCap(env, userA, 'prod', NOW * 1000)).toBe('ok');
    expect(await enforceSessionCap(env, userA, 'prod', NOW * 1000)).toBe('ok');
    expect(await enforceSessionCap(env, userB, 'prod', NOW * 1000)).toBe('ok');   // newer wins
    expect(await enforceSessionCap(env, userA, 'prod', NOW * 1000)).toBe('superseded');
  });

  it('scopes production and staging seats separately', async () => {
    const kv = fakeKv();
    const env = { SESSIONS: kv };
    expect(await enforceSessionCap(env, userB, 'prod', NOW * 1000)).toBe('ok');
    // The same person's OLDER staging session is a different seat entirely.
    expect(await enforceSessionCap(env, userA, 'stg', NOW * 1000)).toBe('ok');
  });

  it('writes the idle TTL, not the cookie lifetime', async () => {
    const kv = fakeKv();
    const env = { SESSIONS: kv, LENSY_SESSION_CAP_IDLE_MINUTES: '10' };
    await enforceSessionCap(env, userA, 'prod', NOW * 1000);
    expect(kv.lastPutOpts).toEqual({ expirationTtl: 600 });
  });

  it('fails OPEN when KV errors', async () => {
    const env = {
      SESSIONS: {
        async get() { throw new Error('kv down'); },
        async put() { throw new Error('kv down'); },
      },
    };
    expect(await enforceSessionCap(env, userA, 'prod', NOW * 1000)).toBe('ok');
  });
});
