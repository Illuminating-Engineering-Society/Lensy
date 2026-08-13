/**
 * Regression tests for the 260805 client feedback round (DO40–DO47).
 *
 * One describe block per item, in the client's numbering, so a future reader can
 * find the behaviour a given piece of feedback asked for. The Worker-side items
 * are here; the browser-side halves (the bold section line, the Document card
 * markup) live in src/frontend/index.test.js.
 */

import { describe, it, expect } from 'vitest';
import {
  stripQueryLabel, isVersionComparisonQuery, cleanQuery,
} from '../lib/query-expander';
import { extractSectionTitles, parseHeadingLine } from '../lib/chunker.js';
import {
  parseDesignationQuery, normalizeTitleForMatch, findStandardLookupResults,
  buildDocumentResult, addMissingEditionCards, comparisonFamily,
  sectionAncestors, resolveSectionPath, attachSectionTitles,
  buildComparisonContext, orderComparisonResults, looksLikeFrontMatter,
} from './search';

// ─── DO41: a pasted "Sample Search:" label must not reach the search ──────────

describe('stripQueryLabel (DO41)', () => {
  it('drops the label the feedback documents print in front of each example', () => {
    expect(stripQueryLabel('Sample Search: What\'s new in the latest version of rp-8?'))
      .toBe("What's new in the latest version of rp-8?");
    expect(stripQueryLabel('Search: parking garage')).toBe('parking garage');
    expect(stripQueryLabel('Example Search:   ramps')).toBe('ramps');
  });

  it('leaves an ordinary query alone', () => {
    expect(stripQueryLabel('how bright should a skating rink be?'))
      .toBe('how bright should a skating rink be?');
    // No colon → no label. "search and rescue" is a topic, not a prefix.
    expect(stripQueryLabel('search and rescue lighting')).toBe('search and rescue lighting');
  });

  it('never empties the query', () => {
    expect(stripQueryLabel('Search:')).toBe('Search:');
  });

  it('keeps the version-comparison intent that the label was hiding', () => {
    const pasted = 'Sample Search: What\'s new in the latest version of rp-8?';
    expect(isVersionComparisonQuery(stripQueryLabel(pasted))).toBe(true);
  });

  it('is applied by cleanQuery, so the embedding never sees the label', () => {
    expect(cleanQuery('Sample Search: parking garage lighting requirements'))
      .not.toMatch(/sample/i);
  });
});

// ─── DO40: section number + title on body excerpts ────────────────────────────

describe('extractSectionTitles (DO40)', () => {
  const page = (number, lines) => ({ number, text: lines.join('\n'), lines: lines.map(text => ({ text, x: 50 })) });

  it('maps each heading number to its printed title', () => {
    const titles = extractSectionTitles([
      page(38, ['3 Design Guide', 'Some prose about the design guide follows here.']),
      page(39, [
        '3.3 Transition Spaces Between Exterior and Interior Spaces',
        '3.3.4 Circulation Areas',
        'In providing higher light levels for persons with low vision, every room should have ambient illumination.',
      ]),
    ]);
    expect(titles['3']).toBe('Design Guide');
    expect(titles['3.3']).toBe('Transition Spaces Between Exterior and Interior Spaces');
    expect(titles['3.3.4']).toBe('Circulation Areas');
  });

  it('ignores the table of contents, page numbers and all', () => {
    const titles = extractSectionTitles([
      page(2, [
        'Table of Contents',
        '3 Design Guide . . . . . . . . . . 38',
        '3.3 Transition Spaces . . . . . . 39',
        '3.3.4 Circulation Areas . . . . . 39',
        '4 Calculations . . . . . . . . . . 55',
      ]),
      page(38, ['3 Design Guide', 'Prose that follows the heading in the body of the document.']),
    ]);
    expect(titles['3']).toBe('Design Guide');
    expect(titles['3.3']).toBeUndefined();   // only ever seen in the TOC
  });

  it('names an annex by its letter', () => {
    const titles = extractSectionTitles([
      page(70, ['Annex A Recommended Illuminance Criteria', 'General notes and governing criteria follow.']),
    ]);
    expect(titles['Annex A']).toBe('Recommended Illuminance Criteria');
  });

  it('refuses sentences that merely start with a numeral', () => {
    expect(parseHeadingLine('2.1 times the maintained value is permitted. See below.')).toBeNull();
    expect(parseHeadingLine('300 lux at 0.76 m')).toBeNull();
  });
});

