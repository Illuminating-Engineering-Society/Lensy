/**
 * "Cite as" — the bibliographic line under every bookmark (Dan, Teams 11/13/26 #2).
 *
 * "For every instance of a bookmark listing (Cards in collections, share-via-
 *  link, body of email-share, printed pdf, etc) can you add a small-font …
 *  'Cite as' element below each item formatted as:
 *
 *    Cite as: Illuminating Engineering Society. RP-##-yy* Recommended Practice:
 *    ______, Table A-1, p. 38. New York: IES; YYYY,
 *    https://lighting.ies.org/BJXuxu#page=42.
 *
 *  …where 'p. 38' is the printed page number and the URL links to Vitrium page
 *  number; if reference is to an entire standard then remove the table/page
 *  portion."
 *
 * Built in ONE place and attached to each saved item on read (`withCiteAs` in
 * workers/api.ts), so the collection page, the shared view, the email, the CSV
 * and the print-out cannot disagree. Everything about the standard is read
 * LIVE from the catalogue (designation, title, year), never from the words the
 * bookmark was saved with; only the locator (table / section, page, link) is
 * the item's own.
 *
 * The designation is printed in full ("ANSI/IES RP-43-25"), as every other
 * surface prints it (client DO45) — and because the catalogue id is not always
 * printable ("ASHRAE-IES-90.1-2025", "LS-1").
 */

import { composeStandardName } from './citations';
import { toLibraryUrlOrNull } from './library-url.js';

/** The catalogue facts a citation needs (a `standards` row). */
export interface CiteStandard {
  id: string;
  full_designation?: string | null;
  title?: string | null;
  published_date?: string | null;
  vitrium_web_url?: string | null;
}

/** The saved item's own part of the citation. */
export interface CiteItem {
  result_type?: string | null;
  resource_title?: string | null;
  page_number?: number | null;
  page_label?: string | null;
  library_url?: string | null;
  application_name?: string | null;
  /** Owner view only: the row saved with a legacy illuminance bookmark. */
  snapshot_data?: string | null;
}

export interface CiteAs {
  /** Everything before the link: "Illuminating Engineering Society. … New York: IES; 2025". */
  text: string;
  /** The page link (PDF page index, as the Library viewer needs it), or null. */
  url: string | null;
  /** The whole citation as one line of plain text — the email's text part, the CSV cell. */
  line: string;
}

interface Publisher { author: string; imprint: string }

const IES: Publisher = { author: 'Illuminating Engineering Society', imprint: 'New York: IES' };
/**
 * A joint standard is published by its lead sponsor, not by IES: ASHRAE/IES
 * 90.1 is an ASHRAE publication, and "New York: IES" on it would be wrong.
 */
const JOINT_PUBLISHERS: Array<[RegExp, Publisher]> = [
  [/^ASHRAE\b/i, { author: 'ASHRAE', imprint: 'Peachtree Corners, GA: ASHRAE' }],
];

function publisherFor(standard: CiteStandard): Publisher {
  for (const [re, publisher] of JOINT_PUBLISHERS) {
    if (re.test(standard.id)) return publisher;
  }
  return IES;
}

/**
 * The year a designation carries: "RP-43-25" → 2025, "LM-63-19(R25)" → 2019,
 * "RP-27.3-07" → 2007, "ASHRAE-IES-90.1-2025" → 2025. Null when it has none
 * ("LS-1").
 */
export function designationYear(designation: string | null | undefined): number | null {
  const base = String(designation || '')
    .replace(/\s*\(R\s*\d{2,4}\)\s*$/i, '')
    .replace(/\+E\d+\s*$/i, '')
    .replace(/\s*\(R\s*\d{2,4}\)\s*$/i, '')
    .trim();
  const m = /-(\d{4}|\d{2})$/.exec(base);
  if (!m) return null;
  const n = Number(m[1]);
  if (m[1].length === 4) return n;
  // Two digits: IES designations run from the 1950s; "99" is 1999, "07" is 2007.
  return n >= 50 ? 1900 + n : 2000 + n;
}

/**
 * The year printed after the imprint. The DESIGNATION's year comes first: it
 * is the edition a reader cites ("RP-##-yy … IES; YYYY" in the client's own
 * pattern), and it is how IES standards cite each other. The catalogue's
 * publication date is the day the file was released in the Library — measured
 * on production it reads 2025 for RP-6-24 and RP-1-24 and 2026 for RP-29-25 —
 * so it is only the fallback for a designation that carries no year.
 */
