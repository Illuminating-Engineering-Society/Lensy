/**
 * The 10/09/26 Teams notes, as they reach the search Worker:
 *
 *   #1C  a Non-Subscriber's Contents counts show what a SUBSCRIBER would have
 *        found — counted with the same buckets the UI uses;
 *   #1F  Definition cards survive the Lighting Science collection rule (they
 *        hang off LS-1-25, which no Vitrium folder holds);
 *   #3   the curation rerank reads each authoring committee's Wicket scope.
 */
import { describe, it, expect } from 'vitest';
import { countContentKinds, restrictToStandards } from './search';
import { buildRerankPrompt, committeeScopesBlock } from '../lib/curation';
import { committeeScope } from '../lib/committees.js';

const result = (resultType, standard, extra = {}) => ({
  resultType,
  application: { standard, indoorOutdoor: null, ...(extra.application || {}) },
  ...extra,
});

describe('restrictToStandards (Non-Subscriber collection scope)', () => {
  const allowed = new Set(['LS-6-20+E1']);

  it('keeps Definition cards although LS-1-25 is in no collection', () => {
    const out = restrictToStandards([
      result('definition', 'LS-1-25'),
      result('reference', 'LS-6-20+E1'),
      result('reference', 'RP-8-25+E2'),
    ], allowed);
    expect(out.map(r => `${r.resultType}:${r.application.standard}`))
      .toEqual(['definition:LS-1-25', 'reference:LS-6-20+E1']);
  });

  it('still drops everything else outside the collection', () => {
    expect(restrictToStandards([result('excerpt', 'RP-1-24')], allowed)).toEqual([]);
  });
});

describe('countContentKinds (subscriber-view counts)', () => {
  it('buckets exactly as the Contents checkboxes do', () => {
    const counts = countContentKinds([
      result('excerpt', 'RP-1-24'),
      result('standard', 'RP-1-24'),
      result('definition', 'LS-1-25'),
      result('reference', 'LS-6-20+E1'),
      result('application', 'RP-1-24', { application: { indoorOutdoor: 'Indoor' } }),
      result('application', 'RP-43-25', { application: { indoorOutdoor: 'Outdoor' } }),
      { application: { standard: 'RP-10-23', indoorOutdoor: null } },   // no resultType = a table row
    ]);
    expect(counts).toEqual({ body: 2, definitions: 1, references: 1, tables: 3, interior: 1, exterior: 1 });
  });
});

describe('committee scopes in the curation rerank', () => {
  it('finds a scope from a card credit, a Wicket name or a Vitrium author', () => {
    for (const name of ['IES Color Committee', 'Color Committee', 'Color Cmte.']) {
      expect(committeeScope(name)).toMatch(/color rendering/i);
    }
    expect(committeeScope('Not A Real Committee')).toBeNull();
  });

  it('describes each committee in the pool once, and names it on every line', () => {
    const pool = [
      result('definition', 'LS-1-25', { committee: { name: 'IES Nomenclature Committee', url: '', exact: true } }),
      result('excerpt', 'RP-1-24', { committee: { name: 'IES Education, Library and Office Lighting Committee', url: '', exact: true } }),
      result('excerpt', 'RP-1-24', { committee: { name: 'IES Education, Library and Office Lighting Committee', url: '', exact: true } }),
    ];
    const block = committeeScopesBlock(pool);
    expect(block.split('\n')).toHaveLength(2);
    expect(block).toMatch(/^- Nomenclature Committee: /m);

    const prompt = buildRerankPrompt('difference between luminance and illuminance', pool);
    expect(prompt).toContain('Scopes of the authoring technical committees');
    expect(prompt).toContain('LS-1-25 (Nomenclature Committee)');
    expect(prompt).toMatch(/whose scope covers what the query is asking about/);
  });

  it('leaves the prompt without a scopes block when no committee is credited', () => {
    expect(buildRerankPrompt('q', [result('excerpt', 'RP-1-24'), result('excerpt', 'RP-2-20')]))
      .not.toContain('Scopes of the authoring');
  });
});
