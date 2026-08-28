/**
 * Anonymous interaction log (client DO078).
 *
 *   POST /api/events
 *
 * "Is it possible to continually 'train' the agent based on which cards people
 *  click on first to 'open in library', and perhaps which filters are engaged
 *  post-search for various search types?"
 *
 * Yes — but only from data that exists, and none was being recorded. This is
 * that record: one row per meaningful interaction, carrying what was searched,
 * which card was opened and from what position, and what the reader narrowed to
 * afterwards. See migrations/0013_search_events.sql for the event vocabulary and
 * the privacy contract (no user id, no IP, no session token — the same rule
 * search_log follows).
 *
 * Nothing in the search pipeline reads this table yet. Turning it into ranking
 * influence is a separate, evidence-led step: with a few weeks of rows, a
 * click-through prior per (query shape, standard) can break ties inside the
 * existing score epsilon, which is measurable against the query log. Shipping
 * that before the data exists would be guessing.
 *
 * Fail-soft by construction: a malformed body is a 400, and anything else — a
 * missing table, a D1 hiccup — answers 204 and logs. A telemetry write must
 * never be visible to the reader who triggered it.
 */

import { requireReadAccess } from './session';

function errMsg(err: unknown): string { return err instanceof Error ? err.message : String(err); }

/** The events the client asked to measure. An unknown name is rejected rather
 *  than stored: an open vocabulary makes the CSV unanalysable within a month. */
const EVENTS = new Set(['open_in_library', 'filter_applied', 'guidance']);

const MAX_TEXT = 300;
const MAX_EXTRA = 400;

const text = (v: unknown, max = MAX_TEXT): string | null => {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s ? s.slice(0, max) : null;
};

const int = (v: unknown, min: number, max: number): number | null => {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return null;
  const i = Math.floor(n);
  return i >= min && i <= max ? i : null;
};

/** A short JSON object, re-serialized here so only plain scalars get stored. */
function extraJson(v: unknown): string | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const out: Record<string, string | number | boolean> = {};
  for (const [k, value] of Object.entries(v as Record<string, unknown>)) {
    if (typeof value === 'string') out[k.slice(0, 40)] = value.slice(0, 80);
    else if (typeof value === 'number' && Number.isFinite(value)) out[k.slice(0, 40)] = value;
    else if (typeof value === 'boolean') out[k.slice(0, 40)] = value;
  }
  const json = JSON.stringify(out);
  return json === '{}' ? null : json.slice(0, MAX_EXTRA);
}

export async function handleEvent(request: Request, env: Env): Promise<Response> {
  // Same gate as search: an event is only meaningful from someone who could
  // search in the first place, and this keeps the table from being writable by
  // anonymous traffic.
  const denied = await requireReadAccess(request, env);
  if (denied) return denied;

  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    parsed = undefined;
  }
  // `null`, a bare scalar and an array all parse cleanly and are all invalid —
  // dereferencing them is a 500 where a 400 is the honest answer.
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    });
  }
  const body = parsed as Record<string, unknown>;

  const event = text(body.event, 40);
  if (!event || !EVENTS.has(event)) {
    return new Response(JSON.stringify({ error: 'Unknown event' }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    });
  }

  // Every stored field is length-capped; this one is a list, so both the number
  // of items and each item are bounded.
  const contentTypes = Array.isArray(body.content_types)
    ? JSON.stringify(
        body.content_types
          .filter((t): t is string => typeof t === 'string')
          .slice(0, 8)
          .map(t => t.slice(0, 24)),
      )
    : null;

  try {
    await env.DB.prepare(`
      INSERT INTO search_events
        (event, query, standard_id, result_type, position, section, page_number, content_types, extra)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      event,
      text(body.query, 500),
      text(body.standard_id, 40),
      text(body.result_type, 24),
      int(body.position, 1, 1000),
      text(body.section, 40),
      int(body.page_number, 1, 20000),
      contentTypes,
      extraJson(body.extra),
    ).run();
  } catch (err) {
    // Includes "no such table" until migration 0013 has been applied.
    console.error('event log write failed (non-fatal):', errMsg(err));
  }

  // 204 either way: the caller is a beacon and has nothing to do with the answer.
  return new Response(null, { status: 204 });
}
