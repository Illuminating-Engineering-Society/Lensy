#!/usr/bin/env node
/**
 * Audit the illuminance rows in D1 against a fresh reading of each PDF.
 *
 * Client, Teams 11/12/26 #3: "RP-8 illuminance table results are missing
 * vertical illuminance data … Any way to check whether this is isolated to
 * RP-8 only?" This is that check, for every standard that carries rows: each
 * PDF is read again with the current extractor and compared, row by row, with
 * what production holds. It READS ONLY — nothing is written to D1.
 *
 * Usage:
 *   node scripts/audit-illuminance-rows.js                    # every table standard
 *   node scripts/audit-illuminance-rows.js --standard RP-8-25+E2
 *   node scripts/audit-illuminance-rows.js --details          # print every differing row
 *   node scripts/audit-illuminance-rows.js --json out.json    # the full diff
 *   node scripts/audit-illuminance-rows.js --local            # compare with the local D1
 *
 * The PDF is the PRODUCTION file — the standard's object in R2, downloaded
 * once into a temp folder — because that is the file the stored page numbers
 * belong to; the copies under pdfs/ are not always the same printing (RP-29-25
 * and RP-6-24 are a page off). `--local-pdfs` reads pdfs/ instead.
 *
 * Differences are grouped by what they mean:
 *   planes      a value moved between Horizontal and Vertical, or appeared
 *   categories  a Category letter changed (mostly letters that were never one)
 *   names       the application path changed
 *   heights     the same height at the PDF's own precision (0.8 → 0.76)
 *   other       basis, uniformity, Area/Task
 *
 * APPLYING what the audit shows — only on request:
 *   node scripts/audit-illuminance-rows.js --apply
 * writes the corrected values into the rows that changed, matched by row code.
 * It touches only a standard whose row count and row codes are the same on
 * both sides (every standard but RP-8-25+E2 on 2026-11-12); before writing it
 * saves the rows' current values beside the SQL it runs, so the change can be
 * read back or undone. A standard whose row COUNT changes is never patched —
 * its codes shift — and is re-ingested instead:
 *   node scripts/ingest-pdfs.js --file <pdf> --id <standard> --applications-only
 * Afterwards: Admin → Maintenance → "Re-index illuminance rows" (names feed
 * the row vectors) and "Flush search cache".
 */

import { execSync } from 'child_process';
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, mkdirSync } from 'fs';
import { resolve, join, basename } from 'path';
import { tmpdir } from 'os';
import { parsePDFNode } from '../src/lib/pdf-parser.js';
import { extractApplicationsFromPages } from '../src/lib/applications-extractor.js';
import { deriveStandardId, inferFullDesignation } from '../src/lib/standard-id.js';

const args = process.argv.slice(2);
const value = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };
const ONLY = value('--standard');
const JSON_OUT = value('--json');
const DETAILS = args.includes('--details');
const TARGET = args.includes('--local') ? '--local' : '--remote';
const LOCAL_PDFS = args.includes('--local-pdfs');
const APPLY = args.includes('--apply');

/** Every column a corrected row rewrites: its name and both planes. */
const WRITTEN = [
  'App', 'App_s1', 'App_s2', 'App_s3', 'App_s4', 'App_s5', 'App_s6',
  'Area_or_Task', 'Veiling_Risk', 'TM24_Eligible',
  'Hor_Cat', 'Hor_Lux', 'Hor_Fc', 'Hor_Height_m', 'Hor_Height_ft', 'Hor_Avg_Max_Min',
  'Hor_Uniformity', 'Hor_CV', 'Hor_Ratio_Basis',
  'Ver_Cat', 'Ver_Lux', 'Ver_Fc', 'Ver_Height_m', 'Ver_Height_ft', 'Ver_Avg_Max_Min',
  'Ver_Uniformity', 'Ver_CV', 'Ver_Ratio_Basis',
];
const sqlValue = (v) => {
  if (v == null || v === '') return 'NULL';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  return `'${String(v).replace(/'/g, "''")}'`;
};
const BUCKET = 'ies-standards-pdfs';

