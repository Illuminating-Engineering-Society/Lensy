/**
 * Cover-page designation, title and authoring committee (client DO48 / DO29).
 *
 * "There is a data mismatch for document title in some instances … The correct
 *  title for ANSI/IES RP-1-24 is: Recommended Practice: Lighting Office Spaces"
 *
 * Every IES standard prints its own identity on page 1:
 *
 *     ANSI/IES RP-1-24
 *     RECOMMENDED PRACTICE:
 *     LIGHTING OFFICE SPACES
 *     AN AMERICAN NATIONAL STANDARD
 *     www.ies.org
 *
 * That is the authority, and it was being ignored. The PDF's `/Title` file
 * metadata is EMPTY across the whole corpus, so `standards.title` was written as
 * the bare id, which sent citations to the curated fallback in
 * src/config/standards-schema.json — a hand-written list whose RP-1-24 entry said
 * "Lighting Design for Commercial Interiors". A wrong title is worse than none:
 * it mislabels the document a reader is about to cite or buy.
 *
 * Reading the cover fixes the whole corpus in one ingest, and it also supplies:
 *   - the exact full designation cards must print, reaffirmation marker and all
 *     ("ANSI/IES LS-2-20(R2023)"), which no id-based rule can reconstruct (DO45);
 *   - the authoring technical committee, printed a page later as "Prepared by
 *     the IES … Committee", which is what the committee credit needs (DO29) and
 *     which the Vitrium export has not supplied yet.
 *
 * Plain ESM JS (no TypeScript) so the Node ingest script and the Worker share it.
 */

/**
 * The designation line: "ANSI/IES RP-1-24", "IES LM-63-19R25",
 * "ANSI/IES LS-2-20(R2023)", "ANSI/IES/NALMCO RP-36-24", "ANSI/IES RP-8-25+E2".
 * Anchored to the whole line — a designation mentioned mid-sentence is not a
 * cover line.
 */
const DESIGNATION_LINE_RE =
  /^((?:ANSI\/|BSR\/)?IES(?:\/[A-Z]{2,8})?\s+[A-Z]{1,4}-\d+(?:\.\d+)?-\d{2}[A-Z]?\d*(?:\s*\(\s*R\s*\d{2,4}\s*\))?(?:\s*\+\s*E\d+)?)\s*$/i;

/**
 * Lines that end the title block — everything below them is packaging.
 *
 * "approved" is the approval stamp ("APPROVED BY THE ANSI BOARD…"), but it also
 * opens the title of every standard in the LM series: "APPROVED METHOD:
 * ELECTRICAL AND PHOTOMETRIC MEASUREMENT OF FLUORESCENT LAMPS". Without the
 * lookahead the stop fires on the title's own first line, the title block comes
 * back empty, and 40-odd Lighting Measurements standards fall back to showing
 * their bare id as their name.
 */
const TITLE_STOP_RE =
  /^(?:an\s+american\s+national\s+standard|approved(?!\s+method)|published|publication|prepared\s+by|copyright|©|www\.|https?:|ies\.org|illuminating\s+engineering\s+society|table\s+of\s+contents|preface|foreword|\d)/i;

/** An errata banner printed between the designation and the title. */
const ERRATA_LINE_RE = /^\+?\s*errata\s*\d*\s*$/i;

/** A table-of-contents line that slipped onto a draft cover. */
const LEADER_RE = /(?:\.\s*){4,}/;

/**
 * How many lines below the designation can still be part of the title. Covers
 * wrap long titles hard — RP-46-25 uses four lines, TM-24-20 six.
 */
const MAX_TITLE_LINES = 6;

/** Words that stay lowercase inside a title (never first, never after a colon). */
const MINOR_WORDS = new Set([
  'a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'from', 'in', 'into', 'nor',
  'of', 'on', 'or', 'per', 'the', 'to', 'via', 'with', 'within',
]);

/**
 * Tokens that must survive title-casing as written. Anything containing a digit
 * (TM-30, LS-1) or a slash (S/P) is kept automatically, so this list is only for
 * pure letter acronyms.
 */
