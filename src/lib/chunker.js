/**
 * IES Section-Aware Document Chunker
 *
 * Splits parsed PDF pages into semantically coherent chunks for embedding.
 * Extracted from scripts/ingest-pdfs.js so the logic is unit-testable and
 * shared. Node-side only concern, but has no Node dependencies.
 *
 * Chunk types produced:
 *   'text'       body prose (default)
 *   'table'      pages dominated by tabular data
 *   'reference'  entries from a standard's References / Bibliography section —
 *                one chunk PER REFERENCE ENTRY where segmentation is possible,
 *                so each result can be hyperlinked individually (DOI, URL, or
 *                Lighting Library link). Powers the references-only search mode.
 *
 * Strategy:
 *  1. Walk pages line-by-line, tracking the current IES section number
 *  2. Start a new chunk at each section heading
 *  3. When a References/Bibliography heading is reached, switch to per-entry
 *     reference chunking until the next non-reference section heading
 *  4. If a chunk exceeds targetWords, flush with overlap carry-over
 *  5. Prepend "[Section X.X]" to continuation chunks for context
 */

import { looksLikeFormalReference } from './references.js';
import {
  readSectionNumber, sanitizeSectionTitle, parseHeading, hasPrintedSeparators, chapterOf,
} from './section-titles.js';

