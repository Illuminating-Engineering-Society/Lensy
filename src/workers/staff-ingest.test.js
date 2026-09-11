/**
 * Staff ingest jobs (src/workers/staff-ingest.ts) — the dashboard-driven
 * upload → parse → index → disposition flow.
 *
 * What matters here: a job derives the same id the CLI would, refuses the
 * shapes that would corrupt the catalog (unknown replacesId, pages before the
 * header/footer batch), rebuilds pages with the shared pdf-pages code, and the
 * two dispositions do exactly what they claim — 'deprecate' is the RP-27/RP-8
 * demotion shape (status flip + superseded_by + PDF move, vectors left to the
 * live status filter), 'delete' actually removes vectors, rows and PDF.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { handleIngestJobs } from './staff-ingest';
import { fixturePara as para, fixtureDocxBytes as docxBytes } from '../lib/docx-fixture.js';

// workerd global; in Node the identity pair is enough for the copy stream.
beforeAll(() => {
  if (!globalThis.FixedLengthStream) {
    globalThis.FixedLengthStream = class {
      constructor() {
        const t = new TransformStream();
        this.readable = t.readable;
        this.writable = t.writable;
      }
    };
  }
});

// ─── Stubs ─────────────────────────────────────────────────────────────────────

function r2Stub(seed = {}) {
  const store = new Map();
  const enc = v => (typeof v === 'string' ? new TextEncoder().encode(v) : new Uint8Array(v));
  for (const [k, v] of Object.entries(seed)) store.set(k, enc(v));
  return {
    store,
    async put(key, value) {
      let data = value;
      if (value && typeof value.getReader === 'function') {
        data = new Uint8Array(await new Response(value).arrayBuffer());
      } else {
        data = enc(value);
      }
      store.set(key, data);
      return { size: data.byteLength };
    },
    async get(key) {
      if (!store.has(key)) return null;
      const bytes = store.get(key);
      return {
        size: bytes.byteLength,
        body: new Response(bytes).body,
        httpMetadata: {},
        async text() { return new TextDecoder().decode(bytes); },
      };
    },
    async head(key) { return store.has(key) ? { size: store.get(key).byteLength } : null; },
    async delete(key) { store.delete(key); },
    async list({ prefix }) {
      const objects = [...store.keys()].filter(k => k.startsWith(prefix)).sort().map(key => ({ key }));
      return { objects, truncated: false };
    },
  };
}

function vectorizeStub() {
  const deleted = [];
  return {
    deleted,
    async upsert() { return {}; },
    async getByIds() { return []; },
    async deleteByIds(ids) { deleted.push(...ids); return { count: ids.length }; },
    async query() { return { matches: [] }; },
  };
}

/**
 * A one-job ingest_jobs table plus SQL-shape routing for everything else the
 * flow touches (standards lookups, application codes, the ingest upsert).
 */
