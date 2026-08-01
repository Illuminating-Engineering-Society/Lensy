/**
 * Regression tests for the 260729 client feedback round (DO20–DO33).
 *
 * Kept separate from search.test.js so each round of feedback stays legible as a
 * unit: every describe block below names the item it locks down.
 */

import { describe, it, expect } from 'vitest';
import {
  buildReferenceLink, buildComparisonContext, normalizeContentTypes,
  editionYear, orderComparisonResults, requestedDeprecatedEdition, spreadAcrossSections,
  isResolvableDoi, isBrokenDoiUrl, definitionSearchTerm, searchDefinitions,
} from './search';
import { extractReferenceMarkers, referenceEntryNumber } from '../lib/reference-markers.js';
import {
  sanitizeDefinitionHtml, definitionPlainText, definitionClause,
  normalizeGlossaryPost, buildDefinitionEmbedText,
} from '../lib/definitions.js';

// ─── DO27: version-comparison ordering ────────────────────────────────────────

describe('editionYear', () => {
  it('reads the two-digit edition and infers the century', () => {
    expect(editionYear('RP-8-25')).toBe(2025);
    expect(editionYear('RP-8-25+E2')).toBe(2025);
    expect(editionYear('RP-8-99')).toBe(1999);
    expect(editionYear('RP-9-00')).toBe(2000);
  });

  it('reads the EDITION, not a reaffirmation suffix', () => {
    expect(editionYear('LM-63-19R25')).toBe(2019);
  });

  it('is -1 when there is no edition to read', () => {
    expect(editionYear('RP-8')).toBe(-1);
    expect(editionYear(null)).toBe(-1);
  });
});

describe('orderComparisonResults', () => {
  const res = (id, opts = {}) => ({
    resultType: 'excerpt',
    relevanceScore: opts.score ?? 0.5,
    isDeprecated: !!opts.deprecated,
    application: { standard: id, standardFull: `ANSI/IES ${id}`, code: `${id}-${opts.n ?? 0}` },
  });

  it('puts the current standard first, then deprecated newest to oldest', () => {
    const out = orderComparisonResults([
      res('RP-8-14', { deprecated: true, score: 0.9 }),
      res('RP-8-25+E2', { score: 0.4 }),
      res('RP-8-22', { deprecated: true, score: 0.6 }),
      res('RP-8-18', { deprecated: true, score: 0.8 }),
    ]);
    expect(out.map(r => r.application.standard))
      .toEqual(['RP-8-25+E2', 'RP-8-22', 'RP-8-18', 'RP-8-14']);
  });

  it('keeps one edition together, score-ordered inside the edition', () => {
    const out = orderComparisonResults([
      res('RP-8-22', { deprecated: true, score: 0.3, n: 1 }),
      res('RP-8-18', { deprecated: true, score: 0.9, n: 2 }),
      res('RP-8-22', { deprecated: true, score: 0.7, n: 3 }),
    ]);
    expect(out.map(r => r.application.code))
      .toEqual(['RP-8-22-3', 'RP-8-22-1', 'RP-8-18-2']);
  });

  it('is a no-op when nothing is deprecated', () => {
    const list = [res('RP-8-25+E2', { score: 0.9 }), res('TM-30-24', { score: 0.5 })];
    expect(orderComparisonResults(list)).toBe(list);
  });
});

describe('buildComparisonContext targets one prior edition', () => {
  const dep = (id) => ({
    resultType: 'excerpt', relevanceScore: 0.5, isDeprecated: true, supersededBy: 'RP-8-25+E2',
    standardLink: `https://view.protectedpdf.com/${id}`,
    application: { standard: id, standardFull: `ANSI/IES ${id}`, code: id },
  });
  const cur = {
    resultType: 'excerpt', relevanceScore: 0.9,
    application: { standard: 'RP-8-25+E2', standardFull: 'ANSI/IES RP-8-25+E2', code: 'c' },
    standardLink: 'https://view.protectedpdf.com/current',
  };

  it('picks the MOST RECENT deprecated edition and shelves the rest', () => {
    const ctx = buildComparisonContext([cur, dep('RP-8-14'), dep('RP-8-22'), dep('RP-8-18')]);
    expect(ctx.current.id).toBe('RP-8-25+E2');
    expect(ctx.deprecated.map(d => d.id)).toEqual(['RP-8-22']);
    expect(ctx.alsoDeprecated.map(d => d.id)).toEqual(['RP-8-18', 'RP-8-14']);
  });

  it('honours an edition the user named explicitly', () => {
    const ctx = buildComparisonContext([cur, dep('RP-8-22'), dep('RP-8-18')], 'RP-8-18');
    expect(ctx.deprecated.map(d => d.id)).toEqual(['RP-8-18']);
    expect(ctx.alsoDeprecated.map(d => d.id)).toEqual(['RP-8-22']);
  });
});

