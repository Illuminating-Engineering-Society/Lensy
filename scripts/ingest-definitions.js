#!/usr/bin/env node
/**
 * Ingest the ANSI/IES LS-1 definitions (client feedback DO33)
 *
 * Adds a "Definitions" content type to Lensy: a filter that searches ONLY the
 * LS-1 terminology published at https://ies.org/standards/definitions/, and a
 * result card that prints the full definition — emphasis, inline math and images
 * included — titled with the current LS-1 designation.
 *
 * The definitions page is a WordPress `glossary` custom post type, so this reads
 * the REST collection rather than scraping the A–Z index:
 *
 *   https://ies.org/wp-json/wp/v2/glossary?per_page=100&page=N&_fields=…
 *
 * Pipeline
 *   1. Page through the collection (X-WP-TotalPages tells us how many)
 *   2. Normalize each post: term, LS-1 clause number, sanitized rich text, plain text
 *   3. POST batches to /api/ingest/definitions, which embeds them into the main
 *      Vectorize index (chunk_type='definition') and upserts the D1 rows
 *
 * Usage
 *   node scripts/ingest-definitions.js                    # against LUCIUS_API_URL
 *   node scripts/ingest-definitions.js --local            # against wrangler dev
 *   node scripts/ingest-definitions.js --dry-run          # fetch + normalize only
 *   node scripts/ingest-definitions.js --limit 50         # first N definitions
 *   node scripts/ingest-definitions.js --out defs.json    # save the normalized set
 *
 * Options
 *   --local          Target http://localhost:8787
 *   --dry-run        Do everything except POST
 *   --limit <n>      Stop after n definitions (smoke tests; implies --no-prune)
 *   --out <path>     Write the normalized definitions to a JSON file
 *   --source <url>   Override the glossary REST endpoint
 *   --no-prune       Keep definitions IES has retired (default is to remove them)
 *   --verbose        Print every definition as it is normalized
 *
 * Environment
 *   LUCIUS_API_URL     Worker base URL (default http://localhost:8787)
 *   LUCIUS_API_SECRET  Bearer token for the ingest endpoints
 *
 * Re-run whenever IES publishes new or revised terminology — the upsert is
 * idempotent, keyed on the definition's slug.
 */

import { writeFileSync } from 'fs';
import { resolve } from 'path';
import {
  DEFINITIONS_STANDARD_ID,
  normalizeGlossaryPost,
} from '../src/lib/definitions.js';

const args = process.argv.slice(2);

function flag(name) { return args.includes(name); }
function value(name, fallback = null) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

const CONFIG = {
  apiUrl: flag('--local')
    ? 'http://localhost:8787'
    : (process.env.LUCIUS_API_URL || 'http://localhost:8787'),
  apiSecret: process.env.LUCIUS_API_SECRET || null,
  source: value('--source', 'https://ies.org/wp-json/wp/v2/glossary'),
  dryRun: flag('--dry-run'),
  verbose: flag('--verbose'),
  limit: value('--limit') ? Number(value('--limit')) : null,
  out: value('--out'),
  // --limit fetches a SUBSET, so pruning against it would delete every
  // definition outside that subset. Refuse automatically rather than rely on the
  // operator remembering --no-prune.
  noPrune: flag('--no-prune') || !!value('--limit'),
};

// The REST collection caps per_page at 100. Batches POSTed to the Worker are
// smaller: each definition carries its full rich text, and the Worker embeds the
// whole batch in one Workers AI call.
const FETCH_PER_PAGE = 100;
const POST_BATCH = 50;
const FETCH_RETRIES = 3;

