/**
 * Section numbers and titles: what may be trusted, and what must be suppressed
 * (client DO071 / DO073, and the feedback note "Title names, section names, and
 * hierarchy is not always accurate").
 *
 * Two reported failures, both reproduced against the shipped PDFs:
 *
 *  1. LP-1-24 p. 77 prints "13.4 Light Distribution on Task Plane
 *     (Uniformity)". Its subsetted font drops the period, so the parser reads
 *     "13 4 Light Distribution on Task Plane" — and where the space is dropped
 *     too, "131 Patterns of Light…". A card headed "131" names a section the
 *     document does not have.
 *
 *  2. LP-9-25 p. 68 is a two-column annex whose two headings share a baseline.
 *     The line arrives as "A.1.1.3 Regular Area With Single Row of Individual
 *     A.1.1.6 Regular Area With Uniform Indirect Lighting.The", i.e. two
 *     headings plus the first words of the body, under one number.
 *
 * So this module does three things, and the third is the important one:
 *   • normalize a number whose separators the font ate ("13 4" → "13.4")
 *   • cut a title at the point where it stops being a title (a second heading
 *     number, a run-in sentence, a column-merged bullet)
 *   • REFUSE anything it cannot vouch for. A missing locator is a small loss; a
 *     confidently wrong one ("§131") is the bug the client reported. Same
 *     principle the client set for formulae in DO072.
 *
 * Used on both sides of the pipeline, which is why it is plain ESM:
 *   - ingest (src/lib/chunker.js) so a re-ingest stores clean numbers + titles
 *   - query time (src/workers/search.ts attachSectionTitles) so the corpus
 *     already indexed stops printing the bad ones without waiting for one
 */

/** Deepest section depth we will believe: "21.2.1.2" is real, six is not. */
const MAX_DEPTH = 6;
/** Highest top-level number we will believe. The longest standard in the corpus
 *  (LP-1-24) runs to 23 chapters; "800 K dull red", "2025 Dec 4)" and a
 *  reference numbered 43 are colour temperatures, dates and bibliography lines
 *  that happen to lead a line with a capital. */
const MAX_TOP_LEVEL = 40;
const MAX_TITLE_LENGTH = 120;
/** A section title is a NAME. Beyond this it is a sentence that merged into the
 *  heading, or a whole reference entry. */
const MAX_TITLE_WORDS = 14;

/** "Annex A" / "Appendix B" — carried through as-is. */
const ANNEX_KEY_RE = /^(?:annex|appendix)\s+[A-Z]$/i;

/**
 * Is this section number one the document could actually have printed?
 *
 * Rejects the artefacts of a lost separator ("131", "1810", "21211") without
 * rejecting the real numbering ("13.4", "A.1.1.3", "Annex A").
 */
export function isPlausibleSectionNumber(number) {
  const raw = String(number || '').trim();
  if (!raw) return false;
  if (ANNEX_KEY_RE.test(raw)) return true;

  const parts = raw.split('.');
  if (parts.length > MAX_DEPTH) return false;

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!part) return false;
    // A leading letter is an annex-style number: "A", "B.2", "A.1.1.3".
    if (i === 0 && /^[A-Z]$/.test(part)) continue;
    if (!/^\d{1,2}$/.test(part)) return false;
    if (i === 0 && (Number(part) > MAX_TOP_LEVEL || Number(part) < 1)) return false;
  }
  // A bare single letter is an annex reference, which the chunker spells
  // "Annex A"; on its own it is more likely a stray capital.
  if (parts.length === 1 && /^[A-Z]$/.test(parts[0])) return false;
  return true;
}

/**
 * Normalize a heading number whose separators the PDF font dropped.
 *
 * "13 4" → "13.4", "2 0" → "2.0", "A 1 1 3" → "A.1.1.3". A number that already
 * carries its periods is returned unchanged; anything implausible yields null.
 *
 * `chapter` disambiguates the one case the line cannot: with the separators
 * gone, "11 4" is either 11.4 or 1.1.4, and "21 Task Visibility" is either
 * chapter 21 or section 2.1. Which one depends on where in the document the line
 * sits, so the caller passes the chapter it is currently reading (tracked from
 * the headings whose numbering was printed intact). LP-1-24 needs both readings:
 * "11 4 Visual Comfort" inside chapter 1 is 1.1.4, while "13 4 Light
 * Distribution on Task Plane" inside chapter 13 is 13.4.
 */