const SECTION_RE = /^(?:(?:\d+(?:\.\d+)*)|(?:[A-Z](?:\.\d+)*))\s+[A-Z].{3,}/;
// The same heading with its periods eaten by a subsetted font: LP-1-24 p. 77
// prints "13.4 Light Distribution on Task Plane" and the parser reads
// "13 4 Light Distribution on Task Plane". SECTION_RE cannot match that (it
// wants a capital straight after the number), so before this the heading was
// invisible and every chunk on the page kept the PREVIOUS section's number —
// the "card labelled 13.1 whose text is 13.4" the client reported (DO071).
const SPACED_SECTION_RE = /^\d{1,2}(?:\s\d{1,2}){1,5}\s+[A-Z(]/;
const ANNEX_RE = /^(?:Annex|Appendix)\s+[A-Z]/i;
// Same shape as ANNEX_RE, with the letter captured: [1] = "Annex"|"Appendix",
// [2] = the letter, [3] = whatever title follows it.
const TABLE_PAGE_RE = /^Table\s+[A-Z0-9]-?\d*/im;

// A heading that starts (or ends) a References section. IES standards title
// these "References", "Normative References", "Informative References", or
// "Bibliography" — bare or behind a section/annex number ("10.0 References",
// "Annex B Bibliography").
const REFERENCES_HEADING_RE =
  /^(?:(?:\d+(?:\.\d+)*|Annex\s+[A-Z]|Appendix\s+[A-Z])[\s.:—-]*)?(?:Normative\s+|Informative\s+)?(?:References?|Bibliography)\s*$/i;

// Chunk sizing (client DO23: "possibly less aggressive 'chunking' will help
// this?" — a broad conceptual query returned a single document-body result).
//
// 350 words is ~2 pages of a standard, so a passage about one narrow concept was
// diluted by everything printed around it: the chunk's embedding drifted toward
// the page's dominant topic and the concept lost to unrelated application rows.
// 200 words keeps a chunk close to a single idea, roughly doubles the number of
// retrievable passages per document, and — with the overlap raised in step — no
// longer splits a provision away from its own heading.
//
// Cost: ~1.75× the vectors per standard. Requires a re-ingest to take effect;
// existing 350-word chunks keep working, they just stay coarse.
const DEFAULTS = {
  targetWords: 200,   // ~285 tokens at 1.4 words/token
  overlapWords: 60,   // overlap between adjacent chunks for context continuity
  minWords: 30,       // discard body chunks shorter than this
  minReferenceWords: 5, // reference entries are legitimately short
};

/**
 * @param {Array<{number, text, lines?}>} pages - from parsePDFNode()
 * @param {object} [options] - chunking parameters (see DEFAULTS)
 * @returns {Array<{text, pageNumber, section, type, wordCount}>}
 */
export function chunkIESDocument(pages, options = {}) {
  const cfg = { ...DEFAULTS, ...options };

  const chunks = [];
  let currentSection = null;
  // The chapter we are reading, tracked from the headings whose numbering the
  // font printed intact. It is what tells "11 4 Visual Comfort" (inside chapter
  // 1 → 1.1.4) from "13 4 Light Distribution" (inside chapter 13 → 13.4) —
  // see normalizeSectionNumber.
  let chapterHint = null;
  let inReferences = false;
  let buffer = [];
  let bufferPage = null;
  let bufferWordCount = 0;
  // Reference entries accumulate separately: [{ lines: [], x, pageNumber }]
  let refEntries = [];
  let refBaseX = null;

  function flushBuffer(type = 'text') {
    if (buffer.length > 0) {
      const text = buffer.join('\n').trim();
      const wordCount = text.split(/\s+/).filter(Boolean).length;
      if (wordCount >= cfg.minWords) {
        chunks.push({ text, pageNumber: bufferPage, section: currentSection, type, wordCount });
      }
    }
    buffer = [];
    bufferWordCount = 0;
    // Always reset — even when the buffer was empty — so the NEXT chunk takes
    // its page from where its content actually starts. Otherwise a chunk
    // after a multi-page detour (e.g. a long References section) inherits a
    // stale page number.
    bufferPage = null;
  }

  function flushReferenceEntries() {
    for (const entry of refEntries) {
      const text = entry.lines.join(' ').replace(/\s+/g, ' ').trim();
      const wordCount = text.split(/\s+/).filter(Boolean).length;
      // Client DO26.1: only entries that are actually FORMAL references may
      // enter the reference index. The heading detector opens a reference run
      // on any line reading "References", so a form/checklist page could
      // otherwise stream body prose in as bibliography entries. Rejected text
      // falls through to the normal body-chunk path below, so nothing is lost
      // from the document-body index.
      if (wordCount >= cfg.minReferenceWords && looksLikeFormalReference(text)) {
        chunks.push({
          text,
          pageNumber: entry.pageNumber,
          section: currentSection || 'References',
          type: 'reference',
          wordCount,
        });
      } else if (wordCount >= cfg.minWords) {
        chunks.push({
          text,
          pageNumber: entry.pageNumber,
          section: currentSection || 'References',
          type: 'text',
          wordCount,
        });
      }
    }
    refEntries = [];
    refBaseX = null;
  }

  for (const page of pages) {
    const lines = page.lines
      ? page.lines.map(l => ({ text: l.text, fontSize: l.fontSize || 10, x: l.x ?? null }))
      : page.text.split('\n').map(t => ({ text: t, fontSize: 10, x: null }));

    const numericRows = lines.filter(l => /\d+\s+\d+/.test(l.text)).length;
    const isTablePage = TABLE_PAGE_RE.test(page.text) || numericRows > lines.length * 0.25;
    // Whether a "13 4"-style heading may be read here. Stricter than
    // isTablePage, which a two-line page can satisfy on the strength of the
    // heading itself: a real criteria grid carries SEVERAL numeric rows.
    const tableish = TABLE_PAGE_RE.test(page.text)
      || (numericRows >= 4 && numericRows > lines.length * 0.25);

    for (const line of lines) {
      const lineText = line.text.trim();
      if (!lineText) continue;

      const isReferencesHeading = REFERENCES_HEADING_RE.test(lineText);
      // The space-separated form is only read on a page that is NOT a table:
      // "10 20 Task Area" is an illuminance row, and admitting it as a heading
      // would stamp §10.20 onto the rest of the page — the very failure DO071
      // reported, arrived at from the other side.
      const spacedHeading = !tableish && SPACED_SECTION_RE.test(lineText);
      let isSectionHeading = SECTION_RE.test(lineText) || spacedHeading
        || ANNEX_RE.test(lineText) || isReferencesHeading;

      // Inside a References section, a citation can masquerade as a section
      // heading ("10 CFR Part 430, Energy Conservation Program…"). Headings
      // don't carry citation punctuation — keep such lines in the reference
      // stream instead of falsely ending the section.
      if (isSectionHeading && !isReferencesHeading && inReferences && isCitationLike(lineText)) {
        isSectionHeading = false;
      }

      if (isSectionHeading && lineText.length > 5) {
        // Any heading ends the current references run — including another
        // references heading (Normative → Informative): entries must be
        // stamped with the section they were collected under, BEFORE
        // currentSection is overwritten.
        if (inReferences) {
          flushReferenceEntries();
          inReferences = false;
        }

        flushBuffer(isTablePage ? 'table' : 'text');
        // The number is read by src/lib/section-titles.js, which spells an annex
        // "Annex A" (so it matches sections_json — client DO40), restores the
        // separator a subsetted font dropped ("13 4" → "13.4"), and returns NULL
        // for a number the document cannot have printed.
        //
        // A null here deliberately CLEARS the section rather than keeping the
        // previous one: "131 Patterns of Light within the occupants' field of
        // view—such as walls and" is two columns' worth of text under a number
        // that does not exist, and a card headed "§131" is worse than a card
        // with no locator at all (the rule the client set for formulae in
        // DO072, applied to locators).
        const read = readSectionNumber(lineText, { chapter: chapterHint });
        currentSection = read ? read.number : null;
        if (read && hasPrintedSeparators(read.raw)) {
          chapterHint = chapterOf(read.number) || chapterHint;
        }
        if (isReferencesHeading) {
          inReferences = true;
          currentSection = currentSection || 'References';
          bufferPage = page.number;
          continue; // the heading itself is not a reference entry
        }
        bufferPage = bufferPage || page.number;
      } else if (isReferencesHeading && lineText.length <= 5) {
        // pathological short heading — ignore
      }

      if (inReferences) {
        appendReferenceLine(refEntries, line, lineText, page.number);
        if (refBaseX == null && line.x != null) refBaseX = line.x;
        continue;
      }

      if (bufferPage === null) bufferPage = page.number;
      buffer.push(lineText);
      bufferWordCount += lineText.split(/\s+/).length;

      if (bufferWordCount >= cfg.targetWords) {
        flushBuffer(isTablePage ? 'table' : 'text');

        // Carry overlap into next chunk with section context prefix
        const overlapLines = getOverlapLines(buffer, cfg.overlapWords);
        buffer = currentSection
          ? [`[Section ${currentSection}]`, ...overlapLines]
          : overlapLines;
        bufferWordCount = buffer.join(' ').split(/\s+/).length;
        bufferPage = page.number;
      }
    }

    // Flush at page boundary if significantly buffered
    if (!inReferences && bufferPage !== page.number && bufferWordCount > cfg.minWords) {
      flushBuffer(isTablePage ? 'table' : 'text');
      bufferPage = page.number;
    }
  }

  if (inReferences) flushReferenceEntries();
  flushBuffer();

  // Split any remaining oversized chunks
  const finalChunks = [];
  for (const chunk of chunks) {
    if (chunk.type !== 'reference' && chunk.wordCount > cfg.targetWords * 2) {
      finalChunks.push(...splitLargeChunk(chunk, cfg));
    } else {
      finalChunks.push(chunk);
    }
  }

  return finalChunks;
}

// ─── Section titles (client DO40) ─────────────────────────────────────────────
//
// "Present and emphasize Section ('chapter') # and title with each search result
//  from the body of a document … Include all 'parent' section titles for
//  context."
//
// A chunk only ever knows its OWN section number ("3.3.4"), so the titles — and
// the parent chain above them — have to come from somewhere else. This builds
// one map per document, { "3": "Design Guide", "3.3": "Transition Spaces…",
// "3.3.4": "Circulation Areas" }, which the ingest stores on the standards row
// and search reads back at query time. Nothing is re-embedded for it, and a
// standard without the map simply renders the number alone, as before.

// A table-of-contents line: dot leaders, or a title trailed by a page number
// after column whitespace. TOC entries have the same shape as headings and come
// FIRST in the document, so without this every title would be the TOC's copy —
// complete with its page number glued on.
const TOC_LINE_RE = /(?:\.\s*){4,}|\s{2,}\d{1,4}\s*$|\t\d{1,4}\s*$/;
const TOC_PAGE_MIN_LEADER_LINES = 4;

/** Words a title may legitimately end on when it continues over a line break. */
const CONTINUATION_TAIL_RE = /\b(?:of|and|for|with|in|on|to|by|per|from|the|a|an|or|at)$/i;
/**
 * An adjective-shaped last word — the other way a title reads unfinished.
 * LP-9-25 prints "A.1.1.3 Regular Area With Single Row of Individual" and
 * completes it with "Luminaires." on the next line.
 */
const ADJECTIVE_TAIL_RE = /(?:al|ive|ous|ent|ant|ary|ic|ual|ble|ing)$/i;
/**
 * Words that open a SENTENCE, not the tail of a heading. Without this the
 * run-in join absorbed the first word of the following paragraph: "4.2 Task
 * Plane Lighting" + "Fig. 4 shows…" became "Task Plane Lighting Fig".
 */
const SENTENCE_OPENERS = new Set([
  'fig', 'figure', 'note', 'table', 'see', 'refer', 'eq', 'no', 'sec', 'section',
  'ch', 'chapter', 'ex', 'example', 'vol', 'app', 'annex', 'ref', 'nb', 'ie', 'eg', 'this', 'these',
]);

/**
 * Build the section-number → section-title map for one parsed document.
 *
 * Reads the line METADATA when the parser supplied it (font size, x position),
 * because two of the client's reported failures are only solvable there: a
 * heading that runs over two lines is one heading, and the second line is
 * recognizable by carrying the heading's own font at the heading's own margin.
 *
 * @param {Array<{number, text, lines?}>} pages - from parsePDFNode()
 * @returns {Record<string, string>} e.g. { "3.3.4": "Circulation Areas" }
 */
export function extractSectionTitles(pages) {
  const titles = {};
  for (const entry of extractOutline(pages)) {
    if (!titles[entry.number]) titles[entry.number] = entry.title;
  }
  return titles;
}

/**
 * The document's TABLE OF CONTENTS: every heading in document order, with the
 * page it was printed on (client DO082).
 *
 * "Provide a 'View Table of Contents' option for each standard on the List
 *  Standards page. This could either be generated by indexing or could be pulled
 *  from the 'preview' files … Goal: provide easy access to TOC for each
 *  document."
 *
 * Generated by indexing, which is the option that needs nothing new hosted: the
 * ingest already finds every heading for the section titles (DO040/DO071), so
 * the only thing missing was keeping their ORDER and their PAGE. An object map
 * cannot carry order, hence this array — `extractSectionTitles` is now derived
 * from it, so there is exactly one heading walk and the two can never disagree.
 */
export function extractOutline(pages) {
  const outline = [];
  const seen = new Set();
  // See chunkIESDocument: the chapter currently being read disambiguates a
  // number whose separators the font dropped.
  let chapterHint = null;
  for (const page of pages) {
    const lines = headingLines(page);

    // Skip the table of contents wholesale: its entries are headings verbatim,
    // but a page-number tail survives on lines whose leaders the parser dropped.
    const leaderLines = lines.filter(l => /(?:\.\s*){4,}/.test(l.text)).length;
    if (leaderLines >= TOC_PAGE_MIN_LEADER_LINES) continue;

    const bodySize = dominantFontSize(lines);
    // Same guard as the chunker's: a numeric row on a table page must not be
    // read as a heading whose separators the font dropped.
    const numericLines = lines.filter(l => /\d+\s+\d+/.test(l.text)).length;
    const tablePage = TABLE_PAGE_RE.test(page.text || '')
      || (numericLines >= 4 && numericLines > lines.length * 0.25);

    const found = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.text.length < 4 || line.text.length > 200) continue;
      if (TOC_LINE_RE.test(line.text)) continue;
      if (tablePage && SPACED_SECTION_RE.test(line.text)) continue;
      // A bibliography entry has a heading's shape — "6. Illuminating
      // Engineering Society. ANSI/IES LS-7-20…" reads as number 6 titled
      // "Illuminating Engineering Society" — so the References pages are the
      // single biggest source of invented section titles. Same test the chunker
      // uses to decide what is a reference (client DO26.1).
      if (looksLikeFormalReference(line.text)) continue;
      const read = readSectionNumber(line.text, { chapter: chapterHint });
      if (!read) continue;
      // The number is structural evidence even when the title beside it is not
      // usable, so the chapter context updates first.
      if (hasPrintedSeparators(read.raw)) {
        chapterHint = chapterOf(read.number) || chapterHint;
      }
      // A display heading may print its number and its title on separate lines:
      // LP-9-25 opens its annex with "Annex A" over "Field Measurements", both
      // in 15pt bold. Without this the annex has no title at all.
      const title = sanitizeSectionTitle(read.rest) || titleFromNextLine(lines, i, bodySize);
      if (!title) continue;
      found.push({
        number: read.number,
        title: joinHeadingContinuation(title, lines, i, bodySize),
        page: page.number,
      });
    }

    // A page carrying a RUN of bare integers is a numbered list, not a set of
    // chapter headings: LP-1-24's specification appendix numbers its clauses
    // "1. Provide submittals in accordance with Division 26…", which would
    // otherwise become the title of chapter 1 and head every chapter-1 card.
    // Dotted numbers on the same page are unaffected — they are unambiguous.
    const bareIntegers = found.filter(f => /^\d{1,2}$/.test(f.number));
    const listPage = bareIntegers.length >= 3;

    for (const f of found) {
      if (listPage && /^\d{1,2}$/.test(f.number)) continue;
      // First occurrence wins: the body heading is the authoritative print, and
      // a later cross-reference ("see 3.3.4 Circulation Areas, above") should
      // never overwrite it.
      if (seen.has(f.number)) continue;
      seen.add(f.number);
      outline.push(f);
    }
  }
  return outline;
}

