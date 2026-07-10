#!/usr/bin/env node
/**
 * Lensy PDF Ingestion Script
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
 * Structure-aware: each PDF is classified as either
 *   • NEW_TABLE — landscape "Recommended Illuminance Criteria" grid (RP-43-25
 *     style prototypes). Full pipeline incl. structured application extraction.
 *   • STANDARD  — ordinary prose document (LP-/LS-/TM- series, older RPs).
 *     Ingested for semantic text search only; application extraction is skipped
 *     because these PDFs have no structured illuminance grid to parse.
 *
 * Deprecated standards: PDFs under a "Deprecated Standards" folder (or passed
 * with --status deprecated) are indexed for VERSION COMPARISON ONLY:
 *   - vectors go to the separate deprecated Vectorize index, never the main one
 *   - no application records are extracted (deprecated values must never be
 *     served as current guidance)
 *   - the raw PDF is stored under deprecated/ in R2
 *   - a file whose ID matches a CURRENT standard is skipped: a reaffirmed
 *     printing (e.g. LM-63-19 vs current LM-63-19R25) is the same edition,
 *     not a deprecated one
 *
 * Usage:
 *   node scripts/ingest-pdfs.js --file pdfs/RP-9-20.pdf --id RP-9-20
 *   node scripts/ingest-pdfs.js --dir pdfs/                  # batch all PDFs (recursive)
 *   node scripts/ingest-pdfs.js --dir "pdfs/Deprecated Standards"  # deprecated only
 *   node scripts/ingest-pdfs.js --applications-only          # re-embed D1 apps
 *
 * Options:
 *   --file <path>      Single PDF file to ingest
 *   --id <standardId>  Standard ID override (default: derived from filename)
 *   --dir <path>       Directory of PDFs to ingest in batch (recurses into
 *                      subfolders; the "Others" folder is always skipped)
 *   --status <current|deprecated>  Force ingestion status. Default: derived
 *                      from the file's path ("Deprecated Standards" folder)
 *   --applications-only  Re-embed all D1 application rows into Vectorize
 *   --new-table-only   In batch mode, ingest only PDFs detected as NEW_TABLE
 *   --force-structure <new_table|standard>  Override structure auto-detection
 *   --local            Target local wrangler dev (http://localhost:8787)
 *   --dry-run          Parse and chunk without sending to Worker
 *   --verbose          Print chunk details during processing
 *
 * Environment:
 *   LUCIUS_API_URL     Worker URL (default: http://localhost:8787)
 *   LUCIUS_API_SECRET  Optional shared secret for ingest endpoint auth
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'fs';
import { resolve, basename, extname, join, relative } from 'path';
import { execSync } from 'child_process';
import { parsePDFNode } from '../src/lib/pdf-parser.js';
import { extractIESTables, extractGeneralNotes } from '../src/lib/table-extractor.js';
import {
  extractApplicationsFromPages,
  reportExtractionQuality,
  detectNewTableStructure,
} from '../src/lib/applications-extractor.js';

// Directory names skipped during recursive batch ingestion. "Others" holds
// reference material (e.g. the IlluminanceTables schema doc), not standards.
const SKIP_DIRS = new Set(['Others']);

// Any path segment matching this marks a PDF as a deprecated standard.
const DEPRECATED_DIR_RE = /^deprecated( standards)?$/i;

// ─── Config ───────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

const CONFIG = {
  apiUrl: args.includes('--local')
    ? 'http://localhost:8787'
    : (process.env.LUCIUS_API_URL || 'http://localhost:8787'),
  apiSecret: process.env.LUCIUS_API_SECRET || null,
  dryRun: args.includes('--dry-run'),
  verbose: args.includes('--verbose'),
  newTableOnly: args.includes('--new-table-only'),
  forceStructure: (() => {
    const i = args.indexOf('--force-structure');
    if (i < 0) return null;
    const v = (args[i + 1] || '').toLowerCase();
    if (v !== 'new_table' && v !== 'standard') {
      throw new Error(`--force-structure expects "new_table" or "standard", got "${args[i + 1]}"`);
    }
    return v;
  })(),
  forceStatus: (() => {
    const i = args.indexOf('--status');
    if (i < 0) return null;
    const v = (args[i + 1] || '').toLowerCase();
    if (v !== 'current' && v !== 'deprecated') {
      throw new Error(`--status expects "current" or "deprecated", got "${args[i + 1]}"`);
    }
    return v;
  })(),
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
  console.log(`\nLensy — PDF Ingestion Pipeline`);
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
    return ingestFile(filePath, standardId, statusForPath(filePath));
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

  // Current standards first, then deprecated — so the current-ID set is
  // complete before any deprecated file is checked against it.
  const files = collectPdfs(dirPath).sort(
    (a, b) => (statusForPath(a) === 'deprecated') - (statusForPath(b) === 'deprecated') || a.localeCompare(b)
  );

  console.log(`Found ${files.length} PDF(s) under ${dirPath} (excluding: ${[...SKIP_DIRS].join(', ')})\n`);

  // IDs of current standards seen in this batch. A deprecated file whose ID
  // matches one of these is a reaffirmed printing of the SAME edition, not a
  // prior edition — ingesting it would overwrite the active standard. The
  // Worker enforces the same rule against D1 for files outside this batch.
  const currentIds = new Set(
    files.filter(f => statusForPath(f) !== 'deprecated')
         .map(f => deriveStandardId(basename(f)))
  );
  const ingestedDeprecated = new Set();

  let success = 0;
  let failed = 0;
  const byStructure = { new_table: 0, standard: 0, skipped: 0 };

  for (const filePath of files) {
    const standardId = deriveStandardId(basename(filePath));
    const status = statusForPath(filePath);
    const label = relative(dirPath, filePath);

    if (status === 'deprecated') {
      if (currentIds.has(standardId)) {
        console.log(`\n[${standardId}] ${label}`);
        console.log('  ↷ Skipped: same edition as a CURRENT standard (reaffirmed printing).');
        byStructure.skipped++;
        continue;
      }
      if (ingestedDeprecated.has(standardId)) {
        console.log(`\n[${standardId}] ${label}`);
        console.log('  ↷ Skipped: duplicate copy of an already-ingested deprecated edition.');
        byStructure.skipped++;
        continue;
      }
    }

    try {
      const result = await ingestFile(filePath, standardId, status);
      if (result?.skipped) byStructure.skipped++;
      else if (result?.structure) byStructure[result.structure]++;
      if (status === 'deprecated' && !result?.skipped) ingestedDeprecated.add(standardId);
      success++;
    } catch (err) {
      console.error(`  ✗ ${label} (${standardId}): ${err.message}`);
      failed++;
    }
  }

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`Batch complete: ${success} processed, ${failed} failed.`);
  console.log(`  NEW_TABLE: ${byStructure.new_table}   STANDARD: ${byStructure.standard}   skipped: ${byStructure.skipped}`);
  if (ingestedDeprecated.size > 0) console.log(`  Deprecated standards indexed: ${ingestedDeprecated.size}`);
  console.log('');
}

/**
 * Ingestion status for a PDF: 'deprecated' when any path segment is a
 * "Deprecated Standards" folder, else 'current'. --status overrides.
 */
