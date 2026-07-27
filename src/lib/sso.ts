/**
 * SSO against the IES Auth IDP (auth.ies.org — the AuthIES Worker).
 *
 * Lensy is registered there as a COOKIE Service Provider: after login the IdP
 * sets the shared `ies_auth` cookie on `.ies.org`, and lensy.ies.org verifies
 * and decrypts it here — no OAuth round-trips, no token storage.
 *
 * AuthIES authenticates natively: the IdP serves its own login form and checks a
 * PBKDF2 hash in its D1 user directory. The Wicket CAS hand-off is deleted, not
 * merely switched off — there is no `AUTH_MODE`, and `ies-login.wicketcloud.com`
 * appears in no code path. Nothing in the cookie contract changed (AuthIES plan
 * §10, "Impact on Service Providers: none"), but two things did:
 *
 *  - the payload now carries `roles` (lowercase IdP role slugs from the
 *    directory, e.g. ["administrator","member"]) — modelled below, surfaced by
 *    /api/auth/me, and used for ONE thing: the `administrator` slug is what
 *    makes someone a Lensy admin (see decideAccess). It grants nothing else;
 *  - every pre-existing IES account starts `pending` and must set a password
 *    from an emailed link before it can ever produce an ies_auth cookie. Such
 *    users reach Lensy as plain anonymous visitors, so the gate must invite
 *    them to sign in rather than report an error.
 *
 * Cookie scheme (MUST stay byte-identical to AuthIES src/lib/crypto.ts):
 *   value     = {b64url(iv)}.{b64url(AES-256-GCM ciphertext+tag)}.{b64url(HMAC)}
 *   AES key   = SHA-256(SESSION_ENCRYPTION_KEY)          (32 bytes)
 *   HMAC key  = UTF-8 bytes of COOKIE_SIGNING_SECRET
 *   HMAC over = "{b64url(iv)}.{b64url(ciphertext)}"      (encrypt-then-MAC)
 *
 * Both secrets are the SAME values as the AuthIES Worker's
 * (`wrangler secret put SESSION_ENCRYPTION_KEY / COOKIE_SIGNING_SECRET`).
 *
 * Crypto helpers take the secrets as arguments (not env) so they are
 * unit-testable with plain vitest; only the request-level helpers touch Env.
 */

import { effectiveStatus, type InviteAccessRow } from './invites';

export const AUTH_COOKIE_NAME = 'ies_auth';

/** Payload inside ies_auth (AuthIES types.ts AuthCookiePayload). */
export interface SsoUser {
  /**
   * AuthIES `users.person_uuid`: the Wicket UUID for accounts imported from
   * Wicket, a freshly generated UUID for IdP-local accounts. Stable per
   * account either way — safe to persist as invited_users.person_uuid.
   */
  sub: string;
  email: string;
  firstName: string;
  lastName: string;
  isMember: boolean;
  memberTier?: string | null;
  /**
   * IdP role slugs, normalized lowercase. Always an array after parsing (`[]`
   * for cookies minted before AuthIES added the field). Only `administrator`
   * is acted on (see decideAccess); the rest are informational.
   */
  roles: string[];
  exp: number; // unix seconds
  iat: number;
  sid: string; // IdP session id
}

// ── encoding ─────────────────────────────────────────────────────────────────

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function b64urlEncode(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  for (const b of view) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(str: string): Uint8Array {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

// ── crypto (mirror of AuthIES) ───────────────────────────────────────────────

async function deriveAesKey(keyMaterial: string): Promise<CryptoKey> {
  const hash = await crypto.subtle.digest('SHA-256', encoder.encode(keyMaterial));
  return crypto.subtle.importKey('raw', hash, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw', encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'],
  );
}

/**
 * Build a full ies_auth cookie VALUE. Production cookies are minted by the
 * IdP — Lensy only needs this for the local dev-login endpoint and tests.
 */
export async function buildAuthCookieValue(
  payload: SsoUser,
  encryptionKey: string,
  signingSecret: string,
): Promise<string> {
  const aesKey = await deriveAesKey(encryptionKey);
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, aesKey, encoder.encode(JSON.stringify(payload)),
  );
  const enc = `${b64urlEncode(iv)}.${b64urlEncode(ciphertext)}`;
  const hmacKey = await importHmacKey(signingSecret);
  const sig = await crypto.subtle.sign('HMAC', hmacKey, encoder.encode(enc));
  return `${enc}.${b64urlEncode(sig)}`;
}

/**
 * Why a cookie was rejected. The split matters operationally:
 *
 *  - `expired` / `malformed` are normal — a session that simply ran out, or a
 *    stale/truncated cookie. The visitor is treated as anonymous and offered
 *    sign-in.
 *  - `bad_signature` / `undecryptable` / `bad_payload` mean this Worker and the
 *    IdP disagree about the secrets (a rotation applied on one side only). The
 *    cookie is valid to the IdP, so bouncing the user to /login just hands the
 *    same unreadable cookie back — an infinite loop. These surface as an
 *    explicit configuration error instead.
 */
