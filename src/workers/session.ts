/**
 * Lensy Session Endpoints — SSO against auth.ies.org (see lib/sso.ts).
 *
 *   GET  /api/auth/me         Who am I + am I allowed in. The frontend gates
 *                             the whole UI on this response.
 *   POST /api/auth/dev-login  LOCAL DEV ONLY (404 in production): mints an
 *                             ies_auth cookie with the local .dev.vars secrets
 *                             so the flow is testable without running the IdP.
 *
 * Plus the two server-side gates every route goes through:
 *
 *   requireReadAccess()   read API (/api/search etc.) — a valid ies_auth
 *                         cookie that passes the access decision, OR an
 *                         explicit LUCIUS_API_SECRET bearer (staff scripts).
 *   requireAdminAccess()  staff API (/api/admin/*, /api/ingest*) — the same
 *                         cookie, additionally carrying admin rights (the
 *                         IdP's `administrator` role, or a Lensy invite row
 *                         with role 'admin'), OR the same bearer for scripts.
 *
 * The bearer stays as the MACHINE path: ingest/cleanup scripts and cron have
 * no browser session. Humans no longer type it anywhere — /admin/users.html is
 * gated by SSO like every other page.
 */

import { checkAuth } from '../lib/auth';
import { resolveTier, liteEnabled, type LensyTier } from '../lib/tiers';
import {
  getSsoState,
  decideAccess,
  buildLoginUrl,
  buildLogoutUrl,
  buildAuthCookieValue,
  AUTH_COOKIE_NAME,
  type AccessDecision,
  type SsoState,
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
  const sso = await getSsoState(request, env);

  // Secrets out of step with the IdP: the cookie is real but unreadable here,
  // so /login would hand back the same one forever. Report it as a 503 config
  // fault (the gate shows an explicit message) instead of looping.
  if (sso.state === 'misconfigured') {
    console.error('sso_misconfigured', { detail: sso.detail });
    return json({
      authenticated: false,
      authorized: false,
      reason: 'sso_misconfigured',
      detail: sso.detail,
    }, 503);
  }

  if (sso.state === 'anonymous') {
    return json({
      authenticated: false,
      loginUrl: buildLoginUrl(env, request.url),
    }, 401);
  }

  const user = sso.user;
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
      // Which Lensy this account gets (client DO53). The UI locks the tools
      // LensyLite excludes; the search Worker enforces the same rule again.
      tier: tierFor(user, decision, env),
      liteEnabled: liteEnabled(env),
      // What the /admin pages gate on. The API enforces it again server-side
      // (requireAdminAccess) — this only decides what the UI offers.
      isAdmin: decision.admin,
      // Full IdP role slug list, informational.
      idpRoles: user.roles,
    },
    logoutUrl: buildLogoutUrl(env, request.url),
  });
}

// ─── Access tier (client DO53) ────────────────────────────────────────────────

/** The tier for one authorized session. */
function tierFor(user: SsoUser, decision: AccessDecision, env: Env): LensyTier {
  return resolveTier({
    roles: user.roles,
    isMember: user.isMember,
    memberTier: user.memberTier ?? null,
    // What the invitation itself grants, independent of anything Wicket knows
    // about them. Null for the members-without-invite path, which has no row.
    inviteTier: decision.tier ?? null,
    admin: decision.admin,
  }, env);
}

/**
 * The tier a REQUEST is entitled to, for the endpoints that enforce it.
 *
 * Scripts and cron authenticate with the bearer secret and are always 'full' —
 * ingest and the verification harness must see the whole corpus. A cookie
 * session resolves through decideAccess, and a request with neither (which the
 * route gate has already rejected) is 'none'.
 */
export async function resolveRequestTier(request: Request, env: Env): Promise<LensyTier> {
  if (!liteEnabled(env)) return 'full';
  if (request.headers.get('authorization')) {
    const viaSecret = await checkAuth(request, env);
    if (viaSecret.ok) return 'full';
  }
  const gate = await evaluateSession(request, env);
  if (!gate.ok) return 'none';
  return tierFor(gate.user, gate.decision, env);
}

// ─── Shared gate plumbing ─────────────────────────────────────────────────────

type SessionGate =
  | { ok: true; user: SsoUser; decision: AccessDecision }
  | { ok: false; response: Response };

/**
 * Cookie → access decision, with the 401/403/503 both gates answer with when
 * there is no usable session. Shared so the read gate and the admin gate can
 * never drift on what "signed in and allowed" means.
 */
async function evaluateSession(request: Request, env: Env): Promise<SessionGate> {
  const sso: SsoState = await getSsoState(request, env);

  if (sso.state === 'misconfigured') {
    console.error('sso_misconfigured', { detail: sso.detail });
    return { ok: false, response: json({ error: 'sso_misconfigured', detail: sso.detail }, 503) };
  }
  if (sso.state === 'anonymous') {
    return {
      ok: false,
      response: json({
        error: 'authentication_required',
        loginUrl: buildLoginUrl(env, request.url),
      }, 401),
    };
  }

  const row = await findInvite(env, sso.user.email);
  const decision = decideAccess(sso.user, row, allowMembersWithoutInvite(env), Date.now());
  if (!decision.authorized) {
    return {
      ok: false,
      response: json({ error: 'access_denied', reason: decision.reason }, 403),
    };
  }
  return { ok: true, user: sso.user, decision };
}

/**
 * The bearer path, kept for scripts/cron that have no cookie. Returns null when
 * no Authorization header was sent (→ fall through to the cookie), or the 401
 * to answer with when a header was sent but is wrong. An explicitly-supplied
 * bad token is never retried as a session: it is a broken script, not a user.
 */