/** Page → trimmed, non-empty lines with whatever metadata the parser gave us. */
function headingLines(page) {
  const raw = page.lines
    ? page.lines.map(l => ({
        text: String(l.text || '').trim(),
        fontSize: typeof l.fontSize === 'number' ? l.fontSize : 10,
        x: typeof l.x === 'number' ? l.x : null,
      }))
    : String(page.text || '').split('\n').map(t => ({ text: String(t || '').trim(), fontSize: 10, x: null }));
  return raw.filter(l => l.text);
}

/** The font size covering the most characters on the page — its body text. */
function dominantFontSize(lines) {
  const charsBySize = new Map();
  for (const l of lines) {
    const size = Math.round(l.fontSize * 2) / 2;
    charsBySize.set(size, (charsBySize.get(size) || 0) + l.text.length);
  }
  let best = 10;
  let bestChars = -1;
  for (const [size, chars] of charsBySize) {
    if (chars > bestChars) { bestChars = chars; best = size; }
  }
  return best;
}

/**
 * A heading printed over two lines is one heading (client DO071).
 *
 * Two shapes, both observed in the corpus:
 *
 *  • A DISPLAY heading, set larger than the body text, whose remainder sits on
 *    the next line in the same font at the same margin. LP-1-24 p. 77 prints
 *    "13.4 Light Distribution on Task Plane" / "(Uniformity)" — and the client
 *    asked for exactly "13.4 Light Distribution on Task Plane (Uniformity)".
 *
 *  • A RUN-IN heading, set in the body font, whose last word is on the next line
 *    followed by the sentence it introduces. LP-9-25 p. 68 prints
 *    "A.1.1.3 Regular Area With Single Row of Individual" /
 *    "Luminaires. The average illuminance…" — the client asked for
 *    "A.1.1.3 Regular Area With Single Row of Individual Luminaires".
 *
 * Conservative in both cases: a title that already reads as complete (it closes
 * a bracket, or ends on a colon) is left alone, and the joined result must still
 * pass the title sanitizer.
 */