export function normalizeSectionNumber(number, chapter = null) {
  const raw = String(number || '').trim().replace(/[\s.]+$/, '');
  if (!raw) return null;
  if (ANNEX_KEY_RE.test(raw)) {
    return `Annex ${raw.split(/\s+/)[1].toUpperCase()}`;
  }
  // Split on periods AND spaces: the space IS the dropped period.
  const parts = raw.split(/[\s.]+/).filter(Boolean);
  if (parts.length === 0) return null;

  const hint = String(chapter || '');
  // Only a single-digit chapter can be the victim of this ambiguity, and only a
  // two-digit head can be split. "10 Light + Environment" inside chapter 1 must
  // stay chapter 10, hence the trailing-zero guard: a section numbered x.0 is a
  // chapter opener, which is always printed with its separator intact.
  if (/^\d$/.test(hint)) {
    const head = parts[0];
    if (/^\d\d$/.test(head) && head[0] === hint && head[1] !== '0') {
      parts.splice(0, 1, head[0], head[1]);
    }
  }

  const joined = parts.join('.');
  return isPlausibleSectionNumber(joined) ? joined : null;
}

/**
 * The section number a heading line opens with, plus where the title starts.
 *
 * Accepts the space-separated form, which is why it cannot just be a regex on
 * `\d+(\.\d+)*`: on LP-1-24 the printed "13.4" reaches us as "13 4".
 *
 * `raw` is the number exactly as the line printed it, so the caller can tell
 * whether the separators survived (see hasPrintedSeparators).
 *
 * @returns {{ number: string, rest: string, raw: string } | null}
 */
