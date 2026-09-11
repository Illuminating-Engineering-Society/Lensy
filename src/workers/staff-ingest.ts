/**
 * Lensy Staff Ingest Jobs — the dashboard-driven "upload a new edition" flow
 * (client, 2026-09-10: a staff dashboard to select an existing standard, upload
 * a replacement PDF, watch the AI read + index it, and choose what happens to
 * the old edition).
 *
 * Division of labour — the SAME split as scripts/ingest-pdfs.js, one seat over:
 *
 *   Staff browser (admin/standards.html)        This Worker
 *   ─────────────────────────────────────       ─────────────────────────────
 *   1. upload raw PDF            ─────────────► ingest-jobs/<id>/source.pdf (R2)
 *   2. parse PDF with pdfjs (vendored copy —
 *      pdfjs cannot run in workerd)
 *   3. send RAW text items per page  ─────────► lines/text rebuilt by
 *                                               src/lib/pdf-pages.js (the very
 *                                               functions the Node script uses),
 *                                               stored per batch in R2
 *   4. POST /process             ─────────────► cover title, structure, tables,
 *                                               applications, chunks, outline,
 *                                               captions — all src/lib — then
 *                                               runDocumentIngest() (embeddings,
 *                                               Vectorize, D1), with per-step
 *                                               progress written to the job row
 *   5. POST /finalize            ─────────────► old-edition disposition
 *
 * The browser ships only raw pdfjs text items; every judgement (line building,
 * chunking, extraction) happens HERE, in the modules the Node pipeline imports,
 * so the two ingest paths cannot drift. The job row (migration 0017) is the
 * progress tracker the page polls and the audit line afterwards.
 *
 * Old-edition dispositions (chosen at job creation, applied at finalize):
 *   'deprecate' — the RP-27/RP-8 demotion shape: D1 status → 'Deprecated' with
 *                 superseded_by → the new id, the PDF moved to the deprecated/
 *                 R2 prefix. The old edition's main-index vectors are NOT
 *                 deleted: search filters them by live D1 status
 *                 (notDeprecated), the same posture as the manual demotions.
 *                 Optionally a follow-up job is created to index the old
 *                 edition into the DEPRECATED index for version comparison.
 *   'delete'    — vectors, application rows (+ their vectors), the standards
 *                 row and the PDF are all removed.
 *   'none'      — nothing to do (new standard, or a same-id re-ingest, where
 *                 runDocumentIngest already overwrote in place).
 *
 * Endpoints (all requireAdminAccess — SSO admin session or the staff bearer):
 *   POST /api/admin/ingest-jobs                create a job
 *   GET  /api/admin/ingest-jobs                recent jobs (?limit=)
 *   GET  /api/admin/ingest-jobs/:id            one job — the poll target
 *   POST /api/admin/ingest-jobs/:id/pdf        raw PDF bytes → R2
 *   GET  /api/admin/ingest-jobs/:id/pdf        stream the PDF back (resume, and
 *                                              the comparison follow-up parse)
 *   POST /api/admin/ingest-jobs/:id/docx       optional Word manuscript → R2
 *                                              (validated: tracked changes and a
 *                                              wrong-family designation refuse)
 *   DELETE /api/admin/ingest-jobs/:id/docx     detach the manuscript
 *   POST /api/admin/ingest-jobs/:id/pages      one batch of raw pages
 *   POST /api/admin/ingest-jobs/:id/process    extract + embed + index
 *   POST /api/admin/ingest-jobs/:id/finalize   old-edition disposition + cleanup
 *   POST /api/admin/ingest-jobs/:id/cancel    abandon + clean up staging
 *
 * Dual-upload (docs/DOCX_INGEST.md, client 2026-09-11): when a job carries a
 * Word manuscript, /process reads the CONTENT from it (headings by style,
 * references as paragraphs, real tables, linearized math — none of the PDF
 * layout heuristics) and src/lib/page-align.js stamps every chunk with the
 * page of the published PDF, which stays the citation authority. Unlike the
 * PDF, the .docx is parsed in the Worker itself (ZIP + XML — no pdfjs, no
 * browser step). Every failure downgrades to the proven PDF-only path with a
 * warning, never to a failed ingest; a body-drift above
 * DOCX_BODY_DRIFT_LIMIT means the files look like different revisions and the
 * manuscript is discarded rather than indexing draft text under a published
 * standard's name.
 *
 * NOT here, by design: pushing the new PDF to Vitrium. The client's longer-term
 * goal is for Lensy to be the single place staff update a standard everywhere,
 * but Vitrium API access is still blocked (privilege grant pending with
 * Vitrium's rep) — see docs/STAFF_INGEST.md for the planned seam.
 */

import { requireAdminAccess } from './session';
import { getSsoState } from '../lib/sso';
import { bumpDataVersion } from '../lib/cache';
import {
  runDocumentIngest, deleteVectorRange, pruneApplicationRowsCore, pdfKeyFor,
} from './ingest';
import {
  buildPageFromRaw, cleanDocMeta, detectHeadersFootersFromRaw,
} from '../lib/pdf-pages.js';
import { deriveStandardId, inferFullDesignation, standardFamilyOf } from '../lib/standard-id.js';
import { extractIESTables, extractGeneralNotes } from '../lib/table-extractor.js';
import { chunkIESDocument, extractOutline } from '../lib/chunker.js';
import { extractDocumentAssets } from '../lib/document-assets.js';
import { extractCoverMetadata, extractCoverCommittee } from '../lib/cover-title.js';
import { extractReferenceMarkers } from '../lib/reference-markers.js';
import {
  extractApplicationsFromPages, detectNewTableStructure,
} from '../lib/applications-extractor.js';
import { extractDocx } from '../lib/docx-extract.js';
import { alignChunksToPdfPages, alignSequenceToPages } from '../lib/page-align.js';

function errMsg(err: unknown): string { return err instanceof Error ? err.message : String(err); }

