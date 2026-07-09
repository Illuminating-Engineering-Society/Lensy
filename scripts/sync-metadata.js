#!/usr/bin/env node
/**
 * Vitrium Metadata Sync Script
 * Populates Vitrium doc IDs and web viewer URLs in the D1 database so search
 * results can render "View in Vitrium" links.
 *
 * Three modes:
 *
 *  1. CSV mode (primary) — parses Vitrium's "Web Viewer URLs" document export:
 *       node scripts/sync-metadata.js --csv scripts/data/vitrium-webviewer-urls.csv
 *
 *     Expected columns: "Folder Path", "Title", "Doc ID", "Web Viewer URL".
 *     Standard IDs are extracted from titles ("RP-8-25 + E2" → RP-8-25+E2,
 *     "TM-25-20R25" → TM-25-20). When the same standard appears both in a
 *     current folder and the deprecated archive, the current entry wins.
 *
 *  2. File mode — reads a local JSON mapping:
 *       node scripts/sync-metadata.js --file vitrium-mapping.json
 *
 *     Format: { "RP-9-23": "doc-guid", ... } or an array of
 *     { standardId, docId, webUrl } objects.
 *
 *  3. API mode — fetches document metadata from the Vitrium API:
 *       VITRIUM_API_KEY=xxx node scripts/sync-metadata.js
 *
 * Flags: --dry-run (preview, no writes), --local (write to local D1 + KV).
 *
 * After a live sync the script bumps the search-cache data version (KV) so
 * cached responses with stale/missing Vitrium links are invalidated.
 *
 * Phase 3: Will also sync Wicket member data.
 */

import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const VITRIUM_API_URL = process.env.VITRIUM_API_URL || 'https://api.vitrium.com';
const VITRIUM_API_KEY = process.env.VITRIUM_API_KEY;
const DRY_RUN = process.argv.includes('--dry-run');
const IS_LOCAL = process.argv.includes('--local');
const D1_TARGET = IS_LOCAL ? '--local' : '--remote';

const CSV_FILE = argValue('--csv');
const MAPPING_FILE = argValue('--file');

function argValue(flag) {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return null;
  const val = process.argv[idx + 1];
  if (!val || val.startsWith('--')) {
    console.error(`Error: ${flag} requires a path argument.`);
    process.exit(1);
  }
  return val;
}

if (!CSV_FILE && !MAPPING_FILE && !VITRIUM_API_KEY) {
  console.error('Error: provide --csv <export.csv>, --file <mapping.json>, or set VITRIUM_API_KEY for API mode.');
  process.exit(1);
}

async function main() {
  console.log(`\nLensy — Vitrium Metadata Sync`);
  console.log(`Source: ${CSV_FILE ? `CSV (${CSV_FILE})` : MAPPING_FILE ? `file (${MAPPING_FILE})` : `API (${VITRIUM_API_URL})`}`);
  console.log(`Mode: ${DRY_RUN ? 'Dry Run (no writes)' : 'Live'} — D1 target: ${D1_TARGET}\n`);

  // Resolve the list of { standardId, docId, webUrl } entries to write
  const entries = CSV_FILE ? loadCsvExport(CSV_FILE)
    : MAPPING_FILE ? loadMappingFile(MAPPING_FILE)
    : await fetchFromApi();
  console.log(`Resolved ${entries.length} standard → Vitrium mappings.\n`);

  if (entries.length === 0) {
    console.log('Nothing to sync.');
    return;
  }

  // Build one batched SQL file — a single wrangler invocation instead of
  // one process per standard.
  const statements = entries.map(({ standardId, docId, webUrl }) => `
UPDATE standards
SET vitrium_doc_id = '${sqlEsc(docId)}',
    vitrium_web_url = ${webUrl ? `'${sqlEsc(webUrl)}'` : 'vitrium_web_url'},
    updated_at = CURRENT_TIMESTAMP
WHERE id = '${sqlEsc(standardId)}';

UPDATE applications
SET Vitrium_Doc_ID = '${sqlEsc(docId)}'
WHERE Standard = '${sqlEsc(standardId)}';
`).join('\n');

  if (DRY_RUN) {
    for (const e of entries) {
      console.log(`  [DRY RUN] ${e.standardId} → ${e.docId}${e.webUrl ? `  (${e.webUrl})` : ''}`);
    }
    console.log(`\nDone (dry run, ${entries.length} entries, no writes).\n`);
    return;
  }

  const tmpFile = path.join(os.tmpdir(), `lucius_vitrium_sync_${process.pid}.sql`);
  fs.writeFileSync(tmpFile, statements);
  try {
    execSync(`wrangler d1 execute ies-metadata ${D1_TARGET} --file="${tmpFile}"`, { stdio: 'inherit' });
    console.log(`\n✓ Synced ${entries.length} standards.`);
  } finally {
    fs.unlinkSync(tmpFile);
  }

  // Direct D1 writes bypass the ingest endpoints, so bump the search-cache
  // data version ourselves — otherwise cached searches keep serving results
  // without Vitrium links until their TTL expires.
  try {
    execSync(
      `wrangler kv key put cache:data-version ${Date.now()} --binding SESSIONS ${IS_LOCAL ? '--local' : '--remote'}`,
      { stdio: 'pipe' }
    );
    console.log('✓ Search cache invalidated (data version bumped).\n');
  } catch (err) {
    console.warn(`⚠ Could not bump cache data version (${err.message.slice(0, 80)}).`);
    console.warn('  Run manually: wrangler kv key put cache:data-version <timestamp> --binding SESSIONS --remote\n');
  }
}

