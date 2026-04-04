import { describe, it, expect } from 'vitest';
import { splitMultiQuery, cleanQuery, expandQuery, prepareQueryForEmbedding } from './query-expander.js';

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
    expect(cleanQuery('how bright should a conference room be?')).toBe('conference room be?');
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
});
