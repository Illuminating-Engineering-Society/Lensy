import { describe, it, expect } from 'vitest';
import {
  routineGroupOf, buildThemePrompt, parseThemes, buildAssignPrompt, parseAssignment,
  rankThemes, groupQueries, ROUTINE_GROUPS,
} from './trending-topics';

// Dan, Teams 11/19/26 #8: themes that point to trends and problems to solve,
// not the building type the search happened to name.

const q = (query, searches = 1) => ({ query, searches });

describe('routineGroupOf — what needs no model', () => {
  it('reads a bare designation as a standard lookup', () => {
    for (const s of ['TM-30-22', 'RP-8-25+E2', 'rp-11-26', 'ANSI/IES RP-1-24', 'LS-4-20(R2023)', 'ASHRAE-IES-90.1-2025', 'RP-8']) {
      expect(routineGroupOf(s), s).toBe('Standard Lookups');
    }
  });
  it('reads a suggestion-launched row as an illuminance lookup', () => {
    expect(routineGroupOf('RP-8-25+E2 Drive Aisles / Parking Areas > All Parking Lots')).toBe('Illuminance Lookups');
  });
  it('reads a platform question as one', () => {
    expect(routineGroupOf('where is the illuminance selector tool?')).toBe('Platform & Account');
    expect(routineGroupOf('how do I renew my Lighting Library subscription?')).toBe('Platform & Account');
    expect(routineGroupOf('what is IES Lens?')).toBe('Platform & Account');
  });
  // The searches below are from the production log (11/20/26).
  it('reads a plain light-level lookup as one, by its own words', () => {
    for (const s of ['OFFICE', 'Desk', 'exam room', 'courthouse detainee cell', 'what are the light levels for a lobby',
      'how should I light a k-12 classroom?', 'how much light do I need for a sidewalk?', 'recommended illuminance for kitchen tasks',
      'how many footcandles does ies recommend for a flag?', 'What are considerations for lighting hospital patient rooms',
      'lighting for water treatment plants', 'IES recommendations for Soccer outdoor', 'how to light a football field for a high shool']) {
      expect(routineGroupOf(s), s).toBe('Illuminance Lookups');
    }
  });
  it('leaves anything that carries a subject of its own to the model', () => {
    for (const s of ['melanopic EDI targets for night shift nurses', 'TM-30 Rf for retail', 'flicker from PWM dimming',
      'illuminance and light trespass recommendations for a parking lot', 'what are the recommended UGR level for offices',
      'can lighting controls reduce brightness of outdoor lights after curfew?', 'RECOMMENDED LLF FOR EXTERIOR LIGHTING',
      'How do I determine what CCT to choose for an interior lighting layout?', 'how to measure glare', 'control protocols',
      'exterior lighting zones', 'what is the recommended retrofit for a T8 fluorescent?', 'class of play categories',
      'What lighting level in footcandles should I use to light a dark oil painting and are there any conservation concerns',
      'Is the human circadian rhythm an important consideration in lighting design?', 'what standards did matthew hartley help author']) {
      expect(routineGroupOf(s), s).toBeNull();
    }
  });
});