const ACRONYMS = new Set([
  'IES', 'ANSI', 'BSR', 'NALMCO', 'AVIXA', 'ALA', 'CIE', 'ISO', 'IEC', 'IEEE', 'NFPA', 'ASTM',
  'NEMA', 'ASHRAE', 'LED', 'LEDS', 'OLED', 'UV', 'IR', 'RGB', 'CCT', 'CRI', 'SPD', 'BUG', 'UVGI',
  'DALI', 'HVAC', 'BIM', 'AC', 'DC', 'ADA', 'OSHA', 'PDF', 'USA', 'US', 'UL', 'HID', 'SSL',
  'TM', 'RP', 'LP', 'LS', 'DG', 'HB',
]);

/** Acronyms whose published form is not simply upper case. */
const MIXED_CASE_ACRONYMS = new Map([['IOT', 'IoT']]);

/**
 * Read the designation and title off a parsed PDF's cover.
 *
 * @param {Array<{number, text, lines?}>} pages from parsePDFNode()
 * @returns {{ designation: string|null, title: string|null }}
 */
export function extractCoverMetadata(pages) {
  // Page 1 is the cover; page 2 covers the occasional blank or errata leaf in
  // front of it. Nothing deeper — by page 3 a designation line is a citation.
  for (const page of (pages || []).slice(0, 2)) {
    const found = readCover(linesOf(page));
    if (found.designation || found.title) return found;
  }
  return { designation: null, title: null };
}

function linesOf(page) {
  const raw = rawLinesOf(page);
  const hyphen = inferHyphenGlyph(raw);
  return raw.map(t => sanitizeGlyphs(t, hyphen)).filter(Boolean);
}

function rawLinesOf(page) {
  return page?.lines
    ? page.lines.map(l => l.text)
    : String(page?.text || '').split('\n');
}

/**
 * The designation line, read while its punctuation is still glyph codes, purely
 * to capture the two separators inside it.
 *
 * A designation is "LM-9-20": whatever sits between the series, the number and
 * the year IS a hyphen. That makes the cover teach us its own font, which is the
 * only reliable way to read one — see inferHyphenGlyph.
 */
const DESIGNATION_SEPARATORS_RE = new RegExp(
  '^(?:ANSI/|BSR/)?IES(?:/[A-Z]{2,8})?\\s+[A-Z]{1,4}' +
  '([\\u0001-\\u001F-])\\d+(?:\\.\\d+)?([\\u0001-\\u001F-])\\d{2}',
  'i',
);

/**
 * Which control code THIS cover's font uses for a hyphen, or null.
 *
 * The substituted glyphs land on C0 control code points by font subset, so the
 * mapping is per document and the codes collide across the corpus:
 *
 *     RP-44-21   U+001F = "("   U+001E = ")"
 *     LM-47-20   U+001F = "-"   U+001E = "("   U+001D = ")"
 *
 * A fixed rule cannot serve both. Reading RP-44-21's rule onto an LM cover turns
 * "LM-47-20(R2023)" into "LM-47(20)R2023-" and "DISCHARGE (HID) LAMPS" into
 * "DISCHARGE -HID- LAMPS". So instead of assuming, we learn: the designation
 * line's own separators are hyphens by definition, and once the hyphen code is
 * known, every OTHER control code on the cover is free to be a bracket.
 *
 * Returns null for a cover whose designation prints real punctuation (most of
 * the corpus), which leaves the original U+001F…U+001E bracket rule in charge.
 */
function inferHyphenGlyph(rawLines) {
  for (const line of rawLines) {
    const m = DESIGNATION_SEPARATORS_RE.exec(String(line || ''));
    if (!m) continue;
    const sep = [m[1], m[2]].find(s => s && s.charCodeAt(0) < 0x20);
    if (sep) return sep;
  }
  return null;
}

/**
 * Repair the glyph substitutions IES cover fonts produce.
 *
 * The covers are set in a subsetted font whose punctuation lands on C0 control
 * code points: "ANSI/IES LP-2-20" extracts with each hyphen replaced by a
 * control character, so no designation pattern matches it — that alone
 * accounted for most of the standards whose cover could not be read.
 *
 * Two different glyphs share U+001F, so the ORDER matters here: a
 * U+001F…U+001E pair is a bracket ("IRRADIATION (UVGI)"), and every control left
 * over is a hyphen or a dash ("LP-12-21", "VISION – EYE AND BRAIN").
 */
