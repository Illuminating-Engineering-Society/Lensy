import { describe, it, expect } from 'vitest';
import {
  buildAuthCookieValue,
  parseAuthCookieValue,
  verifyAuthCookieValue,
  isSecretMismatch,
  resolveReturnTo,
  buildLoginUrl,
  buildLogoutUrl,
  getSsoState,
  decideAccess,
  hasIdpAdminRole,
} from './sso';

const ENC_KEY = 'test-session-encryption-key';
const SIG_KEY = 'test-cookie-signing-secret';
const NOW = Date.parse('2026-07-26T12:00:00Z');

// Mirrors what AuthIES sessionToCookiePayload() emits today, `roles` included.
function payload(overrides = {}) {
  const nowSec = Math.floor(NOW / 1000);
  return {
    sub: 'person-uuid-1234',
    email: 'dana@firm.com',
    firstName: 'Dana',
    lastName: 'Ruiz',
    isMember: true,
    memberTier: 'Individual',
    roles: ['member'],
    iat: nowSec,
    exp: nowSec + 3600,
    sid: 'sid-abc',
    ...overrides,
  };
}

describe('ies_auth cookie round-trip (must mirror AuthIES crypto.ts)', () => {
  it('builds and parses back the same payload', async () => {
    const value = await buildAuthCookieValue(payload(), ENC_KEY, SIG_KEY);
    expect(value.split('.')).toHaveLength(3);
    const parsed = await parseAuthCookieValue(value, ENC_KEY, SIG_KEY, NOW);
    expect(parsed).toEqual(payload());
  });

  it('carries the IdP roles array through verbatim', async () => {
    const roles = ['administrator', 'member', 'staff'];
    const value = await buildAuthCookieValue(payload({ roles }), ENC_KEY, SIG_KEY);
    const parsed = await parseAuthCookieValue(value, ENC_KEY, SIG_KEY, NOW);
    expect(parsed.roles).toEqual(roles);
  });

  it('normalizes roles when the IdP omits or mangles the field', async () => {
    const cases = [
      [{}, []],                                   // cookie minted before roles existed
      [{ roles: null }, []],
      [{ roles: 'administrator' }, []],           // not an array → ignored
      [{ roles: ['member', 7, null] }, ['member']], // non-strings dropped
      // Lowercased on the way in: the admin check compares to a literal slug.
      [{ roles: ['Administrator', 'MEMBER'] }, ['administrator', 'member']],
    ];
    for (const [overrides, expected] of cases) {
      const raw = payload();
      delete raw.roles;
      const value = await buildAuthCookieValue({ ...raw, ...overrides }, ENC_KEY, SIG_KEY);
      const parsed = await parseAuthCookieValue(value, ENC_KEY, SIG_KEY, NOW);
      expect(parsed.roles).toEqual(expected);
    }
  });

  it('rejects an expired cookie', async () => {
    const nowSec = Math.floor(NOW / 1000);
    const value = await buildAuthCookieValue(
      payload({ exp: nowSec - 1 }), ENC_KEY, SIG_KEY,
    );
    expect(await parseAuthCookieValue(value, ENC_KEY, SIG_KEY, NOW)).toBe(null);
  });

  it('rejects a tampered signature', async () => {
    const value = await buildAuthCookieValue(payload(), ENC_KEY, SIG_KEY);
    const parts = value.split('.');
    const sig = parts[2];
    const flipped = (sig[0] === 'A' ? 'B' : 'A') + sig.slice(1);
    const tampered = `${parts[0]}.${parts[1]}.${flipped}`;
    expect(await parseAuthCookieValue(tampered, ENC_KEY, SIG_KEY, NOW)).toBe(null);
  });

  it('rejects tampered ciphertext even if re-signed with the wrong key', async () => {
    const value = await buildAuthCookieValue(payload(), ENC_KEY, SIG_KEY);
    const forged = await buildAuthCookieValue(payload({ isMember: true }), 'other-enc', 'other-sig');
    expect(await parseAuthCookieValue(forged, ENC_KEY, SIG_KEY, NOW)).toBe(null);
    // Sanity: the untampered original still parses.
    expect(await parseAuthCookieValue(value, ENC_KEY, SIG_KEY, NOW)).not.toBe(null);
  });

  it('rejects wrong secrets and malformed values', async () => {
    const value = await buildAuthCookieValue(payload(), ENC_KEY, SIG_KEY);
    expect(await parseAuthCookieValue(value, 'wrong', SIG_KEY, NOW)).toBe(null);
    expect(await parseAuthCookieValue(value, ENC_KEY, 'wrong', NOW)).toBe(null);
    expect(await parseAuthCookieValue('garbage', ENC_KEY, SIG_KEY, NOW)).toBe(null);
    expect(await parseAuthCookieValue('a.b', ENC_KEY, SIG_KEY, NOW)).toBe(null);
    expect(await parseAuthCookieValue('', ENC_KEY, SIG_KEY, NOW)).toBe(null);
  });
});