describe('pass 1 — the themes', () => {
  it('asks for trends and problems with evidence, and forbids building types', () => {
    const p = buildThemePrompt([q('flicker from PWM dimming'), q('office')]);
    expect(p).toContain('RESEARCH TRENDS, DESIGN AND ENGINEERING TRENDS and PROBLEMS TO SOLVE');
    expect(p).toContain('NOT a building type');
    expect(p).toContain('NOT a catch-all');
    expect(p).toContain('"evidence"');
    expect(p).toContain('1. flicker from PWM dimming');
    expect(p).toContain('2. office');
  });

  it('keeps named themes with their signal, and refuses building types and standards', () => {
    const themes = parseThemes(`Sure: {"themes": [
      {"name": "Circadian & Melanopic Metrics", "signal": "Designers want melanopic targets for shift work."},
      {"name": "Offices", "signal": "x"},
      {"name": "Roadway Lighting", "signal": "x"},
      {"name": "RP-8", "signal": "x"},
      {"name": "circadian & melanopic metrics", "signal": "duplicate"},
      {"name": "Illuminance Lookups", "signal": "routine, not a theme"},
      {"name": "Illuminance Levels & Metrics", "signal": "the lookups again"},
      {"name": "Office Lighting Guidelines", "signal": "a building type with a suffix"},
      {"name": "Parking Lot Lighting", "signal": "another"},
      {"name": "Stadium Retrofits", "type": "space", "signal": "labelled a space by the model itself"},
      "Temporal Light Artifacts & Flicker",
      {"name": "", "signal": "nameless"}
    ]}`);
    expect(themes.map(t => t.name)).toEqual(['Circadian & Melanopic Metrics', 'Temporal Light Artifacts & Flicker']);
    expect(themes[0].signal).toBe('Designers want melanopic targets for shift work.');
    expect(themes[1].signal).toBe('');
  });

  // Every name below came back from the 70B model on the production log (11/20/26).
  it('refuses the catch-alls and the spaces-with-extra-words the model writes anyway', () => {
    const names = ['Lighting For Specific Applications', 'Lighting For Special Applications', 'Pedestrian And Roadway Lighting',
      'Lighting For Healthcare And Wellness', 'Pedestrian Walkways', 'Lighting For Outdoor Spaces', 'Lighting Standards And Regulations'];
    const themes = parseThemes(JSON.stringify({ themes: names.map(name => ({ name, type: 'design', signal: 's' })) }));
    expect(themes).toEqual([]);
    // …and keeps the real ones from the same runs.
    const kept = ['Exterior Lighting Zones', 'Lighting Controls', 'Light Loss Factor', 'Light Trespass', 'Emergency Lighting',
      'Circadian Rhythm', 'Glare And UGR', 'Color Temperature'];
    expect(parseThemes(JSON.stringify({ themes: kept.map(name => ({ name })) })).map(t => t.name)).toEqual(kept);
  });

  it('wants two of the queries it was shown as evidence for each theme', () => {
    const answer = JSON.stringify({ themes: [
      { name: 'Light Trespass', evidence: [4, 158], signal: 's' },
      { name: 'Sky Glow, Wildlife & Dark Sky', evidence: [], signal: 'recited from the prompt' },
      { name: 'Temporal Light Artifacts & Flicker', signal: 'no evidence at all' },
      { name: 'Aging Eyes & Low Vision', evidence: [7], signal: 'one query is not a trend' },
      { name: 'UV & Photobiological Safety', evidence: [999, 1000], signal: 'numbers it was never shown' },
      { name: 'Lighting Controls', evidence: ['5', 18, 18], signal: 's' },
    ] });
    expect(parseThemes(answer, 200).map(t => t.name)).toEqual(['Light Trespass', 'Lighting Controls']);
    // Without a count there is nothing to check the numbers against.
    expect(parseThemes(answer)).toHaveLength(6);
  });

  it('reads JSON the way the model writes it: trailing commas, or cut off mid-list', () => {
    // One real run in three ended the list with a comma.
    const trailing = '{"themes": [\n{"name": "Light Loss Factor", "type": "design", "evidence": [12, 17], "signal": "s"},\n{"name": "Commissioning", "evidence": [188, 192], "signal": "s"},\n]}';
    expect(parseThemes(trailing, 300).map(t => t.name)).toEqual(['Light Loss Factor', 'Commissioning']);
    const cutOff = '{"themes": [{"name": "Light Loss Factor", "evidence": [12, 17], "signal": "s"}, {"name": "Lighting Controls", "evidence": [5, 18], "signal": "s"}, {"name": "Glare And U';
    expect(parseThemes(cutOff, 300).map(t => t.name)).toEqual(['Light Loss Factor', 'Lighting Controls']);
  });

  it('returns nothing for an unusable answer', () => {
    expect(parseThemes('I cannot help with that.')).toEqual([]);
    expect(parseThemes('{"themes": "none"}')).toEqual([]);
    expect(parseThemes(null)).toEqual([]);
  });
});

