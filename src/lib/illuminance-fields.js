/**
 * Shared rules for two illuminance-table fields the client flagged as displaying
 * inconsistently (feedback DO20 / DO21).
 *
 * Used by BOTH sides so ingest and search can never disagree:
 *   - scripts / src/lib/applications-extractor.js  (what gets stored)
 *   - src/workers/search.ts                        (what gets displayed)
 *
 * Plain ESM JS (no TypeScript) so the Node ingestion scripts can import it
 * without a build step.
 *
 * 1. LIGHTING ZONE — printed as "Lz4", "LZ4", "L Z 4" or "Lighting Zone 4"
 *    (all equivalent), sometimes paired with a curfew zone: "Lz3 (and Lz4
 *    curfew)". It may live in a dedicated column OR, in the newer table schema,
 *    as a hierarchy label (App_s1…App_s6). Accepting only the bare "Lz4" form
 *    is what left every RP-2 curfew row without a Lighting Zone field.
 *
 * 2. ENVIRONMENTAL & VISUAL CONSIDERATIONS — Glare / Uplight / Controls /
 *    Spectrum. Only standards that actually print these columns may show them.
 *    The row parser infers them heuristically from row text, so elsewhere they
 *    are misreads (the word "curfew" inside a lighting-zone label surfacing as
 *    a Controls requirement).
 */

// Zone designation in any printed form.
const LIGHTING_ZONE_RE = /(?:^|\b)(?:lighting\s*zone|l\s*z)\s*[-:]?\s*([0-4])\b/i;
// The paired curfew zone: "(and Lz4 curfew)".
const CURFEW_ZONE_RE = /\(?\s*(?:and\s+)?(?:lighting\s*zone|l\s*z)\s*[-:]?\s*([0-4])\s*curfew\s*\)?/i;
// A printed zone cell is a short label, never a sentence that mentions a zone.
const MAX_ZONE_LABEL_LENGTH = 40;

/**
 * Parse a single cell / hierarchy label as a lighting-zone designation.
 *
 * @param {unknown} value
 * @returns {{label: string, code: string, curfew: string|null}|null} null when
 *          the text is not a zone label.
 */
export function parseLightingZoneLabel(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text || text.length > MAX_ZONE_LABEL_LENGTH) return null;
  const m = LIGHTING_ZONE_RE.exec(text);
  if (!m) return null;
  const curfew = CURFEW_ZONE_RE.exec(text);
  return {
    label: text,
    code: `LZ${m[1]}`,
    curfew: curfew ? `Lz${curfew[1]} curfew` : null,
  };
}

/**
 * Standards whose printed illuminance tables carry the dedicated
 * "Environmental and Visual Considerations" columns. Today that is RP-43-25
 * alone; add a family prefix here as other documents adopt the columns.
 */
export const ENV_CONSIDERATION_FAMILIES = ['RP-43'];

/**
 * @param {string|null|undefined} standard - standard id, e.g. "RP-43-25"
 * @returns {boolean} whether Glare / Uplight / Controls / Spectrum may display.
 */
export function hasEnvConsiderationColumns(standard) {
  if (!standard) return false;
  const id = String(standard).toUpperCase();
  return ENV_CONSIDERATION_FAMILIES.some(fam => id === fam || id.startsWith(`${fam}-`));
}
