/**
 * Lensy Ingest Worker
 *
 * IMPORTANT: This Worker does NOT parse PDFs. PDF parsing (pdfjs-dist) requires
 * Node.js and cannot run in a Cloudflare Worker. The ingestion script
 * (scripts/ingest-pdfs.js) handles all PDF parsing and sends pre-parsed data here.
 *
 * Endpoints:
 *
 *   POST /api/ingest
 *     Accept pre-parsed PDF data from the ingestion script.
 *     Auth: Bearer LUCIUS_API_SECRET (fail-closed in production).
 *     Body: { standardId, status, metadata, chunks, tables, applications }
 *     - status:       'current' (default) | 'deprecated'
 *     - chunks:       [{text, pageNumber, section, type}]       → Vectorize
 *                     type: 'text' | 'table' | 'general_notes' | 'reference'
 *                     ('reference' = References/Bibliography entries; powers
 *                      the references-only search mode)
 *     - tables:       [{pageNumber, title, rows, ...}]          → D1 standards.tables_json
 *     - applications: [{code, App, Hor_Lux, ...}]  (optional)  → D1 applications (upsert)
 *
 *     Deprecated standards (status: 'deprecated'):
 *     - chunks are upserted into the SEPARATE deprecated Vectorize index
 *       (env.VECTORIZE_DEPRECATED) — the main search index never sees them,
 *       so regular searches and any future external API cannot surface them.
 *       They are only queried for version-comparison searches ("what's new
 *       in RP-6?"). See IS-AI Prototype_260403.pdf, §6 (p.1) and p.5 notes.
 *     - application records are rejected: deprecated illuminance values must
 *       never enter the applications table that serves current guidance.
 *     - the D1 standards row is written with status='Deprecated' and a
 *       best-effort superseded_by pointing at the newest Active edition of
 *       the same standard family.
 *     - refuses to ingest over an existing Active standard of the same id
 *       (a reaffirmed printing is the same edition, not a deprecated one).
 *
 *   POST /api/ingest/applications
 *     Re-embed all D1 application rows into Vectorize.
 *     Can be called after seeding or after PDF-extracted records are in D1.
 *
 *   POST /api/ingest/r2-upload-url
 *     Return R2 key and wrangler command for uploading the raw PDF.
 */

import { bumpDataVersion } from '../lib/cache';
import { checkAuth } from '../lib/auth';

const EMBED_MODEL = '@cf/baai/bge-base-en-v1.5';
const EMBED_BATCH = 100;       // Workers AI max per call
const EMBED_MAX_ATTEMPTS = 3;  // retries per embedding batch (transient AI errors)
const VECTORIZE_BATCH = 1000;  // Vectorize max per upsert
const DELETE_BATCH = 200;      // Vectorize deleteByIds batch size

export async function handleIngest(request, env) {
  // Ingest rewrites the searchable corpus — shared-secret protected, and
  // fail-closed in production when no secret is configured (see lib/auth.js).
  const auth = await checkAuth(request, env);
  if (!auth.ok) {
    return jsonResponse({ error: auth.reason || 'Unauthorized' }, auth.reason ? 503 : 401);
  }

  const url = new URL(request.url);
  const subPath = url.pathname.replace('/api/ingest', '').replace(/\/$/, '');

  switch (subPath) {
    case '/applications':
      return ingestApplications(env);
    case '/r2-upload-url':
      return getR2UploadUrl(request, env);
    case '':
    default:
      return ingestParsedPDF(request, env);
  }
}

// ─── PDF Chunk Ingestion ───────────────────────────────────────────────────────
// Called by scripts/ingest-pdfs.js after it has parsed the PDF locally.

