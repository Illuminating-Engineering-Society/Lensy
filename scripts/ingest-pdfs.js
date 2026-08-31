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
 *   node scripts/ingest-pdfs.js --sweep-r2-only              # report R2 orphans
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
 *   --no-prune         Keep application rows this parse no longer produces
 *                      (default is to delete them — see Step 7b)
 *   --sweep-r2-only    Compare R2 against D1 and report orphaned PDFs, nothing
 *                      else. Combine with --sweep-r2 to delete them.
 *   --sweep-r2         Actually delete the R2 objects the sweep reports
 *                      (off by default: a removed PDF is not recoverable here)
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
import { chunkIESDocument, extractOutline } from '../src/lib/chunker.js';
import { extractDocumentAssets } from '../src/lib/document-assets.js';
import { extractCoverMetadata, extractCoverCommittee } from '../src/lib/cover-title.js';
import { extractReferenceMarkers } from '../src/lib/reference-markers.js';
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
  // Skip the post-ingest prune of application rows a parse no longer produces.
  // Escape hatch only — leaving stale rows in D1 is what makes an extractor
  // change surface old data in search (see Step 7b).
  skipPrune: args.includes('--no-prune'),
  // Actually delete the R2 objects the end-of-batch sweep reports. Off by
  // default: a raw PDF removed from R2 cannot be recovered from Lensy, so the
  // report is meant to be read first.
  sweepR2: args.includes('--sweep-r2'),
  // Chunking parameters. These MIRROR the DEFAULTS in src/lib/chunker.js and are
  // passed explicitly, so both places must move together — editing only the
  // library leaves the pipeline on the old sizing.
  // 350 → 200 words per chunk (client DO23: "possibly less aggressive 'chunking'
  // will help this?"). A 350-word chunk is ~2 pages of a standard, so a passage
  // about one narrow concept was diluted by everything printed around it.
  chunkTargetWords: 200,   // ~285 tokens at 1.4 words/token
  chunkOverlapWords: 60,   // overlap between adjacent chunks for context continuity
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

  // Fail fast, before parsing anything. Every PDF parses independently of the
  // Worker, so an unreachable or unauthorized endpoint used to surface only at
  // the POST — after the whole corpus had been parsed and chunked. Observed:
  // 220 files parsed, all 220 failed with "fetch failed", because LUCIUS_API_URL
  // was unset and the default is localhost.
  if (!CONFIG.dryRun) await preflight();

  if (args.includes('--applications-only')) {
    return reindexApplications();
  }

  // Standalone R2 sweep. A full ingest already reports orphaned objects at the
  // end, but ACTING on that report should not cost a second re-embed of the whole
  // corpus — this mode just compares the bucket against D1 and exits.
  if (args.includes('--sweep-r2-only')) {
    return sweepR2Only();
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
  console.log('  node scripts/ingest-pdfs.js --sweep-r2-only [--sweep-r2]');
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

  // A lower errata of an edition that also ships a higher one is a PRIOR
  // edition, whichever folder it sits in (client DO096).
  const supersededErrata = findSupersededErrata(currentIds);
  if (supersededErrata.size > 0) {
    console.log(`Superseded by a higher errata, ingesting as deprecated: ${[...supersededErrata].join(', ')}\n`);
    // They are no longer CURRENT ids, or the reaffirmed-printing guard below
    // would see each one as "the same edition as a current standard" — which is
    // its own id — and skip the very file this rule just reclassified.
    for (const id of supersededErrata) currentIds.delete(id);
  }

  let success = 0;
  let failed = 0;
  const byStructure = { new_table: 0, standard: 0, skipped: 0 };

  for (const filePath of files) {
    const standardId = deriveStandardId(basename(filePath));
    let status = statusForPath(filePath);
    if (!CONFIG.forceStatus && status === 'current' && supersededErrata.has(standardId)) {
      status = 'deprecated';
    }
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

  // R2 garbage collection — a whole-directory run is the only moment we know the
  // complete set of standards that should exist, so it is the only moment a
  // bucket sweep is safe. A per-file run can only ever clean up that file's own
  // counterpart-prefix copy, which ingestFile already does.
  //
  // Reports by default and deletes nothing: removing a raw PDF is not
  // recoverable from Lensy. Pass --sweep-r2 to actually delete, after reading the
  // report. Skipped when the batch had failures — a partial run's D1 is not a
  // trustworthy picture of what should exist.
  if (!CONFIG.dryRun) {
    if (failed > 0) {
      console.log(`  R2 sweep skipped: ${failed} file(s) failed, so D1 does not yet describe the full corpus.`);
    } else {
      try {
        const sweep = await postToWorker('/api/ingest/r2-sweep', { confirm: CONFIG.sweepR2 });
        if (sweep.orphans === 0) {
          console.log(`  R2: ${sweep.examined} object(s), no orphans.`);
        } else if (sweep.dryRun) {
          console.log(`  R2: ${sweep.orphans} of ${sweep.examined} object(s) have no standards row — ` +
            `${(sweep.keys || []).slice(0, 5).join(', ')}${sweep.orphans > 5 ? ', …' : ''}`);
          console.log('     Re-run with --sweep-r2 to delete them.');
        } else {
          console.log(`  R2: deleted ${sweep.deleted} of ${sweep.orphans} orphaned object(s).`);
        }
      } catch (err) {
        console.warn(`  R2 sweep unavailable (non-fatal): ${err.message}`);
      }
    }
  }
  console.log('');
}

/**
 * Which of these standard IDs a HIGHER errata of the same edition supersedes
 * (client DO096).
 *
 * "_+E# indicates an 'errata' and the highest +E# is therefore the current
 * version of a standard." RP-8-25+E1 and RP-8-25+E2 are one edition printed
 * twice, but both PDFs ship in the current folder, so both were ingested Active
 * — and the AI Guide was then citing two live standards where there is one.
 * Measured on production: RP-8-25 was the only family in the corpus with two
 * Active erratas, so this rule changes exactly one document today, and prevents
 * the next one silently.
 *
 * A base edition carrying no marker is errata 0, so "RP-8-25" is superseded by
 * "RP-8-25+E1". Different YEARS are different bases and are untouched here —
 * RP-8-22 is a prior edition by the ordinary folder rule, not by this one.
 */
function findSupersededErrata(ids) {
  const best = new Map();   // base edition → highest errata seen
  const parsed = [];
  for (const id of ids) {
    const m = /^(.+?)\s*\+\s*E(\d+)$/i.exec(id);
    const base = m ? m[1].trim() : id;
    const level = m ? parseInt(m[2], 10) : 0;
    parsed.push({ id, base, level });
    const top = best.get(base);
    if (!top || level > top.level) best.set(base, { level, id });
  }
  const superseded = new Set();
  for (const p of parsed) {
    const top = best.get(p.base);
    if (top && top.id !== p.id) superseded.add(p.id);
  }
  return superseded;
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

  // Step 2a: the standard's own cover is the authority for its title and its
  // full designation (client DO48 — the file metadata is empty for this whole
  // corpus, so `title` was being written as the bare id and citations fell back
  // to a hand-written list that had RP-1-24 wrong). The committee printed a page
  // later seeds the authoring credit (DO29) until Vitrium supplies it.
  const cover = extractCoverMetadata(pages);
  const coverCommittee = extractCoverCommittee(pages);
  const title = cover.title || metadata.title || '';
  console.log(`  Pages: ${pages.length}, Title: "${title || '(none)'}"` +
    `${cover.title ? ' (from the cover)' : ''}`);
  if (!cover.title) {
    console.warn('  ⚠ The cover page yielded no title — this standard will cite as a bare designation ' +
      'unless the Vitrium export supplies one (npm run sync-metadata).');
  }
  if (coverCommittee) console.log(`  Authoring committee: ${coverCommittee}`);

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
    // The printed designation carries what an id cannot: the reaffirmation
    // marker ("ANSI/IES LS-2-20(R2023)") and co-publishers ("ANSI/IES/NALMCO")
    // — the exact string the client asked result cards to print (DO45/DO48).
    fullDesignation: cover.designation || inferFullDesignation(standardId, title),
    year: metadata.year,
    author: metadata.author || coverCommittee,
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

  // Step 5: Chunk text with IES section awareness (src/lib/chunker.js).
  // References/Bibliography sections are segmented into per-entry chunks
  // tagged type='reference' — these power the references-only search mode.
  console.log('  Chunking text...');
  const textChunks = chunkIESDocument(pages, {
    targetWords: CONFIG.chunkTargetWords,
    overlapWords: CONFIG.chunkOverlapWords,
    minWords: CONFIG.minChunkWords,
  });

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
  const byType = {};
  for (const c of chunks) byType[c.type || 'text'] = (byType[c.type || 'text'] || 0) + 1;
  console.log(`  Chunks: ${chunks.length} (${Object.entries(byType).map(([t, n]) => `${n} ${t}`).join(', ')})`);

  // Indexing-coverage report: which pages produced at least one chunk. Low
  // coverage means part of the document never reached the index — surface it
  // HERE, at ingest time, not after a client notices missing results.
  const coveredPages = new Set(chunks.map(c => c.pageNumber).filter(p => p != null));
  const coveragePct = pages.length > 0 ? Math.round((coveredPages.size / pages.length) * 100) : 0;
  console.log(`  Page coverage: ${coveredPages.size}/${pages.length} pages (${coveragePct}%)`);
  if (coveragePct < 60 && pages.length > 3) {
    console.warn(`  ⚠ LOW COVERAGE: only ${coveragePct}% of pages produced chunks — inspect this PDF's parse (scripts/inspect-pdf-lines.js).`);
  }
  const hasReferencesHeading = pages.some(p => /(?:^|\n)\s*(?:[\d.]+\s+|Annex\s+[A-Z]\s+)?(?:Normative\s+|Informative\s+)?References?\s*(?:\n|$)/i.test(p.text));
  if (hasReferencesHeading && !byType.reference) {
    console.warn('  ⚠ A References heading was detected but no reference chunks were produced — reference search will miss this standard.');
  }

  // Step 5b: In-body reference markers — superscripted numerals citing the
  // References section, mapped to the first page that prints each one. Lets a
  // Reference result link to where the work is CITED, not to the bibliography
  // page (client DO31.4).
  const referenceMarkers = extractReferenceMarkers(pages);
  const markerCount = Object.keys(referenceMarkers).length;
  console.log(`  In-body reference markers: ${markerCount}`);
  if (byType.reference && markerCount === 0) {
    console.warn('  ⚠ Reference entries were indexed but no in-body superscript markers were found — Reference chips will link to the References page instead of the citing page.');
  }

  // Step 5c: Section number → printed section title (client DO40). Chunks carry
  // only their own section NUMBER, so the titles and the parent chain above them
  // ("3 Design Guide" › "3.3 Transition Spaces…" › "3.3.4 Circulation Areas")
  // come from this per-document map, stored on the standards row.
  // Step 5c/5d: ONE heading walk, two products (client DO40 + DO82). The
  // outline is every heading in document ORDER with its PAGE — the table of
  // contents the List Standards page offers — and the section-title map is
  // derived from it, so the two can never disagree.
  const outline = extractOutline(pages);
  const sections = {};
  for (const entry of outline) if (!sections[entry.number]) sections[entry.number] = entry.title;
  const sectionCount = outline.length;
  console.log(`  Section titles: ${sectionCount}`);
  if (sectionCount === 0 && pages.length > 5) {
    console.warn('  ⚠ No section headings were recognised — body excerpts from this standard will show a section number without its title.');
  }

  // Step 5e: table and figure CAPTIONS (client DO86). The embedding model is
  // text-only and a rasterized table yields no text, but its caption always
  // does — so "where is the table that shows sound coefficients?" can be
  // answered with the table's number and page even when its cells are an image.
  const assets = extractDocumentAssets(pages);
  const tableCaptions = assets.filter(a => a.kind === 'table').length;
  console.log(`  Table/figure captions: ${assets.length} (${tableCaptions} tables, ${assets.length - tableCaptions} figures)`);

  if (CONFIG.verbose) {
    for (const [i, chunk] of chunks.entries()) {
      const preview = chunk.text.substring(0, 70).replace(/\n/g, ' ');
      console.log(`    [${i}] p.${chunk.pageNumber} §${chunk.section || '?'} (${chunk.wordCount}w) "${preview}..."`);
    }
  }

  if (CONFIG.dryRun) {
    console.log(`  [DRY RUN] Would send: ${chunks.length} chunks, ${tables.length} tables, ` +
      `${applications.length} applications, ${sectionCount} section titles`);
    return { structure };
  }

  // Step 6: POST chunks + metadata to Worker (embedding + indexing + D1 standards row)
  console.log('  Sending to Worker for embedding + indexing...');
  const result = await postToWorker('/api/ingest', {
    standardId,
    structure,
    status,
    metadata: {
      title,
      author: standardMeta.author,
      subject: metadata.subject,
      year: metadata.year,
      fullDesignation: standardMeta.fullDesignation,
      pageCount: pages.length,  // → standards.page_count, for coverage reporting
    },
    chunks,
    tables,
    applications: [],  // sent separately below to avoid request size limits
    referenceMarkers,
    sections,
    outline,
    assets,
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

  // Step 7b: prune rows this parse no longer produces.
  //
  // Application codes are `<STDID>_<rowIndex>`, so ANY extractor change that
  // shifts the row numbering leaves the tail of the previous run behind — live in
  // D1 with Active = 1, and re-embedded by `ingest:apps` — showing up in search
  // as illuminance rows carrying data from the old parse. The upserts above
  // cannot detect that; only the complete code list can.
  let applicationsPruned = 0;
  if (applications.length > 0 && !CONFIG.skipPrune) {
    const pruned = await postToWorker('/api/ingest/applications/prune', {
      standardId,
      keepCodes: applications.map(a => a.code),
    });
    applicationsPruned = pruned.deleted || 0;
    if (applicationsPruned > 0) {
      console.log(`  Pruned ${applicationsPruned} stale application row(s) from a previous parse` +
        ` (${pruned.vectorsDeleted || 0} vectors): ${(pruned.sample || []).slice(0, 5).join(', ')}${applicationsPruned > 5 ? ', …' : ''}`);
    }
  }

  console.log(`  ✓ ${result.chunksIndexed} chunks indexed, ${result.tablesFound} tables stored, ` +
    `${applicationsUpserted} application records upserted${applicationsPruned ? `, ${applicationsPruned} pruned` : ''}`);
  return { structure };
}

// ─── R2 Upload ────────────────────────────────────────────────────────────────

function uploadToR2(filePath, r2Key) {
  console.log(`  Uploading to R2: ${r2Key}`);
  // wrangler v3: r2 object put targets the REAL bucket by default; --local
  // opts into simulated storage. (wrangler v4 flips this default — if the
  // project upgrades, remote uploads will need an explicit --remote flag.)
  const isLocalTarget = CONFIG.apiUrl.includes('localhost') || CONFIG.apiUrl.includes('127.0.0.1');
  const localFlag = isLocalTarget ? ' --local' : '';
  const cmd = `wrangler r2 object put ies-standards-pdfs/${r2Key} --file="${filePath}"${localFlag}`;
  const MAX_ATTEMPTS = 3;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      execSync(cmd, { stdio: 'pipe' });
      console.log('  R2 upload complete.');
      return;
    } catch (err) {
      const stderr = (err.stderr || '').toString().trim();
      const detail = stderr.split('\n').slice(-3).join(' | ') || err.message;
      if (attempt < MAX_ATTEMPTS) {
        console.warn(`  ⚠ R2 upload attempt ${attempt}/${MAX_ATTEMPTS} failed, retrying: ${detail.slice(0, 200)}`);
        execSync(`node -e "setTimeout(()=>{}, ${attempt * 5000})"`); // backoff
      } else {
        // Non-fatal: embedding proceeds even if R2 upload fails
        console.warn(`  ⚠ R2 upload failed after ${MAX_ATTEMPTS} attempts (non-fatal): ${detail.slice(0, 300)}`);
      }
    }
  }
}

// ─── Applications Re-index ────────────────────────────────────────────────────

/**
 * Verify the Worker is reachable, authorized, and running a build that has the
 * endpoints this script needs — before a single PDF is parsed.
 *
 * Two side-effect-free probes:
 *   1. /api/ingest/r2-upload-url just echoes a key back → proves reach + auth.
 *   2. /api/ingest/applications/prune with an empty keep-list is REFUSED by
 *      design (400), so a 404 here means the deployed Worker predates the prune
 *      and the ingest would fail per-file at the very end of each document.
 */
async function preflight() {
  const isLocal = CONFIG.apiUrl.includes('localhost') || CONFIG.apiUrl.includes('127.0.0.1');
  const urlHint = process.env.LUCIUS_API_URL
    ? ''
    : `\n   LUCIUS_API_URL is not set, so the target defaulted to ${CONFIG.apiUrl}.` +
      '\n   Export it (e.g. LUCIUS_API_URL=https://lensy.ies.org) or pass --local for wrangler dev.';

  try {
    await postToWorker('/api/ingest/r2-upload-url', { standardId: '__preflight__' });
  } catch (err) {
    const msg = String(err.message || err);
    if (/fetch failed|ECONNREFUSED|ENOTFOUND|other side closed/i.test(msg)) {
      throw new Error(`Cannot reach the Worker at ${CONFIG.apiUrl}.${urlHint}` +
        (isLocal ? '\n   For local dev, start it first: npx wrangler dev' : ''));
    }
    if (/\b(401|403)\b/.test(msg)) {
      throw new Error(`The Worker at ${CONFIG.apiUrl} rejected the ingest credential.` +
        '\n   LUCIUS_API_SECRET must match the value set with `wrangler secret put LUCIUS_API_SECRET`.' +
        `\n   Server said: ${msg}`);
    }
    throw new Error(`Preflight against ${CONFIG.apiUrl} failed: ${msg}${urlHint}`);
  }

  // NOTE the inverted logic here, which is not a mistake: handleIngest routes an
  // unrecognized sub-path to `default: ingestParsedPDF`, so a build without the
  // prune endpoint does NOT answer 404 — it treats the probe as an empty document
  // ingest and answers 200. Success is therefore the failure signal; the refusal
  // is what proves the endpoint exists.
  let pruneRefused = false;
  try {
    await postToWorker('/api/ingest/applications/prune', { standardId: '__preflight__', keepCodes: [] });
  } catch (err) {
    const msg = String(err.message || err);
    if (/keepCodes is empty/.test(msg)) pruneRefused = true;
    else throw new Error(`Preflight prune probe failed unexpectedly: ${msg}`);
  }
  if (!pruneRefused) {
    throw new Error(`The Worker at ${CONFIG.apiUrl} is running a build without /api/ingest/applications/prune ` +
      '(the probe fell through to the generic ingest handler).' +
      '\n   Deploy the current code first (npm run deploy), then re-run the ingest —' +
      '\n   otherwise stale application rows from the previous parse stay live in D1 and' +
      '\n   get re-embedded by `npm run ingest:apps`.');
  }

  console.log(`Preflight: ${CONFIG.apiUrl} reachable, authorized, prune endpoint present.\n`);
}

/**
 * Compare the R2 bucket against D1 and report (or delete) objects with no
 * standards row. Reports only unless --sweep-r2 is also passed: a raw PDF removed
 * from R2 cannot be recovered from Lensy.
 */
async function sweepR2Only() {
  console.log(`R2 sweep — comparing the bucket against D1${CONFIG.sweepR2 ? '' : ' (report only)'}...\n`);

  if (CONFIG.dryRun) {
    console.log('[DRY RUN] Would POST to /api/ingest/r2-sweep');
    return;
  }

  let sweep;
  try {
    sweep = await postToWorker('/api/ingest/r2-sweep', { confirm: CONFIG.sweepR2 });
  } catch (err) {
    const msg = String(err.message || err);
    // A 409 is the endpoint's own safety refusal (every object looked orphaned,
    // i.e. the standards table is empty or unreadable). That is the sweep working
    // as designed — report it as a warning, not a crash.
    if (/\b409\b/.test(msg)) {
      console.warn(`R2 sweep declined for safety:\n  ${msg.replace(/^Worker returned 409: /, '')}\n`);
      return;
    }
    throw err;
  }

  if (sweep.orphans === 0) {
    console.log(`✓ ${sweep.examined} object(s) in R2, no orphans.\n`);
    return;
  }

  console.log(`${sweep.orphans} of ${sweep.examined} object(s) have no standards row:`);
  for (const key of sweep.keys || []) console.log(`  ${key}`);
  if (sweep.orphans > (sweep.keys || []).length) {
    console.log(`  … and ${sweep.orphans - sweep.keys.length} more`);
  }

  if (sweep.dryRun) {
    console.log('\nNothing deleted. Re-run with --sweep-r2 to delete these objects.\n');
  } else {
    console.log(`\n✓ Deleted ${sweep.deleted} of ${sweep.orphans}.\n`);
  }
}

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
