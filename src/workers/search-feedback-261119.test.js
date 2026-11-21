/**
 * Dan's 11/19/26 Teams notes, Worker side.
 */
import { describe, it, expect } from 'vitest';
import {
  findStandardLookupResults, unknownEditionNote, baseEdition, editionYear,
  collectSupersessionContext, collectIesStatements, statementNotice, handleSearch,
} from './search';
import { acronymFacts, expandQuery, cleanQuery } from '../lib/query-expander';
import { generateResponse, statementOpening, ensureStatementOpening } from '../lib/ai-summary';
import { isStaffSession } from './session';

// ─── #7: staff searches are told apart, as a class ───────────────────────────

describe('isStaffSession (11/19/26 #7)', () => {
  const member = { roles: ['member', 'lighting-library-full-access'] };
  const plain = { admin: false, role: 'member' };

  it('recognizes IES staff by any of the three routes', () => {
    expect(isStaffSession({ roles: ['administrator'] }, { admin: true, role: 'member' }, {})).toBe(true);   // IdP administrator
    expect(isStaffSession(member, { admin: true, role: 'admin' }, {})).toBe(true);                          // admin invitation
    expect(isStaffSession(member, { admin: false, role: 'staff' }, {})).toBe(true);                         // staff invitation
    expect(isStaffSession({ roles: ['member', 'ies-staff'] }, plain, {})).toBe(true);                       // IdP staff role
  });

  it('leaves readers alone', () => {
    expect(isStaffSession(member, plain, {})).toBe(false);
    expect(isStaffSession(member, { admin: false, role: 'guest' }, {})).toBe(false);
    expect(isStaffSession({ roles: [] }, { admin: false }, {})).toBe(false);
    expect(isStaffSession({ roles: ['tc-chair'] }, plain, {})).toBe(false);
  });

  it('takes the staff role slugs from LENSY_STAFF_ROLES when set', () => {
    const env = { LENSY_STAFF_ROLES: ' hq-team , Administrator ' };
    expect(isStaffSession({ roles: ['hq-team'] }, plain, env)).toBe(true);
    expect(isStaffSession({ roles: ['ies-staff'] }, plain, env)).toBe(false);
    expect(isStaffSession({ roles: ['administrator'] }, plain, env)).toBe(true);
  });
});

// ─── #1: "the bug rating is a measure of the attractiveness … to insects" ────

describe('BUG is an acronym, not an insect (11/19/26 #1)', () => {
  it('tells the Guide what the letters stand for whenever the query means the rating', () => {
    for (const q of ['Is the bug rating still applicable', '"Is the bug rating still applicable',
      'what is a BUG rating?', 'bug ratings for LZ2', 'B.U.G. limits', 'BUG', 'bug values in tm-15',
      'what do bugs have to do with uplight']) {
      const facts = acronymFacts(q);
      expect(facts, q).toHaveLength(1);
      expect(facts[0]).toContain('Backlight, Uplight and Glare');
      expect(facts[0]).toContain('nothing to do with insects');
    }
  });

  it('leaves insect questions, and every other question, alone', () => {
    for (const q of ['lighting that attracts fewer bugs', 'bug zapper lamps', 'insect attraction to LEDs',
      'debugging a lighting control system', 'office lighting', 'glare rating']) {
      expect(acronymFacts(q), q).toEqual([]);
    }
  });

  it('steers retrieval to where the acronym lives', () => {
    const expanded = expandQuery('Is the bug rating still applicable');
    for (const word of ['backlight', 'uplight', 'glare', 'tm-15']) expect(expanded).toContain(word);
    expect(expandQuery('lighting that attracts fewer bugs')).not.toContain('backlight');
  });

  it('drops a stray quotation mark around the whole query', () => {
    expect(cleanQuery('"Is the bug rating still applicable')).toBe(cleanQuery('Is the bug rating still applicable'));
    expect(cleanQuery('“office lighting”')).toBe('office lighting');
    expect(cleanQuery('"')).toBe('"');
  });
});

