/**
 * Alternative paths for a zero-result search (client DO077).
 *
 * The first test is the client's own worked example.
 */

import { describe, it, expect } from 'vitest';
import { buildNoResultsGuidance, suggestSpelling, editDistance } from './no-results';

const VOCAB = ['illuminance', 'luminance', 'luminaire', 'uniformity', 'correlated color temperature', 'glare'];

describe('buildNoResultsGuidance', () => {
  it('recommends Document Body for the client\'s example search', () => {
    const guidance = buildNoResultsGuidance({
      query: 'what is the difference between luminance and illuminance?',
      contentTypes: ['tables'],
    });
    expect(guidance.message).toMatch(/Illuminance Tables/);
    const first = guidance.suggestions[0];
    expect(first.action).toBe('enable_content_type');
    expect(first.value).toBe('body');
    expect(first.label).toMatch(/document bodies/i);
  });

  it('also offers the LS-1 definitions for a conceptual question', () => {
    const guidance = buildNoResultsGuidance({
      query: 'what is veiling reflection?',
      contentTypes: ['tables'],
    });
    expect(guidance.suggestions.some(s => s.action === 'enable_content_type' && s.value === 'definitions')).toBe(true);
  });

  it('offers the Illuminance Tables when the question asks for light levels', () => {
    const guidance = buildNoResultsGuidance({
      query: 'how bright should a skating rink be',
      contentTypes: ['body', 'references'],
    });
    expect(guidance.suggestions.some(s => s.value === 'tables')).toBe(true);
  });

  it('offers to drop a location narrowing', () => {
    const guidance = buildNoResultsGuidance({
      query: 'parking garage',
      contentTypes: ['tables', 'body'],
      filters: { indoor_outdoor: 'Indoor' },
    });
    expect(guidance.suggestions.some(s => s.action === 'clear_location')).toBe(true);
  });

  it('broadens an inferred standard scope by re-running the query WITHOUT it', () => {
    // The scope comes from the query text, not the UI, so "reset the filters"
    // would re-run the identical search and return the identical nothing.
    const guidance = buildNoResultsGuidance({
      query: 'RP-8-25 curb ramp illuminance',
      contentTypes: ['tables', 'body'],
      filters: { standard_prefix: 'RP-8' },
    });
    expect(guidance.message).toMatch(/RP-8/);
    const broaden = guidance.suggestions.find(s => s.action === 'search');
    expect(broaden.value).toBe('curb ramp illuminance');
    expect(guidance.suggestions.some(s => s.action === 'clear_filters')).toBe(false);
  });

  it('falls back to clearing the filters when the query is nothing BUT the scope', () => {
    const guidance = buildNoResultsGuidance({
      query: 'RP-8-25',
      contentTypes: ['tables'],
      filters: { standard: 'RP-8-25' },
    });
    expect(guidance.suggestions.some(s => s.action === 'clear_filters')).toBe(true);
  });

  it('offers a spelling correction as a runnable query', () => {
    const guidance = buildNoResultsGuidance({
      query: 'ceiling iluminance uniformity',
      contentTypes: ['body'],
      vocabulary: VOCAB,
    });
    const fix = guidance.suggestions.find(s => s.action === 'search');
    expect(fix).toBeTruthy();
    expect(fix.value).toBe('ceiling illuminance uniformity');
  });

  it('always ends with a rephrase hint and a way to reach a human', () => {
    const guidance = buildNoResultsGuidance({ query: 'zzzz', contentTypes: ['body', 'tables'] });
    const actions = guidance.suggestions.map(s => s.action);
    expect(actions).toContain('rephrase');
    expect(actions[actions.length - 1]).toBe('contact');
  });

  it('names the real limit for a LensyLite search', () => {
    const guidance = buildNoResultsGuidance({ query: 'parking garage', contentTypes: ['body'], tier: 'lite' });
    expect(guidance.message).toMatch(/Lighting Science/);
  });
});

describe('suggestSpelling', () => {
  it('corrects one word, not two', () => {
    const out = suggestSpelling('iluminance and luminanse', VOCAB);
    expect(out.correction).toBe('illuminance');
    expect(out.query).toBe('illuminance and luminanse');
  });

  it('says nothing when every word is spelt correctly', () => {
    expect(suggestSpelling('illuminance uniformity', VOCAB)).toBe(null);
  });

  it('says nothing when it has no vocabulary to compare against', () => {
    expect(suggestSpelling('iluminance', [])).toBe(null);
  });

  it('does not "correct" a word that is merely unknown', () => {
    // Nothing in the vocabulary is within two edits of "pickleball".
    expect(suggestSpelling('pickleball court', VOCAB)).toBe(null);
  });

  it('leaves short words alone — a 4-letter word is one edit from everything', () => {
    expect(suggestSpelling('glar', VOCAB)).toBe(null);
  });
});

describe('editDistance', () => {
  it('measures within its budget and gives up beyond it', () => {
    expect(editDistance('iluminance', 'illuminance')).toBe(1);
    expect(editDistance('cat', 'category', 2)).toBe(3);
  });
});
