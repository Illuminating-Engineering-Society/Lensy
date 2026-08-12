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
 * ─── Where the signal comes from (resolved 2026-08-12) ───────────────────────
 *
 * Wicket is the system of record. It files an IES grade and a Lighting Library
 * purchase in the SAME resource — a person membership — separated only by
 * `attributes.membership_category`:
 *
 *   'membership' | 'staff' | 'affiliate_membership'  → an IES membership
 *                                                      (cookie `isMember`)
 *   'subscription'                                   → a purchased product
 *
 * The AuthIES import slugifies each subscription tier name into `roles_json`,
 * which rides the `ies_auth` cookie as a role slug. So the rule Shane Skwarek
 * stated and Dan Ozminkowski confirmed — full = Lighting Library subscription,
 * lite = active IES membership — needs no code here, only
 * LENSY_SUBSCRIBER_ROLES="lighting-library-full-access".
 *
 * The check stays written against a CONFIGURABLE slug list rather than that
 * literal, because the tier NAME is client-editable text in Wicket's admin.
 *
 * ─── Open product question: the narrower subscriptions ───────────────────────
 *
 * Wicket sells products that are not the whole Library, and none of them grants
 * `full` today, so their holders land on `lite`:
 *
 *   "The Illuminance Selector"              205 people
 *   "Lighting Practice Collection"            3
 *   "Lighting Applications Collection"        3
 *   "Lighting Science Collection"             3
 *   "Roadway Lighting Collection"             3
 *   "Lighting Testing & Measurements"         3
 *
 * Two of those map badly and IES has to decide, because the answer is product
 * policy and not something this module should invent:
 *
 *  - Illuminance Selector subscribers are paying for exactly the tool Lensy
 *    replaces, yet `lite` is the one tier that LOCKS Illuminance Tables.
 *  - A Lighting Science Collection subscriber gets, on `lite`, precisely the
 *    collection they paid for — free to every member.
 *
 * Nobody is harmed yet: none of these people has activated an IdP password, so
 * none can sign in. Settle it before they do.
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

/**
 * Role slugs that mean "has a Lighting Library subscription", by default.
 *
 * These were guesses made before the entitlement was found, and Wicket emits
 * NONE of them — the real slug is `lighting-library-full-access`, set through
 * LENSY_SUBSCRIBER_ROLES in wrangler.toml. They are kept only so a deployment
 * that never configures the var still recognizes something plausible; the
 * configured value is what production actually runs on.
 */
const DEFAULT_SUBSCRIBER_ROLES = [
  'lighting-library-full-access',
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
