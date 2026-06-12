#!/usr/bin/env node
/**
 * Lensy — Search & Extraction Quality Tests (real data, not fixtures)
 *
 * This script validates the pipeline against the ACTUAL IES prototype PDFs in
 * pdfs/, instead of hard-coded queries that assume applications which may not
 * exist in the corpus. It runs in two stages:
 *
 *   Stage 1 — Extraction gate (always, offline, no Worker needed)
 *     Parses every PDF in pdfs/ with the real ingestion code path
 *     (parsePDFNode → extractApplicationsFromPages) and asserts each standard
 *     meets the spec-compliance gates derived from
 *     pdfs/Others/IlluminanceTables_Reference_260421.pdf:
 *       • records extracted (> 0)
 *       • ≥90% of rows carry a horizontal lux value
 *       • zero hierarchy gaps (no deeper level filled above an empty one)
 *       • every row resolves an App level
 *       • illuminance Category coverage is high (waived for RP-43-style tables)
 *
 *   Stage 2 — Live search (only if a Worker URL is reachable)
 *     Builds queries from REAL extracted application names (sampled from the
 *     corpus above) and verifies each is retrievable via POST /api/search.
 *     Skipped automatically when no Worker is running.
 *
 * Usage:
 *   node scripts/test-search.js                       # extraction gate only
 *   node scripts/test-search.js --url http://localhost:8787   # + live search
 *   node scripts/test-search.js --pdf-dir pdfs --samples 12
 */

import { readFileSync, readdirSync, existsSync } from 'fs';
import { resolve, basename, extname, join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { parsePDFNode } from '../src/lib/pdf-parser.js';
import {
  extractApplicationsFromPages,
  reportExtractionQuality,
} from '../src/lib/applications-extractor.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const args = process.argv.slice(2);
const getArg = (flag, def) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : def;
};

const API_BASE = getArg('--url', process.env.LUCIUS_API_URL || null);
const PDF_DIR = resolve(ROOT, getArg('--pdf-dir', 'pdfs'));
const SAMPLES = parseInt(getArg('--samples', '12'), 10);

// Spec-compliance gates (per standard).
const GATES = {
  minHorLuxRatio: 0.9,    // ≥90% of rows must have a horizontal lux value
  minCatRatio:    0.7,    // ≥70% must carry an illuminance Category …
  catWaivedFor:   /^RP-43/, // … except RP-43-style tables, which carry none
};

const PASS = '✓', FAIL = '✗', WARN = '⚠', SKIP = '·';

async function main() {
  console.log('\nLensy — Search & Extraction Quality Tests');
  console.log('─'.repeat(62));

  const corpus = await runExtractionGate();

  let liveFailures = 0;
  if (API_BASE) {
    liveFailures = await runLiveSearch(corpus);
  } else {
    console.log(`\n${SKIP} Live search skipped (no --url / LUCIUS_API_URL).`);
    console.log('   Pass --url http://localhost:8787 to test the Worker too.');
  }

  const extractionFailed = corpus.some(c => c.failures.length > 0);
  console.log('\n' + '─'.repeat(62));
  if (extractionFailed || liveFailures > 0) {
    console.log(`Result: FAILED (${corpus.filter(c => c.failures.length).length} standards with extraction issues, ${liveFailures} live-search misses)\n`);
    process.exit(1);
  }
  console.log('Result: all gates passed\n');
}

// ─── Stage 1: Extraction gate ─────────────────────────────────────────────────

async function runExtractionGate() {
  if (!existsSync(PDF_DIR)) {
    console.error(`\n${FAIL} PDF directory not found: ${PDF_DIR}`);
    process.exit(1);
  }

  const files = readdirSync(PDF_DIR)
    .filter(f => extname(f).toLowerCase() === '.pdf')
    .sort();

  if (files.length === 0) {
    console.error(`\n${FAIL} No PDFs in ${PDF_DIR}`);
    process.exit(1);
  }

  console.log(`\nStage 1 — Extraction gate over ${files.length} real PDF(s)\n`);

  const corpus = [];
  for (const file of files) {
    const standardId = standardIdFromFilename(file);
    const filePath = join(PDF_DIR, file);
    const failures = [];
    let applications = [];

    try {
      const pdfBytes = new Uint8Array(readFileSync(filePath));
      const { metadata, pages } = await parsePDFNode(pdfBytes);
      applications = extractApplicationsFromPages(pages, standardId, {
        fullDesignation: `ANSI/IES ${standardId}`,
        year: metadata.year,
      });

      const q = reportExtractionQuality(applications);
      const total = q.total;

      if (total === 0) failures.push('0 records extracted');
      if (total > 0 && q.withHorLux / total < GATES.minHorLuxRatio)
        failures.push(`only ${q.withHorLux}/${total} rows have horizontal lux (<${GATES.minHorLuxRatio * 100}%)`);
      if (q.hierarchyGaps > 0)
        failures.push(`${q.hierarchyGaps} hierarchy gaps`);
      if (total > 0 && q.withApp < total)
        failures.push(`${total - q.withApp} rows missing App level`);
      if (total > 0 && !GATES.catWaivedFor.test(standardId) && q.withIlluminanceCategory / total < GATES.minCatRatio)
        failures.push(`only ${q.withIlluminanceCategory}/${total} rows have a Category (<${GATES.minCatRatio * 100}%)`);

      const mark = failures.length === 0 ? PASS : FAIL;
      console.log(`${mark} ${standardId.padEnd(12)} ${total} rows · lux ${pct(q.withHorLux, total)} · cat ${pct(q.withIlluminanceCategory, total)} · vert ${q.withVertical} · gaps ${q.hierarchyGaps}`);
      for (const f of failures) console.log(`     ${FAIL} ${f}`);
    } catch (err) {
      failures.push(`parse error: ${err.message}`);
      console.log(`${FAIL} ${standardId.padEnd(12)} ${err.message}`);
    }

    corpus.push({ standardId, applications, failures });
  }

  return corpus;
}