describe('IES Statements reach the reader and the Guide (11/19/26 #1)', () => {
  const TITLE = 'IES Statement on TM-15 Zonal Lumen Classification and BUG Ratings';
  const TEXT = 'The Illuminating Engineering Society (IES) recognizes the expertise of our technical committees. '
    + 'An informative annex, commonly known as the BUG (Backlight, Uplight, and Glare) rating system, was last '
    + 'published as Annex A of ANSI/IES TM-15-20. IES is no longer pursuing revisions to the BUG rating system as '
    + 'previously defined. Until updated guidance is completed and released, IES recommends continued reference to '
    + 'Annex A of ANSI/IES TM-15-20 where BUG ratings are utilized.';
  const STANDARDS = [
    { id: 'TM-15-20', full_designation: 'ANSI/IES TM-15-20', vitrium_web_url: 'https://view.protectedpdf.com/X9kxEC',
      statements_json: JSON.stringify([{ title: TITLE, page: 2, date: 'September 29, 2026', text: TEXT }]),
      page_labels_json: JSON.stringify(['a', 'b', 'i', 'ii', '1', '2']) },
  ];
  const envWith = (rows, { failStatements = false } = {}) => ({
    DB: {
      prepare(sql) {
        const stmt = {
          _args: [],
          bind(...args) { stmt._args = args; return stmt; },
          async all() {
            if (/statements_json IS NOT NULL/.test(sql)) {
              if (failStatements) throw new Error('no such column: statements_json');
              return { results: rows };
            }
            if (/SELECT id, page_labels_json/.test(sql)) return { results: rows.filter(r => stmt._args.includes(r.id)) };
            throw new Error(`unexpected SQL: ${sql}`);
          },
        };
        return stmt;
      },
    },
  });

  it('finds the Statement for the question the client asked, whatever was retrieved', async () => {
    const found = await collectIesStatements(envWith(STANDARDS), 'Is the bug rating still applicable',
      [{ application: { standard: 'RP-27.1-22' } }]);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      standard: 'TM-15-20', designation: 'ANSI/IES TM-15-20', title: TITLE, page: 2, pageLabel: 'b',
      location: 'inside the front cover', matched: 'query', date: 'September 29, 2026',
      // Branded Library host, on the Statement's own page.
      url: 'https://lighting.ies.org/X9kxEC#page=2',
    });
    expect(found[0].text).toContain('no longer pursuing revisions');
  });

  it('finds it when TM-15-20 is among the standards the answer is written from', async () => {
    const found = await collectIesStatements(envWith(STANDARDS), 'uplight limits for outdoor luminaires',
      [{ application: { standard: 'RP-43-25' } }, { application: { standard: 'TM-15-20' } }]);
    expect(found.map(f => f.matched)).toEqual(['results']);
  });

  it('stays out of unrelated searches, and survives a database without the column', async () => {
    expect(await collectIesStatements(envWith(STANDARDS), 'office lighting', [{ application: { standard: 'RP-1-24' } }])).toEqual([]);
    expect(await collectIesStatements(envWith(STANDARDS, { failStatements: true }), 'bug rating', [])).toEqual([]);
  });

  it('prints a notice the banner can link', async () => {
    const [s] = await collectIesStatements(envWith(STANDARDS), 'bug rating', []);
    const notice = statementNotice(s);
    expect(notice).toContain(`ANSI/IES TM-15-20 carries the “${TITLE}” (September 29, 2026), printed inside the front cover`);
    expect(notice).toMatch(/\[Open the Statement in the Library\]\(https:\/\/lighting\.ies\.org\/X9kxEC#page=2\)$/);
  });

  it('hands the Guide the whole Statement, with the rule to lead with it', async () => {
    let prompt = '';
    const ai = { run: async (_model, opts) => { prompt = opts.messages[1].content; return { response: 'ok answer citing ANSI/IES TM-15-20.' }; } };
    const results = [{
      application: { fullName: 'TM-15-20', category: 'TM-15-20', standard: 'TM-15-20', standardFull: 'ANSI/IES TM-15-20' },
      citation: 'ANSI/IES TM-15-20, p. a', excerpt: { text: 'IES Statement on TM-15 Zonal Lumen Classification and BUG Ratings' },
    }];
    await generateResponse(ai, 'Is the bug rating still applicable', results, {
      facts: acronymFacts('Is the bug rating still applicable'),
      statements: [{ title: TITLE, printedIn: 'ANSI/IES TM-15-20', location: 'inside the front cover', date: 'September 29, 2026', text: TEXT }],
    });
    expect(prompt).toContain('IES STATEMENTS');
    expect(prompt).toContain(`"${TITLE}" — printed inside the front cover of ANSI/IES TM-15-20, dated September 29, 2026.`);
    expect(prompt).toContain('IES is no longer pursuing revisions to the BUG rating system');
    // The opening is composed by code and copied by the model; summing the
    // Statement up in a verdict is forbidden.
    expect(prompt).toContain(`Opening sentence to copy: The Illuminating Engineering Society addresses this in the "${TITLE}" (September 29, 2026), printed inside the front cover of ANSI/IES TM-15-20.`);
    expect(prompt).toContain('your answer BEGINS with a paragraph about it');
    expect(prompt).toContain('never sum the Statement up in a verdict');
    expect(prompt).toContain('REPLACES the "FIRST SENTENCE" rule');
    expect(prompt).toContain('Backlight, Uplight and Glare');
    expect(prompt).toContain('NEVER DEFINE WHAT THE SOURCES DO NOT DEFINE');
    // The Statement comes before the instructions, after the results.
    expect(prompt.indexOf('IES STATEMENTS')).toBeGreaterThan(prompt.indexOf('Search Results'));
    expect(prompt.indexOf('IES STATEMENTS')).toBeLessThan(prompt.indexOf('Instructions — write a GUIDE'));
  });

  const STATEMENT = { title: TITLE, printedIn: 'ANSI/IES TM-15-20', location: 'inside the front cover', date: 'September 29, 2026', text: TEXT };
  const OPENING = `The Illuminating Engineering Society addresses this in the "${TITLE}" (September 29, 2026), printed inside the front cover of ANSI/IES TM-15-20.`;
  const RESULT = [{
    application: { fullName: 'TM-15-20', category: 'TM-15-20', standard: 'TM-15-20', standardFull: 'ANSI/IES TM-15-20' },
    citation: 'ANSI/IES TM-15-20, p. a', excerpt: { text: 'x' },
  }];
  const answering = (response) => ({ run: async () => ({ response }) });

  it('composes the opening sentence itself', () => {
    expect(statementOpening(STATEMENT)).toBe(OPENING);
    // No date, and a page that is not the inside cover.
    expect(statementOpening({ ...STATEMENT, date: null, location: 'on p. 5' }))
      .toBe(`The Illuminating Engineering Society addresses this in the "${TITLE}", printed on p. 5 of ANSI/IES TM-15-20.`);
    // A page that only opens "The Illuminating Engineering Society recognizes…" has no title to quote,
    // and a title too long to quote under the 15-word limit is not quoted either.
    expect(statementOpening({ ...STATEMENT, title: 'IES Statement' })).toContain('addresses this in the "IES Statement" (');
    expect(statementOpening({ ...STATEMENT, title: `IES Statement on ${'a very long subject '.repeat(5)}` })).toContain('addresses this in an IES Statement (');
  });

  // The measured failure (11/20/26): the model opened with a verdict of its own.
  it('puts the opening back when the model opens with something else', async () => {
    const verdict = 'The bug rating is still applicable, but its use is no longer recommended by IES. ANSI/IES TM-15-20 covers it.';
    const out = await generateResponse(answering(verdict), 'Is the bug rating still applicable', RESULT,
      { statements: [{ ...STATEMENT, lead: true }] });
    expect(out.text.startsWith(`${OPENING}\n\n`)).toBe(true);
    expect(out.text).toContain(verdict);
    expect(out.degraded).toBeUndefined();
  });

  it('leaves an answer that already opens with the Statement exactly as written', async () => {
    const good = `${OPENING} IES recommends continued reference to Annex A of ANSI/IES TM-15-20 where BUG ratings are utilized. The Statement itself gives the full wording.`;
    const out = await generateResponse(answering(good), 'Is the bug rating still applicable', RESULT,
      { statements: [{ ...STATEMENT, lead: true }] });
    expect(out.text).toBe(good);
    expect(ensureStatementOpening(good, [{ ...STATEMENT, lead: true }])).toBe(good);
  });

  it('holds the opening only for a Statement the query itself reached', async () => {
    // Its standard is merely among the results: the model decides whether it bears on the question.
    const other = 'Uplight limits for LZ1 are listed in ANSI/IES TM-15-20.';
    const out = await generateResponse(answering(other), 'uplight limits', RESULT, { statements: [STATEMENT] });
    expect(out.text).toBe(other);
    expect(ensureStatementOpening('', [{ ...STATEMENT, lead: true }])).toBe('');
  });

  it('adds nothing to the prompt of a search with no Statement', async () => {
    let prompt = '';
    const ai = { run: async (_model, opts) => { prompt = opts.messages[1].content; return { response: 'ok' }; } };
    await generateResponse(ai, 'office lighting', [{ application: { fullName: 'Office', standard: 'RP-1-24', standardFull: 'ANSI/IES RP-1-24' }, citation: 'x', excerpt: { text: 'y' } }]);
    expect(prompt).not.toContain('IES STATEMENTS');
  });
});

