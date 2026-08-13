import { describe, it, expect } from 'vitest';
import { toLibraryUrl, toLibraryUrlOrNull, LIBRARY_VIEWER_ORIGIN } from './library-url.js';

describe('toLibraryUrl', () => {
  it('rewrites the Vitrium viewer host to the branded Library host', () => {
    expect(toLibraryUrl('https://view.protectedpdf.com/2H4QTw'))
      .toBe('https://lighting.ies.org/2H4QTw');
  });

  it('keeps the #page fragment — the whole point of the report', () => {
    // The reported failure: the reader landed on Vitrium's auth error, and after
    // signing in the viewer opened page 1 because the fragment was gone.
    expect(toLibraryUrl('https://view.protectedpdf.com/2H4QTw#page=43'))
      .toBe('https://lighting.ies.org/2H4QTw#page=43');
  });

  it('keeps a section anchor and a query string', () => {
    expect(toLibraryUrl('https://view.protectedpdf.com/abc?x=1#section-8.6.1.4'))
      .toBe('https://lighting.ies.org/abc?x=1#section-8.6.1.4');
  });

  it('matches the host with and without www., case-insensitively', () => {
    expect(toLibraryUrl('https://WWW.View.ProtectedPDF.com/abc#page=2'))
      .toBe('https://lighting.ies.org/abc#page=2');
    expect(toLibraryUrl('https://protectedpdf.com/abc')).toBe('https://lighting.ies.org/abc');
  });

  it('leaves every other link alone', () => {
    for (const url of [
      'https://lighting.ies.org/2H4QTw#page=43',       // already branded
      'https://doi.org/10.1080/15502724.2020.1808014', // a reference DOI
      'https://ies.org/standards/definitions/glare/',  // the LS-1 glossary
      'https://ies.org/store/rp-8-25/',                // Buy
    ]) {
      expect(toLibraryUrl(url)).toBe(url);
    }
  });

  it('does not mistake a lookalike host for the viewer', () => {
    const evil = 'https://view.protectedpdf.com.example.net/2H4QTw';
    expect(toLibraryUrl(evil)).toBe(evil);
  });

  it('returns null for nothing, and passes non-URL text through untouched', () => {
    expect(toLibraryUrl(null)).toBeNull();
    expect(toLibraryUrl('')).toBeNull();
    expect(toLibraryUrl('   ')).toBeNull();
    expect(toLibraryUrl(42)).toBeNull();
    expect(toLibraryUrl('not a url')).toBe('not a url');
  });

  it('toLibraryUrlOrNull collapses anything unusable to null', () => {
    expect(toLibraryUrlOrNull(undefined)).toBeNull();
    expect(toLibraryUrlOrNull('https://view.protectedpdf.com/x#page=9'))
      .toBe(`${LIBRARY_VIEWER_ORIGIN}/x#page=9`);
  });
});