/**
 * The title of a heading that printed its number alone on one line, taken from
 * the next line — only when that line is set in the heading's own display font
 * at the heading's own margin, and is not itself a heading.
 */
function titleFromNextLine(lines, index, bodySize) {
  const line = lines[index];
  const next = lines[index + 1];
  if (!next) return null;
  if (line.fontSize <= bodySize + 0.4) return null;             // not a display heading
  if (Math.abs(next.fontSize - line.fontSize) > 0.4) return null;
  if (line.x != null && next.x != null && Math.abs(next.x - line.x) > 4) return null;
  if (parseHeading(next.text)) return null;
  if (next.text.split(/\s+/).length > 10) return null;
  return sanitizeSectionTitle(next.text);
}

function joinHeadingContinuation(title, lines, index, bodySize) {
  const next = lines[index + 1];
  if (!next) return title;
  const line = lines[index];
  if (/[)\]:.]$/.test(title)) return title;
  if (parseHeading(next.text)) return title;      // the next line is its own heading

  const isDisplay = line.fontSize > bodySize + 0.4;
  if (isDisplay
      && Math.abs(next.fontSize - line.fontSize) <= 0.4
      && (line.x == null || next.x == null || Math.abs(next.x - line.x) <= 4)
      && next.text.split(/\s+/).length <= 8) {
    return sanitizeSectionTitle(`${title} ${next.text}`) || title;
  }

  // Run-in: the next line opens with the tail of the title, then a full stop and
  // the body sentence. Two conditions, and BOTH are load-bearing:
  //
  //  • the title must read UNFINISHED — it ends on a joining word ("of", "and")
  //    or on an adjective ("…Row of Individual"). "Interior Circulation Areas"
  //    is a complete noun phrase and takes nothing.
  //  • the candidate must not be a word that opens a sentence. "4.2 Task Plane
  //    Lighting" followed by "Fig. 4 shows…" used to become "…Lighting Fig".
  const words = title.split(/\s+/);
  if (words.length < 3) return title;
  const runIn = /^([A-Z][A-Za-z'’-]*(?:\s+[A-Za-z'’-]+)?)\.(?:\s|$)/.exec(next.text);
  if (!runIn) return title;
  const last = words[words.length - 1];
  const looksUnfinished = CONTINUATION_TAIL_RE.test(last) || ADJECTIVE_TAIL_RE.test(last);
  if (!looksUnfinished) return title;
  const candidate = runIn[1];
  const firstWord = candidate.split(/\s+/)[0].replace(/[^A-Za-z]/g, '').toLowerCase();
  if (SENTENCE_OPENERS.has(firstWord)) return title;
  return sanitizeSectionTitle(`${title} ${candidate}`) || title;
}