async function ingestParsedPDF(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 400);
  }

  const {
    standardId,
    status = 'current',
    metadata = {},
    chunks = [],
    tables = [],
    applications = [],  // extracted application records from PDF tables
    r2Key = null,
  } = body;

  if (!standardId) return jsonResponse({ error: 'standardId is required' }, 400);
  if (status !== 'current' && status !== 'deprecated') {
    return jsonResponse({ error: `status must be "current" or "deprecated", got "${status}"` }, 400);
  }
  // chunks can be empty when request is only upserting applications
  if (!Array.isArray(chunks)) {
    return jsonResponse({ error: 'chunks must be an array' }, 400);
  }

  const isDeprecated = status === 'deprecated';

  // Previous ingest state — used both for the deprecated-downgrade guard and
  // for stale-vector cleanup when a re-ingest produces FEWER chunks.
  const existing = await env.DB.prepare(
    'SELECT status, chunk_count FROM standards WHERE id = ?'
  ).bind(standardId).first();

  if (isDeprecated) {
    // Deprecated values must never be served as current guidance.
    if (Array.isArray(applications) && applications.length > 0) {
      return jsonResponse({
        error: 'Deprecated standards cannot carry application records — they are indexed for version comparison only.',
      }, 400);
    }
    // Same id already Active in D1 → this file is a reaffirmed printing of
    // the current edition, not a prior edition. Refuse rather than silently
    // downgrading an active standard.
    if (existing && existing.status !== 'Deprecated') {
      return jsonResponse({
        error: `"${standardId}" is already indexed as a CURRENT standard — refusing to re-ingest it as deprecated. ` +
               'If this really is a prior edition, give it a distinct id (e.g. include the edition year).',
      }, 409);
    }
    if (!env.VECTORIZE_DEPRECATED) {
      return jsonResponse({
        error: 'VECTORIZE_DEPRECATED binding is not configured. Create the index and add the binding to wrangler.toml ' +
               '(wrangler vectorize create ies-standards-deprecated-vectors --dimensions=768 --metric=cosine).',
      }, 500);
    }
  }

  // ── 1. Generate embeddings for all chunks (skip if none) ──────────────────
  // Validate EVERY chunk up front: a single empty text at position N would
  // otherwise fail deep inside the Workers AI call and leave a half-indexed
  // standard behind.
  for (let i = 0; i < chunks.length; i++) {
    if (typeof chunks[i].text !== 'string' || !chunks[i].text.trim()) {
      return jsonResponse({ error: `Chunk ${i} has an empty text field — every chunk must carry text` }, 400);
    }
  }

  const embeddings = chunks.length > 0
    ? await embedInBatches(env.AI, chunks.map(c => c.text))
    : [];

  // Full-indexing guarantee: one embedding per chunk, no silent truncation.
  if (embeddings.length !== chunks.length) {
    return jsonResponse({
      error: `Embedding count mismatch: got ${embeddings.length} embeddings for ${chunks.length} chunks — aborting so the index never holds a partial document.`,
    }, 500);
  }

  // ── 2. Build Vectorize vectors ─────────────────────────────────────────────
  const vectors = chunks.map((chunk, i) => ({
    id: `${standardId}-chunk-${i}`,
    values: embeddings[i],
    metadata: {
      standard_id: standardId,
      application_code: null,
      standard_code: standardId,
      chunk_type: chunk.type || 'text',       // 'text' | 'table' | 'general_notes' | 'reference'
      page_number: chunk.pageNumber || null,
      section: chunk.section || null,         // e.g. "3.5" from IES section numbering
      excerpt_text: chunk.text.substring(0, 500), // metadata size limit ~1KB
      indoor_outdoor: null,
      tm24_eligible: null,
      status,                                 // 'current' | 'deprecated'
    },
  }));

  // ── 3. Upsert into Vectorize (batched) ────────────────────────────────────
  // Deprecated chunks go to the dedicated deprecated index, never the main one.
  const targetIndex = isDeprecated ? env.VECTORIZE_DEPRECATED : env.VECTORIZE;
  for (let i = 0; i < vectors.length; i += VECTORIZE_BATCH) {
    await targetIndex.upsert(vectors.slice(i, i + VECTORIZE_BATCH));
  }

  // ── 3b. Stale-vector cleanup ───────────────────────────────────────────────
  // Vector ids are deterministic (`<standardId>-chunk-<n>`). If a re-ingest
  // produced FEWER chunks than the previous run, the tail ids (n .. prev-1)
  // still hold the OLD document's content and would keep surfacing in search.
  // Delete them so the index exactly mirrors the latest parse. Three cases:
  //   a. Same index, known previous count → delete the tail range.
  //   b. Same index, UNKNOWN previous count (row predates migration 0006) →
  //      probe deterministic ids upward from the new count and delete what
  //      exists, so the first post-0006 re-ingest self-heals the standard.
  //   c. Status flipped (Deprecated → Active): the new vectors went to a
  //      DIFFERENT index, so the old index still holds the entire previous
  //      document — delete its full range.
  const prevChunkCount = existing?.chunk_count ?? null;
  const prevIndex = existing
    ? (existing.status === 'Deprecated' ? env.VECTORIZE_DEPRECATED : env.VECTORIZE)
    : null;
  let staleDeleted = 0;
  if (chunks.length > 0 && existing && prevIndex) {
    try {
      if (prevIndex !== targetIndex) {
        // (c) index transition — nothing in the old index was overwritten
        staleDeleted += await deleteVectorRange(prevIndex, standardId, 0, prevChunkCount ?? null);
      } else if (prevChunkCount != null && prevChunkCount > chunks.length) {
        // (a) shrinking re-ingest
        staleDeleted += await deleteVectorRange(targetIndex, standardId, chunks.length, prevChunkCount);
      } else if (prevChunkCount == null) {
        // (b) legacy row without stats — probe for a stale tail
        staleDeleted += await deleteVectorRange(targetIndex, standardId, chunks.length, null);
      }
    } catch (err) {
      console.error(`stale vector cleanup failed for ${standardId} (non-fatal):`, err.message);
    }
  }

  // ── 4. Persist standard metadata + tables to D1 (skip for app-only batches) ─
  // Store tables as a compact JSON array (page, header, row count, footnotes)
  const tablesCompact = (tables || []).map(t => ({
    pageNumber: t.pageNumber,
    header: t.header,
    rowCount: (t.rows || []).length,
    footnotes: t.footnotes,
    generalNotes: t.generalNotes,
  }));

  // Deprecated rows point at the newest Active edition of their family
  // (best-effort) so responses can say "deprecated — replaced by RP-6-24".
  const supersededBy = isDeprecated ? await findSupersedingStandard(env.DB, standardId) : null;

  // ── 4a. Index-coverage stats ──────────────────────────────────────────────
  // Written on every chunk-carrying ingest so staff can verify the standard
  // is FULLY indexed (GET /api/admin/index-status): how many pages produced
  // at least one chunk, and the chunk-type mix (text/table/general_notes/
  // reference). pageCount comes from the parsing script (metadata.pageCount).
  const coverage = buildCoverageStats(chunks);
  const pageCount = Number.isFinite(metadata.pageCount) ? metadata.pageCount : null;

  if (chunks.length > 0 || tables.length > 0 || metadata.title) await env.DB.prepare(`
    INSERT INTO standards
      (id, title, description, author, year, full_designation, r2_key,
       tables_json, status, superseded_by, chunk_count, page_count,
       coverage_json, indexed_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET
      title        = excluded.title,
      description  = excluded.description,
      author       = excluded.author,
      year         = excluded.year,
      full_designation = excluded.full_designation,
      r2_key       = COALESCE(excluded.r2_key, standards.r2_key),
      tables_json  = excluded.tables_json,
      status       = excluded.status,
      superseded_by = COALESCE(excluded.superseded_by, standards.superseded_by),
      chunk_count  = COALESCE(excluded.chunk_count, standards.chunk_count),
      page_count   = COALESCE(excluded.page_count, standards.page_count),
      coverage_json = COALESCE(excluded.coverage_json, standards.coverage_json),
      indexed_at   = CURRENT_TIMESTAMP,
      updated_at   = CURRENT_TIMESTAMP
  `).bind(
    standardId,
    metadata.title || standardId,
    metadata.subject || null,
    metadata.author || null,
    metadata.year ? parseInt(metadata.year, 10) : null,
    metadata.fullDesignation || null,
    r2Key || `standards/${standardId}.pdf`,
    JSON.stringify(tablesCompact),
    isDeprecated ? 'Deprecated' : 'Active',
    supersededBy,
    chunks.length > 0 ? chunks.length : null,
    pageCount,
    chunks.length > 0 ? JSON.stringify(coverage) : null,
  ).run();

  // ── 5. Upsert extracted application records into D1 ──────────────────────
  // This is the "PDFs as source of truth" step: application data comes FROM
  // the PDF, not from a manually maintained CSV.
  let applicationsUpserted = 0;
  if (Array.isArray(applications) && applications.length > 0) {
    applicationsUpserted = await upsertApplications(env.DB, applications);
  }

  // Corpus changed — invalidate all cached search responses.
  await bumpDataVersion(env.SESSIONS);

  return jsonResponse({
    success: true,
    standardId,
    chunksIndexed: chunks.length,
    tablesFound: (tables || []).length,
    vectorsUpserted: vectors.length,
    staleVectorsDeleted: staleDeleted,
    applicationsUpserted,
    coverage: chunks.length > 0 ? { ...coverage, pageCount } : null,
  });
}

