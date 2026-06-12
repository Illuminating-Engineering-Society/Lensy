/**
 * Lucius Ingest Worker
 *
 * IMPORTANT: This Worker does NOT parse PDFs. PDF parsing (pdfjs-dist) requires
 * Node.js and cannot run in a Cloudflare Worker. The ingestion script
 * (scripts/ingest-pdfs.js) handles all PDF parsing and sends pre-parsed data here.
 *
 * Endpoints:
 *
 *   POST /api/ingest
 *     Accept pre-parsed PDF data from the ingestion script.
 *     Body: { standardId, metadata, chunks, tables, applications }
 *     - chunks:       [{text, pageNumber, section, type}]       → Vectorize
 *     - tables:       [{pageNumber, title, rows, ...}]          → D1 standards.tables_json
 *     - applications: [{code, App, Hor_Lux, ...}]  (optional)  → D1 applications (upsert)
 *
 *   POST /api/ingest/applications
 *     Re-embed all D1 application rows into Vectorize.
 *     Can be called after seeding or after PDF-extracted records are in D1.
 *
 *   POST /api/ingest/r2-upload-url
 *     Return R2 key and wrangler command for uploading the raw PDF.
 */

import { bumpDataVersion } from '../lib/cache.js';

const EMBED_MODEL = '@cf/baai/bge-base-en-v1.5';
const EMBED_BATCH = 100;       // Workers AI max per call
const VECTORIZE_BATCH = 1000;  // Vectorize max per upsert

export async function handleIngest(request, env) {
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
    metadata = {},
    chunks = [],
    tables = [],
    applications = [],  // extracted application records from PDF tables
    r2Key = null,
  } = body;

  if (!standardId) return jsonResponse({ error: 'standardId is required' }, 400);
  // chunks can be empty when request is only upserting applications
  if (!Array.isArray(chunks)) {
    return jsonResponse({ error: 'chunks must be an array' }, 400);
  }

  // ── 1. Generate embeddings for all chunks (skip if none) ──────────────────
  if (chunks.length > 0) {
    for (const chunk of chunks.slice(0, 3)) {
      if (typeof chunk.text !== 'string' || !chunk.text.trim()) {
        return jsonResponse({ error: 'Each chunk must have a non-empty text field' }, 400);
      }
    }
  }

  const embeddings = chunks.length > 0
    ? await embedInBatches(env.AI, chunks.map(c => c.text))
    : [];

  // ── 2. Build Vectorize vectors ─────────────────────────────────────────────
  const vectors = chunks.map((chunk, i) => ({
    id: `${standardId}-chunk-${i}`,
    values: embeddings[i],
    metadata: {
      standard_id: standardId,
      application_code: null,
      standard_code: standardId,
      chunk_type: chunk.type || 'text',       // 'text' | 'table' | 'section_heading'
      page_number: chunk.pageNumber || null,
      section: chunk.section || null,         // e.g. "3.5" from IES section numbering
      excerpt_text: chunk.text.substring(0, 500), // metadata size limit ~1KB
      indoor_outdoor: null,
      tm24_eligible: null,
    },
  }));

  // ── 3. Upsert into Vectorize (batched) ────────────────────────────────────
  for (let i = 0; i < vectors.length; i += VECTORIZE_BATCH) {
    await env.VECTORIZE.upsert(vectors.slice(i, i + VECTORIZE_BATCH));
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

  if (chunks.length > 0 || tables.length > 0 || metadata.title) await env.DB.prepare(`
    INSERT INTO standards
      (id, title, description, author, year, full_designation, r2_key,
       tables_json, indexed_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET
      title        = excluded.title,
      description  = excluded.description,
      author       = excluded.author,
      year         = excluded.year,
      full_designation = excluded.full_designation,
      r2_key       = COALESCE(excluded.r2_key, standards.r2_key),
      tables_json  = excluded.tables_json,
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
    applicationsUpserted,
  });
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
  'Footnotes', 'General_Notes', 'App_Notes',
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
    app.Indoor_Outdoor ? `${app.Indoor_Outdoor.toLowerCase()} application` : null,
    app.Area_or_Task === 'T' ? 'task lighting' : app.Area_or_Task === 'A' ? 'area lighting' : null,
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
    const response = await ai.run(EMBED_MODEL, { text: batch });
    embeddings.push(...response.data);
  }
  return embeddings;
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