/**
 * One line → { number, title }, or null when it is not a heading.
 *
 * Kept as the module's public name (the DO40 tests and any future caller use
 * it); the rules now live in src/lib/section-titles.js so the search worker can
 * apply the SAME judgement to the titles already in D1 without a re-ingest.
 */
export function parseHeadingLine(line) {
  return parseHeading(line);
}

/**
 * Append one line inside a References section, deciding whether it starts a
 * NEW reference entry or continues the current one.
 *
 * Entry-start signals (any one suffices):
 *   • numbered prefix: "12.", "[12]", "12)" — explicit reference numbering
 *   • hanging indent: the line's X is at the block's base X while the previous
 *     entry's continuation lines were indented deeper
 *   • the previous entry "looks complete" (ends with a period/URL/year) AND
 *     this line starts with an author/organization pattern
 *
 * Falls back to fixed-size grouping (~80 words) when no signal is available,
 * so unsegmentable reference blocks still index as 'reference' chunks.
 */
function appendReferenceLine(refEntries, line, lineText, pageNumber) {
  const NUMBERED_START = /^\[?\d{1,3}\]?[.)]\s+\S/;
  // "Smith, J." | "Rea MS," (medical style) | "NFPA." / org acronyms
  const AUTHOR_START = /^(?:[A-Z][A-Za-z'’-]+,\s|[A-Z][a-z'’-]+\s+[A-Z]{1,3}[.,\s]|[A-Z]{2,}[.,\s]|(?:ANSI|IES|BSR|CIE|ISO|IEC|ASHRAE|IEEE)\b)/;
  const FALLBACK_MAX_WORDS = 80;

  const last = refEntries[refEntries.length - 1];
  const lastText = last ? last.lines.join(' ') : '';
  const lastComplete = /[.)\]]\s*$|\d{4}[.,]?\s*$|https?:\/\/\S+$/i.test(lastText.trim());

  let startsNew = false;
  if (!last) {
    startsNew = true;
  } else if (NUMBERED_START.test(lineText)) {
    startsNew = true;
  } else if (line.x != null && last.x != null && line.x <= last.x + 2 && lastIndented(last)) {
    // hanging indent returned to base X
    startsNew = true;
  } else if (lastComplete && AUTHOR_START.test(lineText)) {
    startsNew = true;
  } else if (lastComplete && /^\d+\s+[A-Z]/.test(lineText)) {
    // regulation-style citation start ("10 CFR Part 430, …") after a
    // completed entry — continuations never begin digit-then-capital
    startsNew = true;
  } else if (lastText.split(/\s+/).length >= FALLBACK_MAX_WORDS) {
    startsNew = true; // safety valve: never let one entry grow unbounded
  }

  if (startsNew) {
    refEntries.push({ lines: [lineText], x: line.x, pageNumber, deepestX: line.x });
  } else {
    last.lines.push(lineText);
    if (line.x != null && (last.deepestX == null || line.x > last.deepestX)) {
      last.deepestX = line.x;
    }
  }
}

