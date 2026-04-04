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
 * - Multi-column layouts: items are sorted by Y then X
 * - Font size / bold detection for section heading identification
 * - Header/footer stripping
 */
function buildPageContent(items, viewport, headerFooterSet) {
  if (!items || items.length === 0) return { text: '', lines: [] };

  const pageHeight = viewport[3];

  // Parse and normalize each text item
  const parsed = items
    .filter(item => item.str && item.str.trim().length > 0)
    .map(item => {
      const x = item.transform[4];
      const y = pageHeight - item.transform[5]; // flip to top-left origin
      const fontSize = Math.abs(item.transform[3]) || Math.abs(item.transform[0]) || 10;
      // Bold detection: many PDFs encode bold in the font name
      const fontName = (item.fontName || '').toLowerCase();
      const bold = fontName.includes('bold') || fontName.includes('black') ||
                   fontName.includes('heavy') || fontSize > 14;
      return { str: item.str, x, y, fontSize, bold, hasEOL: item.hasEOL };
    })
    .sort((a, b) => {
      // Sort top-to-bottom, then left-to-right
      const yDiff = a.y - b.y;
      if (Math.abs(yDiff) > 3) return yDiff;
      return a.x - b.x;
    });

  if (parsed.length === 0) return { text: '', lines: [] };

  // Group into lines (items within 3pt of same Y = same line)
  const rawLines = [];
  let currentGroup = [parsed[0]];

  for (let i = 1; i < parsed.length; i++) {
    const item = parsed[i];
    const prevY = currentGroup[currentGroup.length - 1].y;
    if (Math.abs(item.y - prevY) <= 3) {
      currentGroup.push(item);
    } else {
      rawLines.push(currentGroup);
      currentGroup = [item];
    }
  }
  rawLines.push(currentGroup);

  // Build structured line objects; filter header/footer
  const lines = [];
  for (const group of rawLines) {
    const lineText = group.map(i => i.str).join('').replace(/\s+/g, ' ').trim();
    if (!lineText) continue;
    if (headerFooterSet?.has(lineText.toLowerCase())) continue; // strip repeated header/footer

    const avgFontSize = group.reduce((s, i) => s + i.fontSize, 0) / group.length;
    const isBold = group.some(i => i.bold);
    const y = group[0].y;
    const x = group[0].x;

    lines.push({ text: lineText, y, x, fontSize: avgFontSize, bold: isBold });
  }

  const text = lines.map(l => l.text).join('\n');
  return { text, lines };
}

// ─── pdfjs-dist Loader ────────────────────────────────────────────────────────

async function loadPdfjs() {
  // Try ESM build first (pdfjs-dist ≥ 4.x)
  try {
    const mod = await import('pdfjs-dist/legacy/build/pdf.mjs');
    if (mod.GlobalWorkerOptions) mod.GlobalWorkerOptions.workerSrc = '';
    return mod;
  } catch { /* fall through */ }

  // Fallback: CommonJS build
  try {
    const require = createRequire(import.meta.url);
    const mod = require('pdfjs-dist/legacy/build/pdf.js');
    if (mod.GlobalWorkerOptions) mod.GlobalWorkerOptions.workerSrc = '';
    return mod;
  } catch (err) {
    throw new Error(
      'pdfjs-dist not found. Run `npm install` first.\n' + err.message
    );
  }
}
