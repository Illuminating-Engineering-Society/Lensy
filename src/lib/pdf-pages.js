/**
 * PDF page reconstruction — pure functions, runtime-agnostic.
 *
 * Everything below pdfjs's raw `textContent.items` lives here so it can run in
 * BOTH halves of the pipeline:
 *   - Node (scripts/ingest-pdfs.js via src/lib/pdf-parser.js), where pdfjs
 *     itself parses the PDF, and
 *   - the Worker (src/workers/staff-ingest.ts), where the STAFF BROWSER parses
 *     the PDF with a vendored pdfjs and ships the raw text items per page —
 *     pdfjs cannot run in workerd, but every judgement made ON its output can.
 *
 * The one input shape both paths produce is the "raw page":
 *
 *   { number, view: [x0, y0, x1, y1], items: [{ str, transform, fontName, width, hasEOL }] }
 *
 * `view` is pdfjs's page.view; `items` is textContent.items (only the five
 * fields named above are read — a browser sender may strip the rest, and may
 * drop items whose `str` is empty/whitespace, since every consumer here
 * filters those anyway).
 *
 * The output shape is the `pages` array the whole extraction stack consumes
 * (chunker, section-titles, cover-title, applications-extractor, …):
 *
 *   { number, text, lines: [{ text, y, x, fontSize, bold, marks }], width, height }
 *
 * These functions were extracted VERBATIM from src/lib/pdf-parser.js (which now
 * imports them), so the Node script and the dashboard ingest can never drift on
 * how a line is built.
 */

// ─── Metadata helpers ─────────────────────────────────────────────────────────

export function cleanMetaString(val) {
  if (!val) return '';
  return String(val).replace(/[\x00-\x1F\x7F]/g, '').trim();
}

export function extractYear(dateStr) {
  if (!dateStr) return null;
  // PDF date format: D:YYYYMMDDHHmmSS or plain YYYY
  const match = String(dateStr).match(/(?:D:)?(\d{4})/);
  return match ? match[1] : null;
}

/**
 * Normalize a pdfjs `getMetadata().info` object (or any bag carrying the PDF's
 * /Title, /Author, … fields) into the metadata shape the ingest pipeline uses.
 * Tolerates null/undefined — a document with no metadata is a real state.
 */
export function cleanDocMeta(info) {
  const i = info || {};
  return {
    title: cleanMetaString(i.Title),
    author: cleanMetaString(i.Author),
    subject: cleanMetaString(i.Subject),
    keywords: cleanMetaString(i.Keywords),
    year: extractYear(i.CreationDate || i.ModDate),
  };
}

// ─── Header/Footer Detection ──────────────────────────────────────────────────
// IES standards have repeated page headers like "ANSI/IES RP-9-20" and
// footers like "© 2020 IES" on every page. Detect and strip these.

/**
 * Identify repeating header/footer text from the first few RAW pages
 * (appears on 3+ sampled pages at the same Y position).
 *
 * @param {Array<{number, view, items}>} rawPages — the document's first pages,
 *   in order; only the first 5 are sampled (fewer if the document is shorter).
 * @returns {Set<string>} lower-cased strings to strip during line building
 */
export function detectHeadersFootersFromRaw(rawPages) {
  const samplePages = Math.min(5, rawPages.length);
  const textByYBucket = new Map(); // Map<yBucket, Map<string, count>>

  for (let i = 0; i < samplePages; i++) {
    const raw = rawPages[i];
    const view = raw.view || [0, 0, 0, 0];
    const pageHeight = view[3];

    for (const item of raw.items || []) {
      if (!item.str?.trim()) continue;
      const y = pageHeight - item.transform[5]; // flip to top-left
      // Only consider top 8% and bottom 8% of page as header/footer candidates
      const isHeaderZone = y < pageHeight * 0.08;
      const isFooterZone = y > pageHeight * 0.92;
      if (!isHeaderZone && !isFooterZone) continue;

      const yBucket = Math.round(y / 5) * 5; // 5pt buckets
      const str = item.str.trim();
      if (!textByYBucket.has(yBucket)) textByYBucket.set(yBucket, new Map());
      const bucket = textByYBucket.get(yBucket);
      bucket.set(str, (bucket.get(str) || 0) + 1);
    }
  }

  // Text that appears on 3+ sampled pages at the same Y position = header/footer
  const repeating = new Set();
  for (const [, bucket] of textByYBucket) {
    for (const [text, count] of bucket) {
      if (count >= Math.min(3, samplePages - 1)) {
        repeating.add(text.toLowerCase());
      }
    }
  }

  return repeating;
}

