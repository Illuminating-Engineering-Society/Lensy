/**
 * Manuscript → PDF page alignment (src/lib/page-align.js).
 *
 * What matters here: the normalization erases exactly the differences two
 * extractions of the SAME document produce (line-break hyphenation, ligatures,
 * whitespace, punctuation eaten by subsetted fonts); the search is monotonic,
 * so a phrase repeated later in the document cannot steal a match; a chunk
 * that cannot be located inherits a neighbour's page and is COUNTED — the
 * body-inherited fraction is the drift gate the Worker enforces; and the
 * uncovered-pages list is the other direction of "not losing content".
 */

import { describe, it, expect } from 'vitest';
import {
  normalizeAlignText, buildPageIndex, pageAt,
  alignChunksToPdfPages, alignSequenceToPages,
} from './page-align.js';

const page = (number, text) => ({ number, text });
const chunk = (text, type = 'text', section = null) => ({ text, section, type, wordCount: text.split(/\s+/).length });

describe('normalizeAlignText', () => {
  it('erases hyphenation, whitespace and punctuation differences', () => {
    // PDF line break: "illumi-\nnance"; DOCX: "illuminance".
    expect(normalizeAlignText('illumi-\nnance at the task plane'))
      .toBe(normalizeAlignText('illuminance at the task plane'));
    // Subsetted-font control codes on the PDF side vanish too.
    expect(normalizeAlignText('LP220')).toBe(normalizeAlignText('LP-2-20'));
  });
});

describe('buildPageIndex / pageAt', () => {
  it('maps stream positions back to page numbers', () => {
    const index = buildPageIndex([page(1, 'aaaa bbbb'), page(2, 'cccc dddd'), page(3, 'eeee')]);
    expect(pageAt(index, 0)).toBe(1);
    expect(pageAt(index, 8)).toBe(2);   // 'aaaabbbb' is 8 chars; position 8 opens page 2
    expect(pageAt(index, 16)).toBe(3);
  });
});

