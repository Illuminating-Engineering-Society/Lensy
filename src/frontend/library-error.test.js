/**
 * Lighting Library error page (client note, 2026-09-04).
 *
 * Same technique as index.test.js: the page is one HTML file with an inline
 * script and no build step, so the suite evaluates that script in a bare
 * sandbox (no window/document — the boot guard skips rendering) and exercises
 * the decision logic directly: which Vitrium error code produces which view,
 * with which actions, and when the reset form appears.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import vm from 'vm';

const here = dirname(fileURLToPath(import.meta.url));

let sandbox;

beforeAll(() => {
  const html = readFileSync(join(here, 'library-error.html'), 'utf8');
  const blocks = [...html.matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  expect(blocks.length).toBe(1);
  sandbox = { URL, URLSearchParams, console };
  vm.createContext(sandbox);
  vm.runInContext(blocks[0], sandbox);
});

const view = (message, extra = {}) => sandbox.resolveView({ message, url: '', username: '', userid: '', ...extra });

describe('the inline parsers mirror src/lib/vitrium-support.js', () => {
  it('errorCodeFromMessage', () => {
    expect(sandbox.errorCodeFromMessage('You have exceeded your device limit (vc3)')).toBe('vc3');
    expect(sandbox.errorCodeFromMessage('Access (loan) has expired (rqe2).')).toBe('rqe2');
    expect(sandbox.errorCodeFromMessage('no code here')).toBe(null);
  });

  it('shortCodeFromViewerUrl', () => {
    expect(sandbox.shortCodeFromViewerUrl('https://view.protectedpdf.com/Forbidden/gghmRV')).toBe('gghmRV');
    expect(sandbox.shortCodeFromViewerUrl('https://lighting.ies.org/6yXpKE')).toBe('6yXpKE');
    expect(sandbox.shortCodeFromViewerUrl('https://evil.example.com/2H4QTw')).toBe(null);
  });
});

describe('resolveView — the client\'s three named cases', () => {
  it('no permission → the purchase funnel (buy this document and/or subscribe)', () => {
    for (const code of ['w29', 'n4p', '4k3']) {
      const v = view(`No permission (${code})`);
      expect(v.category).toBe('purchase');
      // The document-specific buy button is added once the lookup resolves.
      expect(v.wantsBuy).toBe(true);
      const labels = v.actions.map(a => a.label);
      expect(labels).toContain('Subscribe to the Lighting Library');
      expect(v.showForm).toBe(false);
    }
  });

  it('expired subscription/loan → renewal', () => {
    for (const code of ['qe2', 'rqe2']) {
      const v = view(`Access expired (${code})`);
      expect(v.category).toBe('expired');
      expect(v.wantsBuy).toBe(true);
      expect(v.actions.map(a => a.label)).toContain('Renew or subscribe');
    }
  });

  it('device limit → the staff reset form, for the whole Clear-Use family', () => {
    for (const code of ['vc3', 'dvc3', 'dovc3', 'dpvc3', 'vp3', 'ipvc3']) {
      const v = view(`Limit hit (${code})`);
      expect(v.category).toBe('clearuse');
      expect(v.showForm).toBe(true);
      expect(v.title.length).toBeGreaterThan(10);
      expect(v.lead.length).toBeGreaterThan(20);
    }
    expect(view('Limit hit (vc3)').title).toContain('device limit');
  });
});

describe('resolveView — account and document states', () => {
  it('account not found gets activation guidance, not a purchase pitch', () => {
    const v = view('Account not found (3yq)');
    expect(v.category).toBe('account');
    expect(v.showForm).toBe(false);
    expect(v.help.join(' ')).toMatch(/confirmation email/i);
  });

  it('a deactivated document points at the store (supersession fills in from the lookup)', () => {
    const v = view('This content has been deactivated in the system (2p3).');
    expect(v.category).toBe('inactive');
    expect(v.actions.map(a => a.label)).toContain('Browse the IES Store');
  });

  it('an unknown code degrades to the generic view carrying Vitrium\'s own message', () => {
    const v = view('Something new happened (zz9)');
    expect(v.category).toBe('default');
    expect(v.lead).toContain('Something new happened');
    expect(v.showForm).toBe(false);
  });

  it('no message at all still renders a complete view', () => {
    const v = view('');
    expect(v.code).toBe(null);
    expect(v.title.length).toBeGreaterThan(5);
    expect(v.actions.length).toBeGreaterThan(0);
  });
});

// ─── Client 10/20/26: lease wording, subscribe on 3yq/g45, vc3 license terms ──

describe('the 10/20/26 error-page edits', () => {
  it('no permission says "lease it individually"', () => {
    const v = view('No permission (w29)');
    expect(v.lead).toContain('lease it individually');
    expect(v.lead).not.toMatch(/purchase/);
  });

  it('3yq and g45 offer the subscription', () => {
    for (const code of ['3yq', 'g45']) {
      expect(view(`Not found (${code})`).actions.map(a => a.label)).toContain('Subscribe to the Lighting Library');
    }
  });

  it('vc3 explains the 2-device license and links the Subscription page', () => {
    const v = view('You have exceeded your device limit (vc3)');
    expect(v.showForm).toBe(true);
    expect(v.help[0]).toMatch(/2 browsers on up to 2 devices/);
    expect(v.help[0]).toMatch(/Supported browsers: Chrome, Firefox, Edge, Safari\./);
    expect(v.help[1]).toMatchObject({ link: 'Subscription', after: ' page to license additional users.' });
  });

  it('asks for the reason behind a reset request, and links Tutorials everywhere', () => {
    const html = readFileSync(join(here, 'library-error.html'), 'utf8');
    expect(html).toContain('Subscriptions are licensed for individual use on up to 2 devices.');
    expect(html).toContain('Please share your reason for requesting a device limit reset');
    expect(html).toContain('https://lens.ies.org/tutorials');
  });
});