function makeEnv({ standards = {}, job = null, r2seed = {} } = {}) {
  const state = { job, followUp: null };
  const calls = [];
  const DB = {
    prepare(sql) {
      return {
        bind(...bindings) {
          calls.push({ sql, bindings });
          return {
            first: async () => {
              if (/FROM ingest_jobs WHERE id/.test(sql)) return state.job ? { ...state.job } : null;
              if (/SELECT id, status, chunk_count FROM standards WHERE id/.test(sql)) {
                const s = standards[bindings[0]];
                return s ? { id: bindings[0], status: s.status, chunk_count: s.chunk_count ?? null } : null;
              }
              if (/SELECT id, status FROM standards WHERE id/.test(sql)) {
                const s = standards[bindings[0]];
                return s ? { id: bindings[0], status: s.status } : null;
              }
              if (/SELECT status, chunk_count FROM standards WHERE id/.test(sql)) {
                const s = standards[bindings[0]];
                return s ? { status: s.status, chunk_count: s.chunk_count ?? null } : null;
              }
              return null;
            },
            run: async () => {
              if (/INSERT INTO ingest_jobs/.test(sql)) {
                if (/pdf_key/.test(sql)) {
                  state.followUp = {
                    id: bindings[0], created_by: bindings[1], filename: bindings[2],
                    standard_id: bindings[3], pdf_key: bindings[4],
                  };
                } else {
                  state.job = {
                    id: bindings[0], created_by: bindings[1], filename: bindings[2],
                    standard_id: bindings[3], ingest_status: bindings[4],
                    replaces_id: bindings[5], disposition: bindings[6],
                    index_old_for_comparison: bindings[7],
                    status: 'created', step: null, progress_json: null,
                    page_count: null, pages_received: 0, pdf_key: null, pdf_size: null,
                    result_json: null, error: null,
                    created_at: '2026-09-10 00:00:00', updated_at: '2026-09-10 00:00:00',
                  };
                }
              }
              if (/UPDATE ingest_jobs SET/.test(sql) && state.job) {
                const cols = [...sql.matchAll(/(\w+) = \?/g)].map(m => m[1]);
                cols.forEach((c, i) => { state.job[c] = bindings[i]; });
              }
              return { meta: { changes: 1, last_row_id: 1 } };
            },
            all: async () => {
              if (/FROM ingest_jobs ORDER BY/.test(sql)) {
                return { results: state.job ? [{ ...state.job }] : [] };
              }
              if (/SELECT code FROM applications WHERE Standard/.test(sql)) {
                const s = standards[bindings[0]];
                return { results: (s?.appCodes || []).map(code => ({ code })) };
              }
              if (/SELECT id FROM standards WHERE status = 'Active' AND id LIKE/.test(sql)) {
                return { results: [] };
              }
              return { results: [] };
            },
          };
        },
      };
    },
    batch: async (stmts) => stmts.map(() => ({ meta: {} })),
  };

  return {
    state,
    calls,
    env: {
      DB,
      PDFS: r2Stub(r2seed),
      VECTORIZE: vectorizeStub(),
      VECTORIZE_DEPRECATED: vectorizeStub(),
      AI: { run: async (_m, { text }) => ({ data: text.map(() => [0.1, 0.2, 0.3]) }) },
      SESSIONS: { get: async () => null, put: async () => {} },
      // ENVIRONMENT deliberately unset: outside production the bearer check
      // accepts any Authorization header (src/lib/auth.ts), which is how every
      // worker test authenticates.
    },
  };
}

