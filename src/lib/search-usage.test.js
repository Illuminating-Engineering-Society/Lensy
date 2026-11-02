/**
 * Per-account daily search counts (Dan, 2026-11-02). What is tested is the
 * privacy contract — only day, account and count are written — and the
 * fail-soft posture; the counting point lives in handleSearch.
 */

import { describe, it, expect } from 'vitest';
import { recordSearchUsage, usageDay } from './search-usage';

function fakeDb({ fail = false } = {}) {
  const calls = [];
  return {
    calls,
    DB: {
      prepare(sql) {
        return {
          bind(...args) {
            return {
              async run() {
                if (fail) throw new Error('no such table: search_usage_daily');
                calls.push({ sql, args });
                return { success: true };
              },
            };
          },
        };
      },
    },
  };
}

describe('usageDay', () => {
  it('is the UTC date', () => {
    expect(usageDay(new Date('2026-11-02T23:30:00-05:00'))).toBe('2026-11-03');
  });
});

describe('recordSearchUsage', () => {
  it('writes day, normalized email, account id and tier — nothing else', async () => {
    const env = fakeDb();
    await recordSearchUsage(env, { sub: 'uuid-1', email: ' Ada@Example.org ' }, 'lite', new Date('2026-11-02T12:00:00Z'));
    expect(env.calls).toHaveLength(1);
    expect(env.calls[0].args).toEqual(['2026-11-02', 'ada@example.org', 'uuid-1', 'lite']);
    expect(env.calls[0].sql).toMatch(/searches = searches \+ 1/);
  });

  it('skips an account with no email', async () => {
    const env = fakeDb();
    await recordSearchUsage(env, { sub: 'uuid-1', email: '  ' }, 'full');
    expect(env.calls).toHaveLength(0);
  });

  it('never throws when the table is missing', async () => {
    await expect(
      recordSearchUsage(fakeDb({ fail: true }), { sub: 'u', email: 'a@b.org' }, 'full'),
    ).resolves.toBeUndefined();
  });
});
