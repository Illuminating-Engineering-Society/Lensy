#!/usr/bin/env node
/**
 * Lucius PDF Ingestion Script
 * Runs in Node.js. Parses IES standard PDFs and sends pre-parsed data
 * to the Cloudflare Worker for embedding + indexing.
 *
 * Architecture:
 *   Node.js (this script)                Cloudflare Worker
 *   ─────────────────────                ────────────────────────────
 *   1. Read PDF from disk
 *   2. Upload raw PDF → R2 (via wrangler)
 *   3. Parse with pdfjs-dist
 *   4. Extract text + metadata
 *   5. Detect IES tables
 *   6. Chunk text (section-aware)
 *   7. POST chunks + metadata  ──────►  8. Embed via Workers AI
 *                                        9. Upsert into Vectorize
 *                                       10. Store metadata in D1
 *
 * Usage:
 *   node scripts/ingest-pdfs.js --file pdfs/RP-9-20.pdf --id RP-9-20
 *   node scripts/ingest-pdfs.js --dir pdfs/                  # batch all PDFs
 *   node scripts/ingest-pdfs.js --applications-only          # re-embed D1 apps
 *
 * Options:
 *   --file <path>      Single PDF file to ingest
 *   --id <standardId>  Standard ID override (default: filename without .pdf)
 *   --dir <path>       Directory of PDFs to ingest in batch
 *   --applications-only  Re-embed all D1 application rows into Vectorize
 *   --local            Target local wrangler dev (http://localhost:8787)
 *   --dry-run          Parse and chunk without sending to Worker
 *   --verbose          Print chunk details during processing
 *
 * Environment:
 *   LUCIUS_API_URL     Worker URL (default: http://localhost:8787)
 *   LUCIUS_API_SECRET  Optional shared secret for ingest endpoint auth
 */

import { readFileSync, readdirSync, existsSync } from 'fs';
import { resolve, basename, extname } from 'path';
import { execSync } from 'child_process';
import { parsePDFNode } from '../src/lib/pdf-parser.js';
import { extractIESTables } from '../src/lib/table-extractor.js';

// ─── Config ───────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

const CONFIG = {
  apiUrl: args.includes('--local')
    ? 'http://localhost:8787'
    : (process.env.LUCIUS_API_URL || 'http://localhost:8787'),
  apiSecret: process.env.LUCIUS_API_SECRET || null,
  dryRun: args.includes('--dry-run'),
  verbose: args.includes('--verbose'),
  // Chunking parameters
  chunkTargetWords: 350,   // ~500 tokens at 1.4 words/token
  chunkOverlapWords: 40,   // overlap between adjacent chunks for context continuity
  minChunkWords: 30,       // discard chunks shorter than this
};

const fileArg = args.indexOf('--file');
const dirArg = args.indexOf('--dir');
const idArg = args.indexOf('--id');

// ─── Entry Point ──────────────────────────────────────────────────────────────

async function main() {
  console.log(`\nLucius — PDF Ingestion Pipeline`);
  console.log(`${'─'.repeat(50)}`);
  console.log(`Target: ${CONFIG.apiUrl}`);
  console.log(`Mode:   ${CONFIG.dryRun ? 'DRY RUN (no network calls)' : 'Live'}\n`);

  if (args.includes('--applications-only')) {
    return reindexApplications();
  }

  if (dirArg >= 0) {
    return ingestDirectory(resolve(process.cwd(), args[dirArg + 1]));
  }

  if (fileArg >= 0) {
    const filePath = resolve(process.cwd(), args[fileArg + 1]);
    const standardId = idArg >= 0 ? args[idArg + 1] : basename(filePath, '.pdf');
    return ingestFile(filePath, standardId);
  }

  console.log('Usage:');
  console.log('  node scripts/ingest-pdfs.js --file pdfs/RP-9-20.pdf --id RP-9-20');
  console.log('  node scripts/ingest-pdfs.js --dir pdfs/');
  console.log('  node scripts/ingest-pdfs.js --applications-only');
  process.exit(1);
}

// ─── Batch Directory Ingestion ────────────────────────────────────────────────

async function ingestDirectory(dirPath) {
  if (!existsSync(dirPath)) throw new Error(`Directory not found: ${dirPath}`);

  const files = readdirSync(dirPath)
    .filter(f => extname(f).toLowerCase() === '.pdf')
    .sort();

  console.log(`Found ${files.length} PDF(s) in ${dirPath}\n`);

  let success = 0;
  let failed = 0;

  for (const file of files) {
    const filePath = resolve(dirPath, file);
    const standardId = basename(file, '.pdf');
    try {
      await ingestFile(filePath, standardId);
      success++;
    } catch (err) {
      console.error(`  ✗ ${standardId}: ${err.message}`);
      failed++;
    }
  }

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`Batch complete: ${success} succeeded, ${failed} failed.\n`);
}

