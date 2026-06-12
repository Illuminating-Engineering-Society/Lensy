#!/usr/bin/env node
/**
 * Vitrium Metadata Sync Script
 * Fetches document metadata from Vitrium API and updates the D1 standards table.
 * Run periodically to keep Vitrium deep links and doc IDs current.
 *
 * Usage:
 *   VITRIUM_API_KEY=xxx node scripts/sync-metadata.js
 *   VITRIUM_API_KEY=xxx node scripts/sync-metadata.js --dry-run
 *
 * Phase 3: Will also sync Wicket member data.
 */

import { execSync } from 'child_process';

const VITRIUM_API_URL = process.env.VITRIUM_API_URL || 'https://api.vitrium.com';
const VITRIUM_API_KEY = process.env.VITRIUM_API_KEY;
const DRY_RUN = process.argv.includes('--dry-run');
const LOCAL = process.argv.includes('--local') ? '--local' : '';

if (!VITRIUM_API_KEY) {
  console.error('Error: VITRIUM_API_KEY environment variable is required.');
  process.exit(1);
}

async function main() {
  console.log(`\nLensy — Vitrium Metadata Sync`);
  console.log(`API: ${VITRIUM_API_URL}`);
  console.log(`Mode: ${DRY_RUN ? 'Dry Run (no writes)' : 'Live'}\n`);

  // Fetch all published IES standards from Vitrium
  const documents = await fetchVitriumDocuments();
  console.log(`Found ${documents.length} documents in Vitrium.\n`);

  let updated = 0;
  let skipped = 0;

  for (const doc of documents) {
    const standardId = extractStandardId(doc);
    if (!standardId) {
      console.log(`  SKIP: Cannot map "${doc.title}" to a standard ID`);
      skipped++;
      continue;
    }

    const sql = `
      UPDATE standards
      SET vitrium_doc_id = '${sqlEsc(doc.id)}',
          updated_at = CURRENT_TIMESTAMP
      WHERE id = '${sqlEsc(standardId)}';

      UPDATE applications
      SET Vitrium_Doc_ID = '${sqlEsc(doc.id)}'
      WHERE Standard = '${sqlEsc(standardId)}';
    `;

    if (DRY_RUN) {
      console.log(`  [DRY RUN] Would update ${standardId} → Vitrium ID: ${doc.id}`);
    } else {
      try {
        const tmpFile = `/tmp/lucius_sync_${standardId.replace(/[^A-Z0-9]/gi, '_')}.sql`;
        require('fs').writeFileSync(tmpFile, sql);
        execSync(`wrangler d1 execute ies-metadata ${LOCAL} --file="${tmpFile}"`, { stdio: 'pipe' });
        console.log(`  ✓ Updated ${standardId}`);
        updated++;
      } catch (err) {
        console.error(`  ✗ Failed to update ${standardId}: ${err.message.slice(0, 80)}`);
      }
    }
  }

  console.log(`\nDone. ${updated} updated, ${skipped} skipped.\n`);
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
    throw new Error(`Vitrium API error: ${response.status} ${await response.text().slice(0, 100)}`);
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

function sqlEsc(str) {
  return String(str || '').replace(/'/g, "''");
}

main().catch(err => {
  console.error('\n✗ Fatal error:', err.message);
  process.exit(1);
});
