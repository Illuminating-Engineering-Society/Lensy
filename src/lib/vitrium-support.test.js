/**
 * Vitrium error-page support logic (client note, 2026-09-04).
 *
 * The contract under test is Vitrium's, not ours: the query-string shape comes
 * from their Custom Error Page sample project (April 2023), and the code
 * vocabulary from their Error Code Reference Guide. If either parser drifts,
 * the error page silently loses its document lookup or its per-code guidance —
 * nothing errors, the reader just gets the generic view.
 */

import { describe, it, expect } from 'vitest';
import {
  CLEAR_USE_CODES, CLEAR_USE_LABELS, isShortCode,
  shortCodeFromViewerUrl, errorCodeFromMessage,
} from './vitrium-support.js';

describe('errorCodeFromMessage', () => {
  it('reads the trailing parenthesized code, as Vitrium formats it', () => {
    expect(errorCodeFromMessage('You have exceeded your device limit (vc3)')).toBe('vc3');
    // Vitrium's own sample test URL puts a period AFTER the parens.
    expect(errorCodeFromMessage('This content has been deactivated in the system (2p3).')).toBe('2p3');
    expect(errorCodeFromMessage('Access expired (qe2).')).toBe('qe2');
  });

  it('takes the LAST parenthesized token when the message has earlier parens', () => {
    expect(errorCodeFromMessage('Access (loan) has expired (rqe2).')).toBe('rqe2');
  });

  it('lowercases, and returns null when there is nothing code-shaped', () => {
    expect(errorCodeFromMessage('Device limit exceeded (VC3)')).toBe('vc3');
    expect(errorCodeFromMessage('No code in this message')).toBe(null);
    expect(errorCodeFromMessage('')).toBe(null);
    expect(errorCodeFromMessage(null)).toBe(null);
    expect(errorCodeFromMessage(undefined)).toBe(null);
    // A parenthetical too long to be a code is prose, not a code.
    expect(errorCodeFromMessage('See the policy (device limits and print limits)')).toBe(null);
  });
});

describe('shortCodeFromViewerUrl', () => {
  it('reads the code from the Forbidden URL Vitrium passes to the error page', () => {
    // The exact shape from Vitrium's manual: /Forbidden/<code>.
    expect(shortCodeFromViewerUrl('https://view.protectedpdf.com/Forbidden/gghmRV')).toBe('gghmRV');
    expect(shortCodeFromViewerUrl('https://view.protectedpdf.com/2H4QTw')).toBe('2H4QTw');
    expect(shortCodeFromViewerUrl('https://view.protectedpdf.com/2H4QTw#page=43')).toBe('2H4QTw');
    // The branded host serves the same codes (src/lib/library-url.js).
    expect(shortCodeFromViewerUrl('https://lighting.ies.org/6yXpKE')).toBe('6yXpKE');
    expect(shortCodeFromViewerUrl('https://www.view.protectedpdf.com/Forbidden/abc123')).toBe('abc123');
  });

  it('refuses anything that could join to the wrong document', () => {
    expect(shortCodeFromViewerUrl('https://evil.example.com/2H4QTw')).toBe(null);
    expect(shortCodeFromViewerUrl('https://view.protectedpdf.com/')).toBe(null);
    expect(shortCodeFromViewerUrl('https://view.protectedpdf.com/a/b/c')).toBe(null);
    expect(shortCodeFromViewerUrl('https://view.protectedpdf.com/has-hyphen')).toBe(null);
    expect(shortCodeFromViewerUrl('not a url')).toBe(null);
    expect(shortCodeFromViewerUrl('')).toBe(null);
    expect(shortCodeFromViewerUrl(null)).toBe(null);
  });
});

describe('the Clear-Use family', () => {
  it('is exactly the codes Vitrium documents as fixed by Users → Clear Use', () => {
    expect([...CLEAR_USE_CODES].sort()).toEqual(['dovc3', 'dpvc3', 'dvc3', 'ipvc3', 'vc3', 'vp3']);
  });

  it('labels every member, for the staff email', () => {
    for (const code of CLEAR_USE_CODES) {
      expect(typeof CLEAR_USE_LABELS[code]).toBe('string');
      expect(CLEAR_USE_LABELS[code].length).toBeGreaterThan(5);
    }
  });

  it('never contains a non-resettable code', () => {
    // qe2 (expired) and w29 (no permission) are purchase/renewal conversations,
    // not Clear-Use resets — a staff reset cannot fix them.
    expect(CLEAR_USE_CODES.has('qe2')).toBe(false);
    expect(CLEAR_USE_CODES.has('w29')).toBe(false);
    expect(CLEAR_USE_CODES.has('2p3')).toBe(false);
  });
});

describe('isShortCode', () => {
  it('accepts viewer codes and refuses LIKE-wildcard smuggling', () => {
    expect(isShortCode('2H4QTw')).toBe(true);
    expect(isShortCode('gghmRV')).toBe(true);
    expect(isShortCode('a%b')).toBe(false);
    expect(isShortCode('ab_')).toBe(false);
    expect(isShortCode('abc')).toBe(false);       // too short
    expect(isShortCode('x'.repeat(17))).toBe(false);
    expect(isShortCode(42)).toBe(false);
    expect(isShortCode(null)).toBe(false);
  });
});