async function call(env, method, path, body, headers = {}) {
  const request = new Request(`http://localhost${path}`, {
    method,
    headers: { Authorization: 'Bearer test', 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined
      : (typeof body === 'string' || body instanceof Uint8Array ? body : JSON.stringify(body)),
  });
  const res = await handleIngestJobs(request, env, new URL(request.url));
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const PAGE1 = {
  number: 1,
  view: [0, 0, 612, 792],
  items: [
    { str: 'RECOMMENDED PRACTICE', transform: [14, 0, 0, 14, 60, 700], fontName: 'F1-Bold', width: 160 },
    { str: 'Body text about lighting design.', transform: [10, 0, 0, 10, 60, 500], fontName: 'F1', width: 160 },
  ],
};
const PAGE2 = {
  number: 2,
  view: [0, 0, 612, 792],
  items: [
    { str: 'More prose on the second page.', transform: [10, 0, 0, 10, 60, 500], fontName: 'F1', width: 160 },
  ],
};

// ─── Auth ──────────────────────────────────────────────────────────────────────

describe('gate', () => {
  it('refuses a request with neither bearer nor session', async () => {
    const { env } = makeEnv();
    const request = new Request('http://localhost/api/admin/ingest-jobs');
    const res = await handleIngestJobs(request, env, new URL(request.url));
    expect([401, 403, 503]).toContain(res.status);
  });
});

// ─── Job creation ──────────────────────────────────────────────────────────────

describe('create', () => {
  it('derives the standard id from the filename with the shared rule', async () => {
    const { env, state } = makeEnv();
    const { status, body } = await call(env, 'POST', '/api/admin/ingest-jobs',
      { filename: 'RP-27-26_v2_final.pdf' });
    expect(status).toBe(201);
    expect(body.job.standard_id).toBe('RP-27-26');
    expect(body.job.disposition).toBe('none');
    expect(state.job.status).toBe('created');
  });

  it('refuses a filename that yields nothing id-shaped', async () => {
    const { env } = makeEnv();
    const { status, body } = await call(env, 'POST', '/api/admin/ingest-jobs',
      { filename: 'meeting notes v3.pdf' });
    expect(status).toBe(400);
    expect(body.error).toMatch(/does not look like/i);
  });

  it('refuses a replacesId with no standards row', async () => {
    const { env } = makeEnv();
    const { status, body } = await call(env, 'POST', '/api/admin/ingest-jobs',
      { filename: 'RP-27-26.pdf', replacesId: 'RP-27-20+E1' });
    expect(status).toBe(400);
    expect(body.error).toMatch(/no standards row/);
  });

  it('defaults to deprecate for a real replacement, and warns across families', async () => {
    const { env } = makeEnv({ standards: { 'RP-9-20': { status: 'Active' } } });
    const { status, body } = await call(env, 'POST', '/api/admin/ingest-jobs',
      { filename: 'RP-27-26.pdf', replacesId: 'RP-9-20' });
    expect(status).toBe(201);
    expect(body.job.disposition).toBe('deprecate');
    expect(body.warnings.join(' ')).toMatch(/different standard FAMILIES/);
  });

  it('treats a same-id replacement as in-place: disposition forced to none', async () => {
    const { env } = makeEnv({ standards: { 'RP-27-26': { status: 'Active' } } });
    const { status, body } = await call(env, 'POST', '/api/admin/ingest-jobs',
      { filename: 'RP-27-26.pdf', replacesId: 'RP-27-26', disposition: 'delete' });
    expect(status).toBe(201);
    expect(body.job.disposition).toBe('none');
    expect(body.warnings.join(' ')).toMatch(/in-place/);
  });
});

// ─── PDF upload ────────────────────────────────────────────────────────────────

describe('pdf upload', () => {
  const baseJob = {
    id: 'j1', created_at: '', updated_at: '', created_by: 'staff@ies.org',
    filename: 'TM-99-26.pdf', standard_id: 'TM-99-26', ingest_status: 'current',
    replaces_id: null, disposition: 'none', index_old_for_comparison: 0,
    status: 'created', step: null, progress_json: null,
    page_count: null, pages_received: 0, pdf_key: null, pdf_size: null,
    result_json: null, error: null,
  };

  it('streams raw bytes into the job staging key and records the size', async () => {
    const { env, state } = makeEnv({ job: { ...baseJob } });
    const bytes = new Uint8Array([37, 80, 68, 70, 45]); // %PDF-
    const { status, body } = await call(env, 'POST', '/api/admin/ingest-jobs/j1/pdf', bytes,
      { 'Content-Type': 'application/pdf' });
    expect(status).toBe(200);
    expect(body.size).toBe(5);
    expect(env.PDFS.store.has('ingest-jobs/j1/source.pdf')).toBe(true);
    expect(state.job.status).toBe('uploaded');
    expect(state.job.pdf_key).toBe('ingest-jobs/j1/source.pdf');
  });

  it('records a finished multipart upload without re-sending the bytes', async () => {
    const { env, state } = makeEnv({
      job: { ...baseJob },
      r2seed: { 'ingest-jobs/j1/source.pdf': 'x'.repeat(64) },
    });
    const { status, body } = await call(env, 'POST', '/api/admin/ingest-jobs/j1/pdf',
      { multipartComplete: true });
    expect(status).toBe(200);
    expect(body.size).toBe(64);
    expect(state.job.status).toBe('uploaded');
  });
});

// ─── Raw pages intake ──────────────────────────────────────────────────────────

describe('pages', () => {
  const uploadedJob = {
    id: 'j1', created_at: '', updated_at: '', created_by: 'staff@ies.org',
    filename: 'TM-99-26.pdf', standard_id: 'TM-99-26', ingest_status: 'current',
    replaces_id: null, disposition: 'none', index_old_for_comparison: 0,
    status: 'uploaded', step: null, progress_json: null,
    page_count: null, pages_received: 0,
    pdf_key: 'ingest-jobs/j1/source.pdf', pdf_size: 5,
    result_json: null, error: null,
  };

  it('insists on the first batch first (it establishes the header/footer set)', async () => {
    const { env } = makeEnv({ job: { ...uploadedJob } });
    const { status, body } = await call(env, 'POST', '/api/admin/ingest-jobs/j1/pages',
      { totalPages: 2, pageStart: 2, pages: [PAGE2] });
    expect(status).toBe(409);
    expect(body.error).toMatch(/page 1 first/);
  });

  it('builds pages with the shared code, stores them, and completes the parse', async () => {
    const { env, state } = makeEnv({ job: { ...uploadedJob } });
    const { status, body } = await call(env, 'POST', '/api/admin/ingest-jobs/j1/pages', {
      totalPages: 2,
      pageStart: 1,
      pages: [PAGE1, PAGE2],
      docMeta: { Title: 'Test Standard', CreationDate: 'D:20260101120000' },
    });
    expect(status).toBe(200);
    expect(body.done).toBe(true);
    expect(state.job.status).toBe('parsed');
    expect(state.job.pages_received).toBe(2);

    const stored = env.PDFS.store.get('ingest-jobs/j1/pages-00001.json');
    const built = JSON.parse(new TextDecoder().decode(stored));
    expect(built).toHaveLength(2);
    expect(built[0].text).toContain('RECOMMENDED PRACTICE');
    expect(built[1].number).toBe(2);

    const progress = JSON.parse(state.job.progress_json);
    expect(progress.docMeta.title).toBe('Test Standard');
    expect(progress.docMeta.year).toBe('2026');
  });

  it('refuses a totalPages that changed mid-job', async () => {
    const { env } = makeEnv({
      job: {
        ...uploadedJob, status: 'parsing',
        progress_json: JSON.stringify({ headerFooters: [], docMeta: {}, totalPages: 2, batches: { 1: 2 } }),
        page_count: 2, pages_received: 2,
      },
    });
    const { status } = await call(env, 'POST', '/api/admin/ingest-jobs/j1/pages',
      { totalPages: 3, pageStart: 3, pages: [PAGE2] });
    expect(status).toBe(409);
  });
});

// ─── Process (extract + index) ─────────────────────────────────────────────────

describe('process', () => {
  it('runs the extraction stack over the stored pages and lands on indexed', async () => {
    const words = Array.from({ length: 80 }, (_, i) => `word${i}`).join(' ');
    const builtPages = [{
      number: 1,
      text: `1 Introduction\n${words}`,
      lines: [
        { text: '1 Introduction', x: 60, y: 80, fontSize: 14, bold: true, marks: [] },
        { text: words, x: 60, y: 120, fontSize: 10, bold: false, marks: [] },
      ],
      width: 612,
      height: 792,
    }];
    const { env, state } = makeEnv({
      job: {
        id: 'j1', created_at: '', updated_at: '', created_by: 'staff@ies.org',
        filename: 'TM-99-26.pdf', standard_id: 'TM-99-26', ingest_status: 'current',
        replaces_id: null, disposition: 'none', index_old_for_comparison: 0,
        status: 'parsed', step: null,
        progress_json: JSON.stringify({
          headerFooters: [], totalPages: 1, batches: { 1: 1 },
          docMeta: { title: 'Test Standard', author: '', subject: '', keywords: '', year: '2026' },
        }),
        page_count: 1, pages_received: 1,
        pdf_key: 'ingest-jobs/j1/source.pdf', pdf_size: 5,
        result_json: null, error: null,
      },
      r2seed: {
        'ingest-jobs/j1/source.pdf': '%PDF-fake',
        'ingest-jobs/j1/pages-00001.json': JSON.stringify(builtPages),
      },
    });

    const { status, body } = await call(env, 'POST', '/api/admin/ingest-jobs/j1/process', {});
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.result.structure).toBe('standard');
    expect(body.result.pageCount).toBe(1);
    expect(state.job.status).toBe('indexed');
    // The raw PDF was copied to its library home for the catalog row to point at.
    expect(env.PDFS.store.has('standards/TM-99-26.pdf')).toBe(true);
  });

  it('refuses to process before every page has arrived', async () => {
    const { env } = makeEnv({
      job: {
        id: 'j1', created_at: '', updated_at: '', created_by: null,
        filename: 'TM-99-26.pdf', standard_id: 'TM-99-26', ingest_status: 'current',
        replaces_id: null, disposition: 'none', index_old_for_comparison: 0,
        status: 'parsing', step: null, progress_json: null,
        page_count: 10, pages_received: 4, pdf_key: null, pdf_size: null,
        result_json: null, error: null,
      },
    });
    const { status } = await call(env, 'POST', '/api/admin/ingest-jobs/j1/process', {});
    expect(status).toBe(409);
  });
});

// ─── Finalize dispositions ─────────────────────────────────────────────────────

function indexedJob(overrides = {}) {
  return {
    id: 'j1', created_at: '', updated_at: '', created_by: 'staff@ies.org',
    filename: 'RP-9-26.pdf', standard_id: 'RP-9-26', ingest_status: 'current',
    replaces_id: 'RP-9-20', disposition: 'deprecate', index_old_for_comparison: 0,
    status: 'indexed', step: 'done',
    progress_json: null, page_count: 10, pages_received: 10,
    pdf_key: 'ingest-jobs/j1/source.pdf', pdf_size: 100,
    result_json: JSON.stringify({ chunksIndexed: 42 }), error: null,
    ...overrides,
  };
}

describe('finalize — deprecate', () => {
  it('flips status with superseded_by, moves the PDF, and cleans staging', async () => {
    const { env, state, calls } = makeEnv({
      standards: { 'RP-9-20': { status: 'Active', chunk_count: 10 } },
      job: indexedJob(),
      r2seed: {
        'standards/RP-9-20.pdf': 'old-pdf-bytes',
        'ingest-jobs/j1/source.pdf': 'new-pdf-bytes',
        'ingest-jobs/j1/pages-00001.json': '[]',
      },
    });
    const { status, body } = await call(env, 'POST', '/api/admin/ingest-jobs/j1/finalize', {});
    expect(status).toBe(200);
    expect(body.actions.map(a => a.action)).toContain('deprecated');

    const upd = calls.find(c => /UPDATE standards SET status = 'Deprecated'/.test(c.sql));
    expect(upd.bindings).toEqual(['RP-9-26', 'RP-9-20']);

    expect(env.PDFS.store.has('deprecated/RP-9-20.pdf')).toBe(true);
    expect(env.PDFS.store.has('standards/RP-9-20.pdf')).toBe(false);
    // Staging is gone; the moved library copy is not staging.
    expect([...env.PDFS.store.keys()].some(k => k.startsWith('ingest-jobs/j1/'))).toBe(false);
    expect(state.job.status).toBe('complete');
    // The demotion posture: no vector deletions — the status filter handles it.
    expect(env.VECTORIZE.deleted).toHaveLength(0);
  });

  it('creates the comparison follow-up job pointing at the moved PDF', async () => {
    const { env, state } = makeEnv({
      standards: { 'RP-9-20': { status: 'Active', chunk_count: 10 } },
      job: indexedJob({ index_old_for_comparison: 1 }),
      r2seed: { 'standards/RP-9-20.pdf': 'old-pdf-bytes' },
    });
    const { status, body } = await call(env, 'POST', '/api/admin/ingest-jobs/j1/finalize', {});
    expect(status).toBe(200);
    expect(body.followUpJobId).toBeTruthy();
    expect(state.followUp.standard_id).toBe('RP-9-20');
    expect(state.followUp.pdf_key).toBe('deprecated/RP-9-20.pdf');
  });
});

describe('finalize — delete', () => {
  it('removes vectors, application rows, the catalog row and the PDF', async () => {
    const { env, calls } = makeEnv({
      standards: { 'RP-9-20': { status: 'Active', chunk_count: 3, appCodes: ['RP-9-20_1', 'RP-9-20_2'] } },
      job: indexedJob({ disposition: 'delete' }),
      r2seed: { 'standards/RP-9-20.pdf': 'old-pdf-bytes' },
    });
    const { status, body } = await call(env, 'POST', '/api/admin/ingest-jobs/j1/finalize', {});
    expect(status).toBe(200);
    expect(body.actions.map(a => a.action)).toEqual(
      expect.arrayContaining(['chunk_vectors_deleted', 'applications_deleted', 'standards_row_deleted', 'pdf_deleted']));

    // Chunk vectors by deterministic range; application vectors by code.
    expect(env.VECTORIZE.deleted).toEqual(
      expect.arrayContaining(['RP-9-20-chunk-0', 'RP-9-20-chunk-1', 'RP-9-20-chunk-2', 'RP-9-20_1', 'RP-9-20_2']));
    expect(calls.some(c => /DELETE FROM standards WHERE id = \?/.test(c.sql))).toBe(true);
    expect(calls.some(c => /DELETE FROM applications WHERE code IN/.test(c.sql))).toBe(true);
    expect(env.PDFS.store.has('standards/RP-9-20.pdf')).toBe(false);
  });
});

describe('cancel', () => {
  it('deletes staging and marks the job cancelled', async () => {
    const { env, state } = makeEnv({
      job: indexedJob({ status: 'parsing' }),
      r2seed: { 'ingest-jobs/j1/source.pdf': 'bytes', 'ingest-jobs/j1/pages-00001.json': '[]' },
    });
    const { status } = await call(env, 'POST', '/api/admin/ingest-jobs/j1/cancel', {});
    expect(status).toBe(200);
    expect(state.job.status).toBe('cancelled');
    expect([...env.PDFS.store.keys()].some(k => k.startsWith('ingest-jobs/j1/'))).toBe(false);
  });
});

// ─── Dual-upload: the Word manuscript (docs/DOCX_INGEST.md) ────────────────────

const wordsOf = (n, prefix) => Array.from({ length: n }, (_, i) => `${prefix}${i}`).join(' ');

/** A five-section manuscript and the matching built PDF pages — the same text
 *  on both sides, so alignment succeeds; three pages so the stamps differ. */
function manuscriptFixture() {
  const sections = [1, 2, 3, 4, 5].map(i => ({
    heading: `${i} Chapter Title ${['One', 'Two', 'Three', 'Four', 'Five'][i - 1]}`,
    body: wordsOf(40, `sec${i}word`),
  }));
  const body = sections.map(s => para(s.heading, { style: 'Heading1' }) + para(s.body, {})).join('');
  const bytes = docxBytes(body);
  const pageText = (list) => list.map(s => `${s.heading}\n${s.body}`).join('\n');
  const builtPages = [
    { number: 1, text: pageText(sections.slice(0, 2)), lines: [], width: 612, height: 792 },
    { number: 2, text: pageText(sections.slice(2, 4)), lines: [], width: 612, height: 792 },
    { number: 3, text: pageText(sections.slice(4)), lines: [], width: 612, height: 792 },
  ];
  return { bytes, builtPages };
}

function docxJob(overrides = {}) {
  return {
    id: 'j1', created_at: '', updated_at: '', created_by: 'staff@ies.org',
    filename: 'TM-99-26.pdf', standard_id: 'TM-99-26', ingest_status: 'current',
    replaces_id: null, disposition: 'none', index_old_for_comparison: 0,
    status: 'parsed', step: null,
    progress_json: JSON.stringify({
      headerFooters: [], totalPages: 3, batches: { 1: 3 },
      docMeta: { title: 'Test Standard', author: '', subject: '', keywords: '', year: '2026' },
    }),
    page_count: 3, pages_received: 3,
    pdf_key: 'ingest-jobs/j1/source.pdf', pdf_size: 5,
    docx_key: null, docx_size: null, alignment_json: null,
    result_json: null, error: null,
    ...overrides,
  };
}

describe('docx upload', () => {
  it('validates, stores and records the manuscript', async () => {
    const { bytes } = manuscriptFixture();
    const { env, state } = makeEnv({ job: docxJob({ status: 'uploaded' }) });
    const { status, body } = await call(env, 'POST', '/api/admin/ingest-jobs/j1/docx', bytes,
      { 'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
    expect(status).toBe(200);
    expect(body.stats.headings).toBe(5);
    expect(env.PDFS.store.has('ingest-jobs/j1/source.docx')).toBe(true);
    expect(state.job.docx_key).toBe('ingest-jobs/j1/source.docx');
  });

  it('refuses a manuscript with unaccepted tracked changes', async () => {
    const body =
      para('1 Scope', { style: 'Heading1' }) +
      '<w:p><w:ins w:id="1" w:author="editor"><w:r><w:t>draft insertion</w:t></w:r></w:ins></w:p>';
    const { env, state } = makeEnv({ job: docxJob({ status: 'uploaded' }) });
    const res = await call(env, 'POST', '/api/admin/ingest-jobs/j1/docx', docxBytes(body),
      { 'Content-Type': 'application/octet-stream' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/tracked changes/i);
    expect(state.job.docx_key).toBe(null);
  });

  it('refuses a manuscript naming a different standard family', async () => {
    const body =
      para('ANSI/IES RP-9-25 Recommended Practice: Lighting Hospitality Spaces', {}) +
      para('1 Scope', { style: 'Heading1' }) +
      para(wordsOf(40, 'w'), {});
    const { env } = makeEnv({ job: docxJob({ status: 'uploaded' }) });
    const res = await call(env, 'POST', '/api/admin/ingest-jobs/j1/docx', docxBytes(body),
      { 'Content-Type': 'application/octet-stream' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/different standard family/i);
  });
});

describe('process with a manuscript', () => {
  it('indexes the manuscript content with PDF-aligned pages', async () => {
    const { bytes, builtPages } = manuscriptFixture();
    const { env, state } = makeEnv({
      job: docxJob({ docx_key: 'ingest-jobs/j1/source.docx', docx_size: bytes.length }),
      r2seed: {
        'ingest-jobs/j1/source.pdf': '%PDF-fake',
        'ingest-jobs/j1/pages-00001.json': JSON.stringify(builtPages),
      },
    });
    env.PDFS.store.set('ingest-jobs/j1/source.docx', bytes);

    const { status, body } = await call(env, 'POST', '/api/admin/ingest-jobs/j1/process', {});
    expect(status).toBe(200);
    expect(body.result.source).toBe('docx+pdf');
    expect(body.result.alignment.located).toBe(5);
    expect(body.result.alignment.inherited).toBe(0);
    expect(body.result.sectionTitles).toBe(5);
    expect(state.job.status).toBe('indexed');
    // The full report is kept on the row for the dashboard.
    const report = JSON.parse(state.job.alignment_json);
    expect(report.bodyInheritedFraction).toBe(0);
  });

  it('downgrades to the PDF path when the manuscript drifts from the PDF', async () => {
    // Same five-section manuscript, but the PDF pages carry entirely different
    // prose — the files are different revisions.
    const { bytes } = manuscriptFixture();
    const strangerPages = [1, 2, 3].map(n => ({
      number: n,
      text: `${n} Other Heading\n${wordsOf(60, `other${n}word`)}`,
      lines: [], width: 612, height: 792,
    }));
    const { env, state } = makeEnv({
      job: docxJob({ docx_key: 'ingest-jobs/j1/source.docx', docx_size: bytes.length }),
      r2seed: {
        'ingest-jobs/j1/source.pdf': '%PDF-fake',
        'ingest-jobs/j1/pages-00001.json': JSON.stringify(strangerPages),
      },
    });
    env.PDFS.store.set('ingest-jobs/j1/source.docx', bytes);

    const { status, body } = await call(env, 'POST', '/api/admin/ingest-jobs/j1/process', {});
    expect(status).toBe(200);
    expect(body.result.source).toBe('pdf');
    expect(body.result.warnings.join(' ')).toMatch(/manuscript NOT used/i);
    expect(state.job.status).toBe('indexed');
  });
});