/** The fields a reader sees on an Illuminance Table card. */
const COMPARED = [
  'Hor_Cat', 'Hor_Lux', 'Hor_Height_m', 'Hor_Avg_Max_Min', 'Hor_Uniformity',
  'Ver_Cat', 'Ver_Lux', 'Ver_Height_m', 'Ver_Avg_Max_Min', 'Ver_Uniformity',
  'Area_or_Task',
];
const PATH = ['App', 'App_s1', 'App_s2', 'App_s3', 'App_s4', 'App_s5', 'App_s6'];

function d1Json(sql) {
  const out = execSync(`npx wrangler d1 execute ies-metadata ${TARGET} --json --command "${sql}"`,
    { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  const parsed = JSON.parse(out);
  return (Array.isArray(parsed) ? parsed[0] : parsed).results || [];
}

function localPdfs(dir, out = new Map()) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (!/deprecated|others/i.test(name)) localPdfs(full, out);
    } else if (/\.pdf$/i.test(name)) {
      try { out.set(deriveStandardId(name), full); } catch { /* not a standard's file name */ }
    }
  }
  return out;
}

function fetchFromR2(standard) {
  const rows = d1Json(`SELECT r2_key FROM standards WHERE id = '${standard.replace(/'/g, "''")}'`);
  const key = rows[0]?.r2_key;
  if (!key) return null;
  const dir = join(tmpdir(), 'lens-audit-pdfs');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const file = join(dir, `${standard.replace(/[^A-Za-z0-9.+-]/g, '_')}.pdf`);
  if (!existsSync(file)) {
    // Wrangler 3's `r2 object get` is remote by default and rejects --remote.
    execSync(`npx wrangler r2 object get "${BUCKET}/${key}" ${TARGET === '--local' ? '--local ' : ''}--file="${file}"`,
      { stdio: ['ignore', 'ignore', 'pipe'] });
  }
  return file;
}

const pathOf = (row) => PATH.map(c => String(row[c] ?? '').trim()).filter(Boolean).join(' > ');
const same = (a, b) => {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  const na = Number(a), nb = Number(b);
  if (!Number.isNaN(na) && !Number.isNaN(nb) && String(a).trim() !== '' && String(b).trim() !== '') return na === nb;
  return String(a).trim() === String(b).trim();
};

/** Which kind of difference one changed field is (see the header). */
function kindOf(f) {
  if (f.field === 'name') return 'names';
  if (f.field === 'Hor_Lux' || f.field === 'Ver_Lux') return 'planes';
  if (f.field === 'Hor_Cat' || f.field === 'Ver_Cat') return 'categories';
  if (f.field === 'Hor_Height_m' || f.field === 'Ver_Height_m') {
    const a = Number(f.stored), b = Number(f.fresh);
    const precision = f.stored != null && f.fresh != null && Math.abs(a - b) < 0.06;
    return precision ? 'heights' : 'planes';
  }
  return 'other';
}

/**
 * Pair D1's rows with the fresh ones, page by page. A page with the same
 * number of rows on both sides is paired in table order (so a corrected NAME
 * shows as a change, not as a removal plus an addition); otherwise rows are
 * paired by name, and what is left over is reported as removed or added.
 */
