/**
 * The 10/13–10/14/26 Teams notes:
 *
 *   10/14 #3   concept questions weight the foundational committees' scope
 *              (rerank prompt, card curation, the Guide's input order);
 *   10/14      the Guide frames definitions ("In simplified terms, …");
 *   10/13 #2B  a printed "@ 0.00 m" height survives extraction;
 *   10/13 #2   RP-43's Controls ranges ("20% - 50%") are read;
 *   10/13 #5   page-1 covers are served for standards the portal lacks.
 */
import { describe, it, expect } from 'vitest';
import { isConceptQuery } from '../lib/query-expander';
import { isFoundationalCommittee } from '../lib/committees.js';
import {
  buildRerankPrompt, curateResults, liftWithin, conceptOrderForGuide, SCOPE_LIFT,
} from '../lib/curation';
import { frameOpeningDefinition } from '../lib/ai-summary';
import { parseDataRow } from '../lib/applications-extractor.js';
import { serveCover, coverKeyFor, coverUrlFor } from './staff-ingest';

const card = (standard, committee) => ({
  resultType: 'excerpt',
  application: { standard },
  committee: committee ? { name: committee, url: '', exact: true } : null,
});

describe('isConceptQuery', () => {
  it.each([
    "what's the difference between luminance and illuminance?",
    'what is luminance?',
    'luminance vs illuminance',
    'how does CCT differ from CRI',
    'define glare',
    'explain unified glare rating',
  ])('reads "%s" as a concept question', q => expect(isConceptQuery(q)).toBe(true));

  it.each([
    'what is the recommended illuminance for a parking lot',
    'what is the illuminance in a classroom',
    'how bright should a skating rink be?',
    'office lighting',
  ])('reads "%s" as an application question', q => expect(isConceptQuery(q)).toBe(false));
});

describe('isFoundationalCommittee', () => {
  it('recognizes terminology, measurement and vision-science committees in any spelling', () => {
    for (const name of [
      'IES Nomenclature Committee', 'Vision Science Committee', 'IES Color Committee',
      'IES Testing Procedures Committee',
      'Solid-State Lighting Subcommittee of the IES Testing Procedures Committee',
      'IES Measurements and Calculations Subcommittee', 'IES Light and Human Health Committee',
    ]) expect(isFoundationalCommittee(name)).toBe(true);
  });

  it('leaves application committees alone', () => {
    for (const name of ['IES Retail Lighting Committee', 'Roadway Lighting Committee',
      'IES Museum and Art Gallery Lighting Committee', 'Education, Library and Office Lighting Committee', null]) {
      expect(isFoundationalCommittee(name)).toBe(false);
    }
  });
});

describe('scope weighting on concept questions (client 10/14/26 #3)', () => {
  const pool = [
    card('RP-2-20+E1', 'IES Retail Lighting Committee'),
    card('RP-30-25', 'IES Museum and Art Gallery Lighting Committee'),
    card('RP-1-24', 'Education, Library and Office Lighting Committee'),
    card('LS-2-20', 'IES Nomenclature Committee'),
    card('RP-8-25+E2', 'Roadway Lighting Committee'),
    card('LS-8-25', 'IES Vision Science Committee'),
  ];
  const ids = rs => rs.map(r => r.application.standard);

  it('liftWithin moves a favoured item past at most SCOPE_LIFT others, stably', () => {
    const fav = i => i === 9;
    const band = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
    expect(liftWithin(band, fav)).toEqual([0, 1, 2, 3, 4, 9, 5, 6, 7, 8]);
    expect(SCOPE_LIFT).toBe(4);
  });

  it('lifts the vision-science documents ahead of RP-2 in the card order', () => {
    const out = curateResults(pool, { order: null, cited: new Set(), conceptQuery: true });
    expect(ids(out.results).slice(0, 2)).toEqual(['LS-2-20', 'LS-8-25']);
  });

  it('never moves a card across the Guide-cited band', () => {
    const out = curateResults(pool, { order: null, cited: new Set([0]), conceptQuery: true });
    expect(ids(out.results)[0]).toBe('RP-2-20+E1');
  });

  it('changes nothing for an application question', () => {
    const out = curateResults(pool, { order: null, cited: new Set() });
    expect(ids(out.results)).toEqual(ids(pool));
  });

  it('hands the Guide the foundational committees first', () => {
    expect(ids(conceptOrderForGuide(pool)).slice(0, 2)).toEqual(['LS-2-20', 'LS-8-25']);
  });

  it('makes the committee scope the FIRST rerank criterion, naming the committees present', () => {
    const prompt = buildRerankPrompt('difference between luminance and illuminance', pool, true);
    expect(prompt).toMatch(/committee scope is therefore the FIRST criterion/);
    expect(prompt).toContain('Nomenclature Committee, Vision Science Committee');
    expect(buildRerankPrompt('office lighting', pool, false)).not.toMatch(/FIRST criterion/);
  });
});

