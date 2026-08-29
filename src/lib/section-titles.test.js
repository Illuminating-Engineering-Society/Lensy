/**
 * Section number / title trust rules (client DO071, DO073, and the feedback
 * note "Title names, section names, and hierarchy is not always accurate").
 *
 * Every mangled fixture below is a real line, produced by running
 * src/lib/pdf-parser.js over the shipped PDF named beside it.
 */

import { describe, it, expect } from 'vitest';
import {
  isPlausibleSectionNumber, normalizeSectionNumber, readSectionNumber,
  sanitizeSectionTitle, parseHeading, chapterOf, chapterLabel, hasPrintedSeparators,
  compareSectionNumbers, outlineFromSectionMap, looksLikeChapterHeading,
} from './section-titles.js';

describe('looksLikeChapterHeading', () => {
  // Every string below is a real sections_json value, read off production D1 on
  // 2026-08-29 — the 69 chapter keys across 45 standards that exist ONLY as a
  // bare integer, which is the key this predicate guards.
  it('keeps a heading that reads like one', () => {
    for (const t of [
      'Design Guide',                                 // LP-1-24 ch. 3 — the DO40 breadcrumb
      'Methods of Characterizing Illuminance Meters', // LM-73-04 ch. 7
      'The Phases of the Lighting Design Process',    // LP-1-24 ch. 21
      'Introduction',
    ]) expect(looksLikeChapterHeading(t)).toBe(true);
  });

  it('rejects the debris a bare-integer key actually holds', () => {
    for (const t of [
      'Proposed change',                                     // LP-7-20 — public-review comment form
      'Measure the luminaire',                               // LM-10-20 — numbered instruction
      'Process the luminous intensity data',                 // LM-10-20
      'Is there at least one lighting control zone for each', // DG-29-11 — checklist question
      'The fenestration surfaces must be properly ori',      // LM-83-12 — truncated sentence
      'The maximum airflow past the luminaire shall be',     // LM-98-24
      'CPUs, servers, switches',                             // RP-10-20+E2 — table cell
      'Vertical poster boards, tack surfaces',               // RP-10-20+E2
      'Sketch showing luminaire shape, dimensions',          // LM-46-20
      '(B) Type I - 4-Way',                                  // RP-8-25 — roadway distribution type
      'MH LRL1.0',                                           // RP-8-25 — the one that broke DO28
      'Far_UV-C luminaire',                                  // LM-93-22
      'Lamp cost',                                           // DG-10-12 — table cell
    ]) expect(looksLikeChapterHeading(t)).toBe(false);
  });

  it('has nothing to say about an empty value', () => {
    for (const t of ['', null, undefined, '   ']) expect(looksLikeChapterHeading(t)).toBe(false);
  });
});

describe('isPlausibleSectionNumber', () => {
  it('accepts the numbering IES standards actually print', () => {
    for (const n of ['1', '13.4', '21.2.1.2', 'A.1.1.3', 'Annex A', 'Appendix C', '3.3.4']) {
      expect(isPlausibleSectionNumber(n)).toBe(true);
    }
  });

  it('rejects the artefacts of a dropped separator (LP-1-24)', () => {
    // "13 1" printed as "131", "18 1 0" as "1810", colour temperatures and
    // dates that lead a line with a capital.
    for (const n of ['131', '1810', '21211', '800', '2025', '6500']) {
      expect(isPlausibleSectionNumber(n)).toBe(false);
    }
  });

  it('rejects a bare capital and anything too deep', () => {
    expect(isPlausibleSectionNumber('A')).toBe(false);
    expect(isPlausibleSectionNumber('1.1.1.1.1.1.1')).toBe(false);
  });
});

describe('normalizeSectionNumber', () => {
  it('restores the period the subsetted font dropped (LP-1-24 p. 77)', () => {
    expect(normalizeSectionNumber('13 4')).toBe('13.4');
    expect(normalizeSectionNumber('2 0')).toBe('2.0');
    expect(normalizeSectionNumber('A 1 1 3')).toBe('A.1.1.3');
  });

  it('leaves a properly printed number alone', () => {
    expect(normalizeSectionNumber('3.3.4')).toBe('3.3.4');
    expect(normalizeSectionNumber('Annex a')).toBe('Annex A');
  });

  it('returns null rather than a number the document cannot have', () => {
    expect(normalizeSectionNumber('131')).toBe(null);
    expect(normalizeSectionNumber('2700')).toBe(null);
  });
});

