/**
 * The client's 9/28 – 10/02 Teams notes, Worker side.
 */
import { describe, it, expect } from 'vitest';
import {
  isHandbookQuery, isBareHandbookQuery, deprecatedLookupNote, isIlluminanceQuery,
  rp1IlluminanceNote, definitionSearchTerm,
} from './search';
import { isProductQuestion, productAnswerText, SUPPORT_FORM_URL } from '../lib/product';
import { symbolExpansions, expandQuery } from '../lib/query-expander';

describe('questions about IES Lens itself (9/30/26 DO#3)', () => {
  it('recognizes the product questions', () => {
    for (const q of ['what are you?', 'Who are you', 'what is IES Lens?', 'what can you do?',
      'what is the lighting library', 'are you an AI?', 'hello']) {
      expect(isProductQuestion(q), q).toBe(true);
    }
  });
  it('leaves lighting questions alone', () => {
    for (const q of ['what is luminance?', 'what are the requirements for egress lighting',
      'lens efficiency of a luminaire', 'what is the illuminance for a library reading room']) {
      expect(isProductQuestion(q), q).toBe(false);
    }
  });
  it('answers in the third person, as "This is IES Lens…"', () => {
    const text = productAnswerText();
    expect(text.startsWith('This is IES Lens')).toBe(true);
    expect(text).not.toMatch(/\b(?:I|I'm|me|my|we|our)\b/);
  });
  it('points support at the IES form, never at a staff inbox (9/30/26 DO#4)', () => {
    expect(SUPPORT_FORM_URL).toBe('https://ies.org/contact-us/');
  });
});

describe('the Lighting Handbook (9/30/26 DO#1)', () => {
  it('recognizes the Handbook searches the client listed', () => {
    for (const q of ['Handbook', 'Lighting Handbook', '10th edition Handbook', 'IES handbook office']) {
      expect(isHandbookQuery(q), q).toBe(true);
    }
    expect(isHandbookQuery('office lighting')).toBe(false);
  });
  it('treats only the bare name as a request for the Handbook itself', () => {
    expect(isBareHandbookQuery('the lighting handbook 10th edition')).toBe(true);
    expect(isBareHandbookQuery('handbook office illuminance')).toBe(false);
  });
});

describe('a deprecated edition named exactly (9/30/26 DO#2)', () => {
  const card = (designation, deprecated) => ({
    resultType: 'standard', isDeprecated: deprecated,
    document: { designation }, application: { standard: designation.replace('ANSI/IES ', '') },
  });
  it('builds the note in the Compare Versions wording', () => {
    const note = deprecatedLookupNote([card('ANSI/IES RP-43-25', false), card('ANSI/IES RP-43-22', true)]);
    expect(note.text).toBe('ANSI/IES RP-43-22 has been replaced by ANSI/IES RP-43-25, and for the most '
      + 'accurate and up-to-date information, readers should consult the current edition.');
  });
  it('is silent for an ordinary lookup', () => {
    expect(deprecatedLookupNote([card('ANSI/IES RP-43-25', false)])).toBeNull();
  });
});

describe('symbols typed without their subscript (9/30/26 DO#9)', () => {
  it('reads Rf as the TM-30 Fidelity Index, case-sensitively', () => {
    expect(symbolExpansions('Rf')).toContain('fidelity');
    expect(expandQuery('Rf')).toMatch(/fidelity index/);
    expect(symbolExpansions('rf interference')).toEqual([]);
    expect(symbolExpansions('EV charging')).toEqual([]);
    expect(symbolExpansions('Ev on the façade')).toContain('vertical');
  });
  it('matches a definition term printed with its symbol', () => {
    expect(definitionSearchTerm('Rf')).toBe('rf');
    expect(definitionSearchTerm('R_f')).toBe('rf');
  });
});

describe('RP-10 for common applications (9/30/26 DO#10)', () => {
  it('detects an illuminance question', () => {
    expect(isIlluminanceQuery('office lighting illuminance levels')).toBe(true);
    expect(isIlluminanceQuery('how bright should a classroom be')).toBe(true);
    expect(isIlluminanceQuery('what changed in RP-8')).toBe(false);
  });
  it('adds the RP-10 note to an RP-1 illuminance answer, and only then', () => {
    const rp1 = [{ application: { standard: 'RP-1-24' } }];
    expect(rp1IlluminanceNote('office illuminance', rp1, 'ANSI/IES RP-10-20+E2'))
      .toBe('Illuminance recommendations for common applications including office spaces can be found in ANSI/IES RP-10-20+E2.');
    expect(rp1IlluminanceNote('office glare control', rp1, 'ANSI/IES RP-10-20+E2')).toBeNull();
    expect(rp1IlluminanceNote('office illuminance', [{ application: { standard: 'RP-3-20' } }], null)).toBeNull();
  });
});

describe('comparison section links from the outline (9/29/26 DO#1)', () => {
  it('keys a chapter both as printed and bare, and never mangles "10"', async () => {
    const { withOutlineSectionLinks } = await import('./search');
    const env = {
      DB: {
        prepare: () => ({
          bind: () => ({
            all: async () => ({
              results: [{
                id: 'RP-43-25',
                vitrium_web_url: 'https://lighting.ies.org/dpgQ4A',
                outline_json: JSON.stringify([
                  { number: '6.0', title: 'Community Planning', page: 30 },
                  { number: '10', title: 'Annexes', page: 90 },
                  { number: '8.7.2.4', title: 'Color', page: 61 },
                ]),
              }],
            }),
          }),
        }),
      },
    };
    const map = await withOutlineSectionLinks(env, {}, ['RP-43-25']);
    const s = map['RP-43-25'].sections;
    expect(s['6.0']).toBe('https://lighting.ies.org/dpgQ4A#page=30');
    expect(s['6']).toBe('https://lighting.ies.org/dpgQ4A#page=30');
    expect(s['10']).toBe('https://lighting.ies.org/dpgQ4A#page=90');
    expect(s['1']).toBeUndefined();
    expect(s['8.7.2.4']).toBe('https://lighting.ies.org/dpgQ4A#page=61');
  });
});
