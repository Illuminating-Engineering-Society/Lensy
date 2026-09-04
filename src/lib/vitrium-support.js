/**
 * Vitrium custom error page support (client note, 2026-09-04).
 *
 * When the Lighting Library's WebViewer refuses a reader, Vitrium redirects to
 * a page we host, carrying everything it knows in the query string:
 *
 *   /library-error.html?username=<vitrium username>&userid=<guid>
 *     &url=https%3A%2F%2Fview.protectedpdf.com%2FForbidden%2F<shortcode>
 *     &message=You+have+exceeded+your+device+limit+(vc3).&lang=en
 *
 * (Contract measured against Vitrium's own sample project,
 * https://www.vitrium.com/hubfs/api-samples/CustomErrorPage.zip, April 2023.)
 *
 * This module is the pure logic both sides need: the Worker endpoints
 * (src/workers/library-support.ts) and their tests. The page itself
 * (src/frontend/library-error.html) carries a copy of the same two parsers in
 * its inline script — it must keep working if IES later hosts it off this
 * origin, so it imports nothing.
 *
 * The error-code vocabulary is Vitrium's published Error Code Reference Guide
 * (https://www.vitrium.com/hubfs/support-pdfs/vitrium-error-code-reference-guide-1.pdf):
 * 2p3, 3yq, 4k3, 7rp, 7ud, bw5, dovc3, dpvc3, dvc3, g45, gf4, gf5, ipvc3, m47,
 * n4p, ps1, qe2, qs2, rc7, rc8, rc9, rqe2, vc3, vp3, w29.
 */

/**
 * The codes whose documented fix is Vitrium admin → Users tab → "Clear Use":
 * every usage-limit error a reader can hit. These are the ONLY codes the
 * device-reset request endpoint accepts — the client's flow ("they submit a
 * form which goes to staff for approval to reset device limit") makes sense
 * for exactly this family and no other.
 */
export const CLEAR_USE_CODES = new Set([
  'vc3',    // Exceeded Device Limit — the case the client named
  'dvc3',   // Exceeded Content Limit (library/account limit)
  'dovc3',  // Exceeded Open Limit
  'dpvc3',  // Exceeded Print Limit
  'vp3',    // Exceeded Print Limit (download-to-print)
  'ipvc3',  // IP Address Not Covered
]);

/** What each Clear-Use code means, for the staff notification email. */
export const CLEAR_USE_LABELS = {
  vc3: 'Exceeded device limit',
  dvc3: 'Exceeded content limit (library/account limit)',
  dovc3: 'Exceeded open limit',
  dpvc3: 'Exceeded print limit',
  vp3: 'Exceeded print limit (download to print)',
  ipvc3: 'IP address not covered by the license',
};

/** A Vitrium viewer short code: opaque, alphanumeric, short. */
const SHORT_CODE_RE = /^[A-Za-z0-9]{4,16}$/;

/** Hosts a viewer URL can legitimately arrive on. */
const VIEWER_HOSTS = new Set([
  'view.protectedpdf.com',
  'protectedpdf.com',
  'lighting.ies.org',
]);

/**
 * Is this string usable as a viewer short code on its own?
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isShortCode(value) {
  return typeof value === 'string' && SHORT_CODE_RE.test(value);
}

/**
 * The document short code inside a viewer URL, or null.
 *
 * Vitrium hands the error page the URL the reader was refused on, which is the
 * document's own viewer URL with a `/Forbidden` segment injected:
 * `https://view.protectedpdf.com/Forbidden/gghmRV`. The same short code serves
 * the document on the branded host (src/lib/library-url.js), so it is the join
 * key back to standards.vitrium_web_url.
 *
 * Deliberately strict: an unknown host, extra path segments, or a segment that
 * does not look like a short code all return null — the error page still works
 * without a resolved document; a wrong join would name the wrong standard.
 *
 * @param {unknown} raw
 * @returns {string|null}
 */
export function shortCodeFromViewerUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  let parsed;
  try {
    parsed = new URL(raw.trim());
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
  if (!VIEWER_HOSTS.has(host)) return null;

  const segments = parsed.pathname
    .split('/')
    .filter(Boolean)
    .filter(s => s.toLowerCase() !== 'forbidden');
  if (segments.length !== 1) return null;
  return SHORT_CODE_RE.test(segments[0]) ? segments[0] : null;
}

/**
 * The DRM error code inside a Vitrium message, lowercased, or null.
 *
 * Vitrium appends the code in parentheses — "You have exceeded your device
 * limit (vc3)." — and its own sample takes the LAST parenthesized token, which
 * matters because a message could contain earlier parentheses. A trailing
 * period after the parens is normal.
 *
 * @param {unknown} message
 * @returns {string|null}
 */
export function errorCodeFromMessage(message) {
  if (typeof message !== 'string') return null;
  const matches = message.match(/\(([A-Za-z0-9]{2,8})\)/g);
  if (!matches || matches.length === 0) return null;
  const last = matches[matches.length - 1];
  return last.slice(1, -1).toLowerCase();
}