function statusForPath(filePath) {
  if (CONFIG.forceStatus) return CONFIG.forceStatus;
  const segments = resolve(filePath).split(/[\\/]/);
  return segments.some(s => DEPRECATED_DIR_RE.test(s)) ? 'deprecated' : 'current';
}

/**
 * Recursively collect .pdf paths under dirPath, skipping any directory whose
 * name is in SKIP_DIRS (e.g. "Others" — reference material, not standards).
 */
function collectPdfs(dirPath) {
  const out = [];
  for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
    const full = join(dirPath, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) {
        console.log(`  ↷ Skipping directory: ${entry.name}/`);
        continue;
      }
      out.push(...collectPdfs(full));
    } else if (extname(entry.name).toLowerCase() === '.pdf') {
      out.push(full);
    }
  }
  return out;
}

// ─── Single File Ingestion ────────────────────────────────────────────────────

async function ingestFile(filePath, standardId, status = 'current') {
  const isDeprecated = status === 'deprecated';
  console.log(`\n[${standardId}] ${filePath}${isDeprecated ? '  (DEPRECATED)' : ''}`);

  if (!existsSync(filePath)) throw new Error(`File not found: ${filePath}`);

  // Deprecated standards never carry the NEW_TABLE pipeline — in
  // --new-table-only mode they are out of scope before parsing.
  if (CONFIG.newTableOnly && isDeprecated) {
    console.log('  ↷ Skipped (--new-table-only): deprecated standards are text-only.');
    return { skipped: true, structure: 'standard' };
  }

  const pdfBytes = new Uint8Array(readFileSync(filePath));
  console.log(`  File size: ${(pdfBytes.length / 1024).toFixed(0)} KB`);

  // Deprecated PDFs live under a separate R2 prefix so they can never be
  // served from the standards/ namespace (e.g. by a future external API).
  const r2Key = `${isDeprecated ? 'deprecated' : 'standards'}/${standardId}.pdf`;

  // Step 1: Upload raw PDF to R2 (non-fatal if it fails)
  if (!CONFIG.dryRun) {
    uploadToR2(filePath, r2Key);
  } else {
    console.log('  [DRY RUN] Skipping R2 upload');
  }

  // Step 2: Parse PDF in Node.js using pdfjs-dist
  console.log('  Parsing PDF...');
  const { metadata, pages } = await parsePDFNode(pdfBytes);
  console.log(`  Pages: ${pages.length}, Title: "${metadata.title || '(none)'}"`);

  // Step 2b: Classify the document structure. NEW_TABLE PDFs carry the
  // landscape "Recommended Illuminance Criteria" grid the application extractor
  // was built for; STANDARD PDFs are ordinary prose and have no such grid.
  const detection = detectNewTableStructure(pages);
  // Deprecated docs are always ingested as prose (STANDARD): their
  // illuminance values must never become structured application records.
  const structure = isDeprecated
    ? 'standard'
    : CONFIG.forceStructure
      ? CONFIG.forceStructure
      : (detection.isNewTable ? 'new_table' : 'standard');
  const isNewTable = structure === 'new_table';
  console.log(
    `  Structure: ${structure.toUpperCase()}` +
    `${CONFIG.forceStructure ? ' (forced)' : ''}` +
    ` (rows=${detection.rowHits}, criteriaPages=${detection.criteriaPages})`
  );

  // In --new-table-only batch mode, skip prose standards entirely.
  if (CONFIG.newTableOnly && !isNewTable) {
    console.log('  ↷ Skipped (--new-table-only): not a NEW_TABLE document.');
    return { skipped: true, structure };
  }

  // Step 3: Extract IES illuminance tables
  console.log('  Extracting tables...');
  const tables = extractIESTables(pages);
  console.log(`  Tables found: ${tables.length}`);

  // Step 4: Extract structured application records — NEW_TABLE only.
  // Running the extractor over prose standards yields only incidental,
  // low-quality rows that would pollute D1, so we skip it for STANDARD docs.
  // Those PDFs are still fully indexed for semantic text search below.
  const standardMeta = {
    fullDesignation: inferFullDesignation(standardId, metadata.title),
    year: metadata.year,
    author: metadata.author,
  };
  let applications = [];
  if (isNewTable) {
    console.log('  Extracting application records...');
    applications = extractApplicationsFromPages(pages, standardId, standardMeta);
    console.log(`  Applications extracted: ${applications.length}`);

    // Show quality report in verbose mode
    if (CONFIG.verbose && applications.length > 0) {
      const quality = reportExtractionQuality(applications);
      console.log(`  Quality score: ${quality.qualityScore}% have horizontal lux values`);
      for (const w of quality.warnings) console.log(`  ⚠ ${w}`);
    }
  } else {
    console.log('  Application extraction skipped (STANDARD structure — text-only ingest).');
  }

  // Step 4b: Extract standalone "General Notes" / Annex A blocks as citable chunks
  const generalNotes = extractGeneralNotes(pages);
  if (generalNotes.length > 0) {
    console.log(`  General Notes blocks: ${generalNotes.length}`);
  }

  // Step 5: Chunk text with IES section awareness
  console.log('  Chunking text...');
  const textChunks = chunkIESDocument(pages);

  // Promote General Notes blocks into dedicated chunks tagged 'general_notes'
  // so the search layer can rank them as authoritative governing-criteria text.
  const noteChunks = generalNotes.map((n) => ({
    text: `[${n.heading}]\n${n.text}`,
    pageNumber: n.pageNumber,
    section: n.heading.replace(/[:.].*/, '').trim(),
    type: 'general_notes',
    wordCount: n.text.split(/\s+/).length,
  }));

  const chunks = [...textChunks, ...noteChunks];
  console.log(`  Chunks: ${chunks.length} (${textChunks.length} text, ${noteChunks.length} general-notes)`);

  if (CONFIG.verbose) {
    for (const [i, chunk] of chunks.entries()) {
      const preview = chunk.text.substring(0, 70).replace(/\n/g, ' ');
      console.log(`    [${i}] p.${chunk.pageNumber} §${chunk.section || '?'} (${chunk.wordCount}w) "${preview}..."`);
    }
  }

  if (CONFIG.dryRun) {
    console.log(`  [DRY RUN] Would send: ${chunks.length} chunks, ${tables.length} tables, ${applications.length} applications`);
    return { structure };
  }

  // Step 6: POST chunks + metadata to Worker (embedding + indexing + D1 standards row)
  console.log('  Sending to Worker for embedding + indexing...');
  const result = await postToWorker('/api/ingest', {
    standardId,
    structure,
    status,
    metadata: {
      title: metadata.title,
      author: metadata.author,
      subject: metadata.subject,
      year: metadata.year,
      fullDesignation: standardMeta.fullDesignation,
    },
    chunks,
    tables,
    applications: [],  // sent separately below to avoid request size limits
    r2Key,
  });

  // Step 7: POST applications in small batches (avoid D1 variable limits)
  let applicationsUpserted = 0;
  if (applications.length > 0) {
    const APP_BATCH = 20;
    for (let i = 0; i < applications.length; i += APP_BATCH) {
      const batch = applications.slice(i, i + APP_BATCH);
      const appResult = await postToWorker('/api/ingest', {
        standardId,
        metadata: {},
        chunks: [],          // skip re-embedding — only upsert apps
        tables: [],
        applications: batch,
        r2Key: null,
      });
      applicationsUpserted += appResult.applicationsUpserted || 0;
    }
  }

  console.log(`  ✓ ${result.chunksIndexed} chunks indexed, ${result.tablesFound} tables stored, ${applicationsUpserted} application records upserted`);
  return { structure };
}