// ─── Page Text Reconstruction ─────────────────────────────────────────────────

/**
 * Build one finished page from a raw page.
 *
 * @param {{number, view, items}} rawPage
 * @param {Set<string>} headerFooterSet — from detectHeadersFootersFromRaw
 * @returns {{number, text, lines, width, height}}
 */
export function buildPageFromRaw(rawPage, headerFooterSet) {
  const view = rawPage.view || [0, 0, 0, 0];
  const { text, lines } = buildPageContent(rawPage.items || [], view, headerFooterSet);
  return {
    number: rawPage.number,
    text,
    lines,
    width: view[2],
    height: view[3],
  };
}

/**
 * Convert raw PDF text items into structured lines and a flat text string.
 *
 * Handles:
 * - Multi-column layouts: items are clustered into columns by X-gap detection,
 *   then each column is read top-to-bottom independently. Without this, items
 *   from left and right columns at the same Y interleave line-by-line and
 *   produce gibberish like "The lighting design / hazards. / for all..."
 * - Font size / bold detection for section heading identification
 * - Header/footer stripping
 */
export function buildPageContent(items, viewport, headerFooterSet) {
  if (!items || items.length === 0) return { text: '', lines: [] };

  const pageHeight = viewport[3];
  const pageWidth = viewport[2];

  // Parse and normalize each text item
  const parsed = items
    .filter(item => item.str && item.str.trim().length > 0)
    .map(item => {
      const x = item.transform[4];
      const y = pageHeight - item.transform[5]; // flip to top-left origin
      const fontSize = Math.abs(item.transform[3]) || Math.abs(item.transform[0]) || 10;
      const fontName = (item.fontName || '').toLowerCase();
      const bold = fontName.includes('bold') || fontName.includes('black') ||
                   fontName.includes('heavy') || fontSize > 14;
      const width = item.width || (item.str.length * fontSize * 0.5);
      return { str: item.str, x, y, width, fontSize, bold, hasEOL: item.hasEOL };
    });

  if (parsed.length === 0) return { text: '', lines: [] };

  // Detect column boundaries via X-gap analysis. Tables are read as a single
  // column because their cells legitimately span the page width.
  const columnRanges = detectColumns(parsed, pageWidth);

  // Sort items within each column by (y, x) and build lines per column,
  // then concatenate columns left-to-right. This preserves reading order.
  const allLines = [];
  for (const [colMin, colMax] of columnRanges) {
    const colItems = parsed
      .filter(p => p.x >= colMin && p.x < colMax)
      .sort((a, b) => {
        const yDiff = a.y - b.y;
        if (Math.abs(yDiff) > 3) return yDiff;
        return a.x - b.x;
      });
    if (colItems.length === 0) continue;
    allLines.push(...groupItemsIntoLines(colItems, headerFooterSet));
  }

  const text = allLines.map(l => l.text).join('\n');
  return { text, lines: allLines };
}

/**
 * Detect column boundaries by finding wide vertical bands with no text.
 *
 * IES standards typically use 1-column layout for tables and 2-column layout
 * for body prose. Cover/title pages may also be 1-column. We never split into
 * more than 2 columns (rare in this corpus).
 *
 * Returns an array of [minX, maxX) ranges, ordered left-to-right.
 */