// The two substituted glyphs, named rather than typed: a literal control
// character in a regex is invisible in an editor and trivially lost in a copy.
const GLYPH_OPEN_BRACKET = String.fromCharCode(0x1F);
const GLYPH_CLOSE_BRACKET = String.fromCharCode(0x1E);
const BRACKET_GLYPH_RE = new RegExp(
  GLYPH_OPEN_BRACKET + '([^' + GLYPH_OPEN_BRACKET + GLYPH_CLOSE_BRACKET + ']{1,60})' + GLYPH_CLOSE_BRACKET,
  'g',
);
// Everything left over — every other C0 control, the soft hyphen, and the
// Unicode dash block — is a hyphen or a dash.
const DASH_GLYPH_RE = new RegExp(
  '[' + String.fromCharCode(0x01) + '-' + String.fromCharCode(0x1F) +
  String.fromCharCode(0xAD) + String.fromCharCode(0x2010) + '-' + String.fromCharCode(0x2015) + ']',
  'g',
);

// Any control-delimited run, for the covers that told us their hyphen code: a
// pair whose delimiters are BOTH something other than that hyphen is a bracket.
// Built from character codes for the same reason as the pair above.
const CTRL_RANGE = String.fromCharCode(0x01) + '-' + String.fromCharCode(0x1F);
const ANY_BRACKET_GLYPH_RE = new RegExp(
  '([' + CTRL_RANGE + '])([^' + CTRL_RANGE + ']{1,60})([' + CTRL_RANGE + '])',
  'g',
);

/**
 * @param {string} text
 * @param {string|null} [hyphenGlyph] the control code this cover uses for a
 *   hyphen, from inferHyphenGlyph(). Omit for the corpus-wide default rule.
 */
