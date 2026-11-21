import { describe, it, expect } from 'vitest';
import {
  queryFingerprint, relate, decideAttempt, nextSearchAttempt, searchAttemptsEnabled,
} from './search-attempt';

// Dan, Teams 11/19/26 #4: tell a popular question from one reader rephrasing.

const fp = queryFingerprint;

describe('queryFingerprint', () => {
  it('ignores case, order, filler and plurals', () => {
    expect(fp('How to light a parking lot?')).toEqual(fp('parking lots'));
    expect(fp('What is the BUG rating')).toEqual(fp('bug ratings'));
    expect(fp('the')).toEqual([]);
  });
  it('stores numbers, never words', () => {
    const f = fp('parking garage illuminance');
    expect(f).toHaveLength(3);
    expect(f.every(Number.isInteger)).toBe(true);
    expect(JSON.stringify(f)).not.toMatch(/[a-z]/i);
  });
  it('keeps a designation distinct from its neighbours', () => {
    expect(fp('RP-8')).not.toEqual(fp('RP-28'));
    expect(fp('90.1')).toHaveLength(1);
  });
});

describe('relate', () => {
  it('reads the same words as the same search', () => {
    expect(relate(fp('parking lot illuminance'), fp('illuminance parking lots'))).toBe('same');
  });
  it('reads a rephrasing as a rephrase', () => {
    expect(relate(fp('how to light a parking lot'), fp('parking lot illuminance levels'))).toBe('rephrase');
    expect(relate(fp('Is the bug rating still applicable'), fp('are bug ratings being replaced'))).toBe('rephrase');
    expect(relate(fp('glare'), fp('glare rating for sports'))).toBe('rephrase');
  });
  it('reads a different question as new', () => {
    expect(relate(fp('parking lot illuminance'), fp('classroom daylighting'))).toBe('new');
    expect(relate(fp('office task illuminance uniformity ratio'), fp('hospital corridor illuminance at night shift'))).toBe('new');
    expect(relate([], fp('anything'))).toBe('new');
  });
});

describe('decideAttempt', () => {
  const at = 1_000_000;
  const rec = (q, n, t = at) => ({ h: fp(q), n, at: t });
  it('counts up on a rephrase inside the window', () => {
    expect(decideAttempt(null, fp('parking lot'), at)).toBe(1);
    expect(decideAttempt(rec('parking lot lighting', 1), fp('parking lot illuminance'), at + 60)).toBe(2);
    expect(decideAttempt(rec('parking lot illuminance', 2), fp('parking lot footcandles'), at + 120)).toBe(3);
  });
  it('does not count a re-run of the same search', () => {
    expect(decideAttempt(rec('parking lot illuminance', 2), fp('Parking lot illuminance?'), at + 30)).toBe(2);
  });
  it('starts over on a new question, or after ten minutes', () => {
    expect(decideAttempt(rec('parking lot illuminance', 4), fp('museum conservation limits'), at + 30)).toBe(1);
    expect(decideAttempt(rec('parking lot lighting', 3), fp('parking lot illuminance'), at + 601)).toBe(1);
  });
  it('is capped', () => {
    expect(decideAttempt(rec('parking lot lighting', 20), fp('parking lot illuminance'), at + 5)).toBe(20);
  });
});

describe('nextSearchAttempt', () => {
  const kv = () => {
    const store = new Map();
    return {
      store,
      puts: [],
      async get(k) { return store.get(k) ?? null; },
      async put(k, v, opts) { this.puts.push({ k, v, opts }); store.set(k, v); },
    };
  };
  const t0 = new Date('2026-11-20T12:00:00Z');
  const later = (s) => new Date(t0.getTime() + s * 1000);

  it('follows one reader through a rephrased question', async () => {
    const SESSIONS = kv();
    const env = { SESSIONS };
    const run = async (q, when) => { const r = await nextSearchAttempt(env, 'prod', 'user-1', q, when); await r.write; return r.attempt; };
    expect(await run('where is the illuminance selector', t0)).toBe(1);
    expect(await run('illuminance selector tool', later(40))).toBe(2);
    expect(await run('ies illuminance selector download', later(90))).toBe(3);
    expect(await run('roadway lighting warrants', later(120))).toBe(1);
    // Another reader asking the same thing is a first attempt of their own.
    expect(await run('roadway lighting warrants', later(121))).toBe(1);
    const other = await nextSearchAttempt(env, 'prod', 'user-2', 'illuminance selector tool', later(45));
    expect(other.attempt).toBe(1);
  });

  it('remembers hashes for ten minutes, under the account, and nothing readable', async () => {
    const SESSIONS = kv();
    const r = await nextSearchAttempt({ SESSIONS }, 'stg', 'abc', 'parking garage illuminance', t0);
    await r.write;
    expect(SESSIONS.puts).toHaveLength(1);
    expect(SESSIONS.puts[0].k).toBe('search-attempt:stg:abc');
    expect(SESSIONS.puts[0].opts.expirationTtl).toBe(660);
    expect(SESSIONS.puts[0].v).not.toMatch(/parking|garage|illuminance/i);
  });

  it('is off when asked, and fails open', async () => {
    expect(searchAttemptsEnabled({})).toBe(true);
    expect(searchAttemptsEnabled({ LENSY_SEARCH_ATTEMPTS: 'OFF' })).toBe(false);
    expect((await nextSearchAttempt({ SESSIONS: kv(), LENSY_SEARCH_ATTEMPTS: 'off' }, 'prod', 'u', 'glare')).attempt).toBeNull();
    expect((await nextSearchAttempt({}, 'prod', 'u', 'glare')).attempt).toBeNull();
    const broken = { get: async () => { throw new Error('kv down'); }, put: async () => {} };
    expect((await nextSearchAttempt({ SESSIONS: broken }, 'prod', 'u', 'glare')).attempt).toBeNull();
    const garbage = { get: async () => 'not json', put: async () => {} };
    expect((await nextSearchAttempt({ SESSIONS: garbage }, 'prod', 'u', 'glare')).attempt).toBe(1);
    expect((await nextSearchAttempt({ SESSIONS: kv() }, 'prod', 'u', 'the')).attempt).toBe(1);
  });
});