// A rotated secret and a lapsed session both fail to parse, but they need
// opposite handling: re-login fixes one and loops forever on the other.
describe('verifyAuthCookieValue failure classification', () => {
  async function failureOf(value, encKey = ENC_KEY, sigKey = SIG_KEY) {
    const result = await verifyAuthCookieValue(value, encKey, sigKey, NOW);
    expect(result.ok).toBe(false);
    return result.failure;
  }

  it('flags an out-of-step SESSION_ENCRYPTION_KEY as a secret mismatch', async () => {
    const value = await buildAuthCookieValue(payload(), 'rotated-enc-key', SIG_KEY);
    const failure = await failureOf(value);
    expect(failure).toBe('undecryptable');
    expect(isSecretMismatch(failure)).toBe(true);
  });

  it('flags an out-of-step COOKIE_SIGNING_SECRET as a secret mismatch', async () => {
    const value = await buildAuthCookieValue(payload(), ENC_KEY, 'rotated-sig-secret');
    const failure = await failureOf(value);
    expect(failure).toBe('bad_signature');
    expect(isSecretMismatch(failure)).toBe(true);
  });

  it('treats an expired session as ordinary, not a misconfiguration', async () => {
    const nowSec = Math.floor(NOW / 1000);
    const value = await buildAuthCookieValue(payload({ exp: nowSec - 1 }), ENC_KEY, SIG_KEY);
    const failure = await failureOf(value);
    expect(failure).toBe('expired');
    expect(isSecretMismatch(failure)).toBe(false);
  });

  it('treats junk cookies as malformed, not a misconfiguration', async () => {
    for (const junk of ['', 'garbage', 'a.b', 'a.b.c']) {
      const failure = await failureOf(junk);
      expect(failure).toBe('malformed');
      expect(isSecretMismatch(failure)).toBe(false);
    }
  });

  it('flags a signed cookie whose payload lost required fields', async () => {
    const raw = payload();
    delete raw.sub;
    const value = await buildAuthCookieValue(raw, ENC_KEY, SIG_KEY);
    const failure = await failureOf(value);
    expect(failure).toBe('bad_payload');
    expect(isSecretMismatch(failure)).toBe(true);
  });
});

// A deep link must survive the IdP round-trip, but redirect_uri is
// caller-influenced — it may never leave lensy.ies.org.
describe('resolveReturnTo / buildLoginUrl', () => {
  const ORIGIN = 'https://lensy.ies.org';

  it('honours an explicit same-origin returnTo path', () => {
    expect(resolveReturnTo(`${ORIGIN}/api/auth/me?returnTo=%2Fprojects.html`))
      .toBe(`${ORIGIN}/projects.html`);
    expect(resolveReturnTo(`${ORIGIN}/api/auth/me?returnTo=%2Fprojects.html%3Fid%3D7`))
      .toBe(`${ORIGIN}/projects.html?id=7`);
  });

  it('refuses off-site and scheme-bearing returnTo values', () => {
    const hostile = [
      'https%3A%2F%2Fevil.example%2Fx',   // absolute URL
      '%2F%2Fevil.example%2Fx',           // protocol-relative
      '%5C%5Cevil.example',               // backslash host
      'projects.html',                    // not rooted
    ];
    for (const value of hostile) {
      expect(resolveReturnTo(`${ORIGIN}/api/auth/me?returnTo=${value}`)).toBe(`${ORIGIN}/`);
    }
  });

  it('falls back to the requested page, or "/" for API and auth routes', () => {
    expect(resolveReturnTo(`${ORIGIN}/projects.html`)).toBe(`${ORIGIN}/projects.html`);
    expect(resolveReturnTo(`${ORIGIN}/api/search`)).toBe(`${ORIGIN}/`);
    expect(resolveReturnTo(`${ORIGIN}/login`)).toBe(`${ORIGIN}/`);
    expect(resolveReturnTo(`${ORIGIN}/logout`)).toBe(`${ORIGIN}/`);
  });

  it('builds the IdP login URL with sp=lensy and an encoded redirect_uri', () => {
    const env = { AUTH_IDP_BASE_URL: 'https://auth.ies.org' };
    expect(buildLoginUrl(env, `${ORIGIN}/api/auth/me?returnTo=%2Fprojects.html`)).toBe(
      'https://auth.ies.org/login?sp=lensy&redirect_uri=' +
        encodeURIComponent('https://lensy.ies.org/projects.html'),
    );
  });
});

