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
import { getSsoState } from '../lib/sso';
import {
  sanitizeGuideHtml, guideImageSources, replaceImageSources, isHostedGuideAsset,
  normalizeLoomUrl, GUIDE_IMAGE_TYPES, MAX_GUIDE_HTML_LENGTH,
} from '../lib/tutorial-guides.js';

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

/**
 * GET /api/tutorials/media — the manifest above plus staff edits
 * (`overrides`, see readTutorialOverrides), public.
 */
export async function handleTutorialManifest(env: Env): Promise<Response> {
  let media: Record<string, TutorialMediaEntry> = {};
  try {
    media = await listTutorialMedia(env);
  } catch (err) {
    // Fail soft to "nothing hosted": every tutorial falls back to Loom, which
    // is exactly the page as it was before self-hosting existed.
    console.error('tutorial manifest failed:', err);
  }
  const overrides = await readTutorialOverrides(env);
  return new Response(JSON.stringify({ media, overrides }), {
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

// ── Staff edits: Loom link, title, summary, How-To guide (client 10/29/26) ───
// Dan: "does it simplify workflow to add fields to modify: Loom Link (in case
// we record a complete replacement video); How-To Guides (copy/paste rich text
// with images into a field to update as necessary)". One row per edited
// tutorial (migration 0026); a NULL column falls back to the catalogue file.

export interface TutorialOverride {
  loom: string | null;
  title: string | null;
  summary: string | null;
  guideHtml: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
}

interface OverrideRow {
  slug: string; loom_url: string | null; title: string | null; summary: string | null;
  guide_html: string | null; updated_at: string | null; updated_by: string | null;
}

/** Every override, keyed by slug. Fail-soft: no table yet → none. */
export async function readTutorialOverrides(env: Env): Promise<Record<string, TutorialOverride>> {
  try {
    const res = await env.DB.prepare(
      'SELECT slug, loom_url, title, summary, guide_html, updated_at, updated_by FROM tutorial_overrides',
    ).all<OverrideRow>();
    const out: Record<string, TutorialOverride> = {};
    for (const r of res.results || []) {
      if (!isTutorialSlug(r.slug)) continue;
      out[r.slug] = {
        loom: r.loom_url, title: r.title, summary: r.summary, guideHtml: r.guide_html,
        updatedAt: r.updated_at, updatedBy: r.updated_by,
      };
    }
    return out;
  } catch (err) {
    console.error('tutorial overrides unreadable (migration 0026 applied?):', err);
    return {};
  }
}

const MAX_TITLE = 200;
const MAX_SUMMARY = 2000;
const MAX_GUIDE_IMAGES = 60;
const MAX_GUIDE_IMAGE_BYTES = 5 * 1024 * 1024;
export const GUIDE_ASSET_PREFIX = `${TUTORIAL_PREFIX}guides/`;

/**
 * PUT /api/admin/tutorials/<slug> — {loom?, title?, summary?, guideHtml?}.
 * A key that is absent stays as it is; null or "" clears it back to the
 * catalogue's value. The guide is sanitized and its images copied into R2
 * before it is stored, so what readers get is what this answer reports.
 */
export async function handleAdminTutorialUpdate(request: Request, env: Env, slug: string): Promise<Response> {
  const denied = await requireAdminAccess(request, env);
  if (denied) return denied;
  if (!isTutorialSlug(slug)) return json({ error: 'unknown tutorial slug' }, 400);

  let body: Record<string, unknown>;
  try { body = await request.json(); } catch { return json({ error: 'JSON body required' }, 400); }
  if (!body || typeof body !== 'object') return json({ error: 'JSON body required' }, 400);

  const current = (await readTutorialOverrides(env))[slug] ?? null;
  const next = {
    loom: current?.loom ?? null,
    title: current?.title ?? null,
    summary: current?.summary ?? null,
    guideHtml: current?.guideHtml ?? null,
  };
  const cleared = (v: unknown) => v === null || (typeof v === 'string' && v.trim() === '');

  if ('loom' in body) {
    if (cleared(body.loom)) next.loom = null;
    else {
      const loom = normalizeLoomUrl(body.loom);
      if (!loom) return json({ error: 'The Loom link must be a loom.com/share/… or loom.com/embed/… address.' }, 400);
      next.loom = loom;
    }
  }
  if ('title' in body) {
    next.title = cleared(body.title) ? null : String(body.title).trim().slice(0, MAX_TITLE);
  }
  if ('summary' in body) {
    next.summary = cleared(body.summary) ? null : String(body.summary).trim().slice(0, MAX_SUMMARY);
  }

  let imagesCopied = 0;
  let imagesDropped = 0;
  if ('guideHtml' in body) {
    const clean = cleared(body.guideHtml) ? '' : sanitizeGuideHtml(String(body.guideHtml));
    if (!clean) {
      next.guideHtml = null;
    } else {
      // Measured AFTER the images are copied: a pasted screenshot arrives as a
      // data: URI that is far longer than the link it becomes.
      const hosted = await hostGuideImages(env, slug, clean);
      if (hosted.html.length > MAX_GUIDE_HTML_LENGTH) {
        return json({ error: 'That guide is too long to store — split it, or paste less text.' }, 400);
      }
      next.guideHtml = hosted.html || null;
      imagesCopied = hosted.copied;
      imagesDropped = hosted.dropped;
    }
  }

  const updatedBy = await staffIdentity(request, env);
  const empty = !next.loom && !next.title && !next.summary && !next.guideHtml;
  try {
    if (empty) {
      await env.DB.prepare('DELETE FROM tutorial_overrides WHERE slug = ?').bind(slug).run();
    } else {
      await env.DB.prepare(`
        INSERT INTO tutorial_overrides (slug, loom_url, title, summary, guide_html, updated_at, updated_by)
        VALUES (?, ?, ?, ?, ?, datetime('now'), ?)
        ON CONFLICT(slug) DO UPDATE SET
          loom_url = excluded.loom_url, title = excluded.title, summary = excluded.summary,
          guide_html = excluded.guide_html, updated_at = excluded.updated_at, updated_by = excluded.updated_by
      `).bind(slug, next.loom, next.title, next.summary, next.guideHtml, updatedBy).run();
    }
  } catch (err) {
    console.error('tutorial override write failed:', err);
    return json({ error: 'Could not save — has migration 0026 been applied?' }, 500);
  }
  return json({ slug, override: empty ? null : next, imagesCopied, imagesDropped });
}

/**
 * Copy every image a guide names into R2 and point the guide at the copies.
 * Pasted images arrive three ways: Loom's CDN (signed links that expire),
 * data: URIs (a screenshot or a Word paste) and, rarely, another https host.
 * An image that cannot be copied is dropped rather than left pointing at a
 * host the page's CSP would block anyway; the count is reported to staff.
 */
export async function hostGuideImages(
  env: Env, slug: string, html: string, fetcher: typeof fetch = fetch,
): Promise<{ html: string; copied: number; dropped: number }> {
  const map = new Map<string, string | null>();
  let copied = 0;
  let dropped = 0;
  const sources = guideImageSources(html).filter(src => !isHostedGuideAsset(src) && !/^\/(?!\/)/.test(src));
  for (const [i, src] of sources.entries()) {
    if (i >= MAX_GUIDE_IMAGES) { map.set(src, null); dropped++; continue; }
    try {
      const image = await readImage(src, fetcher);
      if (!image) { map.set(src, null); dropped++; continue; }
      const hash = await sha256Hex(image.bytes);
      const file = `${hash.slice(0, 32)}.${image.ext}`;
      await env.PDFS.put(`${GUIDE_ASSET_PREFIX}${slug}/${file}`, image.bytes, {
        httpMetadata: { contentType: image.type },
      });
      map.set(src, `/api/tutorials/guide-assets/${slug}/${file}`);
      copied++;
    } catch (err) {
      console.error('guide image copy failed:', err);
      map.set(src, null);
      dropped++;
    }
  }
  return { html: map.size ? sanitizeGuideHtml(replaceImageSources(html, map)) : html, copied, dropped };
}

async function readImage(
  src: string, fetcher: typeof fetch,
): Promise<{ bytes: Uint8Array; type: string; ext: string } | null> {
  const data = /^data:(image\/[a-z+.-]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(src);
  if (data) {
    const type = data[1].toLowerCase();
    const ext = (GUIDE_IMAGE_TYPES as Record<string, string>)[type];
    if (!ext) return null;
    const bin = atob(data[2].replace(/\s+/g, ''));
    if (bin.length > MAX_GUIDE_IMAGE_BYTES) return null;
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return { bytes, type, ext };
  }
  const url = src.startsWith('//') ? `https:${src}` : src;
  if (!/^https:\/\//i.test(url)) return null;
  const res = await fetcher(url, { redirect: 'follow', signal: AbortSignal.timeout(10_000) });
  if (!res.ok) return null;
  const type = (res.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
  const ext = (GUIDE_IMAGE_TYPES as Record<string, string>)[type];
  if (!ext) return null;
  const declared = Number(res.headers.get('Content-Length') || 0);
  if (declared > MAX_GUIDE_IMAGE_BYTES) return null;
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length > MAX_GUIDE_IMAGE_BYTES) return null;
  return { bytes, type, ext };
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** GET /api/tutorials/guide-assets/<slug>/<hash>.<ext> — a guide's image, public. */
export async function serveGuideAsset(env: Env, path: string): Promise<Response> {
  const m = /^([a-z0-9]+(?:-[a-z0-9]+)*)\/([a-f0-9]{16,64})\.(png|jpg|gif|webp)$/.exec(path);
  if (!m || !isTutorialSlug(m[1])) return new Response('Not found', { status: 404 });
  const obj = await env.PDFS.get(`${GUIDE_ASSET_PREFIX}${m[1]}/${m[2]}.${m[3]}`);
  if (!obj) return new Response('Not found', { status: 404 });
  const type = Object.entries(GUIDE_IMAGE_TYPES).find(([, ext]) => ext === m[3])?.[0] ?? 'application/octet-stream';
  return new Response(obj.body, {
    headers: {
      'Content-Type': type,
      // Content-addressed: a changed image is a new file name.
      'Cache-Control': 'public, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

async function staffIdentity(request: Request, env: Env): Promise<string> {
  try {
    const sso = await getSsoState(request, env);
    if (sso.state === 'ok') return sso.user.email;
  } catch { /* attribution is best-effort */ }
  return 'staff-bearer';
}
