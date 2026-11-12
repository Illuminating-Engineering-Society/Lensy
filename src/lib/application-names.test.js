import { describe, it, expect } from 'vitest';
import {
  buildApplicationNames,
  pinnedApplicationCodes,
  pinApplicationsFirst,
  MAX_PINNED_APPLICATIONS,
} from './application-names';
// A classic browser script: importing it registers globalThis.LensApplicationSuggest.
import '../frontend/utils/application-suggest.js';

const { prepareIndex, suggestApplications, visibleLevels, highlightParts, MAX_PINNED_CODES } =
  globalThis.LensApplicationSuggest;

// Rows as they sit in production D1 (sampled 2026-11-11).
const ROWS = [
  { code: 'RP1020E2_0076', Standard: 'RP-10-20+E2', App: 'Transition Circulation Spaces', App_s1: 'Lobbies, Atria', App_s2: 'Circulation, elevator lobbies', App_s3: 'Reception desk' },
  { code: 'RP1126_0071', Standard: 'RP-11-26', App: 'Reading and writing', App_s1: 'Desk' },
  { code: 'RP220E1_0020', Standard: 'RP-2-20+E1', App: 'Shopping Mall, Interior', App_s1: 'Information Desks', App_s2: 'Min' },
  { code: 'RP220E1_0021', Standard: 'RP-2-20+E1', App: 'Shopping Mall, Interior', App_s1: 'Information Desks', App_s2: 'Max' },
  { code: 'RP923_0048', Standard: 'RP-9-23', App: 'Guest Room', App_s1: 'Reading', App_s2: 'Desk' },
  { code: 'RP923_0093', Standard: 'RP-9-23', App: 'Transition Spaces', App_s1: 'Lobbies', App_s2: 'General' },
  { code: 'RP923_0094', Standard: 'RP-9-23', App: 'Transition Spaces', App_s1: 'Lobbies', App_s2: 'Reception lobbies', App_s3: 'Desktop' },
  { code: 'RP923_0095', Standard: 'RP-9-23', App: 'Transition Spaces', App_s1: 'Lobbies', App_s2: 'Reception lobbies', App_s3: 'Focal wall behind desk' },
  { code: 'RP426_0004', Standard: 'RP-4-26', App: 'Library Proper', App_s1: 'Circulation, information, lending desk', App_s2: 'Self-service' },
  { code: 'RP426_0005', Standard: 'RP-4-26', App: 'Library Proper', App_s1: 'Circulation, information, lending desk', App_s2: 'Staffed' },
];

const index = () => prepareIndex(buildApplicationNames(ROWS));
const labels = (list) => list.map(s => s.query);

describe('buildApplicationNames', () => {
  it('carries names only: code, standard and the hierarchy path', () => {
    const payload = buildApplicationNames([
      { code: 'RP923_0094', Standard: 'RP-9-23', App: 'Transition Spaces', App_s1: 'Lobbies', App_s2: null, App_s3: ' Desktop ', Hor_Lux: 300, Page_Number: 42 },
    ]);
    expect(payload).toEqual({
      standards: ['RP-9-23'],
      groups: [],
      applications: [{ c: 'RP923_0094', s: 0, p: ['Transition Spaces', 'Lobbies', 'Desktop'] }],
    });
  });

  it('carries each table banner once, indexed by the rows under it', () => {
    const payload = buildApplicationNames([
      { code: 'RP923_0048', Standard: 'RP-9-23', Sub_Category: 'INTERIOR - HOSPITALITY', App: 'Guest Room' },
      { code: 'RP923_0110', Standard: 'RP-9-23', Sub_Category: 'EXTERIOR - HOSPITALITY', App: 'Pools, Outdoor' },
      { code: 'RP923_0049', Standard: 'RP-9-23', Sub_Category: ' INTERIOR -  HOSPITALITY ', App: 'Gaming' },
      { code: 'RP923_0050', Standard: 'RP-9-23', App: 'No banner' },
    ]);
    expect(payload.groups).toEqual(['INTERIOR - HOSPITALITY', 'EXTERIOR - HOSPITALITY']);
    expect(payload.applications.map(a => a.g)).toEqual([0, 1, 0, undefined]);
  });

  it('lists each standard once and skips rows with no code, standard or path', () => {
    const payload = buildApplicationNames([
      ...ROWS,
      { code: '', Standard: 'RP-9-23', App: 'X' },
      { code: 'A_1', Standard: null, App: 'X' },
      { code: 'A_2', Standard: 'RP-9-23' },
    ]);
    expect(payload.standards).toEqual(['RP-10-20+E2', 'RP-11-26', 'RP-2-20+E1', 'RP-9-23', 'RP-4-26']);
    expect(payload.applications).toHaveLength(ROWS.length);
  });
});