describe('pass 2 — placing the queries', () => {
  const themes = [{ name: 'Flicker', signal: 's1' }, { name: 'Dark Sky', signal: '' }];

  it('lists the themes and the routine groups by code, and asks for one line per query', () => {
    const p = buildAssignPrompt(themes, [q('pwm flicker'), q('office')]);
    expect(p).toContain('T1. Flicker — s1');
    expect(p).toContain('T2. Dark Sky');
    expect(p).toContain('R1 = Illuminance Lookups');
    expect(p).toContain('When in doubt, use R4');
    expect(p).toContain('2. office');
    expect(p).toMatch(/1=T3\n2=R1\n3=R4$/);
  });

  it('reads one line per query', () => {
    const placed = parseAssignment('1=T1\n2 = t2\n3=R4\n4=T9\n5=X1\n1=T2\n99=T1\n', 2, 5);
    expect([...placed]).toEqual([[0, 'T1'], [1, 'T2'], [2, 'R4']]);
    // …also when the model runs them together or adds words.
    expect([...parseAssignment('Here you go: 1=T2, 2=R1; 3=T1', 2, 3)]).toEqual([[0, 'T2'], [1, 'R1'], [2, 'T1']]);
  });

  it('still reads the grouped JSON form: known codes only, each query once', () => {
    const placed = parseAssignment('{"T1": [1, 1, 3], "t2": [2], "T9": [4], "R1": [4, 99, 0], "X1": [5], "R4": [3]}', 2, 5);
    expect([...placed]).toEqual([[0, 'T1'], [2, 'T1'], [1, 'T2'], [3, 'R1']]);
  });

  it('survives an unusable answer', () => {
    expect(parseAssignment('nope', 2, 5).size).toBe(0);
  });
});

describe('rankThemes — counts come from the log', () => {
  const themes = [{ name: 'Flicker', signal: 'PWM dimming complaints.' }, { name: 'Dark Sky', signal: '' }, { name: 'One-Off', signal: '' }];
  const placed = [
    { query: q('pwm flicker', 4), code: 'T1' },
    { query: q('stroboscopic effect', 1), code: 'T1' },
    { query: q('sky glow limits', 9), code: 'T2' },
    { query: q('wildlife friendly lighting', 2), code: 'T2' },
    { query: q('a single odd question', 1), code: 'T3' },
    { query: q('office', 30), code: 'R1' },
    { query: q('RP-8', 5), code: 'R2' },
  ];

  it('ranks themes by searches and never lets a routine lookup compete', () => {
    const { topics, routine } = rankThemes(themes, placed);
    expect(topics.map(t => [t.topic, t.searches, t.queries])).toEqual([['Dark Sky', 11, 2], ['Flicker', 5, 2]]);
    expect(topics[1].signal).toBe('PWM dimming complaints.');
    expect(topics[0].examples[0]).toBe('sky glow limits');
    // 30 "office" searches are reported — in their own line.
    expect(routine.map(r => [r.topic, r.searches])).toEqual([['Illuminance Lookups', 30], ['Standard Lookups', 5]]);
  });

  it('a single query asked once is not a trend', () => {
    expect(rankThemes(themes, placed).topics.map(t => t.topic)).not.toContain('One-Off');
  });
});

