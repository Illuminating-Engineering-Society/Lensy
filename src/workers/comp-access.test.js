/**
 * 90-day complimentary document access (src/workers/comp-access.ts) — client
 * DO110, the backend of /admin#comp-access.
 *
 * What matters here: every endpoint sits behind the admin gate; a grant naming
 * a document that is not in the corpus is refused as a SET rather than half
 * applied; the 90-day window is computed (and recomputed from an override) the
 * way the recipient's email prints it; a bulk create reports per recipient like
 * the invite endpoint; the list fails soft when migration 0020 has not been
 * applied; and the CSV cannot be turned into a spreadsheet formula.
 */

import { describe, it, expect } from 'vitest';
import {
  handleAdminCompAccess, handleAdminCompAccessCsv, resolveWindow,
  parseRecipients, effectiveGrantStatus,
} from './comp-access';

// ─── Stubs ─────────────────────────────────────────────────────────────────────

/**
 * SQL-shape-routed D1 stub. `route(sql, bindings)` returns rows for .all()
 * (wrapped in {results}), the row for .first(), or a {meta} for .run();
 * throwing inside route simulates a missing table.
 */
function makeDb(route) {
  const calls = [];
  return {
    calls,
    prepare(sql) {
      const stmt = {
        sql,
        bindings: [],
        bind(...b) { stmt.bindings = b; calls.push({ sql, bindings: b }); return stmt; },
        async first() { return route(sql, stmt.bindings) ?? null; },
        async all() { return { results: route(sql, stmt.bindings) || [] }; },
        async run() { return route(sql, stmt.bindings) || { meta: { last_row_id: 1, changes: 1 } }; },
      };
      return stmt;
    },
  };
}

const CATALOG = [
  {
    id: 'RP-8-25+E2', full_designation: 'ANSI/IES RP-8-25+E2',
    title: 'Recommended Practice: Lighting Roadway and Parking Facilities',
    status: 'Active', vitrium_web_url: 'https://view.protectedpdf.com/2H4QTw',
  },
  {
    id: 'RP-27-20+E1', full_designation: 'ANSI/IES RP-27-20+E1',
    title: 'Photobiological Safety for Lamps', status: 'Deprecated',
    vitrium_web_url: 'https://view.protectedpdf.com/9ZZZZZ',
  },
  // A standard whose cover could not be read: the ingest writes title = id.
  { id: 'LM-75-19', full_designation: 'IES LM-75-19', title: 'LM-75-19', status: 'Active', vitrium_web_url: null },
];

function makeEnv(route, opts = {}) {
  const sent = [];
  return {
    sent,
    DB: makeDb(route),
    SESSIONS: { get: async () => null, put: async () => {} },
    SEND_EMAIL: opts.noEmailBinding ? undefined : {
      async send(msg) {
        if (opts.failEmail) throw new Error('E_RECIPIENT_SUPPRESSED: bounced before');
        sent.push(msg);
      },
    },
    // ENVIRONMENT deliberately unset: outside production the bearer check
    // accepts any Authorization header (src/lib/auth.ts), which is how every
    // worker test authenticates.
  };
}

/** Routes everything the handlers ask for; `grants` is the queue's contents. */
function makeRoute(grants = []) {
  let nextId = 100;
  return function route(sql) {
    if (/FROM standards/.test(sql)) return CATALOG;
    if (/INSERT INTO comp_access_grants/.test(sql)) return { meta: { last_row_id: nextId++ } };
    if (/UPDATE comp_access_grants/.test(sql)) return { meta: { changes: 1 } };
    if (/FROM comp_access_grants WHERE id = \?/.test(sql)) return grants[0] ?? null;
    if (/FROM comp_access_grants/.test(sql)) return grants;
    throw new Error(`unrouted SQL: ${sql}`);
  };
}

