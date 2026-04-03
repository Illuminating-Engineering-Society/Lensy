#!/usr/bin/env node
/**
 * Seed Applications Script
 * Imports the 68-column IES Illuminance Selector database into D1.
 *
 * Usage:
 *   node scripts/seed-applications.js --source data/applications.csv
 *   node scripts/seed-applications.js --source data/applications.json
 *
 * After seeding D1, run ingest-applications to index into Vectorize:
 *   node scripts/ingest-pdfs.js --applications-only
 *
 * CSV format: header row with exact column names from standards-schema.json
 * JSON format: array of application objects
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';
import { execSync } from 'child_process';

const args = process.argv.slice(2);
const sourceArg = args.indexOf('--source');
const sourceFile = sourceArg >= 0 ? args[sourceArg + 1] : 'data/applications.json';
const localFlag = args.includes('--local') ? '--local' : '';

const BATCH_SIZE = 20; // D1 batch insert limit

async function main() {
  console.log(`\nLucius — Seed Applications\n${'─'.repeat(40)}`);
  console.log(`Source: ${sourceFile}`);
  console.log(`Target: ${localFlag ? 'Local D1' : 'Remote D1 (ies-metadata)'}\n`);

  // Load source data
  const fullPath = resolve(process.cwd(), sourceFile);
  const raw = readFileSync(fullPath, 'utf8');

  let applications;
  if (sourceFile.endsWith('.json')) {
    applications = JSON.parse(raw);
  } else if (sourceFile.endsWith('.csv')) {
    applications = parseCSV(raw);
  } else {
    throw new Error('Source must be .json or .csv');
  }

  console.log(`Loaded ${applications.length} applications from source.\n`);

  // Validate required fields
  const invalid = applications.filter(a => !a.code && !a.Code);
  if (invalid.length > 0) {
    console.warn(`⚠ ${invalid.length} applications missing 'code' field — skipping.`);
  }

  // Generate code from hierarchy if missing
  applications = applications.map((app, idx) => ({
    ...normalizeKeys(app),
    code: app.code || app.Code || generateCode(app, idx),
  }));

  // Insert in batches
  let inserted = 0;
  let errors = 0;

  for (let i = 0; i < applications.length; i += BATCH_SIZE) {
    const batch = applications.slice(i, i + BATCH_SIZE);
    const sql = buildBatchInsert(batch);

    try {
      // Write SQL to temp file and execute via wrangler
      const tmpFile = `/tmp/lucius_seed_batch_${i}.sql`;
      writeFileSync(tmpFile, sql);
      execSync(
        `wrangler d1 execute ies-metadata ${localFlag} --file="${tmpFile}"`,
        { stdio: 'pipe' }
      );
      inserted += batch.length;
      process.stdout.write(`\r  Inserted ${inserted}/${applications.length}...`);
    } catch (err) {
      console.error(`\n  ✗ Batch ${i}-${i + BATCH_SIZE} failed:`, err.message.slice(0, 100));
      errors++;
    }
  }

  console.log(`\n\n✓ Done. ${inserted} inserted, ${errors} batches with errors.`);
  if (inserted > 0) {
    console.log('\nNext step: index applications into Vectorize:');
    console.log('  node scripts/ingest-pdfs.js --applications-only\n');
  }
}

function buildBatchInsert(apps) {
  const cols = [
    'code', 'App', 'App_s1', 'App_s2', 'App_s3', 'App_s4', 'App_s5', 'App_s6',
    'Standard', 'Standard_Full', 'Table_Ref', 'Row_Ref', 'Link_Mapping',
    'Area_or_Task', 'Indoor_Outdoor', 'App_Type',
    'Hor_Cat', 'Hor_Lux', 'Hor_Fc', 'Hor_Height_m', 'Hor_Height_ft',
    'Hor_Avg_Max_Min', 'Hor_Uniformity', 'Hor_Notes',
    'Ver_Cat', 'Ver_Lux', 'Ver_Fc', 'Ver_Height_m', 'Ver_Height_ft',
    'Ver_Avg_Max_Min', 'Ver_Uniformity', 'Ver_Notes',
    'Task_Cat', 'Task_Lux', 'Task_Fc', 'Task_Height_m', 'Task_Height_ft',
    'Task_Avg_Max_Min', 'Task_Uniformity', 'Task_Notes',
    'TM24_Eligible', 'TM24_Notes',
    'Lighting_Zone', 'Max_Glare_Rating', 'Max_Uplight', 'Curfew_Dimming',
    'Spectrum_Guidance', 'Controls_Required',
    'Footnotes', 'General_Notes', 'App_Notes',
    'Vitrium_Doc_ID', 'Vitrium_Deep_Link',
    'Active',
  ];

  const valueRows = apps.map(app => {
    const vals = cols.map(col => sqlVal(app[col]));
    return `(${vals.join(', ')})`;
  });

  return `INSERT OR REPLACE INTO applications (${cols.join(', ')})\nVALUES\n${valueRows.join(',\n')};\n`;
}

function sqlVal(v) {
  if (v === null || v === undefined || v === '') return 'NULL';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? '1' : '0';
  // Escape single quotes
  return `'${String(v).replace(/'/g, "''")}'`;
}

function normalizeKeys(obj) {
  // Handle both camelCase and original column name formats
  return obj; // pass-through; source should match column names exactly
}

function generateCode(app, idx) {
  const standard = (app.Standard || app.standard || 'STD').replace(/[^A-Z0-9-]/gi, '');
  const row = idx + 1;
  return `${standard}_row_${row}`;
}

function parseCSV(raw) {
  const lines = raw.split('\n').filter(l => l.trim());
  const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
  return lines.slice(1).map(line => {
    const vals = parseCSVLine(line);
    return Object.fromEntries(headers.map((h, i) => [h, vals[i] || null]));
  });
}

function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') {
      inQuotes = !inQuotes;
    } else if (line[i] === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += line[i];
    }
  }
  result.push(current.trim());
  return result;
}

// Need writeFileSync imported
import { writeFileSync } from 'fs';

main().catch(err => {
  console.error('\n✗ Fatal error:', err.message);
  process.exit(1);
});