describe('groupQueries — the two passes together', () => {
  const queries = [
    q('OFFICE', 11), q('corridor', 10), q('TM-30-22', 5),
    q('flicker from PWM dimming', 2), q('stroboscopic effect in a gym', 1),
    q('where is the illuminance selector tool?', 2), q('sky glow ordinance limits', 3), q('turtle friendly lighting', 1),
    q('a question about something else entirely here', 1),
  ];
  const isPass1 = (prompt) => /identify the THEMES/i.test(prompt);
  // Open queries, in order: 1 flicker…, 2 stroboscopic…, 3 sky glow…, 4 turtle…, 5 a question about…
  const THEMES = '{"themes":['
    + '{"name":"Temporal Light Artifacts & Flicker","type":"problem","evidence":[1,2],"signal":"Dimming artefacts."},'
    + '{"name":"Sky Glow, Wildlife & Dark Sky","type":"problem","evidence":[3,4],"signal":"Ordinances."},]}';

  it('classifies routine queries by rule and asks the model about the rest', async () => {
    const prompts = [];
    const runModel = async (prompt) => {
      prompts.push(prompt);
      return { model: 'm', text: isPass1(prompt) ? THEMES : '1=T1\n2=T1\n3=T2\n4=T2\n5=R4' };
    };
    const out = await groupQueries(queries, runModel);
    // The designation, the platform question and the bare spaces never reached the model.
    expect(prompts[0]).not.toContain('TM-30-22');
    expect(prompts[0]).not.toContain('illuminance selector');
    expect(prompts[0]).not.toMatch(/^\d+\. OFFICE$/m);
    expect(prompts[0]).not.toMatch(/^\d+\. corridor$/m);
    expect(prompts[0]).toMatch(/^1\. flicker from PWM dimming$/m);
    expect(out.topics.map(t => [t.topic, t.searches])).toEqual([
      ['Sky Glow, Wildlife & Dark Sky', 4], ['Temporal Light Artifacts & Flicker', 3],
    ]);
    expect(Object.fromEntries(out.routine.map(r => [r.topic, r.searches]))).toEqual({
      'Illuminance Lookups': 21, 'Standard Lookups': 5, 'Platform & Account': 2, Other: 1,
    });
    expect(out.placed).toBe(9);
  });

  it('gives up (keeping the previous ranking) when pass 1 gives no usable answer', async () => {
    expect(await groupQueries(queries, async () => null)).toBeNull();
    expect(await groupQueries(queries, async () => ({ model: 'm', text: 'no json' }))).toBeNull();
  });

  it('a window of nothing but lookups is a result, not a failure', async () => {
    // The model answered, and none of what it proposed survives: the open
    // queries are counted as Other and the routine counts stand.
    const runModel = async () => ({ model: 'm', text: '{"themes": [{"name": "Offices", "evidence": [1, 2]}]}' });
    const out = await groupQueries(queries, runModel);
    expect(out.topics).toEqual([]);
    expect(Object.fromEntries(out.routine.map(r => [r.topic, r.searches]))).toEqual({
      'Illuminance Lookups': 21, 'Standard Lookups': 5, 'Platform & Account': 2, Other: 8,
    });
  });

  it('still reports the routine counts when a placing batch fails', async () => {
    const runModel = async (prompt) => (isPass1(prompt) ? { model: 'm', text: THEMES } : null);
    const out = await groupQueries(queries, runModel);
    expect(out.topics).toEqual([]);
    expect(out.routine.map(r => r.topic)).toEqual(['Illuminance Lookups', 'Standard Lookups', 'Platform & Account']);
  });

  it('labels the open queries in batches of 50, in parallel', async () => {
    const many = Array.from({ length: 120 }, (_, i) => q(`glare complaint number ${i} in a retrofit`));
    let batches = 0;
    const runModel = async (prompt) => {
      if (isPass1(prompt)) return { model: 'm', text: '{"themes":[{"name":"Glare Complaints","evidence":[1,2],"signal":"s"}]}' };
      batches++;
      return { model: 'm', text: [...prompt.matchAll(/^(\d+)\. /gm)].map(m => `${m[1]}=T1`).join('\n') };
    };
    const out = await groupQueries(many, runModel);
    expect(batches).toBe(3);
    expect(out.topics).toEqual([expect.objectContaining({ topic: 'Glare Complaints', searches: 120, queries: 120 })]);
  });

  it('needs no model when every query is routine', async () => {
    const out = await groupQueries([q('RP-8', 3), q('TM-30-24', 1)], async () => { throw new Error('must not be called'); });
    expect(out.model).toBe('rules');
    expect(out.routine).toEqual([{ topic: 'Standard Lookups', searches: 4, queries: 2, examples: ['RP-8', 'TM-30-24'] }]);
  });

  it('names the routine groups in a fixed order', () => {
    expect(ROUTINE_GROUPS).toEqual(['Illuminance Lookups', 'Standard Lookups', 'Platform & Account', 'Other']);
  });
});