export function detectColumns(items, pageWidth) {
  const SINGLE_COLUMN = [[0, pageWidth + 1]];
  if (items.length < 30) return SINGLE_COLUMN; // not enough text to bother

  // Tables: many items at integer-aligned tab positions span the whole page.
  // Heuristic: if items occupy a wide X-range (>60% of page) AND there are
  // many distinct X-starts (>15), it's likely tabular — treat as single col.
  const xs = items.map(i => i.x);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const span = maxX - minX;
  const distinctStarts = new Set(xs.map(x => Math.round(x / 5))).size;
  if (span > pageWidth * 0.6 && distinctStarts > 25) {
    // Could still be 2-column; check for gap.
  }

  // Build a coverage map of X positions: for each item, mark every bucket
  // its full width [x, x+width] covers. A gap is a horizontal band where NO
  // item has any portion of its glyph run. Using starting-X alone misses
  // wide items that visually fill the gap.
  const BUCKET = 5;
  const nBuckets = Math.ceil(pageWidth / BUCKET) + 1;
  const covered = new Uint8Array(nBuckets);
  for (const item of items) {
    const xStart = item.x;
    // pdfjs items expose the visual width via item.width when present;
    // otherwise estimate from string length × fontSize × 0.5.
    const itemWidth = item.width || (item.str?.length || 0) * (item.fontSize || 10) * 0.5;
    const xEnd = xStart + itemWidth;
    const b0 = Math.max(0, Math.floor(xStart / BUCKET));
    const b1 = Math.min(nBuckets - 1, Math.ceil(xEnd / BUCKET));
    for (let i = b0; i <= b1; i++) covered[i] = 1;
  }

  // Find the longest uncovered run inside the central band of the page.
  // Restricting to the middle 60% avoids classifying outer-margin whitespace
  // (where a column simply ends short) as a column gap.
  const centerStartBucket = Math.floor((pageWidth * 0.25) / BUCKET);
  const centerEndBucket = Math.ceil((pageWidth * 0.75) / BUCKET);
  let bestRunStart = -1, bestRunLen = 0, curStart = -1, curLen = 0;
  for (let i = centerStartBucket; i < centerEndBucket; i++) {
    if (!covered[i]) {
      if (curStart < 0) curStart = i;
      curLen++;
      if (curLen > bestRunLen) { bestRunLen = curLen; bestRunStart = curStart; }
    } else {
      curStart = -1; curLen = 0;
    }
  }

  // The empty run must actually be flanked by content on both sides.
  if (bestRunLen <= 0) return SINGLE_COLUMN;
  let hasContentLeft = false, hasContentRight = false;
  for (let i = 0; i < bestRunStart; i++) if (covered[i]) { hasContentLeft = true; break; }
  for (let i = bestRunStart + bestRunLen; i < nBuckets; i++) if (covered[i]) { hasContentRight = true; break; }
  if (!hasContentLeft || !hasContentRight) return SINGLE_COLUMN;

  // A real column gap is at least 12pt wide and roughly centered. The 12pt
  // floor catches tight 2-column body layouts (RP-43-25 has ~15pt gutters)
  // while still rejecting accidental whitespace inside tables.
  const gapWidth = bestRunLen * BUCKET;
  if (gapWidth < 12) return SINGLE_COLUMN;

  const gapCenter = (bestRunStart + bestRunLen / 2) * BUCKET;
  const distFromCenter = Math.abs(gapCenter - pageWidth / 2);
  if (distFromCenter > pageWidth * 0.25) return SINGLE_COLUMN;

  // Sanity check: each side of the gap must hold a non-trivial share of items.
  const splitX = gapCenter;
  const leftCount = items.filter(i => i.x < splitX).length;
  const rightCount = items.length - leftCount;
  const minSide = Math.min(leftCount, rightCount);
  if (minSide < items.length * 0.2) return SINGLE_COLUMN;

  return [
    [0, splitX],
    [splitX, pageWidth + 1],
  ];
}

/**
 * Group items already sorted by (y, x) into lines (same Y within 3pt) and
 * apply header/footer stripping. Used per-column.
 */
export function groupItemsIntoLines(sortedItems, headerFooterSet) {
  if (sortedItems.length === 0) return [];

  const rawLines = [];
  let currentGroup = [sortedItems[0]];

  for (let i = 1; i < sortedItems.length; i++) {
    const item = sortedItems[i];
    const prevY = currentGroup[currentGroup.length - 1].y;
    if (Math.abs(item.y - prevY) <= 3) {
      currentGroup.push(item);
    } else {
      rawLines.push(currentGroup);
      currentGroup = [item];
    }
  }
  rawLines.push(currentGroup);

  const lines = [];
  for (const group of rawLines) {
    const lineText = joinItemsWithSpacing(group);
    if (!lineText) continue;
    if (headerFooterSet?.has(lineText.toLowerCase())) continue;

    const avgFontSize = group.reduce((s, i) => s + i.fontSize, 0) / group.length;
    const isBold = group.some(i => i.bold);
    lines.push({
      text: lineText,
      y: group[0].y,
      x: group[0].x,
      fontSize: avgFontSize,
      bold: isBold,
      marks: detectSuperscriptMarks(group),
    });
  }
  return lines;
}