const row = (id, status, superseded_by = null, extra = {}) => ({
  id, title: `Title of ${id.split('-').slice(0, 2).join('-')}`,
  full_designation: `ANSI/IES ${id.replace(/\+R(\d{4})/, '(R$1)')}`,
  description: null, author: null, status, superseded_by,
  vitrium_web_url: `https://lighting.ies.org/${id.replace(/[^A-Za-z0-9]/g, '')}`,
  collection: null, thumbnail_url: null, buy_url: null, ...extra,
});

const ROWS = [
  row('TM-30-24+E1', 'Active'),
  row('TM-30-20', 'Deprecated', 'TM-30-24'),
  row('TM-30-18', 'Deprecated', 'TM-30-24'),
  row('TM-30-15', 'Deprecated', 'TM-30-18'),
  // A reaffirmed printing and the printing it reaffirms: one document.
  row('LP-4-20+R2026', 'Active'),
  row('LP-4-20', 'Deprecated', 'LP-4-20+R2026'),
  // A family merged into another standard.
  row('LP-2-20', 'Deprecated', 'RP-43-25'),
  row('LP-2-17', 'Deprecated', 'LP-2-20'),
  row('RP-43-25', 'Active'),
  row('RP-43-22', 'Deprecated', 'RP-43-25'),
];