// Staging keys live under their own prefix so the R2 sweep (which lists only
// standards/ and deprecated/) can never mistake a half-run job for an orphan.
const JOB_R2_PREFIX = 'ingest-jobs/';
const MAX_PAGES_PER_BATCH = 50;
// `${id}-chunk-<n>` must stay inside Vectorize's 64-byte vector-id limit.
const MAX_STANDARD_ID_LENGTH = 40;
const STANDARD_ID_RE = /^[A-Za-z]{1,3}-[0-9][0-9A-Za-z.+-]*$/;
const APP_DELETE_BATCH = 50;   // D1 bound-param budget (same as ingest prune)
const VEC_DELETE_BATCH = 100;  // Vectorize deleteByIds cap (measured, admin.ts)

// Manuscripts are text: the largest .docx in a standards workflow is a few MB;
// far beyond that it is the wrong file (or carries embedded media we would
// hold in memory to parse).
const MAX_DOCX_BYTES = 40 * 1024 * 1024;
// Above this fraction of PROSE chunks unlocatable in the PDF, the two files
// look like different revisions and the manuscript is discarded (design
// threshold in docs/DOCX_INGEST.md). Tables are excluded from the gate: a
// DOCX table serializes cells in an order the PDF's layout stream need not
// share, so they legitimately miss.
const DOCX_BODY_DRIFT_LIMIT = 0.05;
// A manuscript yielding far fewer passages than the PDF is not the full
// published document (a chapter draft, an outline).
const DOCX_MIN_CHUNK_RATIO = 0.4;

interface IngestJobRow {
  id: string;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  filename: string;
  standard_id: string;
  ingest_status: string;
  replaces_id: string | null;
  disposition: string;
  index_old_for_comparison: number;
  status: string;
  step: string | null;
  progress_json: string | null;
  page_count: number | null;
  pages_received: number;
  pdf_key: string | null;
  pdf_size: number | null;
  docx_key: string | null;
  docx_size: number | null;
  alignment_json: string | null;
  result_json: string | null;
  error: string | null;
}

interface RawPage {
  number: number;
  view: number[];
  items: Array<{ str: string; transform: number[]; fontName?: string; width?: number; hasEOL?: boolean }>;
}

export async function handleIngestJobs(request: Request, env: Env, url: URL): Promise<Response> {
  const denied = await requireAdminAccess(request, env);
  if (denied) return denied;

  // /api/admin/ingest-jobs[/:id[/:action]]
  const rest = url.pathname.replace(/^\/api\/admin\/ingest-jobs\/?/, '');
  const [rawId, action] = rest.split('/');
  const jobId = rawId ? safeDecode(rawId) : '';

  if (!jobId) {
    if (request.method === 'GET') return listJobs(env, url);
    if (request.method === 'POST') return createJob(request, env);
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }

  const job = await getJob(env, jobId);
  if (!job) return jsonResponse({ error: `No ingest job "${jobId}"` }, 404);

  if (!action) {
    if (request.method === 'GET') return jsonResponse({ job: publicJob(job) });
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }

  switch (action) {
    case 'pdf':
      if (request.method === 'POST') return uploadPdf(request, env, job);
      if (request.method === 'GET') return downloadPdf(env, job);
      return jsonResponse({ error: 'Method not allowed' }, 405);
    case 'docx':
      if (request.method === 'POST') return uploadDocx(request, env, job);
      if (request.method === 'DELETE') return removeDocx(env, job);
      return jsonResponse({ error: 'Method not allowed' }, 405);
    case 'pages':
      if (request.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);
      return receivePages(request, env, job);
    case 'process':
      if (request.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);
      return processJob(request, env, job);
    case 'finalize':
      if (request.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);
      return finalizeJob(env, job);
    case 'cancel':
      if (request.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);
      return cancelJob(env, job);
    default:
      return jsonResponse({ error: `Unknown action "${action}"` }, 404);
  }
}

// ─── Create / list / read ─────────────────────────────────────────────────────

async function createJob(request: Request, env: Env): Promise<Response> {
  const body = await safeJson(request);

  const filename = typeof body.filename === 'string' ? body.filename.trim().slice(0, 300) : '';
  if (!filename) return jsonResponse({ error: 'filename is required' }, 400);

  const standardId = String(body.standardId || deriveStandardId(filename)).trim();
  if (!STANDARD_ID_RE.test(standardId) || standardId.length > MAX_STANDARD_ID_LENGTH) {
    return jsonResponse({
      error: `"${standardId}" does not look like an IES standard id (e.g. RP-43-25, LM-63-19, RP-8-25+E2). ` +
             'Override it explicitly if the filename cannot be parsed.',
    }, 400);
  }

  const ingestStatus = body.status === 'deprecated' ? 'deprecated' : 'current';

  const warnings: string[] = [];

  // What (if anything) this upload replaces.
  let replacesId: string | null = null;
  let replacedRow: { id: string; status: string } | null = null;
  if (body.replacesId != null && body.replacesId !== '') {
    replacesId = String(body.replacesId).trim();
    replacedRow = await env.DB.prepare('SELECT id, status FROM standards WHERE id = ?')
      .bind(replacesId).first<{ id: string; status: string }>();
    if (!replacedRow) {
      return jsonResponse({ error: `replacesId "${replacesId}" has no standards row — pick it from the list.` }, 400);
    }
    const oldFamily = standardFamilyOf(replacesId);
    const newFamily = standardFamilyOf(standardId);
    if (oldFamily && newFamily && oldFamily !== newFamily) {
      warnings.push(`"${standardId}" and "${replacesId}" are different standard FAMILIES (${newFamily} vs ${oldFamily}) — ` +
        'a replacement is normally a new edition of the same family. Double-check before finalizing.');
    }
  }

  const samePdf = replacesId === standardId;
  let disposition = ['deprecate', 'delete', 'none'].includes(body.disposition)
    ? body.disposition
    : (replacesId && !samePdf ? 'deprecate' : 'none');
  if (!replacesId || samePdf) disposition = 'none';
  if (samePdf) {
    warnings.push(`"${standardId}" replaces itself — this is an in-place re-ingest (corrected file / re-parse); ` +
      'no old-edition handling will run.');
  }

  const indexOldForComparison = body.indexOldForComparison === true && disposition === 'deprecate';

  const existing = await env.DB.prepare('SELECT id, status FROM standards WHERE id = ?')
    .bind(standardId).first<{ id: string; status: string }>();
  if (existing && !samePdf) {
    if (ingestStatus === 'deprecated' && existing.status === 'Active') {
      warnings.push(`"${standardId}" is currently indexed as an ACTIVE standard — a deprecated ingest under the same id ` +
        'will be refused at the indexing step unless a higher errata is Active (the reaffirmed-printing guard).');
    } else {
      warnings.push(`"${standardId}" is already indexed (status ${existing.status}) — this upload will overwrite it in place.`);
    }
  }

  // Attribution: the staff member's email off the SSO cookie; scripts on the
  // bearer have no identity to record.
  let createdBy = 'staff-bearer';
  try {
    const sso = await getSsoState(request, env);
    if (sso.state === 'ok') createdBy = sso.user.email;
  } catch { /* attribution is best-effort */ }

  const id = crypto.randomUUID();
  try {
    await env.DB.prepare(`
      INSERT INTO ingest_jobs
        (id, created_by, filename, standard_id, ingest_status, replaces_id,
         disposition, index_old_for_comparison, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'created')
    `).bind(
      id, createdBy, filename, standardId, ingestStatus, replacesId,
      disposition, indexOldForComparison ? 1 : 0,
    ).run();
  } catch (err) {
    return jsonResponse({
      error: `Could not create the job row — has migration 0017_ingest_jobs been applied? (${errMsg(err)})`,
    }, 500);
  }

  const job = await getJob(env, id);
  return jsonResponse({ job: job ? publicJob(job) : { id }, warnings }, 201);
}

