/**
 * PDF Parser — Node.js only
 *
 * This module uses pdfjs-dist and is intended for use in Node.js scripts
 * (scripts/ingest-pdfs.js). Do NOT import this inside a Cloudflare Worker.
 *
 * Everything downstream of pdfjs's raw text items — line building, column
 * detection, superscript marks, metadata cleanup — lives in the runtime-
 * agnostic src/lib/pdf-pages.js, shared with the staff-dashboard ingest
 * (src/workers/staff-ingest.ts), where the staff BROWSER runs pdfjs and the
 * Worker rebuilds pages with the very same functions. Only the pdfjs loader
 * and the page loop are Node-bound, and only they live here.
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
import {
  buildPageFromRaw,
  cleanDocMeta,
  detectHeadersFootersFromRaw,
} from './pdf-pages.js';

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

  // Identify repeating header/footer text (appears on 3+ pages at same Y
  // position). Sampled from the first pages only, so this pass stays cheap.
  const samples = [];
  for (let pageNum = 1; pageNum <= Math.min(5, pageCount); pageNum++) {
    samples.push(await rawPage(pdf, pageNum));
  }
  const headerFooterCandidates = detectHeadersFootersFromRaw(samples);

  // Build pages one at a time (pdfjs caches getPage, so re-requesting the
  // sampled pages costs nothing) — raw items for the whole document are never
  // held at once, which matters for the 500 MB outliers in this corpus.
  const pages = [];
  for (let pageNum = 1; pageNum <= pageCount; pageNum++) {
    pages.push(buildPageFromRaw(await rawPage(pdf, pageNum), headerFooterCandidates));
  }

  return { metadata, pages };
}

/** One page in the raw shape src/lib/pdf-pages.js consumes. */
async function rawPage(pdf, pageNum) {
  const page = await pdf.getPage(pageNum);
  const textContent = await page.getTextContent({ includeMarkedContent: false });
  return { number: pageNum, view: page.view, items: textContent.items };
}

// ─── Metadata Extraction ──────────────────────────────────────────────────────

async function extractMetadata(pdf) {
  try {
    const meta = await pdf.getMetadata();
    return cleanDocMeta(meta.info);
  } catch {
    return cleanDocMeta(null);
  }
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
