/**
 * Self-hosted tutorial videos (client, 2026-10-28): permanent /tutorials/<slug>
 * pages, videos streamed from R2 with real byte ranges, and the manifest the
 * page reads to choose between our player and the Loom fallback.
 */
import { describe, it, expect } from 'vitest';
import {
  tutorialPageSlug, tutorialMediaKey, contentRangeFor, serveTutorialMedia, listTutorialMedia,
} from './tutorials';

/** Just enough of an R2 bucket: get (with range/onlyIf) and list. */
function fakeBucket(files) {
  const objects = Object.entries(files).map(([key, bytes]) => ({
    key, bytes, size: bytes.length, uploaded: new Date('2026-10-28T12:00:00Z'), httpEtag: `"etag-${key}"`,
  }));
  return {
    async get(key, opts = {}) {
      const o = objects.find(x => x.key === key);
      if (!o) return null;
      const inm = opts.onlyIf instanceof Headers ? opts.onlyIf.get('if-none-match') : null;
      if (inm && inm === o.httpEtag) return { size: o.size, httpEtag: o.httpEtag };
      let range;
      let slice = o.bytes;
      const header = opts.range instanceof Headers ? opts.range.get('range') : null;
      const m = header && /^bytes=(\d*)-(\d*)$/.exec(header);
      if (m) {
        if (m[1] === '') {
          range = { suffix: Number(m[2]) };
          slice = o.bytes.slice(o.size - Number(m[2]));
        } else {
          const offset = Number(m[1]);
          range = m[2] === '' ? { offset } : { offset, length: Number(m[2]) - offset + 1 };
          slice = o.bytes.slice(offset, range.length ? offset + range.length : undefined);
        }
      }
      return { size: o.size, httpEtag: o.httpEtag, range, body: new Blob([slice]).stream() };
    },
    async list({ prefix }) {
      return { objects: objects.filter(o => o.key.startsWith(prefix)), truncated: false };
    },
  };
}

const bytes = n => new Uint8Array(Array.from({ length: n }, (_, i) => i % 256));

describe('tutorial page URLs', () => {
  it('reads the slug of /tutorials/<slug>', () => {
    expect(tutorialPageSlug('/tutorials/measure')).toBe('measure');
    expect(tutorialPageSlug('/tutorials/notes-and-callouts/')).toBe('notes-and-callouts');
  });
  it('is not the list page, an asset, or a deeper path', () => {
    expect(tutorialPageSlug('/tutorials')).toBeNull();
    expect(tutorialPageSlug('/tutorials/')).toBeNull();
    expect(tutorialPageSlug('/tutorials/x.js')).toBeNull();
    expect(tutorialPageSlug('/tutorials/a/b')).toBeNull();
    expect(tutorialPageSlug('/tutorials/Measure')).toBeNull();
    expect(tutorialPageSlug('/tutorials/-x')).toBeNull();
  });
});

describe('media keys', () => {
  it('maps a slug to its video and poster', () => {
    expect(tutorialMediaKey('measure', 'mp4')).toBe('tutorials/measure.mp4');
    expect(tutorialMediaKey('measure', 'jpg')).toBe('tutorials/measure.jpg');
  });
  it('refuses anything else', () => {
    expect(tutorialMediaKey('measure', 'pdf')).toBeNull();
    expect(tutorialMediaKey('../standards/x', 'mp4')).toBeNull();
    expect(tutorialMediaKey('', 'mp4')).toBeNull();
  });
});

describe('contentRangeFor', () => {
  it('handles the three shapes R2 returns', () => {
    expect(contentRangeFor({ offset: 10, length: 5 }, 100)).toEqual({ start: 10, end: 14 });
    expect(contentRangeFor({ offset: 90 }, 100)).toEqual({ start: 90, end: 99 });
    expect(contentRangeFor({ suffix: 20 }, 100)).toEqual({ start: 80, end: 99 });
  });
  it('clamps a length running past the end', () => {
    expect(contentRangeFor({ offset: 95, length: 50 }, 100)).toEqual({ start: 95, end: 99 });
  });
});

describe('serveTutorialMedia', () => {
  const env = { PDFS: fakeBucket({ 'tutorials/measure.mp4': bytes(1000), 'tutorials/measure.jpg': bytes(10) }) };
  const req = (headers = {}, method = 'GET') =>
    new Request('https://lens.ies.org/api/tutorials/media/measure.mp4', { method, headers });

  it('serves the whole video with its type and length', async () => {
    const res = await serveTutorialMedia(req(), env, 'measure.mp4');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('video/mp4');
    expect(res.headers.get('Accept-Ranges')).toBe('bytes');
    expect(res.headers.get('Content-Length')).toBe('1000');
    expect((await res.arrayBuffer()).byteLength).toBe(1000);
  });

  it('answers a byte range with 206 and Content-Range (Safari will not play without it)', async () => {
    const res = await serveTutorialMedia(req({ Range: 'bytes=0-1' }), env, 'measure.mp4');
    expect(res.status).toBe(206);
    expect(res.headers.get('Content-Range')).toBe('bytes 0-1/1000');
    expect(res.headers.get('Content-Length')).toBe('2');
    expect((await res.arrayBuffer()).byteLength).toBe(2);
  });

  it('serves the poster as a JPEG', async () => {
    const res = await serveTutorialMedia(req(), env, 'measure.jpg');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/jpeg');
  });

  it('revalidates with 304', async () => {
    const res = await serveTutorialMedia(req({ 'If-None-Match': '"etag-tutorials/measure.mp4"' }), env, 'measure.mp4');
    expect(res.status).toBe(304);
  });

  it('sends no body on HEAD', async () => {
    const res = await serveTutorialMedia(req({}, 'HEAD'), env, 'measure.mp4');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Length')).toBe('1000');
  });

  it('404s a missing video and anything outside the tutorial namespace', async () => {
    expect((await serveTutorialMedia(req(), env, 'shapes.mp4')).status).toBe(404);
    expect((await serveTutorialMedia(req(), env, 'measure.pdf')).status).toBe(404);
    expect((await serveTutorialMedia(req(), env, '..%2Fstandards%2FRP-8.pdf')).status).toBe(404);
  });
});

describe('listTutorialMedia', () => {
  it('reports which slugs have a video and/or poster', async () => {
    const env = { PDFS: fakeBucket({
      'tutorials/measure.mp4': bytes(1000),
      'tutorials/measure.jpg': bytes(10),
      'tutorials/shapes.jpg': bytes(10),
      'tutorials/stray.txt': bytes(1),
    }) };
    const media = await listTutorialMedia(env);
    expect(media.measure).toEqual({ video: { size: 1000, uploaded: '2026-10-28T12:00:00.000Z' }, poster: true });
    expect(media.shapes).toEqual({ video: null, poster: true });
    expect(media.stray).toBeUndefined();
  });
});