async function listJobs(env: Env, url: URL): Promise<Response> {
  const limit = Math.min(200, Math.max(1, parseInt(url.searchParams.get('limit') || '50', 10) || 50));
  try {
    const rows = await env.DB.prepare(
      'SELECT * FROM ingest_jobs ORDER BY created_at DESC LIMIT ?'
    ).bind(limit).all<IngestJobRow>();
    return jsonResponse({ jobs: (rows.results || []).map(publicJob) });
  } catch (err) {
    // A missing table reads as an empty queue plus the reason, not a 500 —
    // same posture as the device-resets export.
    return jsonResponse({ jobs: [], note: `ingest_jobs unavailable (migration 0017 applied?): ${errMsg(err)}` });
  }
}

// ─── PDF upload / download ────────────────────────────────────────────────────

async function uploadPdf(request: Request, env: Env, job: IngestJobRow): Promise<Response> {
  if (!['created', 'uploaded', 'failed'].includes(job.status)) {
    return jsonResponse({ error: `Job is ${job.status} — the PDF can only be (re)uploaded before parsing completes.` }, 409);
  }

  const key = `${JOB_R2_PREFIX}${job.id}/source.pdf`;

  // Very large files arrive through POST /api/admin/r2-multipart (same key);
  // this JSON mode just records the finished upload on the job row.
  if ((request.headers.get('content-type') || '').includes('application/json')) {
    const body = await safeJson(request);
    if (body.multipartComplete !== true) {
      return jsonResponse({ error: 'JSON bodies here only accept { "multipartComplete": true }' }, 400);
    }
    const head = await env.PDFS.head(key);
    if (!head) return jsonResponse({ error: `No object at ${key} — complete the multipart upload first.` }, 400);
    await touchJob(env, job.id, { pdf_key: key, pdf_size: head.size, status: 'uploaded', error: null });
    return jsonResponse({ success: true, key, size: head.size });
  }

  if (!request.body) return jsonResponse({ error: 'Request body (raw PDF bytes) required' }, 400);
  let size: number;
  try {
    const obj = await env.PDFS.put(key, request.body, {
      httpMetadata: { contentType: 'application/pdf' },
    });
    size = obj?.size ?? 0;
  } catch (err) {
    return jsonResponse({
      error: `R2 upload failed: ${errMsg(err)}. Very large files (>~100 MB) should go through ` +
             'POST /api/admin/r2-multipart with key ' + key,
    }, 500);
  }

  await touchJob(env, job.id, { pdf_key: key, pdf_size: size, status: 'uploaded', error: null });
  return jsonResponse({ success: true, key, size });
}

async function downloadPdf(env: Env, job: IngestJobRow): Promise<Response> {
  const key = job.pdf_key || `${JOB_R2_PREFIX}${job.id}/source.pdf`;
  const obj = await env.PDFS.get(key);
  if (!obj) return jsonResponse({ error: `No PDF stored at ${key}` }, 404);
  return new Response(obj.body, {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Length': String(obj.size),
      'Content-Disposition': `attachment; filename="${job.standard_id}.pdf"`,
    },
  });
}

// ─── Word manuscript upload (optional — the dual-upload content source) ───────

async function uploadDocx(request: Request, env: Env, job: IngestJobRow): Promise<Response> {
  if (!['created', 'uploaded', 'parsing', 'parsed', 'failed'].includes(job.status)) {
    return jsonResponse({ error: `Job is ${job.status} — the manuscript can only be attached before processing completes.` }, 409);
  }
  if (!request.body) return jsonResponse({ error: 'Request body (raw .docx bytes) required' }, 400);

  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.length > MAX_DOCX_BYTES) {
    return jsonResponse({ error: `The manuscript is ${Math.round(bytes.length / 1024 / 1024)} MB — larger than any Word standards manuscript should be (limit ${MAX_DOCX_BYTES / 1024 / 1024} MB).` }, 400);
  }

  // Validate NOW, while the staff member is looking at the tracker, not at
  // /process minutes later: tracked changes and structural failures refuse the
  // upload with an actionable message (design rule 2 in docs/DOCX_INGEST.md).
  let extraction;
  try {
    extraction = await extractDocx(bytes);
  } catch (err) {
    return jsonResponse({ error: `Not a usable Word manuscript: ${errMsg(err)}` }, 400);
  }

  // The wrong-manuscript check: a new edition's manuscript names its own
  // designation, which must share the job's FAMILY (RP-8-25's manuscript says
  // RP-8-something). A manuscript with no detectable designation passes — the
  // alignment drift gate catches a wrong file at /process anyway.
  const docxFamily = extraction.designation ? standardFamilyOf(extraction.designation) : null;
  const jobFamily = standardFamilyOf(job.standard_id);
  if (docxFamily && jobFamily && docxFamily !== jobFamily) {
    return jsonResponse({
      error: `The manuscript names ${extraction.designation} — a different standard family than ${job.standard_id}. ` +
             'Attach the matching Word file, or fix the job id.',
    }, 400);
  }

  const key = `${JOB_R2_PREFIX}${job.id}/source.docx`;
  await env.PDFS.put(key, bytes, {
    httpMetadata: { contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  });
  await touchJob(env, job.id, { docx_key: key, docx_size: bytes.length });

  return jsonResponse({
    success: true,
    key,
    size: bytes.length,
    designation: extraction.designation,
    stats: extraction.stats,
  });
}