describe('frameOpeningDefinition (client 10/14/26)', () => {
  it('prefaces a definitional opening', () => {
    expect(frameOpeningDefinition('The difference between luminance and illuminance is that illuminance falls on a surface.\n\nMore.'))
      .toBe('In simplified terms, the difference between luminance and illuminance is that illuminance falls on a surface.\n\nMore.');
    expect(frameOpeningDefinition('Luminance is the light leaving a surface toward the eye.'))
      .toBe('In simplified terms, luminance is the light leaving a surface toward the eye.');
  });

  it('keeps an acronym capitalized', () => {
    expect(frameOpeningDefinition('CCT is a measure of the color appearance of white light.'))
      .toBe('In simplified terms, CCT is a measure of the color appearance of white light.');
  });

  it('leaves an attributed, already-framed or non-definitional opening alone', () => {
    for (const text of [
      'According to ANSI/IES LS-2-20, illuminance is the incident flux density.',
      'A practical way to understand it is that illuminance falls on a surface.',
      'In simplified terms, luminance is what the eye sees.',
      'Designers should consult the result cards for the values.',
      '### Overview\nLuminance is the light leaving a surface.',
    ]) expect(frameOpeningDefinition(text)).toBe(text);
  });
});

describe('RP-43 table rows (client 10/13/26 #2)', () => {
  it('keeps the printed ground-level height and reads a Controls range', () => {
    const r = parseDataRow('Lower limit (avg.) A 10 lx @ 0.00 m 8:1 Avg:Min 3% 50 lm 20% - 50% 2400 K to 3000 K');
    expect(r.horLux).toBe(10);
    expect(r.horHeightM).toBe(0);
    expect(r.controls).toBe('20% – 50%');
    expect(r.glareMax).toBe('3%');
    expect(r.uplightMax).toBe('50 lm');
    expect(r.spectrum).toBe('2400K to 3000K');
  });

  it('still reads the vocabulary form and leaves an empty Controls cell empty', () => {
    expect(parseDataRow('Lower limit (avg.) A 10 lx @ 0.00 m 8:1 Avg:Min 5% 500 lm Off to 50% 2400 K to 4000 K').controls)
      .toBe('Off to 50%');
    expect(parseDataRow('Lower limit (avg.) A 2 lx @ 0.00 m 10:1 Avg:Min 1% 0 lm 1800 K to 2400 K').controls).toBeNull();
  });
});

describe('page-1 cover fallback (client 10/13/26 #5)', () => {
  const env = (store) => ({
    PDFS: {
      async get(key) {
        if (!store.has(key)) return null;
        return { body: new Response(store.get(key)).body, httpMetadata: { contentType: 'image/jpeg' } };
      },
    },
  });

  it('serves a stored cover publicly, by encoded or plain id', async () => {
    const store = new Map([[coverKeyFor('TM-30-24+E1'), new Uint8Array([0xff, 0xd8, 0xff])]]);
    expect(coverUrlFor('TM-30-24+E1')).toBe('/api/covers/TM-30-24%2BE1');
    for (const raw of ['TM-30-24%2BE1', 'TM-30-24+E1']) {
      const res = await serveCover(env(store), raw);
      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('image/jpeg');
    }
  });

  it('answers 404 for a missing cover or an id that is not a standard', async () => {
    const store = new Map();
    expect((await serveCover(env(store), 'RP-1-24')).status).toBe(404);
    expect((await serveCover(env(store), '..%2F..%2Fstandards%2FRP-1-24.pdf')).status).toBe(404);
  });
});

// ─── The 10/14/26 follow-ups ─────────────────────────────────────────────────

import { resolveDesignation, resolveGuideMentions, familyOfId, editionBase } from '../lib/guide-links';
import { validateStandardEdit, deleteStandardCompletely } from './staff-ingest';
import { previewTierFor } from './session';