// ─── Single File Ingestion ────────────────────────────────────────────────────

async function ingestFile(filePath, standardId) {
  console.log(`\n[${standardId}] ${filePath}`);

  if (!existsSync(filePath)) throw new Error(`File not found: ${filePath}`);

  const pdfBytes = readFileSync(filePath);
  console.log(`  File size: ${(pdfBytes.length / 1024).toFixed(0)} KB`);

  // Step 1: Upload raw PDF to R2 (non-fatal if it fails)
  if (!CONFIG.dryRun) {
    uploadToR2(filePath, standardId);
  } else {
    console.log('  [DRY RUN] Skipping R2 upload');
  }

  // Step 2: Parse PDF in Node.js using pdfjs-dist
  console.log('  Parsing PDF...');
  const { metadata, pages } = await parsePDFNode(pdfBytes);
  console.log(`  Pages: ${pages.length}, Title: "${metadata.title || '(none)'}"`);

  // Step 3: Extract IES illuminance tables
  console.log('  Extracting tables...');
  const tables = extractIESTables(pages);
  console.log(`  Tables found: ${tables.length}`);

  // Step 4: Chunk text with IES section awareness
  console.log('  Chunking text...');
  const chunks = chunkIESDocument(pages);
  console.log(`  Chunks: ${chunks.length}`);

  if (CONFIG.verbose) {
    for (const [i, chunk] of chunks.entries()) {
      const preview = chunk.text.substring(0, 70).replace(/\n/g, ' ');
      console.log(`    [${i}] p.${chunk.pageNumber} §${chunk.section || '?'} (${chunk.wordCount}w) "${preview}..."`);
    }
  }

  if (CONFIG.dryRun) {
    console.log(`  [DRY RUN] Would send: ${chunks.length} chunks, ${tables.length} tables`);
    return;
  }

  // Step 5: POST pre-parsed data to Worker for embedding + indexing
  console.log('  Sending to Worker for embedding...');
  const result = await postToWorker('/api/ingest', {
    standardId,
    metadata: {
      title: metadata.title,
      author: metadata.author,
      subject: metadata.subject,
      year: metadata.year,
      fullDesignation: inferFullDesignation(standardId, metadata.title),
    },
    chunks,
    tables,
    r2Key: `standards/${standardId}.pdf`,
  });

  console.log(`  ✓ ${result.chunksIndexed} chunks indexed, ${result.tablesFound} tables stored`);
}

// ─── R2 Upload ────────────────────────────────────────────────────────────────

function uploadToR2(filePath, standardId) {
  const r2Key = `standards/${standardId}.pdf`;
  console.log(`  Uploading to R2: ${r2Key}`);
  try {
    execSync(
      `wrangler r2 object put ies-standards-pdfs/${r2Key} --file="${filePath}"`,
      { stdio: 'pipe' }
    );
    console.log('  R2 upload complete.');
  } catch (err) {
    // Non-fatal: embedding proceeds even if R2 upload fails
    console.warn(`  ⚠ R2 upload failed (non-fatal): ${err.message.slice(0, 100)}`);
  }
}

// ─── IES Section-Aware Chunking ───────────────────────────────────────────────

/**
 * Split document pages into semantically coherent chunks.
 *
 * Strategy:
 *  1. Walk pages line-by-line, tracking current IES section number
 *  2. Start a new chunk at each section heading
 *  3. If a chunk exceeds chunkTargetWords, flush with overlap carry-over
 *  4. Prepend "[Section X.X]" to each continuation chunk for context
 *  5. Tag table page chunks as type='table' for search ranking
 */