async function removeDocx(env: Env, job: IngestJobRow): Promise<Response> {
  if (job.docx_key) {
    try { await env.PDFS.delete(job.docx_key); } catch { /* staging sweep gets it */ }
  }
  await touchJob(env, job.id, { docx_key: null, docx_size: null, alignment_json: null });
  return jsonResponse({ success: true });
}

// ─── Raw pages intake ─────────────────────────────────────────────────────────

async function receivePages(request: Request, env: Env, job: IngestJobRow): Promise<Response> {
  if (!['uploaded', 'parsing', 'parsed', 'failed'].includes(job.status)) {
    return jsonResponse({ error: `Job is ${job.status} — pages are only accepted after the PDF upload.` }, 409);
  }

  const body = await safeJson(request);
  const totalPages = body.totalPages;
  const pageStart = body.pageStart;
  const pages = body.pages;
  if (!Number.isInteger(totalPages) || totalPages < 1 || totalPages > 5000) {
    return jsonResponse({ error: 'totalPages must be an integer between 1 and 5000' }, 400);
  }
  if (!Number.isInteger(pageStart) || pageStart < 1 || pageStart > totalPages) {
    return jsonResponse({ error: 'pageStart must be an integer within the document' }, 400);
  }
  if (!Array.isArray(pages) || pages.length === 0 || pages.length > MAX_PAGES_PER_BATCH) {
    return jsonResponse({ error: `pages must carry 1–${MAX_PAGES_PER_BATCH} raw pages` }, 400);
  }
  for (const [i, p] of (pages as RawPage[]).entries()) {
    if (!Number.isInteger(p?.number) || !Array.isArray(p?.view) || p.view.length < 4 || !Array.isArray(p?.items)) {
      return jsonResponse({ error: `pages[${i}] needs { number, view: [x0,y0,x1,y1], items: [] }` }, 400);
    }
  }

  const progress = parseJsonColumn(job.progress_json) || {};

  // The first batch teaches us the document's repeating headers/footers — every
  // later page is built against that set, so it has to arrive first.
  if (!Array.isArray(progress.headerFooters)) {
    if (pageStart !== 1) {
      return jsonResponse({ error: 'Send the batch starting at page 1 first — it establishes the header/footer set.' }, 409);
    }
    const sampleNeed = Math.min(5, totalPages);
    if (pages.length < sampleNeed) {
      return jsonResponse({ error: `The first batch must carry at least ${sampleNeed} pages (header/footer sampling).` }, 400);
    }
    progress.headerFooters = [...detectHeadersFootersFromRaw(pages as RawPage[])];
    progress.docMeta = cleanDocMeta(body.docMeta);
    progress.totalPages = totalPages;
    progress.batches = {};
  } else if (progress.totalPages !== totalPages) {
    return jsonResponse({
      error: `totalPages changed mid-job (${progress.totalPages} → ${totalPages}) — cancel and start a new job for a different file.`,
    }, 409);
  }

  const headerFooterSet = new Set<string>(progress.headerFooters);
  const built = (pages as RawPage[]).map(p => buildPageFromRaw(p, headerFooterSet));

  const batchKey = `${JOB_R2_PREFIX}${job.id}/pages-${String(pageStart).padStart(5, '0')}.json`;
  await env.PDFS.put(batchKey, JSON.stringify(built), {
    httpMetadata: { contentType: 'application/json' },
  });

  progress.batches = { ...(progress.batches || {}), [String(pageStart)]: pages.length };
  const pagesReceived = Object.values(progress.batches as Record<string, number>)
    .reduce((s, n) => s + (Number(n) || 0), 0);
  const done = pagesReceived >= totalPages;

  await touchJob(env, job.id, {
    progress_json: JSON.stringify(progress),
    page_count: totalPages,
    pages_received: pagesReceived,
    status: done ? 'parsed' : 'parsing',
    error: null,
  });

  return jsonResponse({ success: true, received: pages.length, pagesReceived, totalPages, done });
}

// ─── Extraction + indexing ────────────────────────────────────────────────────