function fakeEnv(rows = ROWS) {
  return {
    DB: {
      prepare(sql) {
        const stmt = {
          _args: [],
          bind(...args) { stmt._args = args; return stmt; },
          async all() {
            if (/WHERE UPPER\(id\) = \? OR UPPER\(id\) LIKE \?/.test(sql)) {
              const [id, like] = stmt._args;
              const prefix = String(like).replace(/%$/, '');
              return { results: rows.filter(r => r.id.toUpperCase() === id || r.id.toUpperCase().startsWith(prefix)) };
            }
            if (/WHERE UPPER\(id\) = \?/.test(sql)) {
              return { results: rows.filter(r => r.id.toUpperCase() === stmt._args[0]) };
            }
            if (/status = 'Deprecated' AND superseded_by IN/.test(sql)) {
              return { results: rows.filter(r => r.status === 'Deprecated' && stmt._args.includes(r.superseded_by)) };
            }
            if (/WHERE id IN/.test(sql)) {
              return { results: rows.filter(r => stmt._args.includes(r.id)) };
            }
            throw new Error(`unexpected SQL: ${sql}`);
          },
        };
        return stmt;
      },
    },
  };
}

describe('a designation IES never published (11/19/26 #2)', () => {
  it('"TM-30-22" lists every published edition: current first, then deprecated newest to oldest', async () => {
    const out = await findStandardLookupResults(fakeEnv(), 'TM-30-22');
    expect(out.map(r => r.document.id)).toEqual(['TM-30-24+E1', 'TM-30-20', 'TM-30-18', 'TM-30-15']);
    expect(out.map(r => !!r.isDeprecated)).toEqual([false, true, true, true]);
    expect(out.every(r => r.resultType === 'standard')).toBe(true);
    // Every deprecated card says what is current today, not what replaced it then.
    expect(out[3].deprecationNotice).toContain('replaced by TM-30-24+E1');
    // The cards remember what was asked for, so the note can say it.
    expect(out[0].document.requestedEdition).toBe('TM-30-22');
  });

  it('writes a catalogue note naming what was typed and what exists', async () => {
    const note = unknownEditionNote(await findStandardLookupResults(fakeEnv(), 'tm-30-22'));
    expect(note.text).toContain('TM-30-22');
    expect(note.text).toContain('ANSI/IES TM-30-24');
    expect(note.text).toContain('ANSI/IES TM-30-20');
    expect(note.text).toMatch(/current/i);
    expect(note.disclaimer).toBe('Lighting Library catalogue note.');
  });

  it('an edition that exists is answered exactly as before, with no such note', async () => {
    const exact = await findStandardLookupResults(fakeEnv(), 'TM-30-24');
    expect(exact.map(r => r.document.id)).toEqual(['TM-30-24+E1']);
    expect(exact[0].relevanceScore).toBe(1);
    expect(unknownEditionNote(exact)).toBeNull();

    const deprecated = await findStandardLookupResults(fakeEnv(), 'TM-30-20');
    expect(deprecated.map(r => r.document.id)).toEqual(['TM-30-24+E1', 'TM-30-20']);
    expect(unknownEditionNote(deprecated)).toBeNull();
  });

  it('a family alone still answers with the current edition only', async () => {
    const out = await findStandardLookupResults(fakeEnv(), 'TM-30');
    expect(out.map(r => r.document.id)).toEqual(['TM-30-24+E1']);
  });

  it('a merged family: the successor first, then every edition of the family asked for', async () => {
    const out = await findStandardLookupResults(fakeEnv(), 'LP-2-22');
    expect(out.map(r => r.document.id)).toEqual(['RP-43-25', 'LP-2-20', 'LP-2-17']);
    expect(out[1].isDeprecated).toBe(true);
  });

  it('a family the catalogue does not hold answers nothing', async () => {
    expect(await findStandardLookupResults(fakeEnv(), 'TM-99-22')).toEqual([]);
  });

  it('never lists a reaffirmed printing beside the printing it reaffirms', async () => {
    // "LP-4-22" does not exist; LP-4-20 and LP-4-20(R2026) are one document.
    const out = await findStandardLookupResults(fakeEnv(), 'LP-4-22');
    expect(out.map(r => r.document.id)).toEqual(['LP-4-20+R2026']);
  });

  it('"LP-4-20" is the current reaffirmed document, not a deprecated edition of itself', async () => {
    const out = await findStandardLookupResults(fakeEnv(), 'LP-4-20');
    expect(out.map(r => r.document.id)).toEqual(['LP-4-20+R2026']);
    expect(out[0].isDeprecated).toBeFalsy();
    expect(out[0].relevanceScore).toBe(1);
  });
});