describe('requestedDeprecatedEdition', () => {
  it('finds the prior edition named alongside the current one', () => {
    expect(requestedDeprecatedEdition('what changed between RP-8-25+E2 and RP-8-18?', 'RP-8-25+E2'))
      .toBe('RP-8-18');
  });

  it('ignores the current edition, errata suffix and all', () => {
    expect(requestedDeprecatedEdition("what's new in RP-8-25?", 'RP-8-25+E2')).toBeNull();
  });

  it('is null when the query names no edition', () => {
    expect(requestedDeprecatedEdition("what's new in rp-8?", 'RP-8-25+E2')).toBeNull();
  });

  it('survives pasted smart dashes', () => {
    expect(requestedDeprecatedEdition('compare RP‑8‑25 with RP‑8‑18', 'RP-8-25'))
      .toBe('RP-8-18');
  });
});

// ─── DO28: comparison excerpts must span chapters ─────────────────────────────

describe('spreadAcrossSections', () => {
  const r = (section, page, score) => ({
    resultType: 'excerpt', relevanceScore: score,
    excerpt: { section, pageNumber: page },
    application: { standard: 'RP-8-22', code: `${section}-${page}` },
  });

  it('caps how much of the window one section can take', () => {
    const list = [
      r('17.4', 100, 0.9), r('17.4', 101, 0.89), r('17.4', 102, 0.88), r('17.4', 103, 0.87),
      r('11.3', 60, 0.5), r('9.2', 30, 0.4),
    ];
    const out = spreadAcrossSections(list, 4, 2);
    expect(out.filter(x => x.excerpt.section === '17.4').length).toBe(2);
    expect(out.map(x => x.excerpt.section)).toContain('11.3');
    expect(out.map(x => x.excerpt.section)).toContain('9.2');
  });

  it('bands by page when chunks carry no section', () => {
    const list = [r(null, 10, 0.9), r(null, 11, 0.89), r(null, 12, 0.88), r(null, 90, 0.4)];
    const out = spreadAcrossSections(list, 3, 2);
    expect(out.filter(x => x.excerpt.pageNumber >= 90).length).toBe(1);
  });

  it('backfills from the skipped items rather than returning a short list', () => {
    const list = [r('1', 1, 0.9), r('1', 2, 0.8), r('1', 3, 0.7), r('1', 4, 0.6)];
    expect(spreadAcrossSections(list, 3, 1).length).toBe(3);
  });

  it('is a no-op when the list already fits', () => {
    const list = [r('1', 1, 0.9), r('2', 20, 0.8)];
    expect(spreadAcrossSections(list, 5)).toBe(list);
  });
});

// ─── DO31.3: a DOI link is never a bare registrant prefix ─────────────────────

describe('DOI validation', () => {
  it('accepts a DOI with a real item suffix', () => {
    expect(isResolvableDoi('10.1080/00994480.2020.1750207')).toBe(true);
    expect(isResolvableDoi('10.1002/9781118534113')).toBe(true);
  });

  it('rejects a registrant prefix on its own', () => {
    expect(isResolvableDoi('10.1080')).toBe(false);
    expect(isResolvableDoi('10.1080/')).toBe(false);
    expect(isResolvableDoi('10.1080/-')).toBe(false);
  });

  it('recognizes doi.org URLs that land on the "prefix only" error page', () => {
    expect(isBrokenDoiUrl('https://doi.org/10.1080')).toBe(true);
    expect(isBrokenDoiUrl('https://dx.doi.org/10.1080/')).toBe(true);
    expect(isBrokenDoiUrl('https://doi.org/10.1080/00994480.2020.1750207')).toBe(false);
    expect(isBrokenDoiUrl('https://www.ies.org/standards/')).toBe(false);
  });

  it('offers no link at all for a prefix-only DOI', () => {
    expect(buildReferenceLink('Smith J. Lighting study. 2020. https://doi.org/10.1080')).toBeNull();
    expect(buildReferenceLink('Smith J. Lighting study. 2020. doi 10.1080')).toBeNull();
  });

  it('still links a complete DOI', () => {
    expect(buildReferenceLink('Smith J. Study. 2020. https://doi.org/10.1080/00994480.2020.1750207'))
      .toEqual({ url: 'https://doi.org/10.1080/00994480.2020.1750207', type: 'doi' });
  });
});

