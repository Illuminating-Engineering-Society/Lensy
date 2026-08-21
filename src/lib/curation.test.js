/**
 * AI curation of the result-card order (client request, 2026-08-20).
 *
 * "Promote the cards the Guide actually cites … have the rest of the cards
 *  also curated by the same logic … If they disable 'AI Guide' then they lose
 *  that curation."
 *
 * The gating itself (Guide off / version comparison → no curation) lives in
 * handleSearch; these tests cover the pure pieces: the rank parser, the
 * citation extractor, and the assembly rules — including the client
 * invariants curation must never undo (definition term-matches stay first).
 */

import { describe, it, expect } from 'vitest';
import {
  buildRerankPrompt, describeForRerank, parseRankOrder,
  extractGuideCitations, curateResults, PROMOTED_MAX, RERANK_MAX,
} from './curation';

const doc = (std, section, page, over = {}) => ({
  resultType: 'excerpt',
  relevanceScore: 0.7,
  citation: `ANSI/IES ${std}, p. ${page}`,
  citationName: `ANSI/IES ${std} Some Title`,
  citationPage: page,
  application: { standard: std, standardFull: `ANSI/IES ${std}` },
  excerpt: { text: `Passage from §${section}.`, section, pageNumber: page },
  ...over,
});

const definition = (score) => ({
  resultType: 'definition',
  relevanceScore: score,
  citationName: 'ANSI/IES LS-1-25 Lighting Science',
  citationPage: null,
  application: { standard: 'LS-1-25', standardFull: 'ANSI/IES LS-1-25' },
  definition: { slug: 'color', term: 'color', clause: '4.1', html: '<p>x</p>', sourceUrl: null },
  excerpt: { text: 'The characteristic of light.' },
});

// ─── parseRankOrder ───────────────────────────────────────────────────────────

describe('parseRankOrder', () => {
  it('reads a clean JSON array into 0-based indices', () => {
    expect(parseRankOrder('[3, 1, 2]', 3)).toEqual([2, 0, 1]);
  });

  it('finds the array inside chatter and tolerates partial coverage', () => {
    expect(parseRankOrder('Here is the ranking: [2, 4, 1] — hope that helps', 5))
      .toEqual([1, 3, 0]);
  });

  it('drops out-of-range and duplicate entries', () => {
    expect(parseRankOrder('[1, 9, 2, 2, 0, 3]', 4)).toEqual([0, 1, 2]);
  });

  it('refuses rankings too small to trust, and non-arrays', () => {
    expect(parseRankOrder('[1]', 10)).toBe(null);
    expect(parseRankOrder('the best result is number 3', 10)).toBe(null);
    expect(parseRankOrder('', 10)).toBe(null);
    expect(parseRankOrder(null, 10)).toBe(null);
  });

  it('accepts a complete ranking of a tiny pool', () => {
    expect(parseRankOrder('[2, 1]', 2)).toEqual([1, 0]);
  });
});

// ─── extractGuideCitations ────────────────────────────────────────────────────

describe('extractGuideCitations', () => {
  const results = [
    doc('RP-8-25+E2', '4.2', 21),
    doc('RP-8-25+E2', '7.1', 63),
    doc('RP-6-24', '5.4', 40),
    doc('RP-1-24', '3.3', 12),
  ];

  it('cites the result whose section the Guide names', () => {
    const cited = extractGuideCitations(
      'According to ANSI/IES RP-8-25+E2, Section 7.1, parking structures require uniformity.',
      results,
    );
    expect([...cited]).toEqual([1]);
  });

  it('cites by page when the prose names one', () => {
    const cited = extractGuideCitations(
      'ANSI/IES RP-6-24 (p. 40) treats recreational courts separately.',
      results,
    );
    expect(cited.has(2)).toBe(true);
  });

  it('falls back to the best-ranked card of a standard named without a locator', () => {
    const cited = extractGuideCitations(
      'RP-8-25+E2 governs roadway and parking lighting design.',
      results,
    );
    expect([...cited]).toEqual([0]);
  });

  it('cites nothing for standards the Guide never names', () => {
    const cited = extractGuideCitations('General guidance without any designation.', results);
    expect(cited.size).toBe(0);
  });

  it('does not let a section number match inside a longer number', () => {
    const cited = extractGuideCitations(
      'ANSI/IES RP-8-25+E2, Section 4.2.1 covers a narrower case.',
      results,
    );
    // §4.2 must not claim the "4.2.1" mention; the designation fallback stands in.
    expect(cited.has(0)).toBe(true);
    expect(cited.has(1)).toBe(false);
  });

  it('is empty for empty text or results', () => {
    expect(extractGuideCitations('', results).size).toBe(0);
    expect(extractGuideCitations('RP-8-25+E2', []).size).toBe(0);
  });
});

