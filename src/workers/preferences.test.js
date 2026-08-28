/**
 * Per-account UI preferences (client DO080).
 *
 * The pure halves — what may be stored, and what a stored blob means — are
 * tested here; the endpoint's session handling is exercised by the acceptance
 * harness (scripts/verify-feedback.js DO80).
 */

import { describe, it, expect } from 'vitest';
import { parsePreferences, sanitizePreferences } from './preferences';

describe('sanitizePreferences', () => {
  it('keeps the AI Guide state', () => {
    expect(sanitizePreferences({ ai_guide: false })).toEqual({ ai_guide: false });
    expect(sanitizePreferences({ ai_guide: true })).toEqual({ ai_guide: true });
  });

  it('drops anything it does not know, and anything of the wrong type', () => {
    expect(sanitizePreferences({ ai_guide: 'yes' })).toEqual({});
    expect(sanitizePreferences({ tier: 'full', admin: true, results_per_page: 100 })).toEqual({});
    // This endpoint must never become a general-purpose store.
    expect(sanitizePreferences({ ai_guide: true, whatever: { deeply: 'nested' } }))
      .toEqual({ ai_guide: true });
  });
});

describe('parsePreferences', () => {
  it('reads a stored blob', () => {
    expect(parsePreferences('{"ai_guide":false}')).toEqual({ ai_guide: false });
  });

  it('is empty for nothing, for junk, and for the wrong shape', () => {
    expect(parsePreferences(null)).toEqual({});
    expect(parsePreferences('')).toEqual({});
    expect(parsePreferences('not json')).toEqual({});
    expect(parsePreferences('[1,2,3]')).toEqual({});
    expect(parsePreferences('"a string"')).toEqual({});
  });

  it('ignores a key written by a newer Worker', () => {
    expect(parsePreferences('{"ai_guide":true,"future_setting":"x"}')).toEqual({ ai_guide: true });
  });
});
