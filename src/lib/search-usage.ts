/**
 * Per-account daily search counts (Dan, 2026-11-02; migration 0028).
 *
 * "Counts search usage per user without any search content. 'Total searches
 * per day' per user is likely the safest." So the only thing recorded is
 * (UTC day, account) → count. No query, no results, no timestamp finer than a
 * day — that is what keeps it from being joinable to search_log.
 *
 * Counted where the daily cap counts: after validation (a 400 spends
 * nothing), cache hits included (a cached answer is still one of the reader's
 * searches). Only cookie sessions are counted; the staff bearer has no account.
 * Fail-soft: usage bookkeeping must never fail a search.
 */

export interface SearchUsageAccount {
  sub: string;
  email: string;
}

/** YYYY-MM-DD in UTC. */
export function usageDay(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export async function recordSearchUsage(
  env: { DB: D1Database },
  account: SearchUsageAccount,
  tier: string,
  now: Date = new Date(),
): Promise<void> {
  const email = account.email.trim().toLowerCase();
  if (!email) return;
  try {
    await env.DB.prepare(
      `INSERT INTO search_usage_daily (day, email, person_uuid, tier, searches, updated_at)
       VALUES (?, ?, ?, ?, 1, datetime('now'))
       ON CONFLICT (day, email) DO UPDATE SET
         searches = searches + 1,
         tier = excluded.tier,
         person_uuid = COALESCE(excluded.person_uuid, search_usage_daily.person_uuid),
         updated_at = excluded.updated_at`,
    )
      .bind(usageDay(now), email, account.sub || null, tier)
      .run();
  } catch (err) {
    // Missing table (migration 0028 not applied) or a transient D1 error.
    console.error('search usage write failed (non-fatal):', err instanceof Error ? err.message : String(err));
  }
}
