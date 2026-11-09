/**
 * Printed page numbers in search results (Dan, Teams 2026-11-06: "P.42 here
 * should print as 'p. 33' for the user in AI Guide and Result Cards").
 */

import { describe, it, expect } from 'vitest';
import { attachPageLabels, buildSectionLinkMap, withPageLabelInfo } from './search.ts';
import { extractGuideCitations } from '../lib/curation';

// RP-1-24: nine lettered front-matter pages, then 1…72 (its real /PageLabels).
const RP1_LABELS = [...'abcdefghi'.split(''), ...Array.from({ length: 72 }, (_, i) => String(i + 1))];

function envWith(labelsById) {
  return {
    DB: {
      prepare(sql) {
        return {
          bind(...ids) {
            return {
              async all() {
                if (!/page_labels_json/.test(sql)) return { results: [] };
                return {
                  results: ids.filter(id => labelsById[id])
                    .map(id => ({ id, page_labels_json: JSON.stringify(labelsById[id]) })),
                };
              },
            };
          },
        };
      },
    },
  };
}

function excerptResult(standard, page, extra = {}) {
  const excerpt = { text: 'Luminance ratios…', pageNumber: page, section: '5.3', chunkType: 'text',
    vitriumLink: `https://lighting.ies.org/abc#page=${page}` };
  return {
    resultType: 'excerpt',
    application: { standard, standardFull: `ANSI/IES ${standard}` },
    relevanceScore: 0.8,
    excerpt,
    excerpts: [excerpt],
    citation: `ANSI/IES ${standard} Lighting Office Spaces, p. ${page}`,
    citationName: `ANSI/IES ${standard} Lighting Office Spaces`,
    citationPage: page,
    vitriumLink: `https://lighting.ies.org/abc#page=${page}`,
    relatedApplications: [],
    ...extra,
  };
}

describe('attachPageLabels', () => {
  it("prints Dan's example: PDF page 42 of RP-1-24 is p. 33", async () => {
    const r = excerptResult('RP-1-24', 42, {
      assets: [{ kind: 'table', label: 'Table C-1', caption: 'Sound Absorption Coefficients', page: 71 }],
      referenceMarkers: [{ standard: 'RP-1-24', standardFull: null, count: 1, pageNumber: 42, url: null }],
    });
    await attachPageLabels(envWith({ 'RP-1-24': RP1_LABELS }), [r]);
    expect(r.excerpt.pageLabel).toBe('33');
    expect(r.excerpt.pageNumber).toBe(42);                 // the link keeps the index
    expect(r.citationPageLabel).toBe('33');
    expect(r.citation).toBe('ANSI/IES RP-1-24 Lighting Office Spaces, p. 33');
    expect(r.assets[0].pageLabel).toBe('62');               // Table C-1, as printed
    expect(r.referenceMarkers[0].pageLabel).toBe('33');
  });

  it('leaves a standard without labels exactly as it was', async () => {
    const r = excerptResult('TM-35-19', 12);
    await attachPageLabels(envWith({}), [r]);
    expect(r.excerpt.pageLabel).toBeUndefined();
    expect(r.citation).toBe('ANSI/IES TM-35-19 Lighting Office Spaces, p. 12');
  });

  it('fails open when the column does not exist yet', async () => {
    const env = { DB: { prepare() { throw new Error('no such column: page_labels_json'); } } };
    const r = excerptResult('RP-1-24', 42);
    await attachPageLabels(env, [r]);
    expect(r.excerpt.pageLabel).toBeUndefined();
  });
});

describe('Guide page links follow the printed page', () => {
  it('keys the link map by the printed page and flags the offset', async () => {
    const r = excerptResult('RP-1-24', 42);
    const env = envWith({ 'RP-1-24': RP1_LABELS });
    const index = await attachPageLabels(env, [r]);
    const map = await withPageLabelInfo(env, buildSectionLinkMap([r]), index);
    expect(map['RP-1-24'].pages['33']).toBe('https://lighting.ies.org/abc#page=42');
    expect(map['RP-1-24'].pages['42']).toBeUndefined();
    expect(map['RP-1-24'].labeled).toBe(true);
    expect(map['RP-1-24'].pageOffset).toBe(9);
  });

  it('counts a Guide citation of the printed page as citing the card', async () => {
    // Two cards of one standard: only the one on printed p. 33 is the citation.
    const results = [excerptResult('RP-1-24', 20), excerptResult('RP-1-24', 42)];
    await attachPageLabels(envWith({ 'RP-1-24': RP1_LABELS }), results);
    const cited = extractGuideCitations('ANSI/IES RP-1-24 addresses ratios in Figure 5-11, p. 33.', results);
    expect(cited.has(1)).toBe(true);
    expect(cited.has(0)).toBe(false);
  });
});
