/**
 * Every standard the AI Guide names, resolved to a real Lighting Library link
 * (client, 2026-10-14: "Some standards/sections are referenced without
 * hyperlink. Are you able to get those hyperlinks more consistent?").
 *
 * The UI already links a designation the RESULT SET contains, by its exact id.
 * Three common forms fell through and printed as plain text:
 *
 *   - an edition named without its errata/reaffirmation suffix ("RP-8-25" for
 *     RP-8-25+E2, "LS-2-20" for LS-2-20(R2023));
 *   - a family named without an edition ("RP-8", "TM-30");
 *   - a standard outside the result set — typically the "Further reading"
 *     recommendation, or one a catalogue fact named.
 *
 * Each is resolved here against the D1 catalogue: never fabricated — a token
 * that names no standard IES Lens holds stays plain text, as before. Pure (the
 * caller supplies the index), so it is unit-testable without D1.
 */

import { SUPPORT_FORM_URL, SUPPORT_SENTENCE } from './product';

export interface CatalogueEntry {
  status: string;
  webUrl: string | null;
  /** "ANSI/IES LS-1-25" — matched too, since LS-1's id carries no edition. */
  fullDesignation?: string | null;
}

/** "RP-8-25", "ANSI/IES LS-2-20(R2023)", "TM-30", "RP-27.1-22" — prefix optional. */
export const GUIDE_DESIGNATION_RE =
  /(?<![\w-])(?:(?:ANSI|BSR|IES)(?:\/[A-Z]+)*\s+)?((?:RP|LP|LS|LEM|LM|TM|DG|HB|WP|G)-\d+(?:\.\d+)?(?:-\d{2,4})?(?:\+E\d+)?(?:\s*\(R\d{2,4}\)|R\d{2,4})?)(?![\w-])/g;

const squash = (s: string) => String(s).toUpperCase().replace(/\s+/g, '');
const stripPrefix = (s: string) => String(s).replace(/^(?:ANSI|BSR|IES)(?:\/[A-Z]+)*\s*/i, '');

/** The edition a printing belongs to: "RP-8-25+E2" → "RP-8-25", "LM-63-19R25" → "LM-63-19". */
export function editionBase(id: string): string {
  return squash(id)
    .replace(/\(R\d{2,4}\)$/, '')
    .replace(/\+E\d+$/, '')
    .replace(/R\d{2,4}$/, '')
    .replace(/\+E\d+$/, '');
}

/**
 * "RP-8-25+E2" → "RP-8"; "RP-27.1-22" → "RP-27.1"; "RP-10" → "RP-10". A family
 * is always PREFIX-NUMBER — "RP-10" is a family, never edition 10 of "RP".
 */
export function familyOfId(id: string): string {
  const base = editionBase(id);
  const m = /^([A-Z]+-\d+(?:\.\d+)?)(?:-\d{2,4})?$/.exec(base);
  return m ? m[1] : base;
}

/** Does the token name an edition ("RP-8-25") rather than a family ("RP-8")? */
function namesEdition(token: string): boolean {
  return /^[A-Z]+-\d+(?:\.\d+)?-\d{2,4}$/.test(editionBase(token));
}

const errataOf = (id: string) => Number((/\+E(\d+)/i.exec(id) || [])[1] || 0);
const yearOf = (id: string) => {
  const m = /-(\d{2,4})$/.exec(editionBase(id));
  if (!m) return -1;
  const n = Number(m[1]);
  return m[1].length === 4 ? n : (n <= 49 ? 2000 + n : 1900 + n);
};

/**
 * The catalogue id a token names, or null. Exact id (or full designation)
 * first, whatever its status — the Guide named that document; then the same
 * edition under another printing (Active preferred, highest errata); then, for
 * a bare family, its current Active edition.
 */
export function resolveDesignation(token: string, index: Map<string, CatalogueEntry>): string | null {
  const t = squash(token);
  for (const id of index.keys()) {
    if (squash(id) === t) return id;
  }
  for (const [id, e] of index) {
    if (e.fullDesignation && squash(stripPrefix(e.fullDesignation)) === t) return id;
  }
  const hasEdition = namesEdition(t);
  const candidates = [...index.entries()].filter(([id]) =>
    hasEdition ? editionBase(id) === editionBase(t) : familyOfId(id) === t);
  const pool = hasEdition ? candidates : candidates.filter(([, e]) => e.status !== 'Deprecated');
  if (pool.length === 0) return null;
  pool.sort(([a, ea], [b, eb]) =>
    (Number(ea.status === 'Deprecated') - Number(eb.status === 'Deprecated'))
    || (yearOf(b) - yearOf(a))
    || (errataOf(b) - errataOf(a)));
  return pool[0][0];
}

