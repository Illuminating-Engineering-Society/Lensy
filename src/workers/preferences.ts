/**
 * Per-account UI preferences (client DO080).
 *
 *   GET /api/preferences   → { preferences: { ai_guide?: boolean } }
 *   PUT /api/preferences   ← { ai_guide: boolean }   → { preferences }
 *
 * "Disable/Enable AI Guide tool: 'save' the state to the user's account. Every
 *  time the user returns to the tool, it should be in the same state it was last
 *  set."
 *
 * Keyed on the email in the ies_auth cookie, so the setting follows the person
 * rather than the browser. Two deliberate choices:
 *
 *   • Only KNOWN keys are stored. An unknown key is dropped rather than kept,
 *     so this endpoint can never become a general-purpose store for whatever a
 *     client sends.
 *   • Everything fails SOFT. No session (the staff bearer, or a request before
 *     the cookie is set) answers with an empty object and accepts a write as a
 *     no-op; a D1 error does the same. A preference that does not persist is a
 *     small annoyance, and it must never break the page that asked for it.
 */

import { getSsoState } from '../lib/sso';

function errMsg(err: unknown): string { return err instanceof Error ? err.message : String(err); }

/** The preferences this Worker understands. Anything else is dropped. */
export interface UserPreferences {
  /** The Disable/Enable AI Guide state (client DO080). */
  ai_guide?: boolean;
}

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

/** Read the stored blob, keeping only the keys we know. */
export function parsePreferences(raw: string | null | undefined): UserPreferences {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return sanitizePreferences(parsed as Record<string, unknown>);
  } catch {
    return {};
  }
}

/** Keep the known keys, with the right types. */
export function sanitizePreferences(input: Record<string, unknown>): UserPreferences {
  const out: UserPreferences = {};
  if (typeof input.ai_guide === 'boolean') out.ai_guide = input.ai_guide;
  return out;
}

/** The account this request belongs to, or null (bearer/anonymous). */
async function accountFor(request: Request, env: Env): Promise<{ email: string; sub: string | null } | null> {
  try {
    const sso = await getSsoState(request, env);
    if (sso.state !== 'ok' || !sso.user?.email) return null;
    return { email: sso.user.email.toLowerCase(), sub: sso.user.sub || null };
  } catch (err) {
    console.error('preferences: session read failed (non-fatal):', errMsg(err));
    return null;
  }
}

export async function handlePreferences(request: Request, env: Env): Promise<Response> {
  const account = await accountFor(request, env);

  if (request.method === 'GET') {
    if (!account) return json({ preferences: {} });
    try {
      const row = await env.DB.prepare(
        'SELECT preferences_json FROM user_preferences WHERE email = ?'
      ).bind(account.email).first<{ preferences_json: string | null }>();
      return json({ preferences: parsePreferences(row?.preferences_json) });
    } catch (err) {
      // Includes "no such table" until migration 0014 is applied.
      console.error('preferences: read failed (non-fatal):', errMsg(err));
      return json({ preferences: {} });
    }
  }

  // PUT — merge, so a client that knows about one preference cannot erase
  // another it has never heard of.
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return json({ error: 'Invalid JSON body' }, 400);
  }
  const incoming = sanitizePreferences(body as Record<string, unknown>);
  if (Object.keys(incoming).length === 0) {
    return json({ error: 'No known preference in the request' }, 400);
  }
  if (!account) {
    // A staff bearer or a session-less call: accepted and discarded, because the
    // caller has no account to save it to.
    return json({ preferences: incoming, stored: false });
  }

  try {
    const row = await env.DB.prepare(
      'SELECT preferences_json FROM user_preferences WHERE email = ?'
    ).bind(account.email).first<{ preferences_json: string | null }>();
    const merged = { ...parsePreferences(row?.preferences_json), ...incoming };

    await env.DB.prepare(`
      INSERT INTO user_preferences (email, person_uuid, preferences_json, created_at, updated_at)
      VALUES (?, ?, ?, datetime('now'), datetime('now'))
      ON CONFLICT(email) DO UPDATE SET
        preferences_json = excluded.preferences_json,
        person_uuid = COALESCE(excluded.person_uuid, user_preferences.person_uuid),
        updated_at = datetime('now')
    `).bind(account.email, account.sub, JSON.stringify(merged)).run();

    return json({ preferences: merged, stored: true });
  } catch (err) {
    console.error('preferences: write failed (non-fatal):', errMsg(err));
    return json({ preferences: incoming, stored: false });
  }
}