describe('every standard the AI Guide names gets a link (client 10/14/26)', () => {
  const index = new Map([
    ['RP-8-25+E2', { status: 'Active', webUrl: 'https://lighting.ies.org/yWVuwU' }],
    ['RP-8-22', { status: 'Deprecated', webUrl: 'https://lighting.ies.org/3Fedak' }],
    ['RP-10-20+E2', { status: 'Active', webUrl: 'https://lighting.ies.org/r10' }],
    ['LS-2-20(R2023)', { status: 'Active', webUrl: 'https://lighting.ies.org/ls2' }],
    ['LS-1', { status: 'Active', webUrl: 'https://ies.org/standards/definitions/', fullDesignation: 'ANSI/IES LS-1-25' }],
    ['RP-27.1-22', { status: 'Active', webUrl: 'https://lighting.ies.org/r271' }],
    ['RP-27-20+E1', { status: 'Deprecated', webUrl: 'https://lighting.ies.org/r27' }],
  ]);

  it('separates family from edition the way IES numbers them', () => {
    expect(familyOfId('RP-8-25+E2')).toBe('RP-8');
    expect(familyOfId('RP-10')).toBe('RP-10');
    expect(familyOfId('RP-27.1-22')).toBe('RP-27.1');
    expect(editionBase('LS-2-20(R2023)')).toBe('LS-2-20');
    expect(editionBase('LM-63-19R25')).toBe('LM-63-19');
  });

  it('resolves an edition without its suffix, a bare family and a full designation', () => {
    expect(resolveDesignation('RP-8-25', index)).toBe('RP-8-25+E2');
    expect(resolveDesignation('RP-8', index)).toBe('RP-8-25+E2');
    expect(resolveDesignation('RP-10', index)).toBe('RP-10-20+E2');
    expect(resolveDesignation('LS-2-20', index)).toBe('LS-2-20(R2023)');
    expect(resolveDesignation('LS-1-25', index)).toBe('LS-1');
    expect(resolveDesignation('RP-8-22', index)).toBe('RP-8-22');   // named exactly
  });

  it('never links a family to a deprecated edition, nor RP-27 to RP-27.1', () => {
    expect(resolveDesignation('RP-27', index)).toBeNull();
    expect(resolveDesignation('RP-27.1', index)).toBe('RP-27.1-22');
    expect(resolveDesignation('RP-99', index)).toBeNull();
  });

  it('collects the mentions in the prose, prefixes and all', () => {
    const m = resolveGuideMentions([
      'See ANSI/IES RP-8-25, Section 4.2, and IES RP-10 for further reading; RP-99 is not a standard.',
    ], index);
    expect([...m.keys()]).toEqual(['RP-8-25', 'RP-10']);
    expect(m.get('RP-8-25')).toEqual({ id: 'RP-8-25+E2', url: 'https://lighting.ies.org/yWVuwU' });
  });
});

describe('editing a standard record (client 10/14/26 #2)', () => {
  it('accepts the three catalogue fields and clears with an empty value', () => {
    expect(validateStandardEdit({
      libraryUrl: 'https://lighting.ies.org/AbC123', publishedDate: '2026-06-26', collection: 'Recommended Practice',
    })).toEqual({ fields: {
      vitrium_web_url: 'https://lighting.ies.org/AbC123', published_date: '2026-06-26', collection: 'Recommended Practice',
    } });
    expect(validateStandardEdit({ libraryUrl: '', collection: '' }).fields)
      .toEqual({ vitrium_web_url: null, collection: null });
  });

  it('refuses a foreign link, an impossible or future date, and an empty edit', () => {
    expect(validateStandardEdit({ libraryUrl: 'https://evil.example.com/x' }).error).toMatch(/lighting\.ies\.org/);
    expect(validateStandardEdit({ libraryUrl: 'http://lighting.ies.org/x' }).error).toBeTruthy();
    expect(validateStandardEdit({ publishedDate: '2026-02-30' }).error).toMatch(/real date/);
    expect(validateStandardEdit({ publishedDate: '2999-01-01' }).error).toMatch(/future/);
    expect(validateStandardEdit({}).error).toMatch(/Nothing/);
  });

  it('edits the webstore lease link, store hosts only (client 10/15/26 #3)', () => {
    expect(validateStandardEdit({ leaseUrl: 'https://store.ies.org/product/rp-41-20/' }).fields)
      .toEqual({ buy_url: 'https://store.ies.org/product/rp-41-20/' });
    expect(validateStandardEdit({ leaseUrl: '' }).fields).toEqual({ buy_url: null });
    expect(validateStandardEdit({ leaseUrl: 'https://lighting.ies.org/AbC123' }).error).toMatch(/store\.ies\.org/);
    expect(validateStandardEdit({ leaseUrl: 'http://store.ies.org/x' }).error).toBeTruthy();
    expect(validateStandardEdit({ leaseUrl: 'not a url' }).error).toMatch(/not a URL/);
  });

  // 2026-10-28: every field sync-metadata writes is editable in the admin.
  it('edits the Vitrium Doc ID (a GUID, stored lowercase) and clears it when empty', () => {
    expect(validateStandardEdit({ vitriumDocId: ' 98173938-2BFC-4745-8F4A-11D3DA2AA8E4 ' }).fields)
      .toEqual({ vitrium_doc_id: '98173938-2bfc-4745-8f4a-11d3da2aa8e4' });
    expect(validateStandardEdit({ vitriumDocId: '' }).fields).toEqual({ vitrium_doc_id: null });
    expect(validateStandardEdit({ vitriumDocId: '2H4QTw' }).error).toMatch(/GUID/);
  });

  it('edits title, designation, committee and description', () => {
    expect(validateStandardEdit({
      title: '  Recommended Practice:  Lighting Office Spaces ', fullDesignation: 'ANSI/IES RP-1-24',
      author: 'Office Lighting Committee', description: '',
    }).fields).toEqual({
      title: 'Recommended Practice: Lighting Office Spaces', full_designation: 'ANSI/IES RP-1-24',
      author: 'Office Lighting Committee', description: null,
    });
    // The title column is never blanked — an empty box means unchanged.
    expect(validateStandardEdit({ title: '', author: 'X Committee' }).fields).toEqual({ author: 'X Committee' });
    expect(validateStandardEdit({ description: 'x'.repeat(4001) }).error).toMatch(/too long/);
  });
});

