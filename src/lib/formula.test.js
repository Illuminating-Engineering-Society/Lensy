/**
 * Formula detection and redaction (client DO072 / DO072a).
 *
 * The fixtures are real: every mangled string below was produced by running
 * src/lib/pdf-parser.js over the shipped PDF named in the comment.
 */

import { describe, it, expect } from 'vitest';
import {
  hasFormula, isMostlyFormula, isFormulaLine, stripInlineFormula, redactFormulas,
  formulaSignals, FORMULA_NOTICE,
} from './formula.js';

// LP-9-25 p. 68, Annex A.1.1.3 — the passage the client screenshotted.
const LP9_PASSAGE = [
  'A.1.1.3 Regular Area With Single Row of Individual A.1.1.6 Regular Area With Uniform Indirect Lighting.The',
  'Luminaires. The average illuminance, Eavg, in such a average illuminance, Eavg, in such a space (See Figure',
  'space (SeeFigure A-1c) can be determined from: A-1f) can be determined from:',
  'Q(_______N− 1)+____P',
  'Eavg = , ___________________________R(L− 8)(W− 8)+8 Q(L− 8)+8 T(___________W− 8)+64P',
  'where: where:',
].join('\n');

// Annex A.5 of the LM "Average Luminance (Calculated) for Indoor Luminaires"
// guide, p. 26 — captured VERBATIM from a production /api/search response on
// 2026-08-28, which is to say this is text a card actually printed. It is the
// second shape of the same failure: the bars arrived as LONE underscores, no
// single line carries both an assignment and a symbol, and the one line that is
// plainly an equation ("Areatotal = …") carries no symbol at all. Every line
// therefore passed the whole-passage test individually and none was dropped.
const ANNEX_A5_PASSAGE = [
  '[Section A.5]', '(cos(90 − ϕ))', '_', '2', 'y', '_1', '√ B', '1', 'B _', '_1 x',
  '2 2 2 −1 _1', '1 (A1)[ 1√A −x + A sin', '1 1 ( 1) (A-53)', '(A', '1)]',
  'Areatotal = Areaarc + Areaellipse (A-54)',
  'InCase 3the projected area for the elliptical portion is zero once the vertical angle (ϕ) is 90°.',
  '16',
  'Approved Method: IES Guide for Determination of Average Luminance (Calculated) for Indoor Luminaires',
].join('\n');

// TM-28-20 / the AI Guide answer the client marked up in DO072a.
const AI_SENTENCE =
  'This formula, ΦtbLM-84 = ΦLM-84 · exp(−t·αLM-84), is used to approximate the luminous flux maintenance over time.';

describe('hasFormula', () => {
  it('sees a fraction bar as proof on its own', () => {
    expect(hasFormula('Q(_______N− 1)+____P')).toBe(true);
  });

  it('sees an equation with symbols', () => {
    expect(hasFormula('Eavg = Q(N − 1) + P')).toBe(true);
    expect(hasFormula('τ(λ) ≡ Φ(λ)out')).toBe(true);
  });

  it('leaves ordinary IES prose alone', () => {
    expect(hasFormula(
      'IES recommends no more than a 15:1 maximum-to-minimum ratio on the parking surface.'
    )).toBe(false);
    expect(hasFormula(
      'Refer to ANSI/IES LS-7-20, Lighting Science: Vision – Eye and Brain for additional information.'
    )).toBe(false);
    // A definition naming one Greek symbol is not an equation (DO33 cards).
    expect(hasFormula('absorptance, α: the fraction of incident light lost in a material.')).toBe(false);
  });

  it('does not fire on a lux value or a measurement height', () => {
    expect(hasFormula('300 lux at 0.76 m above finished floor, Category D.')).toBe(false);
  });

  // ── The review cases: prose that MUST survive untouched ──────────────────
  // An over-eager detector is worse than none, because everything downstream
  // then deletes symbols out of ordinary sentences — and deleting "≥" from
  // "ratios of ≥0.7" leaves a different criterion rather than a missing one.
  const PROSE_WITH_SYMBOLS = [
    'Maintained values are within ± 10% of target, and ratios of ≥ 0.7 apply × 2 zones ≤ LZ3.',
    'Values ranged from −5 to −1 dB, a −2 dB change',
    'The luminous flux Φ, the wavelength λ, the solid angle Ω, and the luminous efficacy η are defined in ANSI/IES LS-1.',
    'Values of α, β, γ and δ are given in Table 3.',
  ];

  it('treats operators and Greek symbols in prose as prose', () => {
    for (const line of PROSE_WITH_SYMBOLS) expect(hasFormula(line)).toBe(false);
  });

  it('leaves that prose byte-for-byte unchanged through every pass', () => {
    for (const line of PROSE_WITH_SYMBOLS) {
      expect(stripInlineFormula(line)).toBe(line);
      expect(redactFormulas(line)).toEqual({ text: line, redacted: 0, mostlyFormula: false });
      expect(isFormulaLine(line)).toBe(false);
    }
  });
});

