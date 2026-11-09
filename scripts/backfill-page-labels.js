/**
 * Backfill standards.page_labels_json (migration 0029) for every standard
 * already indexed — the printed page numbers (Dan, Teams 2026-11-06: "P.42
 * here should print as 'p. 33' … that is all the Lens user should ever see").
 *
 * New ingests store the labels themselves (scripts/ingest-pdfs.js and the
 * staff dashboard both send pdfjs getPageLabels()); this fills in the corpus
 * indexed before that, WITHOUT re-ingesting anything.
 *
 * For each standards row: the local PDF under pdfs/ whose derived id matches
 * and whose page count equals the row's page_count (the count is the guard
 * against a local prototype that differs from what was indexed); otherwise
 * the row's own R2 object, downloaded with wrangler. The labels go through the
 * same validator the ingest uses (src/lib/page-labels.js).
 *
 * Usage:
 *   node scripts/backfill-page-labels.js            # dry run: report only
 *   node scripts/backfill-page-labels.js --apply    # write to production D1
 *   node scripts/backfill-page-labels.js --local    # target the local D1
 *   node scripts/backfill-page-labels.js --no-r2    # local PDFs only
 *   node scripts/backfill-page-labels.js --id RP-1-24
 */

import { execSync } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { deriveStandardId } from '../src/lib/standard-id.js';
import { cleanPageLabels } from '../src/lib/page-labels.js';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const LOCAL = args.includes('--local');
const NO_R2 = args.includes('--no-r2');
const ONLY = args.includes('--id') ? args[args.indexOf('--id') + 1] : null;
const TARGET = LOCAL ? '--local' : '--remote';
const BUCKET = 'ies-standards-pdfs';
const PDF_ROOT = resolve(process.cwd(), 'pdfs');

const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');

function d1Json(sql) {
  const out = execSync(`npx wrangler d1 execute ies-metadata ${TARGET} --json --command "${sql}"`,
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  return JSON.parse(out)[0].results;
}

function localPdfs() {
  const byId = new Map();
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) { if (name !== 'Others') walk(p); continue; }
      if (!/\.pdf$/i.test(name)) continue;
      const id = deriveStandardId(name);
      if (!byId.has(id)) byId.set(id, []);
      byId.get(id).push(p);
    }
  };
  if (existsSync(PDF_ROOT)) walk(PDF_ROOT);
  return byId;
}

async function readLabels(bytes) {
  const pdf = await pdfjs.getDocument({ data: bytes, verbosity: 0, useSystemFonts: true, disableFontFace: true }).promise;
  try {
    let labels = null;
    try { labels = await pdf.getPageLabels(); } catch { labels = null; }
    return { numPages: pdf.numPages, labels };
  } finally {
    await pdf.destroy();
  }
}

const rows = d1Json(
  `SELECT id, status, r2_key, page_count FROM standards${ONLY ? ` WHERE id = '${ONLY.replace(/'/g, "''")}'` : ''} ORDER BY id`,
);
const locals = localPdfs();
const tmp = mkdtempSync(join(tmpdir(), 'page-labels-'));
const updates = [];
const report = { labelled: [], none: [], refused: [], missing: [] };

for (const row of rows) {
  let source = null;
  let result = null;

  for (const path of locals.get(row.id) || []) {
    if (statSync(path).size > 400e6) continue;
    const r = await readLabels(new Uint8Array(readFileSync(path)));
    if (row.page_count == null || r.numPages === row.page_count) { source = path; result = r; break; }
  }

  if (!result && !NO_R2 && row.r2_key) {
    const file = join(tmp, `${row.id.replace(/[^\w.+-]/g, '_')}.pdf`);
    try {
      execSync(`npx wrangler r2 object get "${BUCKET}/${row.r2_key}" ${TARGET} --file="${file}"`,
        { stdio: ['ignore', 'ignore', 'ignore'] });
      result = await readLabels(new Uint8Array(readFileSync(file)));
      source = `r2:${row.r2_key}`;
    } catch {
      result = null;
    } finally {
      try { rmSync(file, { force: true }); } catch { /* ignore */ }
    }
  }

  if (!result) { report.missing.push(row.id); continue; }

  const clean = cleanPageLabels(result.labels, result.numPages);
  if (clean) {
    report.labelled.push(`${row.id}  (${source}; p.${Math.min(42, clean.length)} → "${clean[Math.min(42, clean.length) - 1]}")`);
  } else if (result.labels) {
    report.refused.push(`${row.id}  (${source}; sample ${result.labels.slice(0, 6).join(',')})`);
  } else {
    report.none.push(row.id);
  }
  updates.push(`UPDATE standards SET page_labels_json = ${clean ? `'${JSON.stringify(clean).replace(/'/g, "''")}'` : 'NULL'} WHERE id = '${row.id.replace(/'/g, "''")}';`);
}

console.log(`\nLabelled (${report.labelled.length}):\n  ${report.labelled.join('\n  ')}`);
console.log(`\nNo labels in the PDF (${report.none.length}): ${report.none.join(', ')}`);
console.log(`\nLabels refused as untrustworthy (${report.refused.length}):\n  ${report.refused.join('\n  ')}`);
console.log(`\nNo PDF found (${report.missing.length}): ${report.missing.join(', ')}`);

if (!APPLY) {
  console.log(`\nDry run — ${updates.length} UPDATE statements not written. Re-run with --apply.`);
} else if (updates.length > 0) {
  const sqlFile = join(tmp, 'page-labels.sql');
  writeFileSync(sqlFile, updates.join('\n'));
  execSync(`npx wrangler d1 execute ies-metadata ${TARGET} --file="${sqlFile}"`, { stdio: 'inherit' });
  console.log(`\nWrote ${updates.length} rows. Flush the search cache (Admin → Maintenance) so cached answers pick up printed pages.`);
}
rmSync(tmp, { recursive: true, force: true });