export type CookieFailure =
  | 'malformed'
  | 'bad_signature'
  | 'undecryptable'
  | 'bad_payload'
  | 'expired';

export type CookieResult =
  | { ok: true; user: SsoUser }
  | { ok: false; failure: CookieFailure };

/** True when the failure means "secrets don't match the IdP", not "no session". */
export function isSecretMismatch(failure: CookieFailure): boolean {
  return failure === 'bad_signature' || failure === 'undecryptable' || failure === 'bad_payload';
}

/** Verify HMAC, decrypt, validate shape + expiry, reporting why on failure. */
export async function verifyAuthCookieValue(
  value: string,
  encryptionKey: string,
  signingSecret: string,
  nowMs: number,
): Promise<CookieResult> {
  const parts = value.split('.');
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
    return { ok: false, failure: 'malformed' };
  }
  const enc = `${parts[0]}.${parts[1]}`;

  let signatureValid: boolean;
  try {
    const hmacKey = await importHmacKey(signingSecret);
    signatureValid = await crypto.subtle.verify(
      'HMAC', hmacKey, b64urlDecode(parts[2]), encoder.encode(enc),
    );
  } catch {
    // Non-base64url signature segment — junk, not a key disagreement.
    return { ok: false, failure: 'malformed' };
  }
  if (!signatureValid) return { ok: false, failure: 'bad_signature' };

  // Past this point the HMAC matched, so COOKIE_SIGNING_SECRET agrees and the
  // cookie really came from the IdP: any further failure is our own config.
  let payload: unknown;
  try {
    const aesKey = await deriveAesKey(encryptionKey);
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: b64urlDecode(parts[0]) }, aesKey, b64urlDecode(parts[1]),
    );
    payload = JSON.parse(decoder.decode(plaintext));
  } catch {
    return { ok: false, failure: 'undecryptable' };
  }

  const user = toSsoUser(payload);
  if (!user) return { ok: false, failure: 'bad_payload' };
  if (user.exp <= Math.floor(nowMs / 1000)) return { ok: false, failure: 'expired' };
  return { ok: true, user };
}

/** Back-compat wrapper: the authenticated user, or null on any failure. */
export async function parseAuthCookieValue(
  value: string,
  encryptionKey: string,
  signingSecret: string,
  nowMs: number,
): Promise<SsoUser | null> {
  const result = await verifyAuthCookieValue(value, encryptionKey, signingSecret, nowMs);
  return result.ok ? result.user : null;
}

/**
 * Validate the decrypted payload and normalize `roles`. Mirrors AuthIES
 * parseAuthCookie(): the same four required fields, and roles coerced to a
 * string[] so a cookie minted before the field existed still parses.
 */
function toSsoUser(v: unknown): SsoUser | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  if (
    typeof o.sub !== 'string' ||
    typeof o.email !== 'string' ||
    typeof o.exp !== 'number' ||
    typeof o.sid !== 'string'
  ) {
    return null;
  }
  return {
    ...(o as unknown as SsoUser),
    // Lowercased here as well as at the IdP: the admin check compares against a
    // literal slug, and a stray "Administrator" must not silently miss.
    roles: Array.isArray(o.roles)
      ? o.roles.filter((r): r is string => typeof r === 'string').map((r) => r.toLowerCase())
      : [],
  };
}

// ── request helpers ──────────────────────────────────────────────────────────

export function parseCookies(request: Request): Record<string, string> {
  const header = request.headers.get('Cookie');
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const pair of header.split(';')) {
    const idx = pair.indexOf('=');
    if (idx === -1) continue;
    const name = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    if (name) out[name] = decodeURIComponent(value);
  }
  return out;
}

/**
 * The request's SSO state. Distinguishes the four cases the gate must handle
 * differently: a signed-in user, nobody, a secret disagreement with the IdP,
 * and this Worker having no SSO secrets at all.
 */
export type SsoState =
  | { state: 'ok'; user: SsoUser }
  | { state: 'anonymous' }
  | { state: 'misconfigured'; detail: 'secrets_missing' | CookieFailure };

export async function getSsoState(request: Request, env: Env): Promise<SsoState> {
  const encKey = env.SESSION_ENCRYPTION_KEY;
  const sigKey = env.COOKIE_SIGNING_SECRET;
  // Deploy-order mistake, not a visitor problem: say so instead of looping the
  // whole site through a login that can never be verified.
  if (!encKey || !sigKey) return { state: 'misconfigured', detail: 'secrets_missing' };

  const cookie = parseCookies(request)[AUTH_COOKIE_NAME];
  if (!cookie) return { state: 'anonymous' };

  const result = await verifyAuthCookieValue(cookie, encKey, sigKey, Date.now());
  if (result.ok) return { state: 'ok', user: result.user };
  if (isSecretMismatch(result.failure)) {
    return { state: 'misconfigured', detail: result.failure };
  }
  return { state: 'anonymous' }; // expired or junk → offer sign-in
}

