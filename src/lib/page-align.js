/**
 * Manuscript → PDF page alignment — the centerpiece of the dual-upload ingest
 * (docs/DOCX_INGEST.md). A .docx carries no page numbers, and every citation
 * surface in Lensy (Library #page=N deep links, excerpt citations, outline
 * pages, asset chips) is keyed on the PUBLISHED PDF's page index — so every
 * manuscript-sourced chunk is stamped with the PDF page where its text begins.
 *
 * Tractable because both files are the same document. Both sides are
 * normalized to a bare [a-z0-9] character stream — the DO110 trick, one move
 * that erases hyphenation-at-line-break, ligatures, subsetted-font
 * punctuation, and every whitespace difference ("illumi-\nnance" and
 * "illuminance" become the same bytes). Each chunk's opening characters are
 * then searched for MONOTONICALLY: chunks arrive in document order, so the
 * cursor only moves forward, which is near-linear and immune to a phrase that
 * repeats later in the document.
 *
 * The failures are the feature: a chunk that cannot be located ('inherited')
 * is manuscript drift, and the report of them — in both directions — is the
 * client's "ensure we're not losing content" guarantee. The caller gates on
 * bodyInheritedFraction (prose only: a DOCX table serializes cells in an
 * order the PDF's layout stream need not share, so tables legitimately miss).
 */

/** Lowercased [a-z0-9]-only stream — see the header for why so aggressive. */
export function normalizeAlignText(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/**
 * One normalized stream for the whole document, with per-page offsets.
 * @param {Array<{number:number, text?:string}>} pages - built PDF pages
 */
export function buildPageIndex(pages) {
  let stream = '';
  const pageStarts = [];
  for (const page of pages) {
    pageStarts.push({ page: page.number, start: stream.length });
    stream += normalizeAlignText(page.text || '');
  }
  return { stream, pageStarts };
}

/** The page a stream position falls on (binary search over pageStarts). */
export function pageAt(index, pos) {
  const starts = index.pageStarts;
  if (!starts.length) return null;
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid].start <= pos) lo = mid;
    else hi = mid - 1;
  }
  return starts[lo].page;
}

// Anchor ladder: 72 normalized characters (~12 words) is specific enough that
// a false hit is practically impossible; 40 and 24 are the fuzzy fallbacks for
// openings the two extractions render differently (a dropped field result, a
// list marker). Below MIN_SIGNAL there is nothing to judge a match by.
const ANCHOR_LENGTHS = [72, 40, 24];
const MIN_SIGNAL = 12;

// Continuation chunks open with the chunker's "[Section X.X]" marker, which is
// ours, not the document's — never part of the anchor.
const CONTINUATION_MARKER_RE = /^\[[^\]\n]{1,40}\]\s*/;

// A PDF page with less normalized text than this is a divider/blank — its
// absence from coverage is not evidence of lost content.
const MIN_COVERABLE_PAGE_CHARS = 150;

/**
 * Stamp every chunk with the PDF page its text begins on.
 *
 * @param {Array<{text, section, type, wordCount}>} chunks - document order
 * @param {Array<{number, text}>} pages - built PDF pages
 * @returns {{
 *   chunks: Array<chunk & {pageNumber, pageConfidence}>,
 *   report: object,        // see below — stored as the job's alignment_json
 *   index: object,         // the page index, reusable for outline/assets
 *   firstMatchPos: number, // where body content starts (skips front matter)
 * }}
 */