// Bounds for the probe-based cleanup (endIndex unknown): far beyond any real
// document's chunk count, cheap to walk in PROBE_WINDOW-id getByIds calls.
const PROBE_WINDOW = 100;
const PROBE_HARD_CAP = 5000;

/**
 * Delete `<standardId>-chunk-<n>` vectors for n in [startIndex, endIndex).
 * When endIndex is null (unknown previous count), probe upward window by
 * window via getByIds and delete whatever exists, stopping at the first
 * fully-empty window. Returns the number of vectors deleted.
 */
async function deleteVectorRange(index, standardId, startIndex, endIndex) {
  let deleted = 0;

  if (endIndex != null) {
    const ids = [];
    for (let n = startIndex; n < endIndex; n++) ids.push(`${standardId}-chunk-${n}`);
    for (let i = 0; i < ids.length; i += DELETE_BATCH) {
      const batch = ids.slice(i, i + DELETE_BATCH);
      const res = await index.deleteByIds(batch);
      deleted += res?.count ?? batch.length;
    }
    return deleted;
  }

  for (let start = startIndex; start < startIndex + PROBE_HARD_CAP; start += PROBE_WINDOW) {
    const ids = Array.from({ length: PROBE_WINDOW }, (_, j) => `${standardId}-chunk-${start + j}`);
    const found = await index.getByIds(ids);
    const foundIds = (found || []).map(v => v.id).filter(Boolean);
    if (foundIds.length === 0) break; // past the end of the stale tail
    const res = await index.deleteByIds(foundIds);
    deleted += res?.count ?? foundIds.length;
  }
  return deleted;
}