function comparePage(stored, fresh) {
  const changed = [], removed = [], added = [];
  const diff = (a, b) => {
    // A basis or uniformity on a plane neither side prints a value for says nothing.
    const planeAbsent = (f) => (f.startsWith('Hor_') && a.Hor_Lux == null && b.Hor_Lux == null)
      || (f.startsWith('Ver_') && a.Ver_Lux == null && b.Ver_Lux == null);
    const fields = COMPARED.filter(f => !same(a[f], b[f]) && !planeAbsent(f))
      .map(f => ({ field: f, stored: a[f] ?? null, fresh: b[f] ?? null }));
    if (pathOf(a) !== pathOf(b)) fields.unshift({ field: 'name', stored: pathOf(a), fresh: pathOf(b) });
    if (fields.length) changed.push({ code: a.code, page: a.Page_Number, name: pathOf(b), fields });
  };
  if (stored.length === fresh.length) {
    stored.forEach((row, i) => diff(row, fresh[i]));
    return { changed, removed, added };
  }
  const pool = fresh.map(r => ({ row: r, used: false }));
  for (const row of stored) {
    const hit = pool.find(p => !p.used && pathOf(p.row) === pathOf(row));
    if (hit) { hit.used = true; diff(row, hit.row); }
    else removed.push({ code: row.code, page: row.Page_Number, name: pathOf(row), Hor_Lux: row.Hor_Lux, Ver_Lux: row.Ver_Lux });
  }
  for (const p of pool) {
    if (!p.used) added.push({ page: p.row.Page_Number, name: pathOf(p.row), Hor_Lux: p.row.Hor_Lux, Ver_Lux: p.row.Ver_Lux });
  }
  return { changed, removed, added };
}