describe('deleting a standard removes every trace of it', () => {
  it('vectors from both indexes, rows, pointers and every R2 object', async () => {
    const statements = [];
    const db = {
      prepare(sql) {
        return {
          bind(...args) { statements.push({ sql, args }); return this; },
          async all() { return { results: [{ code: 'RP0825E1_0001' }] }; },
          async run() { return { meta: { changes: 1 } }; },
        };
      },
    };
    const deletedIds = [];
    const index = (have) => ({
      async deleteByIds(ids) { deletedIds.push(...ids); return { count: ids.length }; },
      async getByIds(ids) { return ids.filter(id => have.includes(id)).map(id => ({ id })); },
    });
    const r2 = new Set(['deprecated/RP-8-25+E1.pdf', 'covers/RP-8-25+E1']);
    const env = {
      DB: db,
      VECTORIZE: index([]),
      VECTORIZE_DEPRECATED: index([]),
      PDFS: { async head(k) { return r2.has(k) ? {} : null; }, async delete(k) { r2.delete(k); } },
    };
    const actions = await deleteStandardCompletely(env, { id: 'RP-8-25+E1', status: 'Deprecated', chunk_count: 3 });
    expect(deletedIds).toEqual(expect.arrayContaining(['RP-8-25+E1-chunk-0', 'RP-8-25+E1-chunk-2', 'RP0825E1_0001']));
    expect(statements.some(s => /UPDATE standards SET superseded_by = NULL/.test(s.sql))).toBe(true);
    expect(statements.some(s => /DELETE FROM standards/.test(s.sql) && s.args[0] === 'RP-8-25+E1')).toBe(true);
    expect(r2.size).toBe(0);
    expect(actions.map(a => a.action)).toContain('standards_row_deleted');
  });
});

describe('administrators can preview the Non-Subscriber tier (client 10/14/26)', () => {
  const req = (cookie) => new Request('https://lens.ies.org/api/search', { headers: cookie ? { Cookie: cookie } : {} });
  it('honours the cookie for an administrator only, and only as a Non-Subscriber', () => {
    expect(previewTierFor(req('a=1; lens_preview_tier=lite'), { admin: true })).toBe('lite');
    // 10/15/26: "Preview as Non-Subscriber Guest" — a free IES account.
    expect(previewTierFor(req('lens_preview_tier=guest'), { admin: true })).toBe('guest');
    expect(previewTierFor(req('lens_preview_tier=lite'), { admin: false })).toBeNull();
    expect(previewTierFor(req('lens_preview_tier=guest'), { admin: false })).toBeNull();
    expect(previewTierFor(req('lens_preview_tier=full'), { admin: true })).toBeNull();
    expect(previewTierFor(req('lens_preview_tier=none'), { admin: true })).toBeNull();
    expect(previewTierFor(req(''), { admin: true })).toBeNull();
  });
});
