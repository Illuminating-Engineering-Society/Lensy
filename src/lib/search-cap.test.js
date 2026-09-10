/**
 * Daily search cap for non-subscribers (client Teams update, 2026-09-08).
 *
 * "Subscribers: No daily cap at this time. Non-Subscribers: Enforce 20x daily
 *  search cap." The pure decision (decideSearchQuota), the config parsing and
 * the KV enforcement's failure posture are tested here; WHO is metered — tier
 * below `full`, cookie sessions only — is decided in handleSearch off
 * resolveSearchGrant, whose `user: null` marks the never-metered callers.
 */

import { describe, it, expect } from 'vitest';
import {
  SEARCH_CAP_WINDOW_SECONDS, dailySearchCap, decideSearchQuota,
  enforceDailySearchCap, describeReset,
} from './search-cap';

const NOW = 1_800_000_000; // any fixed unix second

describe('dailySearchCap', () => {
  it("defaults to the client's 20", () => {
    expect(dailySearchCap({})).toBe(20);
    expect(dailySearchCap({ LENSY_DAILY_SEARCH_CAP: '' })).toBe(20);
  });

  it('honours an override, and treats garbage as the default rather than off', () => {
    expect(dailySearchCap({ LENSY_DAILY_SEARCH_CAP: '50' })).toBe(50);
    expect(dailySearchCap({ LENSY_DAILY_SEARCH_CAP: 'lots' })).toBe(20);
    expect(dailySearchCap({ LENSY_DAILY_SEARCH_CAP: '-5' })).toBe(20);
  });

  it('switches off only explicitly', () => {
    expect(dailySearchCap({ LENSY_DAILY_SEARCH_CAP: 'off' })).toBe(null);
    expect(dailySearchCap({ LENSY_DAILY_SEARCH_CAP: '0' })).toBe(null);
  });
});

describe('decideSearchQuota', () => {
  it('opens a window on the first search', () => {
    const d = decideSearchQuota(null, 20, NOW);
    expect(d).toEqual({ allowed: true, write: { count: 1, windowStartedAt: NOW }, remaining: 19 });
  });

  it('counts within the window and keeps its anchor', () => {
    const d = decideSearchQuota({ count: 7, windowStartedAt: NOW - 3600 }, 20, NOW);
    expect(d).toEqual({
      allowed: true,
      write: { count: 8, windowStartedAt: NOW - 3600 },
      remaining: 12,
    });
  });

  it('allows the 20th search and refuses the 21st, naming the reset time', () => {
    const started = NOW - 3600;
    expect(decideSearchQuota({ count: 19, windowStartedAt: started }, 20, NOW).allowed).toBe(true);
    const refused = decideSearchQuota({ count: 20, windowStartedAt: started }, 20, NOW);
    expect(refused).toEqual({ allowed: false, resetAt: started + SEARCH_CAP_WINDOW_SECONDS });
  });

  it('an expired window restarts instead of extending its own lockout', () => {
    // KV TTLs are best-effort; a record that outlived its window must not
    // keep refusing searches.
    const d = decideSearchQuota(
      { count: 20, windowStartedAt: NOW - SEARCH_CAP_WINDOW_SECONDS },
      20,
      NOW,
    );
    expect(d).toEqual({ allowed: true, write: { count: 1, windowStartedAt: NOW }, remaining: 19 });
  });

  it('treats an unreadable record as a fresh window', () => {
    for (const junk of [{}, { count: 'x' }, { windowStartedAt: NOW }, 'garbage']) {
      expect(decideSearchQuota(junk, 20, NOW).allowed).toBe(true);
    }
  });
});

describe('enforceDailySearchCap', () => {
  const kvStub = (initial = null) => {
    const store = new Map(initial ? [['search-quota:prod:sub-1', initial]] : []);
    return {
      store,
      puts: [],
      async get(key) { return store.get(key) ?? null; },
      async put(key, value, opts) {
        this.puts.push({ key, value: JSON.parse(value), opts });
        store.set(key, JSON.parse(value));
      },
    };
  };

  it('counts a search and expires the record when the window resets', async () => {
    const kv = kvStub({ count: 3, windowStartedAt: NOW - 1000 });
    const out = await enforceDailySearchCap({ SESSIONS: kv }, 'sub-1', 20, 'prod', NOW * 1000);
    expect(out).toEqual({ allowed: true });
    expect(kv.puts[0].value).toEqual({ count: 4, windowStartedAt: NOW - 1000 });
    expect(kv.puts[0].opts.expirationTtl).toBe(SEARCH_CAP_WINDOW_SECONDS - 1000);
  });

  it('refuses past the cap without writing', async () => {
    const kv = kvStub({ count: 20, windowStartedAt: NOW - 1000 });
    const out = await enforceDailySearchCap({ SESSIONS: kv }, 'sub-1', 20, 'prod', NOW * 1000);
    expect(out).toEqual({ allowed: false, resetAt: NOW - 1000 + SEARCH_CAP_WINDOW_SECONDS });
    expect(kv.puts.length).toBe(0);
  });

  it('scopes production and staging apart', async () => {
    const kv = kvStub();
    await enforceDailySearchCap({ SESSIONS: kv }, 'sub-1', 20, 'stg', NOW * 1000);
    expect(kv.puts[0].key).toBe('search-quota:stg:sub-1');
  });

  it('fails OPEN on any KV trouble', async () => {
    const broken = {
      async get() { throw new Error('kv down'); },
      async put() { throw new Error('kv down'); },
    };
    const out = await enforceDailySearchCap({ SESSIONS: broken }, 'sub-1', 20, 'prod', NOW * 1000);
    expect(out).toEqual({ allowed: true });
  });

  it('never writes a TTL below the KV minimum of 60s', async () => {
    const kv = kvStub({ count: 1, windowStartedAt: NOW - SEARCH_CAP_WINDOW_SECONDS + 10 });
    await enforceDailySearchCap({ SESSIONS: kv }, 'sub-1', 20, 'prod', NOW * 1000);
    expect(kv.puts[0].opts.expirationTtl).toBe(60);
  });
});

describe('describeReset', () => {
  it('speaks in hours or minutes, never zero', () => {
    expect(describeReset(NOW + 5 * 3600, NOW)).toBe('in about 5 hours');
    expect(describeReset(NOW + 3601, NOW)).toBe('in about 2 hours');
    expect(describeReset(NOW + 1200, NOW)).toBe('in about 20 minutes');
    expect(describeReset(NOW + 30, NOW)).toBe('in about 1 minute');
    expect(describeReset(NOW - 5, NOW)).toBe('in about 1 minute');
  });
});