export function sanitizeGlyphs(text, hyphenGlyph = null) {
  let out = String(text || '');

  if (hyphenGlyph) {
    out = out.replace(ANY_BRACKET_GLYPH_RE, (whole, open, inner, close) =>
      (open === hyphenGlyph || close === hyphenGlyph) ? whole : `(${inner})`);
    out = out.split(hyphenGlyph).join('-');
  } else {
    out = out.replace(BRACKET_GLYPH_RE, '($1)');
  }

  return out
    .replace(DASH_GLYPH_RE, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

function readCover(lines) {
  const idx = lines.findIndex(l => DESIGNATION_LINE_RE.test(l));
  if (idx === -1) return { designation: null, title: null };

  const designation = normalizeDesignation(DESIGNATION_LINE_RE.exec(lines[idx])[1]);

  const titleLines = [];
  for (const line of lines.slice(idx + 1, idx + 1 + MAX_TITLE_LINES + 3)) {
    // "+ Errata 1" sits between the designation and the title on a corrected
    // printing — skipped rather than treated as the end of the title.
    if (ERRATA_LINE_RE.test(line)) continue;
    if (TITLE_STOP_RE.test(line) || LEADER_RE.test(line)) break;
    // A second designation line (an errata cover reprints it) is not a title.
    if (DESIGNATION_LINE_RE.test(line)) break;
    titleLines.push(line);
    if (titleLines.length >= MAX_TITLE_LINES) break;
  }

  const joined = titleLines.join(' ').replace(/\s+/g, ' ').trim();
  return { designation, title: joined ? toTitleCase(joined) : null };
}

/**
 * The authoring technical committee, as the standard itself prints it
 * ("Prepared by the / IES Light and Human Health Committee") — client DO29.
 *
 * Vitrium's Author metadata is the intended source, but it has not been supplied
 * yet, and the document names its own committee on the page after the cover. A
 * value read here only ever SEEDS `standards.author`: the ingest upsert keeps an
 * existing (curated) value, so a later Vitrium sync still wins.
 *
 * @param {Array<{number, text, lines?}>} pages
 * @returns {string|null} e.g. "IES Light and Human Health Committee"
 */
export function extractCoverCommittee(pages) {
  // At least one word before "Committee": "Prepared by the … Subcommittee" on
  // its own names nothing, and crediting "The Subcommittee" would be worse than
  // crediting no one.
  const COMMITTEE_RE =
    /\b((?:IES\s+)?[A-Z][A-Za-z&/,'’-]*(?:\s+[A-Za-z&/,'’-]+){1,7}\s+(?:Committee|Subcommittee|Working\s+Group|Task\s+Group))\b/;

  for (const page of (pages || []).slice(0, 6)) {
    const lines = linesOf(page);
    for (let i = 0; i < lines.length; i++) {
      if (!/^prepared\s+by(?:\s+the)?\b/i.test(lines[i])) continue;
      // The committee sits on the same line or the next one or two.
      const window = [
        lines[i].replace(/^prepared\s+by(?:\s+the)?\b\s*/i, ''),
        lines[i + 1],
        lines[i + 2],
      ].filter(Boolean).join(' ');
      const m = COMMITTEE_RE.exec(window);
      if (m) return m[1].replace(/^the\s+/i, '').replace(/\s+/g, ' ').trim();
    }
  }
  return null;
}

/** "ANSI/IES LS-2-20 ( R2023 )" → "ANSI/IES LS-2-20(R2023)". */
function normalizeDesignation(raw) {
  return String(raw)
    .toUpperCase()
    .replace(/\s*\(\s*R\s*(\d{2,4})\s*\)/, '(R$1)')
    .replace(/\s*\+\s*(E\d+)/, '+$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * "RECOMMENDED PRACTICE: LIGHTING OFFICE SPACES"
 *   → "Recommended Practice: Lighting Office Spaces"
 *
 * Covers are set in all caps, so the case has to be rebuilt. Text that is
 * already mixed case is left exactly as printed — it was not shouting, so it
 * needs no repair.
 */
export function toTitleCase(text) {
  const s = String(text || '').trim();
  if (!s) return '';
  const letters = s.replace(/[^A-Za-z]/g, '');
  if (letters && letters !== letters.toUpperCase()) return s;

  const words = s.split(' ');
  let startOfPhrase = true;
  const out = words.map((word, i) => {
    const cased = caseWord(word, startOfPhrase || i === words.length - 1);
    // A colon or a dash opens a new phrase, whose first word capitalizes.
    startOfPhrase = /[:—–-]$/.test(word);
    return cased;
  });
  return out.join(' ');
}

function caseWord(word, forceCapital) {
  // Keep anything carrying a digit or a slash exactly as printed: designations
  // ("TM-30-24"), ratios ("S/P") and versions are not English words.
  if (/\d/.test(word) || word.includes('/')) return word;

  // A bracketed all-caps token on a cover is an acronym, published or not:
  // "(UVGI)", "(CCT)". Never lower-cased into "(Uvgi)".
  const bracketed = /^\(([A-Z]{2,6})\)([^A-Za-z]*)$/.exec(word);
  if (bracketed) return `(${bracketed[1]})${bracketed[2]}`;

  // Case each RUN of letters inside the token, so punctuation that the cover
  // left unspaced ("PROPERTIES,SELECTION") still comes out right.
  let first = true;
  return word.replace(/[A-Za-z][A-Za-z'’-]*/g, (run) => {
    const cased = caseRun(run, forceCapital && first);
    first = false;
    return cased;
  });
}

function caseRun(run, forceCapital) {
  const upper = run.toUpperCase();
  if (MIXED_CASE_ACRONYMS.has(upper)) return MIXED_CASE_ACRONYMS.get(upper);
  if (ACRONYMS.has(upper)) return upper;

  const lower = run.toLowerCase();
  if (!forceCapital && MINOR_WORDS.has(lower)) return lower;

  // Hyphenated compounds capitalize each part ("LIGHT-EMITTING" → "Light-Emitting").
  return lower.split('-').map(part =>
    part ? part.charAt(0).toUpperCase() + part.slice(1) : part
  ).join('-');
}