async function main() {
  console.log('\nANSI/IES LS-1 definitions → Lensy');
  console.log(`  Source: ${CONFIG.source}`);
  console.log(`  Target: ${CONFIG.dryRun ? '(dry run)' : CONFIG.apiUrl}`);

  const posts = await fetchAllGlossaryPosts();
  console.log(`  Fetched: ${posts.length} glossary entries`);

  const definitions = [];
  const skipped = [];
  for (const post of posts) {
    const normalized = normalizeGlossaryPost(post);
    if (!normalized) { skipped.push(post?.slug || '(no slug)'); continue; }
    definitions.push(normalized);
    if (CONFIG.verbose) {
      console.log(`    [${normalized.clause || '—'}] ${normalized.term}: ${normalized.text.slice(0, 90)}…`);
    }
  }

  console.log(`  Normalized: ${definitions.length}${skipped.length ? `, skipped ${skipped.length} (${skipped.slice(0, 5).join(', ')}${skipped.length > 5 ? ', …' : ''})` : ''}`);
  const withClause = definitions.filter(d => d.clause).length;
  console.log(`  With an LS-1 clause number: ${withClause}/${definitions.length}`);

  if (CONFIG.out) {
    const path = resolve(process.cwd(), CONFIG.out);
    writeFileSync(path, JSON.stringify(definitions, null, 2));
    console.log(`  Written: ${path}`);
  }

  if (definitions.length === 0) {
    console.error('\n✗ No definitions to index — check --source and the endpoint shape.\n');
    process.exit(1);
  }

  if (CONFIG.dryRun) {
    console.log(`\n[DRY RUN] Would POST ${definitions.length} definitions in ${Math.ceil(definitions.length / POST_BATCH)} batches.\n`);
    return;
  }

  let indexed = 0;
  for (let i = 0; i < definitions.length; i += POST_BATCH) {
    const batch = definitions.slice(i, i + POST_BATCH);
    const result = await postToWorker('/api/ingest/definitions', {
      standardId: DEFINITIONS_STANDARD_ID,
      definitions: batch,
    });
    indexed += result.definitionsIndexed || 0;
    console.log(`  Indexed ${indexed}/${definitions.length}`);
  }

  // Prune terms IES has retired: the upsert refreshes what still exists but
  // cannot know what disappeared, and a Definition card citing a definition that
  // is no longer published is worse than no card. The Worker refuses an empty
  // keep-list, so a failed fetch can never wipe the glossary.
  if (!CONFIG.noPrune) {
    const pruned = await postToWorker('/api/ingest/definitions/prune', {
      keepSlugs: definitions.map(d => d.slug),
    });
    if (pruned.deleted > 0) {
      console.log(`  Pruned ${pruned.deleted} retired definition(s) (${pruned.vectorsDeleted || 0} vectors): ` +
        `${(pruned.sample || []).slice(0, 5).join(', ')}${pruned.deleted > 5 ? ', …' : ''}`);
    }
  }

  console.log(`\n✓ ${indexed} definitions indexed as ${DEFINITIONS_STANDARD_ID}.\n`);
}

/**
 * Page through the glossary collection. X-WP-TotalPages is authoritative; the
 * loop also stops on an empty page so a header-less proxy cannot spin it.
 */
async function fetchAllGlossaryPosts() {
  const posts = [];
  let totalPages = 1;

  for (let page = 1; page <= totalPages; page++) {
    const url = `${CONFIG.source}?per_page=${FETCH_PER_PAGE}&page=${page}` +
      '&orderby=title&order=asc&_fields=id,slug,link,title,content';
    const res = await fetchWithRetry(url);

    if (page === 1) {
      const headerTotal = Number(res.headers.get('x-wp-totalpages'));
      if (Number.isFinite(headerTotal) && headerTotal > 0) totalPages = headerTotal;
      const totalItems = res.headers.get('x-wp-total');
      if (totalItems) console.log(`  Collection reports ${totalItems} definitions across ${totalPages} pages`);
    }

    const batch = await res.json();
    if (!Array.isArray(batch) || batch.length === 0) break;
    posts.push(...batch);

    if (CONFIG.limit && posts.length >= CONFIG.limit) return posts.slice(0, CONFIG.limit);
  }

  return CONFIG.limit ? posts.slice(0, CONFIG.limit) : posts;
}

async function fetchWithRetry(url) {
  let lastErr;
  for (let attempt = 1; attempt <= FETCH_RETRIES; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { Accept: 'application/json', 'User-Agent': 'Lensy-Definitions-Ingest/1.0' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
      return res;
    } catch (err) {
      lastErr = err;
      if (attempt < FETCH_RETRIES) await new Promise(r => setTimeout(r, attempt * 1500));
    }
  }
  throw lastErr;
}

async function postToWorker(path, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (CONFIG.apiSecret) headers.Authorization = `Bearer ${CONFIG.apiSecret}`;

  const res = await fetch(`${CONFIG.apiUrl}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) {
    throw new Error(`${path} → HTTP ${res.status}: ${json.error || text.slice(0, 300)}`);
  }
  return json;
}

main().catch(err => {
  console.error(`\n✗ ${err.message}\n`);
  process.exit(1);
});