describe('ids carrying +R#### and stacked errata', () => {
  it('reduces every printing to its edition', () => {
    expect(baseEdition('LP-4-20+R2026')).toBe('LP-4-20');
    expect(baseEdition('LS-4-20+R2023+E1')).toBe('LS-4-20');
    expect(baseEdition('TM-39-25+E1+E2')).toBe('TM-39-25');
    // …and still the forms it already read.
    expect(baseEdition('RP-8-25+E2')).toBe('RP-8-25');
    expect(baseEdition('LM-63-19R25')).toBe('LM-63-19');
    expect(baseEdition('LS-2-20(R2023)')).toBe('LS-2-20');
    expect(baseEdition('RP-8-18')).toBe('RP-8-18');
  });

  it('reads the edition year past those markers', () => {
    expect(editionYear('LP-4-20+R2026')).toBe(2020);
    expect(editionYear('LS-4-20+R2023+E1')).toBe(2020);
    expect(editionYear('TM-39-25+E1+E2')).toBe(2025);
    expect(editionYear('RP-8-99')).toBe(1999);
  });

  it('a reaffirmation is not a merger: no "now includes the content of" notice', async () => {
    const results = [{ application: { standard: 'LP-4-20+R2026' } }];
    const ctx = await collectSupersessionContext(fakeEnv(), 'electric light sources', results);
    expect(ctx.notices).toEqual([]);
    expect(ctx.facts).toEqual([]);
  });

  it('a real merger still produces one', async () => {
    const results = [{ application: { standard: 'RP-43-25' } }];
    const ctx = await collectSupersessionContext(fakeEnv(), 'pedestrian lighting', results);
    expect(ctx.notices.join(' ')).toContain('LP-2-20');
  });
});

