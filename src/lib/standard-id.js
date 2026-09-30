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
  if (m) return m[2] ? `${m[1]}+${m[2]}` : m[1];
  // A JOINT standard published under another body's numbering, e.g.
  // "ANSI_ASHRAE_IES 90.1-2025.pdf" or "ANSI-ASHRAE-IES-90.1-2025.pdf": the
  // sponsoring bodies (minus the ANSI approval prefix) become the id's letter
  // segments, hyphen-joined, and the number keeps its own year form —
  // "ASHRAE-IES-90.1-2025" (client, 2026-09-28: the uploader refused it).
  const joint = normalizeJointDesignation(stem);
  if (joint) return joint;
  return stem.split(/[_ ]/)[0];
}

/**
 * Accepted shape of a standard id: one to three letter segments, then a number
 * that may carry a dotted part, an edition, and an errata suffix.
 *   RP-43-25 · LM-63-19 · RP-8-25+E2 · RP-27.1-22 · ASHRAE-IES-90.1-2025
 * Shared by the staff dashboard (server and preview) so both refuse and accept
 * the same strings; `${id}-chunk-<n>` must also stay inside Vectorize's 64-byte
 * vector-id limit, which MAX_STANDARD_ID_LENGTH in staff-ingest.ts guards.
 */
export const STANDARD_ID_RE = /^[A-Za-z]{1,6}(?:-[A-Za-z]{1,6}){0,2}-[0-9][0-9A-Za-z.+-]*$/;

/** The IES document series — the letter prefix of every IES designation. */
const IES_SERIES_PREFIXES = new Set(['RP', 'TM', 'HB', 'LM', 'LP', 'LS', 'DG', 'LEM', 'G']);

/**
 * Read a joint designation the way it is printed — "ANSI/ASHRAE/IES 90.1-2025",
 * "ANSI/ASHRAE/IES-90.1-2025", "ANSI ASHRAE IES 90.1-2025" — into the id
 * shape above: "ASHRAE-IES-90.1-2025". The leading ANSI is the approval body,
 * not a sponsor, and is dropped exactly as it is from "ANSI/IES RP-1-24" →
 * "RP-1-24". Returns null for anything that is not a joint designation.
 */
export function normalizeJointDesignation(text) {
  const t = String(text || '').trim();
  const m = /^(?:ANSI[\s\/_-]+)?((?:[A-Z]{2,6}[\s\/_-]+){1,2}[A-Z]{2,6})[\s\/_-]+(\d+(?:\.\d+)?(?:-\d{2,4})?)(?:\s*\+\s*(E\d+))?(?=[\s_]|$)/i.exec(t);
  if (!m) return null;
  const bodies = m[1].split(/[\s\/_-]+/).filter(Boolean).map(b => b.toUpperCase());
  // "ANSI/IES/NALMCO RP-36-24" is an IES designation whose series prefix (RP)
  // landed in the sponsor list — not a joint number. deriveStandardId's own
  // rule owns those; a series prefix is never a sponsoring body.
  if (IES_SERIES_PREFIXES.has(bodies[bodies.length - 1])) return null;
  const id = `${bodies.join('-')}-${m[2]}${m[3] ? `+${m[3].toUpperCase()}` : ''}`;
  return STANDARD_ID_RE.test(id) ? id : null;
}

/**
 * What the staff dashboard's id field accepts, normalized: an ordinary id is
 * returned as typed (trimmed); a joint designation typed as printed is turned
 * into its id form. Anything else is returned trimmed for the caller's own
 * STANDARD_ID_RE check to refuse.
 */
export function normalizeStandardIdInput(input) {
  const raw = String(input || '').trim();
  if (!raw) return raw;
  if (STANDARD_ID_RE.test(raw)) return raw;
  return normalizeJointDesignation(raw) || raw;
}

/**
 * Best-effort full designation when the cover did not yield one: prefix the
 * ANSI/IES form for the series that carry it, else fish it out of the title.
 */
export function inferFullDesignation(standardId, title) {
  if (standardId.startsWith('ANSI/IES')) return standardId;
  if (/^(RP|TM|HB)-/.test(standardId)) return `ANSI/IES ${standardId}`;
  // A joint id ("ASHRAE-IES-90.1-2025") prints as "ANSI/ASHRAE/IES 90.1-2025".
  const joint = /^((?:[A-Z]{2,6}-){1,2}[A-Z]{2,6})-(\d.*)$/.exec(standardId);
  if (joint && !/^(RP|TM|HB|LM|LP|LS|DG|LEM|G)-/.test(standardId)) {
    return `ANSI/${joint[1].replace(/-/g, '/')} ${joint[2]}`;
  }
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
