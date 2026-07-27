import { describe, it, expect } from 'vitest';
import {
  splitMultiQuery, cleanQuery, expandQuery, prepareQueryForEmbedding, isReferenceQuery,
  isVersionComparisonQuery, normalizeTypography,
} from './query-expander';

describe('query-expander', () => {
  it('splits comma-delimited multi-queries', () => {
    expect(splitMultiQuery('office lobby, hallway, conference room')).toEqual([
      'office lobby',
      'hallway',
      'conference room',
    ]);
  });

  it('keeps single queries intact', () => {
    expect(splitMultiQuery('spa lighting requirements')).toEqual(['spa lighting requirements']);
  });

  it('cleans common question phrasing', () => {
    // The dangling copula ("… be?") is stripped by TRAILING_NOISE.
    expect(cleanQuery('how bright should a conference room be?')).toBe('conference room');
  });

  it('expands known synonyms', () => {
    const expanded = expandQuery('spa');
    expect(expanded).toContain('wellness');
    expect(expanded).toContain('massage');
  });

  it('prepareQueryForEmbedding includes cleaned + expanded terms', () => {
    const prepared = prepareQueryForEmbedding('what lighting is recommended for a warehouse');
    expect(prepared).toContain('warehouse');
    expect(prepared).toContain('distribution');
  });

  // Regression for client report DO2: "ambulance" stopped returning the
  // hospital "Emergency department entry" rows between builds. The expansion
  // must anchor the term to the Building Entrances vocabulary of RP-29.
  it('expands "ambulance" toward emergency department entry rows', () => {
    const expanded = expandQuery('ambulance');
    expect(expanded).toContain('emergency');
    expect(expanded).toContain('department');
    expect(expanded).toContain('porte');
    expect(expanded).toContain('entrance');
  });

  it('expands "emergency department" toward entry/entrance rows', () => {
    const expanded = expandQuery('emergency department');
    expect(expanded).toContain('entry');
    expect(expanded).toContain('ambulance');
  });
});

describe('isReferenceQuery', () => {
  it('detects reference-seeking phrasings', () => {
    expect(isReferenceQuery('Provide a list of references in IES standards related to human vision')).toBe(true);
    expect(isReferenceQuery("Show me a list of IES references to 'behavioral science' research")).toBe(true);
    expect(isReferenceQuery('referenced documents about roadway lighting')).toBe(true);
    expect(isReferenceQuery('bibliography on circadian science')).toBe(true);
  });

  it('ignores ordinary illuminance queries', () => {
    expect(isReferenceQuery('How bright should a skating rink be?')).toBe(false);
    expect(isReferenceQuery('What are considerations for lighting parking garages?')).toBe(false);
    expect(isReferenceQuery('reference conditions during measurement')).toBe(false);
    expect(isReferenceQuery('')).toBe(false);
  });
});

// ─── Pasted queries must behave like typed ones ──────────────────────────────
// Found in the production search log (2026-07-27): six searches for
// "What’s new in the latest version of RP-8?" — pasted from the feedback
// document, so the apostrophe is U+2019 — were never treated as version
// comparisons. The reviewer evaluating the feature is precisely the person who
// pastes rather than types.

describe('normalizeTypography', () => {
  it('folds smart apostrophes, quotes, dashes and NBSP to ASCII', () => {
    expect(normalizeTypography('What’s new')).toBe("What's new");
    expect(normalizeTypography('“What’s new?”')).toBe('"What\'s new?"');
    expect(normalizeTypography('RP–8 and RP‑8 and RP—8')).toBe('RP-8 and RP-8 and RP-8');
    expect(normalizeTypography('RP-8\u00a0lighting')).toBe('RP-8 lighting');
  });

  it('leaves plain ASCII untouched and is null-safe', () => {
    expect(normalizeTypography("What's new in RP-8?")).toBe("What's new in RP-8?");
    expect(normalizeTypography('')).toBe('');
    expect(normalizeTypography(null)).toBe('');
  });
});

describe('version-comparison intent survives pasted punctuation', () => {
  // The exact strings recorded in the search log.
  const pasted = [
    'What’s new in the latest version of RP-8?',
    '“What’s new in the latest version of RP-8?',
    'What’s different in RP-6-25?',
  ];

  it('recognizes every pasted variant', () => {
    for (const q of pasted) {
      expect(isVersionComparisonQuery(q), q).toBe(true);
    }
  });

  it('still recognizes the typed variants', () => {
    expect(isVersionComparisonQuery("What's new in the latest version of RP-8?")).toBe(true);
    expect(isVersionComparisonQuery('What is new in RP-8?')).toBe(true);
    expect(isVersionComparisonQuery('what changed in DG-17?')).toBe(true);
  });

  it('does not fire on ordinary searches', () => {
    expect(isVersionComparisonQuery('fitting room')).toBe(false);
    expect(isVersionComparisonQuery('new construction lighting for a church')).toBe(false);
  });
});
