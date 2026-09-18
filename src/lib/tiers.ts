/**
 * Access tiers — Subscriber and Non-Subscriber (client DO53, revised DO999).
 *
 * The 2026-09-17 round renamed the product and rewrote the policy:
 *
 *   "'IES Lens' is the tool name, always. Only 1 logo (no more LensyLite)."
 *   "'Subscriber' is a user with full access … a single-user license to the
 *    full Lighting Library plus full IES Lens … No daily search cap."
 *   "'Non-Subscriber' is all other users with a free IES account (including IES
 *    Members without a subscription) … 20x daily search cap (then AI is
 *    disabled for 24hr)."
 *
 *   Lighting Library subscription                → Subscriber      ('full')
 *   IES account, no subscription                 → Non-Subscriber  ('lite')
 *   Any other IES account                        → 'none': may open a saved
 *                                                  collection shared with them,
 *                                                  but has no search access
 *
 * The tier ids stay 'full' / 'lite' / 'none' — they are internal identifiers on
 * the wire, in the response-cache key and in `invited_users.tier`, and renaming
 * them would be a data migration for no reader-visible gain. What changed is
 * what 'lite' GRANTS and what it is CALLED on screen.
 *
 * Non-Subscriber blocks two tools — Illuminance Tables and Document Comparison
 * — and searches only the current Lighting Science collection. **The AI Guide
 * is no longer blocked**: DO999 makes it a metered trial ("then AI is disabled"
 * presupposes it was enabled), bounded by the 20-a-day cap in
 * src/lib/search-cap.ts rather than by tier.
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
 * The webstore collection a Non-Subscriber may search — "the current Lighting
 * Science Collection (the 'Lighting Science' folder in Vitrium)".
 */
export const LITE_COLLECTION = 'Lighting Science';

/** Series prefix used when the Collection metadata has not been synced yet. */
export const LITE_FALLBACK_PREFIX = 'LS-';

/**
 * Tools a Non-Subscriber does not include, by the filter name the UI uses.
 *
 * 'guide' was here until DO999 and is deliberately gone: the AI Guide is now a
 * metered trial for non-subscribers, cut off by the daily cap rather than by
 * tier. Everything the client still sells as a subscriber unlock — "browse
 * illuminance table values", "compare versions" — stays.
 */
export const LITE_BLOCKED_FILTERS = ['tables', 'compare'] as const;

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

/** Ordering used to combine an invitation with what someone holds in Wicket. */
const TIER_RANK: Record<LensyTier, number> = { none: 0, lite: 1, full: 2 };

function highest(a: LensyTier, b: LensyTier): LensyTier {
  return TIER_RANK[a] >= TIER_RANK[b] ? a : b;
}

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
  /**
   * `invited_users.tier` for this email, when there is a row.
   *
   * An invitation is a grant in its own right: it is what someone gets when
   * Wicket says nothing about them at all. It replaced the old `inviteRole`
   * input, which read the ROLE column and treated 'admin'/'staff'/'subscriber'
   * as full — a rule that silently gave a plain 'guest' (the schema's own
   * default) tier 'none', so inviting somebody let them in and showed them
   * nothing.
   */
  inviteTier?: string | null;
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

  // Staff keep every surface: the admin pages are gated on this too.
  if (input.admin) return 'full';

  // What Wicket says they hold, on its own.
  const earned = earnedTier(input, env);

  // An invitation can only ever ADD access. Taking the higher of the two means
  // a 'lite' invite cannot demote someone who separately pays for the Lighting
  // Library, and an invite still stands alone for a guest Wicket knows nothing
  // about — which is the entire purpose of the allowlist.
  const invited = String(input.inviteTier ?? '').toLowerCase();
  const granted: LensyTier = invited === 'full' ? 'full' : invited === 'lite' ? 'lite' : 'none';

  return highest(earned, granted);
}

/** The tier someone's own IES entitlements earn them, ignoring any invitation. */
function earnedTier(input: TierInput, env: { LENSY_SUBSCRIBER_ROLES?: string }): LensyTier {
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
 * The content types a Non-Subscriber search may use.
 *
 * Illuminance Tables are blocked outright, and `compare` (Document Comparison)
 * with them. Documents, Definitions and References stay — the client's own
 * wording is "You may search for standards, references and definitions" —
 * inside the Lighting Science collection, which is where the tier is scoped.
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

/**
 * The banner a Non-Subscriber search prints.
 *
 * Reworded for DO999/DO111: the tier is no longer a separate product with its
 * own name ("no more LensyLite"), and a subscription is always called the
 * Lighting Library ("We will always refer to subscriptions as 'Lighting
 * Library', as the umbrella product").
 */
export const LITE_NOTICE =
  'You are searching the Lighting Science Collection. ' +
  'Subscribe to the Lighting Library to unlock full access.';
