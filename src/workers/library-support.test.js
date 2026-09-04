/**
 * Lighting Library error-page backend (client note, 2026-09-04).
 *
 * Two public endpoints serve the Vitrium custom error page, and public is the
 * point of most of these tests: the caller is a reader the viewer just refused,
 * so everything rides on the endpoints being narrow — a lookup that can only
 * name what the store already publishes, and a request form that accepts only
 * the Clear-Use error family, dedupes, and refuses to claim "received" for a
 * row it failed to store.
 */

import { describe, it, expect } from 'vitest';
import { handleLibraryDocumentLookup, handleDeviceResetRequest } from './library-support';

/** Programmable D1 stub: route by SQL shape, record every call. */
function dbStub(handlers = []) {
  const calls = [];
  return {
    calls,
    prepare(sql) {
      return {
        bind(...bindings) {
          calls.push({ sql, bindings });
          const h = handlers.find(x => x.match.test(sql)) || {};
          return {
            first: async () => (h.first ? h.first(bindings, sql) : null),
            run: async () => {
              if (h.runThrows) throw new Error(h.runThrows);
              return h.run ? h.run(bindings, sql) : { meta: { last_row_id: 1, changes: 1 } };
            },
            all: async () => (h.all ? h.all(bindings, sql) : { results: [] }),
          };
        },
      };
    },
  };
}

function envStub(overrides = {}) {
  return {
    DB: dbStub(),
    SEARCH_RATE_LIMITER: { limit: async () => ({ success: true }) },
    ...overrides,
  };
}

const lookupRequest = (code) =>
  new Request(`http://localhost/api/library/document${code != null ? `?code=${code}` : ''}`);

async function lookup(env, code) {
  const url = new URL(lookupRequest(code).url);
  const res = await handleLibraryDocumentLookup(lookupRequest(code), env, url);
  return { status: res.status, body: await res.json() };
}

const RP1_ROW = {
  id: 'RP-1-24',
  full_designation: 'ANSI/IES RP-1-24',
  title: 'Recommended Practice: Lighting Office Spaces',
  status: 'Active',
  buy_url: 'https://store.ies.org/product/rp-1-24/',
  vitrium_web_url: 'https://view.protectedpdf.com/2H4QTw',
  superseded_by: null,
};

describe('handleLibraryDocumentLookup', () => {
  it('requires a plausible short code — no LIKE wildcards reach SQL', async () => {
    for (const bad of [undefined, '', 'ab', 'a%25b', 'has-hyphen', 'x'.repeat(20)]) {
      const { status } = await lookup(envStub(), bad);
      expect(status).toBe(400);
    }
  });

  it('answers null for a code the corpus does not know', async () => {
    const { status, body } = await lookup(envStub(), 'zzzzzz');
    expect(status).toBe(200);
    expect(body.document).toBe(null);
  });

  it('shapes a match, with the Library link on the branded host', async () => {
    const env = envStub({
      DB: dbStub([{ match: /FROM standards WHERE vitrium_web_url LIKE/, first: () => RP1_ROW }]),
    });
    const { body } = await lookup(env, '2H4QTw');
    expect(body.document).toEqual({
      id: 'RP-1-24',
      designation: 'ANSI/IES RP-1-24',
      title: 'Recommended Practice: Lighting Office Spaces',
      status: 'Active',
      buyUrl: 'https://store.ies.org/product/rp-1-24/',
      libraryUrl: 'https://lighting.ies.org/2H4QTw',
    });
    expect(body.supersededBy).toBe(null);
  });

  it('resolves the superseding edition for a withdrawn document', async () => {
    const env = envStub({
      DB: dbStub([
        {
          match: /WHERE vitrium_web_url LIKE/,
          first: () => ({
            ...RP1_ROW, id: 'RP-1-20', full_designation: 'ANSI/IES RP-1-20',
            status: 'Deprecated', superseded_by: 'RP-1-24', buy_url: null,
          }),
        },
        { match: /WHERE id = \?/, first: () => RP1_ROW },
      ]),
    });
    const { body } = await lookup(env, '2H4QTw');
    expect(body.document.status).toBe('Deprecated');
    expect(body.supersededBy.id).toBe('RP-1-24');
    expect(body.supersededBy.buyUrl).toBe('https://store.ies.org/product/rp-1-24/');
  });

  it('a title that is just the id is null, and the designation is synthesized', async () => {
    const env = envStub({
      DB: dbStub([{
        match: /WHERE vitrium_web_url LIKE/,
        first: () => ({ ...RP1_ROW, title: 'RP-1-24', full_designation: null }),
      }]),
    });
    const { body } = await lookup(env, '2H4QTw');
    expect(body.document.title).toBe(null);
    expect(body.document.designation).toBe('ANSI/IES RP-1-24');
  });
});

// ─── Device-limit reset requests ──────────────────────────────────────────────

const resetRequest = (body) =>
  new Request('http://localhost/api/library/device-reset', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'cf-connecting-ip': '203.0.113.9' },
    body: JSON.stringify(body),
  });

const VALID_BODY = {
  email: 'reader@firm.com',
  name: 'Sam Reader',
  note: 'Replaced my laptop.',
  error_code: 'vc3',
  document_url: 'https://view.protectedpdf.com/Forbidden/2H4QTw',
  message: 'You have exceeded your device limit (vc3)',
};

async function submit(env, body) {
  const res = await handleDeviceResetRequest(resetRequest(body), env);
  return { status: res.status, body: await res.json() };
}