// lensy-staging.ies.org is a second custom domain on the SAME Worker. The one
// thing that may differ by hostname is the IdP (and, when configured, the
// secret pair that verifies its cookies) — each IdP's SP allowlist only admits
// its own Lensy origin, so a staging visitor sent to auth.ies.org is rejected.
describe('staging host detection (lensy-staging.ies.org)', () => {
  const STG = 'https://lensy-staging.ies.org';
  const env = {
    AUTH_IDP_BASE_URL: 'https://auth.ies.org',
    SESSION_ENCRYPTION_KEY: ENC_KEY,
    COOKIE_SIGNING_SECRET: SIG_KEY,
  };

  it('sends staging-host visitors to the staging IdP for login', () => {
    expect(buildLoginUrl(env, `${STG}/api/auth/me?returnTo=%2Fprojects.html`)).toBe(
      'https://auth-staging.ies.org/login?sp=lensy&redirect_uri=' +
        encodeURIComponent(`${STG}/projects.html`),
    );
  });

  it('sends staging-host visitors to the staging IdP for logout', () => {
    expect(buildLogoutUrl(env, `${STG}/anything`)).toBe(
      'https://auth-staging.ies.org/logout?redirect_uri=' + encodeURIComponent(`${STG}/`),
    );
  });

  it('the production host keeps using AUTH_IDP_BASE_URL', () => {
    expect(buildLogoutUrl(env, 'https://lensy.ies.org/anything')).toBe(
      'https://auth.ies.org/logout?redirect_uri=' +
        encodeURIComponent('https://lensy.ies.org/'),
    );
  });

  // getSsoState verifies against Date.now(), so mint cookies that are live NOW.
  function liveCookiePayload() {
    const nowSec = Math.floor(Date.now() / 1000);
    return payload({ iat: nowSec, exp: nowSec + 3600 });
  }
  function requestWithCookie(url, cookie) {
    return new Request(url, { headers: { Cookie: `ies_auth=${cookie}` } });
  }

  it('verifies a staging-minted cookie with the _STAGING pair on the staging host only', async () => {
    const stgEnv = {
      ...env,
      SESSION_ENCRYPTION_KEY_STAGING: 'staging-enc-key',
      COOKIE_SIGNING_SECRET_STAGING: 'staging-sig-secret',
    };
    const cookie = await buildAuthCookieValue(
      liveCookiePayload(), 'staging-enc-key', 'staging-sig-secret',
    );

    const staging = await getSsoState(requestWithCookie(`${STG}/`, cookie), stgEnv);
    expect(staging.state).toBe('ok');

    // The same cookie on the production host is a secret disagreement with
    // auth.ies.org, exactly as before this feature existed.
    const prod = await getSsoState(requestWithCookie('https://lensy.ies.org/', cookie), stgEnv);
    expect(prod.state).toBe('misconfigured');
  });

  it('falls back to the shared pair on the staging host when no _STAGING pair is set', async () => {
    const cookie = await buildAuthCookieValue(liveCookiePayload(), ENC_KEY, SIG_KEY);
    const state = await getSsoState(requestWithCookie(`${STG}/`, cookie), env);
    expect(state.state).toBe('ok');
  });
});

