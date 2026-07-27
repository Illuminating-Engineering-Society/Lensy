import { describe, it, expect } from 'vitest';
import {
  buildAuthCookieValue,
  parseAuthCookieValue,
  verifyAuthCookieValue,
  isSecretMismatch,
  resolveReturnTo,
  buildLoginUrl,
  decideAccess,
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

describe('decideAccess', () => {
  const member = payload({ isMember: true });
  const guest = payload({ isMember: false, email: 'guest@example.com' });

  it('an invite row grants access and flags first login', () => {
    const row = { status: 'invited', expires_at: null, role: 'guest', person_uuid: null };
    const d = decideAccess(guest, row, true, NOW);
    expect(d).toEqual({ authorized: true, role: 'guest', firstLogin: true });
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
    expect(decideAccess(member, revoked, true, NOW)).toEqual({ authorized: false, reason: 'revoked', firstLogin: false });
    expect(decideAccess(member, expired, true, NOW)).toEqual({ authorized: false, reason: 'expired', firstLogin: false });
  });

  it('without a row: members pass iff the bypass is on, non-members never', () => {
    expect(decideAccess(member, null, true, NOW)).toEqual({ authorized: true, role: 'member', firstLogin: false });
    expect(decideAccess(member, null, false, NOW)).toEqual({ authorized: false, reason: 'not_invited', firstLogin: false });
    expect(decideAccess(guest, null, true, NOW)).toEqual({ authorized: false, reason: 'not_invited', firstLogin: false });
  });

  // An IdP-wide administrator is not a Lensy user: Lensy roles come from
  // invited_users, so the cookie's roles array must not widen access.
  it('ignores IdP roles — an IdP administrator still needs an invite', () => {
    const idpAdmin = payload({
      isMember: false,
      email: 'staffer@ies.org',
      roles: ['administrator', 'staff'],
    });
    expect(decideAccess(idpAdmin, null, true, NOW)).toEqual({
      authorized: false, reason: 'not_invited', firstLogin: false,
    });
    const row = { status: 'revoked', expires_at: null, role: 'admin', person_uuid: null };
    expect(decideAccess(idpAdmin, row, true, NOW).authorized).toBe(false);
  });
});
