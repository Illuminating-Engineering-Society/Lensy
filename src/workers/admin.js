/**
 * Lensy Admin Endpoints
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
 *
 *   POST /api/admin/flush-cache
 *     Bump the corpus data version, invalidating all cached search
 *     responses. Use after out-of-band data changes (direct D1 writes,
 *     sync-metadata.js) that bypass the ingest endpoints.
 *
 *   GET /api/admin/search-log.csv
 *     Staff-only CSV export of the anonymous search-query log
 *     (?from=&to=&limit=). No user-identifying data by design.
 *
 *   GET /api/admin/index-status
 *     Full-indexing confidence report: per standard, the chunk/page coverage
 *     stats written at ingest time PLUS a live Vectorize spot-check that the
 *     first/middle/last chunk vectors actually exist (?verify=0 to skip).
 */

import { bumpDataVersion, getDataVersion } from '../lib/cache';
import { checkAuth } from '../lib/auth';

const EMBED_MODEL = '@cf/baai/bge-base-en-v1.5';
const SCAN_DEFAULT_PASSES = 8;
const SCAN_TOPK = 100;
const DELETE_BATCH = 200;

/**
 * Shared-secret gate for every admin endpoint. Timing-safe comparison and
 * fail-closed in production when the secret is missing (lib/auth.js).
 * Returns a Response to short-circuit with, or null when authorized.
 */
async function requireAuth(request, env) {
  const auth = await checkAuth(request, env);
  if (auth.ok) return null;
  return jsonResponse({ error: auth.reason || 'Unauthorized' }, auth.reason ? 503 : 401);
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
  const denied = await requireAuth(request, env);
  if (denied) return denied;

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
  const denied = await requireAuth(request, env);
  if (denied) return denied;
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
  const denied = await requireAuth(request, env);
  if (denied) return denied;

  const body = await safeJson(request);
  const ids = Array.isArray(body?.ids) ? body.ids.filter(x => typeof x === 'string') : [];
  if (ids.length === 0) return jsonResponse({ error: 'ids[] required' }, 400);

  let deleted = 0;
  for (let i = 0; i < ids.length; i += DELETE_BATCH) {
    const batch = ids.slice(i, i + DELETE_BATCH);
    const res = await env.VECTORIZE.deleteByIds(batch);
    deleted += res?.count ?? batch.length;
  }

  // Corpus changed — invalidate all cached search responses.
  await bumpDataVersion(env.SESSIONS);

  return jsonResponse({ requested: ids.length, deleted });
}

/**
 * Staff-only CSV export of the anonymous search log (client request).
 *
 *   GET /api/admin/search-log.csv?from=2026-07-01&to=2026-07-08&limit=10000
 *
 * Columns: created_at, query, result_count, standards_referenced,
 * no_strong_match, cached. The table carries no user-identifying data by
 * design (privacy requirement) — there is nothing personal to export.
 */
export async function handleAdminSearchLog(request, env) {
  const denied = await requireAuth(request, env);
  if (denied) return denied;

  const url = new URL(request.url);
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');
  const limit = Math.min(50000, Math.max(1, parseInt(url.searchParams.get('limit') || '10000', 10) || 10000));

  let sql = `
    SELECT created_at, query, result_count, standards_referenced, no_strong_match, cached
    FROM search_log WHERE 1=1
  `;
  const bindings = [];
  if (from) { sql += ' AND created_at >= ?'; bindings.push(from); }
  if (to) { sql += ' AND created_at <= ?'; bindings.push(to); }
  sql += ' ORDER BY created_at DESC LIMIT ?';
  bindings.push(limit);

  const result = await env.DB.prepare(sql).bind(...bindings).all();
  const rows = result.results || [];

  const header = 'created_at,query,result_count,standards_referenced,no_strong_match,cached';
  const csv = [
    header,
    ...rows.map(r => [
      r.created_at, r.query, r.result_count, r.standards_referenced,
      r.no_strong_match, r.cached,
    ].map(csvCell).join(',')),
  ].join('\r\n');

  return new Response(csv, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="lensy-search-log.csv"',
    },
  });
}

