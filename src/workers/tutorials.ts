/**
 * Self-hosted tutorial videos (client, 2026-10-28: "can you create WP pages for
 * each (or embed video files from our server, or similar) so the URLs remain
 * static with eventual content updates, and to remove Loom branding?").
 *
 * Every tutorial has a permanent page at /tutorials/<slug> (the same
 * tutorials.html, which reads its slug off the path) and, once staff upload it,
 * a video in R2 at `tutorials/<slug>.mp4` with an optional poster frame at
 * `tutorials/<slug>.jpg`. Replacing a video is an upload to the same key, so
 * the page URL — the one in emails, the welcome window and the tools menus —
 * never changes. Until a video is uploaded the page falls back to the Loom
 * embed named in the catalogue (src/frontend/utils/tutorials-catalogue.js).
 *
 * PUBLIC by design, like /tutorials itself: a tutorial is marketing and support
 * material, and the reader who most needs "how do I sign in" has no session.
 * Uploads go through /api/admin/r2-multipart (admin-only); removal through
 * DELETE /api/admin/tutorials/<slug>.
 */
import { requireAdminAccess } from './session';

/** A tutorial slug: what follows /tutorials/ in its permanent URL. */
export const TUTORIAL_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_SLUG_LENGTH = 80;

export const TUTORIAL_PREFIX = 'tutorials/';

const MEDIA = {
  mp4: 'video/mp4',
  jpg: 'image/jpeg',
} as const;
type MediaExt = keyof typeof MEDIA;

/** The R2 key of a tutorial's video or poster; null for anything malformed. */
export function tutorialMediaKey(slug: string, ext: string): string | null {
  if (!isTutorialSlug(slug) || !(ext in MEDIA)) return null;
  return `${TUTORIAL_PREFIX}${slug}.${ext}`;
}

export function isTutorialSlug(slug: string): boolean {
  return typeof slug === 'string' && slug.length <= MAX_SLUG_LENGTH && TUTORIAL_SLUG_RE.test(slug);
}

/**
 * The slug of a tutorial PAGE path (/tutorials/<slug>, trailing slash
 * allowed), or null. A path with a dot is an asset, never a tutorial.
 */
export function tutorialPageSlug(path: string): string | null {
  const m = /^\/tutorials\/([^/]+)\/?$/.exec(path);
  return m && isTutorialSlug(m[1]) ? m[1] : null;
}

/**
 * Translate an R2 range into the 206 Content-Range header. R2 hands back the
 * range it applied in one of three shapes (offset+length, offset only, suffix).
 */
export function contentRangeFor(range: R2Range, size: number): { start: number; end: number } {
  let start: number;
  let end: number;
  if ('suffix' in range && range.suffix !== undefined) {
    start = Math.max(0, size - range.suffix);
    end = size - 1;
  } else {
    const r = range as { offset?: number; length?: number };
    start = r.offset ?? 0;
    end = r.length !== undefined ? Math.min(size - 1, start + r.length - 1) : size - 1;
  }
  return { start, end };
}

/**
 * GET|HEAD /api/tutorials/media/<slug>.<mp4|jpg> — the video or its poster.
 *
 * Byte ranges are honoured with a real 206: Safari will not play an MP4 that
 * answers a Range request with 200, and every browser needs ranges to seek —
 * which the guide's timestamps do.
 */
export async function serveTutorialMedia(request: Request, env: Env, file: string): Promise<Response> {
  const m = /^([^/.]+)\.([a-z0-9]+)$/.exec(file);
  const key = m ? tutorialMediaKey(m[1], m[2]) : null;
  if (!m || !key) return new Response('Not found', { status: 404 });
  const contentType = MEDIA[m[2] as MediaExt];

  const wantsRange = request.headers.has('range');
  const obj = await env.PDFS.get(key, {
    onlyIf: request.headers,
    ...(wantsRange ? { range: request.headers } : {}),
  });
  if (!obj) return new Response('Not found', { status: 404 });

  const headers = new Headers({
    'Content-Type': contentType,
    'Accept-Ranges': 'bytes',
    ETag: obj.httpEtag,
    // Short enough that a replaced video shows up the same day; the ETag
    // makes the revalidation cheap.
    'Cache-Control': 'public, max-age=3600',
    'X-Content-Type-Options': 'nosniff',
  });

  // A failed precondition (If-None-Match matched) comes back without a body.
  if (!('body' in obj)) return new Response(null, { status: 304, headers });

  const body = request.method === 'HEAD' ? null : obj.body;
  if (wantsRange && obj.range) {
    const { start, end } = contentRangeFor(obj.range, obj.size);
    headers.set('Content-Range', `bytes ${start}-${end}/${obj.size}`);
    headers.set('Content-Length', String(end - start + 1));
    return new Response(body, { status: 206, headers });
  }
  headers.set('Content-Length', String(obj.size));
  return new Response(body, { status: 200, headers });
}

export interface TutorialMediaEntry {
  video: { size: number; uploaded: string } | null;
  poster: boolean;
}

/**
 * Which tutorials have a self-hosted video and/or poster, keyed by slug —
 * one R2 list, so the page knows up front which entries play from our server
 * and which still fall back to Loom.
 */
export async function listTutorialMedia(env: Env): Promise<Record<string, TutorialMediaEntry>> {
  const out: Record<string, TutorialMediaEntry> = {};
  let cursor: string | undefined;
  do {
    const page = await env.PDFS.list({ prefix: TUTORIAL_PREFIX, cursor });
    for (const o of page.objects) {
      const m = /^tutorials\/([^/.]+)\.(mp4|jpg)$/.exec(o.key);
      if (!m || !isTutorialSlug(m[1])) continue;
      const entry = (out[m[1]] ||= { video: null, poster: false });
      if (m[2] === 'mp4') entry.video = { size: o.size, uploaded: o.uploaded.toISOString() };
      else entry.poster = true;
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return out;
}

/** GET /api/tutorials/media — the manifest above, public. */
export async function handleTutorialManifest(env: Env): Promise<Response> {
  let media: Record<string, TutorialMediaEntry> = {};
  try {
    media = await listTutorialMedia(env);
  } catch (err) {
    // Fail soft to "nothing hosted": every tutorial falls back to Loom, which
    // is exactly the page as it was before self-hosting existed.
    console.error('tutorial manifest failed:', err);
  }
  return new Response(JSON.stringify({ media }), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=60',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

/**
 * DELETE /api/admin/tutorials/<slug>?kind=video|poster — remove an uploaded
 * file, so the page goes back to its Loom fallback (or loses its poster).
 */
export async function handleAdminTutorialDelete(request: Request, env: Env, slug: string): Promise<Response> {
  const denied = await requireAdminAccess(request, env);
  if (denied) return denied;
  const kind = new URL(request.url).searchParams.get('kind');
  const key = tutorialMediaKey(slug, kind === 'poster' ? 'jpg' : kind === 'video' ? 'mp4' : '');
  if (!key) return json({ error: 'a tutorial slug and kind=video|poster are required' }, 400);
  await env.PDFS.delete(key);
  return json({ deleted: key });
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}
