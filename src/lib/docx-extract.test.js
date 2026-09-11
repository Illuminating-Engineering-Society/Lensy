/**
 * DOCX manuscript extraction (src/lib/docx-extract.js) — the content half of
 * the dual-upload ingest.
 *
 * What matters here: structure is read from styles, never guessed from layout
 * (headings, references-as-paragraphs, real tables); a heading with no literal
 * number is only numbered when Word itself numbers it; tracked changes are
 * refused outright; the ToC never leaks into body chunks; and OMML math comes
 * out as readable linear text.
 *
 * Fixtures are STORED (uncompressed) ZIP entries so the tests run on any
 * Node ≥ 18 — deflate entries additionally need DecompressionStream
 * ('deflate-raw'), which workerd (the real runtime) always has.
 */

import { describe, it, expect } from 'vitest';
import { extractDocx, unzipDocx, parseXml, xmlAttr, linearizeOmml } from './docx-extract.js';
import {
  buildStoredZip, fixturePara as para, fixtureDocxBytes as docxBytes,
} from './docx-fixture.js';

const words = (n, prefix = 'word') => Array.from({ length: n }, (_, i) => `${prefix}${i}`).join(' ');

// ─── ZIP + XML primitives ──────────────────────────────────────────────────────

describe('unzipDocx', () => {
  it('reads stored entries back by name', async () => {
    const zip = buildStoredZip({ 'a.txt': 'hello', 'dir/b.txt': 'world' });
    const parts = await unzipDocx(zip);
    expect(new TextDecoder().decode(parts.get('a.txt'))).toBe('hello');
    expect(new TextDecoder().decode(parts.get('dir/b.txt'))).toBe('world');
  });

  it('refuses bytes that are not a ZIP', async () => {
    await expect(unzipDocx(new TextEncoder().encode('%PDF-1.7 not a zip at all, padding padding')))
      .rejects.toThrow(/not a zip archive/i);
  });
});

describe('parseXml', () => {
  it('builds a walkable tree with attributes and entities', () => {
    const root = parseXml('<a x="1 &amp; 2"><b/>text &lt;here&gt;</a>');
    const a = root.children[0];
    expect(a.tag).toBe('a');
    expect(xmlAttr(a, 'x')).toBe('1 & 2');
    expect(a.children.some(c => typeof c === 'string' && c.includes('text <here>'))).toBe(true);
  });
});

describe('linearizeOmml', () => {
  it('renders a fraction with sub/superscripts as readable linear text', () => {
    const root = parseXml(
      '<m:oMath><m:sSub><m:e><m:r><m:t>E</m:t></m:r></m:e><m:sub><m:r><m:t>v</m:t></m:r></m:sub></m:sSub>' +
      '<m:r><m:t>=</m:t></m:r>' +
      '<m:f><m:num><m:r><m:t>Φ</m:t></m:r></m:num><m:den><m:r><m:t>A</m:t></m:r></m:den></m:f></m:oMath>');
    expect(linearizeOmml(root.children[0])).toBe('E_v=(Φ)/(A)');
  });
});

// ─── Structure extraction ──────────────────────────────────────────────────────

