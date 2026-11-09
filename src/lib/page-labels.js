/**
 * Printed page numbers (Dan, Teams 2026-11-06).
 *
 * "P.42 here should print as 'p. 33' for the user in AI Guide and Result Cards
 *  (it is the 42nd page in the pdf, but the printed page number is 33 and that
 *  is all the Lens user should ever see)."
 *
 * Every page IES Lens stores is the PDF page INDEX — the number the Lighting
 * Library viewer's `#page=N` needs. What the reader sees printed on the page is
 * a different number: the folio, counted from the first body page after the
 * front matter. The IES PDFs record it themselves as /PageLabels (pdfjs
 * `getPageLabels()`), and on every current standard checked on 2026-11-09 the
 * label is exactly the printed folio — RP-1-24: index 42 → "33", index 71 →
 * "62"; RP-8-25+E2's chapter-paged layout: index 150 → "6-1", as printed.
 *
 * So: LINKS keep the index; DISPLAY (cards, the Guide's prompt and prose, the
 * table of contents) uses the label. A document without trustworthy labels
 * stores none, and everything keeps printing the index as before.
 *
 * Runtime-agnostic: imported by the Node ingest script, the Worker and tests.
 */

/**
 * The label shapes a printed folio takes in this corpus: arabic ("33"), roman
 * front matter ("iv", "IV"), lettered front matter ("a", "aa", "A"), RP-8's
 * chapter-paged "6-1", its chapter cover pages "6a" and annex cover pages "Aa",
 * annex-paged "A-3", and its glossary "GLa" / "GL-1". An EMPTY label (an unlabelled back cover) is tolerated and
 * reads as "no label" for that page.
 * Anything else — Word's "Sec1:3", a stray "aA" — means the labels were never
 * set by hand and do not describe the print.
 */
const FOLIO_RE = /^(?:\d{1,4}|[ivxlcdm]{1,7}|[IVXLCDM]{1,7}|[A-Za-z]{1,2}|[A-Z]{2}[a-z]|\d{1,2}[a-z]|\d{1,2}-\d{1,3}|[A-Z]{1,2}-?\d{1,3})?$/;

/**
 * Validate the labels pdfjs read for one document.
 *
 * Returns the label array (element i = PDF page i+1) when it is trustworthy,
 * else null. Null also when every label equals its index: nothing to map.
 *
 * Refused, all measured on the deprecated corpus: a label that is not
 * folio-shaped (Word's "Sec1:3"), arabic labels that do not count up by one
 * where they sit side by side ("a,51,51,51" — RP-20-14), and a document whose
 * labels mostly repeat ("III" on every page — LM-74-05).
 *
 * @param {unknown} labels - pdfjs getPageLabels() output (string[] | null)
 * @param {number} [pageCount] - the document's page count, when known
 * @returns {string[] | null}
 */
export function cleanPageLabels(labels, pageCount) {
  if (!Array.isArray(labels) || labels.length === 0) return null;
  if (pageCount != null && labels.length !== pageCount) return null;
  const clean = labels.map(l => (typeof l === 'string' ? l.trim() : ''));
  if (clean.some(l => !FOLIO_RE.test(l))) return null;

  for (let i = 1; i < clean.length; i++) {
    const a = clean[i - 1];
    const b = clean[i];
    if (/^\d+$/.test(a) && /^\d+$/.test(b) && Number(b) !== Number(a) + 1) return null;
  }
  const labelled = clean.filter(Boolean);
  if (labelled.length < clean.length * 0.9) return null;
  if (new Set(labelled).size < labelled.length * 0.9) return null;
  if (clean.every((l, i) => l === String(i + 1) || l === '')) return null;
  return clean;
}

/** standards.page_labels_json → the label array, or null. */
export function parsePageLabels(raw) {
  if (!raw) return null;
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(parsed) && parsed.every(l => typeof l === 'string') ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * The printed label of PDF page `page`, or null when the document has no labels
 * (the caller then prints the index, as before).
 */
export function pageLabelFor(labels, page) {
  if (!Array.isArray(labels)) return null;
  const n = Number(page);
  if (!Number.isInteger(n) || n < 1 || n > labels.length) return null;
  return labels[n - 1] || null;
}

/**
 * Printed label → PDF page index, for every label that names exactly ONE page.
 * RP-8-25+E2 prints "b" on its second page and again on its last; a label
 * shared by two pages cannot be resolved, so it is left out (fail closed: an
 * unresolvable "p. b" in the Guide's prose stays plain text).
 *
 * @returns {Map<string, number>}
 */
export function labelToPageMap(labels) {
  const map = new Map();
  const dup = new Set();
  if (!Array.isArray(labels)) return map;
  labels.forEach((label, i) => {
    if (!label) return;
    if (map.has(label)) dup.add(label);
    else map.set(label, i + 1);
  });
  for (const d of dup) map.delete(d);
  return map;
}

/**
 * The constant (index − printed number) across the arabic labels, when there is
 * one: RP-1-24 → 9. Lets the UI resolve ANY printed page the Guide names to the
 * page index, not only the pages retrieval reached. Null when the arabic labels
 * do not share one offset (RP-8's chapter-paged print), or there are none.
 */
export function pageLabelOffset(labels) {
  if (!Array.isArray(labels)) return null;
  let offset = null;
  for (let i = 0; i < labels.length; i++) {
    if (!/^\d+$/.test(labels[i])) continue;
    const d = (i + 1) - Number(labels[i]);
    if (offset == null) offset = d;
    else if (offset !== d) return null;
  }
  return offset;
}
