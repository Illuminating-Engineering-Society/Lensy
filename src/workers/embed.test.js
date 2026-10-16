/**
 * The public, embeddable List Standards page (webstore prototype 10/14/26:
 * "Embed content from lens.ies.org/contents — public version, no login").
 */
import { describe, it, expect } from 'vitest';
import { isEmbeddableContents, allowFramingByIes, EMBED_FRAME_ANCESTORS } from './api';

const GLOBAL_CSP = "default-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'self'";

describe('which URL may be framed', () => {
  it('only the embed variant of /contents', () => {
    expect(isEmbeddableContents(new URL('https://lens.ies.org/contents?embed=1'))).toBe(true);
    expect(isEmbeddableContents(new URL('https://lens.ies.org/contents.html?embed=1'))).toBe(true);
    expect(isEmbeddableContents(new URL('https://lens.ies.org/contents'))).toBe(false);
    expect(isEmbeddableContents(new URL('https://lens.ies.org/?embed=1'))).toBe(false);
    expect(isEmbeddableContents(new URL('https://lens.ies.org/bookmarks?embed=1'))).toBe(false);
  });
});

describe('allowFramingByIes', () => {
  it('replaces frame-ancestors and drops X-Frame-Options, keeping the rest of the CSP', () => {
    const res = allowFramingByIes(new Response('<html>', {
      status: 200,
      headers: { 'Content-Security-Policy': GLOBAL_CSP, 'X-Frame-Options': 'DENY', 'Content-Type': 'text/html' },
    }));
    const csp = res.headers.get('Content-Security-Policy');
    expect(res.headers.get('X-Frame-Options')).toBeNull();
    expect(csp).toContain(`frame-ancestors ${EMBED_FRAME_ANCESTORS.join(' ')}`);
    expect(csp).not.toContain("frame-ancestors 'none'");
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("base-uri 'self'");
    expect(res.headers.get('Content-Type')).toBe('text/html');
  });

  it('adds frame-ancestors when the CSP has none, and sets one when there is no CSP', () => {
    const withCsp = allowFramingByIes(new Response('', { headers: { 'Content-Security-Policy': "default-src 'self'" } }));
    expect(withCsp.headers.get('Content-Security-Policy')).toMatch(/default-src 'self'; frame-ancestors https:\/\/store\.ies\.org/);
    const bare = allowFramingByIes(new Response(''));
    expect(bare.headers.get('Content-Security-Policy')).toMatch(/^frame-ancestors /);
  });

  it('names only IES origins', () => {
    for (const origin of EMBED_FRAME_ANCESTORS) expect(new URL(origin).hostname.endsWith('ies.org')).toBe(true);
  });
});