describe('readSectionNumber', () => {
  it('reads the space-separated form and hands back the title text', () => {
    expect(readSectionNumber('13 4 Light Distribution on Task Plane'))
      .toEqual({ number: '13.4', rest: 'Light Distribution on Task Plane', raw: '13 4' });
  });

  it('reads an annex heading', () => {
    expect(readSectionNumber('Annex A Field Measurements'))
      .toEqual({ number: 'Annex A', rest: 'Field Measurements', raw: 'Annex A' });
  });

  it('is null for a data row and for a sentence that opens with a numeral', () => {
    expect(readSectionNumber('300 lux at 0.76 m')).toBe(null);
    expect(readSectionNumber('2.1 times the maintained value is excessive')).toBe(null);
  });

  it('refuses an inferred number whose "title" carries numbers — a table row', () => {
    // "10 20 Task Area 300 0.76" reads exactly like a heading whose periods the
    // font dropped. A heading is a name, so numbers in it disqualify the reading.
    expect(readSectionNumber('10 20 Task Area 300 0.76 A')).toBe(null);
    // A properly printed number keeps its title, numbers and all.
    expect(readSectionNumber('4.3 Category 3 Criteria').number).toBe('4.3');
  });
});

describe('normalizeSectionNumber with a chapter context (LP-1-24)', () => {
  it('reads "11 4" as 1.1.4 inside chapter 1 and 11.4 inside chapter 11', () => {
    expect(normalizeSectionNumber('11 4', '1')).toBe('1.1.4');
    expect(normalizeSectionNumber('11 4', '11')).toBe('11.4');
  });

  it('leaves "13 4" as 13.4 inside chapter 13 — the client\'s own example', () => {
    expect(normalizeSectionNumber('13 4', '13')).toBe('13.4');
  });

  it('never turns a chapter opener into a subsection', () => {
    // "10 Light + Environment" read inside chapter 1 is still chapter 10.
    expect(normalizeSectionNumber('10', '1')).toBe('10');
    expect(normalizeSectionNumber('20', '2')).toBe('20');
  });

  it('only splits when the chapter is a single digit that the head starts with', () => {
    expect(normalizeSectionNumber('21 3', '20')).toBe('21.3');
    expect(normalizeSectionNumber('34 1', '2')).toBe('34.1');
  });
});

describe('hasPrintedSeparators', () => {
  it('is true only when the document printed the numbering intact', () => {
    expect(hasPrintedSeparators('13.4')).toBe(true);
    expect(hasPrintedSeparators('A.1.1.3')).toBe(true);
    expect(hasPrintedSeparators('8')).toBe(true);
    expect(hasPrintedSeparators('Annex A')).toBe(true);
    expect(hasPrintedSeparators('13 4')).toBe(false);
  });
});

describe('sanitizeSectionTitle', () => {
  it('cuts at a SECOND heading number — the two-column merge (LP-9-25 p. 68)', () => {
    const merged = 'Regular Area With Single Row of Individual A.1.1.6 Regular Area With Uniform Indirect Lighting.The';
    expect(sanitizeSectionTitle(merged)).toBe('Regular Area With Single Row of Individual');
  });

  it('cuts a run-in sentence at the heading period (LP-9-25 A.1.1)', () => {
    expect(sanitizeSectionTitle('Average Illuminance on a Horizontal Plane.The measuring instrument should be positioned'))
      .toBe('Average Illuminance on a Horizontal Plane');
  });

  it('drops table-of-contents leaders and the page number', () => {
    expect(sanitizeSectionTitle('Task Visibility . . . . . . . . . . . 4')).toBe('Task Visibility');
  });

  it('refuses column-merged debris rather than printing it', () => {
    // LP-9-25's public-review form, and LP-1-24's spec table.
    expect(sanitizeSectionTitle('Submitter: ____________________________________________')).toBe(null);
    expect(sanitizeSectionTitle('Description • Name and location of project for which spec is generated')).toBe(null);
    // A unit legend that leads with a capital.
    expect(sanitizeSectionTitle('K dull red')).toBe(null);
    expect(sanitizeSectionTitle('Dec 4)')).toBe(null);
  });

  it('cuts where Title Case gives way to the next column (LP-1-24 p. 16)', () => {
    expect(sanitizeSectionTitle('Human Needs Served by Lighting task performance, health and safety, and mood and'))
      .toBe('Human Needs Served by Lighting');
    expect(sanitizeSectionTitle('How to Achieve Good Task Visibility to spend eight hours a day there?'))
      .toBe('How to Achieve Good Task Visibility');
  });

  it('drops a tail that merely repeats the head (LP-1-24 §1.1.4)', () => {
    expect(sanitizeSectionTitle('Visual Comfort Visual comfort can affect'))
      .toBe('Visual Comfort');
  });

  it('trims a title cut at a line break so it does not read as broken', () => {
    expect(sanitizeSectionTitle('The Phases of the')).toBe('The Phases');
    expect(sanitizeSectionTitle('Lighting Control Technology and')).toBe('Lighting Control Technology');
    expect(sanitizeSectionTitle('Retail Lighting Upgrades The')).toBe('Retail Lighting Upgrades');
    expect(sanitizeSectionTitle('How to Eliminate Unwanted Glare As')).toBe('How to Eliminate Unwanted Glare');
  });

  it('refuses a bibliography line that begins with a number (RP-43-25 key "8")', () => {
    expect(sanitizeSectionTitle('PMID: 16494083')).toBe(null);
  });

  it('does not cut a short sentence-case title, which has no such tell', () => {
    expect(sanitizeSectionTitle('Design considerations for interior spaces'))
      .toBe('Design considerations for interior spaces');
  });

  it('refuses a long sentence — the merged cell of a two-column table', () => {
    // LP-1-24's specification outline, and a stray list marker in RP-43-25.
    expect(sanitizeSectionTitle('Work included Outlines work required of contractor')).toBe(null);
    expect(sanitizeSectionTitle('(Lz3) area would have higher volume pedestrian')).toBe(null);
    expect(sanitizeSectionTitle('Commissioning developed and presented to the client as part')).toBe(null);
  });

  it('keeps a long TITLE CASE heading — length alone is not the signal', () => {
    expect(sanitizeSectionTitle('How to Optimize Daylighting for Different Building and Room Shapes'))
      .toBe('How to Optimize Daylighting for Different Building and Room Shapes');
    expect(sanitizeSectionTitle('Regular Area With Single Row of Individual Luminaires'))
      .toBe('Regular Area With Single Row of Individual Luminaires');
  });

  it('keeps a real title, parentheses and all', () => {
    expect(sanitizeSectionTitle('Light Distribution on Task Plane (Uniformity)'))
      .toBe('Light Distribution on Task Plane (Uniformity)');
    expect(sanitizeSectionTitle('Room Surface Brightness (and Surface Characteristics)'))
      .toBe('Room Surface Brightness (and Surface Characteristics)');
  });
});

