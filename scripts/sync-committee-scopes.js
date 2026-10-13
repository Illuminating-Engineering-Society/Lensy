#!/usr/bin/env node
/**
 * Pull each IES Technical Committee's SCOPE from Wicket into
 * src/config/committee-scopes.json (client 10/09/26 #3).
 *
 *   "Can we train Lens on each Committee's scope, as a way to improve
 *    curation? Scopes are located in Wicket in the 'Description' field for
 *    each. See Group Type = Technical, Status = Active."
 *
 * "Train" here is retrieval-side, like everything else in Lens: the scope text
 * is handed to the AI curation pass beside each result's authoring committee,
 * so a question about what a quantity IS ranks the committee whose scope is
 * nomenclature/photometry above one whose scope is an application. No model is
 * fine-tuned.
 *
 * Read-only against Wicket. Credentials come from the environment — the same
 * REST pair AuthIES uses (WICKET_API_USER_UUID + WICKET_API_SECRET, production):
 *
 *   WICKET_API_USER_UUID=… WICKET_API_SECRET=… node scripts/sync-committee-scopes.js
 *   … --dry-run      print what would be written
 *   … --probe        print the attribute names of the first groups and stop
 *
 * Optional: WICKET_API_URL (default https://ies-api.wicketcloud.com).
 */

import { createHmac } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'src/config/committee-scopes.json');
const API = (process.env.WICKET_API_URL || 'https://ies-api.wicketcloud.com').replace(/\/+$/, '');
const DRY = process.argv.includes('--dry-run');
const PROBE = process.argv.includes('--probe');

function b64url(input) {
  return Buffer.from(input).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

/** The HS256 admin JWT Wicket's REST API takes (same shape as AuthIES buildAdminJwt). */
function adminJwt(sub, secret) {
  const iat = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify({ sub, iat, exp: iat + 300 }));
  const sig = createHmac('sha256', secret).update(`${head}.${body}`).digest('base64')
    .replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${head}.${body}.${sig}`;
}

async function fetchJson(path, jwt) {
  const res = await fetch(`${API}${path}`, {
    headers: { Authorization: `Bearer ${jwt}`, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`Wicket ${res.status} on ${path}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

/** HTML or rich text → one plain paragraph. */
export function plainScope(raw) {
  return String(raw ?? '')
    .replace(/<\s*br\s*\/?>/gi, ' ')
    .replace(/<\/(p|li|div)>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"')
    .replace(/&#39;|&rsquo;|&lsquo;/g, "'").replace(/&ldquo;|&rdquo;/g, '"')
    .replace(/&ndash;|&mdash;/g, '-').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Is this group record a current Technical committee? */
export function isActiveTechnical(attrs, today = new Date().toISOString().slice(0, 10)) {
  const type = String(attrs.type ?? attrs.group_type ?? '').toLowerCase();
  if (!/technical/.test(type)) return false;
  if (attrs.active === false) return false;
  const status = String(attrs.status ?? '').toLowerCase();
  if (status && status !== 'active') return false;
  if (attrs.end_date && String(attrs.end_date).slice(0, 10) < today) return false;
  return true;
}

async function main() {
  const sub = process.env.WICKET_API_USER_UUID;
  const secret = process.env.WICKET_API_SECRET;
  if (!sub || !secret) {
    console.error('Set WICKET_API_USER_UUID and WICKET_API_SECRET (the production REST pair).');
    process.exit(2);
  }

  const groups = [];
  for (let page = 1; page <= 50; page++) {
    const jwt = adminJwt(sub, secret);   // short-lived; re-minted per page
    const data = await fetchJson(`/groups?page[number]=${page}&page[size]=100`, jwt);
    const rows = Array.isArray(data?.data) ? data.data : [];
    if (PROBE) {
      for (const g of rows.slice(0, 5)) {
        const a = g.attributes || {};
        console.log(JSON.stringify({ name: a.name, type: a.type, keys: Object.keys(a) }));
      }
      const types = {};
      for (const g of rows) { const t = String(g.attributes?.type); types[t] = (types[t] || 0) + 1; }
      console.log('types on page 1:', types, 'total pages:', data?.meta?.page?.total_pages);
      return;
    }
    groups.push(...rows);
    const total = data?.meta?.page?.total_pages;
    if (rows.length === 0 || (total && page >= total)) break;
  }

  const committees = {};
  let skippedNoScope = 0;
  for (const g of groups) {
    const a = g.attributes || {};
    if (!isActiveTechnical(a)) continue;
    const name = String(a.name_en || a.name || '').trim();
    const scope = plainScope(a.description_en || a.description);
    if (!name) continue;
    if (!scope) { skippedNoScope++; continue; }
    // Keyed by the Wicket name; src/lib/committees.js committeeScope() joins a
    // standard's `author` to it with the same name folding the registry uses.
    committees[name] = { scope: scope.slice(0, 900) };
  }

  const out = {
    _comment: 'IES Technical Committee scopes, from the Description field of each active Technical group in Wicket (client 10/09/26 #3). Written by scripts/sync-committee-scopes.js — do not edit by hand; re-run when IES revises a scope. Keyed by the committee name as Wicket prints it.',
    _syncedAt: new Date().toISOString().slice(0, 10),
    committees,
  };
  const count = Object.keys(committees).length;
  console.log(`${groups.length} groups read; ${count} active Technical committees with a scope; ${skippedNoScope} without one.`);
  if (DRY) { console.log(JSON.stringify(out, null, 2)); return; }
  let previous = null;
  try { previous = readFileSync(OUT, 'utf8'); } catch { /* first run */ }
  writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n');
  console.log(`${previous ? 'Updated' : 'Wrote'} ${OUT}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(err => { console.error(err.message || err); process.exit(1); });
}
