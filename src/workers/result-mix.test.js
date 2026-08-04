/**
 * DO34 (committee attribution) and DO39 (result mix by type).
 */

import { describe, it, expect } from 'vitest';
import {
  resolveCommittee, formatCommitteeName, looksLikeCommittee, isKnownCommitteeSlug,
  COMMITTEES_ROOT_URL,
} from '../lib/committees.js';
import { applyTypeFloors, typeMatchFloor } from './search';

// ─── DO34: authoring technical committee ──────────────────────────────────────

describe('resolveCommittee', () => {
  it('resolves the client\'s own example to the page they cited', () => {
    const c = resolveCommittee('Retail Lighting Committee');
    expect(c.name).toBe('IES Retail Lighting Committee');
    expect(c.url).toBe('https://ies.org/committee/retail-lighting/');
    expect(c.exact).toBe(true);
  });

  it('formats every committee as "IES [Committee Name]"', () => {
    for (const input of ['Roadway Lighting Committee', 'IES Roadway Lighting Committee', 'roadway lighting']) {
      expect(resolveCommittee(input).name).toBe('IES Roadway Lighting Committee');
    }
  });

  it('absorbs the ways Vitrium\'s Author field is typed by hand', () => {
    // Same committee, four spellings — all must reach one slug.
    const urls = [
      'Nomenclature Committee',
      'IES Nomenclature Cmte.',
      'nomenclature',
      'ANSI/IES Nomenclature Committee',
    ].map(a => resolveCommittee(a).url);
    expect(new Set(urls).size).toBe(1);
    expect(urls[0]).toBe('https://ies.org/committee/nomenclature/');
  });

  it('handles the ampersand form of a committee printed with "and"', () => {
    const c = resolveCommittee('Museum & Art Gallery Lighting Committee');
    expect(c.exact).toBe(true);
    expect(c.url).toBe('https://ies.org/committee/museum-and-art-gallery-lighting/');
  });

  it('falls back to the root list for a committee with no page — never a guessed slug', () => {
    // "committees occasionally are dissolved" — a 404 on ies.org is worse than
    // the general index.
    const c = resolveCommittee('Obsolete Widget Lighting Committee');
    expect(c.name).toBe('IES Obsolete Widget Lighting Committee');
    expect(c.url).toBe(COMMITTEES_ROOT_URL);
    expect(c.exact).toBe(false);
    expect(c.url).not.toContain('/committee/obsolete');
  });

  it('credits working groups without forcing "Committee" onto them', () => {
    const c = resolveCommittee('Mesopic Task Group');
    expect(c.name).toBe('IES Mesopic Task Group');
    expect(c.exact).toBe(false);
  });

  it('refuses to credit an author that is not a committee', () => {
    // The `author` column also holds people and boilerplate, and crediting
    // those as the authoring committee would be wrong.
    expect(resolveCommittee('Senior Manager of Technical Content')).toBeNull();
    expect(resolveCommittee('Illuminating Engineering Society')).toBeNull();
    expect(resolveCommittee('J. Smith')).toBeNull();
    expect(resolveCommittee('')).toBeNull();
    expect(resolveCommittee(null)).toBeNull();
  });

  it('recognizes committee-shaped strings and rejects the rest', () => {
    expect(looksLikeCommittee('Color Committee')).toBe(true);
    expect(looksLikeCommittee('Daylighting Subcommittee')).toBe(true);
    expect(looksLikeCommittee('Some Working Group')).toBe(true);
    expect(looksLikeCommittee('Acme Corp')).toBe(false);
  });

  it('formats a name for a committee outside the registry', () => {
    expect(formatCommitteeName('retail lighting cmte.')).toBe('IES retail lighting Committee');
    expect(formatCommitteeName('IES Color Committee')).toBe('IES Color Committee');
  });

  it('knows which slugs ies.org actually publishes', () => {
    expect(isKnownCommitteeSlug('retail-lighting')).toBe(true);
    expect(isKnownCommitteeSlug('roadway-lighting')).toBe(true);
    expect(isKnownCommitteeSlug('not-a-committee')).toBe(false);
  });
});

// ─── DO39: result mix by type ─────────────────────────────────────────────────

describe('typeMatchFloor', () => {
  it('holds illuminance rows to the highest bar and prose to the lowest', () => {
    // A weak table row reads as a recommendation for the WRONG application;
    // a weak passage is just a passage the reader can judge.
    expect(typeMatchFloor('application')).toBe(0.50);
    expect(typeMatchFloor('definition')).toBe(0.40);
    expect(typeMatchFloor('excerpt')).toBe(0.25);
    expect(typeMatchFloor('reference')).toBe(0.25);
  });
});

describe('applyTypeFloors', () => {
  const r = (type, score, code = `${type}-${score}`) => ({
    resultType: type, relevanceScore: score,
    application: { code, standard: 'RP-2-20+E1' },
  });

  it('drops a weak illuminance row while keeping an equally weak passage', () => {
    const out = applyTypeFloors([r('application', 0.45), r('excerpt', 0.30)]);
    expect(out.map(x => x.resultType)).toEqual(['excerpt']);
  });

  it('keeps a strong illuminance row', () => {
    const out = applyTypeFloors([r('application', 0.62), r('excerpt', 0.30)]);
    expect(out.length).toBe(2);
  });

  it('holds definitions to 40%', () => {
    const out = applyTypeFloors([r('definition', 0.35), r('definition', 0.55)]);
    expect(out.map(x => x.relevanceScore)).toEqual([0.55]);
  });

  it('never returns an empty list when the search DID find something', () => {
    // A blank page is worse than "here are the closest matches" — the
    // low-confidence banner already says confidence is poor.
    const out = applyTypeFloors([r('application', 0.20), r('application', 0.30), r('application', 0.10)]);
    expect(out.length).toBe(3);
    expect(out[0].relevanceScore).toBe(0.30); // best first
  });

  it('caps the all-below-floor fallback', () => {
    const weak = Array.from({ length: 9 }, (_, i) => r('application', 0.1 + i * 0.01, `w${i}`));
    expect(applyTypeFloors(weak).length).toBe(3);
  });

  it('is a no-op on an empty list', () => {
    expect(applyTypeFloors([])).toEqual([]);
  });
});