export function readSectionNumber(line, opts = {}) {
  const text = String(line || '').trim();

  const annex = /^(annex|appendix)\s+([A-Z])\b[\s.:—–-]*(.*)$/i.exec(text);
  if (annex) {
    const number = `Annex ${annex[2].toUpperCase()}`;
    return { number, rest: annex[3] || '', raw: number };
  }

  // Leading number: digits (or a single capital) in groups separated by periods
  // OR single spaces. The tail must be a capital letter, which is what
  // separates a heading from a data row ("300 76 corridor floor").
  const m = /^([A-Z]|\d{1,2})((?:[\s.]\d{1,2}){0,5})[\s.:—–-]+(?=[A-Z(])(.*)$/.exec(text);
  if (!m) return null;
  const raw = `${m[1]}${m[2] || ''}`;
  const rest = m[3] || '';
  // A number whose separators we had to infer, followed by a title that itself
  // carries numbers, is a DATA ROW — "10 20 Task Area 300 0.76" reads exactly
  // like a heading whose periods the font dropped. A real heading is a name.
  if (/\s/.test(raw) && /\d/.test(rest)) return null;
  const number = normalizeSectionNumber(raw, opts.chapter);
  if (!number) return null;
  return { number, rest, raw };
}

/**
 * Was this number printed with its separators intact?
 *
 * Only such a number may update the caller's "chapter I am reading" context —
 * a number we had to reconstruct is not evidence about the document's structure.
 */
export function hasPrintedSeparators(rawNumber) {
  const raw = String(rawNumber || '').trim();
  if (ANNEX_KEY_RE.test(raw)) return true;
  if (/^\d{1,2}$/.test(raw)) return true;          // a bare chapter number
  return /^[A-Z0-9]+(?:\.\d{1,2})+$/.test(raw);    // 13.4, A.1.1.3
}

/**
 * A second heading number inside a title — the two-column merge of DO071.
 * Anchored on whitespace so "A.1.1.3" at the start is not its own terminator.
 */
// The space-separated alternative is there because the same dropped-period font
// that turns "13.4" into "13 4" does so to the SECOND heading on the line:
// LP-1-24 p. 78 merges "13.5 Room Surface Brightness" into 13.0's title as
// "Light + Distribution 9 2 Design Considerations for Minimizing".
const SECOND_NUMBER_RE = new RegExp(
  '\\s(?:'
  + '(?:\\d{1,2}(?:[ .]\\d{1,2}){1,4})'      // 8.7.2.4  |  9 2
  + '|(?:[A-Z](?:[.]\\d{1,2}){1,4})'         // A.1.1.6
  + '|(?:Annex|Appendix)\\s+[A-Z]\\b'
  + ')\\s+[A-Z(]',
);

/**
 * Column-merged debris a title never contains.
 *
 * The identifier rules ("PMID: 16494083", any run of five digits) are there
 * because a References page numbers its entries, so a bibliography line reads
 * as a chapter heading: RP-43-25 was producing `8 => "PMID: 16494083"`, which
 * would have headed every chapter-8 card.
 */
const TITLE_JUNK_RE = /_{3,}|•|\.{3,}|\b(?:lx|lux|fc)\b\s*@|https?:\/\/|^[A-Z]{2,}:\s*\d|\d{5,}/i;

/** A single-letter or unit opener: "K dull red", "m above the floor". */
const UNIT_OPENER_RE = /^(?:[A-Za-z]|lx|lux|fc|mm|cm|ft|in|hz|nm|kw|w)\b[\s,.]/i;

/** Words that stay lowercase inside a Title Case heading. */
const FUNCTION_WORDS = new Set([
  'of', 'and', 'for', 'with', 'in', 'on', 'to', 'by', 'per', 'from', 'the', 'a', 'an',
  'or', 'at', 'as', 'vs', 'into', 'over', 'under', 'within', 'is', 'are', 'not',
]);

const isCapitalized = (word) => /^[A-Z(]/.test(word);
const bareWord = (word) => String(word || '').replace(/[^A-Za-z]/g, '').toLowerCase();

/**
 * Is this a long sentence rather than a name?
 *
 * IES sets its headings in Title Case throughout the corpus, so a candidate
 * whose SECOND substantive word is lowercase is prose — and if it also runs to
 * six words or more, it is a merged cell from a two-column table rather than a
 * short sentence-case heading. That is what LP-1-24's specification outline
 * produces ("Work included Outlines work required of contractor") and what
 * RP-43-25's bulleted lists produce ("(Lz3) area would have higher volume
 * pedestrian" under a stray list marker).
 *
 * The word count is the safety margin: a genuine heading written in sentence
 * case ("Design considerations for interior spaces") stays.
 */
function looksLikeSentence(title) {
  const words = title.split(/\s+/);
  if (words.length < 6) return false;
  const substantive = words.filter(w => /[A-Za-z]/.test(w) && !FUNCTION_WORDS.has(bareWord(w)));
  if (substantive.length < 2) return false;
  return isCapitalized(substantive[0]) && !isCapitalized(substantive[1]);
}

/**
 * Cut a Title Case heading where it stops being a heading and becomes the body
 * prose of the NEXT column (client DO071).
 *
 * LP-1-24 p. 16 is two columns; the heading and the neighbouring paragraph share
 * a baseline, so the line arrives as
 *   "Human Needs Served by Lighting task performance, health and safety, and mood and"
 * Title Case stops at "Lighting"; everything after it is a sentence.
 *
 * Only applied to headings the document itself set in Title Case — a standard
 * that writes its headings in sentence case has no such tell, and cutting there
 * would truncate a legitimate title.
 */
function cutAtProseRun(title) {
  const words = title.split(/\s+/);
  if (words.length < 4) return title;

  // Is this heading Title Case? Look at the first three words that are not
  // function words.
  let checked = 0;
  for (const word of words) {
    if (FUNCTION_WORDS.has(bareWord(word))) continue;
    if (!isCapitalized(word)) return title;   // sentence case — no signal to use
    if (++checked === 3) break;
  }
  if (checked < 3) return title;

  for (let i = 2; i < words.length; i++) {
    if (isCapitalized(words[i])) continue;
    let j = i;
    let substantive = 0;
    while (j < words.length && !isCapitalized(words[j])) {
      if (!FUNCTION_WORDS.has(bareWord(words[j]))) substantive++;
      j++;
    }
    if (j - i >= 3 && substantive >= 2) return words.slice(0, i).join(' ');
    i = j;
  }
  return title;
}

/**
 * A heading whose tail repeats its head is a column merge caught mid-repeat:
 * LP-1-24 §1.1.4 prints "Visual Comfort" beside the paragraph "Visual comfort
 * can affect…", and the merged line trimmed at the prose run leaves
 * "Visual Comfort Visual".
 */
function dropDuplicatedTail(title) {
  const words = title.split(/\s+/);
  if (words.length < 3) return title;
  for (let k = Math.min(3, Math.floor(words.length / 2)); k >= 1; k--) {
    const head = words.slice(0, k).map(bareWord).join(' ');
    const tail = words.slice(-k).map(bareWord).join(' ');
    if (head && head === tail) return words.slice(0, words.length - k).join(' ');
  }
  return title;
}

/**
 * A title cut at a line or column break ends on a word that cannot end a name:
 * "The Phases of the", "Lighting Control Technology and", "Retail Lighting
 * Upgrades The". Trimming those reads as a shortened title rather than a broken
 * one — which is what the client's "legibility" ask is about.
 */
function dropDanglingTail(title) {
  let words = title.split(/\s+/);
  while (words.length > 2) {
    const last = bareWord(words[words.length - 1]);
    const dangling = FUNCTION_WORDS.has(last)
      || ['as', 'since', 'when', 'while', 'because', 'these', 'this', 'those', 'it'].includes(last);
    if (!dangling) break;
    words = words.slice(0, -1);
  }
  return words.join(' ');
}

/**
 * Clean one heading's title, or return null when it cannot be trusted.
 *
 * The cuts, in order:
 *   1. dot leaders and a column-aligned page number (a table-of-contents line)
 *   2. a SECOND heading number (the two-column merge)
 *   3. a run-in sentence: IES annexes print "A.1.1 Average Illuminance on a
 *      Horizontal Plane.The measuring instrument should…" as one line, so the
 *      title ends at that period
 */
export function sanitizeSectionTitle(rawTitle) {
  const raw = String(rawTitle || '').trim();
  // A heading is a name, not a sentence: a long line closed by a full stop is
  // body prose or a whole reference entry that merged into the heading.
  if (/\.$/.test(raw) && raw.split(/\s+/).length >= 8) return null;

  let title = String(rawTitle || '')
    .replace(/(?:\.\s*){3,}.*$/, '')        // dot leaders + page number
    .replace(/\s{2,}\d{1,4}$/, '')          // column-aligned page number
    .replace(/\s+/g, ' ')
    .trim();
  if (!title) return null;

  // 2. cut at a second heading number
  const second = SECOND_NUMBER_RE.exec(title);
  if (second) title = title.slice(0, second.index).trim();

  // 3. cut at a run-in sentence — a period followed by a capital, glued or
  //    spaced. An abbreviation ("U.S.", "No.") has a single letter in front of
  //    the period, so it is left alone.
  const runIn = /(?<![A-Z])\.\s*(?=[A-Z])/.exec(title);
  if (runIn) title = title.slice(0, runIn.index).trim();

  // 4. cut where Title Case gives way to the next column's sentence
  title = cutAtProseRun(title);
  // 5. drop a tail that merely repeats the head, and any dangling joining word
  title = dropDuplicatedTail(title);
  title = dropDanglingTail(title);

  title = title.replace(/[\s.:;,–—-]+$/, '').trim();
  if (!title) return null;

  if (title.length < 3 || title.length > MAX_TITLE_LENGTH) return null;
  if (title.split(/\s+/).length > MAX_TITLE_WORDS) return null;
  if (looksLikeSentence(title)) return null;
  if (TITLE_JUNK_RE.test(title)) return null;
  if (!/[A-Za-z]{3}/.test(title)) return null;      // no real word in it
  if (!/^[A-Z(]/.test(title)) return null;          // a title opens with a capital
  if (UNIT_OPENER_RE.test(title)) return null;      // "K dull red"
  // An unbalanced closing bracket is the tail of something the line was cut out
  // of — "2025 Dec 4)" is a date inside a citation, not a heading.
  if ((title.match(/\)/g) || []).length > (title.match(/\(/g) || []).length) return null;
  // A sentence, not a name: an internal semicolon or a lowercase "the following"
  // opener means the line was body prose that merged into the heading.
  if (/;/.test(title)) return null;
  return title;
}

/**
 * One line → { number, title }, or null.
 *
 * The single entry point both the ingest and any re-check should use: it applies
 * the number normalization, the plausibility rule and the title cuts together,
 * so a caller cannot accidentally trust one without the others.
 */
export function parseHeading(line, opts = {}) {
  const read = readSectionNumber(line, opts);
  if (!read) return null;
  const title = sanitizeSectionTitle(read.rest);
  if (!title) return null;
  return { number: read.number, title };
}

/**
 * Order two section numbers the way a printed table of contents does: by each
 * numeric part in turn, with the annexes after the numbered chapters (client
 * DO082).
 *
 *   "2" < "2.1" < "2.10" < "10" < "Annex A" < "Annex B"
 *
 * The numeric compare matters: a string sort puts "2.10" before "2.2".
 */
export function compareSectionNumbers(a, b) {
  const A = String(a || '').trim();
  const B = String(b || '').trim();
  const annexA = /^(?:annex|appendix)\b/i.test(A);
  const annexB = /^(?:annex|appendix)\b/i.test(B);
  if (annexA !== annexB) return annexA ? 1 : -1;
  if (annexA && annexB) return A.localeCompare(B);

  const pa = A.split('.');
  const pb = B.split('.');
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i];
    const y = pb[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = Number(x);
    const ny = Number(y);
    if (Number.isFinite(nx) && Number.isFinite(ny)) {
      if (nx !== ny) return nx - ny;
    } else if (x !== y) {
      return x.localeCompare(y);
    }
  }
  return 0;
}

/**
 * A section-number → title map turned into a table of contents (client DO082).
 *
 * The fallback for a standard indexed before `outline_json` existed: the order
 * is reconstructed from the numbering and there are no page numbers, which is
 * still a usable table of contents — just not a linkable one.
 */
export function outlineFromSectionMap(map) {
  if (!map || typeof map !== 'object') return [];
  return Object.keys(map)
    .sort(compareSectionNumbers)
    .map(number => ({ number, title: map[number], page: null }));
}

/**
 * The chapter a section belongs to: "8.7.2.4" → "8", "A.1.1.3" → "Annex A",
 * "Annex C" → "Annex C" (client DO073: 4.3.3.1 and 4.2.4 are both chapter 4).
 */
export function chapterOf(section) {
  const raw = String(section || '').trim();
  if (!raw) return null;
  if (/^(?:annex|appendix)\b/i.test(raw)) return raw;
  const head = raw.split('.')[0];
  if (!head) return null;
  // An annex-style number ("A.1.1.3") belongs to that annex.
  if (/^[A-Z]$/.test(head)) return `Annex ${head.toUpperCase()}`;
  return /^\d{1,2}$/.test(head) ? head : null;
}

/**
 * How a chapter prints in a card's banner (client DO073: "print chapter name in
 * the blue band at the top of the card").
 *
 *   ("8", "Outdoor Lighting Design Process") → "Ch. 8 – Outdoor Lighting Design Process"
 *   ("Annex A", "Field Measurements")        → "Annex A – Field Measurements"
 *   ("8", null)                              → "Ch. 8"
 */
export function chapterLabel(number, title) {
  const num = String(number || '').trim();
  if (!num) return '';
  const head = /^(?:annex|appendix)\b/i.test(num) ? num : `Ch. ${num}`;
  return title ? `${head} – ${title}` : head;
}