describe('decideAccess', () => {
  const member = payload({ isMember: true });
  const guest = payload({ isMember: false, email: 'guest@example.com' });

  it('an invite row grants access and flags first login', () => {
    const row = { status: 'invited', expires_at: null, role: 'guest', tier: 'lite', person_uuid: null };
    const d = decideAccess(guest, row, true, NOW);
    expect(d).toEqual({ authorized: true, role: 'guest', tier: 'lite', admin: false, firstLogin: true });
  });

  it('a row written before migration 0012 still grants full', () => {
    // No `tier` column on the row — it must not read as "grants nothing", or
    // every pre-existing invitee would silently lose their access.
    const row = { status: 'active', expires_at: null, role: 'guest', person_uuid: 'p-1' };
    expect(decideAccess(guest, row, true, NOW).tier).toBe('full');
  });

  it('an already-active row is not a first login', () => {
    const row = { status: 'active', expires_at: null, role: 'staff', person_uuid: 'person-uuid-1234' };
    const d = decideAccess(guest, row, true, NOW);
    expect(d.authorized).toBe(true);
    expect(d.firstLogin).toBe(false);
  });

  it('revoked/expired rows deny — even for IES members', () => {
    const revoked = { status: 'revoked', expires_at: null, role: 'guest', person_uuid: null };
    const expired = { status: 'active', expires_at: '2026-01-01T00:00:00Z', role: 'guest', person_uuid: 'x' };
    expect(decideAccess(member, revoked, true, NOW)).toEqual({ authorized: false, reason: 'revoked', admin: false, firstLogin: false });
    expect(decideAccess(member, expired, true, NOW)).toEqual({ authorized: false, reason: 'expired', admin: false, firstLogin: false });
  });

  it('without a row: members pass iff the bypass is on, non-members never', () => {
    expect(decideAccess(member, null, true, NOW)).toEqual({ authorized: true, role: 'member', admin: false, firstLogin: false });
    expect(decideAccess(member, null, false, NOW)).toEqual({ authorized: false, reason: 'not_invited', admin: false, firstLogin: false });
    expect(decideAccess(guest, null, true, NOW)).toEqual({ authorized: false, reason: 'not_invited', admin: false, firstLogin: false });
  });
});

// The `administrator` IdP role is the one role slug Lensy acts on: it is what
// opens /admin and every /api/admin/* endpoint.
describe('decideAccess — admin rights', () => {
  const idpAdmin = payload({
    isMember: false,
    email: 'staffer@ies.org',
    roles: ['user', 'administrator'],
  });
  const member = payload({ isMember: true });

  it('detects the administrator slug', () => {
    expect(hasIdpAdminRole(idpAdmin)).toBe(true);
    expect(hasIdpAdminRole(member)).toBe(false);
    expect(hasIdpAdminRole(payload({ roles: [] }))).toBe(false);
  });

  it('an IdP administrator gets in and is an admin, with no invite and no membership', () => {
    expect(decideAccess(idpAdmin, null, false, NOW)).toEqual({
      authorized: true, role: 'admin', admin: true, firstLogin: false,
    });
  });

  it('an ordinary member is not an admin', () => {
    expect(decideAccess(member, null, true, NOW).admin).toBe(false);
  });

  it("an invite row with role 'admin' is the local grant path", () => {
    const row = { status: 'active', expires_at: null, role: 'admin', person_uuid: 'x' };
    expect(decideAccess(guestPayload(), row, true, NOW).admin).toBe(true);
    const staffRow = { status: 'active', expires_at: null, role: 'staff', person_uuid: 'x' };
    expect(decideAccess(guestPayload(), staffRow, true, NOW).admin).toBe(false);
  });

  it('the IdP role still makes an invited guest an admin', () => {
    const row = { status: 'active', expires_at: null, role: 'guest', person_uuid: 'x' };
    expect(decideAccess(idpAdmin, row, true, NOW).admin).toBe(true);
  });

  // Revoke has to be the final word, or there is no way to lock out a staff
  // account short of editing the IdP directory.
  it('a revoked row beats the administrator role', () => {
    const row = { status: 'revoked', expires_at: null, role: 'admin', person_uuid: null };
    expect(decideAccess(idpAdmin, row, true, NOW)).toEqual({
      authorized: false, reason: 'revoked', admin: false, firstLogin: false,
    });
  });

  function guestPayload() {
    return payload({ isMember: false, email: 'guest@example.com', roles: [] });
  }
});
