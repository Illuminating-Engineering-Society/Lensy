/**
 * Every Lighting Library deep link Lensy hands out is served from the IES
 * branded host, never from Vitrium's own viewer host.
 *
 * Vitrium's document export (scripts/data/vitrium-webviewer-urls.csv, loaded
 * into standards.vitrium_web_url by scripts/sync-metadata.js) gives each
 * standard an opaque short-code URL on VITRIUM's host:
 *
 *   https://view.protectedpdf.com/2H4QTw#page=43
 *
 * That is not the URL to put in front of a reader. Two failures, both reported
 * by the client:
 *
 *   1. The reader lands on a Vitrium authentication error — the IES Lighting
 *      Library session belongs to lighting.ies.org, not to Vitrium's host.
 *   2. After signing in there, the viewer opens the standard at page 1: the
 *      `#page=N` fragment is never sent to a server, so it does not survive the
 *      sign-in bounce.
 *
 * IES's branded host serves the SAME short codes, so the fix is a host swap and
 * nothing else — path, query and fragment are carried across verbatim:
 *
 *   https://lighting.ies.org/2H4QTw#page=43
 *
 * Applied on the way OUT (where a URL is read from D1) rather than on the way
 * in, so rows already stored with Vitrium's host — synced standards and saved
 * collection items alike — are corrected without a data migration.
 *
 * Plain ESM JS so the Worker, the scripts and the tests share one definition.
 */

/** The IES branded Lighting Library viewer. Origin only — no trailing slash. */
export const LIBRARY_VIEWER_ORIGIN = 'https://lighting.ies.org';

/**
 * Vitrium viewer hosts that must be rewritten. A `www.` prefix is stripped
 * before the comparison, so both spellings of each host match.
 */
const VITRIUM_VIEWER_HOSTS = new Set([
  'view.protectedpdf.com',
  'protectedpdf.com',
]);

/**
 * Rewrite a Vitrium viewer URL onto the IES branded host.
 *
 * Anything else is returned untouched — a DOI, an ies.org glossary page, a
 * bare reference URL and an already-branded link all pass straight through, so
 * this is safe to apply to any link-shaped column.
 *
 * @param {unknown} raw
 * @returns {string|null} the branded URL, the input unchanged, or null when
 *   there was nothing usable to rewrite.
 */
export function toLibraryUrl(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return raw;               // not a URL at all — leave it exactly as stored
  }

  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
  if (!VITRIUM_VIEWER_HOSTS.has(host)) return raw;

  return `${LIBRARY_VIEWER_ORIGIN}${parsed.pathname}${parsed.search}${parsed.hash}`;
}

/**
 * `toLibraryUrl` for a nullable column: null/empty in, null out.
 *
 * @param {unknown} raw
 * @returns {string|null}
 */
export function toLibraryUrlOrNull(raw) {
  return toLibraryUrl(raw) || null;
}
