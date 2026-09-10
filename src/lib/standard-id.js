/**
 * Standard-id derivation — pure, runtime-agnostic.
 *
 * Shared by the Node ingest script (scripts/ingest-pdfs.js) and the staff
 * dashboard's ingest jobs (src/workers/staff-ingest.ts), so a PDF uploaded
 * from the browser lands under exactly the id a CLI ingest of the same file
 * would have used.
 */

/**
 * Derive a clean IES standard ID from a (prototype) filename, e.g.
 *   "RP-43-25_v7_Prototype_260420-NEW_TABLE.pdf" → "RP-43-25"
 *   "RP-3-20+E1 Prototype_260519-NEW_TABLE.pdf"  → "RP-3-20+E1"
 *   "RP-8-25 + E2_v1 260527-NEW_TABLE.pdf"       → "RP-8-25+E2"
 *   "RP-27.1-22.pdf"                              → "RP-27.1-22"
 *
 * The errata suffix ("+E1"/"+E2") is preserved (with surrounding spaces
 * normalized away) so an errata revision never collides with its base — e.g.
 * "RP-8-25 + E1_Full" (STANDARD) and "RP-8-25 + E2 …NEW_TABLE" stay distinct.
 * Falls back to the first whitespace/underscore token if no match.
 *
 * Accepts a bare filename or a full path (both separators handled).
 */
export function deriveStandardId(filename) {
  const name = String(filename || '').replace(/^.*[\\/]/, '');
  const stem = name.replace(/\.[^.]*$/, '');
  const m = stem.match(/^([A-Z]{1,3}-\d+(?:\.\d+)?(?:-\d+)?)\s*(?:\+\s*(E\d+))?/i);
  if (!m) return stem.split(/[_ ]/)[0];
  return m[2] ? `${m[1]}+${m[2]}` : m[1];
}

/**
 * Best-effort full designation when the cover did not yield one: prefix the
 * ANSI/IES form for the series that carry it, else fish it out of the title.
 */
export function inferFullDesignation(standardId, title) {
  if (standardId.startsWith('ANSI/IES')) return standardId;
  if (/^(RP|TM|HB)-/.test(standardId)) return `ANSI/IES ${standardId}`;
  const match = title?.match(/ANSI\/IES\s+[\w-]+/);
  return match ? match[0] : standardId;
}

/**
 * The standard "family" — the id minus its trailing 2-digit edition year and
 * any errata suffix: "RP-6-15" → "RP-6", "RP-27.1-22" → "RP-27.1",
 * "RP-36-20+E2" → "RP-36". Returns null when the id does not carry an edition
 * year (same rule as findSupersedingStandard in src/workers/ingest.ts).
 */
export function standardFamilyOf(standardId) {
  const m = /^(.+)-\d{2}(?:\+E\d+)?$/.exec(String(standardId || ''));
  return m ? m[1] : null;
}
