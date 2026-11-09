/**
 * Printed page numbers (Dan, Teams 2026-11-06). Every label array below is the
 * shape pdfjs getPageLabels() returned for the PDF named beside it.
 */

import { describe, it, expect } from 'vitest';
import {
  cleanPageLabels, parsePageLabels, pageLabelFor, labelToPageMap, pageLabelOffset,
} from './page-labels.js';

const front = (n) => 'abcdefghijklmnopqrstuvwxyz'.slice(0, n).split('');
const arabic = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => String(from + i));

// RP-1-24: nine lettered front-matter pages, then 1…72.
const RP1 = [...front(9), ...arabic(1, 72)];

describe('cleanPageLabels', () => {
  it('keeps a front-matter + folio layout (RP-1-24)', () => {
    const labels = cleanPageLabels(RP1, 81);
    expect(labels).toHaveLength(81);
    expect(pageLabelFor(labels, 42)).toBe('33');   // Dan's example
    expect(pageLabelFor(labels, 71)).toBe('62');   // Table C-1 (DO086)
  });

  it("keeps RP-8's chapter-paged print", () => {
    const labels = cleanPageLabels(['a', 'b', 'I', 'II', '1a', '1-1', '1-2', '2a', '2-1', 'VII', 'b']);
    expect(labels).not.toBeNull();
  });

  it('refuses Word section labels', () => {
    expect(cleanPageLabels(['Sec1:3', 'Sec1:4', 'Sec1:5'])).toBeNull();
  });

  it('refuses arabic labels that do not count up (RP-20-14)', () => {
    expect(cleanPageLabels(['a', '51', '51', '51', '1', '2'])).toBeNull();
  });

  it('refuses mostly-repeated labels (LM-74-05)', () => {
    expect(cleanPageLabels(Array(20).fill('III'))).toBeNull();
  });

  it('refuses a count that does not match the document', () => {
    expect(cleanPageLabels(RP1, 80)).toBeNull();
  });

  it('stores nothing when the labels are the index anyway', () => {
    expect(cleanPageLabels(arabic(1, 10), 10)).toBeNull();
  });

  it('stores nothing without labels', () => {
    expect(cleanPageLabels(null)).toBeNull();
    expect(cleanPageLabels([])).toBeNull();
  });
});

describe('pageLabelFor / parsePageLabels', () => {
  it('reads the stored column', () => {
    expect(parsePageLabels(JSON.stringify(RP1))).toEqual(RP1);
    expect(parsePageLabels('nope')).toBeNull();
    expect(parsePageLabels(null)).toBeNull();
  });

  it('answers null outside the document or without labels', () => {
    expect(pageLabelFor(RP1, 0)).toBeNull();
    expect(pageLabelFor(RP1, 82)).toBeNull();
    expect(pageLabelFor(null, 3)).toBeNull();
  });
});

describe('labelToPageMap', () => {
  it('maps each printed label back to its index', () => {
    const map = labelToPageMap(RP1);
    expect(map.get('33')).toBe(42);
    expect(map.get('a')).toBe(1);
  });

  it('leaves out a label two pages share (RP-8-25+E2 prints "b" twice)', () => {
    const map = labelToPageMap(['a', 'b', '1', '2', 'b']);
    expect(map.has('b')).toBe(false);
    expect(map.get('2')).toBe(4);
  });
});

describe('pageLabelOffset', () => {
  it('is the constant index − folio', () => {
    expect(pageLabelOffset(RP1)).toBe(9);
  });

  it('is null for chapter-paged print or no arabic labels', () => {
    expect(pageLabelOffset(['a', '1-1', '1-2', '2-1'])).toBeNull();
    expect(pageLabelOffset(['a', '1', '2', 'b', '1', '2'])).toBeNull();
    expect(pageLabelOffset(null)).toBeNull();
  });
});

describe('cleanPageLabels — RP-8 annex covers and unlabelled back covers', () => {
  it('keeps "Aa"/"Ba" annex cover labels (RP-8-25+E2)', () => {
    expect(cleanPageLabels(['a', 'b', '1a', '1-1', 'Aa', 'Ab', 'A-1', 'Ba', 'B-1', 'GLa', 'GL-1', 'GL-2'])).not.toBeNull();
  });

  it('tolerates an empty back-cover label, which reads as no label', () => {
    const labels = cleanPageLabels(['a', 'b', '1', '2', '3', '4', '5', '6', '7', '8', '']);
    expect(labels).not.toBeNull();
    expect(pageLabelFor(labels, 11)).toBeNull();
    expect(pageLabelFor(labels, 3)).toBe('1');
  });
});
