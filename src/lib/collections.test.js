/**
 * Saved Search Collections (client DO37).
 *
 * The rule under test is the one the client stated twice, in bold: a collection
 * saves REFERENCES to search results, not their contents — with exactly two
 * carve-outs (an illuminance row's application name, a reference entry's text).
 * It is enforced in normalizeSavedItem rather than in the UI, so these tests are
 * the guard against a future caller quietly persisting excerpt text.
 */

import { describe, it, expect } from 'vitest';
import {
  normalizeSavedItem, syntheticItemCode, collectionTypeFor, csvRowFor, csvCell,
  stripHtml, newShareToken, CSV_COLUMNS, RESULT_TYPE_LABELS, SAVEABLE_TYPES,
} from './collections.js';

const base = {
  standard_id: 'RP-2-20+E1',
  resource_title: 'ANSI/IES RP-2-20+E1 Recommended Practice: Lighting Retail Spaces',
  page_number: 72,
  library_url: 'https://view.protectedpdf.com/abc#page=72',
};

describe('normalizeSavedItem — the no-contents rule', () => {
  it('strips excerpt text from a Document item', () => {
    const { item } = normalizeSavedItem({ ...base, result_type: 'body', reference_text: 'A passage from the standard.' });
    expect(item.reference_text).toBeNull();
  });

  it('strips the application name from anything that is not an illuminance row', () => {
    for (const type of ['body', 'references', 'definitions']) {
      const { item } = normalizeSavedItem({ ...base, result_type: type, application_name: 'INTERIOR > Desk' });
      expect(item.application_name).toBeNull();
    }
  });

  it('KEEPS the application name for an illuminance row', () => {
    // Without it the citation names a table row the reader cannot identify.
    const { item } = normalizeSavedItem({
      ...base, result_type: 'tables',
      application_name: 'INTERIOR – RESIDENTIAL > Reading and Writing > Bed headboard (small area)',
    });
    expect(item.application_name).toContain('Bed headboard');
  });

  it('KEEPS the entry text for a reference — the client\'s only exception', () => {
    const entry = '6 International Commission on Illumination (CIE). CIE 015:2018, Colorimetry, 4th ed. Vienna: CIE; 2018.';
    const { item } = normalizeSavedItem({ ...base, result_type: 'references', reference_text: entry });
    expect(item.reference_text).toBe(entry);
  });

  it('always keeps the citation, page and Library link', () => {
    const { item } = normalizeSavedItem({ ...base, result_type: 'body' });
    expect(item.resource_title).toBe(base.resource_title);
    expect(item.page_number).toBe(72);
    expect(item.library_url).toBe(base.library_url);
  });

  it('rejects an unsaveable kind — document comparisons must stay out', () => {
    expect(normalizeSavedItem({ ...base, result_type: 'compare' }).ok).toBe(false);
    expect(normalizeSavedItem({ ...base, result_type: 'ai' }).ok).toBe(false);
    expect(normalizeSavedItem({ ...base }).ok).toBe(false);
  });

  it('requires a citation to save', () => {
    const out = normalizeSavedItem({ result_type: 'body', standard_id: 'RP-1-24' });
    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/resource_title/);
  });

  it('refuses a non-http link rather than storing it', () => {
    const { item } = normalizeSavedItem({ ...base, result_type: 'body', library_url: 'javascript:alert(1)' });
    expect(item.library_url).toBeNull();
  });

  it('accepts a note under either field name', () => {
    expect(normalizeSavedItem({ ...base, result_type: 'body', note: 'mine' }).item.custom_notes).toBe('mine');
    expect(normalizeSavedItem({ ...base, result_type: 'body', custom_notes: 'mine' }).item.custom_notes).toBe('mine');
  });

  it('covers every saveable type with a label', () => {
    for (const t of SAVEABLE_TYPES) expect(RESULT_TYPE_LABELS[t]).toBeTruthy();
  });
});

describe('syntheticItemCode', () => {
  it('is deterministic, so saving the same item twice is caught as a duplicate', () => {
    const item = { result_type: 'body', standard_id: 'RP-2-20+E1', page_number: 72, resource_title: 'x' };
    expect(syntheticItemCode(item)).toBe(syntheticItemCode({ ...item }));
  });

  it('distinguishes different pages of the same standard', () => {
    const a = { result_type: 'body', standard_id: 'RP-2-20+E1', page_number: 72, resource_title: 'x' };
    expect(syntheticItemCode(a)).not.toBe(syntheticItemCode({ ...a, page_number: 73 }));
  });

  it('keys a definition on its slug', () => {
    expect(syntheticItemCode({ result_type: 'definitions', definition_slug: 'color' })).toBe('definition:color');
  });

  it('keys a reference on its entry text, so two entries in one standard differ', () => {
    const a = syntheticItemCode({ result_type: 'references', standard_id: 'LS-5-25', reference_text: 'Entry A' });
    const b = syntheticItemCode({ result_type: 'references', standard_id: 'LS-5-25', reference_text: 'Entry B' });
    expect(a).not.toBe(b);
  });

  it('prefers a real application code when the caller has one', () => {
    const { item } = normalizeSavedItem({ ...base, result_type: 'tables', application_code: 'RP220E1_0162' });
    expect(item.application_code).toBe('RP220E1_0162');
  });
});