function lastIndented(entry) {
  return entry.x != null && entry.deepestX != null && entry.deepestX > entry.x + 2;
}

/**
 * Citation punctuation that section headings never carry: an early comma,
 * a year, a URL, or page markers. Used to keep heading-shaped reference
 * entries ("10 CFR Part 430, Energy Conservation…") inside the References
 * stream.
 */
function isCitationLike(text) {
  return /,/.test(text.slice(0, 60)) ||
    /\b(19|20)\d{2}\b/.test(text) ||
    /https?:\/\//i.test(text) ||
    /\bpp?\.\s*\d/.test(text);
}

function getOverlapLines(lines, targetWords) {
  const result = [];
  let count = 0;
  for (let i = lines.length - 1; i >= 0 && count < targetWords; i--) {
    count += lines[i].split(/\s+/).length;
    result.unshift(lines[i]);
  }
  return result;
}

function splitLargeChunk(chunk, cfg) {
  const words = chunk.text.split(/\s+/);
  const step = cfg.targetWords - cfg.overlapWords;
  const subChunks = [];

  for (let i = 0; i < words.length; i += step) {
    const sliceWords = words.slice(i, i + cfg.targetWords);
    if (sliceWords.length < cfg.minWords) break;
    subChunks.push({
      text: sliceWords.join(' '),
      pageNumber: chunk.pageNumber,
      section: chunk.section,
      type: chunk.type,
      wordCount: sliceWords.length,
    });
  }

  return subChunks.length > 0 ? subChunks : [chunk];
}
