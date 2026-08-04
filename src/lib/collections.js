/**
 * Saved Search Collections — the shape of one saved item (client feedback DO37).
 *
 * "Provide linked references to search results, but do not reprint the excerpts
 *  in the report… User should be able to 'save' searches, but not their contents.
 *  The only exception is 'References'. User may save the full text of any
 *  reference cards."
 *
 * That rule is the whole design. A saved item carries enough to reprint a
 * CITATION and a deep link — designation, title, page, Library URL — and
 * deliberately not the passage the card displayed. Two carve-outs the client
 * specified:
 *
 *   • Illuminance Tables also save the full APPLICATION NAME
 *     ("INTERIOR – RESIDENTIAL > Reading and Writing > Bed headboard (small area)"),
 *     because without it the citation names a table row the reader cannot identify.
 *   • References also save the ENTRY TEXT in full — the bibliography line IS the
 *     reference, so a saved reference without it would be useless.
 *
 * Document and Definition items save no body text at all.
 *
 * Plain ESM JS so the Worker and the tests share one definition of the rule.
 */

/** The four kinds a collection can hold, matching the search content types. */
export const SAVEABLE_TYPES = ['body', 'tables', 'references', 'definitions'];

/** Human labels, exactly as the client's collection view and CSV spell them. */
export const RESULT_TYPE_LABELS = {
  body: 'Documents & Annexes',
  tables: 'Illuminance Table',
  references: 'References',
  definitions: 'Definitions',
};

/** Search resultType → the collection's result_type. */
const FROM_RESULT_TYPE = {
  excerpt: 'body',
  application: 'tables',
  reference: 'references',
  definition: 'definitions',
};

export function collectionTypeFor(searchResultType) {
  return FROM_RESULT_TYPE[searchResultType] || null;
}

/**
 * A short, stable id for a saved item that has no application code.
 *
 * project_applications.application_code is NOT NULL and carries the
 * per-collection duplicate guard, so every kind needs one. Derived from the
 * item's identity rather than random, so saving the same passage twice is caught
 * as a duplicate instead of silently adding a second row.
 */
export function syntheticItemCode(item) {
  const type = item.result_type;
  if (type === 'definitions' && item.definition_slug) return `definition:${item.definition_slug}`;
  const std = item.standard_id || 'unknown';
  if (type === 'references') return `reference:${std}:${hash32(item.reference_text || item.resource_title || '')}`;
  const page = item.page_number != null ? item.page_number : '?';
  return `excerpt:${std}:p${page}:${hash32(item.resource_title || '')}`;
}

