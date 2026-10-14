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