/**
 * Superscript reference markers printed inside a line of body prose.
 *
 * IES standards cite their References section with a raised numeral: "…is
 * available in CIE 015:2018.⁶ The first five…". pdfjs returns that numeral as its
 * own text item — smaller font, baseline raised a few points — and
 * joinItemsWithSpacing then glues it into the line text ("2018.6"), which is
 * unrecoverable from the string alone. Capturing it here is what lets a
 * Reference result link to the place in the body where the work is cited, rather
 * than to the References page (client DO31.4).
 *
 * Two signals, both required, so a normal digit run is never mistaken for a
 * marker: the item is entirely digits (optionally comma-separated, "3,4"), and
 * it is BOTH visibly smaller than the line's dominant font AND raised above the
 * line's baseline.
 *
 * @returns {number[]} marker numbers in reading order (empty for most lines)
 */
export function detectSuperscriptMarks(group) {
  if (group.length < 2) return [];

  // Dominant font of the line = the size covering the most characters, so one
  // small item cannot drag the reference size down with it.
  const charsBySize = new Map();
  for (const item of group) {
    const size = Math.round(item.fontSize * 2) / 2; // 0.5pt buckets
    charsBySize.set(size, (charsBySize.get(size) || 0) + item.str.length);
  }
  let bodySize = 0, bestChars = -1;
  for (const [size, chars] of charsBySize) {
    if (chars > bestChars) { bestChars = chars; bodySize = size; }
  }
  if (!bodySize) return [];

  // Baseline of the line = the y shared by the body-size items.
  const baseItems = group.filter(i => Math.abs(i.fontSize - bodySize) <= 0.6);
  if (baseItems.length === 0) return [];
  const baselineY = baseItems.reduce((s, i) => s + i.y, 0) / baseItems.length;

  const marks = [];
  for (const item of group) {
    const str = item.str.trim();
    if (!/^\d{1,3}(?:\s*,\s*\d{1,3})*$/.test(str)) continue;
    if (item.fontSize > bodySize - 1.2) continue;   // not visibly smaller
    if (item.y >= baselineY - 0.8) continue;        // not raised (y grows downward)
    for (const part of str.split(/\s*,\s*/)) {
      const n = Number(part);
      if (n >= 1 && n <= 999) marks.push(n);
    }
  }
  return marks;
}

/**
 * Concatenate text items belonging to the same line, inserting a single
 * space whenever there is a horizontal gap between glyph runs.
 *
 * pdfjs returns text as discrete items (often one per word or even per
 * styled run) and does NOT include the inter-item whitespace. A naive
 * `items.join('')` produces strings like "Clientpreferences;socialsettings"
 * because pdfjs split "Client preferences" into two items at a font/style
 * boundary and dropped the original space.
 *
 * Heuristic: two items are considered "touching" (no space needed) only if
 * the next item starts within ~30% of the current item's font size from the
 * previous item's right edge. Anything wider was a real space in the PDF.
 */
export function joinItemsWithSpacing(items) {
  if (items.length === 0) return '';
  let out = items[0].str;
  for (let i = 1; i < items.length; i++) {
    const prev = items[i - 1];
    const cur = items[i];
    const prevWidth = prev.width || (prev.str.length * (prev.fontSize || 10) * 0.5);
    const prevEnd = prev.x + prevWidth;
    const gap = cur.x - prevEnd;
    const fs = cur.fontSize || prev.fontSize || 10;
    const needsSpace = gap > fs * 0.25 &&
      !/\s$/.test(out) &&
      !/^\s/.test(cur.str);
    out += (needsSpace ? ' ' : '') + cur.str;
  }
  return out.replace(/\s+/g, ' ').trim();
}
