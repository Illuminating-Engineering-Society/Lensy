/**
 * Cover-page extraction (client DO48 / DO29).
 *
 * The fixtures below are the real extracted line sequences from the corpus,
 * control characters included — that encoding IS the bug this module exists to
 * survive, so a test that used clean text would prove nothing.
 */

import { describe, it, expect } from 'vitest';
import {
  extractCoverMetadata, extractCoverCommittee, sanitizeGlyphs, toTitleCase,
} from './cover-title.js';

/** The subsetted-font glyphs: U+001F is "(" or "-", U+001E is ")". */
const OPEN = String.fromCharCode(0x1F);
const CLOSE = String.fromCharCode(0x1E);

const page = (number, lines) => ({ number, text: lines.join('\n'), lines: lines.map(text => ({ text })) });

describe('extractCoverMetadata', () => {
  it('reads the designation and title off the cover', () => {
    const cover = extractCoverMetadata([page(1, [
      'ANSI/IES RP-1-24',
      'RECOMMENDED PRACTICE:',
      'LIGHTING OFFICE SPACES',
      'AN AMERICAN NATIONAL STANDARD',
      'www.ies.org',
    ])]);
    // The exact string the client gave as correct.
    expect(cover.designation).toBe('ANSI/IES RP-1-24');
    expect(cover.title).toBe('Recommended Practice: Lighting Office Spaces');
  });

  it('keeps the reaffirmation marker the id cannot carry (DO45)', () => {
    const cover = extractCoverMetadata([page(1, [
      'ANSI/IES LS-2-20(R2023)',
      'LIGHTING SCIENCE:',
      'CONCEPTS AND LANGUAGE',
      'OF LIGHTING',
      'AN AMERICAN NATIONAL STANDARD',
    ])]);
    expect(cover.designation).toBe('ANSI/IES LS-2-20(R2023)');
    expect(cover.title).toBe('Lighting Science: Concepts and Language of Lighting');
  });

  it('reads a cover whose hyphens are control-character glyphs', () => {
    const cover = extractCoverMetadata([page(1, [
      `ANSI/IES LP${OPEN}12${OPEN}21`,
      'LIGHTING PRACTICE:',
      'IOT CONNECTED LIGHTING',
      'AN AMERICAN NATIONAL STANDARD',
    ])]);
    expect(cover.designation).toBe('ANSI/IES LP-12-21');
    expect(cover.title).toBe('Lighting Practice: IoT Connected Lighting');
  });

  it('restores a bracketed acronym and leaves it upper case', () => {
    const cover = extractCoverMetadata([page(1, [
      'ANSI/IES RP-44-21',
      'RECOMMENDED PRACTICE:',
      'ULTRAVIOLET GERMICIDAL',
      `IRRADIATION ${OPEN}UVGI${CLOSE}`,
      'AN AMERICAN NATIONAL STANDARD',
    ])]);
    expect(cover.title).toBe('Recommended Practice: Ultraviolet Germicidal Irradiation (UVGI)');
  });

  it('skips an errata banner and co-publisher prefixes', () => {
    const cover = extractCoverMetadata([page(1, [
      'ANSI/IES/NALMCO RP-36-24',
      '+ Errata 1',
      'RECOMMENDED PRACTICE:',
      'LIGHTING MAINTENANCE',
      'AN AMERICAN NATIONAL STANDARD',
    ])]);
    expect(cover.designation).toBe('ANSI/IES/NALMCO RP-36-24');
    expect(cover.title).toBe('Recommended Practice: Lighting Maintenance');
  });

  it('stops at the packaging below the title', () => {
    const cover = extractCoverMetadata([page(1, [
      'ANSI/IES RP-30-25',
      'RECOMMENDED PRACTICE:',
      'LIGHTING MUSEUMS',
      'AN AMERICAN NATIONAL STANDARD',
      'Publication of this document has been approved by the IES.',
    ])]);
    expect(cover.title).toBe('Recommended Practice: Lighting Museums');
  });

  it('stops at a table of contents on a draft cover', () => {
    const cover = extractCoverMetadata([page(1, [
      'ANSI/IES LS-1-22',
      'NOMENCLATURE AND DEFINITIONS FOR ILLUMINATING ENGINEERING',
      'TABLE OF CONTENTS',
      'PREFACE ......................................................... 2',
    ])]);
    expect(cover.title).toBe('Nomenclature and Definitions for Illuminating Engineering');
  });

  it('returns nulls for a cover with no text (a scanned image)', () => {
    expect(extractCoverMetadata([page(1, []), page(2, [])]))
      .toEqual({ designation: null, title: null });
    expect(extractCoverMetadata([])).toEqual({ designation: null, title: null });
  });
});

