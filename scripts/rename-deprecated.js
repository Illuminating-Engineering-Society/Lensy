#!/usr/bin/env node
/**
 * Rename deprecated standard PDFs to canonical "<STANDARD-ID>.pdf" filenames,
 * consistent with the current-standards folders (e.g. "RP-1-24.pdf").
 *
 *   "DG-10-12_LINKS.pdf"            → "DG-10-12.pdf"
 *   "RP-16-05 reprint2010final.pdf" → "RP-16-05.pdf"
 *   "LM-73-18 (R2023).pdf"          → "LM-73-18.pdf"
 *
 * The target name is exactly what deriveStandardId() in ingest-pdfs.js will
 * produce, so filename and ingested standard ID always agree.
 *
 * Never renames blindly over a conflict. Two cases are reported and skipped:
 *
 *   REDUNDANT COPY — two deprecated files reduce to the same ID (e.g. a
 *     "(low res)" copy next to the full-res one, or a pre-reaffirmation
 *     printing next to its "(R##)+E#" reprint). The preferred file (larger,
 *     or carrying errata) is renamed; the other is left untouched and listed
 *     for manual review/deletion. Ingestion also dedupes by ID, so a leftover
 *     copy can never double-ingest.
 *
 *   SAME EDITION AS CURRENT — the deprecated file's ID matches a standard in
 *     the current folders (e.g. deprecated "LM-63-19.pdf" vs current
 *     "LM-63-19R25.pdf"). A reaffirmation is the same edition, not a prior
 *     one — the file is renamed normally but flagged, because ingestion will
 *     refuse to index it as deprecated.
 *
 * Usage:
 *   node scripts/rename-deprecated.js            # dry run (default)
 *   node scripts/rename-deprecated.js --apply    # perform renames
 */

import { readdirSync, renameSync, existsSync, statSync } from 'fs';
import { join, basename, extname, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEPRECATED_DIR = join(ROOT, 'pdfs', 'Deprecated Standards');
const PDFS_DIR = join(ROOT, 'pdfs');

const APPLY = process.argv.includes('--apply');

// Must stay in sync with deriveStandardId() in scripts/ingest-pdfs.js.
function deriveStandardId(file) {
  const stem = basename(file, extname(file));
  const m = stem.match(/^([A-Z]{1,3}-\d+(?:\.\d+)?(?:-\d+)?)\s*(?:\+\s*(E\d+))?/i);
  if (!m) return stem.split(/[_ ]/)[0];
  return m[2] ? `${m[1]}+${m[2]}` : m[1];
}

function collectPdfs(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'Others') continue;
      out.push(...collectPdfs(full));
    } else if (extname(entry.name).toLowerCase() === '.pdf') {
      out.push(full);
    }
  }
  return out;
}

function main() {
  if (!existsSync(DEPRECATED_DIR)) {
    console.error(`Deprecated folder not found: ${DEPRECATED_DIR}`);
    process.exit(1);
  }

  console.log(`\nDeprecated PDF rename — ${APPLY ? 'APPLY' : 'DRY RUN (pass --apply to rename)'}`);
  console.log('─'.repeat(60));

  // IDs of current (non-deprecated) standards, to flag same-edition overlaps.
  const currentIds = new Set(
    collectPdfs(PDFS_DIR)
      .filter(f => !f.includes('Deprecated Standards'))
      .map(f => deriveStandardId(basename(f)))
  );

  const files = collectPdfs(DEPRECATED_DIR).sort();

  // Group by target ID to detect redundant copies before renaming anything.
  const byId = new Map();
  for (const file of files) {
    const id = deriveStandardId(basename(file));
    if (!byId.has(id)) byId.set(id, []);
    byId.get(id).push(file);
  }

  let renamed = 0, unchanged = 0;
  const redundant = [], sameEdition = [];

  for (const [id, group] of byId) {
    // Preferred copy: the one with an errata marker in its name, else largest.
    group.sort((a, b) => {
      const ea = /\+\s*E\d+/i.test(basename(a)) ? 1 : 0;
      const eb = /\+\s*E\d+/i.test(basename(b)) ? 1 : 0;
      if (ea !== eb) return eb - ea;
      return statSync(b).size - statSync(a).size;
    });
    const [keep, ...extras] = group;
    for (const extra of extras) redundant.push({ id, keep: basename(keep), extra: basename(extra) });

    if (currentIds.has(id)) sameEdition.push({ id, file: basename(keep) });

    const target = join(dirname(keep), `${id}.pdf`);
    if (keep === target) { unchanged++; continue; }
    if (existsSync(target)) {
      console.log(`  ⚠ skip ${basename(keep)} → ${id}.pdf (target already exists)`);
      continue;
    }
    console.log(`  ${basename(keep)}  →  ${id}.pdf`);
    if (APPLY) renameSync(keep, target);
    renamed++;
  }

  console.log('─'.repeat(60));
  console.log(`${APPLY ? 'Renamed' : 'Would rename'}: ${renamed}   already canonical: ${unchanged}`);

  if (redundant.length > 0) {
    console.log(`\nRedundant copies (left untouched — same edition twice, review/delete manually):`);
    for (const r of redundant) console.log(`  ${r.id}: kept "${r.keep}", redundant "${r.extra}"`);
  }
  if (sameEdition.length > 0) {
    console.log(`\nSame edition as a CURRENT standard (reaffirmed printing — ingestion will skip these):`);
    for (const s of sameEdition) console.log(`  ${s.id}: "${s.file}"`);
  }
  console.log('');
}

main();
