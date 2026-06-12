#!/usr/bin/env node
/**
 * Extract Applications from PDF — Validation & Inspection Tool
 *
 * Parse a single IES standard PDF and output the extracted application
 * records as JSON. Use this to:
 *   1. Validate extraction quality before ingesting into D1
 *   2. Compare extracted data against the legacy CSV
 *   3. Debug column mapping issues for a specific standard
 *   4. Generate the initial applications.json for bootstrap seeding
 *
 * Usage:
 *   node scripts/extract-applications-from-pdf.js --file pdfs/RP-9-20.pdf --id RP-9-20
 *   node scripts/extract-applications-from-pdf.js --file pdfs/RP-9-20.pdf --id RP-9-20 --output data/RP-9-20-apps.json
 *   node scripts/extract-applications-from-pdf.js --file pdfs/RP-9-20.pdf --id RP-9-20 --compare data/applications.csv
 *   node scripts/extract-applications-from-pdf.js --file pdfs/RP-9-20.pdf --id RP-9-20 --tables-only
 *
 * Options:
 *   --file <path>        PDF file to parse (required)
 *   --id <standardId>    Standard ID, e.g. RP-9-20 (default: filename)
 *   --output <path>      Write JSON output to file (default: stdout)
 *   --compare <path>     Compare against legacy CSV to show differences
 *   --tables-only        Show raw extracted tables instead of parsed records
 *   --column-map         Show the inferred column mapping for each table
 *   --quality            Show extraction quality report only (no data)
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, basename } from 'path';
import { parsePDFNode } from '../src/lib/pdf-parser.js';
import { extractIESTables } from '../src/lib/table-extractor.js';
import {
  extractApplicationsFromPages,
  reportExtractionQuality,
} from '../src/lib/applications-extractor.js';

const args = process.argv.slice(2);
const fileArg = args.indexOf('--file');
const idArg = args.indexOf('--id');
const outputArg = args.indexOf('--output');
const compareArg = args.indexOf('--compare');
const tablesOnly = args.includes('--tables-only');
const showColumnMap = args.includes('--column-map');
const qualityOnly = args.includes('--quality');

async function main() {
  if (fileArg < 0) {
    console.error('Usage: node scripts/extract-applications-from-pdf.js --file pdfs/RP-9-20.pdf --id RP-9-20');
    process.exit(1);
  }

  const filePath = resolve(process.cwd(), args[fileArg + 1]);
  const standardId = idArg >= 0 ? args[idArg + 1] : basename(filePath, '.pdf');

  if (!existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    process.exit(1);
  }

  console.error(`\nExtracting from: ${filePath}`);
  console.error(`Standard ID:     ${standardId}\n`);

  // Parse PDF
  console.error('Parsing PDF...');
  const pdfBytes = new Uint8Array(readFileSync(filePath));
  const { metadata, pages } = await parsePDFNode(pdfBytes);

  console.error(`Pages: ${pages.length}`);
  console.error(`Title: ${metadata.title || '(none)'}`);
  console.error(`Author: ${metadata.author || '(none)'}`);
  console.error(`Year: ${metadata.year || '(none)'}\n`);

  // Extract tables
  console.error('Extracting tables...');
  const tables = extractIESTables(pages);
  console.error(`Tables found: ${tables.length}\n`);

  if (tablesOnly) {
    outputResult(tables, outputArg >= 0 ? args[outputArg + 1] : null);
    return;
  }

  if (showColumnMap) {
    showColumnMaps(tables);
    return;
  }

  // Extract applications
  console.error('Extracting application records...');
  const standardMeta = {
    fullDesignation: `ANSI/IES ${standardId}`,
    year: metadata.year,
    author: metadata.author,
  };
  const applications = extractApplicationsFromPages(pages, standardId, standardMeta);
  console.error(`Applications extracted: ${applications.length}\n`);

  // Quality report
  const quality = reportExtractionQuality(applications);
  console.error('── Extraction Quality ──────────────────────────────────');
  console.error(`Total records:          ${quality.total}`);
  console.error(`With horizontal lux:    ${quality.withHorLux} (${quality.qualityScore}%)`);
  console.error(`With vertical lux:      ${quality.withVertical}`);
  console.error(`With illuminance cat:   ${quality.withIlluminanceCategory}`);
  console.error(`With ratio basis:       ${quality.withRatioBasis}`);
  console.error(`With App level set:     ${quality.withApp}`);
  console.error(`Hierarchy gaps:         ${quality.hierarchyGaps}`);
  console.error(`With deep hierarchy:    ${quality.withDeepHierarchy} (s4–s6)`);
  if (quality.warnings.length > 0) {
    console.error('\nWarnings:');
    for (const w of quality.warnings) console.error(`  ⚠ ${w}`);
  } else {
    console.error('No warnings.');
  }
  console.error('');

  if (qualityOnly) return;

  // Print sample records
  console.error('── Sample Records (first 5) ─────────────────────────────');
  for (const app of applications.slice(0, 5)) {
    const path = [app.Sub_Category, app.App, app.App_s1, app.App_s2, app.App_s3, app.App_s4, app.App_s5, app.App_s6].filter(Boolean).join(' › ');
    console.error(`  [${app.code}]`);
    console.error(`    ${path}`);
    console.error(`    Type: ${app.Area_or_Task}, ${app.Indoor_Outdoor}${app.Veiling_Risk ? `, Veiling=${app.Veiling_Risk}` : ''}${app.Class_of_Play ? `, Class=${app.Class_of_Play}` : ''}`);
    console.error(`    H: Cat=${app.Hor_Cat || '?'} ${app.Hor_Lux || '?'} lux (${app.Hor_Fc || '?'} fc)${app.Hor_Ratio_Basis ? ` [${app.Hor_Ratio_Basis}]` : ''}`);
    if (app.Ver_Lux) {
      console.error(`    V: Cat=${app.Ver_Cat || '?'} ${app.Ver_Lux} lux${app.Ver_Ratio_Basis ? ` [${app.Ver_Ratio_Basis}]` : ''}`);
    }
    if (app.Max_Glare_Rating || app.Max_Uplight || app.Controls_Required || app.Spectrum_Guidance) {
      console.error(`    E&V: Glare=${app.Max_Glare_Rating || '-'}, Uplight=${app.Max_Uplight || '-'}, Controls=${app.Controls_Required || '-'}, Spectrum=${app.Spectrum_Guidance || '-'}`);
    }
    console.error('');
  }

  // Compare against CSV if provided
  if (compareArg >= 0) {
    const csvPath = resolve(process.cwd(), args[compareArg + 1]);
    await compareWithCSV(applications, csvPath, standardId);
  }

  // Output JSON
  outputResult(applications, outputArg >= 0 ? args[outputArg + 1] : null);
}

// ─── Column Map Display ───────────────────────────────────────────────────────

function showColumnMaps(tables) {
  // Re-import the internal buildColumnMap by re-deriving it (it's not exported)
  // Instead, show the raw column headers per table
  for (const [i, table] of tables.entries()) {
    console.log(`\nTable ${i + 1}: ${table.title || '(no title)'}`);
    console.log(`  Page: ${table.pageNumber}`);
    console.log(`  Column headers:`);
    for (const [j, header] of (table.columnHeaders || []).entries()) {
      console.log(`    Row ${j}: "${header}"`);
    }
    console.log(`  Data rows: ${table.rows.length}`);
    if (table.rows.length > 0) {
      console.log(`  First row: ${JSON.stringify(table.rows[0])}`);
    }
  }
}

// ─── CSV Comparison ───────────────────────────────────────────────────────────

async function compareWithCSV(extracted, csvPath, standardId) {
  if (!existsSync(csvPath)) {
    console.error(`⚠ CSV file not found: ${csvPath} — skipping comparison`);
    return;
  }

  console.error(`\n── CSV Comparison: ${csvPath} ────────────────────────────`);

  const csvText = readFileSync(csvPath, 'utf8');
  const csvRecords = parseCSV(csvText)
    .filter(r => {
      const std = r.Standard || r.standard || '';
      return std.includes(standardId.replace('ANSI/IES ', ''));
    });

  console.error(`CSV records for ${standardId}: ${csvRecords.length}`);
  console.error(`Extracted records:             ${extracted.length}`);

  const csvCount = csvRecords.length;
  const extCount = extracted.length;
  const diff = extCount - csvCount;

  if (Math.abs(diff) <= 3) {
    console.error(`✓ Record counts match within tolerance (diff: ${diff > 0 ? '+' : ''}${diff})`);
  } else {
    console.error(`⚠ Record count mismatch: CSV=${csvCount}, Extracted=${extCount} (diff: ${diff > 0 ? '+' : ''}${diff})`);
  }

  // Compare lux values for first 10 matching records
  const csvByApp = new Map(csvRecords.map(r => [
    normalizeAppName(r.App_s2 || r.App_s1 || r.App || ''),
    r,
  ]));

  let luxMatches = 0;
  let luxMismatches = 0;

  for (const ext of extracted.slice(0, 20)) {
    const appKey = normalizeAppName(ext.App_s2 || ext.App_s1 || ext.App || '');
    const csv = csvByApp.get(appKey);
    if (!csv) continue;

    const csvLux = parseFloat(csv.Hor_Lux || csv.hor_lux || 0);
    const extLux = ext.Hor_Lux || 0;

    if (Math.abs(csvLux - extLux) < 1) {
      luxMatches++;
    } else {
      luxMismatches++;
      console.error(`  ⚠ Lux mismatch for "${appKey}": CSV=${csvLux}, Extracted=${extLux}`);
    }
  }

  if (luxMatches + luxMismatches > 0) {
    console.error(`Lux value match rate: ${luxMatches}/${luxMatches + luxMismatches}`);
  }
  console.error('');
}

function normalizeAppName(name) {
  return (name || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

// ─── CSV Parser ───────────────────────────────────────────────────────────────

function parseCSV(raw) {
  const lines = raw.split('\n').filter(l => l.trim());
  if (lines.length < 2) return [];

  const headers = parseCSVLine(lines[0]);
  return lines.slice(1).map(line => {
    const vals = parseCSVLine(line);
    return Object.fromEntries(headers.map((h, i) => [h.trim(), (vals[i] || '').trim()]));
  });
}

function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (const ch of line) {
    if (ch === '"') { inQuotes = !inQuotes; }
    else if (ch === ',' && !inQuotes) { result.push(current); current = ''; }
    else { current += ch; }
  }
  result.push(current);
  return result;
}

// ─── Output ───────────────────────────────────────────────────────────────────

function outputResult(data, outputPath) {
  const json = JSON.stringify(data, null, 2);
  if (outputPath) {
    const fullPath = resolve(process.cwd(), outputPath);
    writeFileSync(fullPath, json, 'utf8');
    console.error(`\nOutput written to: ${fullPath}`);
    console.error(`Records: ${data.length}`);
  } else {
    // Print to stdout (so it can be piped)
    process.stdout.write(json + '\n');
  }
}

// ─── Run ──────────────────────────────────────────────────────────────────────

main().catch(err => {
  console.error(`\n✗ Fatal error: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});
