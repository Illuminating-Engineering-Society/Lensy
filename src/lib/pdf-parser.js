/**
 * PDF Parser — Node.js only
 *
 * This module uses pdfjs-dist and is intended for use in Node.js scripts
 * (scripts/ingest-pdfs.js). Do NOT import this inside a Cloudflare Worker.
 *
 * Exports:
 *   parsePDFNode(pdfBytes)  → { metadata, pages }
 *
 * Each page in `pages` has:
 *   { number, text, lines, width, height }
 *
 * Each line in `lines` has:
 *   { text, y, fontSize, bold, x }
 *
 * IES-specific notes:
 *   - IES standards often use multi-column layout in body text
 *   - Table pages have dense tabular data with aligned columns
 *   - Section headings are typically larger font and/or bold
 *   - Page headers/footers repeat on every page and should be filtered
 */

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Parse a PDF buffer into metadata and structured page data.
 * @param {Buffer|ArrayBuffer|Uint8Array} pdfBytes
 * @returns {Promise<{ metadata: Object, pages: Array }>}
 */
export async function parsePDFNode(pdfBytes) {
  const pdfjsLib = await loadPdfjs();

  const uint8 = pdfBytes instanceof Uint8Array
    ? pdfBytes
    : new Uint8Array(pdfBytes instanceof ArrayBuffer ? pdfBytes : pdfBytes.buffer);

  const loadingTask = pdfjsLib.getDocument({
    data: uint8,
    useWorkerFetch: false,
    isEvalSupported: false,
    useSystemFonts: true,
    disableFontFace: true,
    verbosity: 0,  // suppress pdfjs console output
  });

  const pdf = await loadingTask.promise;

  const metadata = await extractMetadata(pdf);
  const pageCount = pdf.numPages;

  // Identify repeating header/footer text (appears on 3+ pages at same Y position)
  const headerFooterCandidates = await detectHeadersFooters(pdf, pageCount);

  const pages = [];
  for (let pageNum = 1; pageNum <= pageCount; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const textContent = await page.getTextContent({ includeMarkedContent: false });
    const viewport = page.view; // [x, y, width, height]

    const { text, lines } = buildPageContent(
      textContent.items,
      viewport,
      headerFooterCandidates
    );

    pages.push({
      number: pageNum,
      text,
      lines,
      width: viewport[2],
      height: viewport[3],
    });
  }

  return { metadata, pages };
}

// ─── Metadata Extraction ──────────────────────────────────────────────────────

async function extractMetadata(pdf) {
  try {
    const meta = await pdf.getMetadata();
    const info = meta.info || {};
    return {
      title: cleanMetaString(info.Title),
      author: cleanMetaString(info.Author),
      subject: cleanMetaString(info.Subject),
      keywords: cleanMetaString(info.Keywords),
      year: extractYear(info.CreationDate || info.ModDate),
    };
  } catch {
    return { title: '', author: '', subject: '', keywords: '', year: null };
  }
}

function cleanMetaString(val) {
  if (!val) return '';
  return String(val).replace(/[\x00-\x1F\x7F]/g, '').trim();
}

function extractYear(dateStr) {
  if (!dateStr) return null;
  // PDF date format: D:YYYYMMDDHHmmSS or plain YYYY
  const match = String(dateStr).match(/(?:D:)?(\d{4})/);
  return match ? match[1] : null;
}

// ─── Header/Footer Detection ──────────────────────────────────────────────────
// IES standards have repeated page headers like "ANSI/IES RP-9-20" and
// footers like "© 2020 IES" on every page. Detect and strip these.

async function detectHeadersFooters(pdf, pageCount) {
  const samplePages = Math.min(5, pageCount);
  const textByYBucket = new Map(); // Map<yBucket, Set<string>>

  for (let pageNum = 1; pageNum <= samplePages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const content = await page.getTextContent({ includeMarkedContent: false });
    const viewport = page.view;
    const pageHeight = viewport[3];

    for (const item of content.items) {
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
function buildPageContent(items, viewport, headerFooterSet) {
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
function detectColumns(items, pageWidth) {
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
function groupItemsIntoLines(sortedItems, headerFooterSet) {
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
    });
  }
  return lines;
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
function joinItemsWithSpacing(items) {
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

// ─── pdfjs-dist Loader ────────────────────────────────────────────────────────

async function loadPdfjs() {
  // pdfjs-dist v4: disable web worker (not available in Node.js)
  try {
    const mod = await import('pdfjs-dist/legacy/build/pdf.mjs');
    if (mod.GlobalWorkerOptions) {
      // Empty string triggers the "no workerSrc" error; use a non-worker path instead
      mod.GlobalWorkerOptions.workerSrc = new URL(
        '../../node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs',
        import.meta.url
      ).href;
    }
    return mod;
  } catch { /* fall through */ }

  // Fallback: CommonJS build
  try {
    const require = createRequire(import.meta.url);
    const mod = require('pdfjs-dist/legacy/build/pdf.js');
    if (mod.GlobalWorkerOptions) mod.GlobalWorkerOptions.workerSrc = false;
    return mod;
  } catch (err) {
    throw new Error(
      'pdfjs-dist not found. Run `npm install` first.\n' + err.message
    );
  }
}