describe('parseHeading', () => {
  it('turns the LP-1-24 line into the section the client expects', () => {
    expect(parseHeading('13 4 Light Distribution on Task Plane'))
      .toEqual({ number: '13.4', title: 'Light Distribution on Task Plane' });
  });

  it('turns the LP-9-25 merged annex line into just its own heading', () => {
    expect(parseHeading('A.1.1.3 Regular Area With Single Row of Individual A.1.1.6 Regular Area With Uniform Indirect Lighting.The'))
      .toEqual({ number: 'A.1.1.3', title: 'Regular Area With Single Row of Individual' });
  });

  it('refuses the glued form outright — no locator beats a wrong one', () => {
    expect(parseHeading('131 Patterns of Light within the occupants’ field of view—such as walls and')).toBe(null);
  });
});

describe('chapterOf / chapterLabel (client DO073)', () => {
  it('folds every section of a chapter onto the chapter', () => {
    expect(chapterOf('4.3.3.1')).toBe('4');
    expect(chapterOf('4.2.4')).toBe('4');
    expect(chapterOf('8.7.2.4')).toBe('8');
    expect(chapterOf('13')).toBe('13');
  });

  it('treats an annex as its own chapter', () => {
    expect(chapterOf('A.1.1.3')).toBe('Annex A');
    expect(chapterOf('Annex C')).toBe('Annex C');
  });

  it('is null when there is no trustworthy chapter', () => {
    expect(chapterOf('')).toBe(null);
    expect(chapterOf('References')).toBe(null);
  });

  it('labels the blue band the way the client drew it', () => {
    expect(chapterLabel('8', 'Outdoor Lighting Design Process'))
      .toBe('Ch. 8 – Outdoor Lighting Design Process');
    expect(chapterLabel('Annex A', 'Field Measurements')).toBe('Annex A – Field Measurements');
    expect(chapterLabel('8', null)).toBe('Ch. 8');
  });
});

// ─── DO082: the outline is ordered like a printed table of contents ───────────

describe('compareSectionNumbers / outlineFromSectionMap (DO082)', () => {
  it('orders by each numeric part, not as strings', () => {
    const sorted = ['2.10', '10', '2', '2.2', '1.1.1', 'Annex B', 'Annex A']
      .sort(compareSectionNumbers);
    expect(sorted).toEqual(['1.1.1', '2', '2.2', '2.10', '10', 'Annex A', 'Annex B']);
  });

  it('turns a section map into a table of contents, pageless', () => {
    const outline = outlineFromSectionMap({
      '2.1': 'Task Visibility', '1.0': 'Light + Quality', '2.0': 'Light + Vision',
    });
    expect(outline).toEqual([
      { number: '1.0', title: 'Light + Quality', page: null },
      { number: '2.0', title: 'Light + Vision', page: null },
      { number: '2.1', title: 'Task Visibility', page: null },
    ]);
  });

  it('is empty for a standard with no indexed headings', () => {
    expect(outlineFromSectionMap(null)).toEqual([]);
    expect(outlineFromSectionMap({})).toEqual([]);
  });
});
