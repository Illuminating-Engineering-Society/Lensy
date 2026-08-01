/**
 * ANSI/IES LS-1 definitions — normalization shared by ingest and search
 * (client feedback DO33).
 *
 * The client asked for a new "Definitions" filter and result card that searches
 * ONLY the LS-1 definitions published at https://ies.org/standards/definitions/,
 * shows the full text of each definition (which may carry emphasis, inline math,
 * or images), and titles every card with the current LS-1 designation. That page
 * is a WordPress `glossary` custom post type, so the authoritative source is its
 * REST collection — no HTML scraping of the A–Z index needed:
 *
 *   https://ies.org/wp-json/wp/v2/glossary?per_page=100&page=N
 *     → [{ slug, link, title: { rendered }, content: { rendered } }, …]
 *
 * Definitions open with their LS-1 clause number in brackets ("[4.1] The
 * characteristic of light by which …"), which is captured separately so the card
 * can cite it the way the printed standard does.
 *
 * NOTE (client): "Sometime late 2027, we anticipate that definition source
 * transitioning to a 'pdf' in Vitrium like all other standards." When that
 * happens this module is replaced by the normal PDF ingest path; the search and
 * UI contracts below (chunk_type 'definition', the `definitions` D1 table) do not
 * change.
 *
 * Plain ESM JS (no TypeScript) so the Node ingestion script and the Worker
 * bundle import the same file.
 */

/** The designation every Definition result card is titled with (client DO33). */
export const DEFINITIONS_STANDARD_ID = 'LS-1-25';
export const DEFINITIONS_STANDARD_FULL = 'ANSI/IES LS-1-25';
export const DEFINITIONS_STANDARD_TITLE =
  'Lighting Science: Nomenclature and Definitions for Illuminating Engineering';

/** Vector id for one definition. Distinct from the `<id>-chunk-<n>` scheme so
 *  the chunk-range cleanup and probe helpers can never touch these. */
export function definitionVectorId(slug) {
  return `LS-1-DEF-${slug}`;
}

// Tags a definition may legitimately use. Everything else is unwrapped (its text
// is kept) or, for <script>/<style>, dropped entirely with its content.
const ALLOWED_TAGS = new Set([
  'p', 'br', 'em', 'i', 'strong', 'b', 'sub', 'sup', 'u', 'span',
  'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tr', 'th', 'td',
  'img', 'a', 'code', 'figure', 'figcaption',
]);

// Attributes kept per tag. No event handlers, no style, no class except the
// KaTeX marker the glossary uses for inline math.
const ALLOWED_ATTRS = {
  a: new Set(['href', 'title']),
  img: new Set(['src', 'alt', 'width', 'height']),
  span: new Set(['class']),
  td: new Set(['colspan', 'rowspan']),
  th: new Set(['colspan', 'rowspan']),
};

const DROP_WITH_CONTENT = new Set(['script', 'style', 'iframe', 'object', 'embed', 'noscript']);

/**
 * Reduce glossary HTML to an allowlisted subset safe to render with innerHTML.
 *
 * Deliberately a string transform rather than a DOM parse: this runs in Node
 * (ingest script) and in a Worker (no DOMParser), and the input is a small,
 * well-formed WordPress block render. Anything not on the allowlist loses its
 * tags but keeps its text, so no definition content is silently lost.
 *
 * @param {string} html
 * @returns {string}
 */
