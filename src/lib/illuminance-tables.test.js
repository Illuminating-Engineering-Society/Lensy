/**
 * "List Illuminance Tables" (Dan, Teams 2026-11-09 #2): the staff-curated list.
 */

import { describe, it, expect } from 'vitest';
import {
  tableRefOf, resolvePrintedPage, validateIlluminanceTables, parseIlluminanceTables,
  presentIlluminanceTable, unlistedTableRefs, suggestIlluminanceTables,
} from './illuminance-tables.js';

const front = (n) => 'abcdefghijklmnopqrstuvwxyz'.slice(0, n).split('');
const arabic = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => String(from + i));
// Nine lettered front-matter pages, then 1…90 (index 69 prints "60").
const LABELS = [...front(9), ...arabic(1, 90)];

describe('tableRefOf', () => {
  it('reads the table number off a title, in the printed forms', () => {
    expect(tableRefOf('Table A-1. Recommended Illuminance Criteria')).toBe('Table A-1');
    expect(tableRefOf('table 17-1 Design Criteria for Parking Lots')).toBe('Table 17-1');
    expect(tableRefOf('Table A-10')).toBe('Table A-10');
    expect(tableRefOf('Recommended Illuminance Criteria')).toBeNull();
  });
});

describe('resolvePrintedPage', () => {
  it('maps a printed page to the PDF index through the labels', () => {
    expect(resolvePrintedPage('60', LABELS, 99)).toEqual({ page: 69, label: '60' });
    expect(resolvePrintedPage('p. 60', LABELS, 99)).toEqual({ page: 69, label: '60' });
  });
  it('refuses a page the document does not print', () => {
    expect(resolvePrintedPage('500', LABELS, 99).error).toBe('not_printed');
    expect(resolvePrintedPage('', LABELS, 99).error).toBe('missing');
  });
  it('refuses a label printed on two pages rather than picking one', () => {
    expect(resolvePrintedPage('b', ['a', 'b', '1', '2', 'b'], 5).error).toBe('ambiguous');
  });
  it('matches a lettered label regardless of case when unambiguous', () => {
    expect(resolvePrintedPage('a-3', ['1', 'A-3'], 2)).toEqual({ page: 2, label: 'A-3' });
  });
  it('uses the index when the PDF carries no labels, bounded by the page count', () => {
    expect(resolvePrintedPage('12', null, 40)).toEqual({ page: 12, label: null });
    expect(resolvePrintedPage('41', null, 40).error).toBe('out_of_range');
    expect(resolvePrintedPage('iv', null, 40).error).toBe('not_printed');
  });
});

describe('validateIlluminanceTables', () => {
  const doc = { labels: LABELS, pageCount: 99 };
  it('accepts titled tables with printed pages', () => {
    const r = validateIlluminanceTables([
      { title: '  Table A-1.  Recommended   Illuminance Criteria ', page: '60' },
      { title: 'Table A-2. Outdoor', page: '68' },
    ], doc);
    expect(r.tables).toEqual([
      { title: 'Table A-1. Recommended Illuminance Criteria', page: 69, label: '60' },
      { title: 'Table A-2. Outdoor', page: 77, label: '68' },
    ]);
  });
  it('accepts an empty list (the standard is unlisted)', () => {
    expect(validateIlluminanceTables([], doc).tables).toEqual([]);
  });
  it('names the offending row', () => {
    expect(validateIlluminanceTables([{ title: '', page: '1' }], doc).error).toMatch(/Table 1 needs a title/);
    expect(validateIlluminanceTables([{ title: 'Table A-1', page: '500' }], doc).error).toMatch(/does not print/);
    expect(validateIlluminanceTables([{ title: 'X', page: '1' }, { title: 'x', page: '2' }], doc).error).toMatch(/listed twice/);
    expect(validateIlluminanceTables('nope', doc).error).toBeTruthy();
  });
});

describe('parse / present', () => {
  it('drops malformed stored entries', () => {
    expect(parseIlluminanceTables('[{"title":"T","page":3,"label":"1"},{"title":"","page":2},{"title":"U","page":"4"}]'))
      .toEqual([{ title: 'T', page: 3, label: '1' }]);
    expect(parseIlluminanceTables('not json')).toEqual([]);
    expect(parseIlluminanceTables(null)).toEqual([]);
  });
  it('prints the current label and flags one that moved after a re-ingest', () => {
    expect(presentIlluminanceTable({ title: 'T', page: 69, label: '60' }, LABELS))
      .toEqual({ title: 'T', page: 69, label: '60', stale: false });
    expect(presentIlluminanceTable({ title: 'T', page: 69, label: '58' }, LABELS).stale).toBe(true);
    expect(presentIlluminanceTable({ title: 'T', page: 12, label: null }, null).label).toBe('12');
  });
});

describe('unlistedTableRefs', () => {
  it('names the tables search uses that the list does not carry', () => {
    const listed = [{ title: 'Table A-1. Indoor' }];
    expect(unlistedTableRefs(listed, ['Table A-1', 'Table A-2', 'Table A-10'])).toEqual(['Table A-2', 'Table A-10']);
    expect(unlistedTableRefs(listed, ['Table A-1'])).toEqual([]);
  });
});

describe('suggestIlluminanceTables', () => {
  it('titles search tables from their captions and adds criteria captions', () => {
    const out = suggestIlluminanceTables({
      appTables: [{ ref: 'Table A-1', firstPage: 69 }, { ref: 'Table A-2', firstPage: 77 }],
      assets: [
        { kind: 'table', label: 'Table A-1', caption: 'Recommended Illuminance Criteria for Indoor Sports', page: 68 },
        { kind: 'table', label: 'Table 17-1', caption: 'Design Criteria for Parking Lots', page: 30 },
        { kind: 'table', label: 'Table 3-1', caption: 'Sound Absorption Coefficients', page: 20 },
        { kind: 'figure', label: 'Figure 1-1', caption: 'Illuminance diagram', page: 10 },
      ],
      labels: LABELS,
    });
    expect(out).toEqual([
      { title: 'Table 17-1. Design Criteria for Parking Lots', page: 30, label: '21', source: 'caption' },
      { title: 'Table A-1. Recommended Illuminance Criteria for Indoor Sports', page: 68, label: '59', source: 'search' },
      { title: 'Table A-2', page: 77, label: '68', source: 'search' },
    ]);
  });
  it('ignores a caption far from the rows (a list-of-tables echo)', () => {
    const [s] = suggestIlluminanceTables({
      appTables: [{ ref: 'Table A-1', firstPage: 69 }],
      assets: [{ kind: 'table', label: 'Table A-1', caption: 'Criteria', page: 5 }],
      labels: null,
    });
    expect(s.page).toBe(69);
  });
});