describe('extractDocx — headings and sections', () => {
  it('reads literal numbers and titles from Heading styles, and sections chunks', async () => {
    const body =
      para('1 Scope', { style: 'Heading1' }) +
      para(words(50, 'scope'), {}) +
      para('1.1 Purpose of This Document', { style: 'Heading2' }) +
      para(words(40, 'purpose'), {});
    const out = await extractDocx(docxBytes(body));

    expect(out.outline).toEqual([
      { number: '1', title: 'Scope', level: 1 },
      { number: '1.1', title: 'Purpose of This Document', level: 2 },
    ]);
    expect(out.sections).toEqual({ 1: 'Scope', '1.1': 'Purpose of This Document' });
    expect(out.chunks[0].section).toBe('1');
    expect(out.chunks[0].text).toContain('1 Scope');
    expect(out.chunks.at(-1).section).toBe('1.1');
    expect(out.stats.numbering).toBe('literal');
  });

  it('recognizes annex headings', async () => {
    const body =
      para('Annex A Field Measurements', { style: 'Heading1' }) +
      para(words(40, 'annex'), {});
    const out = await extractDocx(docxBytes(body));
    expect(out.outline[0]).toEqual({ number: 'Annex A', title: 'Field Measurements', level: 1 });
    expect(out.chunks[0].section).toBe('Annex A');
  });

  it('synthesizes numbers ONLY for Word-numbered headings (w:numPr)', async () => {
    const body =
      para('Scope', { style: 'Heading1', numPr: true }) +
      para(words(35, 'one'), {}) +
      para('Definitions', { style: 'Heading2', numPr: true }) +
      para(words(35, 'two'), {}) +
      para('Field Measurements', { style: 'Heading1', numPr: true }) +
      para(words(35, 'three'), {});
    const out = await extractDocx(docxBytes(body));
    expect(out.outline.map(e => e.number)).toEqual(['1', '1.1', '2']);
    expect(out.stats.numbering).toBe('synthesized');
  });

  it('never invents a number for a genuinely unnumbered heading', async () => {
    const body =
      para('Introduction', { style: 'Heading1' }) +
      para(words(40, 'intro'), {});
    const out = await extractDocx(docxBytes(body));
    expect(out.outline).toEqual([]);
    expect(out.chunks[0].section).toBe(null);
  });

  it('refuses a year-shaped "section number"', async () => {
    const body =
      para('2026 Compliance Deadlines', { style: 'Heading1' }) +
      para(words(40, 'deadline'), {});
    const out = await extractDocx(docxBytes(body));
    expect(out.outline).toEqual([]);
    expect(out.chunks[0].section).toBe(null);
  });
});

describe('extractDocx — chunking', () => {
  it('splits at the target size with the continuation marker and overlap', async () => {
    const body =
      para('4 Design Guide', { style: 'Heading1' }) +
      para(words(250, 'body'), {});
    const out = await extractDocx(docxBytes(body));
    const text = out.chunks.filter(c => c.type === 'text');
    expect(text.length).toBeGreaterThanOrEqual(2);
    expect(text[1].text).toMatch(/^\[Section 4\]/);
    // The overlap carry: the second chunk repeats the first chunk's tail.
    expect(text[1].text).toContain('body249');
    expect(text[0].text).toContain('body249');
  });

  it('skips ToC paragraphs entirely', async () => {
    const body =
      para('1 Scope UNIQUETOCMARKER 3', { style: 'TOC1' }) +
      para('1 Scope', { style: 'Heading1' }) +
      para(words(40, 'scope'), {});
    const out = await extractDocx(docxBytes(body));
    expect(out.chunks.map(c => c.text).join('\n')).not.toContain('UNIQUETOCMARKER');
  });
});

describe('extractDocx — references', () => {
  it('turns each paragraph of a References section into one reference chunk', async () => {
    const entry =
      'Illuminating Engineering Society. ANSI/IES LS-1-22, Lighting Science: ' +
      'Nomenclature and Definitions for Illuminating Engineering. New York: IES; 2022.';
    const body =
      para('10 References', { style: 'Heading1' }) +
      para(entry, {}) +
      para('CIE. CIE 15:2018, Colorimetry, 4th Edition. Vienna: CIE; 2018.', {});
    const out = await extractDocx(docxBytes(body));
    const refs = out.chunks.filter(c => c.type === 'reference');
    expect(refs).toHaveLength(2);
    expect(refs[0].text).toBe(entry);
    expect(refs[0].section).toBe('10');
  });
});