describe('resolveSectionPath (DO40)', () => {
  const index = {
    '3': 'Design Guide',
    '3.3': 'Transition Spaces Between Exterior and Interior Spaces',
    '3.3.4': 'Circulation Areas',
    'Annex A': 'Recommended Illuminance Criteria',
  };

  it('walks every parent above the section', () => {
    expect(sectionAncestors('3.3.4')).toEqual(['3', '3.3', '3.3.4']);
    const resolved = resolveSectionPath(index, '3.3.4');
    expect(resolved.title).toBe('Circulation Areas');
    expect(resolved.path.map(p => p.title)).toEqual([
      'Design Guide',
      'Transition Spaces Between Exterior and Interior Spaces',
      'Circulation Areas',
    ]);
  });

  it('resolves an annex whether it is recorded as "A" or "Annex A"', () => {
    expect(resolveSectionPath(index, 'Annex A').title).toBe('Recommended Illuminance Criteria');
    expect(resolveSectionPath(index, 'A').title).toBe('Recommended Illuminance Criteria');
  });

  it('returns null when the leaf section has no recorded title', () => {
    // Printing the parent's title beside 3.3.9 would name that section wrongly.
    expect(resolveSectionPath(index, '3.3.9')).toBeNull();
    expect(resolveSectionPath(index, null)).toBeNull();
  });
});

describe('attachSectionTitles (DO40)', () => {
  const sections = { '3': 'Design Guide', '3.3': 'Transition Spaces', '3.3.4': 'Circulation Areas' };

  const env = {
    DB: {
      prepare(sql) {
        const stmt = {
          bind() { return stmt; },
          async all() {
            if (/sections_json/.test(sql)) {
              return { results: [{ id: 'RP-28-25', sections_json: JSON.stringify(sections) }] };
            }
            throw new Error(`unexpected SQL: ${sql}`);
          },
        };
        return stmt;
      },
    },
  };

  it('decorates every excerpt of an indexed standard', async () => {
    const excerpt = { text: 'x', pageNumber: 39, section: '3.3.4', chunkType: 'text' };
    const results = [{
      resultType: 'excerpt',
      application: { standard: 'RP-28-25' },
      excerpt,
      excerpts: [excerpt],
    }];
    await attachSectionTitles(env, results);
    expect(results[0].excerpt.sectionTitle).toBe('Circulation Areas');
    expect(results[0].excerpt.sectionPath.map(p => p.number)).toEqual(['3', '3.3', '3.3.4']);
  });

  it('does nothing — and costs no query — when no excerpt carries a section', async () => {
    const results = [{
      resultType: 'application',
      application: { standard: 'RP-28-25' },
      excerpt: { text: 'x', pageNumber: 1, section: null },
      excerpts: [],
    }];
    await expect(attachSectionTitles({ DB: null }, results)).resolves.toBeUndefined();
  });
});

// ─── DO42 / DO43: document comparison ────────────────────────────────────────

describe('comparisonFamily (DO42)', () => {
  it('prefers the inferred filter, then the designation in the query', () => {
    expect(comparisonFamily({ standard_prefix: 'RP-8' }, 'anything')).toBe('RP-8');
    expect(comparisonFamily({ standard: 'RP-8-25+E2' }, 'anything')).toBe('RP-8');
    expect(comparisonFamily({}, "what's new in the latest version of rp-8?")).toBe('RP-8');
  });

  it('is null when the query names no standard', () => {
    expect(comparisonFamily({}, 'what changed recently?')).toBeNull();
  });
});