export function sanitizeDefinitionHtml(html) {
  if (!html) return '';
  let out = String(html);

  // 1. Remove elements whose CONTENT must go too.
  for (const tag of DROP_WITH_CONTENT) {
    out = out.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\s*>`, 'gi'), '');
    out = out.replace(new RegExp(`<\\/?${tag}\\b[^>]*>`, 'gi'), '');
  }

  // 2. Drop comments (WordPress block delimiters live in raw content, not the
  //    render, but be safe).
  out = out.replace(/<!--[\s\S]*?-->/g, '');

  // 3. Rewrite every remaining tag: keep allowlisted ones with allowlisted
  //    attributes, unwrap the rest.
  out = out.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g, (match, rawTag, rawAttrs) => {
    const tag = rawTag.toLowerCase();
    if (!ALLOWED_TAGS.has(tag)) return '';
    if (match.startsWith('</')) return `</${tag}>`;

    const allowed = ALLOWED_ATTRS[tag];
    let attrs = '';
    if (allowed) {
      const attrRe = /([a-zA-Z-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
      let m;
      while ((m = attrRe.exec(rawAttrs)) !== null) {
        const name = m[1].toLowerCase();
        if (!allowed.has(name)) continue;
        const value = m[2] ?? m[3] ?? '';
        // Only http(s), protocol-relative and data:image URLs — never
        // javascript: or data:text/html.
        if ((name === 'href' || name === 'src') && !isSafeUrl(value)) continue;
        attrs += ` ${name}="${escapeAttr(value)}"`;
      }
      // Every surviving link opens away from Lensy.
      if (tag === 'a' && /\shref=/.test(attrs)) attrs += ' target="_blank" rel="noopener nofollow"';
    }
    const selfClosing = tag === 'br' || tag === 'img';
    return `<${tag}${attrs}${selfClosing ? ' /' : ''}>`;
  });

  return out.trim();
}

function isSafeUrl(value) {
  const v = String(value || '').trim();
  if (/^(?:https?:)?\/\//i.test(v)) return true;
  if (/^\//.test(v)) return true;
  if (/^data:image\/(?:png|jpe?g|gif|svg\+xml|webp);/i.test(v)) return true;
  return false;
}

function escapeAttr(value) {
  return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Plain-text rendering of a definition — what gets embedded, keyword-matched,
 * and shown to the AI Guide. Block tags become spaces so words never fuse.
 *
 * @param {string} html
 * @returns {string}
 */
export function definitionPlainText(html) {
  if (!html) return '';
  return String(html)
    .replace(/<(?:script|style)\b[^>]*>[\s\S]*?<\/(?:script|style)\s*>/gi, ' ')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/(?:p|li|tr|div|h[1-6])\s*>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#8217;|&#x2019;|&rsquo;/gi, '’')
    .replace(/&#8216;|&lsquo;/gi, '‘')
    .replace(/&hellip;/gi, '…')
    .replace(/&[a-z]+;|&#\d+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The LS-1 clause number a definition opens with: "[4.1] The characteristic of
 * light …" → "4.1". Returns null for the handful of entries printed without one
 * (e.g. the Annex A overview page).
 *
 * @param {string} text plain text (see definitionPlainText)
 * @returns {string|null}
 */
export function definitionClause(text) {
  const m = /^\s*\[\s*([0-9]+(?:\.[0-9]+)*)\s*\]/.exec(String(text || ''));
  return m ? m[1] : null;
}

/**
 * Normalize one WordPress glossary post into the record shape D1 and Vectorize
 * both consume.
 *
 * @param {{slug?:string, link?:string, title?:{rendered?:string}, content?:{rendered?:string}}} post
 * @returns {{slug,term,clause,html,text,sourceUrl}|null} null when unusable
 */
export function normalizeGlossaryPost(post) {
  const slug = String(post?.slug || '').trim();
  const term = definitionPlainText(post?.title?.rendered || '');
  const html = sanitizeDefinitionHtml(post?.content?.rendered || '');
  const text = definitionPlainText(post?.content?.rendered || '');
  if (!slug || !term || !text) return null;
  return {
    slug,
    term,
    clause: definitionClause(text),
    html,
    text,
    sourceUrl: post?.link || `https://ies.org/definitions/${slug}/`,
  };
}

/**
 * Text embedded for one definition.
 *
 * The TERM is repeated so a query that is just the term ("color", "mesopic")
 * lands on its own definition rather than on the dozens of definitions that
 * mention it in passing — the same weighting trick used for application rows.
 * The clause number is left out: it carries no semantic signal and "[4.1]"
 * would collide with section references throughout the corpus.
 *
 * @param {{term:string, text:string}} def
 * @returns {string}
 */
export function buildDefinitionEmbedText(def) {
  const body = String(def.text || '').replace(/^\s*\[[0-9.]+\]\s*/, '');
  return `${def.term}. ${def.term}. ${body}`;
}
