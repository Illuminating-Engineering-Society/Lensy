/**
 * Lensy Session Endpoints — SSO against auth.ies.org (see lib/sso.ts).
 *
 *   GET  /api/auth/me         Who am I + am I allowed in. The frontend gates
 *                             the whole UI on this response.
 *   POST /api/auth/dev-login  LOCAL DEV ONLY (404 in production): mints an
 *                             ies_auth cookie with the local .dev.vars secrets
 *                             so the flow is testable without Wicket/the IdP.
 *
 * Plus requireReadAccess(): the server-side gate in front of the read API
 * (/api/search etc.) — a valid ies_auth cookie that passes the access
 * decision, OR an explicit LUCIUS_API_SECRET bearer (staff scripts).
 */

import { checkAuth } from '../lib/auth';
import {
  getSsoUser,
  decideAccess,
  buildLoginUrl,
  buildLogoutUrl,
  buildAuthCookieValue,
  AUTH_COOKIE_NAME,
  type SsoUser,
} from '../lib/sso';
import type { InvitedUserRow } from '../types';

function allowMembersWithoutInvite(env: Env): boolean {
  // Default ON: Lensy is an IES member benefit; the allowlist adds guests
  // and can still explicitly revoke anyone (a row always wins).
  // String(): wrangler types emits the var as a literal type, which TS would
  // reject in a direct comparison against 'false'.
  return String(env.ALLOW_MEMBERS_WITHOUT_INVITE) !== 'false';
}

async function findInvite(env: Env, email: string): Promise<InvitedUserRow | null> {
  return env.DB.prepare('SELECT * FROM invited_users WHERE email = ?')
    .bind(email.toLowerCase()).first<InvitedUserRow>();
}

/** Activate the invite on first SSO login; refresh last_login_at once a day. */
async function recordLogin(
  env: Env,
  user: SsoUser,
  row: InvitedUserRow,
  firstLogin: boolean,
): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  if (firstLogin) {
    await env.DB.prepare(`
      UPDATE invited_users
      SET status = 'active', person_uuid = ?, last_login_at = datetime('now'),
          updated_at = datetime('now')
      WHERE id = ?
    `).bind(user.sub, row.id).run();
  } else if ((row.last_login_at ?? '').slice(0, 10) !== today) {
    await env.DB.prepare(
      `UPDATE invited_users SET last_login_at = datetime('now') WHERE id = ?`
    ).bind(row.id).run();
  }
}

// ─── GET /api/auth/me ─────────────────────────────────────────────────────────

export async function handleAuthMe(request: Request, env: Env): Promise<Response> {
  const user = await getSsoUser(request, env);
  if (!user) {
    return json({
      authenticated: false,
      loginUrl: buildLoginUrl(env, request.url),
    }, 401);
  }

  const row = await findInvite(env, user.email);
  const decision = decideAccess(user, row, allowMembersWithoutInvite(env), Date.now());

  if (!decision.authorized) {
    return json({
      authenticated: true,
      authorized: false,
      reason: decision.reason,
      email: user.email,
      logoutUrl: buildLogoutUrl(env, request.url),
    }, 403);
  }

  if (row) await recordLogin(env, user, row, decision.firstLogin);

  return json({
    authenticated: true,
    authorized: true,
    user: {
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      name: `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim() || user.email,
      isMember: user.isMember,
      memberTier: user.memberTier ?? null,
      role: decision.role,
    },
    logoutUrl: buildLogoutUrl(env, request.url),
  });
}

// ─── Read-API gate ────────────────────────────────────────────────────────────

/**
 * Gate for the read endpoints (/api/search, /api/applications, /api/standards,
 * /api/projects). Returns null when the request may proceed, else the 401/403
 * to short-circuit with.
 *
 * An explicit Authorization header is checked against LUCIUS_API_SECRET first
 * so staff scripts (test-search.js etc.) keep working without a cookie. No
 * header → the SSO cookie decides.
 */
export async function requireReadAccess(request: Request, env: Env): Promise<Response | null> {
  if (request.headers.get('authorization')) {
    const viaSecret = await checkAuth(request, env);
    if (viaSecret.ok) return null;
  }

  const user = await getSsoUser(request, env);
  if (!user) {
    return json({
      error: 'authentication_required',
      loginUrl: buildLoginUrl(env, request.url),
    }, 401);
  }

  const row = await findInvite(env, user.email);
  const decision = decideAccess(user, row, allowMembersWithoutInvite(env), Date.now());
  if (!decision.authorized) {
    return json({ error: 'access_denied', reason: decision.reason }, 403);
  }
  return null;
}

// ─── POST /api/auth/dev-login (never in production) ──────────────────────────

export async function handleDevLogin(request: Request, env: Env): Promise<Response> {
  if (env.ENVIRONMENT === 'production') {
    return json({ error: 'Not found' }, 404);
  }
  const encKey = env.SESSION_ENCRYPTION_KEY;
  const sigKey = env.COOKIE_SIGNING_SECRET;
  if (!encKey || !sigKey) {
    return json({
      error: 'Set SESSION_ENCRYPTION_KEY and COOKIE_SIGNING_SECRET in .dev.vars to use dev-login.',
    }, 500);
  }

  let body: Record<string, unknown> = {};
  try { body = await request.json() as Record<string, unknown>; } catch { /* defaults below */ }

  const email = typeof body.email === 'string' && body.email.trim()
    ? body.email.trim().toLowerCase() : 'dev@example.com';
  const nowSec = Math.floor(Date.now() / 1000);
  const user: SsoUser = {
    sub: typeof body.sub === 'string' && body.sub ? body.sub : `dev-${crypto.randomUUID()}`,
    email,
    firstName: typeof body.firstName === 'string' ? body.firstName : 'Dev',
    lastName: typeof body.lastName === 'string' ? body.lastName : 'User',
    isMember: body.isMember === true,
    memberTier: null,
    iat: nowSec,
    exp: nowSec + 8 * 3600,
    sid: `dev-${crypto.randomUUID()}`,
  };

  const value = await buildAuthCookieValue(user, encKey, sigKey);
  const response = json({ ok: true, user: { email: user.email, isMember: user.isMember } });
  // No Domain attribute → host-only cookie, works on localhost.
  response.headers.append(
    'Set-Cookie',
    `${AUTH_COOKIE_NAME}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${8 * 3600}`,
  );
  return response;
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