describe('addMissingEditionCards (DO42)', () => {
  const edition = (id, status = 'Deprecated', extra = {}) => ({
    id, title: 'Recommended Practice: Roadway Lighting',
    fullDesignation: `ANSI/IES ${id}`, description: null, author: null, collection: null,
    thumbnailUrl: null, buyUrl: null, webUrl: `https://view.protectedpdf.com/${id}`,
    status, supersededBy: status === 'Deprecated' ? 'RP-8-25+E2' : null,
    year: Number(`20${id.slice(-2).replace(/\D/g, '')}`) || 2000, ...extra,
  });
  const editions = [
    edition('RP-8-25+E2', 'Active'),
    edition('RP-8-22'), edition('RP-8-21'), edition('RP-8-18'),
  ];

  it('adds a card for every edition retrieval never reached', () => {
    const results = [{
      resultType: 'excerpt', relevanceScore: 0.5, isDeprecated: true,
      application: { standard: 'RP-8-22', standardFull: 'ANSI/IES RP-8-22', code: 'c1' },
    }];
    const out = addMissingEditionCards(results, editions);
    const ids = out.map(r => r.application.standard);
    expect(ids).toContain('RP-8-25+E2');   // the current edition — the one that was missing
    expect(ids).toContain('RP-8-21');
    expect(ids).toContain('RP-8-18');
    expect(ids.filter(id => id === 'RP-8-22')).toHaveLength(1); // not duplicated
  });

  it('prints current first, then deprecated newest to oldest', () => {
    const ordered = orderComparisonResults(addMissingEditionCards([], editions));
    expect(ordered.map(r => r.application.standard))
      .toEqual(['RP-8-25+E2', 'RP-8-22', 'RP-8-21', 'RP-8-18']);
  });

  it('flags the prior editions as deprecated, with the replacement named', () => {
    const out = addMissingEditionCards([], editions);
    const old = out.find(r => r.application.standard === 'RP-8-22');
    expect(old.isDeprecated).toBe(true);
    expect(old.deprecationNotice).toContain('RP-8-25+E2');
    expect(old.citationName).toContain('(deprecated)');
    const current = out.find(r => r.application.standard === 'RP-8-25+E2');
    expect(current.isDeprecated).toBeUndefined();
  });

  it('is a no-op when no editions were resolved', () => {
    const results = [{ resultType: 'excerpt', application: { standard: 'RP-8-22' } }];
    expect(addMissingEditionCards(results, [])).toBe(results);
  });
});

describe('buildComparisonContext trusts D1 for "current" (DO43)', () => {
  const dep = {
    resultType: 'excerpt', relevanceScore: 0.5, isDeprecated: true,
    application: { standard: 'RP-8-22', standardFull: 'ANSI/IES RP-8-22', code: 'd' },
    standardLink: null,
  };
  const strayCurrent = {
    resultType: 'excerpt', relevanceScore: 0.9,
    application: { standard: 'TM-30-24', standardFull: 'ANSI/IES TM-30-24', code: 'c' },
    standardLink: null,
  };

  it('names the newest Active edition of the family, not the top result', () => {
    const ctx = buildComparisonContext([strayCurrent, dep], null, {
      id: 'RP-8-25+E2', title: 'Recommended Practice: Roadway Lighting',
      fullDesignation: 'ANSI/IES RP-8-25+E2', webUrl: 'https://view.protectedpdf.com/x',
      status: 'Active', supersededBy: null, description: null, author: null,
      collection: null, thumbnailUrl: null, buyUrl: null, year: 2025,
    });
    expect(ctx.current.id).toBe('RP-8-25+E2');
    expect(ctx.current.name).toContain('Roadway Lighting');
    expect(ctx.deprecated.map(d => d.id)).toEqual(['RP-8-22']);
  });

  it('falls back to the result list when no family was resolved', () => {
    const ctx = buildComparisonContext([strayCurrent, dep], null, null);
    expect(ctx.current.id).toBe('TM-30-24');
  });
});