async function processJob(request: Request, env: Env, job: IngestJobRow): Promise<Response> {
  const complete = job.page_count != null && job.page_count > 0 && job.pages_received >= job.page_count;
  if (!complete || !['parsed', 'processing', 'indexed', 'failed'].includes(job.status)) {
    return jsonResponse({
      error: `Job is not ready to process (status ${job.status}, ${job.pages_received}/${job.page_count ?? '?'} pages received).`,
    }, 409);
  }

  const body = await safeJson(request);
  const forceStructure = body.forceStructure === 'new_table' || body.forceStructure === 'standard'
    ? body.forceStructure : null;

  const progress = parseJsonColumn(job.progress_json) || {};
  const docMeta = progress.docMeta || {};
  const isDeprecated = job.ingest_status === 'deprecated';

  // Per-step progress the dashboard polls off the job row. Advisory: a failed
  // write must never fail the ingest.
  const setStep = async (step: string, detail?: Record<string, unknown>) => {
    try {
      progress.run = { step, ...(detail || {}), at: new Date().toISOString() };
      await touchJob(env, job.id, { step, progress_json: JSON.stringify(progress) });
    } catch { /* advisory */ }
  };

  await touchJob(env, job.id, { status: 'processing', error: null });

  try {
    // ── Reassemble the document from the stored page batches ────────────────
    await setStep('assemble');
    const pages = await loadBuiltPages(env, job.id);
    if (pages.length !== job.page_count) {
      throw new Error(`Stored pages (${pages.length}) do not match page_count (${job.page_count}) — re-send the pages.`);
    }

    // ── The same steps, in the same order, as scripts/ingest-pdfs.js ────────
    await setStep('extract');
    const cover = extractCoverMetadata(pages);
    const coverCommittee = extractCoverCommittee(pages);
    const title = cover.title || docMeta.title || '';

    const detection = detectNewTableStructure(pages);
    const structure = isDeprecated
      ? 'standard'
      : (forceStructure || (detection.isNewTable ? 'new_table' : 'standard'));

    const tables = extractIESTables(pages);

    const standardMeta = {
      fullDesignation: cover.designation || inferFullDesignation(job.standard_id, title),
      year: docMeta.year || null,
      author: docMeta.author || coverCommittee,
    };
    const applications = structure === 'new_table'
      ? extractApplicationsFromPages(pages, job.standard_id, standardMeta)
      : [];

    const generalNotes = extractGeneralNotes(pages);
    const noteChunks = generalNotes.map((n: { heading: string; text: string; pageNumber: number }) => ({
      text: `[${n.heading}]\n${n.text}`,
      pageNumber: n.pageNumber,
      section: n.heading.replace(/[:.].*/, '').trim(),
      type: 'general_notes',
      wordCount: n.text.split(/\s+/).length,
    }));
    // No sizing overrides: the chunker's own DEFAULTS are the single source
    // (the Node script's CONFIG mirrors them and is documented as such).
    const pdfBodyChunks = chunkIESDocument(pages);
    const referenceMarkers = extractReferenceMarkers(pages);
    const pdfAssets = extractDocumentAssets(pages);

    // The same ingest-time quality warnings the script prints, kept on the job
    // row so the dashboard can surface them.
    const warnings: string[] = [];

    // ── The dual-upload content source (docs/DOCX_INGEST.md) ────────────────
    // With a manuscript attached, the CONTENT comes from its structure and
    // every page number from aligning it against the PDF — which stays what
    // the reader's Library links open. Any failure below downgrades to the
    // proven PDF-only path with a warning, never to a failed ingest.
    let chunks = [...pdfBodyChunks, ...noteChunks];
    let outline = extractOutline(pages);
    let assets = pdfAssets;
    let contentSource = 'pdf';
    let alignmentReport: Record<string, unknown> | null = null;

    if (job.docx_key) {
      const manuscript = await useDocxManuscript(env, job, pages, pdfBodyChunks.length, pdfAssets, setStep);
      alignmentReport = manuscript.report || null;
      if (manuscript.ok) {
        chunks = [...manuscript.chunks, ...noteChunks];
        outline = manuscript.outline;
        assets = manuscript.assets;
        contentSource = 'docx+pdf';
      } else {
        warnings.push(manuscript.warning);
      }
    }

    const sections: Record<string, string> = {};
    for (const entry of outline) if (entry.title && !sections[entry.number]) sections[entry.number] = entry.title;
    const coveredPages = new Set(chunks.map((c: { pageNumber: number | null }) => c.pageNumber).filter(p => p != null));
    const coveragePct = pages.length > 0 ? Math.round((coveredPages.size / pages.length) * 100) : 0;
    if (coveragePct < 60 && pages.length > 3) {
      warnings.push(`LOW COVERAGE: only ${coveragePct}% of pages produced chunks — inspect this PDF's parse.`);
    }
    const byType: Record<string, number> = {};
    for (const c of chunks) byType[c.type || 'text'] = (byType[c.type || 'text'] || 0) + 1;
    const hasReferencesHeading = pages.some((p: { text: string }) =>
      /(?:^|\n)\s*(?:[\d.]+\s+|Annex\s+[A-Z]\s+)?(?:Normative\s+|Informative\s+)?References?\s*(?:\n|$)/i.test(p.text));
    if (hasReferencesHeading && !byType.reference) {
      warnings.push('A References heading was detected but no reference chunks were produced — reference search will miss this standard.');
    }
    if (byType.reference && Object.keys(referenceMarkers).length === 0) {
      warnings.push('Reference entries were indexed but no in-body superscript markers were found — Reference chips will link to the References page.');
    }
    if (outline.length === 0 && pages.length > 5) {
      warnings.push('No section headings were recognised — body excerpts will show a section number without its title.');
    }
    if (!cover.title) {
      warnings.push('The cover page yielded no title — this standard will cite as a bare designation unless the Vitrium export supplies one.');
    }

    // ── Move the raw PDF to its library home before indexing points at it ───
    await setStep('store');
    const finalKey = pdfKeyFor(job.standard_id, isDeprecated ? 'Deprecated' : 'Active');
    let pdfStored = false;
    try {
      pdfStored = await copyR2Object(env, job.pdf_key || `${JOB_R2_PREFIX}${job.id}/source.pdf`, finalKey);
    } catch (err) {
      console.error(`staff-ingest: PDF copy to ${finalKey} failed (non-fatal):`, errMsg(err));
    }
    if (!pdfStored) warnings.push(`The raw PDF could not be copied to ${finalKey} — links to the Library are unaffected, but the R2 copy is missing.`);

    // ── Embeddings + Vectorize + D1, in-process, with progress ──────────────
    const { status: code, payload } = await runDocumentIngest({
      standardId: job.standard_id,
      structure,
      status: job.ingest_status,
      metadata: {
        title,
        author: standardMeta.author,
        subject: docMeta.subject || null,
        year: docMeta.year || null,
        fullDesignation: standardMeta.fullDesignation,
        pageCount: pages.length,
      },
      chunks,
      tables,
      applications,
      referenceMarkers,
      sections,
      outline,
      assets,
      r2Key: finalKey,
    }, env, setStep);

    if (code !== 200) {
      const message = String((payload as { error?: string }).error || `ingest failed (${code})`);
      await touchJob(env, job.id, { status: 'failed', step: null, error: message });
      return jsonResponse(payload, code);
    }

    // ── Prune application rows a re-parse no longer produces ────────────────
    let applicationsPruned = 0;
    if (applications.length > 0 && !isDeprecated) {
      await setStep('prune');
      const pruned = await pruneApplicationRowsCore(
        env, job.standard_id, new Set(applications.map((a: { code: string }) => a.code)));
      applicationsPruned = pruned.deleted;
      if (applicationsPruned > 0) await bumpDataVersion(env.SESSIONS);
    }

    const result = {
      structure,
      title,
      committee: coverCommittee || null,
      pageCount: pages.length,
      coveragePct,
      chunksIndexed: (payload as { chunksIndexed?: number }).chunksIndexed ?? chunks.length,
      chunkTypes: byType,
      tablesFound: tables.length,
      applicationsUpserted: (payload as { applicationsUpserted?: number }).applicationsUpserted ?? 0,
      applicationsPruned,
      sectionTitles: outline.length,
      assetCaptions: assets.length,
      // 'docx+pdf' = the manuscript's structure is what got indexed; 'pdf' =
      // the classic path (no manuscript, or one that was downgraded — see
      // warnings and the alignment report for why).
      source: contentSource,
      alignment: alignmentReport ? {
        total: alignmentReport.total,
        located: alignmentReport.located,
        inherited: alignmentReport.inherited,
        uncoveredPdfPages: alignmentReport.uncoveredPageCount,
      } : null,
      warnings,
    };

    await touchJob(env, job.id, {
      status: 'indexed',
      step: 'done',
      result_json: JSON.stringify(result),
      alignment_json: alignmentReport ? JSON.stringify(alignmentReport) : null,
      error: null,
    });
    return jsonResponse({ success: true, result });
  } catch (err) {
    const message = errMsg(err);
    console.error(`staff-ingest: process failed for job ${job.id} (${job.standard_id}):`, message);
    await touchJob(env, job.id, { status: 'failed', step: null, error: message });
    // Staff-only endpoint — the detail is appropriate to return (the router's
    // generic handler would mask it in production).
    return jsonResponse({ error: `Processing failed: ${message}` }, 500);
  }
}

