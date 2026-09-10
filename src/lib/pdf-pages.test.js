/**
 * PDF page reconstruction (src/lib/pdf-pages.js) — the pure half of the parser,
 * extracted so the staff-dashboard ingest can rebuild pages in the Worker from
 * raw pdfjs items the browser ships. These tests pin the behaviours the whole
 * extraction stack depends on: line building with spacing, header/footer
 * stripping, and superscript reference-marker detection.
 */

import { describe, it, expect } from 'vitest';
import {
  buildPageFromRaw,
  cleanDocMeta,
  detectHeadersFootersFromRaw,
  detectSuperscriptMarks,
  joinItemsWithSpacing,
} from './pdf-pages.js';

/** A synthetic pdfjs text item: transform = [fs, 0, 0, fs, x, yFromBottom]. */
function item(str, x, yFromBottom, fontSize = 10, extra = {}) {
  return { str, transform: [fontSize, 0, 0, fontSize, x, yFromBottom], fontName: 'F1', width: str.length * fontSize * 0.5, ...extra };
}

const VIEW = [0, 0, 600, 800]; // width 600, height 800

describe('buildPageFromRaw', () => {
  it('reconstructs top-to-bottom lines with the page geometry', () => {
    const raw = {
      number: 3,
      view: VIEW,
      items: [
        item('Second line', 50, 700),  // y (top-origin) = 100
        item('First line', 50, 750),   // y = 50
      ],
    };
    const page = buildPageFromRaw(raw, new Set());
    expect(page.number).toBe(3);
    expect(page.width).toBe(600);
    expect(page.height).toBe(800);
    expect(page.lines.map(l => l.text)).toEqual(['First line', 'Second line']);
    expect(page.text).toBe('First line\nSecond line');
  });

  it('strips lines that match the header/footer set (case-insensitive)', () => {
    const raw = {
      number: 1,
      view: VIEW,
      items: [item('ANSI/IES RP-9-20', 50, 790), item('Body text here', 50, 400)],
    };
    const page = buildPageFromRaw(raw, new Set(['ansi/ies rp-9-20']));
    expect(page.text).toBe('Body text here');
  });

  it('joins same-line items and records bold from the font name', () => {
    const raw = {
      number: 1,
      view: VIEW,
      items: [
        item('3.1', 50, 700, 12, { fontName: 'Helvetica-Bold' }),
        item('Design Guide', 80, 700, 12, { fontName: 'Helvetica-Bold' }),
      ],
    };
    const page = buildPageFromRaw(raw, new Set());
    expect(page.lines).toHaveLength(1);
    expect(page.lines[0].text).toBe('3.1 Design Guide');
    expect(page.lines[0].bold).toBe(true);
  });
});

describe('joinItemsWithSpacing', () => {
  it('inserts a space across a real gap and none within a touching run', () => {
    // "Client" ends at x=10+6*10*0.5=40; next item at 44 is a 4pt gap > 25% of
    // fontSize 10 → space. The third starts exactly at the second's end → none.
    const a = { str: 'Client', x: 10, width: 30, fontSize: 10 };
    const b = { str: 'preferences;', x: 44, width: 60, fontSize: 10 };
    const c = { str: 'social', x: 104, width: 30, fontSize: 10 };
    expect(joinItemsWithSpacing([a, b, c])).toBe('Client preferences;social');
  });
});

describe('detectSuperscriptMarks', () => {
  it('finds a raised, smaller digit and reads a comma list', () => {
    const group = [
      { str: 'available in CIE 015:2018.', x: 50, y: 100, fontSize: 10 },
      { str: '3,4', x: 180, y: 96, fontSize: 7 },            // smaller AND raised
      { str: 'The first five', x: 195, y: 100, fontSize: 10 },
    ];
    expect(detectSuperscriptMarks(group)).toEqual([3, 4]);
  });

  it('ignores a body-size digit run (a year is not a marker)', () => {
    const group = [
      { str: 'published in', x: 50, y: 100, fontSize: 10 },
      { str: '2018', x: 120, y: 100, fontSize: 10 },
    ];
    expect(detectSuperscriptMarks(group)).toEqual([]);
  });
});

describe('detectHeadersFootersFromRaw', () => {
  it('flags a string repeating in the header zone across sampled pages', () => {
    const pages = [1, 2, 3, 4, 5].map(n => ({
      number: n,
      view: VIEW,
      items: [
        item('ANSI/IES RP-9-20', 50, 790),                 // top 8% zone on every page
        item(`Unique body text for page ${n}`, 50, 400),   // middle — never flagged
      ],
    }));
    const set = detectHeadersFootersFromRaw(pages);
    expect(set.has('ansi/ies rp-9-20')).toBe(true);
    expect([...set].some(s => s.includes('unique body text'))).toBe(false);
  });

  it('handles a short document without throwing', () => {
    expect(detectHeadersFootersFromRaw([{ number: 1, view: VIEW, items: [] }]).size).toBe(0);
  });
});

describe('cleanDocMeta', () => {
  it('cleans control characters and reads the year off a PDF date', () => {
    const meta = cleanDocMeta({
      Title: 'RP124',
      Author: '  IES  ',
      CreationDate: 'D:20240101120000',
    });
    expect(meta.title).toBe('RP124');
    expect(meta.author).toBe('IES');
    expect(meta.year).toBe('2024');
  });

  it('is null-safe (a document with no metadata is a real state)', () => {
    expect(cleanDocMeta(null)).toEqual({ title: '', author: '', subject: '', keywords: '', year: null });
  });
});