// ─── DO31.4: in-body reference markers ────────────────────────────────────────

describe('extractReferenceMarkers', () => {
  const page = (number, lines, text = '') => ({ number, text, lines });

  it('keeps the FIRST page each marker appears on', () => {
    const markers = extractReferenceMarkers([
      page(18, [{ marks: [6] }, { marks: [] }]),
      page(21, [{ marks: [6, 17] }, { marks: [18] }]),
    ]);
    expect(markers).toEqual({ 6: 18, 17: 21, 18: 21 });
  });

  it('ignores illuminance-criteria pages, whose superscripts are table footnotes', () => {
    const markers = extractReferenceMarkers([
      page(72, [{ marks: [6] }, { marks: [7] }],
        'Ramps 10 lx @ 1.52 m 1 fc @ 5 ft  Steps 8 lx @ TS  Walk 6 lx @ 0.0 m'),
    ]);
    expect(markers).toEqual({});
  });

  it('is empty when nothing was captured', () => {
    expect(extractReferenceMarkers([page(1, [{}, { marks: [] }])])).toEqual({});
    expect(extractReferenceMarkers([])).toEqual({});
  });
});

describe('referenceEntryNumber', () => {
  it('reads the number a bibliography entry is printed under', () => {
    expect(referenceEntryNumber('6 International Commission on Illumination (CIE). CIE 015:2018.')).toBe(6);
    expect(referenceEntryNumber('[12] Rea MS. Lighting Handbook. New York: IES; 2011.')).toBe(12);
    expect(referenceEntryNumber('8. Smith J. A study of glare. 2019.')).toBe(8);
  });

  it('is null for an unnumbered entry', () => {
    expect(referenceEntryNumber('Rea MS. Lighting Handbook. New York: IES; 2011.')).toBeNull();
    expect(referenceEntryNumber('')).toBeNull();
  });
});

// ─── DO33: LS-1 definitions ───────────────────────────────────────────────────

describe('sanitizeDefinitionHtml', () => {
  it('keeps the formatting a definition is published with', () => {
    const out = sanitizeDefinitionHtml(
      '<p>[4.1] The characteristic of <strong>light</strong> by which an observer can distinguish. '
      + 'See <em>light source color</em>.</p>'
    );
    expect(out).toContain('<strong>light</strong>');
    expect(out).toContain('<em>light source color</em>');
  });

  it('keeps the inline-math span the glossary uses', () => {
    const out = sanitizeDefinitionHtml('<p><span class="wp-katex-eq">α = Φa/Φi</span></p>');
    expect(out).toContain('class="wp-katex-eq"');
    expect(out).toContain('α = Φa/Φi');
  });

  it('drops scripts entirely, content and all', () => {
    const out = sanitizeDefinitionHtml('<p>ok</p><script>alert(1)</script>');
    expect(out).toBe('<p>ok</p>');
    expect(out).not.toContain('alert');
  });

  it('strips event handlers, styles and unknown attributes', () => {
    const out = sanitizeDefinitionHtml('<p onclick="steal()" style="color:red" class="x">text</p>');
    expect(out).toBe('<p>text</p>');
  });

  it('refuses javascript: and data:text URLs but keeps real links and images', () => {
    expect(sanitizeDefinitionHtml('<a href="javascript:alert(1)">x</a>')).toBe('<a>x</a>');
    expect(sanitizeDefinitionHtml('<img src="data:text/html,<script>" alt="x" />')).toBe('<img alt="x" />');
    const ok = sanitizeDefinitionHtml('<a href="https://ies.org/definitions/color/">color</a>');
    expect(ok).toContain('href="https://ies.org/definitions/color/"');
    expect(ok).toContain('rel="noopener nofollow"');
  });

  it('unwraps disallowed tags but never loses their text', () => {
    expect(sanitizeDefinitionHtml('<div><h3>Heading</h3><p>body</p></div>'))
      .toBe('Heading<p>body</p>');
  });
});

