#!/usr/bin/env node
/**
 * Quick PDF Inspector — dump raw lines from pages that look like tables.
 *
 * Usage:
 *   node scripts/inspect-pdf-lines.js --file pdfs/X.pdf [--page 5] [--all]
 *
 * Without --page, finds the first page with a "Table" heading and dumps it.
 * With --all, dumps every page that contains "Table" or has dense numeric data.
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';
import { parsePDFNode } from '../src/lib/pdf-parser.js';

const args = process.argv.slice(2);
const fileArg = args.indexOf('--file');
const pageArg = args.indexOf('--page');
const all = args.includes('--all');

if (fileArg < 0) {
  console.error('Usage: node scripts/inspect-pdf-lines.js --file pdfs/X.pdf [--page N] [--all]');
  process.exit(1);
}

const filePath = resolve(process.cwd(), args[fileArg + 1]);
const targetPage = pageArg >= 0 ? parseInt(args[pageArg + 1], 10) : null;

const pdfBytes = new Uint8Array(readFileSync(filePath));
const { pages } = await parsePDFNode(pdfBytes);

console.log(`Total pages: ${pages.length}\n`);

const TABLE_TITLE = /Table\s+[A-Z]?-?\d+/i;

// A "real table page" has many short lines with leading capital + numeric data
function isTablePage(page) {
  const lines = page.lines || [];
  if (lines.length < 20) return false;
  // Count lines that look like data: short, contain numbers, not paragraph text
  const numericLines = lines.filter(l => {
    const t = l.text.trim();
    return t.length < 80 && /\d/.test(t) && !/[.,]\s+[a-z]/.test(t);
  }).length;
  return numericLines > lines.length * 0.4;
}

const candidates = pages.filter(p => {
  if (targetPage) return p.number === targetPage;
  if (all) return isTablePage(p);
  return isTablePage(p);
});

console.log(`Found ${candidates.length} candidate table pages: ${candidates.map(p => p.number).join(', ')}\n`);
const toDump = all ? candidates : candidates.slice(0, 2);

for (const page of toDump) {
  console.log(`\n${'═'.repeat(80)}`);
  console.log(`PAGE ${page.number}`);
  console.log('═'.repeat(80));
  for (const line of page.lines) {
    const x = line.x?.toFixed(1).padStart(6) || '   ?  ';
    const fs = line.fontSize?.toFixed(1).padStart(4) || '?';
    const b = line.bold ? 'B' : ' ';
    console.log(`  x=${x} fs=${fs}${b} | ${line.text}`);
  }
}
