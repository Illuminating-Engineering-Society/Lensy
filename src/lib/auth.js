/**
 * Shared-secret authentication for write/admin endpoints.
 *
 * All corpus-mutating endpoints (/api/ingest*, /api/admin/*) require the
 * LUCIUS_API_SECRET shared secret (set via `wrangler secret put`).
 *
 * Fail-closed in production: if the secret is not configured and
 * ENVIRONMENT === 'production', every request is rejected — an unauthenticated
 * ingest endpoint would let anyone overwrite the indexed corpus. Outside
 * production (local `wrangler dev` has no secrets), requests are allowed so
 * the local pipeline still works.
 */

/**
 * @returns {Promise<{ ok: boolean, reason?: string }>}
 */
export async function checkAuth(request, env) {
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
async function timingSafeEqual(a, b) {
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
