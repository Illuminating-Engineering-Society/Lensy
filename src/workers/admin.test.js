/**
 * Admin analytics + device-reset queue endpoints (src/workers/admin.ts) — the
 * backends of the staff dashboard at /admin.
 *
 * What matters here: both endpoints sit behind the admin gate, the analytics
 * aggregates come back in the shape the dashboard renders (and the days window
 * is clamped, since it reaches SQL as a datetime() modifier), and BOTH fail
 * soft when their table's migration has not been applied — zeros plus a note,
 * never a 500, matching the CSV exports' posture.
 */

import { describe, it, expect } from 'vitest';
import { handleAdminAnalytics, handleAdminDeviceResetsList } from './admin';

// ─── Stubs ─────────────────────────────────────────────────────────────────────

/**
 * SQL-shape-routed D1 stub. `route(sql, bindings)` returns the rows for .all()
 * (wrapped in {results}) or the row for .first(); throwing inside route
 * simulates a missing table.
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
        async first() { return route(sql, stmt.bindings); },
        async all() { return { results: route(sql, stmt.bindings) || [] }; },
      };
      return stmt;
    },
  };
}

function makeEnv(route) {
  return {
    DB: makeDb(route),
    SESSIONS: { get: async () => null, put: async () => {} },
    // ENVIRONMENT deliberately unset: outside production the bearer check
    // accepts any Authorization header (src/lib/auth.ts), which is how every
    // worker test authenticates.
  };
}

async function call(handler, env, path, headers = { Authorization: 'Bearer test' }) {
  const request = new Request(`http://localhost${path}`, { headers });
  const res = await handler(request, env);
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

// ─── Auth ──────────────────────────────────────────────────────────────────────

describe('gate', () => {
  it('refuses a request with neither bearer nor session', async () => {
    const env = makeEnv(() => []);
    for (const handler of [handleAdminAnalytics, handleAdminDeviceResetsList]) {
      const { status } = await call(handler, env, '/api/admin/x', {});
      expect([401, 403, 503]).toContain(status);
    }
  });
});

// ─── Analytics ─────────────────────────────────────────────────────────────────

function analyticsRoute(sql) {
  if (/COUNT\(\*\) AS total/.test(sql)) {
    return { total: 10, cached: 4, noStrongMatch: 2, zeroResults: 1 };
  }
  if (/GROUP BY day/.test(sql)) {
    return [{ day: '2026-09-10', searches: 6 }, { day: '2026-09-11', searches: 4 }];
  }
  if (/result_count = 0/.test(sql) && /GROUP BY LOWER/.test(sql)) {
    return [{ query: 'unicorn lighting', searches: 2, lastSeen: '2026-09-11 08:00:00' }];
  }
  if (/GROUP BY LOWER/.test(sql)) {
    return [{ query: 'skating rink', searches: 5, noStrongMatch: 1, lastSeen: '2026-09-11 09:00:00' }];
  }
  if (/GROUP BY event/.test(sql)) {
    return [{ event: 'open_in_library', n: 7 }, { event: 'filter_after_open', n: 3 }];
  }
  if (/GROUP BY standard_id/.test(sql)) {
    return [{ standardId: 'RP-6-22', n: 5 }];
  }
  throw new Error(`unrouted SQL: ${sql}`);
}

describe('GET /api/admin/analytics', () => {
  it('returns the aggregate shape the dashboard renders', async () => {
    const env = makeEnv(analyticsRoute);
    const { status, body } = await call(handleAdminAnalytics, env, '/api/admin/analytics');
    expect(status).toBe(200);
    expect(body.days).toBe(30);
    expect(body.searches.total).toBe(10);
    expect(body.searches.cached).toBe(4);
    expect(body.searches.noStrongMatch).toBe(2);
    expect(body.searches.perDay).toHaveLength(2);
    expect(body.searches.topQueries[0].query).toBe('skating rink');
    expect(body.searches.zeroResultQueries[0].query).toBe('unicorn lighting');
    // events.total is the sum of byEvent, not another query.
    expect(body.events.total).toBe(10);
    expect(body.events.topStandards[0].standardId).toBe('RP-6-22');
    expect(body.searches.note).toBeUndefined();
    expect(body.events.note).toBeUndefined();
  });

  it('clamps the days window and binds it as a modifier, never as SQL text', async () => {
    const env = makeEnv(analyticsRoute);
    const big = await call(handleAdminAnalytics, env, '/api/admin/analytics?days=9999');
    expect(big.body.days).toBe(365);
    const junk = await call(handleAdminAnalytics, env, "/api/admin/analytics?days=1');DROP TABLE search_log;--");
    expect(junk.body.days).toBe(1);
    // Every window reached the DB as a bound '-N days' parameter.
    for (const c of env.DB.calls.filter(c => /datetime\('now', \?\)/.test(c.sql))) {
      expect(c.bindings[0]).toMatch(/^-\d+ days$/);
    }
  });

  it('fails soft per table: a missing search_events answers zeros plus a note', async () => {
    const env = makeEnv(sql => {
      if (/search_events/.test(sql)) throw new Error('no such table: search_events');
      return analyticsRoute(sql);
    });
    const { status, body } = await call(handleAdminAnalytics, env, '/api/admin/analytics');
    expect(status).toBe(200);
    expect(body.searches.total).toBe(10);          // the other table still answers
    expect(body.events.total).toBe(0);
    expect(body.events.byEvent).toEqual([]);
    expect(body.events.note).toMatch(/search_events unavailable/);
  });

  it('fails soft when search_log itself is missing', async () => {
    const env = makeEnv(sql => {
      if (/search_log/.test(sql)) throw new Error('no such table: search_log');
      return analyticsRoute(sql);
    });
    const { status, body } = await call(handleAdminAnalytics, env, '/api/admin/analytics');
    expect(status).toBe(200);
    expect(body.searches.total).toBe(0);
    expect(body.searches.note).toMatch(/search_log unavailable/);
    expect(body.events.total).toBe(10);
  });
});

// ─── Device-reset queue (JSON) ─────────────────────────────────────────────────

const RESET_ROW = {
  id: 3, created_at: '2026-09-10 12:00:00', email: 'reader@example.com', name: 'A Reader',
  document_code: '2H4QTw', document_id: 'RP-6-22', document_title: 'Sports Lighting',
  error_code: 'vc3', raw_message: 'Device limit reached (vc3)', user_note: 'new laptop',
  status: 'new', notify_sent: 0, notify_error: null, resolved_at: null, resolved_by: null,
};

function resetsRoute(sql) {
  if (/GROUP BY status/.test(sql)) {
    return [{ status: 'new', n: 2 }, { status: 'done', n: 5 }];
  }
  if (/FROM device_reset_requests WHERE 1=1/.test(sql)) {
    return [RESET_ROW];
  }
  throw new Error(`unrouted SQL: ${sql}`);
}

describe('GET /api/admin/device-resets', () => {
  it('returns the queue rows plus per-status counts in one response', async () => {
    const env = makeEnv(resetsRoute);
    const { status, body } = await call(handleAdminDeviceResetsList, env, '/api/admin/device-resets');
    expect(status).toBe(200);
    expect(body.requests).toHaveLength(1);
    expect(body.requests[0].error_code).toBe('vc3');
    expect(body.counts).toEqual({ all: 7, new: 2, done: 5, dismissed: 0 });
    expect(body.note).toBeUndefined();
  });

  it('passes the status filter through as a binding', async () => {
    const env = makeEnv(resetsRoute);
    await call(handleAdminDeviceResetsList, env, '/api/admin/device-resets?status=new&limit=10');
    const rowsCall = env.DB.calls.find(c => /AND status = \?/.test(c.sql));
    expect(rowsCall).toBeDefined();
    expect(rowsCall.bindings).toEqual(['new', 10]);
  });

  it('fails soft when migration 0016 has not been applied', async () => {
    const env = makeEnv(() => { throw new Error('no such table: device_reset_requests'); });
    const { status, body } = await call(handleAdminDeviceResetsList, env, '/api/admin/device-resets');
    expect(status).toBe(200);
    expect(body.requests).toEqual([]);
    expect(body.counts.all).toBe(0);
    expect(body.note).toMatch(/migration 0016/);
  });
});
