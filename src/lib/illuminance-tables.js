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
      .map(t => ({
        title: t.title, page: t.page, label: typeof t.label === 'string' && t.label ? t.label : null,
        // A review note left by the pre-fill (scripts/prefill-illuminance-tables.js):
        // shown in Edit only, and gone once staff save the list (the validator
        // never writes one).
        ...(typeof t.note === 'string' && t.note ? { note: t.note } : {}),
      }));
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
    ...(entry.note ? { note: entry.note } : {}),
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

/** How far before a table's first row its caption may sit (a caption page, a heading). */
const CAPTION_LEAD_PAGES = 3;

/**
 * Is an ingest caption a real table title? The caption reader (document-assets.js)
 * also catches cross-references that START like a caption — "Table A-3 (see
 * Section A.3). These values are based on…" (RP-43-25 p. 70), "Table A-1
 * (Annex A)" (RP-37-25) — and two-column bleed ("… for Various FOV and sons, it
 * may be desirable to use…", RP-8-25+E2). Such a caption supplies neither a
 * title nor a page: its page is where the TEXT mentions the table.
 */
export function usableCaption(caption) {
  const c = String(caption || '').trim();
  if (c.length < 4 || c.length > 140) return false;
  if (/^[(\[]/.test(c)) return false;
  if (/\bsee\s*section\b|\(see\b/i.test(c)) return false;
  if (/\.\s+[A-Za-z]/.test(c)) return false;                       // a sentence break inside
  if (/\b(?:it|this|these|which|they)\s+(?:may|is|are|can|should|will)\b/i.test(c)) return false;
  return true;
}

/**
 * Words the PDF ran together where italics began or ended: "forInteriorRetail"
 * → "for Interior Retail", "forIndoorSports" → "for Indoor Sports".
 */
export function tidyCaption(caption) {
  return String(caption || '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/\s+/g, ' ').trim();
}

/**
 * Suggestions for the Edit modal (and the pre-fill script), in page order.
 * Never saved by themselves.
 *
 *   1. Every table search returns illuminance rows from (applications.Table_Ref
 *      with its first/last row page). The captions found ON those pages decide:
 *      - the row's own table number is captioned there (or nowhere) → that
 *        table, titled from its caption when the caption is usable, at the
 *        caption's page when it sits just before the first row, else the first
 *        row's page;
 *      - only OTHER table numbers are captioned there → the stored number is
 *        wrong (RP-8-25+E2 stores Tables 17-1/17-2 as "Table A-1"), so those
 *        tables are suggested instead, each flagged `mislabelled`.
 *   2. Tables whose caption reads like an illuminance/criteria table and that
 *      search has no rows from (`source: 'caption'`).
 *
 * `flags`: 'untitled' (no usable caption — staff must type the title),
 * 'mislabelled' (search rows carry another table number).
 *
 * @param {{
 *   appTables: { ref: string, firstPage: number | null, lastPage?: number | null }[],
 *   assets: { kind: string, label: string, caption: string, page: number }[],
 *   labels: string[] | null,
 * }} input
 * @returns {{ title: string, page: number, label: string, source: 'search' | 'caption',
 *             flags: string[], searchRef?: string }[]}
 */
/** The review note a suggestion's flags call for, or null. */
export function reviewNoteFor(suggestion) {
  const flags = suggestion.flags || [];
  const notes = [];
  if (flags.includes('mislabelled')) notes.push(`search rows for this table are labelled "${suggestion.searchRef}" — check the table number`);
  if (flags.includes('untitled')) notes.push('no usable caption was found — type the title as printed');
  if (suggestion.source === 'caption') notes.push('found by its caption only — search has no rows from it');
  return notes.length ? `Pre-filled: ${notes.join('; ')}.` : 'Pre-filled from the index — check title and page against the PDF.';
}

export function suggestIlluminanceTables({ appTables, assets, labels }) {
  const tableAssets = [];
  for (const a of assets || []) {
    if (a && a.kind === 'table' && typeof a.label === 'string' && Number.isInteger(a.page)) {
      const ref = tableRefOf(a.label);
      if (ref) tableAssets.push({ ref, page: a.page, caption: a.caption, usable: usableCaption(a.caption) });
    }
  }
  const labelOf = (page) => pageLabelFor(labels, page) || String(page);
  const titleFor = (ref, asset) => (asset && asset.usable ? `${ref}. ${tidyCaption(asset.caption)}` : ref);
  const out = [];
  const used = new Set();
  const push = ({ ref, ...entry }) => { used.add(ref); out.push(entry); };

  for (const t of appTables || []) {
    const ref = tableRefOf(t.ref);
    const first = Number.isInteger(t.firstPage) ? t.firstPage : null;
    if (!ref || used.has(ref) || first == null) continue;
    const last = Number.isInteger(t.lastPage) && t.lastPage >= first ? t.lastPage : first;
    // Usable captions physically on the rows' pages (or just before them).
    const inSpan = tableAssets.filter(a => a.page >= first - CAPTION_LEAD_PAGES && a.page <= last);
    const own = inSpan.filter(a => a.ref === ref);
    const others = inSpan.filter(a => a.ref !== ref && !used.has(a.ref));
    if (own.length === 0 && others.length > 0) {
      for (const a of others.sort((x, y) => x.page - y.page)) {
        if (used.has(a.ref)) continue;
        // A caption printed just before the span is the first table; any later
        // one starts on its own caption page.
        push({
          ref: a.ref, title: titleFor(a.ref, a), page: a.page, label: labelOf(a.page), source: 'search',
          flags: ['mislabelled', ...(a.usable ? [] : ['untitled'])], searchRef: ref,
        });
      }
      continue;
    }
    const asset = own.find(a => a.usable && a.page <= first) || null;
    const page = asset ? asset.page : first;
    push({ ref, title: titleFor(ref, asset), page, label: labelOf(page), source: 'search', flags: asset ? [] : ['untitled'] });
  }
  for (const a of tableAssets) {
    if (used.has(a.ref) || !a.usable || !ILLUMINANCE_CAPTION_RE.test(a.caption || '')) continue;
    // A caption repeated in a list of tables would claim an early page; keep the last.
    const later = tableAssets.filter(b => b.ref === a.ref && b.usable).sort((x, y) => y.page - x.page)[0];
    push({ ref: a.ref, title: titleFor(a.ref, later), page: later.page, label: labelOf(later.page), source: 'caption', flags: [] });
  }
  return out.sort((a, b) => a.page - b.page);
}