/**
 * Where to send the browser back to after the IdP round-trip. The path is
 * preserved so a deep link survives login — including the activation detour,
 * which carries sp/redirect_uri/state through the emailed set-password link.
 * AuthIES validates this against the `lensy` SP's registered origins, whose
 * "/" path prefix admits any path under them (AuthIES lib/redirect.ts).
 *
 * `?returnTo=` names the page to come back to. The gate sends it because it
 * calls /api/auth/me, which cannot otherwise know which page is being gated.
 * Only a same-origin absolute path is honoured — a caller-supplied value must
 * never be able to redirect off-site.
 */
export function resolveReturnTo(requestUrl: string): string {
  const url = new URL(requestUrl);
  const requested = url.searchParams.get('returnTo');
  if (requested && isSafePath(requested)) return url.origin + requested;

  // No hint: bounce to the requested page, unless it is an API/auth route that
  // is never a landing page.
  const isRoute =
    url.pathname.startsWith('/api/') || url.pathname === '/login' || url.pathname === '/logout';
  return url.origin + (isRoute ? '/' : url.pathname + url.search);
}

/** A rooted path, not a protocol-relative ("//host") or scheme-bearing URL. */
function isSafePath(value: string): boolean {
  return value.startsWith('/') && !value.startsWith('//') && !value.includes('\\');
}

/** URL to start the SSO flow at the IdP and land back on this deployment. */
export function buildLoginUrl(env: Env, requestUrl: string): string {
  const back = encodeURIComponent(resolveReturnTo(requestUrl));
  return `${env.AUTH_IDP_BASE_URL}/login?sp=lensy&redirect_uri=${back}`;
}

/** IdP single-logout URL that returns to this deployment. */
export function buildLogoutUrl(env: Env, requestUrl: string): string {
  const home = new URL(requestUrl).origin + '/';
  return `${env.AUTH_IDP_BASE_URL}/logout?redirect_uri=${encodeURIComponent(home)}`;
}

// ── access decision (pure — see invites.ts for the allowlist semantics) ─────

export interface InviteDecisionRow extends InviteAccessRow {
  role: string;
  person_uuid: string | null;
}

export interface AccessDecision {
  authorized: boolean;
  /** Set when denied. */
  reason?: 'revoked' | 'expired' | 'not_invited';
  /** invited_users.role, or 'member' for the members-without-invite path. */
  role?: string;
  /**
   * May use the staff surfaces (/admin/*, /api/admin/*, /api/ingest*). Always
   * false on a denial — a denied session is not an admin session.
   */
  admin: boolean;
  /** True when the invite row should be activated (first SSO login). */
  firstLogin: boolean;
}

/** The IdP role slug that makes someone an IES administrator. */
export const IDP_ADMIN_ROLE = 'administrator';

/** Does the cookie carry the IdP-wide `administrator` role? */
export function hasIdpAdminRole(user: SsoUser): boolean {
  return user.roles.includes(IDP_ADMIN_ROLE);
}

/**
 * Who gets in:
 *  - a row in invited_users decides for its email — revoked/expired deny even
 *    for IES members AND for IdP administrators (an explicit staff decision
 *    must win; revoke is how you lock someone out);
 *  - no row: IdP administrators get in, then IES members (isMember) iff
 *    allowMembersWithoutInvite (ALLOW_MEMBERS_WITHOUT_INVITE var); everyone
 *    else needs an invite.
 *
 * `isMember` is now read from the IdP's D1 directory (kept fresh by its
 * read-only Wicket membership sync) rather than fetched from Wicket at each
 * login, so a lapsed membership stops granting the bypass only once that sync
 * lands. Guest access is unaffected — invited_users carries its own expiry.
 *
 * Who is an ADMIN (the `admin` flag — staff pages and write endpoints):
 * the IdP's `administrator` role slug, or a Lensy invite row with role
 * 'admin'. The IdP role is the primary path: IES staff are administrators in
 * the directory and should not need a second grant here. The invite row stays
 * as the local escape hatch for an admin without the IdP role.
 *
 * Note admins are still ordinary members of the corpus gate — an administrator
 * whose invite row is revoked is denied outright, admin flag included.
 */
export function decideAccess(
  user: SsoUser,
  row: InviteDecisionRow | null,
  allowMembersWithoutInvite: boolean,
  nowMs: number,
): AccessDecision {
  const idpAdmin = hasIdpAdminRole(user);

  if (row) {
    const status = effectiveStatus(row, nowMs);
    if (status === 'revoked') {
      return { authorized: false, reason: 'revoked', admin: false, firstLogin: false };
    }
    if (status === 'expired') {
      return { authorized: false, reason: 'expired', admin: false, firstLogin: false };
    }
    return {
      authorized: true,
      role: row.role,
      admin: idpAdmin || row.role === 'admin',
      firstLogin: status === 'invited' || !row.person_uuid,
    };
  }
  if (idpAdmin) {
    // IES staff reach the dashboard on their IdP role alone — no invite row,
    // and no dependency on whether they hold a membership.
    return { authorized: true, role: 'admin', admin: true, firstLogin: false };
  }
  if (allowMembersWithoutInvite && user.isMember) {
    return { authorized: true, role: 'member', admin: false, firstLogin: false };
  }
  return { authorized: false, reason: 'not_invited', admin: false, firstLogin: false };
}