describe('extractCoverCommittee (DO29)', () => {
  it('reads the committee the document names', () => {
    const committee = extractCoverCommittee([
      page(1, ['ANSI/IES RP-2-20', 'RECOMMENDED PRACTICE:', 'LIGHTING RETAIL SPACES']),
      page(2, [
        'Publication of this document has been approved by the IES.',
        'Prepared by the',
        'The IES Retail Lighting Committee',
      ]),
    ]);
    // The leading "The" is dropped so the credit reads "IES Retail Lighting
    // Committee" — the client's required "IES [Committee Name]" format.
    expect(committee).toBe('IES Retail Lighting Committee');
  });

  it('reads a committee printed on the same line', () => {
    expect(extractCoverCommittee([page(2, ['Prepared by the IES Light and Human Health Committee'])]))
      .toBe('IES Light and Human Health Committee');
  });

  it('credits nobody rather than a bare "Subcommittee"', () => {
    expect(extractCoverCommittee([page(2, ['Prepared by the', 'Subcommittee'])])).toBeNull();
  });

  it('is null when the document names no committee', () => {
    expect(extractCoverCommittee([page(1, ['ANSI/IES RP-1-24', 'RECOMMENDED PRACTICE:'])])).toBeNull();
  });
});

describe('toTitleCase', () => {
  it('lowercases the minor words but never the first or last', () => {
    expect(toTitleCase('CALCULATION OF LIGHT AND ITS EFFECTS'))
      .toBe('Calculation of Light and Its Effects');
    expect(toTitleCase('THE SCIENCE OF PHOTOMETRY')).toBe('The Science of Photometry');
  });

  it('capitalizes the word after a colon or a dash', () => {
    expect(toTitleCase('LIGHTING SCIENCE: THE MEASUREMENT OF LIGHT'))
      .toBe('Lighting Science: The Measurement of Light');
  });

  it('keeps acronyms and designations as printed', () => {
    expect(toTitleCase('IES METHOD FOR EVALUATING LIGHT SOURCE COLOR RENDITION'))
      .toBe('IES Method for Evaluating Light Source Color Rendition');
    expect(toTitleCase('ADJUSTING FOR TM-24-20 CATEGORIES')).toBe('Adjusting for TM-24-20 Categories');
  });

  it('cases each run inside a token the cover left unspaced', () => {
    expect(toTitleCase('PROPERTIES,SELECTION, AND SPECIFICATION'))
      .toBe('Properties,Selection, and Specification');
  });

  it('leaves already-mixed-case text exactly as printed', () => {
    expect(toTitleCase('Recommended Practice: Lighting Office Spaces'))
      .toBe('Recommended Practice: Lighting Office Spaces');
  });
});

describe('sanitizeGlyphs', () => {
  it('reads a bracket pair before it reads a dash', () => {
    expect(sanitizeGlyphs(`CORRELATED COLOR TEMPERATURE ${OPEN}CCT${CLOSE} AND DISTANCE`))
      .toBe('CORRELATED COLOR TEMPERATURE (CCT) AND DISTANCE');
    expect(sanitizeGlyphs(`VISION ${OPEN} EYE AND BRAIN`)).toBe('VISION - EYE AND BRAIN');
  });

  it('leaves ordinary text alone', () => {
    expect(sanitizeGlyphs('ANSI/IES RP-8-25+E2')).toBe('ANSI/IES RP-8-25+E2');
  });
});
