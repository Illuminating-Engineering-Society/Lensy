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

// Client 11/12/26 #3: RP-8-25+E2 p. 385 was read as two text columns, which
// separated every Vertical cell from its row.
describe('detectColumns — a criteria table is one column', () => {
  const WIDE = [0, 0, 792, 612];
  const cell = (str, x, y) => item(str, x, y, 8);
  // Rows of a table whose Horizontal block ends near x=470 and whose Vertical
  // block starts at x=520: a white band at the centre of the page.
  const tableRows = (withHeaders) => {
    const items = [];
    if (withHeaders) {
      items.push(cell('APPLICATION TASK/AREA', 70, 560), cell('Lux @ m (Fc @ ft)', 292, 560));
      items.push(cell('Lux @ m (Fc @ ft)', 520, 560), cell('Min Ratio Basis', 640, 560));
    }
    for (let i = 0; i < 12; i++) {
      const y = 540 - i * 12;
      items.push(cell(`Application ${i}`, 88, y), cell('General area', 200, y));
      items.push(cell('10 lx @ 0.00 m', 292, y), cell('1 fc @ 0.0 ft', 360, y), cell('Min 15:1', 420, y));
      items.push(cell('5 lx @ 1.50 m', 520, y), cell('1 fc @ 5.0 ft', 590, y), cell('Min 15:1', 650, y));
    }
    return items;
  };

  it('keeps each row on one line when the header vocabulary is on both sides of the gap', () => {
    const page = buildPageFromRaw({ number: 385, view: WIDE, items: tableRows(true) }, new Set());
    const row = page.lines.find(l => l.text.startsWith('Application 0'));
    expect(row.text).toBe('Application 0 General area 10 lx @ 0.00 m 1 fc @ 0.0 ft Min 15:1 5 lx @ 1.50 m 1 fc @ 5.0 ft Min 15:1');
  });

  it('still splits a page whose two sides are not one table', () => {
    const page = buildPageFromRaw({ number: 12, view: WIDE, items: tableRows(false) }, new Set());
    expect(page.lines.find(l => l.text.startsWith('Application 0')).text).toBe('Application 0 General area 10 lx @ 0.00 m 1 fc @ 0.0 ft Min 15:1');
  });

  it('records where each run of a value line starts, and only on such lines', () => {
    const page = buildPageFromRaw({ number: 385, view: WIDE, items: tableRows(true) }, new Set());
    const row = page.lines.find(l => l.text.startsWith('Application 0'));
    expect(row.spans.filter(s => /lx/.test(s.text)).map(s => s.x)).toEqual([292, 520]);
    const prose = buildPageFromRaw({ number: 1, view: VIEW, items: [item('Lighting quality matters.', 72, 700)] }, new Set());
    expect(prose.lines[0].spans).toBeUndefined();
  });
});
