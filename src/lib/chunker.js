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

const SECTION_RE = /^(?:(?:\d+(?:\.\d+)*)|(?:[A-Z](?:\.\d+)*))\s+[A-Z].{3,}/;
const ANNEX_RE = /^(?:Annex|Appendix)\s+[A-Z]/i;
const TABLE_PAGE_RE = /^Table\s+[A-Z0-9]-?\d*/im;

// A heading that starts (or ends) a References section. IES standards title
// these "References", "Normative References", "Informative References", or
// "Bibliography" — bare or behind a section/annex number ("10.0 References",
// "Annex B Bibliography").
const REFERENCES_HEADING_RE =
  /^(?:(?:\d+(?:\.\d+)*|Annex\s+[A-Z]|Appendix\s+[A-Z])[\s.:—-]*)?(?:Normative\s+|Informative\s+)?(?:References?|Bibliography)\s*$/i;

const DEFAULTS = {
  targetWords: 350,   // ~500 tokens at 1.4 words/token
  overlapWords: 40,   // overlap between adjacent chunks for context continuity
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
      if (wordCount >= cfg.minReferenceWords) {
        chunks.push({
          text,
          pageNumber: entry.pageNumber,
          section: currentSection || 'References',
          type: 'reference',
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
        const secMatch = lineText.match(/^(\d+(?:\.\d+)*|[A-Z](?:\.\d+)*)/);
        currentSection = secMatch ? secMatch[1] : (ANNEX_RE.test(lineText) ? 'Annex' : null);
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
