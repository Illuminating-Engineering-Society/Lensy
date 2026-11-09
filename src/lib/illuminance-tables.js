/**
 * The staff-curated list behind "List Illuminance Tables" (Dan, Teams
 * 2026-11-09 #2, pdfs/Others/261109 List…mTables.pdf).
 *
 * "I'm proposing an admin level of control for table titles & listings just in
 *  case … these are extremely sensitive data sets so we'd want to make sure the
 *  indexing never misses one or misrepresents one."
 *
 * So nothing here GUESSES what a reader sees. Staff enter each table's title and
 * first page in Admin → Standards → Edit; this module:
 *   • validates that entry, and turns the PRINTED page staff typed ("easier for
 *     staff if we can enter printed pdf page #") into the PDF page index the
 *     Library viewer's #page=N needs — refusing a page the document does not
 *     print, rather than linking somewhere plausible;
 *   • offers SUGGESTIONS from what the index already knows (the Table_Ref of
 *     the illuminance rows search returns, and the table captions read at
 *     ingest) — staff accept them one by one, nothing is saved unseen;
 *   • names the tables search returns rows from that the list does not carry,
 *     which Index health raises as a warning ("never misses one").
 *
 * Plain ESM JS: the Worker and the tests share one definition.
 */

import { labelToPageMap, pageLabelFor } from './page-labels.js';

export const MAX_ILLUMINANCE_TABLES = 40;
export const MAX_TABLE_TITLE = 300;

/** "Table A-1. Recommended …" / "Table 17-1 Design …" → "Table A-1"; else null. */
export function tableRefOf(title) {
  const m = /^\s*Table\s+([A-Z]{0,2}-?\d+[A-Za-z]?(?:[-.]\d+[a-z]?)?)\b/i.exec(String(title || ''));
  return m ? `Table ${m[1].toUpperCase()}` : null;
}

/**
 * The printed page staff typed → { page, label }, or { error }.
 *
 * With page labels (migration 0029), the typed label must name exactly ONE page
 * ("60" → PDF page 69 on RP-6-24). Matched as typed first, then ignoring case
 * ("a-3" for "A-3") when that is still unambiguous. Without labels the printed
 * number IS the index, bounded by the page count.
 *
 * @param {unknown} input
 * @param {string[] | null} labels  standards.page_labels_json, parsed
 * @param {number | null} pageCount
 */
export function resolvePrintedPage(input, labels, pageCount) {
  const typed = String(input ?? '').trim().replace(/^p(?:age)?\.?\s*/i, '');
  if (!typed) return { error: 'missing' };
  if (Array.isArray(labels) && labels.length > 0) {
    const map = labelToPageMap(labels);
    if (map.has(typed)) return { page: map.get(typed), label: typed };
    const lower = typed.toLowerCase();
    const hits = [...map.entries()].filter(([l]) => l.toLowerCase() === lower);
    if (hits.length === 1) return { page: hits[0][1], label: hits[0][0] };
    if (labels.filter(l => l === typed).length > 1) return { error: 'ambiguous' };
    return { error: 'not_printed' };
  }
  if (!/^\d+$/.test(typed)) return { error: 'not_printed' };
  const n = Number(typed);
  if (n < 1 || (Number.isInteger(pageCount) && pageCount > 0 && n > pageCount)) return { error: 'out_of_range' };
  return { page: n, label: null };
}

const PAGE_ERRORS = {
  missing: 'needs its first page',
  ambiguous: 'names a page number this document prints on more than one page — open the PDF and type the page as printed on the table',
  not_printed: 'names a page this document does not print — type the page number printed on the table\'s first page',
  out_of_range: 'is past the last page of this document',
};

/**
 * Validate the list staff submitted.
 *
 * @param {unknown} input  [{ title, page }] — `page` is the PRINTED page
 * @param {{ labels: string[] | null, pageCount: number | null }} doc
 * @returns {{ tables: {title: string, page: number, label: string | null}[], error?: undefined }
 *         | { error: string, tables?: undefined }}
 */
export function validateIlluminanceTables(input, { labels, pageCount }) {
  if (!Array.isArray(input)) return { error: 'The illuminance tables must be a list.' };
  if (input.length > MAX_ILLUMINANCE_TABLES) {
    return { error: `At most ${MAX_ILLUMINANCE_TABLES} illuminance tables per standard.` };
  }
  const tables = [];
  const seen = new Set();
  for (let i = 0; i < input.length; i++) {
    const raw = input[i] || {};
    const n = i + 1;
    const title = String(raw.title ?? '').trim().replace(/\s+/g, ' ');
    if (!title) return { error: `Table ${n} needs a title.` };
    if (title.length > MAX_TABLE_TITLE) return { error: `Table ${n}'s title is too long (${MAX_TABLE_TITLE} characters at most).` };
    const key = title.toLowerCase();
    if (seen.has(key)) return { error: `"${title}" is listed twice.` };
    seen.add(key);
    const resolved = resolvePrintedPage(raw.page, labels, pageCount);
    if (resolved.error) return { error: `Table ${n} ("${title}") ${PAGE_ERRORS[resolved.error]}.` };
    tables.push({ title, page: resolved.page, label: resolved.label });
  }
  return { tables };
}

