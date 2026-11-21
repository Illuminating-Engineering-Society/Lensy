import { describe, it, expect } from 'vitest';
import {
  detectIesStatements, parseStatements, statementTopics, queryNamesStatement,
  pickStatements, statementLocation,
} from './ies-statements.js';

// TM-15-20 as extracted from the production PDF (11/20/26), pages 1–3.
const COVER = ['ANSI/IES TM-15-20', 'TECHNICAL MEMORANDUM:', 'LUMINAIRE CLASSIFICATION SYSTEM',
  'FOR OUTDOOR LUMINAIRES', 'AN AMERICAN NATIONAL STANDARD', 'www.ies.org'];
const STATEMENT = [
  'IES Statement on TM-15 Zonal Lumen Classification and BUG Ratings',
  'The Illuminating Engineering Society (IES) recognizes the expertise of our technical committees',
  'and the standards they develop to advance the lighting profession. As lighting technology and',
  'application practices continue to evolve, we also recognize the importance of providing clarity',
  'regarding legacy methods and the evolution of recommended practice.',
  'The zonal lumen classification within ANSI/IES TM-15 remains an important method for testing',
  'and evaluating luminaire performance. An informative annex, commonly known as the BUG',
  '(Backlight, Uplight, and Glare) rating system, was last published as Annex A of ANSI/IES TM-15-',
  '20. Developed to categorize zonal lumen data into a simplified framework for evaluating',
  'backlight, uplight, and glare, BUG ratings reflected the characteristics and design priorities of',
  'the lighting technologies prevalent at the time.',
  'September 29, 2026',
];
const TITLE_PAGE = ['ANSI/IES TM-15-20', 'TECHNICAL MEMORANDUM:', 'Publication of this Technical Memorandum',
  'has been approved by the IES.', 'Prepared by:', 'The IES Testing Procedures Committee'];
const page = (number, lines) => ({ number, lines: lines.map(text => ({ text })) });
const PAGES = [page(1, COVER), page(2, STATEMENT), page(3, TITLE_PAGE)];
const TITLE = 'IES Statement on TM-15 Zonal Lumen Classification and BUG Ratings';

describe('detectIesStatements', () => {
  it('reads the Statement inside the front cover of TM-15-20, whole', () => {
    const found = detectIesStatements(PAGES);
    expect(found).toHaveLength(1);
    expect(found[0].title).toBe(TITLE);
    expect(found[0].page).toBe(2);
    expect(found[0].date).toBe('September 29, 2026');
    expect(found[0].text.startsWith('The Illuminating Engineering Society (IES) recognizes')).toBe(true);
    // What the Guide needed and never saw.
    expect(found[0].text).toContain('BUG (Backlight, Uplight, and Glare) rating system');
    // A designation cut by the line break is whole again.
    expect(found[0].text).toContain('Annex A of ANSI/IES TM-15-20.');
    expect(found[0].text).not.toContain('September 29');
  });

  it('accepts the opening sentence alone, with no heading', () => {
    const found = detectIesStatements([page(4, STATEMENT.slice(1))]);
    expect(found).toHaveLength(1);
    expect(found[0].title).toBe('IES Statement');
  });

  it('leaves ordinary pages alone', () => {
    expect(detectIesStatements([page(1, COVER), page(3, TITLE_PAGE)])).toEqual([]);
    // The same words deep in running prose are a sentence, not a Statement.
    const prose = ['1.0 Introduction', 'Outdoor lighting has changed.', 'Many factors apply.', 'Zones are defined below.',
      'Luminaires are classified by zone.', 'Further detail follows.',
      'The Illuminating Engineering Society (IES) recognizes the expertise of its committees.',
      ...STATEMENT.slice(2)];
    expect(detectIesStatements([page(9, prose)])).toEqual([]);
    // A contents line naming the Statement is not the Statement.
    expect(detectIesStatements([page(5, ['Contents', `${TITLE} .......... 2`, '1.0 Scope .......... 3'])])).toEqual([]);
  });

  it('reads plain-text pages too', () => {
    expect(detectIesStatements([{ number: 2, text: STATEMENT.join('\n') }])).toHaveLength(1);
  });
});

describe('parseStatements', () => {
  const stored = JSON.stringify(detectIesStatements(PAGES));
  it('round-trips what the ingest stores', () => {
    expect(parseStatements(stored)).toHaveLength(1);
    expect(parseStatements(stored)[0].page).toBe(2);
  });
  it('answers [] for anything it cannot vouch for', () => {
    expect(parseStatements(null)).toEqual([]);
    expect(parseStatements('not json')).toEqual([]);
    expect(parseStatements('{"title":"x"}')).toEqual([]);
    expect(parseStatements([{ title: 'IES Statement on X', page: 2, text: 'too short' }])).toEqual([]);
    expect(parseStatements([{ title: '', page: 2, text: 'x'.repeat(400) }])).toEqual([]);
  });
});

describe('which searches reach a Statement', () => {
  it('reads the title: words, acronyms as printed, families', () => {
    const t = statementTopics(TITLE);
    expect(t.families).toEqual(['TM-15']);
    expect(t.acronyms).toEqual(['BUG']);
    expect(t.words).toEqual(expect.arrayContaining(['zonal', 'lumen', 'classification', 'bug', 'rating']));
  });

  it('matches the questions the client asked', () => {
    for (const q of ['Is the bug rating still applicable', '"Is the bug rating still applicable',
      'what is a BUG rating', 'are bug ratings being replaced?', 'TM-15 zonal lumens', 'tm-15-20',
      'zonal lumen classification']) {
      expect(queryNamesStatement(q, TITLE), q).toBe(true);
    }
  });

  it('does not answer an insect question, or any rating, with it', () => {
    for (const q of ['lighting that does not attract bugs', 'bug zapper lamps', 'IP rating for wet locations',
      'glare rating of a sports luminaire', 'TM-150 method', 'RP-8 roadway classification']) {
      expect(queryNamesStatement(q, TITLE), q).toBe(false);
    }
  });

  const catalogue = [{ standardId: 'TM-15-20', statements: parseStatements(JSON.stringify(detectIesStatements(PAGES))) }];

  it('picks a Statement the query names, whatever the results were', () => {
    const picked = pickStatements({ query: 'is the bug rating still applicable', leadingStandards: ['RP-43-25'], catalogue });
    expect(picked).toHaveLength(1);
    expect(picked[0].standardId).toBe('TM-15-20');
    expect(picked[0].matched).toBe('query');
  });

  it('picks the Statement of a standard the answer will be written from', () => {
    const picked = pickStatements({ query: 'uplight limits for luminaires', leadingStandards: ['RP-43-25', 'tm-15-20'], catalogue });
    expect(picked.map(p => p.matched)).toEqual(['results']);
  });

  it('picks nothing for an unrelated search', () => {
    expect(pickStatements({ query: 'office lighting', leadingStandards: ['RP-1-24'], catalogue })).toEqual([]);
    expect(pickStatements({ query: 'office lighting', leadingStandards: [], catalogue: [] })).toEqual([]);
  });
});

describe('statementLocation', () => {
  it('calls the page after the cover what IES calls it', () => {
    expect(statementLocation(2, 'b')).toBe('inside the front cover');
    expect(statementLocation(14, '5')).toBe('on p. 5');
    expect(statementLocation(14, null)).toBe('on p. 14');
  });
});