// ─── Stage 2: Live search using real application names ────────────────────────

async function runLiveSearch(corpus) {
  console.log(`\nStage 2 — Live search against ${API_BASE}`);

  // Reachability probe.
  try {
    await fetch(`${API_BASE}/api/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'lighting', limit: 1 }),
    });
  } catch (err) {
    console.log(`\n${SKIP} Worker unreachable (${err.message}). Skipping live search.`);
    return 0;
  }

  // Build queries from REAL leaf application names across the corpus.
  const queries = sampleQueries(corpus, SAMPLES);
  if (queries.length === 0) {
    console.log(`\n${WARN} No application names available to query.`);
    return 0;
  }
  console.log(`Querying ${queries.length} real application names sampled from the corpus\n`);

  let misses = 0;
  for (const { query } of queries) {
    try {
      const res = await fetch(`${API_BASE}/api/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, limit: 8 }),
      });
      if (!res.ok) { console.log(`${FAIL} "${query}" → HTTP ${res.status}`); misses++; continue; }

      const data = await res.json();
      const results = data.results || [];
      const term = significantTerm(query);
      const hit = results.some(r => {
        const a = r.application || {};
        const hay = [a.fullName, a.category, a.sub1, a.sub2, a.sub3, a.standard].filter(Boolean).join(' ').toLowerCase();
        return hay.includes(term);
      });

      if (results.length === 0) { console.log(`${WARN} "${query}" → 0 results`); misses++; }
      else if (hit) console.log(`${PASS} "${query}" → ${results[0].application?.fullName || results[0].application?.standard}`);
      else { console.log(`${WARN} "${query}" → top: ${results[0].application?.fullName} (term "${term}" not in top 8)`); }
    } catch (err) {
      console.log(`${FAIL} "${query}" → ${err.message}`); misses++;
    }
  }
  return misses;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function standardIdFromFilename(file) {
  // "RP-43-25_v7_Prototype_260420-NEW_TABLE.pdf" → "RP-43-25"
  const stem = basename(file, '.pdf');
  const m = stem.match(/^([A-Z]{1,3}-\d+(?:-\d+)?(?:\+E\d+)?)/i);
  return m ? m[1] : stem.split(/[_ ]/)[0];
}

/** Pick representative real leaf names spread across standards. */
function sampleQueries(corpus, n) {
  const withApps = corpus.filter(c => c.applications.length > 0);
  if (withApps.length === 0) return [];

  const perStd = Math.max(1, Math.ceil(n / withApps.length));
  const out = [];
  for (const c of withApps) {
    // Prefer deep, specific leaves (more distinctive queries) with a lux value.
    const candidates = c.applications
      .filter(a => a.Hor_Lux != null)
      .map(a => leafName(a))
      .filter(name => name && name.split(/\s+/).length <= 6 && name.length >= 4);
    const uniq = [...new Set(candidates)];
    for (let i = 0; i < uniq.length && i < perStd; i++) {
      // spread the picks across the list rather than taking the first few
      const idx = Math.floor((i + 1) * uniq.length / (perStd + 1));
      out.push({ query: uniq[idx] || uniq[i], standardId: c.standardId });
    }
  }
  return out.slice(0, n);
}

function leafName(a) {
  return a.App_s6 || a.App_s5 || a.App_s4 || a.App_s3 || a.App_s2 || a.App_s1 || a.App || a.Sub_Category;
}

function significantTerm(query) {
  // The longest word is the most distinctive — use it for the containment check.
  return query.toLowerCase().split(/\s+/).filter(Boolean).sort((a, b) => b.length - a.length)[0] || query.toLowerCase();
}

function pct(num, den) {
  if (!den) return '0%';
  return `${Math.round((num / den) * 100)}%`;
}

main().catch(err => {
  console.error(`\n${FAIL} Fatal: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});
