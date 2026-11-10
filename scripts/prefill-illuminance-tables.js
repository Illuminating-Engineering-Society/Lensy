#!/usr/bin/env node
/**
 * Pre-fill the "List Illuminance Tables" entries from the index (Dan, Teams
 * 2026-11-10: "Yes - pre-filling would be very helpful").
 *
 * For every CURRENT standard this writes the same suggestions Admin → Standards
 * → Edit → "Suggest from index…" offers (src/lib/illuminance-tables.js):
 *   • every table search returns illuminance rows from (applications.Table_Ref),
 *     titled from its ingest caption, at its first page;
 *   • on a standard with no such rows, a table whose caption reads like an
 *     illuminance/criteria table (RP-8-25+E2's Table 17-1 / 17-2) — reported
 *     in the dry run, written only with --captions, since a caption match is
 *     a weaker signal than rows search actually returns.
 *
 * What it never does:
 *   • tick "Has illuminance table?" — the list is PRE-FILLED, not published.
 *     A standard reaches the public page only when staff open Edit, check each
 *     title and page against the PDF, and tick the box ("these are extremely
 *     sensitive data sets").
 *   • touch a standard that already has a list (staff work is never replaced).
 *
 * Needs migration 0030 on the target database.
 *
 *   node scripts/prefill-illuminance-tables.js             # dry run (production, read-only)
 *   node scripts/prefill-illuminance-tables.js --captions  # dry run incl. caption-only standards
 *   node scripts/prefill-illuminance-tables.js --apply     # write to production D1
 *   add --local to target the local D1
 */

import { execSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { suggestIlluminanceTables, validateIlluminanceTables, reviewNoteFor } from '../src/lib/illuminance-tables.js';
import { parsePageLabels } from '../src/lib/page-labels.js';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const CAPTIONS = args.includes('--captions');
const TARGET = args.includes('--local') ? '--local' : '--remote';

function d1Json(sql) {
  const out = execSync(`npx wrangler d1 execute ies-metadata ${TARGET} --json --command "${sql}"`,
    { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  const parsed = JSON.parse(out.slice(out.indexOf('[')));
  return parsed[0]?.results || [];
}

const standards = d1Json(
  "SELECT id, page_count, page_labels_json, assets_json FROM standards WHERE status = 'Active' ORDER BY id",
);
// Read apart so a dry run works before migration 0030; --apply needs it.
let existing = new Map();
try {
  existing = new Map(d1Json('SELECT id, illuminance_tables_json FROM standards WHERE illuminance_tables_json IS NOT NULL')
    .map(r => [r.id, r.illuminance_tables_json]));
} catch {
  if (APPLY) { console.error('Migration 0030 is not applied on this database — run `npm run db:migrate:remote` first.'); process.exit(1); }
  console.log('(migration 0030 not applied yet — dry run assumes no existing lists)');
}
for (const s of standards) s.illuminance_tables_json = existing.get(s.id) || null;
const appRows = d1Json(
  "SELECT Standard AS standard, Table_Ref AS ref, MIN(Page_Number) AS firstPage, MAX(Page_Number) AS lastPage, COUNT(*) AS n FROM applications WHERE Active = 1 AND Table_Ref IS NOT NULL AND Table_Ref <> '' GROUP BY Standard, Table_Ref",
);
const appTables = new Map();
for (const r of appRows) {
  if (!appTables.has(r.standard)) appTables.set(r.standard, []);
  appTables.get(r.standard).push(r);
}

const sqlQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;
const updates = [];
const skipped = [];
for (const s of standards) {
  const tables = appTables.get(s.id) || [];
  let assets = [];
  try { assets = s.assets_json ? JSON.parse(s.assets_json) : []; } catch { assets = []; }
  const labels = parsePageLabels(s.page_labels_json);
  const all = suggestIlluminanceTables({
    appTables: tables.map(t => ({ ref: t.ref, firstPage: t.firstPage, lastPage: t.lastPage })),
    assets: Array.isArray(assets) ? assets : [],
    labels,
  });
  // A standard with search rows gets exactly its search tables; caption-only
  // suggestions there are left to "Suggest from index…" in Edit.
  const picked = tables.length ? all.filter(x => x.source === 'search') : all;
  if (picked.length === 0) continue;
  const captionOnly = tables.length === 0;
  if (s.illuminance_tables_json) { skipped.push(`${s.id} (already has a list — left alone)`); continue; }
  // Run them through the same validator the PATCH uses, so the stored shape is
  // exactly what a staff save would have produced.
  const checked = validateIlluminanceTables(picked.map(x => ({ title: x.title, page: x.label })),
    { labels, pageCount: s.page_count });
  if (checked.error) { skipped.push(`${s.id} (${checked.error})`); continue; }
  // Each row carries its review note (shown in Edit, dropped on the staff save).
  const stored = checked.tables.map((t, i) => ({ ...t, note: reviewNoteFor(picked[i]) }));

  console.log(`\n${s.id}${captionOnly ? '  [caption match only]' : ''}`);
  stored.forEach((t, i) => {
    const flags = picked[i].flags || [];
    const mark = flags.length ? `  [${flags.join(', ')}${picked[i].searchRef ? ` — rows say "${picked[i].searchRef}"` : ''}]` : '';
    console.log(`  p. ${String(t.label ?? t.page).padEnd(5)} (pdf ${String(t.page).padStart(3)})  ${t.title}${mark}`);
  });
  if (captionOnly && !CAPTIONS) { skipped.push(`${s.id} (caption match only — pass --captions to include)`); continue; }
  updates.push(`UPDATE standards SET illuminance_tables_json = ${sqlQuote(JSON.stringify(stored))}, updated_at = CURRENT_TIMESTAMP WHERE id = ${sqlQuote(s.id)} AND illuminance_tables_json IS NULL;`);
}

if (skipped.length) console.log(`\nNot written:\n  ${skipped.join('\n  ')}`);
console.log(`\n${updates.length} standard(s) to pre-fill. "Has illuminance table?" stays unticked on all of them.`);

if (!APPLY) {
  console.log('Dry run — nothing written. Re-run with --apply.');
  process.exit(0);
}
if (updates.length === 0) process.exit(0);
const dir = mkdtempSync(join(tmpdir(), 'prefill-it-'));
const sqlFile = join(dir, 'prefill.sql');
writeFileSync(sqlFile, updates.join('\n') + '\n');
execSync(`npx wrangler d1 execute ies-metadata ${TARGET} --file="${sqlFile}"`, { stdio: 'inherit' });
console.log(`Pre-filled ${updates.length} standard(s). Staff: Admin → Standards → Edit → check each table → tick "Has illuminance table?".`);
