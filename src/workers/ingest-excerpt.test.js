/**
 * The excerpt cut a vector's metadata carries.
 *
 * TM-31-20 (Measurement Uncertainty for Lighting Equipment Calibration Using
 * Integrating Spheres) was the one standard of the Lighting Measurements batch
 * that refused to index: the Worker answered a bare 500, and the Vectorize error
 * behind it was `VECTOR_UPSERT_ERROR (code = 40023): failed to parse upsert
 * vectors request in json format`. The document writes its math in astral code
 * points (𝐫 = U+1D42B, 𝛌 = U+1D6CC — 981 of them) and on p. 64 one sat astride
 * the 500-character budget, so `substring` kept the high surrogate and dropped
 * its pair. A lone surrogate has no UTF-8 encoding, and it takes the WHOLE
 * upsert batch down with it, not just its own vector.
 */

import { describe, it, expect } from 'vitest';
import { excerptText } from './ingest';

const HIGH = '\uD835';           // lone high surrogate
const BOLD_R = '𝐫';   // 𝐫 U+1D42B — one character, two code units

function hasLoneSurrogate(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xD800 && c <= 0xDBFF) {
      const next = s.charCodeAt(i + 1);
      if (next >= 0xDC00 && next <= 0xDFFF) { i++; continue; }
      return true;
    }
    if (c >= 0xDC00 && c <= 0xDFFF) return true;
  }
  return false;
}

describe('excerptText', () => {
  it('never ends on a split surrogate pair (the TM-31-20 upsert failure)', () => {
    // 𝐫 straddles the 500-code-unit boundary: 499 filler + the pair.
    const text = 'a'.repeat(499) + BOLD_R + 'tail';
    const out = excerptText(text, 'text');

    expect(hasLoneSurrogate(out)).toBe(false);
    expect(out).toBe('a'.repeat(499));
    expect(out.length).toBe(499);
  });

  it('keeps a pair that fits whole inside the budget', () => {
    const text = 'a'.repeat(498) + BOLD_R + 'tail';
    const out = excerptText(text, 'text');

    expect(out.endsWith(BOLD_R)).toBe(true);
    expect(out.length).toBe(500);
    expect(hasLoneSurrogate(out)).toBe(false);
  });

  it('carries a lone surrogate already present in the source no further than the cut', () => {
    // Defensive: a malformed PDF glyph, not a cut artefact. It must not reach
    // Vectorize at the tail either.
    const out = excerptText('a'.repeat(499) + HIGH + 'b'.repeat(50), 'text');
    expect(out.endsWith(HIGH)).toBe(false);
  });

  it('gives references and definitions the wider budget', () => {
    const long = 'x'.repeat(2000);
    expect(excerptText(long, 'reference')).toHaveLength(1500);
    expect(excerptText(long, 'definition')).toHaveLength(1500);
    expect(excerptText(long, 'text')).toHaveLength(500);
    expect(excerptText(long, 'application')).toHaveLength(500);
  });

  it('leaves text shorter than the budget untouched', () => {
    expect(excerptText('short', 'text')).toBe('short');
    expect(excerptText('', 'text')).toBe('');
  });
});