describe('suggestApplications', () => {
  it('prints designation, then the path down to the matched application', () => {
    const [first] = suggestApplications(index(), 'desktop');
    expect(first.query).toBe('RP-9-23 Transition Spaces > Lobbies > Reception lobbies > Desktop');
    expect(first.codes).toEqual(['RP923_0094']);
  });

  it('ranks the exact name first, then names that start with it, then the rest', () => {
    const got = labels(suggestApplications(index(), 'desk', 20));
    expect(got.slice(0, 2).sort()).toEqual([
      'RP-11-26 Reading and writing > Desk',
      'RP-9-23 Guest Room > Reading > Desk',
    ]);
    expect(got[2]).toBe('RP-9-23 Transition Spaces > Lobbies > Reception lobbies > Desktop');
    expect(got).toContain('RP-10-20+E2 Transition Circulation Spaces > Lobbies, Atria > Circulation, elevator lobbies > Reception desk');
  });

  it('lists an application once when its rows differ only below the match', () => {
    const got = suggestApplications(index(), 'information desks');
    // The exact name leads; "desks" also reaches RP-4's "… lending desk".
    expect(labels(got)).toEqual([
      'RP-2-20+E1 Shopping Mall, Interior > Information Desks',
      'RP-4-26 Library Proper > Circulation, information, lending desk',
    ]);
    expect(got[0].codes).toEqual(['RP220E1_0020', 'RP220E1_0021']);
    expect(got[0].rowCount).toBe(2);
  });

  it('matches the start of a word, not the middle of one', () => {
    expect(suggestApplications(index(), 'esk')).toEqual([]);
    expect(labels(suggestApplications(index(), 'lend'))).toEqual([
      'RP-4-26 Library Proper > Circulation, information, lending desk',
    ]);
  });

  it('requires every typed word, wherever in the hierarchy it sits', () => {
    expect(labels(suggestApplications(index(), 'guest desk'))).toEqual(['RP-9-23 Guest Room > Reading > Desk']);
    expect(suggestApplications(index(), 'guest stadium')).toEqual([]);
  });

  it('a group suggestion also pins the rows that matched deeper under it', () => {
    const got = suggestApplications(index(), 'lobb', 20);
    const lobbies = got.find(s => s.query === 'RP-9-23 Transition Spaces > Lobbies');
    expect(lobbies.codes).toEqual(['RP923_0093', 'RP923_0094', 'RP923_0095']);
    const reception = got.find(s => s.query === 'RP-9-23 Transition Spaces > Lobbies > Reception lobbies');
    expect(reception.codes).toEqual(['RP923_0094', 'RP923_0095']);
  });

  it('never pins more rows than the search accepts', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({
      code: `RP825E2_${String(i).padStart(4, '0')}`, Standard: 'RP-8-25+E2', App: 'Parking', App_s1: `Row ${i}`,
    }));
    const [parking] = suggestApplications(prepareIndex(buildApplicationNames(many)), 'parking');
    expect(parking.rowCount).toBe(40);
    expect(parking.codes).toHaveLength(MAX_PINNED_CODES);
    expect(MAX_PINNED_CODES).toBe(MAX_PINNED_APPLICATIONS);
  });

  it('suggests nothing for a single letter, an empty box or an empty index', () => {
    expect(suggestApplications(index(), 'd')).toEqual([]);
    expect(suggestApplications(index(), '   ')).toEqual([]);
    expect(suggestApplications([], 'desk')).toEqual([]);
  });

  it('honours the limit', () => {
    expect(suggestApplications(index(), 'desk', 3)).toHaveLength(3);
  });
});