/**
 * Per-ingest coverage stats persisted to standards.coverage_json — the raw
 * material for the /api/admin/index-status full-indexing report.
 */
function buildCoverageStats(chunks) {
  const pages = new Set();
  const byType = {};
  for (const c of chunks) {
    if (c.pageNumber != null) pages.add(c.pageNumber);
    const t = c.type || 'text';
    byType[t] = (byType[t] || 0) + 1;
  }
  return { pagesWithChunks: pages.size, byType };
}

/**
 * Best-effort lookup of the Active standard that supersedes a deprecated one.
 *
 * Family = the id minus its trailing 2-digit edition year (and any errata
 * suffix): "RP-6-15" → "RP-6", "RP-27.2-00" → "RP-27.2", "RP-36-20+E2" →
 * "RP-36". The newest Active edition of that family (by year, then id) is
 * the superseding standard. Returns null when the family has no Active
 * edition indexed yet — re-ingesting the deprecated PDF later will fill it.
 */
async function findSupersedingStandard(db, standardId) {
  const m = /^(.+)-\d{2}(?:\+E\d+)?$/.exec(standardId);
  if (!m) return null;
  const family = m[1];
  try {
    const row = await db.prepare(`
      SELECT id FROM standards
      WHERE status = 'Active' AND id LIKE ?
      ORDER BY year DESC, id DESC
      LIMIT 1
    `).bind(`${family}-%`).first();
    return row?.id || null;
  } catch (err) {
    console.error('findSupersedingStandard failed (non-fatal):', err.message);
    return null;
  }
}

// ─── D1 Application Upsert ───────────────────────────────────────────────────
// Writes PDF-extracted application records into D1.
// Uses ON CONFLICT(code) DO UPDATE so re-ingesting a PDF refreshes the data.

const APP_COLS = [
  'code',
  // Hierarchy (8 levels per IES Illuminance Table reference 260421)
  'Sub_Category',
  'App', 'App_s1', 'App_s2', 'App_s3', 'App_s4', 'App_s5', 'App_s6',
  // Source
  'Standard', 'Standard_Full', 'Table_Ref', 'Row_Ref', 'Page_Number', 'Link_Mapping',
  // Type / classification
  'Area_or_Task', 'Indoor_Outdoor', 'App_Type',
  'Veiling_Risk', 'Class_of_Play',
  // Horizontal plane
  'Hor_Cat', 'Hor_Lux', 'Hor_Fc', 'Hor_Height_m', 'Hor_Height_ft',
  'Hor_Avg_Max_Min', 'Hor_Uniformity', 'Hor_CV', 'Hor_Ratio_Basis', 'Hor_Notes',
  // Vertical plane
  'Ver_Cat', 'Ver_Lux', 'Ver_Fc', 'Ver_Height_m', 'Ver_Height_ft',
  'Ver_Avg_Max_Min', 'Ver_Uniformity', 'Ver_CV', 'Ver_Ratio_Basis', 'Ver_Notes',
  // Task plane
  'Task_Cat', 'Task_Lux', 'Task_Fc', 'Task_Height_m', 'Task_Height_ft',
  'Task_Avg_Max_Min', 'Task_Uniformity', 'Task_Notes',
  // TM-24 spectral adjustment
  'TM24_Eligible', 'TM24_Notes',
  // Environmental & visual
  'Lighting_Zone', 'Max_Glare_Rating', 'Max_Uplight', 'Curfew_Dimming',
  'Spectrum_Guidance', 'Controls_Required',
  // Notes & links
  'Footnotes', 'Footnote_Marks', 'General_Notes', 'App_Notes',
  'Vitrium_Doc_ID', 'Vitrium_Deep_Link',
  'Active',
];