describe('looksLikeFrontMatter rejects roster pages (DO43)', () => {
  it('drops a contributors page, however it is headed', () => {
    expect(looksLikeFrontMatter(
      'Contributors\nJ. Smith, Acme Lighting\nR. Jones, Lumen Co.\nA. Patel, Illume\n' +
      'M. Garcia, Photon Design\nT. Nguyen, Beacon Studio'
    )).toBe(true);
  });

  it('drops an acknowledgements block', () => {
    expect(looksLikeFrontMatter('Acknowledgments — the committee thanks the reviewers of this document.')).toBe(true);
  });

  it('keeps an ordinary provision', () => {
    expect(looksLikeFrontMatter(
      'Roadway lighting design should consider the visual needs of drivers and pedestrians, ' +
      'including adaptation, glare control and uniformity across the travelled way.'
    )).toBe(false);
  });
});

// ─── DO47: a designation or title search returns the document itself ──────────

describe('parseDesignationQuery (DO47)', () => {
  it('accepts every variation the client listed', () => {
    expect(parseDesignationQuery('RP-3')).toEqual({ id: null, family: 'RP-3' });
    expect(parseDesignationQuery('RP-03')).toEqual({ id: null, family: 'RP-3' });
    expect(parseDesignationQuery('rp-3-20')).toEqual({ id: 'RP-3-20', family: 'RP-3' });
    expect(parseDesignationQuery('RP-03-20')).toEqual({ id: 'RP-3-20', family: 'RP-3' });
    expect(parseDesignationQuery('RP-3-20+E1')).toEqual({ id: 'RP-3-20+E1', family: 'RP-3' });
    expect(parseDesignationQuery('RP-03-20 E1')).toEqual({ id: 'RP-3-20+E1', family: 'RP-3' });
  });

  it('handles the ANSI/IES prefix, a reaffirmation marker and a decimal number', () => {
    expect(parseDesignationQuery('ANSI/IES LS-2-20(R2023)')).toEqual({ id: 'LS-2-20', family: 'LS-2' });
    expect(parseDesignationQuery('RP-27.1-22')).toEqual({ id: 'RP-27.1-22', family: 'RP-27.1' });
    expect(parseDesignationQuery('IES G-1-22')).toEqual({ id: 'G-1-22', family: 'G-1' });
  });

  it('rejects anything that is not just a designation', () => {
    expect(parseDesignationQuery('what changed in RP-3-20?')).toBeNull();
    expect(parseDesignationQuery('lighting for classrooms')).toBeNull();
    expect(parseDesignationQuery('XX-1-20')).toBeNull();   // not an IES series
  });
});

