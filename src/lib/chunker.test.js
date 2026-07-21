import { describe, it, expect } from 'vitest';
import { chunkIESDocument } from './chunker.js';

function page(number, lines) {
  return { number, text: lines.map(l => l.text).join('\n'), lines };
}
function l(text, x = 50, fontSize = 10) {
  return { text, x, fontSize };
}

const PROSE_40 =
  'The lighting design for interior spaces shall consider the visual tasks performed by occupants ' +
  'including reading writing and detailed inspection work as well as the general ambient conditions ' +
  'required for safe circulation and comfortable occupancy throughout the space during all hours of operation';

describe('chunkIESDocument — body chunking', () => {
  it('tags prose chunks with their section number', () => {
    const chunks = chunkIESDocument([
      page(1, [l('1.0 Introduction'), l(PROSE_40)]),
    ]);
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0].type).toBe('text');
    expect(chunks[0].section).toBe('1.0');
    expect(chunks[0].pageNumber).toBe(1);
  });

  it('drops body chunks below the minimum word count', () => {
    const chunks = chunkIESDocument([
      page(1, [l('1.0 Introduction'), l('Too short to index.')]),
    ]);
    expect(chunks.length).toBe(0);
  });
});

describe('chunkIESDocument — References section', () => {
  const refPage = page(3, [
    l('10.0 References'),
    l('IES. ANSI/IES LS-1-22, Lighting Science: Nomenclature and Definitions for Illuminating Engineering. New York: Illuminating Engineering Society; 2022.'),
    l('Rea MS, Figueiro MG. Light as a circadian stimulus for architectural lighting applications. Lighting Res Technol. 2018; 50(4):497-510. doi:10.1177/1477153516682368'),
    l('CIE. CIE 218:2016, Research Roadmap for Healthful Interior Lighting Applications. Vienna: CIE; 2016.'),
    l('Annex A Supplemental Guidance'),
    l(PROSE_40),
  ]);

  it('produces one reference chunk per entry, tagged type=reference', () => {
    const chunks = chunkIESDocument([refPage], { minWords: 10 });
    const refs = chunks.filter(c => c.type === 'reference');
    expect(refs.length).toBe(3);
    expect(refs[0].text).toContain('LS-1-22');
    expect(refs[1].text).toContain('doi:10.1177');
    expect(refs[2].text).toContain('CIE 218:2016');
    for (const r of refs) {
      expect(r.pageNumber).toBe(3);
      expect(r.section).toBe('10.0');
    }
  });

  it('returns to body chunking after the References section ends', () => {
    const chunks = chunkIESDocument([refPage], { minWords: 10 });
    const bodyAfter = chunks.filter(c => c.type === 'text');
    expect(bodyAfter.length).toBeGreaterThan(0);
    expect(bodyAfter.some(c => c.text.includes('visual tasks'))).toBe(true);
  });

  it('merges hanging-indent continuation lines into one entry', () => {
    const chunks = chunkIESDocument([
      page(1, [
        l('References'),
        l('IES. ANSI/IES RP-8-22, Recommended Practice: Lighting Roadway and', 50),
        l('Parking Facilities. New York: Illuminating Engineering Society; 2022.', 58),
        l('CIE. CIE S 017:2020, ILV: International Lighting Vocabulary, 2nd edition. Vienna: CIE; 2020.', 50),
      ]),
    ], { minWords: 10 });
    const refs = chunks.filter(c => c.type === 'reference');
    expect(refs.length).toBe(2);
    expect(refs[0].text).toContain('Parking Facilities');
    expect(refs[1].text).toContain('International Lighting Vocabulary');
  });

  it('recognizes numbered reference entries', () => {
    const chunks = chunkIESDocument([
      page(1, [
        l('Bibliography'),
        l('1. First referenced publication with enough descriptive words to pass the minimum length gate for entries.'),
        l('2. Second referenced publication with enough descriptive words to pass the minimum length gate for entries.'),
      ]),
    ], { minWords: 5 });
    const refs = chunks.filter(c => c.type === 'reference');
    expect(refs.length).toBe(2);
  });

  it('does not exit references mode on a citation that looks like a section heading', () => {
    // "10 CFR Part 430, ..." matches the section-heading shape but is a
    // citation — subsequent references must still be indexed.
    const chunks = chunkIESDocument([
      page(1, [
        l('References'),
        l('IES. ANSI/IES LM-79-19, Approved Method: Optical and Electrical Measurements of LED Products. New York: IES; 2019.'),
        l('10 CFR Part 430, Energy Conservation Program for Consumer Products; 2021.'),
        l('CIE. CIE 015:2018, Colorimetry, 4th Edition. Vienna: CIE; 2018.'),
      ]),
    ], { minWords: 5 });
    const refs = chunks.filter(c => c.type === 'reference');
    expect(refs.length).toBe(3);
    expect(refs.some(r => r.text.includes('10 CFR Part 430'))).toBe(true);
  });

  it('attributes the first body chunk AFTER a multi-page references section to its own page', () => {
    const chunks = chunkIESDocument([
      page(5, [
        l('References'),
        l('IES. ANSI/IES LS-1-22, Lighting Science: Nomenclature and Definitions. New York: IES; 2022.'),
      ]),
      page(6, [
        l('CIE. CIE 015:2018, Colorimetry, 4th Edition. Vienna: CIE; 2018.'),
      ]),
      page(7, [
        l('Annex A Supplemental Guidance'),
        l(PROSE_40),
      ]),
    ], { minWords: 10 });
    const body = chunks.find(c => c.type === 'text');
    expect(body).toBeDefined();
    expect(body.pageNumber).toBe(7); // not page 5 (the references heading)
  });
});
