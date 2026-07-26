/**
 * SSO against the IES Auth IDP (auth.ies.org — the AuthIES Worker).
 *
 * Lensy is registered there as a COOKIE Service Provider: after login the IdP
 * sets the shared `ies_auth` cookie on `.ies.org`, and lensy.ies.org verifies
 * and decrypts it here — no OAuth round-trips, no token storage.
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
  sub: string; // Wicket personUuid
  email: string;
  firstName: string;
  lastName: string;
  isMember: boolean;
  memberTier?: string | null;
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

/** Verify HMAC, decrypt, validate shape + expiry. Null on ANY failure. */
export async function parseAuthCookieValue(
  value: string,
  encryptionKey: string,
  signingSecret: string,
  nowMs: number,
): Promise<SsoUser | null> {
  const parts = value.split('.');
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) return null;
  const enc = `${parts[0]}.${parts[1]}`;

  try {
    const hmacKey = await importHmacKey(signingSecret);
    const valid = await crypto.subtle.verify(
      'HMAC', hmacKey, b64urlDecode(parts[2]), encoder.encode(enc),
    );
    if (!valid) return null;

    const aesKey = await deriveAesKey(encryptionKey);
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: b64urlDecode(parts[0]) }, aesKey, b64urlDecode(parts[1]),
    );
    const payload: unknown = JSON.parse(decoder.decode(plaintext));
    if (!isSsoUser(payload)) return null;
    if (payload.exp <= Math.floor(nowMs / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

function isSsoUser(v: unknown): v is SsoUser {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.sub === 'string' &&
    typeof o.email === 'string' &&
    typeof o.exp === 'number' &&
    typeof o.sid === 'string'
  );
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
 * Authenticated IdP user from the request's ies_auth cookie, or null.
 * Null also when the SSO secrets aren't configured on this Worker.
 */
export async function getSsoUser(request: Request, env: Env): Promise<SsoUser | null> {
  const encKey = env.SESSION_ENCRYPTION_KEY;
  const sigKey = env.COOKIE_SIGNING_SECRET;
  if (!encKey || !sigKey) return null;
  const cookie = parseCookies(request)[AUTH_COOKIE_NAME];
  if (!cookie) return null;
  return parseAuthCookieValue(cookie, encKey, sigKey, Date.now());
}

/** URL to start the SSO flow at the IdP and land back on this deployment. */
export function buildLoginUrl(env: Env, requestUrl: string): string {
  const returnTo = new URL(requestUrl).origin + '/';
  return `${env.AUTH_IDP_BASE_URL}/login?sp=lensy&redirect_uri=${encodeURIComponent(returnTo)}`;
}

/** IdP single-logout URL that returns to this deployment. */
export function buildLogoutUrl(env: Env, requestUrl: string): string {
  const returnTo = new URL(requestUrl).origin + '/';
  return `${env.AUTH_IDP_BASE_URL}/logout?redirect_uri=${encodeURIComponent(returnTo)}`;
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
  /** True when the invite row should be activated (first SSO login). */
  firstLogin: boolean;
}

/**
 * Who gets in:
 *  - a row in invited_users decides for its email — revoked/expired deny even
 *    for IES members (an explicit staff decision must win);
 *  - no row: IES members (isMember) get in iff allowMembersWithoutInvite
 *    (ALLOW_MEMBERS_WITHOUT_INVITE var); everyone else needs an invite.
 */
export function decideAccess(
  user: SsoUser,
  row: InviteDecisionRow | null,
  allowMembersWithoutInvite: boolean,
  nowMs: number,
): AccessDecision {
  if (row) {
    const status = effectiveStatus(row, nowMs);
    if (status === 'revoked') return { authorized: false, reason: 'revoked', firstLogin: false };
    if (status === 'expired') return { authorized: false, reason: 'expired', firstLogin: false };
    return {
      authorized: true,
      role: row.role,
      firstLogin: status === 'invited' || !row.person_uuid,
    };
  }
  if (allowMembersWithoutInvite && user.isMember) {
    return { authorized: true, role: 'member', firstLogin: false };
  }
  return { authorized: false, reason: 'not_invited', firstLogin: false };
}
