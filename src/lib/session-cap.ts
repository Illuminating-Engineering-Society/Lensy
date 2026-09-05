/**
 * One concurrent Lensy session per account (client, 2026-09-04).
 *
 * "Out of the gate, Lensy should cap at (only) a 1-concurrent-session cap."
 * Daily limits, central IdP device counts etc. are explicitly deferred until
 * post-rollout usage data says they are needed — so this is a LENSY-side cap,
 * not an IdP change: AuthIES keeps minting sessions exactly as before, and
 * other SPs on the shared ies_auth cookie are untouched.
 *
 * How it works. The ies_auth cookie carries `sid` (the IdP session id) and
 * `iat` (that session's creation time — NOT the mint time: a re-mint of the
 * same session repeats the same iat, see AuthIES sessionToCookiePayload).
 * Lensy keeps one KV "slot" per account holding the sid currently allowed to
 * use it:
 *
 *  - no slot, or the slot's own sid presenting → allowed (the slot is claimed
 *    or kept; the TTL makes it an IDLE window, so a closed laptop frees the
 *    slot by itself after LENSY_SESSION_CAP_IDLE_MINUTES);
 *  - a DIFFERENT sid with a NEWER iat → allowed, and it takes the slot over —
 *    the most recent sign-in wins, which is what makes "sign out and back in
 *    on this device" the takeover gesture;
 *  - a different sid with an older-or-equal iat → `superseded`. The gates
 *    answer 401 `session_superseded`, and the auth gate shows the
 *    "signed in elsewhere" screen instead of the ordinary sign-in card.
 *
 * Because /login against a LIVE IdP session reuses that session (same sid,
 * same iat), a displaced browser cannot silently re-claim the slot by
 * bouncing through the IdP — reclaiming requires a sign-out first, which is
 * the point of a concurrency cap. Two logins in the same second tie on iat;
 * the slot holder wins deterministically.
 *
 * Failure posture: FAIL OPEN. KV is a cap on convenience, not a security
 * boundary — a KV read error must never lock every user out of search. KV's
 * eventual consistency (~60s cross-edge) likewise means two devices can
 * briefly overlap right after a takeover; accepted, this is a cap, not DRM.
 */

/** What the KV slot stores. All times are unix SECONDS. */
export interface SessionSlot {
  /** IdP session id currently holding the account's one Lensy seat. */
  sid: string;
  /** That session's iat (IdP creation time) — what a challenger must beat. */
  iat: number;
  /** When this record was last written; throttles per-request KV writes. */
  seenAt: number;
}

export type SlotDecision =
  | { outcome: 'ok'; write: SessionSlot | null }
  | { outcome: 'superseded' };

/** Re-write the slot (re-arming its idle TTL) at most this often. */
export const SLOT_REFRESH_SECONDS = 300;

/** Idle minutes before an unclaimed slot frees itself. */
const DEFAULT_IDLE_MINUTES = 30;

/**
 * The pure decision: may this cookie use the account's one seat, and what (if
 * anything) should the slot record become. Separated from KV so the rules are
 * unit-testable.
 */
export function decideSessionSlot(
  slot: SessionSlot | null,
  user: { sid: string; iat: number },
  nowSec: number,
  refreshSeconds: number = SLOT_REFRESH_SECONDS,
): SlotDecision {
  if (!slot || typeof slot.sid !== 'string' || typeof slot.iat !== 'number') {
    return { outcome: 'ok', write: { sid: user.sid, iat: user.iat, seenAt: nowSec } };
  }
  if (slot.sid === user.sid) {
    // Same IdP session — write only when the idle TTL needs re-arming, so an
    // active reader costs ~1 KV write per SLOT_REFRESH_SECONDS, not per call.
    const stale = typeof slot.seenAt !== 'number' || nowSec - slot.seenAt >= refreshSeconds;
    return {
      outcome: 'ok',
      write: stale ? { sid: user.sid, iat: user.iat, seenAt: nowSec } : null,
    };
  }
  if (user.iat > slot.iat) {
    // A newer sign-in takes the seat; the previous session is superseded from
    // its next request on.
    return { outcome: 'ok', write: { sid: user.sid, iat: user.iat, seenAt: nowSec } };
  }
  return { outcome: 'superseded' };
}

/** The cap is ON unless explicitly switched off (LENSY_SESSION_CAP="off"). */
export function sessionCapEnabled(env: Env): boolean {
  return String(env.LENSY_SESSION_CAP ?? 'on') !== 'off';
}

/** Idle window in seconds (KV minimum TTL is 60). */
export function sessionCapIdleSeconds(env: Env): number {
  const minutes = Number.parseInt(String(env.LENSY_SESSION_CAP_IDLE_MINUTES ?? ''), 10);
  const effective = Number.isFinite(minutes) && minutes > 0 ? minutes : DEFAULT_IDLE_MINUTES;
  return Math.max(60, effective * 60);
}

function slotKey(scope: string, sub: string): string {
  return `session-slot:${scope}:${sub}`;
}

/**
 * Enforce the cap for one authenticated request. `scope` separates the
 * production and staging hostnames, which share this Worker and its KV but
 * authenticate against different IdPs (lib/sso.ts) — a staging sign-in must
 * not displace the same person's production session.
 */
export async function enforceSessionCap(
  env: Env,
  user: { sub: string; sid: string; iat: number },
  scope: 'prod' | 'stg',
  nowMs: number = Date.now(),
): Promise<'ok' | 'superseded'> {
  try {
    const key = slotKey(scope, user.sub);
    const slot = await env.SESSIONS.get<SessionSlot>(key, 'json');
    const decision = decideSessionSlot(slot, user, Math.floor(nowMs / 1000));
    if (decision.outcome === 'superseded') return 'superseded';
    if (decision.write) {
      await env.SESSIONS.put(key, JSON.stringify(decision.write), {
        expirationTtl: sessionCapIdleSeconds(env),
      });
    }
    return 'ok';
  } catch (err) {
    // Fail open: the cap must never turn a KV hiccup into a full outage.
    console.error('session_cap_error', {
      detail: err instanceof Error ? err.message : 'unknown',
    });
    return 'ok';
  }
}
