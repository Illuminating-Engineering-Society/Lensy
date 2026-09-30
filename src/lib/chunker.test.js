import { describe, it, expect } from 'vitest';
import { chunkIESDocument, extractSectionTitles } from './chunker.js';

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

  // The 18 "no reference chunks" standards of 2026-09-28, in three shapes.
  it('keeps a Vancouver-numbered list ("1 Houser KW, …") inside the run', () => {
    // TM-30-24 p. 47: bare entry numbers, no period, first lines with no
    // comma or year — "3 Royer MP. What is the Reference?…" reads exactly
    // like a "3 Scope" heading. Every entry after it used to become body text.
    const chunks = chunkIESDocument([
      page(47, [
        l('REFERENCES', 63, 12),
        l('1 Houser KW, Wei M, David A, Krames MR, Shen XS. Review of measures for light-source color rendition and', 63),
        l('considerations for a two-measure system for characterizing color rendition. Opt Express. 2013;21:10393-411.', 81),
        l('2 Smet K, Ryckaert WR, Pointer MR, Deconinck G, Hanselaer P. Correlation between color quality metric predictions', 63),
        l('and visual appreciation of light sources. Opt Express. 2011;19:8151-66.', 81),
        l('3 Royer MP. What is the Reference? An examination of alternatives to the reference sources used in IES TM-30-15.', 63),
        l('Leukos. 2016;13:71-89.', 81),
        l('4 International Organization for Standardization (ISO). Graphic Technology – Standard Object Colour Spectra', 63),
        l('Database for Colour Reproduction Evaluation (SOCS). Geneva: ISO; 2003.', 81),
      ]),
    ], { minWords: 5 });
    const refs = chunks.filter(c => c.type === 'reference');
    expect(refs.map(r => r.text.slice(0, 12))).toEqual(['1 Houser KW,', '2 Smet K, Ry', '3 Royer MP. ', '4 Internatio']);
    expect(chunks.filter(c => c.type === 'text')).toEqual([]);
  });

  it('reads sub-numbered normative references ("2.1 ANSI/IES LS-1-22") as entries', () => {
    // TM-25-20 p. 11: each normative reference is its own sub-heading of the
    // "2.0 Normative References" chapter, and the next chapter ends the list.
    const chunks = chunkIESDocument([
      page(11, [
        l('2.0 Normative References', 63, 15),
        l('2.1 ANSI/IES LS-1-22', 63, 11),
        l('Lighting Science: Nomenclature and Definitions for Illuminating Engineering. New York: IES; 2022.', 63),
        l('2.2 ISO 8601', 63, 11),
        l('Date and Time Format, Parts 1 and 2. Geneva: International Organization for Standardization, 2019.', 63),
        l('3.0 Definitions and Nomenclature', 63, 15),
        l('3.1 ASCII', 63, 11),
        l(PROSE_40),
      ]),
    ], { minWords: 10 });
    const refs = chunks.filter(c => c.type === 'reference');
    expect(refs.length).toBe(2);
    expect(refs[0].text).toContain('LS-1-22');
    expect(refs[1].text).toContain('ISO 8601');
    expect(chunks.some(c => c.type === 'text' && c.section === '3.1')).toBe(true);
  });

  it('recognises "Informative Reference List" and "Additional Reading" as bibliography headings', () => {
    const chunks = chunkIESDocument([
      page(15, [
        l('INFORMATIVE REFERENCE LIST', 63, 12),
        l('1 Illuminating Engineering Society. ANSI/IES LM-9-20/R23, Approved Method: Electrical and Photometric', 63),
        l('Measurement of Fluorescent Lamps. New York: IES; 2020.', 81),
        l('ADDITIONAL READING', 63, 12),
        l('Jerome CW. The flattery index. J Illumin Engineering Soc. 1973;2:351-4. DOI: 10.1080/00994480.1973.10747727.', 63),
      ]),
    ], { minWords: 5 });
    const refs = chunks.filter(c => c.type === 'reference');
    expect(refs.length).toBe(2);
  });

  it('does not open a reference run on a lowercase table cell reading "reference"', () => {
    const chunks = chunkIESDocument([
      page(26, [l('1.0 Scope'), l('reference'), l(PROSE_40)]),
    ]);
    expect(chunks.every(c => c.type !== 'reference')).toBe(true);
    expect(chunks[0].section).toBe('1.0');
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

// ─── DO071 regressions found in review ───────────────────────────────────────

describe('chunkIESDocument — a table row is not a heading', () => {
  const TABLE_LINES = [
    l('Table A-1 Recommended Illuminance'),
    l('10 20 Task Area 300 0.76 A'),
    l('30 40 Corridor Floor 100 0.00 A'),
    l('50 60 Stairs and Ramps 150 0.00 A'),
  ];

  it('keeps the section it was given instead of reading "10 20" as §10.20', () => {
    const chunks = chunkIESDocument([
      page(1, [l('4.3 Task Lighting Criteria'), l(PROSE_40)]),
      page(2, TABLE_LINES.concat([l(PROSE_40)])),
    ], { minWords: 10 });
    const sections = [...new Set(chunks.map(c => c.section))];
    expect(sections).not.toContain('10.20');
    expect(sections).not.toContain('30.40');
    expect(sections).toContain('4.3');
  });

  it('still reads the spaced form on an ordinary page (LP-1-24 "13 4")', () => {
    const chunks = chunkIESDocument([
      page(1, [l('13 4 Light Distribution on Task Plane'), l(PROSE_40)]),
    ], { minWords: 10 });
    expect(chunks[0].section).toBe('13.4');
  });
});

describe('extractSectionTitles — a two-line heading joins only when unfinished', () => {
  const p = (number, lines) => ({
    number,
    text: lines.map(t => t.text).join('\n'),
    lines,
  });
  const line = (text, fontSize = 10, x = 50) => ({ text, fontSize, x });

  it('completes a title that ends on an adjective (LP-9-25 A.1.1.3)', () => {
    const titles = extractSectionTitles([p(68, [
      line('A.1.1.3 Regular Area With Single Row of Individual'),
      line('Luminaires. The average illuminance, Eavg, in such a space can be determined from the expression.'),
    ])]);
    expect(titles['A.1.1.3']).toBe('Regular Area With Single Row of Individual Luminaires');
  });

  it('does NOT absorb the first word of the next paragraph', () => {
    const titles = extractSectionTitles([p(20, [
      line('4.2 Task Plane Lighting'),
      line('Fig. 4 shows the layout of the measurement stations used in this survey.'),
    ])]);
    expect(titles['4.2']).toBe('Task Plane Lighting');

    const more = extractSectionTitles([p(21, [
      line('5.1 Outdoor Pedestrian Areas'),
      line('Note. Values are maintained illuminances measured at grade level.'),
    ])]);
    expect(more['5.1']).toBe('Outdoor Pedestrian Areas');

    const complete = extractSectionTitles([p(22, [
      line('3.3.4 Interior Circulation Areas'),
      line('Lighting. The average illuminance in a corridor is measured at the floor.'),
    ])]);
    expect(complete['3.3.4']).toBe('Interior Circulation Areas');
  });
});