/**
 * token-as-written → { id, url } for every designation in `texts` that
 * resolves to a standard with a Library link, in order of first mention.
 */
export function resolveGuideMentions(
  texts: Array<string | null | undefined>,
  index: Map<string, CatalogueEntry>,
): Map<string, { id: string; url: string }> {
  const out = new Map<string, { id: string; url: string }>();
  for (const text of texts) {
    if (!text) continue;
    for (const m of String(text).matchAll(GUIDE_DESIGNATION_RE)) {
      const token = m[1];
      if (out.has(token)) continue;
      const id = resolveDesignation(token, index);
      const url = id ? index.get(id)?.webUrl : null;
      if (id && url) out.set(token, { id, url });
    }
  }
  return out;
}

/** What the Guide says when every paragraph it wrote rested on a designation nothing grounded. */
export const UNGROUNDED_FALLBACK =
  'The standards in these results do not appear to address this question directly. '
  + `Review the result cards below for the closest material. ${SUPPORT_SENTENCE} (${SUPPORT_FORM_URL}).`;

const LIST_ITEM_RE = /^\s*(?:[-*•]|\d+[.)])\s/;

/**
 * Remove what the Guide wrote about standards nothing grounded (Dan, 2026-10-16).
 *
 * As a Non-Subscriber, the Guide opened "According to ANSI/IES RP-33-99,
 * Section 5, p. 12, …". RP-33-99 is a real 1999 IESNA document, but no index
 * IES Lens holds contains it: the model wrote it, and its section and page, from
 * memory. Prompt rules ask the model not to; this is the check that does not
 * depend on the model listening.
 *
 * A designation is grounded when
 *   - the text the model was shown names it (results, excerpts, reference
 *     entries, catalogue facts, the query) — an EDITION only by that edition, so
 *     a bibliography's "RP-33-14" never vouches for "RP-33-99"; or
 *   - it resolves to a CURRENT catalogue standard (a Further-reading pointer
 *     outside the results), or to any catalogued edition on a comparison.
 *
 * A paragraph naming an ungrounded designation is dropped whole — its other
 * sentences ("In simplified terms, this means …") lean on the fabricated
 * citation — and inside a list only the offending item goes. If nothing that
 * names a standard survives, the answer is replaced by UNGROUNDED_FALLBACK.
 */
export function dropUngroundedDesignations(
  text: string,
  index: Map<string, CatalogueEntry>,
  sources: Array<string | null | undefined>,
  opts: { allowDeprecated?: boolean } = {},
): { text: string; removed: string[] } {
  const editions = new Set<string>();
  const families = new Set<string>();
  for (const s of sources) {
    if (!s) continue;
    for (const m of String(s).matchAll(GUIDE_DESIGNATION_RE)) {
      editions.add(editionBase(m[1]));
      families.add(familyOfId(m[1]));
    }
  }
  const grounded = (token: string): boolean => {
    const base = editionBase(token);
    if (namesEdition(token) ? editions.has(base) : families.has(base)) return true;
    const id = resolveDesignation(token, index);
    return !!id && (!!opts.allowDeprecated || index.get(id)?.status !== 'Deprecated');
  };

  const removed: string[] = [];
  const offends = (s: string): boolean => {
    let bad = false;
    for (const m of s.matchAll(GUIDE_DESIGNATION_RE)) {
      if (grounded(m[1])) continue;
      bad = true;
      if (!removed.includes(m[1])) removed.push(m[1]);
    }
    return bad;
  };

  const kept: string[] = [];
  for (const block of String(text || '').split(/\n\s*\n/)) {
    const lines = block.split('\n');
    if (lines.some(l => LIST_ITEM_RE.test(l))) {
      const survivors = lines.filter(l => !offends(l));
      if (survivors.some(l => l.trim())) kept.push(survivors.join('\n'));
    } else if (!offends(block)) {
      kept.push(block);
    }
  }
  if (removed.length === 0) return { text, removed };

  const rest = kept.join('\n\n').trim();
  const namesAStandard = !rest.matchAll(GUIDE_DESIGNATION_RE).next().done;
  return { text: namesAStandard ? rest : UNGROUNDED_FALLBACK, removed };
}
