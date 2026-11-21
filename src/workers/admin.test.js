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
import { handleAdminAnalytics, handleAdminDeviceResetsList, handleAdminDeviceResetUpdate, handleAdminIndexStatus, exportStamp } from './admin';

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
        async run() { return route(sql, stmt.bindings) || { meta: { changes: 1 } }; },
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
  // Column probes (lib/analytics-scope.ts hasColumn): this database is current.
  if (/^SELECT (?:audience|attempt) FROM search_(?:log|events) LIMIT 1$/.test(sql)) return { audience: null };
  // The "N left out" counts: 14 in the window, 12 without staff, 10 without demos too.
  if (/SELECT COUNT\(\*\) AS n FROM search_log/.test(sql)) {
    const noStaff = /audience <> 'staff'/.test(sql);
    const noDemos = /NOT IN/.test(sql);
    return { n: noStaff && noDemos ? 10 : noStaff ? 12 : noDemos ? 11 : 14 };
  }
  if (/AS recorded/.test(sql)) return { recorded: 8, rephrased: 3 };
  if (/attempt >= 2/.test(sql) && /GROUP BY LOWER/.test(sql)) {
    return [{ query: 'illuminance selector tool', searches: 2, maxAttempt: 3, lastSeen: '2026-09-11 09:30:00' }];
  }
  if (/COUNT\(\*\) AS total/.test(sql)) {
    return { total: 10, cached: 4, noStrongMatch: 2, zeroResults: 1 };
  }
  if (/GROUP BY day/.test(sql)) {
    return [
      { day: '2026-09-10', searches: 6, subscribers: 4, nonSubscribers: 1 },
      { day: '2026-09-11', searches: 4, subscribers: 1, nonSubscribers: 3 },
    ];
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

  // 10/16/26 #5: Subscribers vs Non-Subscribers per day.
  it('splits searches per day by tier, and degrades to totals before migration 0022', async () => {
    const env = makeEnv(analyticsRoute);
    const { body } = await call(handleAdminAnalytics, env, '/api/admin/analytics');
    expect(body.searches.perDay[1]).toMatchObject({ subscribers: 1, nonSubscribers: 3 });
    expect(env.DB.calls.find(c => /GROUP BY day/.test(c.sql)).sql).toMatch(/tier IN \('lite', 'guest', 'none'\)/);

    const old = makeEnv(sql => {
      if (/GROUP BY day/.test(sql) && /tier/.test(sql)) throw new Error('D1_ERROR: no such column: tier');
      if (/GROUP BY day/.test(sql)) return [{ day: '2026-09-10', searches: 6 }];
      return analyticsRoute(sql);
    });
    const res = await call(handleAdminAnalytics, old, '/api/admin/analytics');
    expect(res.body.searches.perDay).toEqual([{ day: '2026-09-10', searches: 6 }]);
    expect(res.body.searches.note).toBeUndefined();
  });

  it('clamps the days window and binds it, never as SQL text', async () => {
    const env = makeEnv(analyticsRoute);
    const big = await call(handleAdminAnalytics, env, '/api/admin/analytics?days=9999');
    expect(big.body.days).toBe(365);
    const junk = await call(handleAdminAnalytics, env, "/api/admin/analytics?days=1');DROP TABLE search_log;--");
    expect(junk.body.days).toBe(1);
    // Every window reached the DB as a bound UTC datetime, and no statement
    // carries a date, a query or anything else from the request as text.
    const windowed = env.DB.calls.filter(c => /created_at >= \?/.test(c.sql));
    expect(windowed.length).toBeGreaterThan(8);
    for (const c of windowed) {
      expect(c.bindings[0]).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
      expect(c.sql).not.toMatch(/DROP|\d{4}-\d{2}-\d{2}/);
    }
  });

  // Dan, 11/19/26 #6: a custom date range, e.g. the days of a virtual symposium.
  it('counts a custom range of whole UTC days, both inclusive', async () => {
    const env = makeEnv(analyticsRoute);
    const { status, body } = await call(handleAdminAnalytics, env, '/api/admin/analytics?from=2026-11-04&to=2026-11-06');
    expect(status).toBe(200);
    expect(body.window).toEqual({ from: '2026-11-04', to: '2026-11-06', days: 3, custom: true });
    const totals = env.DB.calls.find(c => /COUNT\(\*\) AS total/.test(c.sql));
    expect(totals.sql).toMatch(/created_at >= \? AND created_at < \?/);
    expect(totals.bindings.slice(0, 2)).toEqual(['2026-11-04 00:00:00', '2026-11-07 00:00:00']);
    // The click log is cut to the same days.
    const events = env.DB.calls.find(c => /GROUP BY event/.test(c.sql));
    expect(events.bindings).toEqual(['2026-11-04 00:00:00', '2026-11-07 00:00:00']);
  });

  it('refuses a range that is not one', async () => {
    const env = makeEnv(analyticsRoute);
    const bad = await call(handleAdminAnalytics, env, '/api/admin/analytics?from=2026-11-06&to=2026-11-04');
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/from must not be after to/);
    expect((await call(handleAdminAnalytics, env, '/api/admin/analytics?from=yesterday')).status).toBe(400);
    expect(env.DB.calls).toHaveLength(0);
  });

  // Dan, 11/19/26 #7: staff searches and the "Try searching for" demos.
  it('leaves staff and demo searches out of every figure, and says how many', async () => {
    const env = makeEnv(analyticsRoute);
    const { body } = await call(handleAdminAnalytics, env, '/api/admin/analytics');
    expect(body.filters).toEqual({ includeStaff: false, includeDemos: false, staffRecorded: true, attemptsRecorded: true });
    expect(body.searches.excluded).toEqual({ staff: 2, demo: 2 });
    for (const c of env.DB.calls.filter(c => /FROM search_log/.test(c.sql) && /GROUP BY|AS total|AS searchesOn|AS recorded/.test(c.sql))) {
      expect(c.sql, c.sql).toMatch(/audience IS NULL OR audience <> 'staff'/);
      expect(c.sql, c.sql).toMatch(/LOWER\(TRIM\(query\)\) NOT IN \(\?, \?, \?, \?\)/);
      expect(c.bindings).toContain('what are considerations for lighting parking garages?');
    }
    // Staff clicks leave the click log's figures too (it has no demo queries to drop).
    const events = env.DB.calls.find(c => /GROUP BY event/.test(c.sql));
    expect(events.sql).toMatch(/audience <> 'staff'/);
    expect(events.sql).not.toMatch(/NOT IN/);
  });

  it('counts them when asked', async () => {
    const env = makeEnv(analyticsRoute);
    const { body } = await call(handleAdminAnalytics, env, '/api/admin/analytics?staff=1&demo=1');
    expect(body.filters).toMatchObject({ includeStaff: true, includeDemos: true });
    const totals = env.DB.calls.find(c => /COUNT\(\*\) AS total/.test(c.sql));
    expect(totals.sql).not.toMatch(/audience|NOT IN/);
    // Still reported, so the toggle's effect is known before it is flipped back.
    expect(body.searches.excluded).toEqual({ staff: 2, demo: 3 });
  });

  it('before migration 0031 nothing can be told apart as staff, and it says so', async () => {
    const env = makeEnv(sql => {
      if (/^SELECT (?:audience|attempt) FROM/.test(sql)) throw new Error('no such column');
      return analyticsRoute(sql);
    });
    const { status, body } = await call(handleAdminAnalytics, env, '/api/admin/analytics');
    expect(status).toBe(200);
    expect(body.filters).toMatchObject({ staffRecorded: false, attemptsRecorded: false });
    expect(body.searches.total).toBe(10);
    expect(body.searches.retries).toEqual({ recorded: 0, rephrased: 0, topRephrased: [] });
    expect(env.DB.calls.every(c => !/audience <> 'staff'/.test(c.sql))).toBe(true);
  });

  // Dan, 11/19/26 #4: rephrasings of a reader's own question.
  it('reports how often readers had to rephrase, and what', async () => {
    const env = makeEnv(analyticsRoute);
    const { body } = await call(handleAdminAnalytics, env, '/api/admin/analytics');
    expect(body.searches.retries.recorded).toBe(8);
    expect(body.searches.retries.rephrased).toBe(3);
    expect(body.searches.retries.topRephrased[0]).toMatchObject({ query: 'illuminance selector tool', maxAttempt: 3 });
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

// ─── Client 10/20/26: the reader hears the decision ───────────────────────────

describe('POST /api/admin/device-resets emails the reader', () => {
  const post = async (env, body) => {
    const request = new Request('http://localhost/api/admin/device-resets', {
      method: 'POST', headers: { Authorization: 'Bearer test', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const res = await handleAdminDeviceResetUpdate(request, env);
    return { status: res.status, body: await res.json() };
  };
  const envWith = (prior) => {
    const sent = [];
    const env = makeEnv(sql => (/SELECT email/.test(sql)
      ? { email: 'reader@example.com', name: 'Pat Reader', document_title: 'ANSI/IES RP-6-24', status: prior }
      : { meta: { changes: 1 } }));
    env.SEND_EMAIL = { async send(m) { sent.push(m); } };
    return { env, sent };
  };

  it('approval sends the authorized-reset wording', async () => {
    const { env, sent } = envWith('new');
    const { body } = await post(env, { id: 3, status: 'done' });
    expect(body.readerNotified).toEqual({ sent: true });
    expect(sent[0].to).toBe('reader@example.com');
    expect(sent[0].text).toContain('Staff has authorized a one-time device limit reset.');
    expect(sent[0].text).toContain('limit your use to two browsers');
  });

  it('rejection sends the terms-of-service wording', async () => {
    const { env, sent } = envWith('new');
    await post(env, { id: 3, status: 'dismissed' });
    expect(sent[0].text).toContain('Per the terms of service, staff was unable to approve your request');
    expect(sent[0].html).toMatch(/>Tutorials<\/a> page to learn more/);
  });

  it('never mails twice, and not when reopening or asked not to', async () => {
    for (const [prior, body] of [['done', { id: 3, status: 'done' }], ['done', { id: 3, status: 'new' }], ['new', { id: 3, status: 'done', notify: false }]]) {
      const { env, sent } = envWith(prior);
      const res = await post(env, body);
      expect(res.body.readerNotified).toBeNull();
      expect(sent).toHaveLength(0);
    }
  });
});

// ─── Client 10/20/26: illuminance rows without search vectors ─────────────────

describe('GET /api/admin/index-status probes the illuminance rows\' own vectors', () => {
  it('warns when a standard\'s rows have no vectors, and not when they do', async () => {
    const env = makeEnv(sql => {
      if (/FROM standards ORDER BY id/.test(sql)) {
        return [
          { id: 'RP-3-26', title: 'Educational', status: 'Active', chunk_count: null, page_count: 80, coverage_json: null,
            vitrium_web_url: 'https://lighting.ies.org/x', published_date: '2026-06-26', buy_url: null },
          { id: 'RP-6-24', title: 'Sports', status: 'Active', chunk_count: null, page_count: 90, coverage_json: null,
            vitrium_web_url: 'https://lighting.ies.org/y', published_date: '2024-01-01', buy_url: null },
        ];
      }
      if (/MIN\(code\)/.test(sql)) {
        return [{ standard: 'RP-3-26', first: 'RP326_0000', last: 'RP326_0025' }, { standard: 'RP-6-24', first: 'RP624_0000', last: 'RP624_0236' }];
      }
      if (/COUNT\(\*\) AS n/.test(sql)) return [{ standard: 'RP-3-26', n: 26 }, { standard: 'RP-6-24', n: 237 }];
      return [];
    });
    env.VECTORIZE = { getByIds: async (ids) => ids.filter(id => id.startsWith('RP624')).map(id => ({ id })) };
    const { body } = await call(handleAdminIndexStatus, env, '/api/admin/index-status');
    const rp3 = body.standards.find(s => s.id === 'RP-3-26');
    const rp6 = body.standards.find(s => s.id === 'RP-6-24');
    expect(rp3.appVectorSpotCheck).toEqual({ probed: 2, found: 0, missing: ['RP326_0000', 'RP326_0025'] });
    expect(rp3.warnings.some(w => /Illuminance rows have no search vectors/.test(w))).toBe(true);
    expect(rp6.appVectorSpotCheck.found).toBe(2);
    expect(rp6.warnings.some(w => /Illuminance rows/.test(w))).toBe(false);
  });
});

// Dan, 10/29/26: "What's the best way for me to evaluate any 'reference chunk'
// and 'only % produced chunks' index warnings?" — the warnings now evaluate
// themselves as far as the data allows.
import { findReferencesHeading, referencesWarning, compactPageList, coverageWarning } from './admin';
import { buildCoverageStats } from './ingest';

describe('index-health warnings staff can act on', () => {
  const outline = entries => JSON.stringify(entries);

  it('no References heading in the outline → no warning at all', () => {
    const h = findReferencesHeading(outline([{ number: '1.0', title: 'Scope', page: 3 }]));
    expect(h).toBeNull();
    expect(referencesWarning(h)).toBeNull();
  });

  it('a References heading with nothing indexed → names it and its page', () => {
    const h = findReferencesHeading(outline([
      { number: '1.0', title: 'Scope', page: 3 },
      { number: '10.0', title: 'References', page: 54 },
    ]));
    expect(h).toEqual({ label: '10.0 References', page: 54 });
    expect(referencesWarning(h)).toContain('"10.0 References" (p. 54)');
  });

  it('recognizes Annex bibliographies too', () => {
    expect(findReferencesHeading(outline([{ number: 'Annex C', title: 'Bibliography', page: 80 }])))
      .toEqual({ label: 'Annex C Bibliography', page: 80 });
  });

  it('no outline → the manual check, spelled out', () => {
    expect(findReferencesHeading(null)).toBeUndefined();
    expect(referencesWarning(undefined)).toMatch(/table of contents/);
  });

  it('lists the pages that produced no text, compactly', () => {
    expect(compactPageList([12, 1, 2, 3, 4, 31, 30, 32])).toBe('1–4, 12, 30–32');
    expect(coverageWarning(40, [1, 2, 5])).toContain('No text on pages 1–2, 5');
    expect(coverageWarning(40, null)).toMatch(/re-ingest to record which pages/);
  });

  it('ingest records the pages without chunks', () => {
    const stats = buildCoverageStats([{ pageNumber: 2, type: 'text' }, { pageNumber: 4, type: 'reference' }], 5);
    expect(stats.pagesWithChunks).toBe(2);
    expect(stats.pagesWithoutChunks).toEqual([1, 3, 5]);
    expect(stats.byType).toEqual({ text: 1, reference: 1 });
  });
});

// Shane, 2026-11-02: search_usage_YYYYMMDDHHMM.csv.
describe('exportStamp', () => {
  it('is YYYYMMDDHHMM in UTC', () => {
    expect(exportStamp(new Date('2026-11-02T15:09:42Z'))).toBe('202611021509');
  });
});
