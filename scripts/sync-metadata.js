#!/usr/bin/env node
/**
 * Vitrium Metadata Sync Script
 * Populates Vitrium doc IDs (and optional deep links) in the D1 database so
 * search results can render "View in Vitrium" links.
 *
 * Two modes:
 *
 *  1. API mode (default) — fetches document metadata from the Vitrium API:
 *       VITRIUM_API_KEY=xxx node scripts/sync-metadata.js
 *       VITRIUM_API_KEY=xxx node scripts/sync-metadata.js --dry-run
 *
 *  2. File mode — reads a local JSON mapping (no API access needed):
 *       node scripts/sync-metadata.js --file vitrium-mapping.json
 *
 *     Mapping format (either shape works):
 *       { "RP-9-20": "abc123", "RP-6-24": "def456" }
 *     or:
 *       [
 *         { "standardId": "RP-9-20", "docId": "abc123" },
 *         { "standardId": "RP-6-24", "docId": "def456", "deepLink": "https://..." }
 *       ]
 *
 * Add --local to write to the local D1 instance (wrangler dev), --dry-run to
 * preview without writing.
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
const LOCAL = process.argv.includes('--local') ? '--local' : '--remote';

const fileFlagIdx = process.argv.indexOf('--file');
const MAPPING_FILE = fileFlagIdx !== -1 ? process.argv[fileFlagIdx + 1] : null;

if (fileFlagIdx !== -1 && !MAPPING_FILE) {
  console.error('Error: --file requires a path, e.g. --file vitrium-mapping.json');
  process.exit(1);
}

if (!MAPPING_FILE && !VITRIUM_API_KEY) {
  console.error('Error: set VITRIUM_API_KEY for API mode, or use --file <mapping.json> for manual mode.');
  process.exit(1);
}

async function main() {
  console.log(`\nLensy — Vitrium Metadata Sync`);
  console.log(`Source: ${MAPPING_FILE ? `file (${MAPPING_FILE})` : `API (${VITRIUM_API_URL})`}`);
  console.log(`Mode: ${DRY_RUN ? 'Dry Run (no writes)' : 'Live'} — D1 target: ${LOCAL}\n`);

  // Resolve the list of { standardId, docId, deepLink } entries to write
  const entries = MAPPING_FILE ? loadMappingFile(MAPPING_FILE) : await fetchFromApi();
  console.log(`Resolved ${entries.length} standard → Vitrium mappings.\n`);

  if (entries.length === 0) {
    console.log('Nothing to sync.');
    return;
  }

  // Build one batched SQL file — a single wrangler invocation instead of
  // one process per standard.
  const statements = entries.map(({ standardId, docId, deepLink }) => `
UPDATE standards
SET vitrium_doc_id = '${sqlEsc(docId)}',
    updated_at = CURRENT_TIMESTAMP
WHERE id = '${sqlEsc(standardId)}' OR id = 'ANSI/IES ${sqlEsc(standardId)}';

UPDATE applications
SET Vitrium_Doc_ID = '${sqlEsc(docId)}'${deepLink ? `,
    Vitrium_Deep_Link = '${sqlEsc(deepLink)}'` : ''}
WHERE Standard = '${sqlEsc(standardId)}';
`).join('\n');

  if (DRY_RUN) {
    for (const e of entries) {
      console.log(`  [DRY RUN] ${e.standardId} → Vitrium ID: ${e.docId}${e.deepLink ? ` (deep link set)` : ''}`);
    }
    console.log('\nDone (dry run, no writes).\n');
    return;
  }

  const tmpFile = path.join(os.tmpdir(), `lucius_vitrium_sync_${process.pid}.sql`);
  fs.writeFileSync(tmpFile, statements);
  try {
    execSync(`wrangler d1 execute ies-metadata ${LOCAL} --file="${tmpFile}"`, { stdio: 'inherit' });
    console.log(`\n✓ Synced ${entries.length} standards.\n`);
  } finally {
    fs.unlinkSync(tmpFile);
  }
}

// ─── File mode ────────────────────────────────────────────────────────────────

function loadMappingFile(filePath) {
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));

  const rows = Array.isArray(raw)
    ? raw.map(r => ({ standardId: r.standardId || r.standard, docId: r.docId || r.vitriumDocId, deepLink: r.deepLink || null }))
    : Object.entries(raw).map(([standardId, docId]) => ({ standardId, docId, deepLink: null }));

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
    const standardId = extractStandardId(doc);
    if (!standardId) {
      console.log(`  SKIP: Cannot map "${doc.title || doc.name}" to a standard ID`);
      continue;
    }
    entries.push({ standardId, docId: doc.id, deepLink: null });
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

function extractStandardId(doc) {
  // Try to extract "RP-9-20" style ID from document title or custom fields
  const title = doc.title || doc.name || '';

  // Pattern: "ANSI/IES RP-9-20" or "RP-9-20" anywhere in title
  const match = title.match(/(?:ANSI\/IES\s+)?([A-Z]+-\d+-\d+)/i);
  if (match) return match[1].toUpperCase();

  // Check custom metadata fields
  if (doc.customFields) {
    const stdField = doc.customFields.find(f =>
      f.name?.toLowerCase().includes('standard') ||
      f.name?.toLowerCase().includes('designation')
    );
    if (stdField?.value) {
      const m = stdField.value.match(/([A-Z]+-\d+-\d+)/i);
      if (m) return m[1].toUpperCase();
    }
  }

  return null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function normalizeStandardId(id) {
  // "ANSI/IES RP-9-20" → "RP-9-20"; leave bare IDs untouched
  const m = String(id).match(/([A-Z]+-\d+(?:-\d+)?)\s*$/i);
  return m ? m[1].toUpperCase() : String(id).trim();
}

function sqlEsc(str) {
  return String(str || '').replace(/'/g, "''");
}

main().catch(err => {
  console.error('\n✗ Fatal error:', err.message);
  process.exit(1);
});
