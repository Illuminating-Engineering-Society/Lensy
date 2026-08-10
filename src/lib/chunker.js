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

const SECTION_RE = /^(?:(?:\d+(?:\.\d+)*)|(?:[A-Z](?:\.\d+)*))\s+[A-Z].{3,}/;
const ANNEX_RE = /^(?:Annex|Appendix)\s+[A-Z]/i;
// Same shape as ANNEX_RE, with the letter captured: [1] = "Annex"|"Appendix",
// [2] = the letter, [3] = whatever title follows it.
const ANNEX_MATCH_RE = /^(Annex|Appendix)\s+([A-Z])\b[\s.:—–-]*(.*)$/i;
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

    const isTablePage = TABLE_PAGE_RE.test(page.text) ||
      lines.filter(l => /\d+\s+\d+/.test(l.text)).length > lines.length * 0.25;

    for (const line of lines) {
      const lineText = line.text.trim();
      if (!lineText) continue;

      const isReferencesHeading = REFERENCES_HEADING_RE.test(lineText);
      let isSectionHeading = SECTION_RE.test(lineText) || ANNEX_RE.test(lineText) || isReferencesHeading;

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
        // Annex first: the numeric matcher below is not anchored to a word
        // boundary, so "Annex A Supplemental Guidance" used to yield section "A"
        // — the leading letter of the word "Annex". Section numbers have to
        // match sections_json (see extractSectionTitles) for the printed
        // "§ number + title" line to resolve (client DO40).
        const annexMatch = ANNEX_MATCH_RE.exec(lineText);
        const secMatch = annexMatch ? null : lineText.match(/^(\d+(?:\.\d+)*|[A-Z](?:\.\d+)*)/);
        currentSection = annexMatch
          ? `Annex ${annexMatch[2].toUpperCase()}`
          : (secMatch ? secMatch[1] : null);
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

// A numbered heading: "3.3.4 Circulation Areas", "A.2 Calculation Method".
// The title must open with a CAPITAL, matching SECTION_RE above — that is what
// separates a heading from a data row ("300 lux at 0.76 m") or a sentence that
// happens to start with a numeral.
const NUMBERED_HEADING_RE = /^(\d+(?:\.\d+)*|[A-Z](?:\.\d+)+)[\s.:—–-]+([A-Z][^\n]{2,})$/;

/**
 * Build the section-number → section-title map for one parsed document.
 *
 * @param {Array<{number, text, lines?}>} pages - from parsePDFNode()
 * @returns {Record<string, string>} e.g. { "3.3.4": "Circulation Areas" }
 */
export function extractSectionTitles(pages) {
  const titles = {};
  for (const page of pages) {
    const rawLines = page.lines
      ? page.lines.map(l => l.text)
      : String(page.text || '').split('\n');
    const lines = rawLines.map(t => String(t || '').trim()).filter(Boolean);

    // Skip the table of contents wholesale: its entries are headings verbatim,
    // but a page-number tail survives on lines whose leaders the parser dropped.
    const leaderLines = lines.filter(l => /(?:\.\s*){4,}/.test(l)).length;
    if (leaderLines >= TOC_PAGE_MIN_LEADER_LINES) continue;

    for (const line of lines) {
      if (line.length < 4 || line.length > 160) continue;
      if (TOC_LINE_RE.test(line)) continue;
      const heading = parseHeadingLine(line);
      if (!heading || !heading.title) continue;
      // First occurrence wins: the body heading is the authoritative print, and
      // a later cross-reference ("see 3.3.4 Circulation Areas, above") should
      // never overwrite it.
      if (!titles[heading.number]) titles[heading.number] = heading.title;
    }
  }
  return titles;
}

/** One line → { number, title }, or null when it is not a heading. */
export function parseHeadingLine(line) {
  const text = String(line || '').trim();

  const annex = ANNEX_MATCH_RE.exec(text);
  if (annex) {
    return { number: `Annex ${annex[2].toUpperCase()}`, title: cleanHeadingTitle(annex[3]) };
  }

  const numbered = NUMBERED_HEADING_RE.exec(text);
  if (!numbered) return null;
  const title = cleanHeadingTitle(numbered[2]);
  // Reject sentence fragments that merely begin with a numeral ("2.1 times the
  // maintained value…"): a heading is a NAME, so it stays short and carries no
  // sentence punctuation.
  if (!title || title.length > 120 || /[.;]\s/.test(title)) return null;
  return { number: numbered[1], title };
}

function cleanHeadingTitle(raw) {
  return String(raw || '')
    .replace(/(?:\.\s*){3,}.*$/, '')     // dot leaders + page number
    .replace(/\s{2,}\d{1,4}$/, '')       // column-aligned page number
    .replace(/[\s.:;,–—-]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
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
