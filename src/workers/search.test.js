import { describe, it, expect } from 'vitest';
import {
  normalizeContentTypes, buildReferenceLink, curatedStandardInfo,
  deriveLightingZone, reserveBodySlots, buildComparisonContext,
} from './search';

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

// ─── Curated full-title fallback (DO1: full titles on EVERY result) ───────────

describe('curatedStandardInfo', () => {
  it('resolves a schema-listed id to its curated title and designation', () => {
    const info = curatedStandardInfo('RP-43-25');
    expect(info?.title).toMatch(/Outdoor Pedestrian/i);
    expect(info?.fullDesignation).toBe('ANSI/IES RP-43-25');
  });

  it('matches errata suffixes against the base edition', () => {
    const base = curatedStandardInfo('RP-43-25');
    expect(curatedStandardInfo('RP-43-25+E1')).toEqual(base);
  });

  it('is case-insensitive and null-safe', () => {
    expect(curatedStandardInfo('rp-43-25')?.fullDesignation).toBe('ANSI/IES RP-43-25');
    expect(curatedStandardInfo(null)).toBeNull();
    expect(curatedStandardInfo('NOT-A-STANDARD-99')).toBeNull();
  });
});

// ─── DO20/DO21: lighting zone resolved from wherever the table prints it ──────

describe('deriveLightingZone', () => {
  it('reads the dedicated column when populated', () => {
    const z = deriveLightingZone({ Lighting_Zone: 'LZ2' });
    expect(z.code).toBe('LZ2');
    expect(z.label).toBe('LZ2');
  });

  it('falls back to the hierarchy label, keeping the printed form', () => {
    // RP-2 Table A-2 prints the zone as a hierarchy level, not a column.
    const z = deriveLightingZone({
      App: 'Ramps, Stairs, and Steps', App_s1: 'Low activity', App_s2: 'Lz3 (and Lz4 curfew)',
    });
    expect(z.code).toBe('LZ3');
    expect(z.label).toBe('Lz3 (and Lz4 curfew)');
    expect(z.curfew).toBe('Lz4 curfew');
  });

  it('prefers the deepest hierarchy level', () => {
    expect(deriveLightingZone({ App_s1: 'Lz1', App_s3: 'Lz4' }).code).toBe('LZ4');
  });

  it('keeps an explicit Curfew_Dimming value when the label has no curfew', () => {
    expect(deriveLightingZone({ App_s1: 'Lz4', Curfew_Dimming: 'Dim to 50%' }).curfew).toBe('Dim to 50%');
  });

  it('returns nothing for rows without a zone', () => {
    const z = deriveLightingZone({ App: 'Fitting room', App_s1: 'General' });
    expect(z.label).toBeNull();
    expect(z.code).toBeNull();
  });
});

// ─── DO23: document-body results keep a share of the pool ─────────────────────

describe('reserveBodySlots', () => {
  const row = (i, type, score) => ({
    resultType: type,
    relevanceScore: score,
    application: { code: `${type}-${i}`, standard: 'RP-2-20+E1', subCategory: null, category: null, sub1: null, rowRef: i },
  });

  it('pulls body excerpts above the cut, displacing the weakest table rows', () => {
    const tables = Array.from({ length: 10 }, (_, i) => row(i, 'application', 0.9 - i * 0.01));
    const bodies = Array.from({ length: 5 }, (_, i) => row(i, 'excerpt', 0.5 - i * 0.01));
    const out = reserveBodySlots([...tables, ...bodies], 10, bodies.length);

    expect(out.length).toBe(10);                                       // pool size unchanged
    expect(out.filter(r => r.resultType === 'excerpt').length).toBe(3); // ceil(10 * 0.3)
    // The strongest table rows survive; only the tail is traded away.
    expect(out.some(r => r.application.code === 'application-0')).toBe(true);
  });

  it('never invents more body results than exist', () => {
    const tables = Array.from({ length: 10 }, (_, i) => row(i, 'application', 0.9 - i * 0.01));
    const out = reserveBodySlots([...tables, row(0, 'excerpt', 0.4)], 10, 1);
    expect(out.filter(r => r.resultType === 'excerpt').length).toBe(1);
  });

  it('leaves a list that already meets the share untouched', () => {
    const mixed = [row(0, 'excerpt', 0.9), row(1, 'excerpt', 0.8), row(2, 'application', 0.7), row(3, 'application', 0.6)];
    expect(reserveBodySlots(mixed, 3, 2).length).toBe(3);
  });

  it('is a plain slice when nothing is below the cut', () => {
    const two = [row(0, 'application', 0.9), row(1, 'excerpt', 0.8)];
    expect(reserveBodySlots(two, 10, 1)).toEqual(two);
  });
});

// ─── DO25: which editions a comparison is between ─────────────────────────────

describe('buildComparisonContext', () => {
  const result = (id, opts = {}) => ({
    resultType: 'excerpt',
    application: { standard: id, standardFull: `ANSI/IES ${id}` },
    standardLink: `https://view.protectedpdf.com/${id}`,
    ...opts,
  });

  it('pairs the deprecated edition with the standard that superseded it', () => {
    const ctx = buildComparisonContext([
      result('RP-9-20'),                                                   // unrelated family, scores first
      result('RP-8-25'),
      result('RP-8-22', { isDeprecated: true, supersededBy: 'RP-8-25' }),
    ]);
    expect(ctx.current.id).toBe('RP-8-25');
    expect(ctx.current.url).toContain('RP-8-25');
    expect(ctx.deprecated.map(d => d.id)).toEqual(['RP-8-22']);
    expect(ctx.deprecated[0].name).toBe('ANSI/IES RP-8-22');
  });

  it('falls back to the same family when no supersedes pointer exists', () => {
    const ctx = buildComparisonContext([
      result('RP-9-20'),
      result('RP-8-25'),
      result('RP-8-22', { isDeprecated: true }),
    ]);
    expect(ctx.current.id).toBe('RP-8-25');
  });

  it('dedupes deprecated editions and survives a current-only result set', () => {
    const ctx = buildComparisonContext([
      result('RP-8-25'),
      result('RP-8-22', { isDeprecated: true }),
      result('RP-8-22', { isDeprecated: true }),
    ]);
    expect(ctx.deprecated.length).toBe(1);

    const noDeprecated = buildComparisonContext([result('RP-8-25')]);
    expect(noDeprecated.current.id).toBe('RP-8-25');
    expect(noDeprecated.deprecated).toEqual([]);
  });
});
