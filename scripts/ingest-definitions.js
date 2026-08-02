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
// 50 → 25. Each definition in a batch costs one D1 statement, so a 50-item batch
// spent ~52 subrequests inside one Worker invocation (1 Workers AI call, 1
// Vectorize upsert, 50 D1 writes, 1 KV bump) — right at the edge of the
// per-request subrequest budget. Halving it also halves the blast radius when a
// batch does fail.
const POST_BATCH = 25;
const FETCH_RETRIES = 3;
const BATCH_RETRIES = 3;      // attempts per batch before bisecting
const MAX_BISECT_DEPTH = 6;   // 25 items bisects to 1 in 5 levels

async function main() {
  console.log('\nANSI/IES LS-1 definitions → Lensy');
  console.log(`  Source: ${CONFIG.source}`);
  console.log(`  Target: ${CONFIG.dryRun ? '(dry run)' : CONFIG.apiUrl}`);

  // Fail fast before fetching ~1,300 definitions over 14 requests: an
  // unreachable or unauthorized Worker should not cost the whole download.
  if (!CONFIG.dryRun) await preflight();

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

  // Distinct from the `skipped` list above, which holds posts that could not be
  // NORMALIZED. These are definitions the Worker refused to index.
  let indexed = 0;
  const notIndexed = [];
  for (let i = 0; i < definitions.length; i += POST_BATCH) {
    const batch = definitions.slice(i, i + POST_BATCH);
    const outcome = await postBatch(batch, i);
    indexed += outcome.indexed;
    notIndexed.push(...outcome.skipped);
    console.log(`  Indexed ${indexed}/${definitions.length}${notIndexed.length ? ` (${notIndexed.length} failed)` : ''}`);
  }

  if (notIndexed.length > 0) {
    console.warn(`\n⚠ ${notIndexed.length} definition(s) could not be indexed:`);
    for (const s of notIndexed) console.warn(`    ${s.slug}: ${s.reason}`);
    console.warn('  Everything else WAS indexed. Re-running retries only what is still missing.');
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
 * POST one batch, surviving both kinds of failure a 1,311-item run hits.
 *
 * A single failed batch used to abort the whole script, throwing away the work
 * already done and telling the operator only a batch number. Instead:
 *
 *   • Retryable failures (Workers AI capacity, a Vectorize hiccup — the Worker
 *     flags these) get a few attempts with backoff.
 *   • A batch that still fails is BISECTED, so the failure is attributed to the
 *     definition that actually causes it instead of to its 49 neighbours. The
 *     upsert is idempotent and keyed on slug, so re-sending halves is safe.
 *   • A single definition that fails on its own is reported and skipped; the run
 *     completes and names it.
 *
 * @returns {{indexed: number, skipped: Array<{slug: string, reason: string}>}}
 */
async function postBatch(batch, offset, depth = 0) {
  let lastErr;
  for (let attempt = 1; attempt <= BATCH_RETRIES; attempt++) {
    try {
      const result = await postToWorker('/api/ingest/definitions', {
        standardId: DEFINITIONS_STANDARD_ID,
        definitions: batch,
      });
      return { indexed: result.definitionsIndexed || 0, skipped: [] };
    } catch (err) {
      lastErr = err;
      // The Worker flags transient stages (Workers AI capacity, a Vectorize
      // hiccup) explicitly. A D1 failure is deterministic — retrying it just
      // multiplies the wait before the bisect that actually locates it. Fall
      // back to the status only for errors from an older build with no flag.
      const retryable = err.body
        ? err.body.retryable === true
        : (err.status === 429 || err.status === 503 || err.status >= 500);
      if (!retryable || attempt === BATCH_RETRIES) break;
      const waitMs = attempt * 3000;
      console.warn(`  Batch at ${offset} failed (attempt ${attempt}/${BATCH_RETRIES}), retrying in ${waitMs / 1000}s: ${short(err)}`);
      await new Promise(r => setTimeout(r, waitMs));
    }
  }

  // One definition on its own that still fails is the culprit — name it, skip it,
  // keep going.
  if (batch.length === 1) {
    console.warn(`  ✗ Skipping "${batch[0].slug}": ${short(lastErr)}`);
    return { indexed: 0, skipped: [{ slug: batch[0].slug, reason: short(lastErr) }] };
  }

  if (depth >= MAX_BISECT_DEPTH) {
    console.warn(`  ✗ Skipping ${batch.length} definition(s) at ${offset} (bisect limit): ${short(lastErr)}`);
    return { indexed: 0, skipped: batch.map(d => ({ slug: d.slug, reason: short(lastErr) })) };
  }

  const mid = Math.ceil(batch.length / 2);
  console.warn(`  Bisecting the failing batch at ${offset} (${batch.length} → ${mid} + ${batch.length - mid})…`);
  const left = await postBatch(batch.slice(0, mid), offset, depth + 1);
  const right = await postBatch(batch.slice(mid), offset + mid, depth + 1);
  return { indexed: left.indexed + right.indexed, skipped: [...left.skipped, ...right.skipped] };
}

/** The useful part of a Worker error: its message, without the HTTP preamble. */
function short(err) {
  return String(err?.message || err)
    .replace(/^\/api\/ingest\/definitions → HTTP \d+: /, '')
    .slice(0, 300);
}

/**
 * Verify the Worker is reachable, authorized, and running a build that has the
 * definitions endpoint — before downloading the glossary.
 *
 * The probe is an empty definitions batch, which the endpoint answers with
 * `definitionsIndexed: 0` without writing anything.
 */
async function preflight() {
  const urlHint = process.env.LUCIUS_API_URL
    ? ''
    : `\n   LUCIUS_API_URL is not set, so the target defaulted to ${CONFIG.apiUrl}.` +
      '\n   Export it (e.g. LUCIUS_API_URL=https://lensy.ies.org) or pass --local for wrangler dev.';

  try {
    await postToWorker('/api/ingest/definitions', { definitions: [] });
  } catch (err) {
    const msg = String(err.message || err);
    if (/fetch failed|ECONNREFUSED|ENOTFOUND|other side closed/i.test(msg)) {
      throw new Error(`Cannot reach the Worker at ${CONFIG.apiUrl}.${urlHint}`);
    }
    if (/\b(401|403)\b/.test(msg)) {
      throw new Error(`The Worker at ${CONFIG.apiUrl} rejected the ingest credential.` +
        '\n   LUCIUS_API_SECRET must match the value set with `wrangler secret put LUCIUS_API_SECRET`.' +
        `\n   Server said: ${msg}`);
    }
    // handleIngest routes an unrecognized sub-path to the generic document
    // handler, which rejects a body with no standardId. That 400 is the signal
    // that this build predates the definitions endpoint — not a 404.
    if (/\b404\b/.test(msg) || /standardId is required/.test(msg)) {
      throw new Error(`The Worker at ${CONFIG.apiUrl} is running a build without /api/ingest/definitions.` +
        '\n   Deploy the current code first (npm run deploy), then re-run this script.');
    }
    if (/no such table|no such column/i.test(msg)) {
      throw new Error('The `definitions` table does not exist yet.' +
        '\n   Apply migration 0009 first: npm run db:migrate:remote');
    }
    throw new Error(`Preflight against ${CONFIG.apiUrl} failed: ${msg}${urlHint}`);
  }

  console.log(`  Preflight: ${CONFIG.apiUrl} reachable, authorized, definitions endpoint present.`);
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
    const err = new Error(`${path} → HTTP ${res.status}: ${json.error || text.slice(0, 300)}`);
    // Carry the structured body: the definitions endpoint reports which stage
    // failed and whether it is worth retrying, and postBatch decides from that
    // rather than from pattern-matching the HTTP status out of the message.
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

main().catch(err => {
  console.error(`\n✗ ${err.message}\n`);
  process.exit(1);
});
