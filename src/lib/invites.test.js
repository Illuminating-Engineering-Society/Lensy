import { describe, it, expect } from 'vitest';
import {
  normalizeEmail,
  normalizeExpiry,
  parseInvite,
  effectiveStatus,
  hasAccess,
} from './invites';

describe('normalizeEmail', () => {
  it('lowercases and trims valid addresses', () => {
    expect(normalizeEmail('  Guest@Example.COM ')).toBe('guest@example.com');
  });

  it('rejects malformed addresses', () => {
    expect(normalizeEmail('not-an-email')).toBe(null);
    expect(normalizeEmail('two words@example.com')).toBe(null);
    expect(normalizeEmail('no-domain@nowhere')).toBe(null);
    expect(normalizeEmail(42)).toBe(null);
    expect(normalizeEmail(null)).toBe(null);
  });
});

describe('normalizeExpiry', () => {
  it('treats empty as "no expiry"', () => {
    expect(normalizeExpiry(null)).toEqual({ ok: true, value: null });
    expect(normalizeExpiry('')).toEqual({ ok: true, value: null });
  });

  it('extends date-only expiries to end of day UTC', () => {
    expect(normalizeExpiry('2026-08-01')).toEqual({ ok: true, value: '2026-08-01T23:59:59Z' });
  });

  it('passes through full ISO timestamps', () => {
    expect(normalizeExpiry('2026-08-01T12:00:00Z').value).toBe('2026-08-01T12:00:00Z');
  });

  it('rejects garbage', () => {
    expect(normalizeExpiry('soon').ok).toBe(false);
    expect(normalizeExpiry(123).ok).toBe(false);
  });
});

describe('parseInvite', () => {
  it('normalizes a full payload', () => {
    const res = parseInvite({
      email: ' Dana@Firm.com ',
      name: '  Dana Ruiz ',
      organization: 'Firm LLC',
      role: 'STAFF',
      expires_at: '2026-12-31',
      notes: 'Event guest',
    });
    expect(res.ok).toBe(true);
    expect(res.value).toEqual({
      email: 'dana@firm.com',
      name: 'Dana Ruiz',
      organization: 'Firm LLC',
      role: 'staff',
      // Not supplied above, so it takes the column default (migration 0012).
      tier: 'full',
      expires_at: '2026-12-31T23:59:59Z',
      notes: 'Event guest',
    });
  });

  it('accepts an explicit tier and rejects anything else', () => {
    const lite = parseInvite({ email: 'a@b.co', tier: 'LITE' });
    expect(lite.ok).toBe(true);
    expect(lite.value.tier).toBe('lite');
    // The tier is what an invitation grants, so a typo must not fall through
    // to a silent default that hands out the whole Library.
    expect(parseInvite({ email: 'a@b.co', tier: 'premium' }).ok).toBe(false);
  });

  it('defaults role to guest and optionals to null', () => {
    const res = parseInvite({ email: 'a@b.co' });
    expect(res.ok).toBe(true);
    expect(res.value.role).toBe('guest');
    expect(res.value.name).toBe(null);
    expect(res.value.expires_at).toBe(null);
  });

  it('rejects bad email, role, and expiry', () => {
    expect(parseInvite({ email: 'nope' }).ok).toBe(false);
    expect(parseInvite({ email: 'a@b.co', role: 'superuser' }).ok).toBe(false);
    expect(parseInvite({ email: 'a@b.co', expires_at: 'whenever' }).ok).toBe(false);
    expect(parseInvite('a@b.co').ok).toBe(false);
  });
});

describe('effectiveStatus / hasAccess', () => {
  const now = Date.parse('2026-07-26T12:00:00Z');

  it('revoked always wins', () => {
    const row = { status: 'revoked', expires_at: '2030-01-01T00:00:00Z' };
    expect(effectiveStatus(row, now)).toBe('revoked');
    expect(hasAccess(row, now)).toBe(false);
  });

  it('past expiry reads as expired and blocks access', () => {
    const row = { status: 'active', expires_at: '2026-01-01T00:00:00Z' };
    expect(effectiveStatus(row, now)).toBe('expired');
    expect(hasAccess(row, now)).toBe(false);
  });

  it('invited and active rows without expiry have access', () => {
    expect(hasAccess({ status: 'invited', expires_at: null }, now)).toBe(true);
    expect(hasAccess({ status: 'active', expires_at: null }, now)).toBe(true);
  });

  it('future expiry keeps access', () => {
    const row = { status: 'active', expires_at: '2026-12-31T23:59:59Z' };
    expect(effectiveStatus(row, now)).toBe('active');
    expect(hasAccess(row, now)).toBe(true);
  });
});