/**
 * Read the stored manuscript, extract its structure, and stamp every chunk
 * with a PDF page. Returns ok:false (with the reason as a ready-made warning)
 * whenever the manuscript should NOT be trusted — the caller then indexes from
 * the PDF alone, exactly as if no manuscript were attached.
 */
async function useDocxManuscript(
  env: Env,
  job: IngestJobRow,
  pages: any[],
  pdfBodyChunkCount: number,
  pdfAssets: Array<{ kind: string; label: string; caption: string; page: number }>,
  setStep: (step: string, detail?: Record<string, unknown>) => Promise<void>,
): Promise<
  | { ok: true; chunks: any[]; outline: any[]; assets: any[]; report: Record<string, unknown> }
  | { ok: false; warning: string; report?: Record<string, unknown> }
> {
  try {
    await setStep('docx');
    const obj = await env.PDFS.get(job.docx_key!);
    if (!obj) throw new Error(`the stored manuscript is missing (${job.docx_key})`);
    const bytes = new Uint8Array(await new Response(obj.body as ReadableStream).arrayBuffer());
    const docx = await extractDocx(bytes);

    await setStep('align');
    const aligned = alignChunksToPdfPages(docx.chunks, pages);
    const report = aligned.report as Record<string, unknown>;

    // Gate 1: a manuscript far smaller than the PDF's own extraction is not
    // the full published document.
    if (docx.chunks.length < Math.max(5, Math.round(pdfBodyChunkCount * DOCX_MIN_CHUNK_RATIO))) {
      return {
        ok: false, report,
        warning: `Word manuscript NOT used: it yielded ${docx.chunks.length} passages where the PDF yields ${pdfBodyChunkCount} — ` +
                 'it does not look like the full published document. Indexed from the PDF alone.',
      };
    }
    // Gate 2: prose the PDF does not contain is manuscript drift — a
    // pre-copyedit draft must never be indexed under a published standard.
    const drift = Number(report.bodyInheritedFraction) || 0;
    if (drift > DOCX_BODY_DRIFT_LIMIT) {
      return {
        ok: false, report,
        warning: `Word manuscript NOT used: ${Math.round(drift * 100)}% of its prose could not be located in the PDF ` +
                 `(limit ${DOCX_BODY_DRIFT_LIMIT * 100}%) — the files look like different revisions. Indexed from the PDF alone.`,
      };
    }

    // Outline pages come from each section's first LOCATED chunk — searching
    // heading text directly would land in the PDF's own table of contents,
    // which precedes the body and repeats every heading verbatim.
    const outline = outlineWithPages(docx.outline, aligned.chunks);

    // Captions are searched from where body content starts, so a List of
    // Figures cannot claim them; one the PDF page stream cannot vouch for is
    // dropped (a raster caption may exist only in the manuscript) — the PDF's
    // own extraction fills those in via the merge below.
    const captionHits = alignSequenceToPages(
      aligned.index,
      docx.assets.map(a => `${a.label} ${a.caption}`),
      { startPos: aligned.firstMatchPos },
    );
    const docxAssets = docx.assets
      .map((a, i) => (captionHits[i] ? { ...a, page: captionHits[i]!.page } : null))
      .filter(Boolean) as Array<{ kind: string; label: string; caption: string; page: number }>;

    return { ok: true, chunks: aligned.chunks, outline, assets: mergeAssets(docxAssets, pdfAssets), report };
  } catch (err) {
    return { ok: false, warning: `Word manuscript NOT used (${errMsg(err)}) — indexed from the PDF alone.` };
  }
}

