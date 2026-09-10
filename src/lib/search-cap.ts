/**
 * Daily search cap for non-subscribers (client Teams update, 2026-09-08).
 *
 * "Subscribers: No daily cap at this time. Non-Subscribers: Enforce 20x daily
 *  search cap (subject to change after usage data is available). After that,
 *  'AI' is locked out for the rest of the user's searches for 24hr."
 *
 * What ships: a non-`full` session gets LENSY_DAILY_SEARCH_CAP searches per
 * rolling 24-hour window; past that, /api/search answers 429 with a message
 * naming when searches resume and where to subscribe, until the window
 * expires. Tier `full` — subscribers, full-tier invitees, admins — and the
 * staff bearer are never metered.
 *
 * Two interpretation choices, made deliberately and easy to revisit:
 *
 *  1. PAST THE CAP, SEARCH ITSELF PAUSES — not just the AI Guide. The client's
 *     wording ("'AI' is locked out for the rest of the user's searches") could
 *     also read as "cards keep working, the Guide stops", but the only
 *     non-subscriber tier that exists is LensyLite, and LensyLite has the Guide
 *     locked off ALREADY (DO53) — under that reading the cap would enforce
 *     nothing observable today. Blocking is the one reading with an effect. If
 *     the client confirms the softer reading, the enforcement point in
 *     handleSearch is the single place to change.
 *  2. "DAILY" IS A ROLLING 24H WINDOW anchored at the window's first search —
 *     the literal "for 24hr", with no timezone question. The window is one KV
 *     record whose expiration IS the reset time.
 *
 * Every search request that passes validation counts, cache hits included: the
 * cap is user-facing metering, not a cost control, and "20 searches" must mean
 * what a reader would count. KV's eventual consistency can let a burst overrun
 * the cap by a few — accepted, same posture as session-cap.ts: this is a cap,
 * not a billing meter, and it FAILS OPEN on any KV trouble.
 */

/** The rolling window: "daily" per the client, 24 hours per their own words. */
export const SEARCH_CAP_WINDOW_SECONDS = 24 * 3600;

/** The client's opening number, "subject to change after usage data". */
const DEFAULT_DAILY_CAP = 20;

/** What the KV record stores. Times are unix SECONDS. */
export interface SearchQuota {
  /** Searches spent in the current window. */
  count: number;
  /** When the window opened (its first search); reset is this + 24h. */
  windowStartedAt: number;
}

export type QuotaDecision =
  | { allowed: true; write: SearchQuota; remaining: number }
  | { allowed: false; resetAt: number };

/**
 * The cap for this deployment, or null when metering is off.
 * Unset → the client's 20. "off" or 0 → disabled. Any positive integer wins.
 */
export function dailySearchCap(env: Env): number | null {
  const raw = String(env.LENSY_DAILY_SEARCH_CAP ?? '').trim().toLowerCase();
  if (!raw) return DEFAULT_DAILY_CAP;
  if (raw === 'off' || raw === '0') return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_DAILY_CAP;
}

/**
 * The pure decision: may this search run, and what should the record become.
 * Separated from KV so the rules are unit-testable (same shape as
 * decideSessionSlot).
 */
export function decideSearchQuota(
  record: SearchQuota | null,
  cap: number,
  nowSec: number,
): QuotaDecision {
  const fresh: SearchQuota = { count: 1, windowStartedAt: nowSec };
  if (
    !record ||
    typeof record.count !== 'number' ||
    typeof record.windowStartedAt !== 'number' ||
    nowSec >= record.windowStartedAt + SEARCH_CAP_WINDOW_SECONDS
  ) {
    // No window, an unreadable record, or an expired window (KV TTLs are
    // best-effort — an overdue record must not extend its own lockout).
    return { allowed: true, write: fresh, remaining: cap - 1 };
  }
  if (record.count < cap) {
    return {
      allowed: true,
      write: { count: record.count + 1, windowStartedAt: record.windowStartedAt },
      remaining: cap - record.count - 1,
    };
  }
  return { allowed: false, resetAt: record.windowStartedAt + SEARCH_CAP_WINDOW_SECONDS };
}

function quotaKey(scope: 'prod' | 'stg', sub: string): string {
  return `search-quota:${scope}:${sub}`;
}

export type QuotaOutcome =
  | { allowed: true; used: number; cap: number }
  | { allowed: false; resetAt: number };

/**
 * Count one search attempt against the account's window. `scope` separates the
 * production and staging hostnames for the same reason session-cap does: same
 * Worker, same KV, different IdPs — a staging test run must not spend a
 * person's production searches.
 */
export async function enforceDailySearchCap(
  env: Env,
  sub: string,
  cap: number,
  scope: 'prod' | 'stg',
  nowMs: number = Date.now(),
): Promise<QuotaOutcome> {
  try {
    const key = quotaKey(scope, sub);
    const nowSec = Math.floor(nowMs / 1000);
    const record = await env.SESSIONS.get<SearchQuota>(key, 'json');
    const decision = decideSearchQuota(record, cap, nowSec);
    if (!decision.allowed) return { allowed: false, resetAt: decision.resetAt };

    // The record expires exactly when the window resets (KV's minimum TTL is
    // 60s; a window in its last minute keeps the key a moment longer, and the
    // expiry check in decideSearchQuota is what actually decides).
    const ttl = Math.max(60, decision.write.windowStartedAt + SEARCH_CAP_WINDOW_SECONDS - nowSec);
    await env.SESSIONS.put(key, JSON.stringify(decision.write), { expirationTtl: ttl });
    // used/cap ride the response so the UI can NUDGE before the cut — the
    // client's "Nudge after 10, cut after 20" (2026-09-04 permissions chart).
    return { allowed: true, used: decision.write.count, cap };
  } catch (err) {
    // Fail open: metering must never turn a KV hiccup into "search is down".
    console.error('search_cap_error', {
      detail: err instanceof Error ? err.message : 'unknown',
    });
    // used 0 on the fail-open path: an uncounted search must not nudge anyone.
    return { allowed: true, used: 0, cap };
  }
}

/** "in about 3 hours" / "in about 20 minutes" — for the 429's message. */
export function describeReset(resetAt: number, nowSec: number): string {
  const seconds = Math.max(0, resetAt - nowSec);
  if (seconds < 3600) {
    const minutes = Math.max(1, Math.ceil(seconds / 60));
    return `in about ${minutes} minute${minutes === 1 ? '' : 's'}`;
  }
  const hours = Math.ceil(seconds / 3600);
  return `in about ${hours} hour${hours === 1 ? '' : 's'}`;
}
