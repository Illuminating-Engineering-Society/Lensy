/**
 * Complimentary access, the parts outside the admin queue (client 10/16/26 #6).
 *
 * 1. `hasActiveLensComp` — whether an email holds a live FULL IES Lens comp
 *    (comp_access_grants.scope = 'lens'). Read by the session gate on every
 *    request, so a grant, a revocation and an expiry all take effect in IES
 *    Lens immediately, without waiting for the reader's next sign-in.
 *
 * 2. `pushCompGrant` / `revokeCompGrant` — hand a row to AuthIES, which owns
 *    the Vitrium relationship. AuthIES's authorization webhook reads its own
 *    `comp_grants` table on every Vitrium call: kind 'subscriber' admits every
 *    document (a Lens comp), kind 'documents' admits only the listed Vitrium
 *    document ids (the DO110 grant). That replaces the hand step in the Vitrium
 *    admin app; "do I still need to do that separately in Wicket?" — no.
 *
 * The AuthIES call is bearer-authenticated with COMP_GRANTS_API_SECRET (the
 * same value on both Workers). Unset → nothing is pushed and the row stays
 * "awaiting Vitrium", which is exactly the pre-10/16 behaviour. Never throws.
 */

import { resolveIdpBaseUrl } from './sso';

/** Re-sending the same source_ref + email updates the AuthIES grant in place. */
export function compSourceRef(rowId: number): string {
  return `lens-comp-${rowId}`;
}

export function compGrantsConfigured(env: Env): boolean {
  return !!(env.COMP_GRANTS_API_SECRET || '').trim();
}

export interface CompGrantPush {
  rowId: number;
  email: string;
  kind: 'subscriber' | 'documents';
  /** standards.vitrium_doc_id values; documents only. */
  documents: string[];
  /** Designations, display-only on the AuthIES side. */
  labels: string[];
  /** YYYY-MM-DD, inclusive at both ends — Lensy's own convention. */
  startDate: string;
  endDate: string;
  grantedBy: string | null;
  note: string | null;
}

export type PushOutcome = { ok: true } | { ok: false; error: string };

async function callAuthies(env: Env, requestUrl: string, path: string, body: unknown): Promise<PushOutcome> {
  const secret = (env.COMP_GRANTS_API_SECRET || '').trim();
  if (!secret) return { ok: false, error: 'COMP_GRANTS_API_SECRET is not set — apply the Vitrium step by hand.' };
  try {
    const res = await fetch(`${resolveIdpBaseUrl(env, requestUrl)}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
      body: JSON.stringify(body),
    });
    if (res.ok) return { ok: true };
    let detail = '';
    try { detail = String(((await res.json()) as { error?: unknown }).error ?? ''); } catch { /* not JSON */ }
    return { ok: false, error: `AuthIES answered ${res.status}${detail ? `: ${detail}` : ''}` };
  } catch (err) {
    return { ok: false, error: `AuthIES unreachable: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export function pushCompGrant(env: Env, requestUrl: string, grant: CompGrantPush): Promise<PushOutcome> {
  return callAuthies(env, requestUrl, '/api/comp-grants', {
    email: grant.email,
    kind: grant.kind,
    ...(grant.kind === 'documents' ? { documents: grant.documents } : {}),
    labels: grant.labels,
    starts_at: grant.startDate,
    // AuthIES reads a date-only expires_at as "through that day", matching the
    // end_date Lensy prints in the recipient's email.
    expires_at: grant.endDate,
    source_ref: compSourceRef(grant.rowId),
    granted_by: grant.grantedBy,
    note: grant.note,
  });
}

export function revokeCompGrant(
  env: Env, requestUrl: string, rowId: number, email: string, revokedBy: string | null,
): Promise<PushOutcome> {
  return callAuthies(env, requestUrl, '/api/comp-grants/revoke', {
    source_ref: compSourceRef(rowId), email, revoked_by: revokedBy,
  });
}

// ── SureCart purchases (2026-10-26) ─────────────────────────────────────────
// A webstore lease or subscription takes the same road as a staff comp:
// AuthIES's /api/comp-grants, with `source: 'surecart'` so the audit, the
// window cap (three years) and the idempotency key are the purchase's own.
// `source_ref` is derived from SureCart's purchase id, which is what makes a
// renewal or a staff resync UPDATE the grant in place.

export function purchaseSourceRef(surecartPurchaseId: string): string {
  return `surecart-${surecartPurchaseId}`;
}

export interface PurchaseGrantPush {
  surecartPurchaseId: string;
  email: string;
  /** 'documents' for a lease (one standard), 'subscriber' for a subscription. */
  kind: 'subscriber' | 'documents';
  /** standards.vitrium_doc_id values; documents only. */
  documents: string[];
  labels: string[];
  /** YYYY-MM-DD, inclusive at both ends. */
  startDate: string;
  endDate: string;
  note: string | null;
}

export function pushPurchaseGrant(env: Env, requestUrl: string, g: PurchaseGrantPush): Promise<PushOutcome> {
  return callAuthies(env, requestUrl, '/api/comp-grants', {
    email: g.email,
    kind: g.kind,
    ...(g.kind === 'documents' ? { documents: g.documents } : {}),
    labels: g.labels,
    starts_at: g.startDate,
    expires_at: g.endDate,
    source: 'surecart',
    source_ref: purchaseSourceRef(g.surecartPurchaseId),
    granted_by: 'surecart',
    note: g.note,
  });
}

/**
 * Revoke EVERY grant of this purchase, whatever address it was granted to:
 * AuthIES keys rows on (source, source_ref, email), so a purchase whose
 * customer email changed holds two rows there, and a revoke scoped to the
 * current email would leave the old address live.
 */
export function revokePurchaseGrant(env: Env, requestUrl: string, surecartPurchaseId: string): Promise<PushOutcome> {
  return callAuthies(env, requestUrl, '/api/comp-grants/revoke', {
    source: 'surecart', source_ref: purchaseSourceRef(surecartPurchaseId), revoked_by: 'surecart',
  });
}

/**
 * Does this email hold a live PURCHASED Lighting Library subscription today?
 * Read by the session gate beside `hasActiveLensComp`: a paid subscription
 * is the `full` tier for its window. Fail-closed to false, same reasoning.
 */
export async function hasActivePurchasedSubscription(env: Env, email: string | null | undefined): Promise<boolean> {
  const address = String(email || '').trim().toLowerCase();
  if (!address) return false;
  try {
    const row = await env.DB.prepare(`
      SELECT 1 AS ok FROM purchases
      WHERE kind = 'subscription' AND status = 'active' AND email = ?
        AND start_date <= date('now') AND end_date >= date('now')
      LIMIT 1
    `).bind(address).first<{ ok: number }>();
    return !!row;
  } catch {
    return false;
  }
}

/**
 * Does this email hold a live FULL IES Lens comp today? Fail-closed to false:
 * a D1 problem (or a database before migration 0023) leaves the reader on the
 * tier they otherwise earn — a comp only ever ADDS access.
 */
export async function hasActiveLensComp(env: Env, email: string | null | undefined): Promise<boolean> {
  const address = String(email || '').trim().toLowerCase();
  if (!address) return false;
  try {
    const row = await env.DB.prepare(`
      SELECT 1 AS ok FROM comp_access_grants
      WHERE scope = 'lens' AND email = ? AND status = 'active'
        AND start_date <= date('now') AND end_date >= date('now')
      LIMIT 1
    `).bind(address).first<{ ok: number }>();
    return !!row;
  } catch {
    return false;
  }
}