// ─── R2 Upload ────────────────────────────────────────────────────────────────

function uploadToR2(filePath, r2Key) {
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

/**
 * Derive a clean IES standard ID from a (prototype) filename, e.g.
 *   "RP-43-25_v7_Prototype_260420-NEW_TABLE.pdf" → "RP-43-25"
 *   "RP-3-20+E1 Prototype_260519-NEW_TABLE.pdf"  → "RP-3-20+E1"
 *   "RP-8-25 + E2_v1 260527-NEW_TABLE.pdf"       → "RP-8-25+E2"
 *   "RP-27.1-22.pdf"                              → "RP-27.1-22"
 *
 * The errata suffix ("+E1"/"+E2") is preserved (with surrounding spaces
 * normalized away) so an errata revision never collides with its base — e.g.
 * "RP-8-25 + E1_Full" (STANDARD) and "RP-8-25 + E2 …NEW_TABLE" stay distinct.
 * Falls back to the first whitespace/underscore token if no match.
 */
function deriveStandardId(file) {
  const stem = basename(file, extname(file));
  const m = stem.match(/^([A-Z]{1,3}-\d+(?:\.\d+)?(?:-\d+)?)\s*(?:\+\s*(E\d+))?/i);
  if (!m) return stem.split(/[_ ]/)[0];
  return m[2] ? `${m[1]}+${m[2]}` : m[1];
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
