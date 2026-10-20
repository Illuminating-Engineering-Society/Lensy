import { describe, it, expect } from 'vitest';
import { hasActiveLensComp, compSourceRef, compGrantsConfigured } from './comp-grants';

// Client 10/16/26 #6: a complimentary FULL IES Lens grant raises the session to
// tier 'full' for its window. The check runs on every gated request.
describe('hasActiveLensComp', () => {
  const env = (first) => {
    const calls = [];
    return {
      calls,
      DB: { prepare: (sql) => ({ bind: (...b) => { calls.push({ sql, b }); return { first: async () => first(sql, b) }; } }) },
    };
  };

  it('asks for a live lens-scope row by lowercased email', async () => {
    const e = env(() => ({ ok: 1 }));
    expect(await hasActiveLensComp(e, ' Guest@Example.com ')).toBe(true);
    expect(e.calls[0].b).toEqual(['guest@example.com']);
    expect(e.calls[0].sql).toMatch(/scope = 'lens'/);
    expect(e.calls[0].sql).toMatch(/status = 'active'/);
    expect(e.calls[0].sql).toMatch(/start_date <= date\('now'\) AND end_date >= date\('now'\)/);
  });

  it('is false without a row, without an email, and when D1 fails (a comp only ever adds)', async () => {
    expect(await hasActiveLensComp(env(() => null), 'a@b.org')).toBe(false);
    expect(await hasActiveLensComp(env(() => ({ ok: 1 })), '')).toBe(false);
    expect(await hasActiveLensComp(env(() => { throw new Error('no such column: scope'); }), 'a@b.org')).toBe(false);
  });

  it('names the AuthIES source_ref after the row, and needs the shared secret', () => {
    expect(compSourceRef(42)).toBe('lens-comp-42');
    expect(compGrantsConfigured({})).toBe(false);
    expect(compGrantsConfigured({ COMP_GRANTS_API_SECRET: ' x ' })).toBe(true);
  });
});