async function call(handler, env, path, init = {}) {
  const { headers = { Authorization: 'Bearer test' }, body, method = 'GET' } = init;
  const request = new Request(`http://localhost${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const url = new URL(request.url);
  const res = await handler(request, env, url);
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const GRANT_ROW = {
  id: 7, created_at: '2026-09-18 10:00:00', email: 'student@example.edu', name: 'A Student',
  standard_ids: '["RP-8-25+E2","RP-27-20+E1"]', start_date: '2026-09-18', end_date: '2026-12-17',
  days: 90, created_by: 'staff@ies.org', notes: 'Lighting 201', status: 'active',
  notify_sent: 1, notify_sent_at: '2026-09-18 10:00:05', notify_error: null,
  vitrium_applied_at: null, vitrium_applied_by: null, revoked_at: null, revoked_by: null,
};

// ─── Auth ──────────────────────────────────────────────────────────────────────

describe('gate', () => {
  it('refuses a request with neither bearer nor session', async () => {
    const env = makeEnv(makeRoute());
    const list = await call(handleAdminCompAccess, env, '/api/admin/comp-access', { headers: {} });
    expect([401, 403, 503]).toContain(list.status);
    const csv = await call(handleAdminCompAccessCsv, env, '/api/admin/comp-access.csv', { headers: {} });
    expect([401, 403, 503]).toContain(csv.status);
  });
});

// ─── Window arithmetic ─────────────────────────────────────────────────────────

describe('resolveWindow', () => {
  it('defaults to 90 days from the start date', () => {
    expect(resolveWindow({ start_date: '2026-09-18' }))
      .toEqual({ startDate: '2026-09-18', endDate: '2026-12-17', days: 90 });
  });

  it('recomputes days from an end-date override, so the email agrees with the dates', () => {
    expect(resolveWindow({ start_date: '2026-09-18', days: 90, end_date: '2026-10-18' }))
      .toEqual({ startDate: '2026-09-18', endDate: '2026-10-18', days: 30 });
  });

  it('refuses a malformed or impossible date', () => {
    expect(resolveWindow({ start_date: '18/09/2026' })).toHaveProperty('error');
    expect(resolveWindow({ start_date: '2026-02-30' })).toHaveProperty('error');
    expect(resolveWindow({ start_date: '2026-09-18', end_date: '2026-09-17' })).toHaveProperty('error');
    expect(resolveWindow({ start_date: '2026-09-18', days: 0 })).toHaveProperty('error');
    expect(resolveWindow({ start_date: '2026-09-18', days: 5000 })).toHaveProperty('error');
  });
});

describe('parseRecipients', () => {
  it('accepts the single-user form and both CSV shapes', () => {
    expect(parseRecipients({ email: 'one@example.com', name: 'One' }))
      .toEqual([{ email: 'one@example.com', name: 'One' }]);
    expect(parseRecipients({ recipients: ['a@example.com', 'b@example.com'] }))
      .toEqual([{ email: 'a@example.com', name: null }, { email: 'b@example.com', name: null }]);
    expect(parseRecipients({ recipients: [{ email: 'c@example.com', name: 'Cee' }] }))
      .toEqual([{ email: 'c@example.com', name: 'Cee' }]);
  });
});

describe('effectiveGrantStatus', () => {
  it('derives expiry from the end date, and revoked always wins', () => {
    expect(effectiveGrantStatus({ status: 'active', end_date: '2026-12-17' }, '2026-09-18')).toBe('active');
    expect(effectiveGrantStatus({ status: 'active', end_date: '2026-09-17' }, '2026-09-18')).toBe('expired');
    expect(effectiveGrantStatus({ status: 'revoked', end_date: '2026-12-17' }, '2026-09-18')).toBe('revoked');
  });
});

// ─── Create ────────────────────────────────────────────────────────────────────

describe('POST /api/admin/comp-access', () => {
  const base = {
    standard_ids: ['RP-8-25+E2', 'RP-27-20+E1'],
    start_date: '2026-09-18',
  };

  it('creates one row per recipient and emails each of them', async () => {
    const env = makeEnv(makeRoute());
    const { status, body } = await call(handleAdminCompAccess, env, '/api/admin/comp-access', {
      method: 'POST',
      body: { ...base, recipients: ['One@Example.com', { email: 'two@example.com', name: 'Two' }] },
    });
    expect(status).toBe(201);
    expect(body.created).toHaveLength(2);
    // Normalized on the way in, like an invite.
    expect(body.created[0].email).toBe('one@example.com');
    expect(body.window).toEqual({ startDate: '2026-09-18', endDate: '2026-12-17', days: 90 });
    expect(body.emailed.sent).toBe(2);
    expect(env.sent).toHaveLength(2);
    // The client asked for full designations, titles and a link per standard.
    expect(env.sent[0].subject).toMatch(/90-day access to 2 IES standards/);
    expect(env.sent[0].text).toContain('ANSI/IES RP-8-25+E2 Recommended Practice: Lighting Roadway and Parking Facilities');
    // Branded host only — Vitrium's own viewer host would meet an auth error.
    expect(env.sent[0].text).toContain('https://lighting.ies.org/2H4QTw');
    expect(env.sent[0].text).not.toContain('protectedpdf.com');
  });

  it('allows a deprecated edition, which the client explicitly asked for', async () => {
    const env = makeEnv(makeRoute());
    const { status, body } = await call(handleAdminCompAccess, env, '/api/admin/comp-access', {
      method: 'POST',
      body: { standard_ids: ['RP-27-20+E1'], recipients: ['one@example.com'] },
    });
    expect(status).toBe(201);
    expect(body.documents[0].status).toBe('Deprecated');
  });

  it('rejects a bad recipient and a repeat without losing the good ones', async () => {
    const env = makeEnv(makeRoute());
    const { body } = await call(handleAdminCompAccess, env, '/api/admin/comp-access', {
      method: 'POST',
      body: { ...base, recipients: ['good@example.com', 'not-an-email', 'GOOD@example.com'] },
    });
    expect(body.created.map(c => c.email)).toEqual(['good@example.com']);
    expect(body.rejected).toHaveLength(2);
    expect(body.rejected[0].reason).toMatch(/Invalid or missing email/);
    expect(body.rejected[1].reason).toMatch(/Duplicate/);
  });

  it('refuses the whole request when any document is not in the corpus', async () => {
    const env = makeEnv(makeRoute());
    const { status, body } = await call(handleAdminCompAccess, env, '/api/admin/comp-access', {
      method: 'POST',
      body: { standard_ids: ['RP-8-25+E2', 'RP-999-99'], recipients: ['one@example.com'] },
    });
    expect(status).toBe(400);
    expect(body.unknownStandardIds).toEqual(['RP-999-99']);
    // Nothing was written, and nobody was told about a document IES never enabled.
    expect(env.DB.calls.some(c => /INSERT INTO comp_access_grants/.test(c.sql))).toBe(false);
    expect(env.sent).toHaveLength(0);
  });

  it('refuses a request with no documents or no recipients', async () => {
    const env = makeEnv(makeRoute());
    const noDocs = await call(handleAdminCompAccess, env, '/api/admin/comp-access', {
      method: 'POST', body: { recipients: ['one@example.com'] },
    });
    expect(noDocs.status).toBe(400);
    const noPeople = await call(handleAdminCompAccess, env, '/api/admin/comp-access', {
      method: 'POST', body: base,
    });
    expect(noPeople.status).toBe(400);
  });

  it('records a mail failure on the row rather than failing the grant', async () => {
    const env = makeEnv(makeRoute(), { failEmail: true });
    const { status, body } = await call(handleAdminCompAccess, env, '/api/admin/comp-access', {
      method: 'POST', body: { ...base, recipients: ['one@example.com'] },
    });
    expect(status).toBe(201);
    expect(body.created).toHaveLength(1);
    expect(body.emailed.sent).toBe(0);
    expect(body.emailed.failed[0].error).toMatch(/E_RECIPIENT_SUPPRESSED/);
    const bookkeeping = env.DB.calls.find(c => /UPDATE comp_access_grants/.test(c.sql) && /notify_error/.test(c.sql));
    expect(bookkeeping).toBeDefined();
  });

  it('skips the mail entirely on notify:false', async () => {
    const env = makeEnv(makeRoute());
    const { body } = await call(handleAdminCompAccess, env, '/api/admin/comp-access', {
      method: 'POST', body: { ...base, recipients: ['one@example.com'], notify: false },
    });
    expect(body.emailed.skipped).toBe(true);
    expect(env.sent).toHaveLength(0);
  });
});

// ─── List ──────────────────────────────────────────────────────────────────────

describe('GET /api/admin/comp-access', () => {
  it('resolves the stored ids to designations and counts the Vitrium backlog', async () => {
    const env = makeEnv(makeRoute([GRANT_ROW]));
    const { status, body } = await call(handleAdminCompAccess, env, '/api/admin/comp-access');
    expect(status).toBe(200);
    expect(body.grants).toHaveLength(1);
    expect(body.grants[0].documents.map(d => d.designation))
      .toEqual(['ANSI/IES RP-8-25+E2', 'ANSI/IES RP-27-20+E1']);
    expect(body.counts.all).toBe(1);
    // Not applied in Vitrium yet — the one number staff act on.
    expect(body.counts.pendingVitrium).toBe(1);
    expect(body.note).toBeUndefined();
  });

  it('fails soft when migration 0020 has not been applied', async () => {
    const env = makeEnv(() => { throw new Error('no such table: comp_access_grants'); });
    const { status, body } = await call(handleAdminCompAccess, env, '/api/admin/comp-access');
    expect(status).toBe(200);
    expect(body.grants).toEqual([]);
    expect(body.counts.all).toBe(0);
    expect(body.note).toMatch(/migration 0020/);
  });

  it('keeps a document that has since left the corpus', async () => {
    const row = { ...GRANT_ROW, standard_ids: '["RP-999-99"]' };
    const env = makeEnv(makeRoute([row]));
    const { body } = await call(handleAdminCompAccess, env, '/api/admin/comp-access');
    expect(body.grants[0].documents[0]).toMatchObject({ id: 'RP-999-99', status: 'unknown' });
  });
});

// ─── Update ────────────────────────────────────────────────────────────────────

describe('PATCH /api/admin/comp-access/:id', () => {
  it('revokes a grant, stamping who and when', async () => {
    const env = makeEnv(makeRoute([GRANT_ROW]));
    const { status } = await call(handleAdminCompAccess, env, '/api/admin/comp-access/7', {
      method: 'PATCH', body: { status: 'revoked', by: 'staff@ies.org' },
    });
    expect(status).toBe(200);
    const update = env.DB.calls.find(c => /UPDATE comp_access_grants SET status/.test(c.sql));
    expect(update.bindings.slice(0, 3)).toEqual(['revoked', expect.any(String), 'staff@ies.org']);
  });

  it('marks the manual Vitrium step done, and lets it be undone', async () => {
    const env = makeEnv(makeRoute([GRANT_ROW]));
    await call(handleAdminCompAccess, env, '/api/admin/comp-access/7', {
      method: 'PATCH', body: { vitrium_applied: true, by: 'staff@ies.org' },
    });
    const applied = env.DB.calls.find(c => /vitrium_applied_at = \?/.test(c.sql));
    expect(applied.bindings[0]).toEqual(expect.any(String));
    expect(applied.bindings[1]).toBe('staff@ies.org');

    const env2 = makeEnv(makeRoute([GRANT_ROW]));
    await call(handleAdminCompAccess, env2, '/api/admin/comp-access/7', {
      method: 'PATCH', body: { vitrium_applied: false },
    });
    const cleared = env2.DB.calls.find(c => /vitrium_applied_at = \?/.test(c.sql));
    expect(cleared.bindings.slice(0, 2)).toEqual([null, null]);
  });

  it('re-sends the notification', async () => {
    const env = makeEnv(makeRoute([GRANT_ROW]));
    const { status, body } = await call(handleAdminCompAccess, env, '/api/admin/comp-access/7', {
      method: 'PATCH', body: { resend: true },
    });
    expect(status).toBe(200);
    expect(body.resent).toBe(true);
    expect(env.sent).toHaveLength(1);
    expect(env.sent[0].to).toBe('student@example.edu');
  });

  it('refuses to re-announce a revoked grant', async () => {
    const env = makeEnv(makeRoute([{ ...GRANT_ROW, status: 'revoked' }]));
    const { status, body } = await call(handleAdminCompAccess, env, '/api/admin/comp-access/7', {
      method: 'PATCH', body: { resend: true },
    });
    expect(status).toBe(409);
    expect(body.error).toMatch(/revoked/);
    expect(env.sent).toHaveLength(0);
  });

  it('refuses an empty patch and an unknown id', async () => {
    const env = makeEnv(makeRoute([GRANT_ROW]));
    const empty = await call(handleAdminCompAccess, env, '/api/admin/comp-access/7', {
      method: 'PATCH', body: {},
    });
    expect(empty.status).toBe(400);

    const missing = makeEnv(makeRoute([]));
    const gone = await call(handleAdminCompAccess, missing, '/api/admin/comp-access/7', {
      method: 'PATCH', body: { status: 'revoked' },
    });
    expect(gone.status).toBe(404);
  });
});

// ─── CSV ───────────────────────────────────────────────────────────────────────

describe('GET /api/admin/comp-access.csv', () => {
  async function csv(env, path = '/api/admin/comp-access.csv') {
    const request = new Request(`http://localhost${path}`, { headers: { Authorization: 'Bearer test' } });
    const res = await handleAdminCompAccessCsv(request, env);
    return { status: res.status, text: await res.text(), type: res.headers.get('Content-Type') };
  }

  it('exports the grant with its designations spelled out', async () => {
    const env = makeEnv(makeRoute([GRANT_ROW]));
    const { status, text, type } = await csv(env);
    expect(status).toBe(200);
    expect(type).toMatch(/text\/csv/);
    const [header, row] = text.split('\r\n');
    expect(header.startsWith('id,created_at,email,name,standards')).toBe(true);
    expect(row).toContain('ANSI/IES RP-8-25+E2 Recommended Practice: Lighting Roadway and Parking Facilities');
    expect(row).toContain('student@example.edu');
  });

  it('neutralizes a cell that Excel would run as a formula, and doubles quotes', async () => {
    const env = makeEnv(makeRoute([{
      ...GRANT_ROW,
      name: '=HYPERLINK("http://evil","click")',
      notes: 'said "urgent", twice',
    }]));
    const { text } = await csv(env);
    const row = text.split('\r\n')[1];
    expect(row).toContain(`"'=HYPERLINK(""http://evil"",""click"")"`);
    expect(row).toContain('"said ""urgent"", twice"');
  });

  it('exports an empty file rather than a 500 when the table is missing', async () => {
    const env = makeEnv(() => { throw new Error('no such table: comp_access_grants'); });
    const { status, text } = await csv(env);
    expect(status).toBe(200);
    expect(text.split('\r\n')).toHaveLength(1);       // header only
  });
});
