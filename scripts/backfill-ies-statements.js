/**
 * Backfill standards.statements_json (migration 0032) — the IES Statements
 * printed inside standards already indexed (Dan, Teams 2026-11-19 #1: the AI
 * Guide "did not ever reference the 'IES Statement' on the inside cover of
 * TM-15-20").
 *
 * New ingests store them themselves (scripts/ingest-pdfs.js and the staff
 * dashboard both run src/lib/ies-statements.js); this fills in the corpus
 * indexed before that, WITHOUT re-ingesting anything.
 *
 * Reads the PRODUCTION PDF from R2 whenever it is there, in preference to a
 * local copy: a Statement is a page IES inserts into an existing PDF after
 * publication, so a local copy with the same id and the same page count can
 * simply not have it (TM-15-20's does not — its page 2 is blank). Where R2
 * holds no object for a standard (about 40 of the Lighting Measurements
 * series, measured 2026-11-20), the local copy under pdfs/ is read instead and
 * the report says so — a "none found" there is weaker evidence.
 *
 * Usage:
 *   node scripts/backfill-ies-statements.js                 # dry run: report only
 *   node scripts/backfill-ies-statements.js --apply         # write to production D1
 *   node scripts/backfill-ies-statements.js --id TM-15-20   # one standard
 *   node scripts/backfill-ies-statements.js --prefix LM-    # ids starting with…
 *   node scripts/backfill-ies-statements.js --all-pages     # scan whole documents (slow)
 *   node scripts/backfill-ies-statements.js --deprecated    # include deprecated editions
 *   node scripts/backfill-ies-statements.js --local         # target the local D1 / R2
 *
 * By default only the first 12 pages of each document are read — a Statement
 * sits in the front matter — and only standards where one is FOUND are
 * written, so a quick scan never erases what a full ingest stored.
 * After --apply, flush the search cache (Admin → Maintenance).
 */

import { execSync } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { parsePDFNode } from '../src/lib/pdf-parser.js';
import { detectIesStatements } from '../src/lib/ies-statements.js';
import { deriveStandardId } from '../src/lib/standard-id.js';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const LOCAL = args.includes('--local');
const ALL_PAGES = args.includes('--all-pages');
const DEPRECATED = args.includes('--deprecated');
const ONLY = args.includes('--id') ? args[args.indexOf('--id') + 1] : null;
const PREFIX = args.includes('--prefix') ? args[args.indexOf('--prefix') + 1] : null;
const TARGET = LOCAL ? '--local' : '--remote';
const BUCKET = 'ies-standards-pdfs';
const FRONT_MATTER_PAGES = 12;
const PDF_ROOT = resolve(process.cwd(), 'pdfs');

const sqlText = (v) => `'${String(v).replace(/'/g, "''")}'`;

function d1Json(sql) {
  const out = execSync(`npx wrangler d1 execute ies-metadata ${TARGET} --json --command "${sql}"`,
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  return JSON.parse(out)[0].results;
}

/** Local PDFs by derived id — current folders only, unless --deprecated. */
function localPdfs() {
  const byId = new Map();
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) {
        if (name === 'Others' || (name === 'Deprecated Standards' && !DEPRECATED)) continue;
        walk(p);
        continue;
      }
      if (!/\.pdf$/i.test(name)) continue;
      const id = deriveStandardId(name);
      if (!byId.has(id)) byId.set(id, p);
    }
  };
  if (existsSync(PDF_ROOT)) walk(PDF_ROOT);
  return byId;
}

const where = [
  ONLY ? `id = ${sqlText(ONLY)}` : null,
  PREFIX ? `id LIKE ${sqlText(`${PREFIX.replace(/[%_]/g, '')}%`)}` : null,
  DEPRECATED || ONLY ? null : "status = 'Active'",
].filter(Boolean).join(' AND ') || '1=1';
const rows = d1Json(`SELECT id, status, r2_key FROM standards WHERE ${where} ORDER BY id`);

const locals = localPdfs();
const tmp = mkdtempSync(join(tmpdir(), 'ies-statements-'));
const found = [];
const fromLocal = [];
const unread = [];
let scanned = 0;

async function scan(bytes) {
  const { pages } = await parsePDFNode(bytes, ALL_PAGES ? {} : { maxPages: FRONT_MATTER_PAGES });
  return detectIesStatements(pages);
}

for (const row of rows) {
  const file = join(tmp, `${row.id.replace(/[^\w.+-]/g, '_')}.pdf`);
  let statements = null;
  let source = null;
  try {
    if (row.r2_key) {
      // Wrangler 3's `r2 object get` is remote by default and rejects --remote.
      execSync(`npx wrangler r2 object get "${BUCKET}/${row.r2_key}" ${LOCAL ? '--local ' : ''}--file="${file}"`,
        { stdio: ['ignore', 'ignore', 'ignore'] });
      statements = await scan(new Uint8Array(readFileSync(file)));
      source = 'r2';
    }
  } catch { /* no R2 object, or unreadable: try the local copy below */ }
  finally { try { rmSync(file, { force: true }); } catch { /* ignore */ } }

  if (!statements && locals.has(row.id)) {
    try {
      statements = await scan(new Uint8Array(readFileSync(locals.get(row.id))));
      source = 'local';
      fromLocal.push(row.id);
    } catch { /* reported below */ }
  }

  if (!statements) { unread.push(row.id); process.stdout.write('x'); continue; }
  scanned++;
  if (statements.length > 0) found.push({ id: row.id, status: row.status, source, statements });
  process.stdout.write(statements.length > 0 ? `\n${row.id}: ${statements.length} statement(s) [${source}]\n` : (source === 'local' ? 'l' : '.'));
}

console.log(`\n\nScanned ${scanned} of ${rows.length} PDFs (${ALL_PAGES ? 'all pages' : `first ${FRONT_MATTER_PAGES} pages`}).`);
for (const f of found) {
  for (const s of f.statements) {
    console.log(`\n${f.id} [${f.status}, read from ${f.source}] — p. ${s.page}${s.date ? `, ${s.date}` : ''}\n  ${s.title}\n  ${s.text.length} chars: ${s.text.slice(0, 220)}…`);
  }
}
if (found.length === 0) console.log('\nNo IES Statement found.');
if (fromLocal.length > 0) {
  console.log(`\nRead from the LOCAL copy because R2 holds no object (${fromLocal.length}) — a Statement added to the published PDF later would not be in it:\n  ${fromLocal.join(', ')}`);
}
if (unread.length > 0) console.log(`\nNo PDF in R2 or under pdfs/ (${unread.length}): ${unread.join(', ')}`);

if (!APPLY) {
  console.log(`\nDry run — ${found.length} standard(s) would be updated. Re-run with --apply.`);
} else if (found.length > 0) {
  const sqlFile = join(tmp, 'ies-statements.sql');
  writeFileSync(sqlFile, found.map(f =>
    `UPDATE standards SET statements_json = ${sqlText(JSON.stringify(f.statements))} WHERE id = ${sqlText(f.id)};`).join('\n'));
  execSync(`npx wrangler d1 execute ies-metadata ${TARGET} --file="${sqlFile}"`, { stdio: 'inherit' });
  console.log(`\nWrote ${found.length} row(s). Flush the search cache (Admin → Maintenance) so cached answers pick the Statements up.`);
}
rmSync(tmp, { recursive: true, force: true });