// ─── #3 and #7, through the handler itself ───────────────────────────────────

describe('handleSearch: a tool question, asked with the staff bearer', () => {
  const makeEnv = () => {
    const inserts = [];
    return {
      inserts,
      // ENVIRONMENT unset: outside production any bearer authenticates (lib/auth.ts).
      SESSIONS: { get: async () => null, put: async () => {} },
      DB: {
        prepare(sql) {
          const stmt = {
            bind(...args) { stmt.args = args; return stmt; },
            async run() { inserts.push({ sql, args: stmt.args }); return { meta: { changes: 1 } }; },
            async all() { return { results: [] }; },
            async first() { return null; },
          };
          return stmt;
        },
      },
    };
  };
  const ask = async (env, query) => {
    const request = new Request('http://localhost/api/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test' },
      body: JSON.stringify({ query, includeAISummary: true }),
    });
    const res = await handleSearch(request, env, { waitUntil() {} });
    return { status: res.status, body: await res.json() };
  };

  it('answers "where are the illuminance tables?" with the tool and its page, not with standards', async () => {
    const env = makeEnv();
    const { status, body } = await ask(env, 'where are the illuminance tables?');
    expect(status).toBe(200);
    expect(body.helpAnswer).toBe(true);
    expect(body.results).toEqual([]);
    expect(body.aiSummary.text.startsWith('**List Illuminance Tables** — ')).toBe(true);
    expect(body.aiSummary.disclaimer).toBe('About the tools of IES Lens and the Lighting Library.');
    expect(body.helpLinks[0]).toMatchObject({ title: 'List Illuminance Tables', url: 'https://lens.ies.org/illuminance-tables' });
  });

  it('answers the retired Illuminance Selector with the transition tutorial', async () => {
    const { body } = await ask(makeEnv(), 'where is the illuminance selector tool?');
    expect(body.aiSummary.text).toContain('which IES is retiring');
    expect(body.helpLinks[0].url).toBe('https://lens.ies.org/tutorials/whats-new');
  });

  it('logs the search as staff, with no attempt number (the bearer is nobody\'s session)', async () => {
    const env = makeEnv();
    await ask(env, 'what is the compare versions tool');
    await new Promise(r => setTimeout(r, 0));
    const insert = env.inserts.find(i => /INSERT INTO search_log/.test(i.sql));
    expect(insert.sql).toContain('audience, attempt');
    expect(insert.args.slice(-2)).toEqual(['staff', null]);
    expect(insert.args[0]).toBe('what is the compare versions tool');
  });

  it('a database without migration 0031 still gets the row, with the columns it has', async () => {
    const env = makeEnv();
    const prepare = env.DB.prepare;
    env.DB.prepare = (sql) => {
      const stmt = prepare(sql);
      if (/INSERT INTO search_log/.test(sql) && /audience/.test(sql)) {
        stmt.run = async () => { throw new Error('D1_ERROR: table search_log has no column named audience'); };
      }
      return stmt;
    };
    await ask(env, 'compare versions');
    await new Promise(r => setTimeout(r, 0));
    const insert = env.inserts.find(i => /INSERT INTO search_log/.test(i.sql));
    expect(insert.sql).toContain('tier, ai_guide');
    expect(insert.sql).not.toContain('audience');
  });
});