/** Manuscript outline entries → { number, title, page }, pages from the
 *  sections' first located chunks; a gap inherits the previous entry's page
 *  (document order makes it the honest lower bound); still-pageless leading
 *  entries are dropped rather than printed with a page we cannot vouch for. */
function outlineWithPages(
  outline: Array<{ number: string; title: string; level?: number }>,
  alignedChunks: Array<{ section: string | null; pageNumber: number | null; pageConfidence: string }>,
): Array<{ number: string; title: string; page: number }> {
  const firstPageBySection = new Map<string, number>();
  for (const c of alignedChunks) {
    if (c.section && c.pageNumber != null && c.pageConfidence !== 'inherited' && !firstPageBySection.has(c.section)) {
      firstPageBySection.set(c.section, c.pageNumber);
    }
  }
  const out: Array<{ number: string; title: string; page: number }> = [];
  let lastPage: number | null = null;
  for (const entry of outline) {
    const page: number | null = firstPageBySection.get(entry.number) ?? lastPage;
    if (page == null) continue;
    lastPage = page;
    out.push({ number: entry.number, title: entry.title, page });
  }
  return out;
}

/** Union of manuscript captions (page-aligned) and the PDF's own extraction,
 *  keyed on kind+label — the manuscript wins a collision (whole captions,
 *  never column-split), the PDF fills what the manuscript could not place. */
function mergeAssets(
  docxAssets: Array<{ kind: string; label: string; caption: string; page: number }>,
  pdfAssets: Array<{ kind: string; label: string; caption: string; page: number }>,
): Array<{ kind: string; label: string; caption: string; page: number }> {
  const byKey = new Map<string, { kind: string; label: string; caption: string; page: number }>();
  for (const a of pdfAssets) byKey.set(`${a.kind}|${a.label}`, a);
  for (const a of docxAssets) byKey.set(`${a.kind}|${a.label}`, a);
  return [...byKey.values()].sort((a, b) => (a.page || 0) - (b.page || 0));
}

/** Read every stored pages batch back, in page order. */
async function loadBuiltPages(env: Env, jobId: string): Promise<any[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const listed = await env.PDFS.list({ prefix: `${JOB_R2_PREFIX}${jobId}/pages-`, limit: 1000, cursor });
    for (const obj of listed.objects) keys.push(obj.key);
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
  keys.sort(); // pages-00001 … zero-padded, so lexicographic = numeric

  const pages: any[] = [];
  for (const key of keys) {
    const obj = await env.PDFS.get(key);
    if (!obj) throw new Error(`Stored pages batch disappeared: ${key}`);
    const batch = JSON.parse(await obj.text());
    if (Array.isArray(batch)) pages.push(...batch);
  }
  pages.sort((a, b) => (a.number || 0) - (b.number || 0));
  return pages;
}

// ─── Old-edition disposition ──────────────────────────────────────────────────