// ─── curateResults ────────────────────────────────────────────────────────────

describe('curateResults', () => {
  it('applies the rerank order and reports the change', () => {
    const results = [doc('RP-1-24', '1.1', 1), doc('RP-6-24', '2.2', 2), doc('RP-8-25+E2', '3.3', 3)];
    const out = curateResults(results, { order: [2, 0, 1], cited: new Set() });
    expect(out.results.map(r => r.application.standard))
      .toEqual(['RP-8-25+E2', 'RP-1-24', 'RP-6-24']);
    expect(out.changed).toBe(true);
    expect(out.promoted).toBe(0);
  });

  it('promotes Guide-cited results above the rerank order and flags them', () => {
    const results = [doc('RP-1-24', '1.1', 1), doc('RP-6-24', '2.2', 2), doc('RP-8-25+E2', '3.3', 3)];
    const out = curateResults(results, { order: [1, 0, 2], cited: new Set([2]) });
    expect(out.results.map(r => r.application.standard))
      .toEqual(['RP-8-25+E2', 'RP-6-24', 'RP-1-24']);
    expect(out.results[0].citedByGuide).toBe(true);
    expect(out.results[1].citedByGuide).toBeUndefined();
    expect(out.promoted).toBe(1);
  });

  it('keeps a definition term-match pinned first — DO33 outranks any curation', () => {
    const results = [definition(1), doc('RP-6-24', '2.2', 2), doc('RP-8-25+E2', '3.3', 3)];
    const out = curateResults(results, { order: [2, 1, 0], cited: new Set([2]) });
    expect(out.results[0].resultType).toBe('definition');
    expect(out.results[1].application.standard).toBe('RP-8-25+E2');
  });

  it('curates a merely-semantic definition match like any other result', () => {
    const results = [definition(0.6), doc('RP-6-24', '2.2', 2)];
    const out = curateResults(results, { order: [1, 0], cited: new Set() });
    expect(out.results[0].application.standard).toBe('RP-6-24');
  });

  it('caps the promotion band and leaves the overflow in ranked position, still badged', () => {
    const results = Array.from({ length: PROMOTED_MAX + 3 }, (_, i) => doc('RP-8-25+E2', `9.${i}`, 10 + i));
    const cited = new Set(results.map((_, i) => i));
    const out = curateResults(results, { order: null, cited });
    expect(out.promoted).toBe(PROMOTED_MAX);
    expect(out.results.every(r => r.citedByGuide)).toBe(true);
  });

  it('is the identity when there is nothing to apply', () => {
    const results = [doc('RP-1-24', '1.1', 1), doc('RP-6-24', '2.2', 2)];
    const out = curateResults(results, { order: null, cited: new Set() });
    expect(out.results.map(r => r.application.standard)).toEqual(['RP-1-24', 'RP-6-24']);
    expect(out.changed).toBe(false);
    expect(out.promoted).toBe(0);
  });

  it('appends results the (partial) rerank never mentioned, in their original order', () => {
    const results = [doc('A-1-20', '1', 1), doc('B-1-20', '2', 2), doc('C-1-20', '3', 3), doc('D-1-20', '4', 4)];
    const out = curateResults(results, { order: [2], cited: new Set() });
    expect(out.results.map(r => r.application.standard))
      .toEqual(['C-1-20', 'A-1-20', 'B-1-20', 'D-1-20']);
  });
});

// ─── rerank prompt ────────────────────────────────────────────────────────────

describe('rerank prompt', () => {
  it('describes each result compactly with its number, kind and standard', () => {
    const line = describeForRerank(doc('RP-8-25+E2', '4.2', 21), 4);
    expect(line).toContain('[5]');
    expect(line).toContain('Document passage');
    expect(line).toContain('RP-8-25+E2');
    expect(line).toContain('§4.2');
  });

  it('caps the pool it describes at RERANK_MAX', () => {
    const many = Array.from({ length: RERANK_MAX + 10 }, (_, i) => doc('RP-1-24', `1.${i}`, i + 1));
    const prompt = buildRerankPrompt('office lighting', many);
    expect(prompt).toContain(`[${RERANK_MAX}]`);
    expect(prompt).not.toContain(`[${RERANK_MAX + 1}]`);
  });

  it('demands a JSON-array-only answer', () => {
    const prompt = buildRerankPrompt('parking', [doc('RP-8-25+E2', '4.2', 21), doc('RP-6-24', '5.4', 40)]);
    expect(prompt).toContain('ONLY a JSON array');
    expect(prompt).toContain('"parking"');
  });
});