function chunkIESDocument(pages) {
  const SECTION_RE = /^(?:(?:\d+(?:\.\d+)*)|(?:[A-Z](?:\.\d+)*))\s+[A-Z].{3,}/;
  const ANNEX_RE = /^(?:Annex|Appendix)\s+[A-Z]/i;
  const TABLE_PAGE_RE = /^Table\s+[A-Z0-9]-?\d*/im;

  const chunks = [];
  let currentSection = null;
  let buffer = [];
  let bufferPage = null;
  let bufferWordCount = 0;

  function flushBuffer(type = 'text') {
    if (buffer.length === 0) return;
    const text = buffer.join('\n').trim();
    const wordCount = text.split(/\s+/).filter(Boolean).length;
    if (wordCount >= CONFIG.minChunkWords) {
      chunks.push({ text, pageNumber: bufferPage, section: currentSection, type, wordCount });
    }
    buffer = [];
    bufferWordCount = 0;
  }

  for (const page of pages) {
    const lines = page.lines
      ? page.lines.map(l => ({ text: l.text, fontSize: l.fontSize || 10 }))
      : page.text.split('\n').map(t => ({ text: t, fontSize: 10 }));

    const isTablePage = TABLE_PAGE_RE.test(page.text) ||
      lines.filter(l => /\d+\s+\d+/.test(l.text)).length > lines.length * 0.25;

    for (const line of lines) {
      const lineText = line.text.trim();
      if (!lineText) continue;

      // Detect IES section heading → flush current chunk, start new
      const isSectionHeading = SECTION_RE.test(lineText) || ANNEX_RE.test(lineText);
      if (isSectionHeading && lineText.length > 5) {
        flushBuffer(isTablePage ? 'table' : 'text');
        const secMatch = lineText.match(/^(\d+(?:\.\d+)*|[A-Z](?:\.\d+)*)/);
        currentSection = secMatch ? secMatch[1] : (ANNEX_RE.test(lineText) ? 'Annex' : null);
        bufferPage = bufferPage || page.number;
      }

      if (bufferPage === null) bufferPage = page.number;
      buffer.push(lineText);
      bufferWordCount += lineText.split(/\s+/).length;

      // Flush when chunk is full
      if (bufferWordCount >= CONFIG.chunkTargetWords) {
        flushBuffer(isTablePage ? 'table' : 'text');

        // Carry overlap into next chunk with section context prefix
        const overlapLines = getOverlapLines(buffer, CONFIG.chunkOverlapWords);
        buffer = currentSection
          ? [`[Section ${currentSection}]`, ...overlapLines]
          : overlapLines;
        bufferWordCount = buffer.join(' ').split(/\s+/).length;
        bufferPage = page.number;
      }
    }

    // Flush at page boundary if significantly buffered
    if (bufferPage !== page.number && bufferWordCount > CONFIG.minChunkWords) {
      flushBuffer(isTablePage ? 'table' : 'text');
      bufferPage = page.number;
    }
  }

  flushBuffer();

  // Split any remaining oversized chunks
  const finalChunks = [];
  for (const chunk of chunks) {
    if (chunk.wordCount > CONFIG.chunkTargetWords * 2) {
      finalChunks.push(...splitLargeChunk(chunk));
    } else {
      finalChunks.push(chunk);
    }
  }

  return finalChunks;
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

function splitLargeChunk(chunk) {
  const words = chunk.text.split(/\s+/);
  const step = CONFIG.chunkTargetWords - CONFIG.chunkOverlapWords;
  const subChunks = [];

  for (let i = 0; i < words.length; i += step) {
    const sliceWords = words.slice(i, i + CONFIG.chunkTargetWords);
    if (sliceWords.length < CONFIG.minChunkWords) break;
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

// ─── Applications Re-index ────────────────────────────────────────────────────

async function reindexApplications() {
  console.log('Re-indexing all application rows from D1 into Vectorize...\n');

  if (CONFIG.dryRun) {
    console.log('[DRY RUN] Would POST to /api/ingest/applications');
    return;
  }

  const result = await postToWorker('/api/ingest/applications', {});
  console.log(`✓ ${result.applicationsIndexed} applications indexed into Vectorize.\n`);
}

// ─── Utilities ────────────────────────────────────────────────────────────────

async function postToWorker(path, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (CONFIG.apiSecret) headers['Authorization'] = `Bearer ${CONFIG.apiSecret}`;

  const response = await fetch(`${CONFIG.apiUrl}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '(no body)');
    throw new Error(`Worker returned ${response.status}: ${text.slice(0, 300)}`);
  }

  return response.json();
}

function inferFullDesignation(standardId, title) {
  if (standardId.startsWith('ANSI/IES')) return standardId;
  if (/^(RP|TM|HB)-/.test(standardId)) return `ANSI/IES ${standardId}`;
  const match = title?.match(/ANSI\/IES\s+[\w-]+/);
  return match ? match[0] : standardId;
}

// ─── Run ──────────────────────────────────────────────────────────────────────

main().catch(err => {
  console.error(`\n✗ Fatal error: ${err.message}`);
  if (CONFIG.verbose) console.error(err.stack);
  process.exit(1);
});
