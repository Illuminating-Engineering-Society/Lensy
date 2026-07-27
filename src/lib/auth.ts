/**
 * Shared-secret authentication — the MACHINE path into the write/admin
 * endpoints (/api/ingest*, /api/admin/*): scripts, cron and curl, which have no
 * browser session. Humans go through SSO instead; workers/session.ts
 * requireAdminAccess() tries this first, then the ies_auth cookie.
 *
 * Only consulted when the caller actually sends an Authorization header, so a
 * missing LUCIUS_API_SECRET never blocks a cookie-authenticated admin.
 *
 * Fail-closed in production: if a bearer is presented and the secret is not
 * configured while ENVIRONMENT === 'production', it is rejected — an
 * unauthenticated ingest endpoint would let anyone overwrite the indexed
 * corpus. Outside production (local `wrangler dev` has no secrets), any bearer
 * is accepted so the local pipeline still works.
 */

export interface AuthResult {
  ok: boolean;
  reason?: string;
}

export async function checkAuth(request: Request, env: Env): Promise<AuthResult> {
  const expected = env.LUCIUS_API_SECRET;
  if (!expected) {
    if (env.ENVIRONMENT === 'production') {
      return {
        ok: false,
        reason: 'LUCIUS_API_SECRET is not configured. Set it with `wrangler secret put LUCIUS_API_SECRET` — write endpoints fail closed in production.',
      };
    }
    return { ok: true }; // local dev without a secret
  }

  const header = request.headers.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : header;
  return { ok: await timingSafeEqual(token, expected) };
}

/**
 * Constant-time string comparison. Comparing SHA-256 digests makes the
 * comparison independent of where the strings first differ AND of their
 * lengths, so the check leaks no timing signal about the secret.
 */
async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [da, db] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b)),
  ]);
  const ua = new Uint8Array(da);
  const ub = new Uint8Array(db);
  let diff = 0;
  for (let i = 0; i < ua.length; i++) diff |= ua[i] ^ ub[i];
  return diff === 0;
}
