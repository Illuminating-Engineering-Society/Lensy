#!/usr/bin/env node
/**
 * PDF Ingestion Script
 * Parses IES standard PDFs and indexes them into Cloudflare Vectorize + D1.
 *
 * Usage:
 *   node scripts/ingest-pdfs.js --file path/to/RP-9-20.pdf --id RP-9-20
 *   node scripts/ingest-pdfs.js --dir path/to/pdfs/         # batch all PDFs in directory
 *   node scripts/ingest-pdfs.js --applications-only         # re-index D1 apps into Vectorize
 *
 * Requires:
 *   CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID env vars
 *   (or use --local flag with wrangler dev running)
 */

import { readFileSync, readdirSync } from 'fs';
import { resolve, basename, extname } from 'path';

const API_BASE = process.env.LUCIUS_API_URL || 'http://localhost:8787';

const args = process.argv.slice(2);
const fileArg = args.indexOf('--file');
const dirArg = args.indexOf('--dir');
const idArg = args.indexOf('--id');
const appOnly = args.includes('--applications-only');

async function main() {
  console.log(`\nLucius — PDF Ingestion\n${'─'.repeat(40)}`);
  console.log(`API: ${API_BASE}\n`);

  if (appOnly) {
    // Re-index all D1 applications into Vectorize
    console.log('Indexing all applications from D1 into Vectorize...');
    const result = await callIngest('/applications', {});
    console.log(`✓ ${result.applicationsIndexed} applications indexed into Vectorize.\n`);
    return;
  }

  if (dirArg >= 0) {
    // Batch ingest all PDFs in a directory
    const dir = resolve(process.cwd(), args[dirArg + 1]);
    const files = readdirSync(dir).filter(f => extname(f).toLowerCase() === '.pdf');
    console.log(`Found ${files.length} PDFs in ${dir}\n`);

    for (const file of files) {
      const filePath = resolve(dir, file);
      const standardId = basename(file, '.pdf');
      await ingestFile(filePath, standardId);
    }
  } else if (fileArg >= 0) {
    // Single file
    const filePath = resolve(process.cwd(), args[fileArg + 1]);
    const standardId = idArg >= 0 ? args[idArg + 1] : basename(filePath, '.pdf');
    await ingestFile(filePath, standardId);
  } else {
    console.log('Usage:');
    console.log('  node scripts/ingest-pdfs.js --file path/to/RP-9-20.pdf --id RP-9-20');
    console.log('  node scripts/ingest-pdfs.js --dir path/to/pdfs/');
    console.log('  node scripts/ingest-pdfs.js --applications-only');
    process.exit(1);
  }
}

async function ingestFile(filePath, standardId) {
  console.log(`Ingesting: ${standardId} (${filePath})`);

  const pdfBytes = readFileSync(filePath);
  const base64 = pdfBytes.toString('base64');

  try {
    // Upload to R2 first via multipart, then trigger ingest
    // For local development: POST directly to the ingest endpoint with base64 body
    const result = await callIngest('', {
      standardId,
      sourceType: 'upload',
      pdfBase64: base64,
    });

    console.log(`  ✓ ${result.chunksIndexed} chunks indexed, ${result.tablesFound} tables found (${result.pages} pages)`);
  } catch (err) {
    console.error(`  ✗ Failed: ${err.message}`);
  }
}

async function callIngest(path, body) {
  const response = await fetch(`${API_BASE}/api/ingest${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${response.status}: ${text.slice(0, 200)}`);
  }

  return response.json();
}

main().catch(err => {
  console.error('\n✗ Fatal error:', err.message);
  process.exit(1);
});