describe('collectionTypeFor', () => {
  it('maps the search result kinds onto the collection kinds', () => {
    expect(collectionTypeFor('excerpt')).toBe('body');
    expect(collectionTypeFor('application')).toBe('tables');
    expect(collectionTypeFor('reference')).toBe('references');
    expect(collectionTypeFor('definition')).toBe('definitions');
  });

  it('returns null for anything not saveable', () => {
    expect(collectionTypeFor('comparison')).toBeNull();
    expect(collectionTypeFor(undefined)).toBeNull();
  });
});

describe('CSV export', () => {
  const collection = {
    name: 'Walkway lighting study', notes: '<p>For the <strong>RFP</strong> response.</p>',
    client_name: 'Acme', location: 'Springfield, MO', designer_name: 'J. Doe',
    collection_type: 'New Construction', created_at: '2026-06-07', modified_at: '2026-06-16',
    owner_label: 'dan@ies.org',
  };

  it('uses the client\'s column order exactly', () => {
    expect(CSV_COLUMNS.map(([, label]) => label)).toEqual([
      'Date Added', 'User', 'Type', 'Search Note', 'Resource', 'Page', 'Open in Library',
      'Application', 'Reference', 'Collection Topic', 'Collection Note', 'Client',
      'Location', 'Designer', 'Project Type', 'Date Created', 'Date Updated',
    ]);
  });

  it('prints the application only for illuminance rows and the reference only for references', () => {
    const table = csvRowFor({
      result_type: 'tables', resource_title: 'ANSI/IES RP-2-20+E1', page_number: 72,
      application_name: 'INTERIOR > Desk', reference_text: 'should not appear', added_at: '2026-06-15',
    }, collection);
    const ref = csvRowFor({
      result_type: 'references', resource_title: 'ANSI/IES LS-5-25', page_number: 61,
      application_name: 'should not appear', reference_text: 'CIE 015:2018', added_at: '2026-06-15',
    }, collection);
    const appIdx = CSV_COLUMNS.findIndex(([k]) => k === 'application');
    const refIdx = CSV_COLUMNS.findIndex(([k]) => k === 'reference');
    expect(table[appIdx]).toBe('"INTERIOR > Desk"');
    expect(table[refIdx]).toBe('""');
    expect(ref[appIdx]).toBe('""');
    expect(ref[refIdx]).toBe('"CIE 015:2018"');
  });

  it('flattens rich-text notes into plain cells', () => {
    const row = csvRowFor({ result_type: 'body', resource_title: 'x', custom_notes: '<p>Line one</p><p>Line two</p>' }, collection);
    const noteIdx = CSV_COLUMNS.findIndex(([k]) => k === 'search_note');
    expect(row[noteIdx]).toBe('"Line one Line two"');
    const collNoteIdx = CSV_COLUMNS.findIndex(([k]) => k === 'collection_note');
    expect(row[collNoteIdx]).toBe('"For the RFP response."');
  });

  it('labels each type the way the client spells it', () => {
    const typeIdx = CSV_COLUMNS.findIndex(([k]) => k === 'type');
    for (const [type, label] of Object.entries(RESULT_TYPE_LABELS)) {
      expect(csvRowFor({ result_type: type, resource_title: 'x' }, collection)[typeIdx]).toBe(`"${label}"`);
    }
  });
});

describe('csvCell', () => {
  it('escapes embedded quotes', () => {
    expect(csvCell('He said "hi"')).toBe('"He said ""hi"""');
  });

  it('neutralizes a formula-leading cell', () => {
    // Excel and Sheets EXECUTE a cell starting with = + - or @, and these files
    // get emailed to clients — a user note is untrusted input.
    expect(csvCell('=1+1')).toBe(`"'=1+1"`);
    expect(csvCell('+A1')).toBe(`"'+A1"`);
    expect(csvCell('-2')).toBe(`"'-2"`);
    expect(csvCell('@SUM(A1)')).toBe(`"'@SUM(A1)"`);
  });

  it('leaves ordinary text alone', () => {
    expect(csvCell('ANSI/IES RP-2-20+E1')).toBe('"ANSI/IES RP-2-20+E1"');
    expect(csvCell(null)).toBe('""');
  });
});

describe('stripHtml', () => {
  it('keeps words apart across block boundaries', () => {
    expect(stripHtml('<p>one</p><p>two</p>')).toBe('one two');
    expect(stripHtml('a<br>b')).toBe('a b');
  });

  it('decodes the entities a rich-text field produces', () => {
    expect(stripHtml('<p>Acme &amp; Co &quot;quoted&quot;</p>')).toBe('Acme & Co "quoted"');
  });

  it('is empty for empty input', () => {
    expect(stripHtml(null)).toBe('');
    expect(stripHtml('')).toBe('');
  });
});

describe('newShareToken', () => {
  it('is URL-safe hex of a fixed length', () => {
    const t = newShareToken(new Uint8Array(16).fill(255));
    expect(t).toBe('f'.repeat(32));
    expect(t).toMatch(/^[0-9a-f]{32}$/);
  });

  it('differs between calls', () => {
    expect(newShareToken()).not.toBe(newShareToken());
  });
});
