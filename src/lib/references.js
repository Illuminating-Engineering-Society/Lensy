/**
 * Formal-reference recognition (client feedback DO26.1).
 *
 * A "References" search must return ONLY entries that are actually listed as a
 * formal reference in the REFERENCES / Bibliography chapter of a standard. The
 * section-heading detector in chunker.js is necessarily loose — any line that
 * reads "References" opens a reference run, so a form/checklist page ("Please
 * verify that all attachments and references are relevant…") could stream
 * whole paragraphs of body prose into the reference index.
 *
 * This module is the content-level gate applied on BOTH sides:
 *   - ingest  (chunker.js)  — prose never becomes a 'reference' chunk
 *   - search  (search.ts)   — already-indexed prose never becomes a result
 *
 * Plain ESM JS (no TypeScript) because the Node ingestion scripts import it
 * directly without a build step, and the Worker bundle imports the same file.
 */

// Lines addressed to a reader are instructions, never bibliography entries.
const PROSE_OPENER_RE =
  /^(?:please|note[:\s]|notes[:\s]|see\s|refer\s+to\b|this\s|these\s|the\s+following|all\s+|for\s+more\s+information|copyright|table\s|figure\s|annex\s+[a-z]\b)/i;

// Author / organization openers used by IES bibliographies:
//   "Smith, J." · "Rea MS," (medical style) · "NFPA." · "Illuminating Engineering…"
const AUTHOR_START_RE =
  /^(?:\[?\d{1,3}\]?[.)]\s*)?(?:[A-Z][A-Za-z'’-]+,\s|[A-Z][a-z'’-]+\s+[A-Z]{1,3}[.,\s]|[A-Z]{2,}[.,\s]|(?:ANSI|BSR|IES|CIE|ISO|IEC|ASHRAE|IEEE|NFPA|ASTM|NEMA|UL|DOE|EPA|WELL|Illuminating)\b)/;

const NUMBERED_START_RE = /^\[?\d{1,3}\]?[.)]\s+\S/;

// Standards-body designation with a document number ("ANSI/IES RP-8-25",
// "CIE 191:2010", "10 CFR Part 430").
const DESIGNATION_RE =
  /\b(?:ANSI|BSR|IES|CIE|ISO|IEC|ASHRAE|IEEE|NFPA|ASTM|NEMA|EN|CFR|UL)\b[^,;.]{0,24}?\d/;

// Publication apparatus: journal/volume/page/publisher/edition markers.
const PUBLISHER_RE =
  /\b(?:press|publish(?:er|ers|ing)|journal|proceedings|vol\.?|no\.?\s*\d|pp?\.\s*\d|\d+\s*(?:st|nd|rd|th)\s+ed(?:ition)?\b|ed\.|eds\.|doi|available\s+at|retrieved|new york|washington|geneva|vienna|london|boca raton|hoboken)\b/i;

const YEAR_RE = /\b(?:19|20)\d{2}\b/;
const DOI_RE = /\b10\.\d{4,9}\/[^\s"<>]+/;
const URL_RE = /\bhttps?:\/\/[^\s"<>)]+/i;

/**
 * Does this text read like a formal bibliography entry?
 *
 * Accepts when the text carries a locator (DOI or URL), or a publication year
 * paired with any bibliographic signal (numbered/author opener, standards
 * designation, publisher apparatus), or a standards designation paired with a
 * numbered/author opener. Rejects reader-addressed prose outright.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function looksLikeFormalReference(text) {
  if (!text) return false;
  const t = String(text).trim();
  if (t.split(/\s+/).filter(Boolean).length < 4) return false;
  if (PROSE_OPENER_RE.test(t)) return false;

  // A bibliography entry is a citation, not a paragraph. Real entries run to
  // ~60 words; anything far longer is body prose that leaked into the run.
  if (t.split(/\s+/).length > 120) return false;

  const hasDoi = DOI_RE.test(t);
  const hasUrl = URL_RE.test(t);
  if (hasDoi || hasUrl) return true;

  // An explicit reference number IS the bibliography's own numbering — inside a
  // REFERENCES chapter that is the strongest signal there is.
  if (NUMBERED_START_RE.test(t)) return true;

  const hasYear = YEAR_RE.test(t);
  const hasDesignation = DESIGNATION_RE.test(t);
  const startsWithAuthor = AUTHOR_START_RE.test(t);
  const hasPublisher = PUBLISHER_RE.test(t);

  if (hasYear && (startsWithAuthor || hasDesignation || hasPublisher)) return true;
  if (hasDesignation && startsWithAuthor) return true;
  // Author + publication apparatus, with at least one number somewhere (volume,
  // pages, edition) — an unnumbered, undated entry still reads as a citation.
  if (startsWithAuthor && hasPublisher && /\d/.test(t)) return true;
  return false;
}

/**
 * Normalized identity of the WORK a reference entry cites, so the same work
 * can be recognized across the References sections of different standards
 * (DO26.4 — "which IES Standards reference this item").
 *
 * Priority: DOI → standards designation → author/title signature.
 *
 * @param {string} text
 * @returns {string|null}
 */
export function referenceCitationKey(text) {
  if (!text) return null;
  const t = String(text);

  const doi = DOI_RE.exec(t);
  if (doi) return `doi:${doi[0].replace(/[).,;:\]]+$/, '').toLowerCase()}`;

  // "ANSI/IES LS-7-20", "IES TM-30-18", "CIE 191:2010"
  const std = /\b(?:ANSI\/|BSR\/)?(?:IES|CIE|ISO|IEC|ASHRAE|IEEE|NFPA|ASTM)(?:\/NALMCO)?\s+((?:RP|TM|LM|LP|LS|DG|HB|G|LEM)-\d+(?:\.\d+)?(?:-\d{2})?|\d{2,4}(?::\d{4})?)/i.exec(t);
  if (std) return `std:${std[1].toUpperCase()}`;

  // Fall back to a signature: leading significant words + year. Strip the
  // numbered prefix so "6. Rea…" and "12. Rea…" collapse to the same work.
  const stripped = t.replace(NUMBERED_START_RE, m => m.replace(/^\[?\d{1,3}\]?[.)]\s+/, ''));
  const words = stripped
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2)
    .slice(0, 7);
  if (words.length < 3) return null;
  const year = YEAR_RE.exec(t);
  return `sig:${words.join('-')}${year ? `:${year[0]}` : ''}`;
}