function citationYear(standard: CiteStandard): number | null {
  const edition = designationYear(standard.full_designation) ?? designationYear(standard.id);
  if (edition) return edition;
  const published = /^(\d{4})-\d{2}-\d{2}/.exec(String(standard.published_date || ''));
  return published ? Number(published[1]) : null;
}

/**
 * The catalogue row a saved item's standard id resolves to. Definition
 * bookmarks are filed under the glossary's edition ("LS-1-25") while the
 * catalogue holds the definitions source as "LS-1" (it has no PDF of its own).
 */
export function catalogueIdFor(standardId: string | null | undefined): string | null {
  const id = String(standardId || '').trim();
  if (!id) return null;
  return /^LS-1-\d{2}$/i.test(id) ? 'LS-1' : id;
}

/**
 * A title worth printing. Some catalogue rows still hold the id, or a PDF's
 * file-name metadata ("RP_2705Cover"), where the cover could not be read; the
 * designation alone is the honest citation then.
 */
function printableTitle(standard: CiteStandard): string {
  const title = String(standard.title || '').trim();
  if (!title || title === standard.id) return '';
  if (!/\s/.test(title)) return '';
  return title;
}

/** "Table A-1", "Table 17-2", "Table B.3" — a label needs a digit ("Table of …" is not one). */
const TABLE_LABEL = String.raw`Table\s+[A-Za-z0-9]+(?:[-–.][A-Za-z0-9]+)*`;

function tableLabel(text: string, anchored: 'start' | 'after-comma'): string | null {
  const re = anchored === 'start'
    ? new RegExp(`^\\s*(${TABLE_LABEL})`, 'i')
    : new RegExp(`,\\s*(${TABLE_LABEL})`, 'i');
  const m = re.exec(text);
  if (!m || !/\d/.test(m[1])) return null;
  return m[1].replace(/\s+/g, ' ').replace(/^table/i, 'Table').replace(/–/g, '-');
}

/** ", Section 8.6.1.4 Outdoor Dining" → "Section 8.6.1.4"; ", Section Annex A …" → "Annex A". */
function sectionLabel(text: string): string | null {
  const m = /,\s*Section\s+(Annex\s+[A-Z]\b|[A-Z]?\d+(?:\.\d+)*|[A-Z](?:\.\d+)+)/.exec(text);
  if (!m) return null;
  const label = m[1].replace(/\s+/g, ' ');
  return /^Annex/i.test(label) ? label : `Section ${label}`;
}

function snapshotTableRef(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const ref = JSON.parse(raw)?.Table_Ref;
    return typeof ref === 'string' && ref.trim() ? ref.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Where in the standard the bookmark points: "Table A-1, p. 38",
 * "Section 8.6.1.4, p. 42", "p. 79" — or '' for a whole standard.
 *
 * The table or section is read from the words the bookmark was saved with (a
 * search card's citation, a table-of-contents entry, a listed table's title);
 * the page is the PRINTED page when the Worker resolved one.
 */
export function citeLocator(item: CiteItem): string {
  const type = item.result_type || 'tables';
  const title = String(item.resource_title || '');
  let where: string | null = null;
  if (type === 'tables') {
    where = tableLabel(title, 'after-comma')
      || tableLabel(String(item.application_name || ''), 'start')
      || snapshotTableRef(item.snapshot_data);
  } else if (type === 'body') {
    where = sectionLabel(title);
  }
  const page = item.page_number != null ? `p. ${item.page_label || item.page_number}` : null;
  return [where, page].filter(Boolean).join(', ');
}

/**
 * The citation of one saved item, or null when its standard is not in the
 * catalogue (nothing true could be printed about it).
 */
export function buildCiteAs(standard: CiteStandard | null | undefined, item: CiteItem): CiteAs | null {
  if (!standard || !standard.id) return null;
  const designation = String(standard.full_designation || '').trim() || standard.id;
  const name = composeStandardName(designation, printableTitle(standard)).replace(/[.\s]+$/, '');
  if (!name) return null;

  const { author, imprint } = publisherFor(standard);
  const locator = citeLocator(item);
  const year = citationYear(standard);

  const text = `${author}. ${name}${locator ? `, ${locator}` : ''}. ${imprint}${year ? `; ${year}` : ''}`;
  const own = typeof item.library_url === 'string' && /^https?:\/\//i.test(item.library_url) ? item.library_url : null;
  const url = own || toLibraryUrlOrNull(standard.vitrium_web_url) || null;
  return { text, url, line: url ? `${text}, ${url}.` : `${text}.` };
}