export function alignChunksToPdfPages(chunks, pages) {
  const index = buildPageIndex(pages);
  const aligned = [];
  const counts = { exact: 0, fuzzy: 0, relocated: 0, inherited: 0 };
  const unmatchedSamples = [];
  const coverageRanges = [];
  let cursor = 0;
  let firstMatchPos = -1;
  let bodyTotal = 0;
  let bodyInherited = 0;

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const isBody = chunk.type === 'text' || chunk.type === 'reference';
    if (isBody) bodyTotal++;

    const norm = normalizeAlignText(String(chunk.text || '').replace(CONTINUATION_MARKER_RE, ''));
    let pos = -1;
    let confidence = null;

    if (norm.length >= MIN_SIGNAL) {
      for (const len of ANCHOR_LENGTHS) {
        const anchor = norm.slice(0, Math.min(len, norm.length));
        pos = index.stream.indexOf(anchor, cursor);
        if (pos >= 0) {
          confidence = (len === ANCHOR_LENGTHS[0] || anchor.length === norm.length) ? 'exact' : 'fuzzy';
          break;
        }
        if (anchor.length === norm.length) break; // the whole text already failed
      }
      // Out-of-order fallback (an annex the manuscript places differently):
      // full-strength anchor only, from the top — a weak anchor searched
      // globally would false-hit.
      if (pos < 0 && cursor > 0) {
        pos = index.stream.indexOf(norm.slice(0, ANCHOR_LENGTHS[0]), 0);
        if (pos >= 0) confidence = 'relocated';
      }
    }

    if (pos >= 0) {
      counts[confidence]++;
      // Search the NEXT chunk from just past this chunk's start, not from its
      // end — a continuation chunk opens with the previous chunk's overlap
      // carry, which lives INSIDE it. One character past the start, so a
      // boilerplate opening repeated verbatim in a later chapter still moves
      // forward instead of re-matching the same spot.
      cursor = Math.max(cursor, pos + 1);
      if (firstMatchPos < 0) firstMatchPos = pos;
      coverageRanges.push([pos, pos + norm.length]);
      aligned.push({ ...chunk, pageNumber: pageAt(index, pos), pageConfidence: confidence });
    } else {
      counts.inherited++;
      if (isBody) bodyInherited++;
      if (unmatchedSamples.length < 5) {
        unmatchedSamples.push({ index: i, type: chunk.type, opening: String(chunk.text || '').slice(0, 90) });
      }
      aligned.push({ ...chunk, pageNumber: null, pageConfidence: 'inherited' });
    }
  }

  // Unlocated chunks inherit their nearest located neighbour's page — forward
  // first (document order makes the previous chunk the best guess), then
  // backward for a leading run, then page 1.
  let lastPage = null;
  for (const c of aligned) {
    if (c.pageNumber != null) lastPage = c.pageNumber;
    else if (lastPage != null) c.pageNumber = lastPage;
  }
  let nextPage = null;
  for (let i = aligned.length - 1; i >= 0; i--) {
    if (aligned[i].pageConfidence !== 'inherited') nextPage = aligned[i].pageNumber;
    else if (aligned[i].pageNumber == null) aligned[i].pageNumber = nextPage ?? (pages[0] ? pages[0].number : 1);
  }

  // The other direction of "not losing content": substantial PDF pages no
  // located chunk touched. Front matter (before the first match) is expected
  // to be uncovered — the manuscript legitimately lacks the ANSI boilerplate.
  const covered = new Set();
  for (const [from, to] of coverageRanges) {
    const first = pageAt(index, from);
    const last = pageAt(index, Math.max(from, to - 1));
    if (first == null || last == null) continue;
    for (let p = first; p <= last; p++) covered.add(p);
  }
  const firstMatchedPage = firstMatchPos >= 0 ? pageAt(index, firstMatchPos) : null;
  const uncoveredPages = [];
  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    if (firstMatchedPage == null || page.number < firstMatchedPage) continue;
    if (covered.has(page.number)) continue;
    if (normalizeAlignText(page.text || '').length < MIN_COVERABLE_PAGE_CHARS) continue;
    uncoveredPages.push(page.number);
  }

  const located = counts.exact + counts.fuzzy + counts.relocated;
  const report = {
    total: chunks.length,
    located,
    exact: counts.exact,
    fuzzy: counts.fuzzy,
    relocated: counts.relocated,
    inherited: counts.inherited,
    bodyTotal,
    bodyInherited,
    bodyInheritedFraction: bodyTotal > 0 ? bodyInherited / bodyTotal : 0,
    unmatchedSamples,
    pdfPageCount: pages.length,
    uncoveredPageCount: uncoveredPages.length,
    uncoveredPages: uncoveredPages.slice(0, 20),
  };

  return { chunks: aligned, report, index, firstMatchPos: Math.max(0, firstMatchPos) };
}

/**
 * Locate a document-ordered sequence of short texts (captions, headings) in
 * the page index. `startPos` floors the search — passing the first body-chunk
 * position skips the front matter, so a caption is found at the FIGURE, not in
 * a List of Figures.
 *
 * @returns Array<{page, pos} | null> - one entry per input text
 */
export function alignSequenceToPages(index, texts, { startPos = 0, minSignal = 10 } = {}) {
  const results = [];
  let cursor = startPos;
  for (const text of texts) {
    const norm = normalizeAlignText(text);
    if (norm.length < minSignal) {
      results.push(null);
      continue;
    }
    const anchor = norm.slice(0, Math.min(64, norm.length));
    let pos = index.stream.indexOf(anchor, cursor);
    if (pos < 0 && cursor > startPos) pos = index.stream.indexOf(anchor, startPos);
    if (pos >= 0) {
      results.push({ page: pageAt(index, pos), pos });
      cursor = Math.max(startPos, pos);
    } else {
      results.push(null);
    }
  }
  return results;
}
