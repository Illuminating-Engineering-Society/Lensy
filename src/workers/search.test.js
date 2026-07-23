import { describe, it, expect } from 'vitest';
import { normalizeContentTypes, buildReferenceLink } from './search';

// ─── Content-type normalization ───────────────────────────────────────────────

describe('normalizeContentTypes', () => {
  const q = 'parking garage lighting';

  it('defaults to tables + body', () => {
    expect([...normalizeContentTypes({}, q)].sort()).toEqual(['body', 'tables']);
    expect([...normalizeContentTypes({ content_types: [] }, q)].sort()).toEqual(['body', 'tables']);
  });

  it('treats compare as a modifier — never an empty search', () => {
    const ct = normalizeContentTypes({ content_types: ['compare'] }, q);
    expect(ct.has('compare')).toBe(true);
    expect(ct.has('tables')).toBe(true);
    expect(ct.has('body')).toBe(true);
  });

  it('drops invalid entries and falls back to defaults', () => {
    expect([...normalizeContentTypes({ content_types: ['bogus'] }, q)].sort()).toEqual(['body', 'tables']);
  });

  it('reference-seeking query replaces the DEFAULT selection with references-only', () => {
    const ct = normalizeContentTypes({}, 'Provide a list of references in IES standards related to human vision');
    expect([...ct]).toEqual(['references']);
  });

  it('reference-seeking query preserves compare and an explicit custom selection', () => {
    const withCompare = normalizeContentTypes(
      { content_types: ['tables', 'body', 'compare'] },
      'Provide a list of references related to human vision'
    );
    expect(withCompare.has('compare')).toBe(true);
    expect(withCompare.has('references')).toBe(true);

    const custom = normalizeContentTypes(
      { content_types: ['tables'] },
      'Provide a list of references related to human vision'
    );
    expect(custom.has('tables')).toBe(true);   // explicit choice kept
    expect(custom.has('references')).toBe(true); // reference intent added
  });
});

// ─── Reference-entry hyperlinks (priority: Library → DOI → URL → none) ───────

describe('buildReferenceLink', () => {
  const index = new Map([
    ['TM-30-20', { webUrl: 'https://view.protectedpdf.com/TM30', status: 'Active' }],
    ['TM-38-22', { webUrl: 'https://view.protectedpdf.com/TM38', status: 'Active' }],
    ['TM-21-21', { webUrl: 'https://view.protectedpdf.com/TM21', status: 'Active' }],
    ['RP-8-25+E1', { webUrl: 'https://view.protectedpdf.com/RP8', status: 'Active' }],
    ['RP-8-14', { webUrl: 'https://view.protectedpdf.com/RP8OLD', status: 'Deprecated' }],
    ['RP-27.1-22', { webUrl: 'https://view.protectedpdf.com/RP271', status: 'Active' }],
    ['LS-9-25', { webUrl: null, status: 'Active' }],
  ]);

  it('links an exact edition citation to its Library URL', () => {
    const link = buildReferenceLink('IES. ANSI/IES TM-30-20, Method for Evaluating Light Source Color Rendition.', index);
    expect(link).toEqual({ url: 'https://view.protectedpdf.com/TM30', type: 'library' });
  });

  it('resolves an EDITIONLESS citation to the same standard family, never a sibling', () => {
    // Regression: "TM-30" must not become family "TM" and match TM-38.
    const link = buildReferenceLink('IES TM-30, Method for Evaluating Light Source Color Rendition.', index);
    expect(link).toEqual({ url: 'https://view.protectedpdf.com/TM30', type: 'library' });
  });

  it('resolves a stale edition citation to the newest ACTIVE edition of the family', () => {
    const link = buildReferenceLink('IES RP-8-14, Roadway Lighting.', index);
    expect(link).toEqual({ url: 'https://view.protectedpdf.com/RP8', type: 'library' });
  });

  it('handles dotted standard numbers without cross-matching', () => {
    const link = buildReferenceLink('IES RP-27.1, Photobiological Safety.', index);
    expect(link).toEqual({ url: 'https://view.protectedpdf.com/RP271', type: 'library' });
  });

  it('falls back to DOI, then bare URL, then no link — never fabricated', () => {
    expect(buildReferenceLink(
      'Rea MS. Light as a circadian stimulus. 2018. doi:10.1177/1477153516682368',
      index
    )).toEqual({ url: 'https://doi.org/10.1177/1477153516682368', type: 'doi' });

    expect(buildReferenceLink(
      'CIE position statement, available at https://cie.co.at/publications/position-statement.',
      index
    )).toEqual({ url: 'https://cie.co.at/publications/position-statement', type: 'url' });

    expect(buildReferenceLink('Smith, J. Lighting and vision. Journal of Vision; 1998.', index)).toBeNull();
  });

  it('returns null for an indexed standard without a Library URL', () => {
    expect(buildReferenceLink('IES LS-9, Lighting Science.', index)).toBeNull();
  });
});
