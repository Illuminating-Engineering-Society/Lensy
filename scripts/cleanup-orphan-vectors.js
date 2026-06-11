#!/usr/bin/env node
/**
 * Lucius — Vectorize Orphan Cleanup
 *
 * Walks the Vectorize index (via the /api/admin/* endpoints) to find chunk
 * vectors whose `standard_id` is no longer present in the D1 standards
 * table, then optionally deletes them.
 *
 * Why this exists:
 *   - Vectorize has no public "list all IDs" API.
 *   - Re-ingesting the same standard with a smaller chunk count leaves the
 *     tail of the previous run as orphans (IDs are `${stdId}-chunk-N` with
 *     stable N — only N in [0, newCount) are overwritten).
 *   - Standards renamed or test-ingested (e.g. RP-8-25_FULL, *-chunktest)
 *     never get cleaned up unless their full ID range is explicitly
 *     deleted.
 *
 * Usage:
 *   # 1. Discover which standard_ids in Vectorize have no D1 row.
 *   node scripts/cleanup-orphan-vectors.js --scan
 *
 *   # 2. Enumerate every chunk ID for the orphans (dry-run).
 *   node scripts/cleanup-orphan-vectors.js --enumerate
 *
 *   # 3. Actually delete (only after reviewing the enumerate output).
 *   node scripts/cleanup-orphan-vectors.js --delete
 *
 * Options:
 *   --scan              Step 1 only: probe Vectorize, list orphan standard IDs.
 *   --enumerate         Step 2: enumerate every chunk ID for orphan standards.
 *   --delete            Step 3: actually delete (requires confirmation).
 *   --max-index <n>     Probe `prefix-chunk-0..n` (default 600).
 *   --passes <n>        Number of random scan passes (default 8).
 *   --topk <n>          topK per scan pass (default 100).
 *   --include <list>    Comma-separated prefixes to force-include in
 *                       enumerate/delete (use after a scan if you know
 *                       a standard exists but the random probes missed it).
 *
 * Environment:
 *   LUCIUS_API_URL      Worker URL (default: http://localhost:8787)
 *   LUCIUS_API_SECRET   Required if the Worker has the secret set.
 */

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const argVal = (name, fallback = null) => {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
};

const CONFIG = {
  apiUrl: process.env.LUCIUS_API_URL || 'http://localhost:8787',
  apiSecret: process.env.LUCIUS_API_SECRET || null,
  scan: flag('--scan'),
  enumerate: flag('--enumerate'),
  doDelete: flag('--delete'),
  maxIndex: Number(argVal('--max-index', 600)),
  passes: Number(argVal('--passes', 8)),
  topK: Number(argVal('--topk', 100)),
  include: (argVal('--include', '') || '').split(',').map(s => s.trim()).filter(Boolean),
};

if (!CONFIG.scan && !CONFIG.enumerate && !CONFIG.doDelete) {
  console.error('Specify one of: --scan, --enumerate, --delete');
  process.exit(2);
}

async function callAdmin(path, body) {
  const res = await fetch(`${CONFIG.apiUrl}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(CONFIG.apiSecret ? { Authorization: `Bearer ${CONFIG.apiSecret}` } : {}),
    },
    body: JSON.stringify(body || {}),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${path} → ${res.status}: ${text}`);
  }
  return res.json();
}

async function runScan() {
  console.log(`▶  Scanning Vectorize via ${CONFIG.apiUrl} (${CONFIG.passes} passes × topK ${CONFIG.topK})…`);
  const result = await callAdmin('/api/admin/scan-orphans', {
    passes: CONFIG.passes,
    topK: CONFIG.topK,
  });

  console.log('');
  console.log('Standards in D1 (valid):');
  for (const id of result.validStandardsInD1) console.log(`  ✓  ${id}`);

  console.log('');
  console.log(`Standards seen in Vectorize probes: ${result.standardsSeenInVectorize}`);
  for (const row of result.detail) {
    const tag = row.isValid ? '✓ ' : '✗ ORPHAN';
    console.log(`  ${tag}  ${row.standardId.padEnd(32)} (seen ${row.seenInProbes}×, sample: ${row.sampleVectorIds.slice(0, 3).join(', ')})`);
  }

  if (result.orphanStandards.length === 0) {
    console.log('\n✅  No orphan standards detected.');
  } else {
    console.log(`\n⚠️   ${result.orphanStandards.length} orphan standard(s):`);
    for (const id of result.orphanStandards) console.log(`     ${id}`);
    console.log('\nNext step: node scripts/cleanup-orphan-vectors.js --enumerate');
  }
  return result;
}

async function runEnumerate(prefixes) {
  if (!prefixes || prefixes.length === 0) {
    const scan = await runScan();
    prefixes = [...new Set([...scan.orphanStandards, ...CONFIG.include])];
  }
  if (prefixes.length === 0) {
    console.log('Nothing to enumerate. Done.');
    return { found: {} };
  }

  console.log(`\n▶  Enumerating chunk IDs for ${prefixes.length} prefix(es), maxIndex=${CONFIG.maxIndex}…`);
  const result = await callAdmin('/api/admin/enumerate-ids', {
    prefixes,
    maxIndex: CONFIG.maxIndex,
  });

  console.log('');
  for (const [prefix, ids] of Object.entries(result.found)) {
    console.log(`  ${prefix}: ${ids.length} chunk(s)`);
    if (ids.length > 0 && ids.length <= 10) {
      for (const id of ids) console.log(`      ${id}`);
    } else if (ids.length > 10) {
      console.log(`      ${ids.slice(0, 3).join(', ')}, …, ${ids.slice(-2).join(', ')}`);
    }
  }
  console.log(`\nTotal vectors to delete: ${result.totalFound}`);
  return result;
}

async function runDelete() {
  const enumerated = await runEnumerate();
  const allIds = Object.values(enumerated.found || {}).flat();
  if (allIds.length === 0) {
    console.log('Nothing to delete. Done.');
    return;
  }

  console.log(`\n⚠️   About to DELETE ${allIds.length} vector(s) from Vectorize.`);
  console.log('   Press Ctrl-C in the next 5 seconds to abort…');
  await new Promise(r => setTimeout(r, 5000));

  const result = await callAdmin('/api/admin/delete-orphans', { ids: allIds });
  console.log(`\n✅  Deleted ${result.deleted} of ${result.requested}.`);
}

async function main() {
  try {
    if (CONFIG.doDelete) {
      await runDelete();
    } else if (CONFIG.enumerate) {
      await runEnumerate(CONFIG.include.length ? CONFIG.include : null);
    } else {
      await runScan();
    }
  } catch (err) {
    console.error(`\n❌  ${err.message}`);
    process.exit(1);
  }
}

main();
