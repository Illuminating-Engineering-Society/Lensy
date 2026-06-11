/**
 * Lucius Admin Endpoints
 *
 * Operations that touch Vectorize directly. Vectorize has no public "list
 * vectors" API; the Worker is the only context with a binding, so anything
 * that needs to walk the index lives here.
 *
 * Auth: shared-secret via the Authorization header. Set LUCIUS_API_SECRET
 * via `wrangler secret put`. Same secret used by the ingest endpoint.
 *
 * Endpoints:
 *   POST /api/admin/scan-orphans
 *     Random-vector probe to discover standard_id values present in
 *     Vectorize that no longer have a row in the D1 standards table.
 *     Read-only; never deletes.
 *
 *   POST /api/admin/delete-orphans
 *     Body: { ids: string[] } — exact vector IDs to delete. Caller must
 *     have built this list from a previous scan-orphans run.
 */

const EMBED_MODEL = '@cf/baai/bge-base-en-v1.5';
const SCAN_DEFAULT_PASSES = 8;
const SCAN_TOPK = 100;
const DELETE_BATCH = 200;

function checkAuth(request, env) {
  const expected = env.LUCIUS_API_SECRET;
  if (!expected) return true; // dev mode without a secret — allow
  const header = request.headers.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : header;
  return token === expected;
}

/**
 * Discover orphan standard_ids in Vectorize.
 *
 * Strategy: Vectorize doesn't let you enumerate IDs, but every chunk vector
 * carries a `standard_id` in its metadata. We run several queries with
 * pseudo-random query vectors and a high topK, union the standard_ids we
 * see, and compare against the D1 standards table. Anything in Vectorize
 * but not in D1 is an orphan.
 *
 * This is heuristic — a standard with very few vectors that all happen to
 * sit far from our random probes can be missed in a single run. The script
 * caller can re-run for higher confidence.
 */
export async function handleAdminScanOrphans(request, env) {
  if (!checkAuth(request, env)) return jsonResponse({ error: 'Unauthorized' }, 401);

  const body = await safeJson(request);
  const passes = Math.min(32, Math.max(1, body?.passes || SCAN_DEFAULT_PASSES));
  const topK = Math.min(100, Math.max(10, body?.topK || SCAN_TOPK));

  const validStandards = await fetchValidStandardIds(env.DB);

  const seenStandards = new Map(); // standard_id → { count, sampleIds: Set }
  const proseTexts = [
    'lighting recommendations',
    'illuminance category',
    'maintained illuminance',
    'general notes annex',
    'sports outdoor pedestrian',
    'parking garage warehouse',
    'office classroom hospital',
    'energy controls daylighting',
  ];

  for (let pass = 0; pass < passes; pass++) {
    // Use varied prose so embeddings cover different parts of the space.
    const text = proseTexts[pass % proseTexts.length];
    const embRes = await env.AI.run(EMBED_MODEL, { text: [text] });
    const queryVector = embRes.data[0];

    const result = await env.VECTORIZE.query(queryVector, {
      topK,
      returnMetadata: 'all',
    });

    for (const match of result.matches || []) {
      const stdId = match.metadata?.standard_id || match.metadata?.standard_code;
      if (!stdId) continue;
      let entry = seenStandards.get(stdId);
      if (!entry) {
        entry = { count: 0, sampleIds: new Set() };
        seenStandards.set(stdId, entry);
      }
      entry.count++;
      if (entry.sampleIds.size < 5) entry.sampleIds.add(match.id);
    }
  }

  const summary = [...seenStandards.entries()].map(([stdId, info]) => ({
    standardId: stdId,
    seenInProbes: info.count,
    sampleVectorIds: [...info.sampleIds],
    isOrphan: !validStandards.has(stdId),
    isValid: validStandards.has(stdId),
  })).sort((a, b) => b.seenInProbes - a.seenInProbes);

  const orphans = summary.filter(s => s.isOrphan);

  return jsonResponse({
    passes,
    topK,
    validStandardsInD1: [...validStandards],
    standardsSeenInVectorize: summary.length,
    orphanStandards: orphans.map(o => o.standardId),
    detail: summary,
    note: 'Heuristic scan — re-run for higher confidence. To delete, build a full ID list from `sampleVectorIds` and call /api/admin/delete-orphans.',
  });
}

/**
 * Enumerate which `${prefix}-chunk-N` IDs (N in [0, maxIndex]) actually
 * exist in Vectorize. Used after a scan to build a complete deletion list
 * for a given orphan standard prefix.
 *
 * Body: { prefixes: string[], maxIndex?: number = 600 }
 */
export async function handleAdminEnumerateIds(request, env) {
  if (!checkAuth(request, env)) return jsonResponse({ error: 'Unauthorized' }, 401);
  const body = await safeJson(request);
  const prefixes = Array.isArray(body?.prefixes) ? body.prefixes.filter(p => typeof p === 'string') : [];
  const maxIndex = Math.min(2000, Math.max(0, body?.maxIndex ?? 600));
  if (prefixes.length === 0) return jsonResponse({ error: 'prefixes[] required' }, 400);

  const PROBE_BATCH = 100; // getByIds accepts arrays; cap for safety
  const found = {};

  for (const prefix of prefixes) {
    found[prefix] = [];
    for (let start = 0; start <= maxIndex; start += PROBE_BATCH) {
      const ids = [];
      for (let n = start; n < Math.min(start + PROBE_BATCH, maxIndex + 1); n++) {
        ids.push(`${prefix}-chunk-${n}`);
      }
      const res = await env.VECTORIZE.getByIds(ids);
      for (const v of (res || [])) {
        if (v && v.id) found[prefix].push(v.id);
      }
    }
  }

  const totalFound = Object.values(found).reduce((s, arr) => s + arr.length, 0);
  return jsonResponse({ prefixes, maxIndex, totalFound, found });
}

/**
 * Delete an explicit list of vector IDs.
 *
 * The caller is responsible for the list — typically built by enumerating
 * `${standardId}-chunk-N` for N in a known range. We don't infer.
 */
export async function handleAdminDeleteOrphans(request, env) {
  if (!checkAuth(request, env)) return jsonResponse({ error: 'Unauthorized' }, 401);

  const body = await safeJson(request);
  const ids = Array.isArray(body?.ids) ? body.ids.filter(x => typeof x === 'string') : [];
  if (ids.length === 0) return jsonResponse({ error: 'ids[] required' }, 400);

  let deleted = 0;
  for (let i = 0; i < ids.length; i += DELETE_BATCH) {
    const batch = ids.slice(i, i + DELETE_BATCH);
    const res = await env.VECTORIZE.deleteByIds(batch);
    deleted += res?.count ?? batch.length;
  }

  return jsonResponse({ requested: ids.length, deleted });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function fetchValidStandardIds(db) {
  const result = await db.prepare('SELECT id FROM standards').all();
  return new Set((result.results || []).map(r => r.id));
}

async function safeJson(request) {
  try { return await request.json(); } catch { return {}; }
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