async function finalizeJob(env: Env, job: IngestJobRow): Promise<Response> {
  if (job.status === 'complete') {
    return jsonResponse({ success: true, note: 'Job is already complete.', job: publicJob(job) });
  }
  if (!['indexed', 'finalizing'].includes(job.status)) {
    return jsonResponse({ error: `Job is ${job.status} — finalize runs after indexing succeeds.` }, 409);
  }
  await touchJob(env, job.id, { status: 'finalizing' });

  const actions: Array<Record<string, unknown>> = [];
  let followUpJobId: string | null = null;

  if (job.replaces_id && job.replaces_id !== job.standard_id) {
    const old = await env.DB.prepare('SELECT id, status, chunk_count FROM standards WHERE id = ?')
      .bind(job.replaces_id).first<{ id: string; status: string; chunk_count: number | null }>();

    if (!old) {
      actions.push({ action: 'skipped', note: `"${job.replaces_id}" has no standards row any more — nothing to do.` });
    } else if (job.disposition === 'deprecate') {
      // The RP-27/RP-8 demotion shape. The old edition's main-index vectors
      // stay put: search reads status live from D1 (notDeprecated) and stops
      // surfacing them the moment this UPDATE lands.
      if (old.status !== 'Deprecated') {
        await env.DB.prepare(`
          UPDATE standards SET status = 'Deprecated', superseded_by = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).bind(job.standard_id, job.replaces_id).run();
        actions.push({ action: 'deprecated', id: job.replaces_id, supersededBy: job.standard_id });
      } else {
        actions.push({ action: 'already_deprecated', id: job.replaces_id });
      }

      // Move the PDF to the deprecated/ prefix (fail-soft: a leftover object
      // costs storage, never correctness — same posture as the ingest script).
      const fromKey = pdfKeyFor(job.replaces_id, 'Active');
      const toKey = pdfKeyFor(job.replaces_id, 'Deprecated');
      try {
        if (await copyR2Object(env, fromKey, toKey)) {
          await env.PDFS.delete(fromKey);
          actions.push({ action: 'pdf_moved', from: fromKey, to: toKey });
        }
      } catch (err) {
        actions.push({ action: 'pdf_move_failed', error: errMsg(err) });
      }

      if (job.index_old_for_comparison) {
        // A follow-up job that indexes the OLD edition into the deprecated
        // index, so "what's new in …" keeps a prior edition to compare
        // against. Its PDF is the one just moved — the browser downloads it
        // from the job and parses it like any upload.
        followUpJobId = crypto.randomUUID();
        await env.DB.prepare(`
          INSERT INTO ingest_jobs
            (id, created_by, filename, standard_id, ingest_status, replaces_id,
             disposition, index_old_for_comparison, status, pdf_key)
          VALUES (?, ?, ?, ?, 'deprecated', NULL, 'none', 0, 'uploaded', ?)
        `).bind(
          followUpJobId, job.created_by, `${job.replaces_id}.pdf (from the Library)`,
          job.replaces_id, toKey,
        ).run();
        actions.push({ action: 'follow_up_created', jobId: followUpJobId, standardId: job.replaces_id });
      }
    } else if (job.disposition === 'delete') {
      // Remove the old edition entirely: chunk vectors, application rows and
      // their vectors, the standards row, and the PDF.
      const oldIndex = old.status === 'Deprecated' ? env.VECTORIZE_DEPRECATED : env.VECTORIZE;
      if (oldIndex) {
        try {
          const deleted = await deleteVectorRange(oldIndex, job.replaces_id, 0, old.chunk_count ?? null);
          actions.push({ action: 'chunk_vectors_deleted', count: deleted });
        } catch (err) {
          actions.push({ action: 'chunk_vector_delete_failed', error: errMsg(err) });
        }
      }

      const codes = await env.DB.prepare('SELECT code FROM applications WHERE Standard = ?')
        .bind(job.replaces_id).all<{ code: string }>();
      const codeList = (codes.results || []).map(r => r.code);
      for (let i = 0; i < codeList.length; i += APP_DELETE_BATCH) {
        const batch = codeList.slice(i, i + APP_DELETE_BATCH);
        await env.DB.prepare(
          `DELETE FROM applications WHERE code IN (${batch.map(() => '?').join(',')})`
        ).bind(...batch).run();
      }
      try {
        for (let i = 0; i < codeList.length; i += VEC_DELETE_BATCH) {
          await env.VECTORIZE.deleteByIds(codeList.slice(i, i + VEC_DELETE_BATCH));
        }
      } catch (err) {
        actions.push({ action: 'application_vector_delete_failed', error: errMsg(err) });
      }
      if (codeList.length > 0) actions.push({ action: 'applications_deleted', count: codeList.length });

      await env.DB.prepare('DELETE FROM standards WHERE id = ?').bind(job.replaces_id).run();
      actions.push({ action: 'standards_row_deleted', id: job.replaces_id });

      try {
        await env.PDFS.delete(pdfKeyFor(job.replaces_id, old.status));
        actions.push({ action: 'pdf_deleted', key: pdfKeyFor(job.replaces_id, old.status) });
      } catch (err) {
        actions.push({ action: 'pdf_delete_failed', error: errMsg(err) });
      }
    }
  }

  await bumpDataVersion(env.SESSIONS);

  // Staging cleanup — only ever under this job's own prefix, so a follow-up
  // job's pdf_key (which points into deprecated/) can never be swept here.
  await deleteJobStaging(env, job.id);

  const result = { ...(parseJsonColumn(job.result_json) || {}), finalize: actions };
  await touchJob(env, job.id, {
    status: 'complete',
    step: null,
    result_json: JSON.stringify(result),
  });

  return jsonResponse({ success: true, actions, followUpJobId });
}

async function cancelJob(env: Env, job: IngestJobRow): Promise<Response> {
  if (job.status === 'complete') {
    return jsonResponse({ error: 'A completed job cannot be cancelled.' }, 409);
  }
  await deleteJobStaging(env, job.id);
  await touchJob(env, job.id, { status: 'cancelled', step: null });
  return jsonResponse({ success: true });
}

/** Delete every staging object under ingest-jobs/<id>/ (fail-soft). */
async function deleteJobStaging(env: Env, jobId: string): Promise<void> {
  try {
    let cursor: string | undefined;
    do {
      const listed = await env.PDFS.list({ prefix: `${JOB_R2_PREFIX}${jobId}/`, limit: 1000, cursor });
      for (const obj of listed.objects) await env.PDFS.delete(obj.key);
      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);
  } catch (err) {
    console.error(`staff-ingest: staging cleanup failed for ${jobId} (non-fatal):`, errMsg(err));
  }
}

// ─── Shared helpers ───────────────────────────────────────────────────────────

/** R2 has no server-side copy; stream through a FixedLengthStream (a plain
 *  ReadableStream put is refused without a known length). */
async function copyR2Object(env: Env, fromKey: string, toKey: string): Promise<boolean> {
  const src = await env.PDFS.get(fromKey);
  if (!src) return false;
  const { readable, writable } = new FixedLengthStream(src.size);
  const pipe = src.body.pipeTo(writable);
  await Promise.all([
    env.PDFS.put(toKey, readable, { httpMetadata: { contentType: 'application/pdf' } }),
    pipe,
  ]);
  return true;
}

async function getJob(env: Env, id: string): Promise<IngestJobRow | null> {
  try {
    const row = await env.DB.prepare('SELECT * FROM ingest_jobs WHERE id = ?')
      .bind(id).first<IngestJobRow>();
    return row || null;
  } catch {
    return null;
  }
}

// The one place job rows are updated; a fixed column list so a caller can never
// smuggle SQL through a key.
const JOB_COLUMNS = new Set([
  'status', 'step', 'progress_json', 'page_count', 'pages_received',
  'pdf_key', 'pdf_size', 'docx_key', 'docx_size', 'alignment_json',
  'result_json', 'error',
]);

async function touchJob(env: Env, id: string, fields: Record<string, unknown>): Promise<void> {
  const cols = Object.keys(fields).filter(k => JOB_COLUMNS.has(k));
  if (cols.length === 0) return;
  const sets = cols.map(c => `${c} = ?`).join(', ');
  await env.DB.prepare(
    `UPDATE ingest_jobs SET ${sets}, updated_at = datetime('now') WHERE id = ?`
  ).bind(...cols.map(c => fields[c] as never), id).run();
}

/** The row as the dashboard sees it: JSON columns parsed, internals kept. */
function publicJob(job: IngestJobRow): Record<string, unknown> {
  return {
    ...job,
    index_old_for_comparison: !!job.index_old_for_comparison,
    progress: parseJsonColumn(job.progress_json),
    result: parseJsonColumn(job.result_json),
    alignment: parseJsonColumn(job.alignment_json),
    progress_json: undefined,
    result_json: undefined,
    alignment_json: undefined,
  };
}

function parseJsonColumn(value: string | null): any {
  if (!value) return null;
  try { return JSON.parse(value); } catch { return null; }
}

function safeDecode(segment: string): string {
  try { return decodeURIComponent(segment); } catch { return segment; }
}

async function safeJson(request: Request): Promise<any> {
  try { return await request.json(); } catch { return {}; }
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
