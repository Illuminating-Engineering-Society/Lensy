import { describe, it, expect } from 'vitest';
import { handleStaffComps, compsForEmails } from './staff-comps';

// GET /api/staff/comps (2026-11-13): one person's Lighting Library comps for
// the staff tools (Light Room). Dan: "COMP: each specific document — start
// date, end date, note · COMP: Subscription — start date, end date, note".
// Its own read-only bearer (404 while unset, 401 on a wrong one).

const TODAY = '2026-11-13';

const CATALOG = [
  { id: 'RP-8-25+E2', full_designation: 'ANSI/IES RP-8-25+E2', title: 'Recommended Practice: Lighting Roadway and Parking Facilities' },
  { id: 'RP-27-20', full_designation: 'ANSI/IES RP-27-20', title: 'RP-27-20' },
];

const grant = (over = {}) => ({
  id: 1, created_at: '2026-11-09 15:00:00', email: 'student@example.edu', name: 'Dana Ruiz',
  standard_ids: '["RP-8-25+E2"]', start_date: '2026-11-09', end_date: '2027-02-07',
  created_by: 'staff@ies.org', notes: 'Lighting 201, Fall 2026', status: 'active',
  vitrium_applied_at: '2026-11-09 15:00:02', scope: 'documents',
  ...over,
});

function makeEnv({ grants = [], secret = 's3cret', throws = false } = {}) {
  const calls = [];
  const route = (sql, bindings) => {
    if (throws) throw new Error('no such table: comp_access_grants');
    if (/FROM comp_access_grants/.test(sql)) return grants.filter(g => bindings.includes(g.email));
    if (/FROM standards/.test(sql)) {
      const wanted = bindings.map(b => String(b).toLowerCase());
      return CATALOG.filter(c => wanted.includes(c.id.toLowerCase()));
    }
    throw new Error(`unrouted SQL: ${sql}`);
  };
  return {
    calls,
    STAFF_COMPS_API_SECRET: secret,
    DB: {
      prepare(sql) {
        let bound = [];
        const stmt = {
          bind(...b) { bound = b; calls.push({ sql, bindings: b }); return stmt; },
          async all() { return { results: route(sql, bound) }; },
        };
        return stmt;
      },
    },
  };
}

function req(query = 'email=Student@Example.edu', token = 's3cret') {
  const url = new URL(`https://lens.ies.org/api/staff/comps?${query}`);
  const headers = token === null ? {} : { Authorization: `Bearer ${token}` };
  return [new Request(url, { headers }), url];
}

describe('GET /api/staff/comps', () => {
  it('404s while the secret is unset', async () => {
    const [r, u] = req();
    expect((await handleStaffComps(r, makeEnv({ secret: '' }), u)).status).toBe(404);
  });

  it('401s without or with the wrong bearer', async () => {
    for (const token of [null, 'nope']) {
      const [r, u] = req(undefined, token);
      expect((await handleStaffComps(r, makeEnv(), u)).status).toBe(401);
    }
  });

  it('400s on a missing, malformed or over-long list of emails', async () => {
    for (const query of ['', 'email=not-an-email', 'email=a@b.org,nope']) {
      const [r, u] = req(query);
      expect((await handleStaffComps(r, makeEnv(), u)).status).toBe(400);
    }
    const many = Array.from({ length: 11 }, (_, i) => `email=p${i}@example.org`).join('&');
    const [r, u] = req(many);
    const res = await handleStaffComps(r, makeEnv(), u);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('too_many_emails');
  });

  it('normalizes the address and never caches the answer', async () => {
    const env = makeEnv({ grants: [grant()] });
    const [r, u] = req('email=%20Student@Example.EDU%20');
    const res = await handleStaffComps(r, env, u);
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const body = await res.json();
    expect(body.emails).toEqual(['student@example.edu']);
    expect(body.comps.length).toBe(1);
    expect(env.calls[0].bindings).toEqual(['student@example.edu']);
  });

  it('takes every address a person has — repeated or comma-separated, once each', async () => {
    const env = makeEnv({ grants: [grant(), grant({ id: 2, email: 'dana@firm.com', scope: 'lens', standard_ids: '[]' })] });
    const [r, u] = req('email=student@example.edu&email=dana@firm.com,STUDENT@example.edu');
    const body = await (await handleStaffComps(r, env, u)).json();
    expect(body.emails).toEqual(['student@example.edu', 'dana@firm.com']);
    expect(body.comps.map(c => c.kind)).toEqual(['subscription', 'document']);
  });

  it('answers 500, not an empty list, when the table cannot be read', async () => {
    const [r, u] = req();
    const res = await handleStaffComps(r, makeEnv({ throws: true }), u);
    expect(res.status).toBe(500);
  });
});