describe('findStandardLookupResults (DO47)', () => {
  const ROWS = [
    {
      id: 'RP-3-20+E1', title: 'Recommended Practice: Lighting Educational Facilities',
      full_designation: 'ANSI/IES RP-3-20+E1',
      description: 'Best practices to light classrooms and corridors.',
      author: 'Education, Library and Office Lighting Committee', status: 'Active',
      superseded_by: null, vitrium_web_url: 'https://view.protectedpdf.com/rp3',
      collection: 'Lighting Applications', thumbnail_url: 'https://ies.org/cover.jpg',
      buy_url: 'https://store.ies.org/rp-3',
    },
    {
      id: 'RP-8-25+E2', title: 'Recommended Practice: Roadway Lighting',
      full_designation: 'ANSI/IES RP-8-25+E2', description: null,
      author: null, status: 'Active', superseded_by: null,
      vitrium_web_url: 'https://view.protectedpdf.com/rp8',
      collection: 'Roadway Lighting', thumbnail_url: null, buy_url: null,
    },
    {
      id: 'RP-8-22', title: 'Recommended Practice: Roadway Lighting',
      full_designation: 'ANSI/IES RP-8-22', description: null,
      author: null, status: 'Deprecated', superseded_by: 'RP-8-25+E2',
      vitrium_web_url: null, collection: 'Roadway Lighting', thumbnail_url: null, buy_url: null,
    },
  ];

  const env = {
    DB: {
      prepare(sql) {
        const stmt = {
          _args: [],
          bind(...args) { stmt._args = args; return stmt; },
          async all() {
            if (/WHERE UPPER\(id\) = \? OR UPPER\(id\) LIKE \?/.test(sql)) {
              const [id, like] = stmt._args;
              const prefix = String(like).replace(/%$/, '');
              return { results: ROWS.filter(r => r.id.toUpperCase() === id || r.id.toUpperCase().startsWith(prefix)) };
            }
            if (/SELECT id, title FROM standards/.test(sql)) {
              return { results: ROWS.filter(r => r.status === 'Active').map(r => ({ id: r.id, title: r.title })) };
            }
            if (/WHERE id IN/.test(sql)) {
              return { results: ROWS.filter(r => stmt._args.includes(r.id)) };
            }
            throw new Error(`unexpected SQL: ${sql}`);
          },
        };
        return stmt;
      },
    },
  };

  it('answers a bare designation with the document itself', async () => {
    const out = await findStandardLookupResults(env, 'RP-3-20');
    expect(out).toHaveLength(1);
    expect(out[0].resultType).toBe('standard');
    // "RP-3-20" resolves to the indexed errata edition — the same document.
    expect(out[0].document.id).toBe('RP-3-20+E1');
    expect(out[0].relevanceScore).toBe(1);
  });

  it('carries the thumbnail, description and committee the ToC shows', async () => {
    const [card] = await findStandardLookupResults(env, 'rp-03-20 e1');
    expect(card.document.thumbnailUrl).toBe('https://ies.org/cover.jpg');
    expect(card.document.description).toContain('classrooms');
    expect(card.committee.name).toBe('IES Education, Library and Office Lighting Committee');
    // Stored as Vitrium's own viewer host; handed to the reader on the branded
    // Library host, which is the one that holds the IES session.
    expect(card.vitriumLink).toBe('https://lighting.ies.org/rp3');
  });

  it('prints the full designation AND title in the citation (DO45)', async () => {
    const [card] = await findStandardLookupResults(env, 'RP-3');
    expect(card.citationName)
      .toBe('ANSI/IES RP-3-20+E1 Recommended Practice: Lighting Educational Facilities');
  });

  it('never answers with a deprecated edition', async () => {
    const out = await findStandardLookupResults(env, 'RP-8-22');
    expect(out.map(r => r.document.id)).toEqual(['RP-8-25+E2']);
    expect(out[0].relevanceScore).toBeLessThan(1);   // a close match, not an exact one
  });

  it('matches a document title', async () => {
    const out = await findStandardLookupResults(env, 'Lighting Educational Facilities');
    expect(out[0].document.id).toBe('RP-3-20+E1');
    expect(out[0].document.matchedOn).toBe('title');
  });

  it('stays out of the way of a topical search', async () => {
    expect(await findStandardLookupResults(env, 'how bright should a classroom be?')).toEqual([]);
    expect(await findStandardLookupResults(env, 'what changed in RP-3-20?')).toEqual([]);
  });

  it('normalizes a title for matching without its series preamble', () => {
    expect(normalizeTitleForMatch('ANSI/IES RP-3-20+E1 Recommended Practice: Lighting Educational Facilities'))
      .toBe('lighting educational facilities');
  });
});

describe('buildDocumentResult (DO45/DO47)', () => {
  const edition = {
    id: 'LS-2-20', title: 'Lighting Science: Concepts and Language of Lighting',
    fullDesignation: 'ANSI/IES LS-2-20(R2023)', description: 'Concepts and language.',
    author: 'Nomenclature Committee', collection: 'Lighting Science',
    thumbnailUrl: null, buyUrl: null, webUrl: 'https://view.protectedpdf.com/ls2',
    status: 'Active', supersededBy: null, year: 2020,
  };

  it('composes designation + title, exactly as the client asked it to print', () => {
    const card = buildDocumentResult(edition, 1, 'designation');
    expect(card.citationName)
      .toBe('ANSI/IES LS-2-20(R2023) Lighting Science: Concepts and Language of Lighting');
    expect(card.citationPage).toBeNull();
    expect(card.standardLink).toBe('https://view.protectedpdf.com/ls2');
  });

  it('credits the authoring committee (DO29)', () => {
    expect(buildDocumentResult(edition, 1, 'designation').committee.name)
      .toBe('IES Nomenclature Committee');
  });
});
