import { describe, it, expect } from 'vitest';
import {
  buildInviteEmail,
  formatExpiry,
  describeSendError,
  resolveAppUrl,
} from './email';

function ctx(overrides = {}) {
  return {
    email: 'dana@firm.com',
    name: 'Dana Ruiz',
    organization: 'Firm LLC',
    role: 'guest',
    expiresAt: null,
    invitedBy: 'Megan Carroll',
    appUrl: 'https://lensy.ies.org',
    ...overrides,
  };
}

describe('buildInviteEmail', () => {
  it('always produces both an HTML and a text part', () => {
    // Some clients render only text/plain, and a missing text part costs spam score.
    const mail = buildInviteEmail(ctx());
    expect(mail.subject).toBe('You have access to Lensy — the IES Standards Assistant');
    expect(mail.html).toContain('<!doctype html>');
    expect(mail.text.length).toBeGreaterThan(100);
    expect(mail.text).not.toContain('<');
  });

  it('greets by first name, and stays grammatical without one', () => {
    expect(buildInviteEmail(ctx()).text).toContain('Hello Dana,');
    expect(buildInviteEmail(ctx({ name: null })).text).toContain('Hello,');
    expect(buildInviteEmail(ctx({ name: '   ' })).text).toContain('Hello,');
    expect(buildInviteEmail(ctx({ name: null })).text).not.toContain('null');
  });

  it('names the inviter when known, and omits the clause when not', () => {
    expect(buildInviteEmail(ctx()).text).toContain('Megan Carroll has given you access');
    const anon = buildInviteEmail(ctx({ invitedBy: null }));
    expect(anon.text).toContain('You have been given access');
    expect(anon.text).not.toContain('has given you access');
  });

  it('links to the deployment it was sent from, without a doubled slash', () => {
    const mail = buildInviteEmail(ctx({ appUrl: 'https://lensy.ies.org/' }));
    expect(mail.text).toContain('https://lensy.ies.org/');
    expect(mail.html).not.toContain('lensy.ies.org//');
    const staging = buildInviteEmail(ctx({ appUrl: 'https://lensy-staging.ies.org' }));
    expect(staging.text).toContain('https://lensy-staging.ies.org/');
    expect(staging.text).not.toContain('//lensy.ies.org');
  });

  // Every pre-existing IES account starts `pending` at the IdP and must set a
  // password from a separate email. Unexplained, that detour reads as a broken
  // invitation — so the sentence is load-bearing, not filler.
  it('warns that a password will have to be set on first sign-in', () => {
    const mail = buildInviteEmail(ctx());
    expect(mail.text).toMatch(/set a new password/i);
    expect(mail.text).toMatch(/separate email/i);
  });

  it('states the expiry date only for time-limited access', () => {
    expect(buildInviteEmail(ctx()).text).not.toMatch(/access runs through/);
    const dated = buildInviteEmail(ctx({ expiresAt: '2026-08-12T23:59:59Z' }));
    expect(dated.text).toContain('Your access runs through 12 August 2026.');
  });

  it('mentions admin tooling for staff and admin roles only', () => {
    expect(buildInviteEmail(ctx({ role: 'admin' })).text).toMatch(/staff access/i);
    expect(buildInviteEmail(ctx({ role: 'staff' })).text).toMatch(/staff access/i);
    expect(buildInviteEmail(ctx({ role: 'guest' })).text).not.toMatch(/staff access/i);
  });

  // Names and "invited by" are free text typed by staff and land in an HTML
  // document sent to a third party.
  it('escapes HTML in staff-supplied fields', () => {
    const mail = buildInviteEmail(ctx({
      name: '<script>alert(1)</script>',
      invitedBy: 'A & B "quoted"',
    }));
    expect(mail.html).not.toContain('<script>');
    expect(mail.html).toContain('&lt;script&gt;');
    expect(mail.html).toContain('A &amp; B &quot;quoted&quot;');
  });
});

describe('formatExpiry', () => {
  it('renders a date-only expiry readably', () => {
    expect(formatExpiry('2026-08-12')).toBe('12 August 2026');
  });

  it('renders the stored end-of-day timestamp as that same day (UTC)', () => {
    // invites.ts stores 'YYYY-MM-DD' as `${date}T23:59:59Z`; a local-time
    // conversion would show the next day for anyone east of UTC.
    expect(formatExpiry('2026-08-12T23:59:59Z')).toBe('12 August 2026');
  });

  it('passes an unparseable value through rather than printing Invalid Date', () => {
    expect(formatExpiry('whenever')).toBe('whenever');
  });
});

describe('describeSendError', () => {
  it('keeps the E_* code — it decides what to do next', () => {
    const err = Object.assign(new Error('Sender domain not verified'), {
      code: 'E_SENDER_NOT_VERIFIED',
    });
    expect(describeSendError(err)).toBe('E_SENDER_NOT_VERIFIED: Sender domain not verified');
  });

  it('handles an Error with no code, and non-Error throws', () => {
    expect(describeSendError(new Error('boom'))).toBe('boom');
    expect(describeSendError('plain string')).toBe('plain string');
  });

  it('truncates to fit the D1 column', () => {
    const err = new Error('x'.repeat(1000));
    expect(describeSendError(err).length).toBe(300);
  });
});

describe('resolveAppUrl', () => {
  it('uses the request origin so each deployment links to itself', () => {
    expect(resolveAppUrl({ url: 'https://lensy.ies.org/api/admin/users' }, {}))
      .toBe('https://lensy.ies.org');
    expect(resolveAppUrl({ url: 'http://localhost:8787/api/admin/users' }, {}))
      .toBe('http://localhost:8787');
  });

  it('honours LENSY_BASE_URL and strips its trailing slash', () => {
    const env = { LENSY_BASE_URL: 'https://lensy.ies.org/' };
    expect(resolveAppUrl({ url: 'http://internal-host/api/admin/users' }, env))
      .toBe('https://lensy.ies.org');
  });
});
