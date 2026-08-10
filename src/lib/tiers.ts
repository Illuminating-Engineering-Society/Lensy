/**
 * Access tiers — Lensy and LensyLite (client DO53).
 *
 * "Begin development of 'LensyLite'. Provide limited access to IES Members who
 *  do not subscribe to the Lighting Library."
 *
 *   Lighting Library subscription                → Lensy      ('full')
 *   IES individual member, no subscription       → LensyLite  ('lite')
 *   Any other IES account                        → 'none': may open a saved
 *                                                  collection shared with them,
 *                                                  but has no search access
 *
 * LensyLite shows every tool and BLOCKS three of them — Illuminance Tables,
 * the AI Guide and Document Comparison — and searches only the current Lighting
 * Science collection.
 *
 * ─── Two things this module is deliberately careful about ────────────────────
 *
 * 1. THE SUBSCRIPTION SIGNAL DOES NOT EXIST YET. The `ies_auth` cookie carries
 *    `isMember`, `memberTier` and the IdP's role slugs; none of them says
 *    "subscribes to the Lighting Library" today. So the check is written against
 *    a CONFIGURABLE list of role slugs (LENSY_SUBSCRIBER_ROLES) plus the member
 *    tier, and when IES publishes the real entitlement it is a var change rather
 *    than a code change.
 *
 * 2. IT IS OFF BY DEFAULT. With LENSY_LITE unset, every authorized visitor is
 *    'full' — exactly today's behaviour. Turning tiering on before the
 *    subscription signal is real would demote the client's own reviewers, who
 *    are IES members, in the middle of their beta. `LENSY_LITE=on` opts in.
 */

import type { ContentType } from '../types';

export type LensyTier = 'full' | 'lite' | 'none';

/**
 * The webstore collection LensyLite may search — "the current Lighting Science
 * Collection (the 'Lighting Science' folder in Vitrium)".
 */
export const LITE_COLLECTION = 'Lighting Science';

/** Series prefix used when the Collection metadata has not been synced yet. */
export const LITE_FALLBACK_PREFIX = 'LS-';

/** Tools LensyLite does not include, by the filter name the UI uses. */
export const LITE_BLOCKED_FILTERS = ['tables', 'guide', 'compare'] as const;

/** Role slugs that mean "has a Lighting Library subscription", by default. */
const DEFAULT_SUBSCRIBER_ROLES = [
  'lighting-library', 'lighting_library', 'library-subscriber',
  'lensy-subscriber', 'subscriber',
];

/** invited_users.role values that always keep full access. */
const FULL_ACCESS_INVITE_ROLES = new Set(['admin', 'staff', 'subscriber']);

/** Is tiering switched on for this deployment? */
export function liteEnabled(env: { LENSY_LITE?: string }): boolean {
  return String(env?.LENSY_LITE ?? '').toLowerCase() === 'on';
}

function subscriberRoles(env: { LENSY_SUBSCRIBER_ROLES?: string }): string[] {
  const raw = String(env?.LENSY_SUBSCRIBER_ROLES ?? '').trim();
  const configured = raw ? raw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean) : [];
  return configured.length > 0 ? configured : DEFAULT_SUBSCRIBER_ROLES;
}

export interface TierInput {
  /** IdP role slugs, already lowercased. */
  roles?: string[];
  /** IES membership, from the IdP directory. */
  isMember?: boolean;
  memberTier?: string | null;
  /** invited_users.role for this email, when there is a row. */
  inviteRole?: string | null;
  /** Staff rights (decideAccess.admin). */
  admin?: boolean;
}

/**
 * Which Lensy a visitor gets.
 *
 * @param input  what the session says about them
 * @param env    LENSY_LITE / LENSY_SUBSCRIBER_ROLES
 */
export function resolveTier(input: TierInput, env: { LENSY_LITE?: string; LENSY_SUBSCRIBER_ROLES?: string }): LensyTier {
  // Tiering off → Lensy behaves as it always has.
  if (!liteEnabled(env)) return 'full';

  // Staff and anyone IES explicitly invited as a subscriber keep everything.
  if (input.admin) return 'full';
  const inviteRole = String(input.inviteRole ?? '').toLowerCase();
  if (FULL_ACCESS_INVITE_ROLES.has(inviteRole)) return 'full';

  const roles = (input.roles ?? []).map(r => String(r).toLowerCase());
  const subscriber = subscriberRoles(env);
  if (roles.some(r => subscriber.includes(r))) return 'full';

  // The member tier is free text at the IdP, so match it loosely — but only on
  // words that actually mean a Library entitlement.
  const tier = String(input.memberTier ?? '').toLowerCase();
  if (/lighting\s*library|library\s*subscri|subscriber/.test(tier)) return 'full';

  if (input.isMember) return 'lite';
  return 'none';
}

/**
 * The content types a LensyLite search may use.
 *
 * Illuminance Tables are blocked outright, and `compare` (Document Comparison)
 * with them. Documents, Definitions and References stay — inside the Lighting
 * Science collection, which is where LensyLite's corpus is scoped.
 */
export function liteContentTypes(contentTypes: Set<ContentType>): Set<ContentType> {
  const allowed = new Set<ContentType>(
    [...contentTypes].filter(t => t !== 'tables' && t !== 'compare')
  );
  // Never end up with nothing selected: an all-tables request becomes a
  // document search rather than an empty result page.
  if (allowed.size === 0) allowed.add('body');
  return allowed;
}

/** The banner LensyLite prints, verbatim from the client's mockup. */
export const LITE_NOTICE =
  'IES Members receive limited access to Lighting Science Collection and LensyLite. ' +
  'Subscribe to unlock full Lensy and Lighting Library access.';