// The table banner — the top level of the hierarchy (Dan, Teams 11/12/26 #4).
describe('suggestApplications: the top level and everyday words', () => {
  const HOSPITALITY = [
    { code: 'RP923_0001', Standard: 'RP-9-23', Sub_Category: 'INTERIOR - HOSPITALITY', App: 'Ballroom', App_s1: 'Dancing' },
    { code: 'RP923_0030', Standard: 'RP-9-23', Sub_Category: 'INTERIOR - HOSPITALITY', App: 'Gaming', App_s1: 'Slots' },
    { code: 'RP923_0031', Standard: 'RP-9-23', Sub_Category: 'INTERIOR - HOSPITALITY', App: 'Gaming', App_s1: 'Tables' },
    { code: 'RP923_0048', Standard: 'RP-9-23', Sub_Category: 'INTERIOR - HOSPITALITY', App: 'Guest Room', App_s1: 'Reading', App_s2: 'Desk' },
    { code: 'RP923_0093', Standard: 'RP-9-23', Sub_Category: 'INTERIOR - HOSPITALITY', App: 'Transition Spaces', App_s1: 'Lobbies', App_s2: 'General' },
    { code: 'RP923_0110', Standard: 'RP-9-23', Sub_Category: 'EXTERIOR - HOSPITALITY', App: 'Pools, Outdoor', App_s1: 'Deck' },
    { code: 'RP2925_0001', Standard: 'RP-29-25', Sub_Category: 'INTERIOR - HEALTHCARE: HOSPITALS AND AMBULATORY CARE', App: 'Patient Rooms', App_s1: 'General' },
    { code: 'RP1020E2_0076', Standard: 'RP-10-20+E2', Sub_Category: 'INTERIOR - COMMON APPLICATIONS', App: 'Transition Circulation Spaces', App_s1: 'Lobbies, Atria' },
  ];
  const idx = () => prepareIndex(buildApplicationNames(HOSPITALITY));

  it('a word only the banner holds lists the applications under that banner, in table order', () => {
    const got = suggestApplications(idx(), 'hospitality');
    expect(labels(got)).toEqual([
      'RP-9-23 Ballroom', 'RP-9-23 Gaming', 'RP-9-23 Guest Room', 'RP-9-23 Transition Spaces', 'RP-9-23 Pools, Outdoor',
    ]);
    expect(got[1].codes).toEqual(['RP923_0030', 'RP923_0031']);
  });

  it('shows the banner as the first level but keeps it out of the search text', () => {
    const [desk] = suggestApplications(idx(), 'desk');
    expect(desk.levels).toEqual(['INTERIOR - HOSPITALITY', 'Guest Room', 'Reading', 'Desk']);
    expect(desk.query).toBe('RP-9-23 Guest Room > Reading > Desk');
  });

  it('"hotel" stands for Hospitality and "casino" for Gaming', () => {
    expect(labels(suggestApplications(idx(), 'hotel'))).toEqual(labels(suggestApplications(idx(), 'hospitality')));
    expect(labels(suggestApplications(idx(), 'casino'))).toEqual(['RP-9-23 Gaming']);
    expect(labels(suggestApplications(idx(), 'hote'))).toContain('RP-9-23 Guest Room');
  });

  it('a banner word narrows a search without moving where the path is cut', () => {
    expect(labels(suggestApplications(idx(), 'hotel lobby'))).toEqual(['RP-9-23 Transition Spaces > Lobbies']);
    expect(labels(suggestApplications(idx(), 'exterior deck'))).toEqual(['RP-9-23 Pools, Outdoor > Deck']);
  });

  it('a whole word outranks the start of a longer one', () => {
    const got = labels(suggestApplications(idx(), 'hospital'));
    expect(got[0]).toBe('RP-29-25 Patient Rooms');
    expect(got).toContain('RP-9-23 Ballroom');
  });

  it('reads a plural as its singular, both ways', () => {
    expect(labels(suggestApplications(idx(), 'lobby'))).toEqual([
      'RP-9-23 Transition Spaces > Lobbies',
      'RP-10-20+E2 Transition Circulation Spaces > Lobbies, Atria',
    ]);
    expect(labels(suggestApplications(idx(), 'desks'))).toEqual(['RP-9-23 Guest Room > Reading > Desk']);
  });

  it('still works with a payload that carries no banners', () => {
    const rows = prepareIndex({ standards: ['RP-9-23'], applications: [{ c: 'A_1', s: 0, p: ['Gaming', 'Slots'] }] });
    const [got] = suggestApplications(rows, 'casino');
    expect(got.levels).toEqual(['Gaming']);
  });
});

describe('prepareIndex', () => {
  it('skips malformed entries instead of failing the list', () => {
    const rows = prepareIndex({
      standards: ['RP-9-23'],
      applications: [
        { c: 'A_1', s: 0, p: ['Lobbies', 'Desktop'] },
        { c: 'A_2', s: 7, p: ['Orphan'] },
        { c: 'A_3', s: 0, p: [] },
        null,
      ],
    });
    expect(rows.map(r => r.code)).toEqual(['A_1']);
    expect(prepareIndex(null)).toEqual([]);
  });
});