async function bearerOutcome(request: Request, env: Env): Promise<Response | null | 'ok'> {
  if (!request.headers.get('authorization')) return null;
  const viaSecret = await checkAuth(request, env);
  if (viaSecret.ok) return 'ok';
  return json({ error: viaSecret.reason || 'unauthorized' }, viaSecret.reason ? 503 : 401);
}

/**
 * CSRF guard for cookie-authenticated writes. `ies_auth` is SameSite=Lax, so a
 * cross-site POST never carries it — this is the second lock: a browser always
 * sends Origin on non-GET, so a mismatched or absent one on a write is not a
 * request our own pages made. Bearer clients skip this (they are not browsers
 * and hold a secret no other site can obtain).
 */
function originMismatch(request: Request): Response | null {
  if (request.method === 'GET' || request.method === 'HEAD') return null;
  const origin = request.headers.get('origin');
  if (origin && origin === new URL(request.url).origin) return null;
  return json({ error: 'bad_origin', detail: 'Cross-origin write rejected.' }, 403);
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
  // A wrong bearer here falls through to the cookie rather than failing: the
  // read API is also called by pages that may send a stale header.
  if (request.headers.get('authorization')) {
    const viaSecret = await checkAuth(request, env);
    if (viaSecret.ok) return null;
  }

  const gate = await evaluateSession(request, env);
  return gate.ok ? null : gate.response;
}

/**
 * Gate for the endpoints that hand out STANDARDS CONTENT — search results and
 * the illuminance dataset. Returns null when the request may proceed.
 *
 * `requireReadAccess` answers "is this a real session?", and since the door
 * stopped denying `not_invited` that is true for every authenticated IES
 * account. This answers the separate question "is this session entitled to the
 * corpus at all?", which is what tier 'none' means.
 *
 * It has to exist as its own check. Before the door opened, 'none' was enforced
 * only by decideAccess refusing entry — `handleSearch` looks exclusively for
 * 'lite', so a 'none' request that reached it would have been served as though
 * it were 'full'. Opening the door without this would have handed the whole
 * Lighting Library to all 65,945 accounts.
 */
export async function requireCorpusAccess(
  request: Request,
  env: Env,
  minimum: LensyTier = 'lite',
): Promise<Response | null> {
  const denied = await requireReadAccess(request, env);
  if (denied) return denied;

  const tier = await resolveRequestTier(request, env);
  const rank = { none: 0, lite: 1, full: 2 } as const;
  if (rank[tier] >= rank[minimum]) return null;

  return new Response(
    JSON.stringify({
      error: 'subscription_required',
      tier,
      message:
        tier === 'none'
          ? 'A Lighting Library subscription or an active IES membership is required to search the standards.'
          : 'This content is part of the full Lighting Library subscription.',
    }),
    { status: 403, headers: { 'Content-Type': 'application/json' } },
  );
}

// ─── Admin/staff gate ─────────────────────────────────────────────────────────

/**
 * Gate for every staff endpoint (/api/admin/*, /api/ingest*). Returns null when
 * the request may proceed, else the response to short-circuit with.
 *
 * Two ways in, in order:
 *  1. `Authorization: Bearer LUCIUS_API_SECRET` — scripts, cron, curl. A header
 *     that is present but wrong is a hard 401; we do not silently downgrade it
 *     to a session check.
 *  2. The `ies_auth` SSO cookie, where decideAccess() says `admin` — i.e. the
 *     IdP's `administrator` role, or a Lensy invite row with role 'admin'.
 *     Writes additionally require a same-origin Origin header.
 *
 * The 403 bodies name which wall was hit (`access_denied` = not a Lensy user at
 * all; `admin_required` = a legitimate user without staff rights) so the gate
 * can say the right thing instead of a generic "no".
 */
export async function requireAdminAccess(request: Request, env: Env): Promise<Response | null> {
  const bearer = await bearerOutcome(request, env);
  if (bearer === 'ok') return null;
  if (bearer) return bearer;

  const gate = await evaluateSession(request, env);
  if (!gate.ok) return gate.response;

  if (!gate.decision.admin) {
    return json({
      error: 'admin_required',
      detail: 'This area is limited to IES administrators.',
      email: gate.user.email,
    }, 403);
  }
  return originMismatch(request);
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
  const isMember = body.isMember === true;
  const nowSec = Math.floor(Date.now() / 1000);
  const user: SsoUser = {
    sub: typeof body.sub === 'string' && body.sub ? body.sub : `dev-${crypto.randomUUID()}`,
    email,
    firstName: typeof body.firstName === 'string' ? body.firstName : 'Dev',
    lastName: typeof body.lastName === 'string' ? body.lastName : 'User',
    isMember,
    memberTier: typeof body.memberTier === 'string' ? body.memberTier : null,
    // Mirror what the IdP actually mints: it always sends `roles`, and derives
    // "member" from the directory. Keeping the shapes identical means local dev
    // exercises the same parse path as production.
    roles: Array.isArray(body.roles)
      ? body.roles.filter((r): r is string => typeof r === 'string').map((r) => r.toLowerCase())
      : isMember ? ['member'] : [],
    iat: nowSec,
    exp: nowSec + 8 * 3600,
    sid: `dev-${crypto.randomUUID()}`,
  };

  const value = await buildAuthCookieValue(user, encKey, sigKey);
  const response = json({
    ok: true,
    user: { email: user.email, isMember: user.isMember, roles: user.roles },
  });
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
