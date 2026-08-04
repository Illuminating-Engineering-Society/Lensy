import { describe, it, expect } from 'vitest';
import {
  buildInviteEmail,
  buildCollectionShareEmail,
  isEmailAddress,
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

// ─── Shared Saved Search Collection email (client DO37) ──────────────────────

function shareCtx(overrides = {}) {
  return {
    to: 'colleague@firm.com',
    senderName: 'Dana Ruiz',
    message: null,
    collection: {
      name: 'Downtown Office Renovation',
      notes: 'For the <b>lobby</b> package',
      collection_type: 'Feasibility study',
      client_name: 'Northline',
      location: 'Chicago, IL',
    },
    items: [
      {
        result_type: 'tables', resource_title: 'ANSI/IES RP-1-22, p. 14', page_number: 14,
        library_url: 'https://view.protectedpdf.com/rp1#page=14',
        application_name: 'Offices → Open plan → Reading', reference_text: null, custom_notes: 'check ratios',
      },
      {
        result_type: 'body', resource_title: 'ANSI/IES RP-8-25, p. 61', page_number: 61,
        library_url: 'https://view.protectedpdf.com/rp8#page=61',
        application_name: null, reference_text: null, custom_notes: null,
      },
      {
        result_type: 'references', resource_title: 'ANSI/IES RP-8-25 References, p. 120', page_number: 120,
        library_url: null, application_name: null,
        reference_text: 'CIE 115:2010 Lighting of Roads for Motor and Pedestrian Traffic.', custom_notes: null,
      },
    ],
    claimUrl: 'https://lensy.ies.org/projects.html?share=abc123',
    appUrl: 'https://lensy.ies.org',
    ...overrides,
  };
}

describe('buildCollectionShareEmail', () => {
  it('produces both parts, with the topic as the subject', () => {
    const mail = buildCollectionShareEmail(shareCtx());
    expect(mail.subject).toBe('IES Lighting Library search results: Downtown Office Renovation');
    expect(mail.html).toContain('<!doctype html>');
    expect(mail.text.length).toBeGreaterThan(200);
    expect(mail.text).not.toContain('<');
  });

  it('carries the "Save Search to My Lensy" button and the claim URL', () => {
    // The client's mockup names this button; the recipient copies the collection
    // into their own account rather than being granted access to the sender's.
    const mail = buildCollectionShareEmail(shareCtx());
    expect(mail.html).toContain('Save Search to My Lensy');
    expect(mail.html).toContain('https://lensy.ies.org/projects.html?share=abc123');
    expect(mail.text).toContain('Save Search to My Lensy: https://lensy.ies.org/projects.html?share=abc123');
  });

  it('omits the claim button entirely when no token could be minted', () => {
    const mail = buildCollectionShareEmail(shareCtx({ claimUrl: null }));
    expect(mail.html).not.toContain('Save Search to My Lensy');
    expect(mail.text).not.toContain('Save Search to My Lensy');
    // The references still went out — a missing token must not lose the email.
    expect(mail.html).toContain('ANSI/IES RP-1-22');
  });

  it('carries the subscribe and purchase prompts', () => {
    const mail = buildCollectionShareEmail(shareCtx());
    expect(mail.html).toContain('store.ies.org/ies/subscriptions/');
    expect(mail.html).toContain('Buy individual standards');
    expect(mail.text).toContain('Subscribe to the Lighting Library:');
  });

  it('prints every saved item with its type label and page', () => {
    const mail = buildCollectionShareEmail(shareCtx());
    for (const label of ['Illuminance Table', 'Document', 'Reference']) {
      expect(mail.html).toContain(label);
      expect(mail.text).toContain(`[${label}]`);
    }
    expect(mail.html).toContain('p. 61');
    expect(mail.text).toContain('3 saved results');
  });

  it('reprints reference entries and application names, but never excerpt text', () => {
    // DO37: "provide linked references … but do not reprint the excerpts". A
    // reference entry is the client's one explicit exception.
    const mail = buildCollectionShareEmail(shareCtx());
    expect(mail.html).toContain('CIE 115:2010');
    expect(mail.html).toContain('Offices → Open plan → Reading');
    // A Document item carries no body text to print, and if a future change
    // starts persisting one, it must not appear here.
    const smuggled = buildCollectionShareEmail(shareCtx({
      items: [{
        result_type: 'body', resource_title: 'ANSI/IES RP-8-25, p. 61', page_number: 61,
        reference_text: 'SMUGGLED EXCERPT BODY', application_name: 'SMUGGLED APP NAME',
      }],
    }));
    expect(smuggled.html).not.toContain('SMUGGLED EXCERPT BODY');
    expect(smuggled.html).not.toContain('SMUGGLED APP NAME');
    expect(smuggled.text).not.toContain('SMUGGLED');
  });

  it('escapes sender, message and item text', () => {
    const mail = buildCollectionShareEmail(shareCtx({
      senderName: 'Dana <script>alert(1)</script>',
      message: 'Look at "this" & that',
      collection: { name: '<img onerror=alert(1)>' },
      items: [{ result_type: 'tables', resource_title: '<b>RP-1</b>', application_name: '<i>Offices</i>' }],
    }));
    expect(mail.html).not.toContain('<script>');
    expect(mail.html).not.toContain('<img onerror');
    expect(mail.html).toContain('&lt;script&gt;');
    expect(mail.html).toContain('&quot;this&quot;');
  });

  it('strips the rich text out of notes', () => {
    // Notes are authored as rich text in the app; an email line is plain.
    const mail = buildCollectionShareEmail(shareCtx());
    expect(mail.html).toContain('Collection note: For the lobby package');
    expect(mail.html).not.toContain('<b>lobby</b>');
  });

  it('reads impersonally when the sender is unknown', () => {
    const mail = buildCollectionShareEmail(shareCtx({ senderName: null }));
    expect(mail.html).toContain('Someone shared');
    expect(mail.html).not.toContain('null');
  });

  it('says so rather than printing an empty list', () => {
    const mail = buildCollectionShareEmail(shareCtx({ items: [] }));
    expect(mail.html).toContain('no saved results yet');
    expect(mail.text).toContain('no saved results yet');
  });
});

describe('isEmailAddress', () => {
  it('accepts real addresses', () => {
    for (const ok of ['a@b.co', 'dana.ruiz+lensy@sub.firm.com']) {
      expect(isEmailAddress(ok)).toBe(true);
    }
  });

  it('rejects what the Email binding would reject anyway', () => {
    for (const bad of ['', 'nope', 'a@b', 'a@@b.co', 'a b@c.co', null, undefined, 42]) {
      expect(isEmailAddress(bad)).toBe(false);
    }
  });
});