describe('handleDeviceResetRequest', () => {
  it('requires a real email address', async () => {
    const { status } = await submit(envStub(), { ...VALID_BODY, email: 'not-an-email' });
    expect(status).toBe(400);
  });

  it('accepts ONLY the Clear-Use family — an expiry or permission error is not a reset', async () => {
    for (const code of ['qe2', 'w29', '2p3', 'nonsense', '']) {
      const { status, body } = await submit(envStub(), { ...VALID_BODY, error_code: code });
      expect(status).toBe(400);
      expect(body.error).toBeTruthy();
    }
    for (const code of ['vc3', 'dvc3', 'dovc3', 'dpvc3', 'vp3', 'ipvc3', 'VC3']) {
      const { status } = await submit(envStub(), { ...VALID_BODY, error_code: code });
      expect(status).toBe(200);
    }
  });

  it('acknowledges and discards a submission with the honeypot filled', async () => {
    const env = envStub();
    const { status, body } = await submit(env, { ...VALID_BODY, website: 'http://spam.example' });
    expect(status).toBe(200);
    expect(body).toEqual({ received: true });
    // Nothing was written or even looked up.
    expect(env.DB.calls.length).toBe(0);
  });

  it('stores the request with the short code parsed from the Forbidden URL', async () => {
    const db = dbStub([
      { match: /SELECT id, full_designation, title FROM standards/, first: () => RP1_ROW },
      { match: /INSERT INTO device_reset_requests/, run: () => ({ meta: { last_row_id: 42, changes: 1 } }) },
    ]);
    const { status, body } = await submit(envStub({ DB: db }), VALID_BODY);
    expect(status).toBe(200);
    expect(body).toEqual({ received: true, requestId: 42 });

    const insert = db.calls.find(c => /INSERT INTO device_reset_requests/.test(c.sql));
    // (email, name, document_code, document_id, document_title, error_code, raw_message, user_note)
    expect(insert.bindings[0]).toBe('reader@firm.com');
    expect(insert.bindings[2]).toBe('2H4QTw');
    expect(insert.bindings[3]).toBe('RP-1-24');
    expect(insert.bindings[4]).toBe('ANSI/IES RP-1-24 Recommended Practice: Lighting Office Spaces');
    expect(insert.bindings[5]).toBe('vc3');
  });

  it('collapses a repeat submission into the open request instead of re-notifying staff', async () => {
    const db = dbStub([
      { match: /SELECT id FROM device_reset_requests/, first: () => ({ id: 7 }) },
    ]);
    const sends = [];
    const env = envStub({
      DB: db,
      DEVICE_RESET_NOTIFY_EMAIL: 'staff@ies.org',
      SEND_EMAIL: { send: async (m) => { sends.push(m); } },
    });
    const { status, body } = await submit(env, VALID_BODY);
    expect(status).toBe(200);
    expect(body).toEqual({ received: true, alreadyPending: true });
    expect(db.calls.some(c => /INSERT/.test(c.sql))).toBe(false);
    expect(sends.length).toBe(0);
  });

  it('notifies staff when the inbox is configured, and records the outcome on the row', async () => {
    const db = dbStub([
      { match: /INSERT INTO device_reset_requests/, run: () => ({ meta: { last_row_id: 9, changes: 1 } }) },
    ]);
    const sends = [];
    const env = envStub({
      DB: db,
      DEVICE_RESET_NOTIFY_EMAIL: 'staff@ies.org',
      SEND_EMAIL: { send: async (m) => { sends.push(m); } },
    });
    const { status } = await submit(env, VALID_BODY);
    expect(status).toBe(200);
    expect(sends.length).toBe(1);
    expect(sends[0].to).toBe('staff@ies.org');
    expect(sends[0].subject).toContain('reader@firm.com');

    const bookkeeping = db.calls.find(c => /UPDATE device_reset_requests SET notify_sent/.test(c.sql));
    expect(bookkeeping.bindings).toEqual([1, null, 9]);
  });

  it('skips the notification cleanly when no inbox is configured', async () => {
    const db = dbStub([
      { match: /INSERT INTO device_reset_requests/, run: () => ({ meta: { last_row_id: 3, changes: 1 } }) },
    ]);
    const env = envStub({ DB: db });   // no DEVICE_RESET_NOTIFY_EMAIL, no SEND_EMAIL
    const { status, body } = await submit(env, VALID_BODY);
    expect(status).toBe(200);
    expect(body.received).toBe(true);
    expect(db.calls.some(c => /UPDATE device_reset_requests/.test(c.sql))).toBe(false);
  });

  it('answers 500 — never "received" — when the row could not be stored', async () => {
    const db = dbStub([
      { match: /INSERT INTO device_reset_requests/, runThrows: 'no such table: device_reset_requests' },
    ]);
    const { status, body } = await submit(envStub({ DB: db }), VALID_BODY);
    expect(status).toBe(500);
    expect(body.error).toContain('could not be recorded');
  });

  it('refuses when the rate limiter says stop, and proceeds when it errors', async () => {
    const limited = envStub({ SEARCH_RATE_LIMITER: { limit: async () => ({ success: false }) } });
    expect((await submit(limited, VALID_BODY)).status).toBe(429);

    const broken = envStub({ SEARCH_RATE_LIMITER: { limit: async () => { throw new Error('down'); } } });
    expect((await submit(broken, VALID_BODY)).status).toBe(200);
  });

  it('rejects a body that is not a JSON object', async () => {
    const res = await handleDeviceResetRequest(
      new Request('http://localhost/api/library/device-reset', { method: 'POST', body: 'not json' }),
      envStub(),
    );
    expect(res.status).toBe(400);
  });
});
