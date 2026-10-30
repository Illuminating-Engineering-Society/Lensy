/**
 * Guides staff paste into /admin → Tutorials (client 10/29/26).
 */
import { describe, it, expect } from 'vitest';
import {
  sanitizeGuideHtml, guideImageSources, replaceImageSources, normalizeLoomUrl, isHostedGuideAsset,
} from './tutorial-guides.js';
import { hostGuideImages } from '../workers/tutorials';

describe('sanitizeGuideHtml', () => {
  it('keeps a Loom How-To Guide\'s structure and drops styles, classes and scripts', () => {
    const pasted = '<h1 class="x" style="color:red">How to Measure</h1><p style="font-size:9px">Open the <b>Measure</b> ribbon.</p>'
      + '<script>alert(1)</script><ul><li onclick="x()">Click <a href="https://www.loom.com/share/abc?t=29">0:29</a></li></ul>';
    const clean = sanitizeGuideHtml(pasted);
    expect(clean).toContain('<h2>How to Measure</h2>');      // h1 clamped below the page title
    expect(clean).toContain('<b>Measure</b>');
    expect(clean).not.toMatch(/style=|class=|onclick|script|alert/);
    expect(clean).toContain('href="https://www.loom.com/share/abc?t=29"');
    expect(clean).toContain('target="_blank"');
  });

  it('refuses javascript: links and treats an empty paste as no guide', () => {
    expect(sanitizeGuideHtml('<a href="javascript:alert(1)">x</a>')).toBe('<a>x</a>');
    expect(sanitizeGuideHtml('<p>&nbsp;</p><p><br></p>')).toBe('');
    expect(sanitizeGuideHtml('<p><img src="https://cdn.loom.com/a.png"></p>')).toContain('<img');
  });
});

describe('image sources', () => {
  const html = '<p><img src="https://cdn.loom.com/a.png" alt="A" /></p><p><img src="data:image/png;base64,AAAA" /></p>';

  it('lists and rewrites them, dropping the ones that could not be copied', () => {
    expect(guideImageSources(html)).toEqual(['https://cdn.loom.com/a.png', 'data:image/png;base64,AAAA']);
    const out = replaceImageSources(html, new Map([
      ['https://cdn.loom.com/a.png', '/api/tutorials/guide-assets/measure/0123456789abcdef.png'],
      ['data:image/png;base64,AAAA', null],
    ]));
    expect(out).toContain('src="/api/tutorials/guide-assets/measure/0123456789abcdef.png"');
    expect(out).toContain('alt="A"');
    expect(out).not.toContain('data:image');
  });

  it('recognizes our own copies', () => {
    expect(isHostedGuideAsset('/api/tutorials/guide-assets/measure/0123456789abcdef.png')).toBe(true);
    expect(isHostedGuideAsset('https://cdn.loom.com/a.png')).toBe(false);
  });
});

describe('normalizeLoomUrl', () => {
  it('accepts share and embed links and returns the share form', () => {
    const id = '7fc113be55b04f3588d0f549809c3028';
    expect(normalizeLoomUrl(`https://www.loom.com/share/${id}?sid=x`)).toBe(`https://www.loom.com/share/${id}`);
    expect(normalizeLoomUrl(`https://loom.com/embed/${id}`)).toBe(`https://www.loom.com/share/${id}`);
  });
  it('refuses anything else', () => {
    expect(normalizeLoomUrl('https://evil.example/share/7fc113be55b04f3588d0f549809c3028')).toBeNull();
    expect(normalizeLoomUrl('http://www.loom.com/share/7fc113be55b04f3588d0f549809c3028')).toBeNull();
    expect(normalizeLoomUrl('')).toBeNull();
  });
});

describe('hostGuideImages', () => {
  const PNG = 'iVBORw0KGgo=';   // a few bytes are enough — only the type is checked
  function env() {
    const puts = [];
    return { puts, PDFS: { async put(key, bytes, opts) { puts.push({ key, size: bytes.length, type: opts.httpMetadata.contentType }); } } };
  }

  it('copies data: and CDN images into R2 and points the guide at the copies', async () => {
    const e = env();
    const fetcher = async () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'image/jpeg' } });
    const html = `<p><img src="data:image/png;base64,${PNG}" /></p><p><img src="https://cdn.loom.com/x.jpg" /></p>`;
    const out = await hostGuideImages(e, 'measure', html, fetcher);
    expect(out.copied).toBe(2);
    expect(out.dropped).toBe(0);
    expect(e.puts.map(p => p.key)).toEqual([
      expect.stringMatching(/^tutorials\/guides\/measure\/[a-f0-9]{32}\.png$/),
      expect.stringMatching(/^tutorials\/guides\/measure\/[a-f0-9]{32}\.jpg$/),
    ]);
    expect(out.html).not.toContain('data:image');
    expect(out.html).not.toContain('cdn.loom.com');
    expect(guideImageSources(out.html).every(isHostedGuideAsset)).toBe(true);
  });

  it('drops an image it cannot copy (not an image, a failed fetch) and says so', async () => {
    const e = env();
    const fetcher = async url => url.includes('html')
      ? new Response('<html>', { headers: { 'Content-Type': 'text/html' } })
      : new Response('gone', { status: 404 });
    const html = '<p>Step</p><p><img src="https://a.example/x.html" /></p><p><img src="https://a.example/y.png" /></p>';
    const out = await hostGuideImages(e, 'measure', html, fetcher);
    expect(out).toMatchObject({ copied: 0, dropped: 2 });
    expect(out.html).toBe('<p>Step</p>');
    expect(e.puts).toEqual([]);
  });
});