describe('compsForEmails', () => {
  const db = (grants) => makeEnv({ grants }).DB;
  const list = (grants, opts = {}) => compsForEmails(db(grants), ['student@example.edu'], { today: TODAY, ...opts });

  it('prints a document comp with its dates, note and who granted it', async () => {
    const [comp] = await list([grant()]);
    expect(comp).toEqual({
      grantId: 1,
      kind: 'document',
      label: 'COMP: ANSI/IES RP-8-25+E2 Recommended Practice: Lighting Roadway and Parking Facilities',
      email: 'student@example.edu',
      name: 'Dana Ruiz',
      standardId: 'RP-8-25+E2',
      designation: 'ANSI/IES RP-8-25+E2',
      title: 'Recommended Practice: Lighting Roadway and Parking Facilities',
      startsAt: '2026-11-09',
      expiresAt: '2027-02-07',
      state: 'active',
      applied: true,
      note: 'Lighting 201, Fall 2026',
      grantedBy: 'staff@ies.org',
      createdAt: '2026-11-09 15:00:00',
    });
  });

  it('lists each document of one grant on its own line', async () => {
    const comps = await list([grant({ standard_ids: '["rp-8-25+e2","RP-27-20","RP-99-01"]' })]);
    // Designation order, numbers read as numbers (RP-8 before RP-27).
    expect(comps.map(c => c.label)).toEqual([
      'COMP: ANSI/IES RP-8-25+E2 Recommended Practice: Lighting Roadway and Parking Facilities',
      'COMP: ANSI/IES RP-27-20',                 // a title that is only the id is not printed
      'COMP: RP-99-01',                          // not in the catalogue any more: still listed
    ]);
    expect(new Set(comps.map(c => c.grantId))).toEqual(new Set([1]));
    expect(comps[0].standardId).toBe('RP-8-25+E2');   // the catalogue's own spelling
  });

  it('prints the subscription comp as "COMP: Subscription", ahead of the documents', async () => {
    const comps = await list([
      grant(),
      grant({ id: 2, scope: 'lens', standard_ids: '[]', start_date: '2026-11-10', end_date: '2026-11-16', notes: 'TC demo' }),
    ]);
    expect(comps.map(c => c.label)).toEqual([
      'COMP: Subscription',
      'COMP: ANSI/IES RP-8-25+E2 Recommended Practice: Lighting Roadway and Parking Facilities',
    ]);
    expect(comps[0]).toMatchObject({
      kind: 'subscription', standardId: null, designation: null, title: null,
      startsAt: '2026-11-10', expiresAt: '2026-11-16', note: 'TC demo', state: 'active',
    });
  });

  it('shows a comp that has not reached the Library instead of hiding it', async () => {
    const [comp] = await list([grant({ vitrium_applied_at: null })]);
    expect(comp.applied).toBe(false);
    expect(comp.state).toBe('active');
  });

  it('keeps what the person holds or is about to hold, and leaves history out by default', async () => {
    const grants = [
      grant({ id: 1 }),
      grant({ id: 2, start_date: '2026-12-01', end_date: '2027-03-01' }),              // scheduled
      grant({ id: 3, start_date: '2026-05-01', end_date: '2026-07-30' }),              // expired
      grant({ id: 4, status: 'revoked' }),                                             // revoked
      grant({ id: 5, start_date: '2026-08-15', end_date: TODAY }),                     // last day, inclusive
      grant({ id: 6, start_date: TODAY, end_date: '2026-11-20' }),                     // first day, inclusive
    ];
    const now = await list(grants);
    expect(now.map(c => [c.grantId, c.state])).toEqual([
      [1, 'active'], [6, 'active'], [5, 'active'], [2, 'scheduled'],
    ]);
    const all = await list(grants, { history: true });
    expect(all.map(c => [c.grantId, c.state])).toEqual([
      [1, 'active'], [6, 'active'], [5, 'active'], [2, 'scheduled'], [3, 'expired'], [4, 'revoked'],
    ]);
  });

  it('treats a row from before the scope column as a document comp', async () => {
    const [comp] = await list([grant({ scope: null })]);
    expect(comp.kind).toBe('document');
  });

  it('survives an unreadable document list and empty optional fields', async () => {
    expect(await list([grant({ standard_ids: 'not json' })])).toEqual([]);
    const [comp] = await list([grant({ name: ' ', notes: null, created_by: '' })]);
    expect(comp).toMatchObject({ name: null, note: null, grantedBy: null });
  });

  it('asks nothing of the database for an empty list of addresses', async () => {
    const env = makeEnv({ grants: [grant()] });
    expect(await compsForEmails(env.DB, [], { today: TODAY })).toEqual([]);
    expect(env.calls.length).toBe(0);
  });
});