describe('visibleLevels', () => {
  const levels = ['Transition Spaces', 'Lobbies', 'Reception lobbies', 'Desktop'];
  it('drops levels from the top and says so', () => {
    expect(visibleLevels(levels, 0)).toEqual({ levels, truncated: false });
    expect(visibleLevels(levels, 1)).toEqual({ levels: ['Lobbies', 'Reception lobbies', 'Desktop'], truncated: true });
  });
  it('never drops the application name itself', () => {
    expect(visibleLevels(levels, 99)).toEqual({ levels: ['Desktop'], truncated: true });
  });
});

describe('highlightParts', () => {
  it('flags the typed start of each matching word', () => {
    expect(highlightParts('Focal wall behind desk', 'desk')).toEqual([
      { text: 'Focal wall behind ', hit: false },
      { text: 'desk', hit: true },
    ]);
    expect(highlightParts('Desktop', 'desk')).toEqual([
      { text: 'Desk', hit: true },
      { text: 'top', hit: false },
    ]);
  });
  it('flags a plural up to where it agrees with the typed word', () => {
    expect(highlightParts('Lobbies', 'lobby')).toEqual([
      { text: 'Lobb', hit: true },
      { text: 'ies', hit: false },
    ]);
  });
  it('leaves text with no match, or no typed words, whole', () => {
    expect(highlightParts('Lobbies', 'desk')).toEqual([{ text: 'Lobbies', hit: false }]);
    expect(highlightParts('Lobbies', '')).toEqual([{ text: 'Lobbies', hit: false }]);
  });
});

describe('pinnedApplicationCodes', () => {
  it('keeps code-shaped strings, de-duplicated', () => {
    expect(pinnedApplicationCodes({ application_codes: ['RP923_0094', ' RP923_0094 ', 'RP-9-20_1', 'RP1020E2_0076'] }))
      .toEqual(['RP923_0094', 'RP-9-20_1', 'RP1020E2_0076']);
  });
  it('drops anything that is not a row code', () => {
    expect(pinnedApplicationCodes({ application_codes: ["x' OR 1=1 --", 42, null, '', 'a b', 'RP923_0094'] }))
      .toEqual(['RP923_0094']);
  });
  it('caps the list', () => {
    const codes = Array.from({ length: 50 }, (_, i) => `RP923_${String(i).padStart(4, '0')}`);
    expect(pinnedApplicationCodes({ application_codes: codes })).toHaveLength(MAX_PINNED_APPLICATIONS);
  });
  it('answers [] for a missing or malformed field', () => {
    for (const filters of [undefined, null, {}, 'nope', { application_codes: 'RP923_0094' }]) {
      expect(pinnedApplicationCodes(filters)).toEqual([]);
    }
  });
});

describe('pinApplicationsFirst', () => {
  const app = (code, extra = {}) => ({ resultType: 'application', application: { code, ...extra } });
  const results = [
    { resultType: 'definition', application: { code: 'LS-1-DEF-1' } },
    app('RP923_0001'),
    { resultType: 'excerpt', application: { code: 'excerpt:RP-9-23:12' } },
    app('RP923_0094'),
    app('RP4325_0010', { limitRange: { lowerCode: 'RP4325_0010', upperCode: 'RP4325_0011', qualifier: null } }),
  ];

  it('moves the pinned rows to the front and keeps every other order', () => {
    const got = pinApplicationsFirst(results, ['RP923_0094']);
    expect(got.map(r => r.application.code))
      .toEqual(['RP923_0094', 'LS-1-DEF-1', 'RP923_0001', 'excerpt:RP-9-23:12', 'RP4325_0010']);
  });
  it('finds a merged limit-range card by either of its codes', () => {
    expect(pinApplicationsFirst(results, ['RP4325_0011'])[0].application.code).toBe('RP4325_0010');
  });
  it('treats a card with no resultType as an application row', () => {
    const got = pinApplicationsFirst([{ resultType: 'excerpt', application: { code: 'X' } }, { application: { code: 'RP923_0094' } }], ['RP923_0094']);
    expect(got[0].application.code).toBe('RP923_0094');
  });
  it('returns the list untouched when nothing is pinned or nothing matches', () => {
    expect(pinApplicationsFirst(results, [])).toBe(results);
    expect(pinApplicationsFirst(results, ['NOPE_0001'])).toBe(results);
  });
});
