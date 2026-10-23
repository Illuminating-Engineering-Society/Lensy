/**
 * The 10/22/26 Teams note: "LP-7-20 … is actually deprecated, so there is no
 * webstore link. How do I mark it deprecated in admin without replacing it?"
 *
 * demoteStandard is the demotion the ingest "deprecate" disposition always ran,
 * now also reachable from Admin → Standards → Edit with no successor.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { demoteStandard } from './staff-ingest';

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

function makeEnv({ appCodes = [], r2Keys = [] } = {}) {
  const statements = [];
  const db = {
    prepare(sql) {
      return {
        bind(...args) { statements.push({ sql, args }); return this; },
        async all() { return { results: appCodes.map(code => ({ code })) }; },
        async run() { return { meta: { changes: 1 } }; },
      };
    },
  };
  const deletedVectors = [];
  const r2 = new Map(r2Keys.map(k => [k, new Uint8Array([1, 2, 3])]));
  const env = {
    DB: db,
    VECTORIZE: { async deleteByIds(ids) { deletedVectors.push(...ids); return { count: ids.length }; } },
    PDFS: {
      async get(k) {
        const bytes = r2.get(k);
        if (!bytes) return null;
        return { size: bytes.length, body: new Blob([bytes]).stream() };
      },
      async put(k, stream) { r2.set(k, new Uint8Array(await new Response(stream).arrayBuffer())); },
      async delete(k) { r2.delete(k); },
    },
  };
  return { env, statements, deletedVectors, r2 };
}

describe('marking a standard deprecated without a replacement (client 10/22/26)', () => {
  it('flips the status with no successor and moves the PDF to deprecated/', async () => {
    const { env, statements, r2 } = makeEnv({ r2Keys: ['standards/LP-7-20.pdf'] });
    const actions = await demoteStandard(env, { id: 'LP-7-20', status: 'Active' }, null);

    const update = statements.find(s => /SET status = 'Deprecated'/.test(s.sql));
    expect(update.args).toEqual([null, 'LP-7-20']);
    expect(r2.has('standards/LP-7-20.pdf')).toBe(false);
    expect(r2.has('deprecated/LP-7-20.pdf')).toBe(true);
    expect(actions.map(a => a.action)).toEqual(['deprecated', 'pdf_moved']);
  });

  it('removes the edition\'s illuminance rows and their vectors, as a replacement does', async () => {
    const { env, deletedVectors } = makeEnv({ appCodes: ['LP0720_0001', 'LP0720_0002'] });
    const actions = await demoteStandard(env, { id: 'LP-7-20', status: 'Active' }, null);
    expect(deletedVectors).toEqual(['LP0720_0001', 'LP0720_0002']);
    expect(actions.find(a => a.action === 'applications_removed').count).toBe(2);
  });

  it('records the successor when there is one (the ingest disposition)', async () => {
    const { env, statements } = makeEnv();
    await demoteStandard(env, { id: 'RP-4-20+E1', status: 'Active' }, 'RP-4-26');
    const update = statements.find(s => /SET status = 'Deprecated'/.test(s.sql));
    expect(update.args).toEqual(['RP-4-26', 'RP-4-20+E1']);
  });

  it('leaves an already-deprecated row untouched', async () => {
    const { env, statements } = makeEnv();
    const actions = await demoteStandard(env, { id: 'LP-7-20', status: 'Deprecated' }, null);
    expect(statements.some(s => /SET status = 'Deprecated'/.test(s.sql))).toBe(false);
    expect(actions[0].action).toBe('already_deprecated');
  });
});
