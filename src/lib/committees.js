/**
 * Authoring technical committee attribution (client feedback DO34).
 *
 * "Display the authoring technical committee name in small font below document
 *  title in each search result, linked to its public technical committee page. If
 *  no exact match (committees occasionally are dissolved), can link to the root
 *  list of technical committees at that URL instead.
 *  Note: Format all committee names as 'IES [Committee Name]'."
 *
 * The committee name arrives as the standard's `author` — per the client, Vitrium's
 * "Author" metadata carries it — so this module turns whatever that field says
 * into a display name and a URL that is never fabricated:
 *
 *   "Retail Lighting Committee"  → IES Retail Lighting Committee
 *                                  https://ies.org/committee/retail-lighting/
 *   "IES Nomenclature Cmte."     → IES Nomenclature Committee
 *                                  https://ies.org/committee/nomenclature/
 *   "Ad Hoc Working Group"       → IES Ad Hoc Working Group
 *                                  (root committee list — no page to link)
 *
 * Matching is against src/config/technical-committees.json, scraped from the
 * public committee index. A name that does not resolve links to the root list
 * rather than to a guessed slug: a 404 on ies.org is worse than a general page.
 *
 * Plain ESM JS (no TypeScript) so the Node scripts and the Worker share it.
 */

import registry from '../config/technical-committees.json';

export const COMMITTEES_ROOT_URL = registry._rootUrl;

// name (normalized) → slug, built once from the registry.
const BY_NAME = new Map(
  Object.entries(registry.committees).map(([slug, name]) => [normalizeName(name), slug])
);
const SLUGS = new Set(Object.keys(registry.committees));

/**
 * Fold a committee name to a comparable key: lowercase, abbreviations expanded,
 * the word "committee" and any IES prefix dropped, punctuation removed.
 *
 * Vitrium's Author field is typed by hand, so the same committee appears as
 * "Retail Lighting Committee", "IES Retail Lighting Committee", "Retail Lighting
 * Cmte." and "Retail Lighting". All four must resolve to one slug.
 */
function normalizeName(raw) {
  return String(raw || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\bcmte\.?\b|\bcttee\.?\b/g, 'committee')
    .replace(/^(?:ansi\/)?ies\s+/, '')
    .replace(/\bcommittees?\b/g, ' ')
    .replace(/\bthe\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Resolve a standard's author/committee field to what a result card should show.
 *
 * @param {string|null|undefined} author the standard's `author` metadata
 * @returns {{name: string, url: string, exact: boolean}|null}
 *   `name` is display-ready ("IES Retail Lighting Committee"), `url` is the
 *   committee page when one exists and the root list otherwise, and `exact` says
 *   which of the two it is. null when there is no attribution to show.
 */
export function resolveCommittee(author) {
  const raw = String(author || '').trim();
  if (!raw) return null;

  // Author sometimes holds a person, a department, or boilerplate rather than a
  // committee. Only attribute what reads like a committee or working group —
  // crediting "Senior Manager of Technical Content" as the authoring committee
  // would be wrong, and inventing a link for it worse.
  const key = normalizeName(raw);
  const slug = BY_NAME.get(key);
  if (slug) {
    return {
      name: `IES ${registry.committees[slug]}`,
      url: `https://ies.org/committee/${slug}/`,
      exact: true,
    };
  }

  if (!looksLikeCommittee(raw)) return null;

  return { name: formatCommitteeName(raw), url: COMMITTEES_ROOT_URL, exact: false };
}

/** Does this author string name a committee (or working group) at all? */
export function looksLikeCommittee(raw) {
  return /\b(?:committee|cmte|cttee|subcommittee|working\s+group|task\s+group|panel)\b/i.test(String(raw || ''));
}

/**
 * "retail lighting cmte." → "IES Retail Lighting Committee".
 *
 * Used for committees absent from the registry (newly formed, renamed, or
 * dissolved) so the credit still reads consistently even without a page to
 * link — the client asked for one format everywhere.
 */
export function formatCommitteeName(raw) {
  // No trailing \b on the abbreviation patterns: it would refuse to consume the
  // period in "cmte." (the boundary sits between "e" and ".", not after it),
  // leaving "…Committee." with a stray full stop.
  let name = String(raw || '').trim()
    .replace(/^(?:ansi\/)?ies\s+/i, '')
    .replace(/\bcmte\.?/gi, 'Committee')
    .replace(/\bcttee\.?/gi, 'Committee')
    .replace(/\s+/g, ' ')
    .replace(/[.,;:]+$/, '')
    .trim();
  // Every committee is titled "… Committee" on ies.org; keep working groups and
  // task groups as they are.
  if (!/\b(?:committee|working group|task group|panel)\b/i.test(name)) {
    name = `${name} Committee`;
  }
  return `IES ${name}`;
}

/** Is this slug one the public committee index actually publishes? */
export function isKnownCommitteeSlug(slug) {
  return SLUGS.has(String(slug || '').toLowerCase());
}
