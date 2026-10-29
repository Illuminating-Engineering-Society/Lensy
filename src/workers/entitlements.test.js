import { describe, it, expect } from 'vitest';
import { handleEntitlements } from './entitlements';

// GET /api/entitlements (2026-10-29): ies.org's "My Standards" view. Its own
// read-only bearer (404 while unset, 401 on a wrong one); lists active leases
// and document comps whose window covers today, joined to the catalogue.

const CATALOG = [
  { id: 'RP-8-25+E2', full_designation: 'ANSI/IES RP-8-25+E2', title: 'Roadway Lighting', vitrium_web_url: 'https://view.protectedpdf.com/2H4QTw', thumbnail_url: null },
  { id: 'RP-27-20', full_designation: 'ANSI/IES RP-27-20', title: 'RP-27-20', vitrium_web_url: null, thumbnail_url: 'https://lens.ies.org/c.png' },
];

function makeEnv({ leases = [], comps = [], secret = 's3cret', throws = false } = {}) {
  const calls = [];
  const route = (sql) => {
    if (throws) throw new Error('no such table: purchases');
    if (/FROM purchases/.test(sql)) return leases;
    if (/FROM comp_access_grants/.test(sql)) return comps;
    if (/FROM standards/.test(sql)) return CATALOG;
    throw new Error(`unrouted SQL: ${sql}`);
  };
  return {
    calls,
    ENTITLEMENTS_API_SECRET: secret,
    DB: {
      prepare(sql) {
        const stmt = {
          bind(...b) { calls.push({ sql, bindings: b }); return stmt; },
          async all() { return { results: route(sql) }; },
        };
        return stmt;
      },
    },
  };
}

function req(email = 'Buyer@Example.org', token = 's3cret') {
  const url = new URL(`https://lens.ies.org/api/entitlements?email=${encodeURIComponent(email)}`);
  const headers = token === null ? {} : { Authorization: `Bearer ${token}` };
  return [new Request(url, { headers }), url];
}

describe('GET /api/entitlements', () => {
  it('404s while the secret is unset', async () => {
    const [r, u] = req();
    const res = await handleEntitlements(r, makeEnv({ secret: '' }), u);
    expect(res.status).toBe(404);
  });

  it('401s without or with the wrong bearer', async () => {
    for (const token of [null, 'nope']) {
      const [r, u] = req(undefined, token);
      const res = await handleEntitlements(r, makeEnv(), u);
      expect(res.status).toBe(401);
    }
  });

  it('400s on a missing or malformed email', async () => {
    const [r, u] = req('not-an-email');
    expect((await handleEntitlements(r, makeEnv(), u)).status).toBe(400);
  });

  it('lists leases and document comps with catalogue fields, deduped to the longest grant', async () => {
    const env = makeEnv({
      leases: [{ standard_id: 'RP-8-25+E2', start_date: '2026-11-02', end_date: '2029-11-01' }],
      comps: [
        { standard_ids: '["rp-8-25+e2","RP-27-20"]', start_date: '2026-10-01', end_date: '2026-12-30' },
        { standard_ids: 'not json', start_date: '2026-10-01', end_date: '2026-12-30' },
      ],
    });
    const [r, u] = req();
    const res = await handleEntitlements(r, env, u);
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const body = await res.json();
    expect(body.email).toBe('buyer@example.org');
    expect(body.standards).toEqual([
      { id: 'RP-27-20', designation: 'ANSI/IES RP-27-20', title: null, source: 'comp', startsAt: '2026-10-01', expiresAt: '2026-12-30', viewerUrl: null, thumbnailUrl: 'https://lens.ies.org/c.png' },
      { id: 'RP-8-25+E2', designation: 'ANSI/IES RP-8-25+E2', title: 'Roadway Lighting', source: 'purchase', startsAt: '2026-11-02', expiresAt: '2029-11-01', viewerUrl: 'https://lighting.ies.org/2H4QTw', thumbnailUrl: null },
    ]);
    // Queries are keyed on the lowercased address and only count live rows.
    const lease = env.calls.find(c => /FROM purchases/.test(c.sql));
    expect(lease.bindings).toEqual(['buyer@example.org']);
    expect(lease.sql).toMatch(/kind = 'lease' AND status = 'active'/);
    expect(lease.sql).toMatch(/end_date >= date\('now'\)/);
  });

  it('answers an empty list when nothing is held', async () => {
    const [r, u] = req();
    const body = await (await handleEntitlements(r, makeEnv(), u)).json();
    expect(body.standards).toEqual([]);
  });

  it('500s (never an empty list) when D1 fails', async () => {
    const [r, u] = req();
    const res = await handleEntitlements(r, makeEnv({ throws: true }), u);
    expect(res.status).toBe(500);
  });
});
