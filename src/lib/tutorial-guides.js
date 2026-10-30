/**
 * Tutorial guides staff paste into /admin (client, 2026-10-29: "How-To Guides:
 * copy/paste rich text with images into a field to update as necessary").
 *
 * Pure helpers — no I/O — so the Worker (workers/tutorials.ts) and the tests
 * share them:
 *   sanitizeGuideHtml   pasted HTML → the allowlisted subset the page renders
 *   guideImageSources   every <img src> in a guide, in order
 *   replaceImageSources rewrite them (to our own copies) or drop the failed ones
 *   normalizeLoomUrl    a Loom share/embed link → its canonical share URL
 *
 * Where the HTML comes from decides the rules. Loom's own How-To Guide page
 * copies as headings, paragraphs, lists, bold, timestamp links and screenshots
 * on Loom's CDN; Word copies the same plus inline styles and classes. Styles
 * and classes go (the page has its own typography); headings are kept but
 * clamped to h2–h4 so a pasted <h1> cannot outrank the tutorial's title.
 */

import { sanitizeAllowlistedHtml } from './definitions.js';

const GUIDE_TAGS = new Set([
  'p', 'br', 'em', 'i', 'strong', 'b', 'u', 'sub', 'sup', 'code',
  'h2', 'h3', 'h4', 'ul', 'ol', 'li', 'blockquote', 'hr',
  'table', 'thead', 'tbody', 'tr', 'th', 'td',
  'a', 'img', 'figure', 'figcaption',
]);

const GUIDE_ATTRS = {
  a: new Set(['href', 'title']),
  img: new Set(['src', 'alt', 'width', 'height']),
  td: new Set(['colspan', 'rowspan']),
  th: new Set(['colspan', 'rowspan']),
};

/** Largest guide stored, after sanitizing (images are links, not bytes). */
export const MAX_GUIDE_HTML_LENGTH = 200_000;

/**
 * @param {string} html
 * @returns {string}
 */
export function sanitizeGuideHtml(html) {
  if (!html) return '';
  const clamped = String(html)
    .replace(/<(\/?)h1\b/gi, '<$1h2')
    .replace(/<(\/?)h[56]\b/gi, '<$1h4');
  const clean = sanitizeAllowlistedHtml(clamped, GUIDE_TAGS, GUIDE_ATTRS)
    // Word's empty paragraphs, &nbsp;-only paragraphs and runs of <br>.
    .replace(/<p>(?:\s|&nbsp;|<br \/>)*<\/p>/gi, '')
    .replace(/(?:<br \/>\s*){3,}/gi, '<br /><br />')
    .trim();
  // Nothing readable left (an empty editor, or only whitespace) is "no guide".
  const text = clean.replace(/<img\b[^>]*>/gi, 'x').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim();
  return text ? clean : '';
}

const IMG_SRC_RE = /<img\b[^>]*?\ssrc="([^"]*)"[^>]*>/gi;

/** Every image source in a (sanitized) guide, in document order, de-duplicated. */
export function guideImageSources(html) {
  const out = [];
  for (const m of String(html || '').matchAll(IMG_SRC_RE)) {
    const src = decodeAttr(m[1]);
    if (src && !out.includes(src)) out.push(src);
  }
  return out;
}

/**
 * Rewrite image sources: `map` gives each source its new URL, or null to drop
 * the image (it could not be copied — leaving a link to a host the page's CSP
 * blocks would only render a broken-image icon).
 */
export function replaceImageSources(html, map) {
  return String(html || '').replace(IMG_SRC_RE, (tag, raw) => {
    const src = decodeAttr(raw);
    if (!map.has(src)) return tag;
    const next = map.get(src);
    if (!next) return '';
    return tag.replace(`src="${raw}"`, `src="${escapeAttr(next)}"`);
  });
}

/** Is this already one of our own copies (no need to fetch it again)? */
export function isHostedGuideAsset(src) {
  return /^\/api\/tutorials\/guide-assets\/[a-z0-9-]+\/[a-f0-9]{16,64}\.(?:png|jpg|gif|webp)$/.test(String(src || ''));
}

/**
 * A Loom link → `https://www.loom.com/share/<id>`, or null when it is not one.
 * Accepts share and embed links, with or without www and query strings.
 */
export function normalizeLoomUrl(value) {
  const m = /^https:\/\/(?:www\.)?loom\.com\/(?:share|embed)\/([A-Za-z0-9]{16,64})(?:[/?#].*)?$/.exec(String(value || '').trim());
  return m ? `https://www.loom.com/share/${m[1]}` : null;
}

/** Image content types we keep, by the extension we store them under. */
export const GUIDE_IMAGE_TYPES = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

function decodeAttr(value) {
  return String(value).replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function escapeAttr(value) {
  return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
