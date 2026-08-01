import { describe, it, expect } from 'vitest';
import {
  normalizeContentTypes, buildReferenceLink, curatedStandardInfo,
  deriveLightingZone, reserveBodySlots, buildComparisonContext, matchesStandardScope, buildResult, buildChunkResults, looksLikeFrontMatter,
  editionYear, orderComparisonResults, requestedDeprecatedEdition, spreadAcrossSections,
  isResolvableDoi, isBrokenDoiUrl, definitionSearchTerm,
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
    expect(out.filter(r => r.resultType === 'excerpt').length).toBe(4); // ceil(10 * BODY_RESULT_MIN_SHARE)
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

// ─── DO25: a scoped search must scope its CHUNK results too ──────────────────
// Vectorize has no LIKE operator, so `standard_prefix` was only applied in D1 —
// to application rows. Body and reference chunks from every other standard came
// through, and "what's new in RP-8?" fed the AI Guide excerpts from TM-30-24.

describe('matchesStandardScope', () => {
  it('is open when the request carries no standard filter', () => {
    expect(matchesStandardScope({}, 'TM-30-24')).toBe(true);
    expect(matchesStandardScope({}, null)).toBe(true);
  });

  it('matches every edition of a scoped family', () => {
    const f = { standard_prefix: 'RP-8' };
    expect(matchesStandardScope(f, 'RP-8-25+E2')).toBe(true);
    expect(matchesStandardScope(f, 'RP-8-22')).toBe(true);
    expect(matchesStandardScope(f, 'rp-8-21')).toBe(true);
    expect(matchesStandardScope(f, 'RP-8')).toBe(true);
  });

  it('excludes other standards — including the number-prefix trap', () => {
    const f = { standard_prefix: 'RP-8' };
    expect(matchesStandardScope(f, 'TM-30-24')).toBe(false);   // the leak the client saw
    expect(matchesStandardScope(f, 'RP-80-99')).toBe(false);
    expect(matchesStandardScope(f, 'RP-2-20+E1')).toBe(false);
    expect(matchesStandardScope(f, null)).toBe(false);
  });

  it('an exact standard filter admits only that edition', () => {
    const f = { standard: 'RP-8-25+E2' };
    expect(matchesStandardScope(f, 'RP-8-25+E2')).toBe(true);
    expect(matchesStandardScope(f, 'RP-8-22')).toBe(false);
  });
});

// ─── The wire contract buildResult() actually emits (DO18 / DO20 / DO21 / DO22)
// buildResult is pure — no bindings — so the fields the UI depends on can be
// asserted against real code instead of read off the source.

describe('buildResult wire contract', () => {
  const STD_INDEX = new Map([
    ['RP-2-20+E1', {
      webUrl: 'https://view.protectedpdf.com/RP2', status: 'Active',
      title: 'Recommended Practice: Lighting Retail Spaces',
      fullDesignation: 'ANSI/IES RP-2-20+E1', docId: null, supersededBy: null,
    }],
    ['RP-43-25', {
      webUrl: 'https://view.protectedpdf.com/RP43', status: 'Active',
      title: 'Recommended Practice: Lighting Design for Outdoor Pedestrian Applications',
      fullDesignation: 'ANSI/IES RP-43-25', docId: null, supersededBy: null,
    }],
  ]);
  const linkCtx = { standardsIndex: STD_INDEX };

  // An RP-2 curfew row: the zone lives in the HIERARCHY, and the row parser has
  // mis-tagged Controls from the word "curfew" inside that very label.
  const rp2Row = {
    code: 'RP220E1_0154',
    Standard: 'RP-2-20+E1', Standard_Full: 'ANSI/IES RP-2-20+E1',
    Table_Ref: 'Table A-2', Row_Ref: 'Row 154', Page_Number: 72,
    App: 'Centers, Outdoors', App_s1: 'Ramps, Stairs, and Steps',
    App_s2: 'High activity', App_s3: 'Lz2 (and Lz3 curfew)',
    Indoor_Outdoor: 'Outdoor', Area_or_Task: 'Area',
    Hor_Lux: 6, Hor_Fc: 0.6, Hor_Height_m: 1.52, Hor_Avg_Max_Min: 'Avg',
    Lighting_Zone: null, Curfew_Dimming: null,
    Controls_Required: 'curfew', Max_Glare_Rating: '3%', Max_Uplight: null, Spectrum_Guidance: null,
    TM24_Eligible: 0,
  };

  const excerptIndex = {
    'RP-2-20+E1': Array.from({ length: 14 }, (_, i) => ({
      standard_id: 'RP-2-20+E1',
      excerpt_text: `Passage ${i} about pedestrian arcades, outdoor merchandising and the visual `
        + `considerations that apply where shoppers move between areas of differing luminance.`,
      page_number: 70 + i, section: `D.${i}`, chunk_type: 'text', score: 0.7 - i * 0.01,
    })),
  };

  it('DO18: splits the citation into name and page', () => {
    const r = buildResult(rp2Row, 0.6, undefined, {}, linkCtx);
    expect(r.citation).toContain('p. 72');
    expect(r.citationName).not.toContain('p. 72');       // the cover link's text
    expect(r.citationName).toContain('ANSI/IES RP-2-20+E1 Recommended Practice: Lighting Retail Spaces');
    expect(r.citationPage).toBe(72);
    expect(r.standardLink).toBe('https://view.protectedpdf.com/RP2');   // no fragment
    expect(r.vitriumLink).toBe('https://view.protectedpdf.com/RP2#page=72');
  });

  it('DO20: derives the lighting zone from the hierarchy label, with its curfew', () => {
    const { outdoor } = buildResult(rp2Row, 0.6, undefined, {}, linkCtx).application;
    expect(outdoor.lightingZone).toBe('Lz2 (and Lz3 curfew)'); // as printed
    expect(outdoor.curfewDimming).toBe('Lz3 curfew');
  });

  it('DO21: suppresses Controls/Glare outside standards that print those columns', () => {
    const { outdoor } = buildResult(rp2Row, 0.6, undefined, {}, linkCtx).application;
    expect(outdoor.controlsRequired).toBeNull();  // "curfew" misread — never shown
    expect(outdoor.maxGlareRating).toBeNull();    // any stray percentage — never shown

    const rp43Row = { ...rp2Row, Standard: 'RP-43-25', Standard_Full: 'ANSI/IES RP-43-25' };
    const rp43 = buildResult(rp43Row, 0.6, undefined, {}, linkCtx).application;
    expect(rp43.outdoor.controlsRequired).toBe('curfew');
    expect(rp43.outdoor.maxGlareRating).toBe('3%');
  });

  it('DO22: returns up to 10 excerpts, each linked to its own page', () => {
    const r = buildResult(rp2Row, 0.6, undefined, excerptIndex, linkCtx);
    expect(r.excerpts.length).toBe(10);
    expect(r.excerpt).toEqual(r.excerpts[0]);   // back-compat single excerpt
    for (const e of r.excerpts) {
      expect(e.vitriumLink).toBe(`https://view.protectedpdf.com/RP2#page=${e.pageNumber}`);
    }
    // Page-near-first: the row is on p. 72, so p. 70–77 come before p. 83.
    expect(Math.abs(r.excerpts[0].pageNumber - 72)).toBeLessThanOrEqual(5);
    expect(new Set(r.excerpts.map(e => e.pageNumber)).size).toBe(10); // no duplicates
  });

  it('DO22: a standard with no chunks yields no excerpts instead of failing', () => {
    const r = buildResult({ ...rp2Row, Standard: 'RP-43-25' }, 0.6, undefined, excerptIndex, linkCtx);
    expect(r.excerpts).toEqual([]);
    expect(r.excerpt).toBeNull();
  });
});

// ─── DO23: body chunks per standard (the other half of the share fix) ────────
// Was hard-coded to ONE excerpt per standard, so a broad conceptual query
// returned a single document-body result no matter how much prose matched.

describe('buildChunkResults per-standard cap', () => {
  const linkCtx = {
    standardsIndex: new Map([
      ['RP-10-20+E2', {
        webUrl: 'https://view.protectedpdf.com/RP10', status: 'Active',
        title: 'Recommended Practice: Lighting Common Applications',
        fullDesignation: 'ANSI/IES RP-10-20+E2', docId: null, supersededBy: null,
      }],
    ]),
  };
  const matches = Array.from({ length: 6 }, (_, i) => ({
    id: `RP-10-20+E2-chunk-${i}`,
    score: 0.7 - i * 0.02,
    metadata: {
      standard_id: 'RP-10-20+E2', chunk_type: 'text', page_number: 20 + i,
      section: `3.${i}`, excerpt_text: `Transition space prose ${i}.`,
    },
  }));

  it('keeps the requested number of excerpts per standard, best first', () => {
    const three = buildChunkResults(matches, linkCtx, { perStandard: 3 });
    expect(three.length).toBe(3);
    expect(three[0].relevanceScore).toBeGreaterThan(three[2].relevanceScore);
    expect(three.every(r => r.resultType === 'excerpt')).toBe(true);
  });

  it('still defaults to one per standard when no cap is given', () => {
    expect(buildChunkResults(matches, linkCtx).length).toBe(1);
  });

  it('carries the split citation and a page-targeted link on chunk results', () => {
    const [r] = buildChunkResults(matches, linkCtx, { perStandard: 1 });
    expect(r.citationName).toBe('ANSI/IES RP-10-20+E2 Recommended Practice: Lighting Common Applications');
    expect(r.citationPage).toBe(20);
    expect(r.standardLink).toBe('https://view.protectedpdf.com/RP10');
    expect(r.excerpts[0].vitriumLink).toBe('https://view.protectedpdf.com/RP10#page=20');
  });
});

// ─── DO25: comparison retrieval must return provisions, not packaging ────────
// Observed 2026-07-27: the RP-8 comparison rested entirely on the ERRATA page
// and "CONTINUED REFERENCES FOR ANNEX B", so the AI Guide could only report that
// the passages showed nothing substantive. Correct, but useless.

describe('looksLikeFrontMatter', () => {
  it('rejects the exact passages the RP-8 comparison was leaning on', () => {
    expect(looksLikeFrontMatter(
      'ANSI/IES RP-8-25 ERRATA If you, as a user of ANSI/IES RP-8-25, believe you have located an error not '
      + 'covered by the following revisions, you should e-mail your information to Pat McGillicuddy, '
      + 'Senior Manager of Technical Content, IES, 85 Broad St. 17th Floor, New York, NY 10004.'
    )).toBe(true);
    expect(looksLikeFrontMatter(
      '2024 Sep 17. 18. ANSI/ISO/IEC 7498-1:1994, Information Technology – Open Systems Interconnection. '
      + 'B-25 ANSI/IES RP-8-25 + E2, Recommended Practice: Lighting Roadway and Parking Facilities '
      + 'CONTINUED REFERENCES FOR ANNEX B 20. Institute of Electrical and Electronics Engineers.'
    )).toBe(true);
  });

  it('rejects tables of contents and copyright pages', () => {
    expect(looksLikeFrontMatter('9.12 New Light Sources . . . . . . . . . . . . . . 143')).toBe(true);
    expect(looksLikeFrontMatter('© 2025 Illuminating Engineering Society. All rights reserved. ISBN 978-0-87995-000-0')).toBe(true);
  });

  it('rejects a dense bibliography block', () => {
    expect(looksLikeFrontMatter(
      'IES 2020. CIE 2018. ISO 2015. Assorted standards listed for the annex, with editions from 2020, 2018 and 2015.'
    )).toBe(true);
  });

  it('KEEPS real provisions, including ones that cite a couple of standards', () => {
    expect(looksLikeFrontMatter(
      'Light loss factors, including luminaire dirt depreciation and lumen depreciation, shall be applied to the '
      + 'maintained illuminance targets; refer to ANSI/IES LS-6 and ANSI/IES/NALMCO RP-36 for the procedure.'
    )).toBe(false);
    expect(looksLikeFrontMatter(
      '17.4.3 Parking Lots and Parking Garages. New illuminance recommendations for EV charging positions apply '
      + 'at the task surface, measured as an average across the charging bay.'
    )).toBe(false);
  });

  it('treats missing text as packaging (nothing to compare)', () => {
    expect(looksLikeFrontMatter('')).toBe(true);
    expect(looksLikeFrontMatter(null)).toBe(true);
  });
});
