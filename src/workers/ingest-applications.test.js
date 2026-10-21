/**
 * A document ingest indexes its own illuminance rows (Dan, 10/20/26).
 *
 * "I can't seem to get illuminance table results from RP-3 … 0 illuminance
 * cards." RP-3-26 (26 rows) and RP-4-26 (40 rows) were ingested from the staff
 * dashboard and sat in D1 with no application vectors: those only came from the
 * separate full re-index (`ingest-pdfs.js --applications-only`), which nothing
 * ran after a dashboard ingest. Search finds a row through its vector (id = the
 * row's code), so the rows were unreachable.
 */

import { describe, it, expect } from 'vitest';
import { runDocumentIngest } from './ingest';

const ROWS = [
  { code: 'RP326_0000', Standard: 'RP-3-26', App: 'Classrooms', App_s1: 'General Classrooms', Indoor_Outdoor: 'Indoor', Active: 1 },
  { code: 'RP326_0001', Standard: 'RP-3-26', App: 'Classrooms', App_s1: 'Study halls', Indoor_Outdoor: 'Indoor', Active: 1 },
];

function makeEnv() {
  const upserts = [];
  const sqls = [];
  const stmt = (sql) => {
    const s = {
      bind: (...b) => { sqls.push({ sql, b }); return s; },
      first: async () => null,
      all: async () => ({ results: /FROM applications WHERE Active = 1 AND code IN/.test(sql) ? ROWS : [] }),
      run: async () => ({ meta: { changes: 1, last_row_id: 1 } }),
    };
    return s;
  };
  return {
    upserts, sqls,
    DB: { prepare: stmt, batch: async (stmts) => stmts.map(() => ({ meta: { changes: 1 } })) },
    AI: { run: async (_m, { text }) => ({ data: text.map(() => new Array(768).fill(0.01)) }) },
    VECTORIZE: {
      upsert: async (v) => { upserts.push(...v); return { count: v.length }; },
      getByIds: async () => [], deleteByIds: async () => ({ count: 0 }),
    },
    SESSIONS: { get: async () => null, put: async () => {} },
  };
}

describe('runDocumentIngest indexes the applications it writes', () => {
  it('upserts one vector per row, keyed by the row code', async () => {
    const env = makeEnv();
    const out = await runDocumentIngest({
      standardId: 'RP-3-26', status: 'current', chunks: [], applications: ROWS,
    }, env);
    expect(out.status).toBe(200);
    expect(out.payload.applicationsUpserted).toBe(2);
    expect(out.payload.applicationVectors).toBe(2);
    const appVectors = env.upserts.filter(v => v.metadata?.chunk_type === 'application');
    expect(appVectors.map(v => v.id).sort()).toEqual(['RP326_0000', 'RP326_0001']);
    expect(appVectors[0].metadata.standard_code).toBe('RP-3-26');
    // Re-read by code, so the embed text sees the full stored row.
    expect(env.sqls.some(q => /code IN \(\?, \?\)/.test(q.sql) && q.b.join() === 'RP326_0000,RP326_0001')).toBe(true);
  });
});