// Build the ON CONFLICT update clause — update everything except code and Vitrium links
// (Vitrium links are set by sync-metadata.js and should not be overwritten by PDF re-ingest)
const UPDATE_COLS = APP_COLS.filter(c =>
  c !== 'code' && c !== 'Vitrium_Doc_ID' && c !== 'Vitrium_Deep_Link'
);

async function upsertApplications(db, applications) {
  if (applications.length === 0) return 0;

  const BATCH = 1; // insert one row at a time to avoid D1 variable limit
  let upserted = 0;

  for (let i = 0; i < applications.length; i += BATCH) {
    const batch = applications.slice(i, i + BATCH);

    const placeholderRows = batch.map(() =>
      `(${APP_COLS.map(() => '?').join(', ')})`
    ).join(', ');

    const setClauses = UPDATE_COLS.map(c => `${c} = excluded.${c}`).join(', ');
    const sql = `
      INSERT INTO applications (${APP_COLS.join(', ')})
      VALUES ${placeholderRows}
      ON CONFLICT(code) DO UPDATE SET
        ${setClauses},
        updated_at = CURRENT_TIMESTAMP
    `;

    const bindings = batch.flatMap(app => APP_COLS.map(col => {
      const v = app[col];
      return (v === undefined || v === '') ? null : v;
    }));

    await db.prepare(sql).bind(...bindings).run();
    upserted += batch.length;
  }

  return upserted;
}

// ─── Application Embedding ────────────────────────────────────────────────────
// Re-embeds all D1 application rows into Vectorize.
// Safe to re-run at any time (upsert is idempotent).

async function ingestApplications(env) {
  const result = await env.DB.prepare(
    'SELECT * FROM applications WHERE Active = 1'
  ).all();

  const applications = result.results;
  if (applications.length === 0) {
    return jsonResponse({
      error: 'No applications in D1 yet. Ingest at least one PDF first, or run `npm run db:seed` with a bootstrap CSV.',
    }, 400);
  }

  const texts = applications.map(buildApplicationEmbedText);
  const embeddings = await embedInBatches(env.AI, texts);

  const vectors = applications.map((app, i) => ({
    id: app.code,
    values: embeddings[i],
    metadata: {
      application_code: app.code,
      standard_id: null,
      standard_code: app.Standard || '',
      chunk_type: 'application',
      page_number: null,
      section: null,
      excerpt_text: texts[i].substring(0, 500),
      indoor_outdoor: app.Indoor_Outdoor || 'Indoor',
      tm24_eligible: !!app.TM24_Eligible,
    },
  }));

  for (let i = 0; i < vectors.length; i += VECTORIZE_BATCH) {
    await env.VECTORIZE.upsert(vectors.slice(i, i + VECTORIZE_BATCH));
  }

  // Corpus changed — invalidate all cached search responses.
  await bumpDataVersion(env.SESSIONS);

  return jsonResponse({
    success: true,
    applicationsIndexed: vectors.length,
  });
}

/**
 * Build the text to embed for one application row.
 *
 * Goal: maximize cosine similarity between natural-language queries like
 * "playground lighting" and the application's vector. Strategy:
 *
 *   1. Front-load the *meaningful* hierarchy levels (App, App_s1) and
 *      strip parenthetical noise like "(if lighting is desired)" — those
 *      phrases dilute the signal because every Lz row contains them.
 *   2. Repeat the strongest noun (App_s1 if present, else App) so it
 *      dominates the bag-of-words. bge-base-en treats repetition as a
 *      mild boost for the repeated term's neighborhood.
 *   3. Include free-form text from notes *if* present, but skip the
 *      mostly-numeric leaf row labels like "Lz1 / Lower limit (avg.)" —
 *      those are filters, not topics.
 *   4. Include indoor/outdoor and area/task as plain English — these
 *      are common query qualifiers.
 */
