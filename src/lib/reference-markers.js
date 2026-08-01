/**
 * In-body reference markers (client feedback DO31.4).
 *
 * A Reference result card shows a bibliography entry from the back of a standard
 * and, next to it, chips for the standards whose References sections list the
 * same work. The client asked those chips to open the place in the body where the
 * work is actually cited — the superscripted numeral — not the References page:
 *
 *   "must search for matches to reference title at back of each standard, then
 *    search for that footnote number ('reference marker') in body of document,
 *    then return first page # matched."
 *
 * The second half of that is what this module does. `pdf-parser.js` records each
 * line's raised small-font numerals in `line.marks`; here they are reduced to a
 * map of marker number → the FIRST body page that prints it. `scripts/ingest-pdfs.js`
 * ships the map with the standard and `src/workers/ingest.ts` stores it on the
 * D1 row, so search can resolve a reference entry's own number to a page without
 * touching the PDF.
 *
 * The first half — matching an entry across standards — is `referenceCitationKey()`
 * in references.js, and the entry's number is read off the front of its text.
 *
 * Plain ESM JS (no TypeScript) so the Node ingestion scripts import it directly.
 */

/**
 * Illuminance-criteria pages print their OWN footnote markers as raised numerals
 * ("Ramps, Stairs, and Steps⁶"), which are table footnotes, not reference
 * citations. They must not pollute the map, so table pages are skipped: a
 * criteria grid is unmistakable from the density of dual-unit data cells.
 */
function isCriteriaTablePage(page) {
  const text = page.text || '';
  const dataCells = (text.match(/\d+(?:\.\d+)?\s*(?:lx|lux|fc)\s*@/gi) || []).length;
  return dataCells >= 3;
}

/**
 * Reduce parsed pages to { markerNumber: firstPageNumber }.
 *
 * @param {Array<{number:number, text?:string, lines?:Array<{marks?:number[]}>}>} pages
 * @returns {Record<string, number>} marker number (as a string key) → page
 */
export function extractReferenceMarkers(pages) {
  const firstPage = new Map();

  for (const page of pages || []) {
    if (isCriteriaTablePage(page)) continue;
    for (const line of page.lines || []) {
      for (const n of line.marks || []) {
        if (!firstPage.has(n)) firstPage.set(n, page.number);
      }
    }
  }

  // Sorted numerically so the stored JSON reads in reference order.
  const out = {};
  for (const [n, pageNumber] of [...firstPage.entries()].sort((a, b) => a[0] - b[0])) {
    out[String(n)] = pageNumber;
  }
  return out;
}

/**
 * The reference NUMBER a bibliography entry was printed under.
 *
 * IES References sections number their entries, and the extracted chunk keeps
 * that number at the front of the text ("6 International Commission on
 * Illumination (CIE). CIE 015:2018, …" or "[6] …" or "6. …"). That number is what
 * the in-body superscript refers to, so it is the join key between an entry and
 * `extractReferenceMarkers()`'s map.
 *
 * @param {string} text
 * @returns {number|null}
 */
export function referenceEntryNumber(text) {
  if (!text) return null;
  const m = /^\s*\[?(\d{1,3})\]?[.)]?\s+\S/.exec(String(text));
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 1 && n <= 999 ? n : null;
}
