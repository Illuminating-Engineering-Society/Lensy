import { describe, it, expect } from 'vitest';
import { looksLikeFormalReference, referenceCitationKey } from './references.js';

// ─── DO26.1: only FORMAL references may appear in a References search ────────

describe('looksLikeFormalReference', () => {
  it('accepts a numbered IES bibliography entry', () => {
    expect(looksLikeFormalReference(
      '6. Illuminating Engineering Society. ANSI/IES LS-7-20: Lighting Science: Vision – Eye and Brain, New York: IES; 2020.'
    )).toBe(true);
  });

  it('accepts author-style journal and standards citations', () => {
    expect(looksLikeFormalReference(
      'Rea MS, Bullough JD. Application efficacy. J Illum Eng Soc. 2001;30(2):73-96.'
    )).toBe(true);
    expect(looksLikeFormalReference(
      'CIE. CIE S 017:2020, ILV: International Lighting Vocabulary, 2nd edition. Vienna: CIE; 2020.'
    )).toBe(true);
  });

  it('accepts a Vancouver-numbered entry — a bare number, then the authors', () => {
    // TM-30-24's REFERENCES chapter (2026-09-28): "1 Houser KW, …", no period.
    expect(looksLikeFormalReference(
      '1 Houser KW, Wei M, David A, Krames MR, Shen XS. Review of measures for light-source color rendition. Opt Express. 2013;21:10393-411.'
    )).toBe(true);
    expect(looksLikeFormalReference(
      '12 Marszalec E, Martinkauppi B, Soriano M, Petikainen M. A physics-based face database for color research. J Electronic Imaging. 2000;9:32-8.'
    )).toBe(true);
    // Still a citation without a comma after the first author.
    expect(looksLikeFormalReference(
      '3 Royer MP. What is the Reference? An examination of alternatives to the reference sources used in IES TM-30-15. Leukos. 2016;13:71-89.'
    )).toBe(true);
    // A numbered table row or a measurement is not.
    expect(looksLikeFormalReference('10 20 Task Area 300 0.76 lux maintained on the plane')).toBe(false);
    expect(looksLikeFormalReference('3 lux minimum shall be maintained at the walkway surface')).toBe(false);
  });

  it('accepts an entry located only by DOI or URL', () => {
    expect(looksLikeFormalReference('Boyce PR. Human Factors in Lighting. doi:10.1201/9781439874950')).toBe(true);
    expect(looksLikeFormalReference('IES Standards Toolbox. https://www.ies.org/standards/toolbox/')).toBe(true);
  });

  it('rejects the form/checklist prose that leaked into the reference index', () => {
    // The exact shape the client flagged (LM-83-23 p. 36): a page whose heading
    // reads "References" opened a reference run over ordinary body prose.
    expect(looksLikeFormalReference(
      'Please verify that all attachments and references are relevant, current, and clearly labeled to avoid ' +
      'processing and review delays. Please list your attachments here: Lighting Science Standards Fundamentals, ' +
      'Metrics and Calculations Lighting Practice Standards Design, Engineering, and Specifications'
    )).toBe(false);
  });

  it('rejects reader-addressed prose and fragments', () => {
    expect(looksLikeFormalReference('See Section 4.4.1 for exterior lighting zones.')).toBe(false);
    expect(looksLikeFormalReference('This annex is informative only.')).toBe(false);
    expect(looksLikeFormalReference('References')).toBe(false);
    expect(looksLikeFormalReference('')).toBe(false);
    expect(looksLikeFormalReference(null)).toBe(false);
  });

  it('rejects a whole paragraph, however citation-like its tokens', () => {
    const paragraph = Array.from({ length: 130 }, (_, i) => `word${i}`).join(' ') + ' IES 2020.';
    expect(looksLikeFormalReference(paragraph)).toBe(false);
  });
});

// ─── DO26.4: the same cited WORK recognized across standards ─────────────────

describe('referenceCitationKey', () => {
  it('keys IES standard citations by designation, regardless of the citing style', () => {
    const a = referenceCitationKey('6. Illuminating Engineering Society. ANSI/IES LS-7-20: Lighting Science. New York: IES; 2020.');
    const b = referenceCitationKey('IES. ANSI/IES LS-7-20, Lighting Science: Vision – Eye and Brain. 2020.');
    expect(a).toBe('std:LS-7-20');
    expect(b).toBe(a);
  });

  it('prefers a DOI over everything else', () => {
    expect(referenceCitationKey('Boyce PR. Human Factors. doi:10.1201/9781439874950'))
      .toBe('doi:10.1201/9781439874950');
  });

  it('falls back to an author/title signature, ignoring the entry number', () => {
    const a = referenceCitationKey('6. Boyce, Peter. Human Factors in Lighting. Third Edition; 2014.');
    const b = referenceCitationKey('12. Boyce, Peter. Human Factors in Lighting. Third Edition; 2014.');
    expect(a).toBeTruthy();
    expect(a).toBe(b);
  });

  it('returns null when there is nothing to key on', () => {
    expect(referenceCitationKey('')).toBeNull();
    expect(referenceCitationKey('a b')).toBeNull();
  });
});