function buildApplicationEmbedText(app) {
  const stripParens = (s) => s ? String(s).replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s+/g, ' ').trim() : '';

  // Pick the topical noun: App_s1 if it carries content, else App.
  const primary = stripParens(app.App_s1) || stripParens(app.App) || '';
  const category = stripParens(app.App) || '';
  const subCategory = stripParens(app.Sub_Category) || '';

  // Mid-hierarchy subdivisions that may add real topical info
  // (skip Lz0–Lz4 zone tags and Upper/Lower limit labels — those are filters).
  const isFilterToken = (s) =>
    !s || /^Lz\d/i.test(s) || /lower\s+limit|upper\s+limit/i.test(s) ||
    /^(?:I|II|III|IV)$/.test(s);
  const subPath = [app.App_s2, app.App_s3, app.App_s4, app.App_s5, app.App_s6]
    .map(stripParens)
    .filter(s => s && !isFilterToken(s));

  const parts = [
    primary, // strongest signal — repeated below
    category && category !== primary ? category : null,
    subPath.length ? subPath.join(' ') : null,
    subCategory ? subCategory.toLowerCase() : null,
    primary, // intentional repeat to weight the topic noun
    // Level-1 category repeat: users often query by CATEGORY name ("social
    // area", "fitting room") rather than the leaf row. Without this second
    // occurrence the leaf noun (App_s1) dominates the bag-of-words and
    // category-level queries under-match (client feedback: "social area"
    // must surface RP-11's Social areas rows the way "gaming" already did).
    category && category !== primary ? category : null,
    app.Indoor_Outdoor ? `${app.Indoor_Outdoor.toLowerCase()} application` : null,
    // Extractor writes 'Task'/'Area'; legacy CSV rows carry 'T'/'A'.
    /^T/i.test(app.Area_or_Task || '') ? 'task lighting'
      : /^A/i.test(app.Area_or_Task || '') ? 'area lighting' : null,
    app.Standard_Full || app.Standard ? `IES ${app.Standard_Full || app.Standard}` : null,
    app.App_Notes || null,
    app.General_Notes || null,
    app.Class_of_Play ? `class of play ${app.Class_of_Play}` : null,
    app.TM24_Eligible ? 'TM-24 spectral adjustment' : null,
  ];

  return parts.filter(Boolean).join('. ');
}

// ─── R2 Upload URL ────────────────────────────────────────────────────────────
// The Node.js script calls this to get a temporary URL for uploading the PDF to R2.
// Alternative: the script can use `wrangler r2 object put` directly.

async function getR2UploadUrl(request, env) {
  const { standardId } = await request.json();
  if (!standardId) return jsonResponse({ error: 'standardId required' }, 400);

  // R2 presigned URLs are not yet available in Workers (as of early 2025).
  // Return the R2 key so the script knows where to upload using Cloudflare API.
  const r2Key = `standards/${standardId}.pdf`;

  return jsonResponse({
    r2Key,
    uploadMethod: 'wrangler',
    command: `wrangler r2 object put ies-standards-pdfs/${r2Key} --file=<path-to-pdf>`,
    note: 'Upload the PDF to R2 using the command above before running ingestion.',
  });
}

// ─── Shared Helpers ───────────────────────────────────────────────────────────

async function embedInBatches(ai, texts) {
  const embeddings = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH) {
    const batch = texts.slice(i, i + EMBED_BATCH);
    const response = await embedWithRetry(ai, batch, i / EMBED_BATCH);
    embeddings.push(...response.data);
  }
  return embeddings;
}

/**
 * One embedding batch with bounded retries. Workers AI throws transient
 * capacity errors under load; without retries a single blip aborts the whole
 * document mid-index. The batch either fully succeeds (with one embedding per
 * input) or the ingest fails loudly — never a silent partial.
 */
async function embedWithRetry(ai, batch, batchIndex) {
  let lastErr;
  for (let attempt = 1; attempt <= EMBED_MAX_ATTEMPTS; attempt++) {
    try {
      const response = await ai.run(EMBED_MODEL, { text: batch });
      if (!Array.isArray(response?.data) || response.data.length !== batch.length) {
        throw new Error(`embedding batch ${batchIndex}: expected ${batch.length} vectors, got ${response?.data?.length ?? 0}`);
      }
      return response;
    } catch (err) {
      lastErr = err;
      if (attempt < EMBED_MAX_ATTEMPTS) {
        await new Promise(r => setTimeout(r, attempt * 1000));
      }
    }
  }
  throw lastErr;
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