/** 32-bit FNV-1a, hex. Deterministic across Node and Workers. */
function hash32(str) {
  let h = 0x811c9dc5;
  const s = String(str || '');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * One saved item, as project_applications stores it.
 *
 * @typedef {object} SavedItem
 * @property {string} result_type      'body' | 'tables' | 'references' | 'definitions'
 * @property {string|null} standard_id
 * @property {string} resource_title   full designation + title
 * @property {number|null} page_number
 * @property {string|null} library_url
 * @property {string|null} application_name  illuminance-table items only
 * @property {string|null} reference_text    reference items only
 * @property {string|null} custom_notes      the user's rich-text note
 * @property {string} application_code       real code, or a synthetic one
 * @property {string|null} definition_slug
 */

/**
 * Normalize a save request into the columns project_applications stores,
 * enforcing the no-contents rule at the boundary rather than trusting callers.
 *
 * @param {object} raw the client's save payload
 * @returns {{ok: true, item: SavedItem, reason?: undefined} | {ok: false, reason: string, item?: undefined}}
 */
export function normalizeSavedItem(raw) {
  const resultType = String(raw?.result_type || '').trim();
  if (!SAVEABLE_TYPES.includes(resultType)) {
    return { ok: false, reason: `result_type must be one of ${SAVEABLE_TYPES.join(', ')}` };
  }

  const resourceTitle = clean(raw?.resource_title);
  if (!resourceTitle) return { ok: false, reason: 'resource_title is required' };

  const item = {
    result_type: resultType,
    standard_id: clean(raw?.standard_id) || null,
    resource_title: resourceTitle,
    page_number: Number.isFinite(Number(raw?.page_number)) ? Number(raw.page_number) : null,
    library_url: safeUrl(raw?.library_url),
    // Only illuminance-table items keep an application name…
    application_name: resultType === 'tables' ? (clean(raw?.application_name) || null) : null,
    // …and only reference items keep body text. Anything else is dropped HERE,
    // so a future caller cannot start persisting excerpt contents by accident.
    reference_text: resultType === 'references' ? (clean(raw?.reference_text) || null) : null,
    custom_notes: clean(raw?.note) || clean(raw?.custom_notes) || null,
    application_code: clean(raw?.application_code) || null,
    definition_slug: clean(raw?.definition_slug) || null,
  };

  if (!item.application_code) item.application_code = syntheticItemCode(item);
  return { ok: true, item };
}

function clean(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s : null;
}

/** Only http(s) links are stored — never javascript: or data: from a client. */
function safeUrl(v) {
  const s = clean(v);
  if (!s) return null;
  return /^https?:\/\//i.test(s) ? s : null;
}

/**
 * CSV column order, verbatim from the client's spec (DO37 "Sample CSV Output").
 * The collection-level fields repeat on every row: the client left the choice to
 * the programmer, and a row that stands on its own survives being sorted or
 * filtered in Excel, which is what these exports get used for.
 */
export const CSV_COLUMNS = [
  ['date_added', 'Date Added'],
  ['user', 'User'],
  ['type', 'Type'],
  ['search_note', 'Search Note'],
  ['resource', 'Resource'],
  ['page', 'Page'],
  ['library_url', 'Open in Library'],
  ['application', 'Application'],
  ['reference', 'Reference'],
  ['collection_topic', 'Collection Topic'],
  ['collection_note', 'Collection Note'],
  ['client', 'Client'],
  ['location', 'Location'],
  ['designer', 'Designer'],
  ['collection_type', 'Project Type'],
  ['created_at', 'Date Created'],
  ['updated_at', 'Date Updated'],
];

/** One CSV row for a saved item, in CSV_COLUMNS order. */
export function csvRowFor(item, collection) {
  const values = {
    date_added: item.added_at || '',
    user: collection.owner_label || '',
    type: RESULT_TYPE_LABELS[item.result_type] || item.result_type || '',
    search_note: stripHtml(item.custom_notes),
    resource: item.resource_title || '',
    page: item.page_number != null ? String(item.page_number) : '',
    library_url: item.library_url || '',
    application: item.result_type === 'tables' ? (item.application_name || '') : '',
    reference: item.result_type === 'references' ? (item.reference_text || '') : '',
    collection_topic: collection.name || '',
    collection_note: stripHtml(collection.notes),
    client: collection.client_name || '',
    location: collection.location || '',
    designer: collection.designer_name || '',
    collection_type: collection.collection_type || collection.project_type || '',
    created_at: collection.created_at || '',
    updated_at: collection.modified_at || collection.updated_at || '',
  };
  return CSV_COLUMNS.map(([key]) => csvCell(values[key]));
}

/** Notes are rich text; a CSV cell is not. */
export function stripHtml(value) {
  if (!value) return '';
  return String(value)
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/(?:p|li|div)\s*>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Quote one CSV cell.
 *
 * The leading-character guard is deliberate: Excel and Sheets execute a cell
 * beginning with = + - or @ as a formula, so a user note starting with one would
 * become a spreadsheet injection in a file IES emails to clients.
 */
export function csvCell(value) {
  let s = value == null ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

/** A share token: URL-safe, unguessable, and short enough to paste in an email. */
export function newShareToken(randomBytes) {
  const bytes = randomBytes || crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
}
