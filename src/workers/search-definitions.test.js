/**
 * searchDefinitions() against fake bindings (client DO33).
 *
 * `wrangler dev` cannot exercise this end to end — Vectorize has no local
 * binding, so every search throws before reaching the definitions step — which is
 * exactly why the two retrieval paths are tested here with stubs: the exact-term
 * D1 match must outrank the semantic match, and the semantic query must be able
 * to fail without taking the search down with it.
 */

import { describe, it, expect } from 'vitest';
import { searchDefinitions } from './search';

const ROWS = [
  {
    slug: 'color', term: 'color', clause: '4.1',
    html: '<p>[4.1] The characteristic of <strong>light</strong> by which a human observer can distinguish.</p>',
    text: '[4.1] The characteristic of light by which a human observer can distinguish.',
    source_url: 'https://ies.org/definitions/color/', standard_id: 'LS-1-25',
  },
  {
    slug: 'object-color', term: 'object color', clause: '4.12',
    html: '<p>[4.12] The color of light reflected or transmitted by an object.</p>',
    text: '[4.12] The color of light reflected or transmitted by an object.',
    source_url: 'https://ies.org/definitions/object-color/', standard_id: 'LS-1-25',
  },
  {
    slug: 'color-rendering-index', term: 'color rendering index, CRI', clause: '4.30',
    html: '<p>[4.30] A measure of colour shift.</p>',
    text: '[4.30] A measure of colour shift.',
    source_url: 'https://ies.org/definitions/color-rendering-index/', standard_id: 'LS-1-25',
  },
];

/**
 * Minimal D1 stand-in: recognizes the two statements searchDefinitions issues
 * (the term match and the slug hydration) and answers from ROWS.
 */
function fakeDb() {
  return {
    prepare(sql) {
      const stmt = {
        _sql: sql,
        _args: [],
        bind(...args) { stmt._args = args; return stmt; },
        async all() {
          if (/WHERE LOWER\(term\)/i.test(sql)) {
            const [exact, prefixComma, prefixSpace] = stmt._args;
            const like = (pattern, value) =>
              new RegExp(`^${pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*')}$`, 'i').test(value);
            return {
              results: ROWS
                .filter(r => r.term.toLowerCase() === exact || like(prefixComma, r.term) || like(prefixSpace, r.term))
                .map(r => ({ slug: r.slug, term: r.term })),
            };
          }
          if (/WHERE slug IN/i.test(sql)) {
            return { results: ROWS.filter(r => stmt._args.includes(r.slug)) };
          }
          throw new Error(`unexpected SQL: ${sql}`);
        },
      };
      return stmt;
    },
  };
}

const VECTOR = [0.1, 0.2, 0.3];

function fakeEnv({ matches = [], vectorThrows = false } = {}) {
  return {
    DB: fakeDb(),
    VECTORIZE: {
      async query() {
        if (vectorThrows) throw new Error('no metadata index on chunk_type');
        return { matches };
      },
    },
  };
}

describe('searchDefinitions', () => {
  it('ranks the EXACT term above a semantic match on a longer term', async () => {
    // "Color" is the client's sample search: it must return the `color`
    // definition first even though `color rendering index` scores higher on
    // similarity to a colour-heavy query.
    const env = fakeEnv({
      matches: [
        { id: 'LS-1-DEF-color-rendering-index', score: 0.99, metadata: { definition_slug: 'color-rendering-index' } },
        { id: 'LS-1-DEF-color', score: 0.71, metadata: { definition_slug: 'color' } },
      ],
    });
    const out = await searchDefinitions(env, VECTOR, 'Color', 10);
    expect(out[0].definition.term).toBe('color');
    expect(out[0].relevanceScore).toBe(1);
    expect(out.map(r => r.definition.slug)).toContain('color-rendering-index');
  });

  it('matches a term whose printed form carries a symbol after a comma', async () => {
    const out = await searchDefinitions(fakeEnv(), VECTOR, 'color rendering index', 10);
    expect(out.map(r => r.definition.slug)).toEqual(['color-rendering-index']);
  });

  it('builds a Definition card titled with the current LS-1 designation', async () => {
    const out = await searchDefinitions(fakeEnv(), VECTOR, 'color', 10);
    const card = out[0];
    expect(card.resultType).toBe('definition');
    expect(card.citation).toBe(
      'ANSI/IES LS-1-25 Lighting Science: Nomenclature and Definitions for Illuminating Engineering, §4.1'
    );
    expect(card.definition.html).toContain('<strong>light</strong>');
    expect(card.definition.clause).toBe('4.1');
    // Until the glossary moves into Vitrium, ies.org is the authoritative source.
    expect(card.vitriumLink).toBe('https://ies.org/definitions/color/');
    // …but the FRONT-COVER link must stay null rather than point at one
    // definition: it is what the AI Guide hyperlinks "ANSI/IES LS-1-25" to.
    expect(card.standardLink).toBeNull();
    // No illuminance data on a definition card.
    expect(card.application.horizontal).toBeNull();
    expect(card.application.standard).toBe('LS-1-25');
  });

  it('still answers from the term match when the vector query fails', async () => {
    // The chunk_type metadata index post-dating the definition ingest is a real
    // failure mode (it silently emptied References mode, DO12); the term match
    // has to carry the search on its own.
    const out = await searchDefinitions(fakeEnv({ vectorThrows: true }), VECTOR, 'define color', 10);
    // Exact term first, then terms that begin with it — never nothing.
    expect(out[0].definition.slug).toBe('color');
    expect(out.map(r => r.definition.slug)).toContain('color-rendering-index');
  });

  it('answers from the vector match alone when the query is not a term', async () => {
    const env = fakeEnv({
      matches: [{ id: 'LS-1-DEF-object-color', score: 0.8, metadata: { definition_slug: 'object-color' } }],
    });
    const out = await searchDefinitions(env, VECTOR, 'the colour of light reflected or transmitted by an object surface', 10);
    expect(out.map(r => r.definition.slug)).toEqual(['object-color']);
  });

  it('returns nothing when neither path matches', async () => {
    const out = await searchDefinitions(fakeEnv({ vectorThrows: true }), VECTOR, 'zzzz', 10);
    expect(out).toEqual([]);
  });

  it('respects the limit', async () => {
    const env = fakeEnv({
      matches: ROWS.map((r, i) => ({ id: r.slug, score: 0.9 - i * 0.1, metadata: { definition_slug: r.slug } })),
    });
    const out = await searchDefinitions(env, VECTOR, 'colour concepts in lighting science', 2);
    expect(out.length).toBe(2);
  });
});