/**
 * CSV-escape one cell. Also neutralizes spreadsheet formula injection —
 * queries are user-supplied free text, and staff open this file in Excel.
 */
function csvCell(v) {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Full-indexing confidence report (client requirement: high confidence that
 * every standard is indexed in its entirety before launch).
 *
 *   GET /api/admin/index-status[?verify=0]
 *
 * Per standard (from D1, populated at ingest):
 *   chunkCount / pageCount / pagesWithChunks / coverage % / chunk-type mix /
 *   application row count / indexed_at
 * Plus a live Vectorize spot-check (verify=1, default): the first, middle and
 * last chunk vector ids are fetched from the correct index (main or
 * deprecated) — any gap means the index and D1 disagree and the standard
 * needs re-ingesting.
 *
 * Warnings flag: missing stats (pre-0006 ingest), page coverage below 60%,
 * zero application rows for a NEW_TABLE-era standard, failed spot-checks.
 */
export async function handleAdminIndexStatus(request, env) {
  const denied = await requireAuth(request, env);
  if (denied) return denied;

  const url = new URL(request.url);
  const verify = url.searchParams.get('verify') !== '0';

  const [standardsRes, appCountsRes] = await Promise.all([
    env.DB.prepare(`
      SELECT id, title, full_designation, status, chunk_count, page_count,
             coverage_json, indexed_at
      FROM standards ORDER BY id
    `).all(),
    env.DB.prepare(`
      SELECT Standard AS standard, COUNT(*) AS n
      FROM applications WHERE Active = 1 GROUP BY Standard
    `).all(),
  ]);

  const appCounts = new Map((appCountsRes.results || []).map(r => [r.standard, r.n]));

  const report = [];
  for (const std of standardsRes.results || []) {
    let coverage = null;
    try { coverage = std.coverage_json ? JSON.parse(std.coverage_json) : null; } catch { /* ignore */ }

    const row = {
      id: std.id,
      title: std.title,
      status: std.status,
      indexedAt: std.indexed_at,
      chunkCount: std.chunk_count,
      pageCount: std.page_count,
      pagesWithChunks: coverage?.pagesWithChunks ?? null,
      pageCoveragePct: (std.page_count && coverage?.pagesWithChunks != null)
        ? Math.round((coverage.pagesWithChunks / std.page_count) * 100)
        : null,
      chunkTypes: coverage?.byType ?? null,
      applicationRows: appCounts.get(std.id) || 0,
      vectorSpotCheck: null,
      warnings: [],
    };

    if (std.chunk_count == null) {
      row.warnings.push('No coverage stats — ingested before migration 0006; re-ingest to record them.');
    }
    if (row.pageCoveragePct != null && row.pageCoveragePct < 60) {
      row.warnings.push(`Only ${row.pageCoveragePct}% of pages produced chunks — verify the PDF parsed fully.`);
    }
    if ((coverage?.byType?.reference ?? 0) === 0 && std.status !== 'Deprecated' && std.chunk_count != null) {
      row.warnings.push('No reference chunks — expected if the standard has no References section; otherwise re-ingest.');
    }

    if (verify && std.chunk_count > 0) {
      const index = std.status === 'Deprecated' ? env.VECTORIZE_DEPRECATED : env.VECTORIZE;
      if (index) {
        const n = std.chunk_count;
        const probeIdxs = [...new Set([0, Math.floor((n - 1) / 2), n - 1])];
        try {
          const got = await index.getByIds(probeIdxs.map(i => `${std.id}-chunk-${i}`));
          const foundIds = new Set((got || []).map(v => v.id));
          const missing = probeIdxs
            .map(i => `${std.id}-chunk-${i}`)
            .filter(id => !foundIds.has(id));
          row.vectorSpotCheck = { probed: probeIdxs.length, found: probeIdxs.length - missing.length, missing };
          if (missing.length > 0) {
            row.warnings.push(`Vectorize spot-check missing ${missing.length}/${probeIdxs.length} probes — re-ingest this standard.`);
          }
        } catch (err) {
          row.vectorSpotCheck = { error: err.message };
        }
      }
    }

    report.push(row);
  }

  const withWarnings = report.filter(r => r.warnings.length > 0);
  return jsonResponse({
    totals: {
      standards: report.length,
      active: report.filter(r => r.status !== 'Deprecated').length,
      deprecated: report.filter(r => r.status === 'Deprecated').length,
      totalChunks: report.reduce((s, r) => s + (r.chunkCount || 0), 0),
      totalApplicationRows: report.reduce((s, r) => s + r.applicationRows, 0),
      standardsWithWarnings: withWarnings.length,
    },
    warnings: withWarnings.map(r => ({ id: r.id, warnings: r.warnings })),
    standards: report,
  });
}

/**
 * Invalidate all cached search responses by bumping the data version.
 * Cheap (one KV write); old entries simply stop being read and expire.
 */
export async function handleAdminFlushCache(request, env) {
  const denied = await requireAuth(request, env);
  if (denied) return denied;

  await bumpDataVersion(env.SESSIONS);
  const dataVersion = await getDataVersion(env.SESSIONS);

  return jsonResponse({ success: true, dataVersion });
}

/**
 * Multipart upload of a large PDF into the PDFS R2 bucket.
 *
 * wrangler caps `r2 object put` at 300 MiB; the R2 binding has no such limit
 * when fed multipart parts. Client: scripts/r2-upload-large.js.
 *
 * POST /api/admin/r2-multipart?action=create&key=<key>
 *   → { uploadId }
 * POST /api/admin/r2-multipart?action=part&key=<key>&uploadId=<id>&partNumber=<n>
 *   (raw part bytes as body; all parts equal size except the last, ≥5 MiB)
 *   → { partNumber, etag }
 * POST /api/admin/r2-multipart?action=complete&key=<key>
 *   Body: { uploadId, parts: [{ partNumber, etag }] } → { key, size }
 * POST /api/admin/r2-multipart?action=abort&key=<key>
 *   Body: { uploadId } → { aborted: true }
 */
export async function handleAdminR2Multipart(request, env) {
  const denied = await requireAuth(request, env);
  if (denied) return denied;

  const url = new URL(request.url);
  const action = url.searchParams.get('action');
  const key = url.searchParams.get('key') || '';

  // Same namespaces the ingest pipeline writes to — nothing else is writable.
  if (!/^(standards|deprecated)\/[^/]+\.pdf$/.test(key)) {
    return jsonResponse({ error: 'key must be standards/<file>.pdf or deprecated/<file>.pdf' }, 400);
  }

  if (action === 'create') {
    const upload = await env.PDFS.createMultipartUpload(key);
    return jsonResponse({ uploadId: upload.uploadId, key });
  }

  if (action === 'part') {
    const uploadId = url.searchParams.get('uploadId');
    const partNumber = parseInt(url.searchParams.get('partNumber'), 10);
    if (!uploadId || !Number.isInteger(partNumber) || partNumber < 1) {
      return jsonResponse({ error: 'uploadId and partNumber (≥1) required' }, 400);
    }
    const upload = env.PDFS.resumeMultipartUpload(key, uploadId);
    const part = await upload.uploadPart(partNumber, request.body);
    return jsonResponse({ partNumber: part.partNumber, etag: part.etag });
  }

  if (action === 'complete') {
    const body = await safeJson(request);
    if (!body.uploadId || !Array.isArray(body.parts)) {
      return jsonResponse({ error: 'uploadId and parts[] required' }, 400);
    }
    const upload = env.PDFS.resumeMultipartUpload(key, body.uploadId);
    const object = await upload.complete(body.parts);
    return jsonResponse({ key, size: object.size, etag: object.httpEtag });
  }

  if (action === 'abort') {
    const body = await safeJson(request);
    if (!body.uploadId) return jsonResponse({ error: 'uploadId required' }, 400);
    const upload = env.PDFS.resumeMultipartUpload(key, body.uploadId);
    await upload.abort();
    return jsonResponse({ aborted: true });
  }

  return jsonResponse({ error: 'action must be create | part | complete | abort' }, 400);
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