/** standards.illuminance_tables_json → the stored list, or []. */
export function parseIlluminanceTables(raw) {
  if (!raw) return [];
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(t => t && typeof t.title === 'string' && t.title.trim() && Number.isInteger(t.page) && t.page > 0)
      .map(t => ({ title: t.title, page: t.page, label: typeof t.label === 'string' && t.label ? t.label : null }));
  } catch {
    return [];
  }
}

/**
 * A stored entry as a reader sees it today: the printed page is re-read from the
 * CURRENT labels, so a re-ingest that changed the PDF's pagination cannot leave
 * a stale "p. 60" beside a link that now opens elsewhere. `stale` says the page
 * staff typed no longer prints at that index — staff re-check it in Edit.
 */
export function presentIlluminanceTable(entry, labels) {
  const current = pageLabelFor(labels, entry.page);
  const shown = current || entry.label || String(entry.page);
  return {
    title: entry.title,
    page: entry.page,
    label: shown,
    stale: !!(entry.label && current && current !== entry.label),
  };
}

/**
 * The tables search returns illuminance rows from that the curated list does not
 * name. Compared by table reference ("Table A-1"), read off the start of each
 * listed title — so a title must begin with its table number to count.
 *
 * @param {{title: string}[]} listed
 * @param {string[]} searchRefs  DISTINCT applications.Table_Ref for the standard
 * @returns {string[]}
 */
export function unlistedTableRefs(listed, searchRefs) {
  const have = new Set(listed.map(t => tableRefOf(t.title)).filter(Boolean));
  return [...new Set(searchRefs.map(r => tableRefOf(r)).filter(Boolean))]
    .filter(ref => !have.has(ref))
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
}

const ILLUMINANCE_CAPTION_RE = /illuminance|lighting criteria|design criteria|recommended (?:light|illuminance) levels?/i;

/**
 * Suggestions for the Edit modal, best first. Never saved by themselves.
 *
 *   1. Every table search returns illuminance rows from (applications.Table_Ref),
 *      titled from its ingest caption when there is one, at its first page —
 *      the caption's page when it sits on or just before the first row's page,
 *      else the first row's page.
 *   2. Any other table whose caption reads like an illuminance/criteria table
 *      (RP-8's "Design Criteria for Parking Lots" has no illuminance rows).
 *
 * @param {{
 *   appTables: { ref: string, firstPage: number | null }[],
 *   assets: { kind: string, label: string, caption: string, page: number }[],
 *   labels: string[] | null,
 * }} input
 * @returns {{ title: string, page: number, label: string, source: 'search' | 'caption' }[]}
 */
export function suggestIlluminanceTables({ appTables, assets, labels }) {
  const captions = new Map();
  for (const a of assets || []) {
    if (a && a.kind === 'table' && typeof a.label === 'string' && Number.isInteger(a.page)) {
      const ref = tableRefOf(a.label);
      if (ref && !captions.has(ref)) captions.set(ref, a);
    }
  }
  const titleFor = (ref, asset) => (asset && asset.caption ? `${ref}. ${asset.caption}` : ref);
  const out = [];
  const used = new Set();
  for (const t of appTables || []) {
    const ref = tableRefOf(t.ref);
    if (!ref || used.has(ref)) continue;
    used.add(ref);
    const asset = captions.get(ref);
    const first = Number.isInteger(t.firstPage) ? t.firstPage : null;
    const page = asset && (first == null || (asset.page <= first && first - asset.page <= 3))
      ? asset.page
      : first;
    if (!page) continue;
    out.push({ title: titleFor(ref, asset), page, label: pageLabelFor(labels, page) || String(page), source: 'search' });
  }
  for (const [ref, asset] of captions) {
    if (used.has(ref) || !ILLUMINANCE_CAPTION_RE.test(asset.caption || '')) continue;
    used.add(ref);
    out.push({ title: titleFor(ref, asset), page: asset.page, label: pageLabelFor(labels, asset.page) || String(asset.page), source: 'caption' });
  }
  return out.sort((a, b) => a.page - b.page);
}