describe('isFormulaLine', () => {
  it('is true for the equation lines and false for the prose around them', () => {
    const lines = LP9_PASSAGE.split('\n');
    expect(isFormulaLine(lines[3])).toBe(true);   // Q(___N− 1)+___P
    expect(isFormulaLine(lines[4])).toBe(true);   // Eavg = , ___R(L− 8)…
    expect(isFormulaLine(lines[1])).toBe(false);  // "…the average illuminance, Eavg, in such a…"
  });
});

describe('redactFormulas', () => {
  it('drops the equation lines and keeps the sentences (client DO072)', () => {
    const out = redactFormulas(LP9_PASSAGE);
    expect(out.redacted).toBeGreaterThan(0);
    expect(out.text).not.toMatch(/_{3,}/);
    expect(out.text).toContain('Regular Area With Single Row of Individual');
    expect(out.text).toContain('can be determined from');
  });

  it('reports mostlyFormula when nothing readable survives, so the card can print the notice', () => {
    const out = redactFormulas('Q(_______N− 1)+____P\nEavg = , N\nwhere:');
    expect(out.mostlyFormula).toBe(true);
    expect(FORMULA_NOTICE).toMatch(/Library/);
  });

  it('is a no-op on prose', () => {
    const prose = 'Uniformity, the even distribution of illuminance across a task plane, is desirable.';
    expect(redactFormulas(prose)).toEqual({ text: prose, redacted: 0, mostlyFormula: false });
  });

  it('clears the debris of an equation broken across many short lines', () => {
    const out = redactFormulas(ANNEX_A5_PASSAGE);
    // What the acceptance check greps for — a card must carry neither.
    expect(out.text).not.toMatch(/_{3,}/);
    expect(out.text).not.toMatch(/[≡∝∞∫∑√]/);
    // Nor any of the fragments, including the ones made only of digits and
    // brackets, which no earlier rule could see.
    for (const debris of ['(cos(90', '_1 x', '(A-53)', '1)]', 'Areatotal =']) {
      expect(out.text).not.toContain(debris);
    }
    // The sentences around it survive: the passage is still worth listing,
    // because the reader needs the link to the page that prints the formula.
    expect(out.text).toContain('the projected area for the elliptical portion is zero');
    expect(out.text).toContain('Average Luminance (Calculated) for Indoor Luminaires');
    expect(out.redacted).toBeGreaterThan(0);
    // Prose survives, so the card prints it ALONGSIDE the notice rather than
    // replacing the whole passage with it.
    expect(out.mostlyFormula).toBe(false);
  });
});

describe('stripInlineFormula (client DO072a — the AI Guide keeps the sentence)', () => {
  it('removes the equation and leaves readable prose', () => {
    const out = stripInlineFormula(AI_SENTENCE);
    expect(out).not.toContain('=');
    expect(out).not.toContain('Φ');
    expect(out).toContain('This formula');
    expect(out).toContain('is used to approximate the luminous flux maintenance over time.');
    expect(out).not.toMatch(/\s,|,,/);
  });

  it('leaves a line with no formula untouched', () => {
    const line = 'According to ANSI/IES TM-28-20, Section 5.2, p. 12, the calculation is described in Annex B.';
    expect(stripInlineFormula(line)).toBe(line);
  });

  it('keeps every word of the sentence, including the short ones', () => {
    // An earlier version treated any 1–2 character token as symbolic and ate
    // the "is" out of "…, is used to approximate…".
    expect(stripInlineFormula(AI_SENTENCE)).toBe(
      'This formula is used to approximate the luminous flux maintenance over time.',
    );
  });
});

describe('formulaSignals', () => {
  it('exposes the counts the thresholds are built on', () => {
    const s = formulaSignals('Eavg = Q(___N− 1)+ P');
    expect(s.bars).toBe(1);
    expect(s.equations).toBeGreaterThan(0);
    expect(s.math).toBeGreaterThan(0);
  });
});

describe('isMostlyFormula', () => {
  it('separates an equation block from prose that mentions one', () => {
    expect(isMostlyFormula('Eavg = , ___________R(L− 8)(W− 8)+8 Q(L− 8)')).toBe(true);
    expect(isMostlyFormula(
      'The average illuminance in such a space can be determined from the expression given in Figure A-1c, '
      + 'where N is the number of luminaires and the measurement stations are described below.'
    )).toBe(false);
  });
});