describe('extractDocx — tables, captions, math', () => {
  it('serializes a w:tbl into a table chunk, cells in row order', async () => {
    const cell = (t) => `<w:tc><w:p><w:r><w:t>${t}</w:t></w:r></w:p></w:tc>`;
    const row = (...cells) => `<w:tr>${cells.map(cell).join('')}</w:tr>`;
    const tbl = `<w:tbl>${
      row('Application', 'Horizontal illuminance target lux', 'Vertical illuminance target lux')}${
      row('General circulation areas in commercial offices', '100 lux average maintained', '30 lux average maintained')}${
      row('Open plan office task areas with computer use', '300 lux average maintained', '75 lux average maintained')}</w:tbl>`;
    const out = await extractDocx(docxBytes(para('4 Criteria', { style: 'Heading1' }) + tbl));
    const table = out.chunks.find(c => c.type === 'table');
    expect(table).toBeTruthy();
    expect(table.section).toBe('4');
    expect(table.text).toContain('Open plan office task areas with computer use  300 lux average maintained');
  });

  it('collects caption paragraphs as assets via the shared caption parser', async () => {
    const body =
      para('4 Acoustics', { style: 'Heading1' }) +
      para(words(35, 'aco'), {}) +
      para('Table 4-1 Sound Absorption Coefficients for Various Materials', { style: 'Caption' });
    const out = await extractDocx(docxBytes(body));
    expect(out.assets).toEqual([
      { kind: 'table', label: 'Table 4-1', caption: 'Sound Absorption Coefficients for Various Materials' },
    ]);
  });

  it('linearizes OMML math inside a paragraph instead of dropping it', async () => {
    const math =
      '<w:p><w:r><w:t xml:space="preserve">The illuminance is approximated by </w:t></w:r>' +
      '<m:oMath><m:r><m:t>E=</m:t></m:r><m:f><m:num><m:r><m:t>Φ</m:t></m:r></m:num>' +
      '<m:den><m:r><m:t>A</m:t></m:r></m:den></m:f></m:oMath>' +
      `<w:r><w:t xml:space="preserve"> for a uniform beam. ${words(30, 'flux')}</w:t></w:r></w:p>`;
    const out = await extractDocx(docxBytes(para('5 Calculations', { style: 'Heading1' }) + math));
    expect(out.chunks[0].text).toContain('E=(Φ)/(A)');
  });
});

describe('extractDocx — refusals and metadata', () => {
  it('refuses a manuscript with unaccepted tracked changes', async () => {
    const body =
      para('1 Scope', { style: 'Heading1' }) +
      '<w:p><w:ins w:id="1" w:author="editor"><w:r><w:t>newly inserted text</w:t></w:r></w:ins></w:p>';
    await expect(extractDocx(docxBytes(body))).rejects.toThrow(/tracked changes/i);
  });

  it('refuses a file with no word/document.xml', async () => {
    await expect(extractDocx(buildStoredZip({ 'mimetype': 'application/pdf' })))
      .rejects.toThrow(/not a Word/i);
  });

  it('finds the designation in the front matter and the title in core.xml', async () => {
    const body =
      para('ANSI/IES RP-8-25 Recommended Practice: Lighting Roadway and Parking Facilities', {}) +
      para('1 Scope', { style: 'Heading1' }) +
      para(words(40, 'scope'), {});
    const out = await extractDocx(docxBytes(body, { core: 'Lighting Roadway and Parking Facilities' }));
    expect(out.designation).toBe('RP-8-25');
    expect(out.coreTitle).toBe('Lighting Roadway and Parking Facilities');
  });

  it('decodes XML entities in body text', async () => {
    const body =
      para('1 Scope', { style: 'Heading1' }) +
      para(`Glare &amp; contrast limits &lt;UGR 19&gt; apply. ${words(30, 'w')}`, {});
    const out = await extractDocx(docxBytes(body));
    expect(out.chunks[0].text).toContain('Glare & contrast limits <UGR 19> apply.');
  });
});