async function main() {
  const standards = d1Json(
    "SELECT a.Standard AS id, COUNT(*) AS n FROM applications a LEFT JOIN standards s ON s.id = a.Standard" +
    " WHERE a.Active = 1 AND (s.status IS NULL OR s.status <> 'Deprecated') GROUP BY a.Standard ORDER BY a.Standard"
  ).filter(s => !ONLY || s.id === ONLY);
  if (standards.length === 0) { console.error(ONLY ? `No rows for ${ONLY}.` : 'No illuminance rows found.'); process.exit(1); }

  const pdfs = localPdfs(resolve(process.cwd(), 'pdfs'));
  const report = [];

  for (const { id, n } of standards) {
    let file = null;
    let source = 'R2';
    if (LOCAL_PDFS) {
      file = pdfs.get(id) || null;
      source = 'local';
    } else {
      try { file = fetchFromR2(id); } catch (err) { source = `R2 failed: ${String(err.message || err).slice(0, 80)}`; }
    }
    if (!file) { console.log(`${id.padEnd(14)} no PDF available (${source}) — not audited`); report.push({ id, audited: false }); continue; }

    const { pages } = await parsePDFNode(new Uint8Array(readFileSync(file)));
    const fresh = extractApplicationsFromPages(pages, id, { fullDesignation: inferFullDesignation(id) });
    const stored = d1Json(
      `SELECT code, Page_Number, ${PATH.join(', ')}, ${COMPARED.join(', ')} FROM applications` +
      ` WHERE Active = 1 AND Standard = '${id.replace(/'/g, "''")}' ORDER BY code`
    );

    const pageNumbers = [...new Set([...stored, ...fresh].map(r => Number(r.Page_Number)))].sort((a, b) => a - b);
    const result = { id, audited: true, source, file: basename(file), stored: stored.length, fresh: fresh.length, changed: [], removed: [], added: [] };
    for (const page of pageNumbers) {
      const part = comparePage(
        stored.filter(r => Number(r.Page_Number) === page),
        fresh.filter(r => Number(r.Page_Number) === page),
      );
      result.changed.push(...part.changed);
      result.removed.push(...part.removed);
      result.added.push(...part.added);
    }
    report.push(result);

    // What --apply would write: the fresh values of each changed row, by code.
    // Only when both sides list the same codes in the same order.
    const sameCodes = stored.length === fresh.length && stored.every((row, i) => row.code === fresh[i].code);
    result.patchable = sameCodes && result.removed.length === 0 && result.added.length === 0;
    result.updates = [];
    if (result.patchable) {
      const freshByCode = new Map(fresh.map(r => [r.code, r]));
      for (const c of result.changed) {
        const row = freshByCode.get(c.code);
        if (!row) continue;
        result.updates.push(
          `UPDATE applications SET ${WRITTEN.map(col => `${col} = ${sqlValue(row[col])}`).join(', ')}` +
          ` WHERE code = ${sqlValue(c.code)} AND Standard = ${sqlValue(id)};`
        );
      }
    }

    // What each changed row MEANS, counted once per row and kind.
    const kinds = { planes: 0, categories: 0, names: 0, heights: 0, other: 0 };
    for (const c of result.changed) {
      c.kinds = [...new Set(c.fields.map(kindOf))];
      for (const k of c.kinds) kinds[k]++;
    }
    result.kinds = kinds;
    const pagesHit = [...new Set([...result.changed.filter(c => c.kinds.some(k => k !== 'heights')), ...result.removed, ...result.added]
      .map(r => r.page))].sort((a, b) => a - b);
    const clean = !result.changed.length && !result.removed.length && !result.added.length;
    console.log(`${id.padEnd(14)} D1 ${String(n).padStart(4)} rows · fresh ${String(fresh.length).padStart(4)} · ` + (clean
      ? 'identical'
      : `planes ${kinds.planes} · categories ${kinds.categories} · names ${kinds.names} · other ${kinds.other}`
        + ` · heights ${kinds.heights} · only in D1 ${result.removed.length} · only in PDF ${result.added.length}`
        + (pagesHit.length ? ` · pages ${pagesHit.join(', ')}` : '')));
    if (DETAILS) {
      for (const c of result.changed) {
        console.log(`    ~ p.${c.page} ${c.code}  ${c.name}`);
        for (const f of c.fields) console.log(`        ${f.field}: ${JSON.stringify(f.stored)} → ${JSON.stringify(f.fresh)}`);
      }
      for (const r of result.removed) console.log(`    - p.${r.page} ${r.code}  ${r.name}  (H ${r.Hor_Lux ?? '—'} / V ${r.Ver_Lux ?? '—'})`);
      for (const r of result.added) console.log(`    + p.${r.page} ${r.name}  (H ${r.Hor_Lux ?? '—'} / V ${r.Ver_Lux ?? '—'})`);
    }
  }

  if (JSON_OUT) {
    writeFileSync(resolve(process.cwd(), JSON_OUT), JSON.stringify(report, null, 2));
    console.log(`\nFull diff written to ${JSON_OUT}`);
  }
  const differing = report.filter(r => r.audited && (r.changed.length || r.removed.length || r.added.length));
  console.log(`\n${report.filter(r => r.audited).length} standards audited · ${differing.length} differ from D1` +
    (differing.length ? `: ${differing.map(r => r.id).join(', ')}` : ''));

  const unpatchable = differing.filter(r => !r.patchable);
  if (unpatchable.length) {
    console.log(`Row count or codes changed — re-ingest instead of patching: ${unpatchable.map(r => r.id).join(', ')}`);
  }
  const updates = differing.filter(r => r.patchable).flatMap(r => r.updates);
  if (!APPLY) {
    if (updates.length) console.log(`--apply would rewrite ${updates.length} rows in ${differing.filter(r => r.patchable).length} standards.`);
    return;
  }
  if (!updates.length) { console.log('Nothing to apply.'); return; }

  // Keep what is being replaced, then write.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = join(tmpdir(), 'lens-audit-apply');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const backup = [];
  for (const r of differing.filter(x => x.patchable)) {
    const codes = r.changed.map(c => `'${c.code.replace(/'/g, "''")}'`);
    for (let i = 0; i < codes.length; i += 80) {
      backup.push(...d1Json(`SELECT code, Standard, ${WRITTEN.join(', ')} FROM applications WHERE code IN (${codes.slice(i, i + 80).join(',')})`));
    }
  }
  const backupFile = join(dir, `before-${stamp}.json`);
  const sqlFile = join(dir, `apply-${stamp}.sql`);
  writeFileSync(backupFile, JSON.stringify(backup, null, 2));
  writeFileSync(sqlFile, updates.join('\n') + '\n');
  console.log(`\nPrevious values of ${backup.length} rows saved to ${backupFile}`);
  console.log(`Applying ${updates.length} updates (${sqlFile}) …`);
  execSync(`npx wrangler d1 execute ies-metadata ${TARGET} --file="${sqlFile}"`, { stdio: 'inherit' });
  console.log('Applied. Next: Admin → Maintenance → Re-index illuminance rows, then Flush search cache.');
}

main().catch(err => { console.error(err); process.exit(1); });