describe('definitionPlainText / definitionClause', () => {
  it('renders text without fusing words across block boundaries', () => {
    expect(definitionPlainText('<p>first</p><p>second</p>')).toBe('first second');
    expect(definitionPlainText('a<br>b')).toBe('a b');
  });

  it('decodes the entities the glossary emits', () => {
    expect(definitionPlainText('<p>Abbe&#8217;s law &amp; friends</p>')).toBe('Abbe’s law & friends');
  });

  it('reads the LS-1 clause number', () => {
    expect(definitionClause('[5.9.9.12] Change in motion perception…')).toBe('5.9.9.12');
    expect(definitionClause('[4.1] The characteristic of light')).toBe('4.1');
    expect(definitionClause('No clause here')).toBeNull();
  });
});

describe('normalizeGlossaryPost', () => {
  const post = {
    slug: 'color',
    link: 'https://ies.org/definitions/color/',
    title: { rendered: 'color' },
    content: { rendered: '<p>[4.1] The characteristic of <strong>light</strong> by which an observer can distinguish.</p>' },
  };

  it('produces the record D1 and Vectorize both consume', () => {
    const out = normalizeGlossaryPost(post);
    expect(out.slug).toBe('color');
    expect(out.term).toBe('color');
    expect(out.clause).toBe('4.1');
    expect(out.html).toContain('<strong>light</strong>');
    expect(out.text.startsWith('[4.1] The characteristic of light')).toBe(true);
    expect(out.sourceUrl).toBe('https://ies.org/definitions/color/');
  });

  it('rejects a post with no usable content', () => {
    expect(normalizeGlossaryPost({ slug: 'x', title: { rendered: 'x' }, content: { rendered: '' } })).toBeNull();
    expect(normalizeGlossaryPost({ title: { rendered: 'x' }, content: { rendered: '<p>y z</p>' } })).toBeNull();
  });
});

describe('buildDefinitionEmbedText', () => {
  it('weights the term so a bare-term query lands on its own definition', () => {
    const text = buildDefinitionEmbedText({ term: 'color', text: '[4.1] The characteristic of light.' });
    expect(text.startsWith('color. color.')).toBe(true);
    // The clause number carries no semantic signal and would collide with
    // section references throughout the corpus.
    expect(text).not.toContain('[4.1]');
  });
});

describe('normalizeContentTypes with definitions', () => {
  it('accepts definitions as a content type', () => {
    expect([...normalizeContentTypes({ content_types: ['definitions'] }, 'color')])
      .toEqual(['definitions']);
  });

  it('a definition-seeking query replaces the DEFAULT selection', () => {
    expect([...normalizeContentTypes({}, 'define mesopic adaptation')]).toEqual(['definitions']);
  });

  it('leaves a hand-picked selection alone and just adds definitions', () => {
    const ct = normalizeContentTypes({ content_types: ['tables'] }, 'what does veiling reflection mean?');
    expect(ct.has('tables')).toBe(true);
    expect(ct.has('definitions')).toBe(true);
  });

  it('does not trigger on descriptive uses of the word', () => {
    expect(normalizeContentTypes({}, 'high-definition display luminance').has('definitions')).toBe(false);
  });
});

describe('definitionSearchTerm', () => {
  it('returns a bare term as-is', () => {
    expect(definitionSearchTerm('Color')).toBe('color');
    expect(definitionSearchTerm('mesopic adaptation')).toBe('mesopic adaptation');
  });

  it('strips the lookup phrasing', () => {
    expect(definitionSearchTerm('define illuminance')).toBe('illuminance');
    expect(definitionSearchTerm('definition of luminous flux')).toBe('luminous flux');
    expect(definitionSearchTerm('what does veiling reflection mean?')).toBe('veiling reflection');
  });

  it('drops the standard qualifier', () => {
    expect(definitionSearchTerm('definition of glare per ANSI/IES LS-1-25')).toBe('glare');
  });

  it('gives up on anything sentence-length', () => {
    expect(definitionSearchTerm('how bright should a skating rink be for competitive play')).toBeNull();
    expect(definitionSearchTerm('a')).toBeNull();
  });
});