// ─── CSV mode (Vitrium "Web Viewer URLs" export) ──────────────────────────────

function loadCsvExport(filePath) {
  const rows = parseCsv(fs.readFileSync(filePath, 'utf8'));
  if (rows.length < 2) return [];

  const header = rows[0].map(h => h.trim().toLowerCase());
  const col = (name) => header.indexOf(name);
  const iFolder = col('folder path');
  const iTitle = col('title');
  const iDocId = col('doc id');
  const iUrl = col('web viewer url');
  if (iTitle === -1 || iDocId === -1 || iUrl === -1) {
    console.error('Error: CSV must have "Title", "Doc ID" and "Web Viewer URL" columns.');
    process.exit(1);
  }

  // standardId → { entry, deprecated }
  const byStandard = new Map();
  let skipped = 0;

  for (const row of rows.slice(1)) {
    const title = row[iTitle];
    const docId = row[iDocId];
    const webUrl = row[iUrl];
    if (!title || !docId) continue;

    const standardId = extractStandardIdFromTitle(title);
    if (!standardId) {
      console.log(`  SKIP: cannot map title "${title}" to a standard ID`);
      skipped++;
      continue;
    }

    const deprecated = iFolder !== -1 && /z_deprecated/i.test(row[iFolder] || '');
    const existing = byStandard.get(standardId);

    if (!existing) {
      byStandard.set(standardId, { entry: { standardId, docId, webUrl }, deprecated });
    } else if (existing.deprecated && !deprecated) {
      // Current edition beats the archived copy of the same designation
      byStandard.set(standardId, { entry: { standardId, docId, webUrl }, deprecated });
    } else if (existing.deprecated === deprecated) {
      console.log(`  DUP: ${standardId} appears twice (${deprecated ? 'deprecated' : 'current'}); keeping first ("${title}" ignored)`);
    }
  }

  if (skipped > 0) console.log(`  (${skipped} rows skipped)\n`);
  return [...byStandard.values()].map(v => v.entry);
}

/**
 * Extract a standard designation from a Vitrium document title.
 *
 *   "RP-8-25 + E2"                          → RP-8-25+E2
 *   "RP-10-20+E2 Prototype_260420-NEW_TABLE" → RP-10-20+E2
 *   "TM-25-20R25"                           → TM-25-20
 *   "LS-4-20 (R2023) +E1_"                  → LS-4-20   (errata after (R...) not part of D1 IDs)
 *   "RP-27.1-22"                            → RP-27.1-22
 */
function extractStandardIdFromTitle(title) {
  const m = String(title).match(/([A-Z]{1,4}-\d+(?:\.\d+)?-\d{2})(\s*\+\s*E\d+)?/i);
  if (!m) return null;
  let id = m[1].toUpperCase();
  if (m[2]) id += `+${m[2].replace(/[\s+]/g, '').toUpperCase()}`;
  return id;
}

/** Minimal CSV parser handling quoted fields with embedded commas/quotes. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else {
      field += c;
    }
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

// ─── File mode ────────────────────────────────────────────────────────────────

function loadMappingFile(filePath) {
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));

  const rows = Array.isArray(raw)
    ? raw.map(r => ({
        standardId: r.standardId || r.standard,
        docId: r.docId || r.vitriumDocId,
        webUrl: r.webUrl || r.deepLink || null,
      }))
    : Object.entries(raw)
        .filter(([key]) => !key.startsWith('_'))
        .map(([standardId, docId]) => ({ standardId, docId, webUrl: null }));

  const valid = [];
  for (const row of rows) {
    if (!row.standardId || !row.docId) {
      console.log(`  SKIP: incomplete entry ${JSON.stringify(row)}`);
      continue;
    }
    valid.push({ ...row, standardId: normalizeStandardId(row.standardId) });
  }
  return valid;
}

// ─── API mode ─────────────────────────────────────────────────────────────────

async function fetchFromApi() {
  const documents = await fetchVitriumDocuments();
  console.log(`Found ${documents.length} documents in Vitrium.`);

  const entries = [];
  for (const doc of documents) {
    const standardId = extractStandardIdFromTitle(doc.title || doc.name || '');
    if (!standardId) {
      console.log(`  SKIP: Cannot map "${doc.title || doc.name}" to a standard ID`);
      continue;
    }
    entries.push({ standardId, docId: doc.id, webUrl: doc.webViewerUrl || null });
  }
  return entries;
}

async function fetchVitriumDocuments() {
  // Vitrium API: GET /api/v2/documents
  const response = await fetch(`${VITRIUM_API_URL}/api/v2/documents`, {
    headers: {
      'Authorization': `Bearer ${VITRIUM_API_KEY}`,
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Vitrium API error: ${response.status} ${body.slice(0, 100)}`);
  }

  const data = await response.json();
  return data.documents || data.items || data || [];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function normalizeStandardId(id) {
  // "ANSI/IES RP-9-23" → "RP-9-23"; preserve +E suffixes; leave bare IDs untouched
  const m = String(id).match(/([A-Z]+-\d+(?:\.\d+)?(?:-\d+)?(?:\+E\d+)?)\s*$/i);
  return m ? m[1].toUpperCase() : String(id).trim();
}

function sqlEsc(str) {
  return String(str || '').replace(/'/g, "''");
}

main().catch(err => {
  console.error('\n✗ Fatal error:', err.message);
  process.exit(1);
});