describe('alignChunksToPdfPages', () => {
  const long = (prefix, n = 20) => Array.from({ length: n }, (_, i) => `${prefix}${i}`).join(' ');

  it('locates chunks on their pages, in document order', () => {
    const pages = [
      page(1, `Front matter boilerplate. ${long('cover')}`),
      page(2, `1 Scope\n${long('scope')}`),
      page(3, `2 Definitions\n${long('def')}`),
    ];
    const chunks = [
      chunk(`1 Scope ${long('scope')}`, 'text', '1'),
      chunk(`2 Definitions ${long('def')}`, 'text', '2'),
    ];
    const { chunks: aligned, report } = alignChunksToPdfPages(chunks, pages);
    expect(aligned.map(c => c.pageNumber)).toEqual([2, 3]);
    expect(aligned.every(c => c.pageConfidence === 'exact')).toBe(true);
    expect(report.located).toBe(2);
    expect(report.inherited).toBe(0);
    expect(report.bodyInheritedFraction).toBe(0);
  });

  it('survives hyphenation and whitespace differences between the two extractions', () => {
    const pages = [
      page(1, 'The recommended illumi-\nnance for circulation areas depends on the adjacent task areas and the adaptation state of occupants moving between them.'),
    ];
    const chunks = [
      chunk('The recommended illuminance for circulation areas depends on the adjacent task areas and the adaptation state of occupants moving between them.'),
    ];
    const { chunks: aligned } = alignChunksToPdfPages(chunks, pages);
    expect(aligned[0].pageNumber).toBe(1);
    expect(aligned[0].pageConfidence).toBe('exact');
  });

  it('is monotonic: a phrase repeated later cannot steal the match', () => {
    const marker = 'general lighting requirements apply to every space described in this chapter without exception';
    const pages = [
      page(1, `${marker} first occurrence tail ${'pad '.repeat(30)}`),
      page(2, `${marker} second occurrence tail ${'pad '.repeat(30)}`),
    ];
    const chunks = [
      chunk(`${marker} first occurrence tail`),
      chunk(`${marker} second occurrence tail`),
    ];
    const { chunks: aligned } = alignChunksToPdfPages(chunks, pages);
    expect(aligned[0].pageNumber).toBe(1);
    expect(aligned[1].pageNumber).toBe(2);
  });

  it('searches the next chunk from the PREVIOUS chunk start, so overlap carry still matches', () => {
    const words = Array.from({ length: 60 }, (_, i) => `token${i}`).join(' ');
    const pages = [page(1, `4 Design\n${words}`)];
    const first = chunk(`4 Design ${words}`);
    // A continuation chunk opens with the marker plus the previous chunk's tail.
    const continuation = chunk(`[Section 4] ${Array.from({ length: 15 }, (_, i) => `token${45 + i}`).join(' ')}`);
    const { chunks: aligned } = alignChunksToPdfPages([first, continuation], pages);
    expect(aligned[1].pageNumber).toBe(1);
    expect(aligned[1].pageConfidence).not.toBe('inherited');
  });

  it('counts unlocatable chunks as inherited, gives them a neighbour page, and reports drift', () => {
    const pages = [
      page(1, `1 Scope ${'known content that both files share '.repeat(4)}`),
    ];
    const chunks = [
      chunk(`1 Scope ${'known content that both files share '.repeat(4)}`),
      chunk('completely different draft text that the published PDF never contained anywhere at all'),
    ];
    const { chunks: aligned, report } = alignChunksToPdfPages(chunks, pages);
    expect(aligned[1].pageConfidence).toBe('inherited');
    expect(aligned[1].pageNumber).toBe(1); // neighbour's page, never null
    expect(report.inherited).toBe(1);
    expect(report.bodyInheritedFraction).toBe(0.5);
    expect(report.unmatchedSamples[0].opening).toContain('completely different draft text');
  });

  it('drift counts PROSE only: a table chunk that cannot align does not trip the gate', () => {
    const pages = [page(1, `1 Scope ${'shared prose both sides carry '.repeat(5)}`)];
    const chunks = [
      chunk(`1 Scope ${'shared prose both sides carry '.repeat(5)}`),
      chunk('Application  100 lux  30 lux\nOffice  300 lux  75 lux\nCorridor 100 50 20 10 more cells here', 'table'),
    ];
    const { report } = alignChunksToPdfPages(chunks, pages);
    expect(report.inherited).toBe(1);
    expect(report.bodyTotal).toBe(1);
    expect(report.bodyInheritedFraction).toBe(0);
  });

  it('reports substantial PDF pages that no chunk covered, ignoring front matter', () => {
    const filler = 'substantial page content with plenty of normalized characters to count '.repeat(4);
    const pages = [
      page(1, `FRONT MATTER ${filler}`),          // before the first match: expected uncovered
      page(2, `1 Scope ${filler}`),
      page(3, `ANNEX ONLY IN PDF ${filler}`),      // content the manuscript never had
    ];
    const chunks = [chunk(`1 Scope ${filler}`)];
    const { report } = alignChunksToPdfPages(chunks, pages);
    expect(report.uncoveredPages).toEqual([3]);
  });
});

describe('alignSequenceToPages', () => {
  it('floors the search at startPos, so a caption is found at the figure and not in a list of figures', () => {
    const caption = 'Table 4-1 Sound Absorption Coefficients for Various Materials';
    const pages = [
      page(1, `List of Tables ${caption} 18 more front matter padding text`),
      page(2, `1 Scope body content starts here with plenty of words to anchor on for the opening chunk`),
      page(3, `${caption}\nrows of the actual table follow here`),
    ];
    const index = buildPageIndex(pages);
    const bodyStart = index.pageStarts[1].start;
    const [hit] = alignSequenceToPages(index, [caption], { startPos: bodyStart });
    expect(hit.page).toBe(3);
  });

  it('returns null for text it cannot vouch for', () => {
    const index = buildPageIndex([page(1, 'some content here')]);
    const [miss, tooShort] = alignSequenceToPages(index, ['entirely absent caption text of length', 'ab'], {});
    expect(miss).toBe(null);
    expect(tooShort).toBe(null);
  });
});
