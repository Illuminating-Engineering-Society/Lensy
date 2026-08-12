/**
 * Invited-users (guest access) domain logic — pure functions only.
 *
 * The D1 table (migrations/0007_invited_users.sql) is a staff-managed
 * allowlist: today it only backs the /admin/users.html dashboard; once Lensy
 * is registered as a Service Provider of auth.ies.org, the SSO callback will
 * call hasAccess() with the authenticated email's row to gate entry.
 *
 * Kept free of Worker bindings so it is unit-testable with plain vitest.
 */

/**
 * What an invite row's `role` decides: ADMIN RIGHTS, and nothing else.
 *
 * It used to also decide the access tier, through LensyLite's
 * FULL_ACCESS_INVITE_ROLES. That is now `tier` below — see INVITE_TIERS.
 */
export const INVITE_ROLES = ['guest', 'staff', 'admin'] as const;
export type InviteRole = (typeof INVITE_ROLES)[number];

/**
 * What an invitation GRANTS.
 *
 * An invitation stands on its own: it admits somebody to Lensy regardless of
 * IES membership, Wicket roles or any subscription, and this is how much of
 * Lensy they see. It can only ever ADD access — an invited person who
 * separately holds a Lighting Library subscription still resolves to full (see
 * resolveTier in lib/tiers.ts), so a 'lite' invite can never demote a paying
 * subscriber.
 */
export const INVITE_TIERS = ['full', 'lite'] as const;
export type InviteTier = (typeof INVITE_TIERS)[number];

export const INVITE_STATUSES = ['invited', 'active', 'revoked'] as const;
export type InviteStatus = (typeof INVITE_STATUSES)[number];

/** Fields accepted when creating an invite (POST /api/admin/users). */
export interface NewInvite {
  email: string;
  name: string | null;
  organization: string | null;
  role: InviteRole;
  tier: InviteTier;
  expires_at: string | null;
  notes: string | null;
}

export type ParseInviteResult =
  | { ok: true; value: NewInvite }
  | { ok: false; reason: string };

// Deliberately permissive: one @, no spaces, a dot in the domain. The real
// gate is the SSO provider — this only catches obvious typos at invite time.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const email = raw.trim().toLowerCase();
  return EMAIL_RE.test(email) ? email : null;
}

function cleanOptional(raw: unknown, maxLen = 300): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  return s ? s.slice(0, maxLen) : null;
}

/** Accepts 'YYYY-MM-DD' or a full ISO timestamp; anything else is invalid. */
export function normalizeExpiry(raw: unknown): { ok: boolean; value: string | null } {
  if (raw == null || raw === '') return { ok: true, value: null };
  if (typeof raw !== 'string') return { ok: false, value: null };
  const s = raw.trim();
  if (Number.isNaN(Date.parse(s))) return { ok: false, value: null };
  // Date-only expiries mean "valid through that day" — store end of day UTC.
  return { ok: true, value: /^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T23:59:59Z` : s };
}

/** Validate + normalize one invite payload. Never throws. */
export function parseInvite(input: unknown): ParseInviteResult {
  if (typeof input !== 'object' || input === null) {
    return { ok: false, reason: 'Invite must be an object' };
  }
  const body = input as Record<string, unknown>;

  const email = normalizeEmail(body.email);
  if (!email) return { ok: false, reason: 'Invalid or missing email' };

  const role = typeof body.role === 'string' ? body.role.trim().toLowerCase() : 'guest';
  if (!(INVITE_ROLES as readonly string[]).includes(role)) {
    return { ok: false, reason: `Invalid role "${role}" (expected ${INVITE_ROLES.join(' | ')})` };
  }

  // Defaults to 'full', matching the column default and what the five rows
  // that predate this field already get. Staff pick it explicitly per invite.
  const tier = typeof body.tier === 'string' ? body.tier.trim().toLowerCase() : 'full';
  if (!(INVITE_TIERS as readonly string[]).includes(tier)) {
    return { ok: false, reason: `Invalid tier "${tier}" (expected ${INVITE_TIERS.join(' | ')})` };
  }

  const expiry = normalizeExpiry(body.expires_at);
  if (!expiry.ok) return { ok: false, reason: 'Invalid expires_at (use YYYY-MM-DD or ISO timestamp)' };

  return {
    ok: true,
    value: {
      email,
      name: cleanOptional(body.name),
      organization: cleanOptional(body.organization),
      role: role as InviteRole,
      tier: tier as InviteTier,
      expires_at: expiry.value,
      notes: cleanOptional(body.notes, 1000),
    },
  };
}

/** Minimal row shape needed for access decisions. */
export interface InviteAccessRow {
  status: string;
  expires_at: string | null;
}

/**
 * Status as it should be displayed/enforced: a stored 'invited'/'active' row
 * whose expires_at has passed reads as 'expired'. 'revoked' always wins.
 */
export function effectiveStatus(row: InviteAccessRow, nowMs: number): string {
  if (row.status === 'revoked') return 'revoked';
  if (row.expires_at) {
    const exp = Date.parse(row.expires_at);
    if (!Number.isNaN(exp) && exp < nowMs) return 'expired';
  }
  return row.status;
}

/**
 * Future SSO gate: 'invited' rows get in on first login (the callback will
 * flip them to 'active'); 'revoked' and expired rows do not.
 */
export function hasAccess(row: InviteAccessRow, nowMs: number): boolean {
  const status = effectiveStatus(row, nowMs);
  return status === 'invited' || status === 'active';
}
