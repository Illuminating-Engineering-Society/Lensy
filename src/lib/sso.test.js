import { describe, it, expect } from 'vitest';
import {
  buildAuthCookieValue,
  parseAuthCookieValue,
  decideAccess,
} from './sso';

const ENC_KEY = 'test-session-encryption-key';
const SIG_KEY = 'test-cookie-signing-secret';
const NOW = Date.parse('2026-07-26T12:00:00Z');

function payload(overrides = {}) {
  const nowSec = Math.floor(NOW / 1000);
  return {
    sub: 'person-uuid-1234',
    email: 'dana@firm.com',
    firstName: 'Dana',
    lastName: 'Ruiz',
    isMember: true,
    memberTier: 'Individual',
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
});
