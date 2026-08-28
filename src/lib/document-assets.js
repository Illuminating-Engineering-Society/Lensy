/**
 * Tables and figures as first-class locators (client DO086).
 *
 * "It doesn't seem to 'understand' tables and images as well as basic text. Are
 *  they also vectorized? Is it multimodal, and if not can it be? … Allow users
 *  to find images, tables, and the content within them via effective search
 *  card results."
 *
 * The honest answer to the question, first, because it decides what this module
 * can and cannot do:
 *
 *   • The embedding model is TEXT-ONLY (@cf/baai/bge-base-en-v1.5). Nothing in
 *     the pipeline is multimodal.
 *   • A table that was extracted as text IS vectorized, as a chunk of
 *     `chunk_type: 'table'` — but the UI deliberately hides those from "From the
 *     Standard" (a raw grid dump repeats the data the card already shows), so
 *     their content is searchable while being invisible and uncitable.
 *   • A table or figure that is a RASTER IMAGE yields no text at all. It is not
 *     indexed, and no amount of retrieval tuning will find it. Reading those
 *     needs OCR or a vision model at ingest — a separate project, sized and
 *     described in CLAUDE.md rather than half-built here.
 *
 * What IS reliably present, for every table and figure in the corpus, is its
 * CAPTION: "Table C-1 Sound Absorption Coefficients for Various Materials",
 * "Figure 5-1 Photometric web diagrams". A caption names the thing, says what is
 * in it, and comes with a page. Indexing captions is therefore what turns the
 * client's three failing searches into answers — "where is the table that shows
 * sound coefficients for various materials?" can be answered with the table's
 * number and page even though its cells are an image.
 *
 * Plain ESM JS so the ingest scripts, the Worker and the tests share one
 * definition.
 */

/**
 * A caption line. IES numbers tables and figures per chapter or annex:
 *   "Table 4-1 …", "Table A-2 …", "Table C-1 …", "Figure 13-19 …", "Figure A-1c …"
 * The label may be followed by a period, an em dash, or nothing.
 */
const CAPTION_RE = /^(Table|Figure|Fig\.?)\s+([A-Z]?-?\d+[A-Za-z]?(?:-\d+[a-z]?)?)\s*[.:—–-]?\s*(.*)$/i;

/** A caption that is really a cross-reference inside a sentence. */
const REFERENCE_PREFIX_RE = /^(?:see|refer to|shown in|listed in|as in|per|from)\b/i;

/** Table-of-contents / list-of-figures line: dot leaders or a trailing page. */
const LEADER_RE = /(?:\.\s*){4,}|\s{2,}\d{1,4}\s*$/;

const MAX_CAPTION_LENGTH = 160;
const MIN_CAPTION_LENGTH = 4;

/**
 * One line → { kind, label, caption } or null.
 *
 * `label` is normalized to "Table C-1" / "Figure 5-1" so a card and the AI Guide
 * name the asset the way the standard prints it.
 */
export function parseCaptionLine(line) {
  const text = String(line || '').trim();
  if (!text || text.length > 300) return null;
  if (LEADER_RE.test(text)) return null;          // a list of figures, not the figure

  const m = CAPTION_RE.exec(text);
  if (!m) return null;
  const kind = /^fig/i.test(m[1]) ? 'figure' : 'table';
  const number = m[2].toUpperCase();
  let caption = String(m[3] || '')
    .replace(/\s+/g, ' ')
    .replace(/[\s.;:,–—-]+$/, '')
    .trim();

  // "Table 4-1" alone is a cross-reference in running text ("…is given in
  // Table 4-1"), not a caption. A caption says what the thing contains.
  if (caption.length < MIN_CAPTION_LENGTH) return null;
  if (REFERENCE_PREFIX_RE.test(caption)) return null;
  // A caption is a NAME: it opens with a capital and is not a sentence.
  if (!/^[A-Z(]/.test(caption)) return null;
  if (caption.length > MAX_CAPTION_LENGTH) caption = `${caption.slice(0, MAX_CAPTION_LENGTH).trim()}…`;

  return { kind, label: `${kind === 'figure' ? 'Figure' : 'Table'} ${number}`, caption };
}

/**
 * A caption that runs onto the next line, joined.
 *
 * Measured on RP-1-24 and RP-43-25: about two figure captions in five are cut at
 * the column boundary — "Table 4-2 UGR Values and Corresponding Descriptive"
 * (…Glare Criteria), "Figure 4-6 Avoid directing" (…light at eye level). A
 * truncated caption is a shorter match target, so the cut costs recall on
 * exactly the searches DO086 is about.
 *
 * Joined only when the next line is set in the SAME font at the SAME margin —
 * i.e. it is visibly part of the same caption block — and is not itself a
 * caption or a heading.
 */
function joinCaptionContinuation(caption, lines, index) {
  const line = lines[index];
  const next = lines[index + 1];
  if (!next || !next.text) return caption;
  if (/[.!?)]$/.test(caption)) return caption;                       // reads finished
  if (caption.length > MAX_CAPTION_LENGTH - 20) return caption;
  // Line GEOMETRY is the whole basis of this judgement: same font, same margin.
  // Without it (a page passed as plain text) there is no way to tell a
  // continuation from the paragraph that follows the caption, so nothing joins.
  if (line.x == null || next.x == null) return caption;
  if (Math.abs((next.fontSize ?? 10) - (line.fontSize ?? 10)) > 0.6) return caption;
  if (Math.abs(next.x - line.x) > 8) return caption;
  if (parseCaptionLine(next.text)) return caption;                   // its own caption
  if (/^(?:\d+(?:\.\d+)*|[A-Z](?:\.\d+)+)[\s.:]/.test(next.text)) return caption;   // a heading
  const words = next.text.trim().split(/\s+/);
  if (words.length > 12) return caption;                             // a paragraph, not a tail
  // The line under a table caption is the table's own first ROW: "Material
  // 125 Hz 250 Hz 500 Hz". Two or more standalone numbers is enough to tell.
  if ((next.text.match(/\b\d+(?:\.\d+)?\b/g) || []).length >= 2) return caption;

  const joined = `${caption} ${next.text.trim()}`
    .replace(/\s+/g, ' ')
    .replace(/[\s.;:,–—-]+$/, '')
    .trim();
  return joined.length <= MAX_CAPTION_LENGTH ? joined : caption;
}

/**
 * Every table and figure caption in one parsed document, in page order.
 *
 * @param {Array<{number:number, text?:string, lines?:Array<{text:string}>}>} pages
 * @returns {Array<{kind:'table'|'figure', label:string, caption:string, page:number}>}
 */
export function extractDocumentAssets(pages) {
  const assets = [];
  const seen = new Set();
  for (const page of pages || []) {
    const lines = page.lines
      ? page.lines.map(l => ({
          text: String(l.text || ''),
          fontSize: typeof l.fontSize === 'number' ? l.fontSize : 10,
          x: typeof l.x === 'number' ? l.x : null,
        }))
      : String(page.text || '').split('\n').map(t => ({ text: t, fontSize: 10, x: null }));

    for (let i = 0; i < lines.length; i++) {
      const parsed = parseCaptionLine(lines[i].text);
      if (!parsed) continue;
      // First printing wins: a caption repeated in a list of figures or a
      // continuation header ("Table 11-2 Photometric Quantities (continued)")
      // should not displace the page the asset actually starts on.
      const key = `${parsed.kind}|${parsed.label}`;
      if (seen.has(key)) continue;
      seen.add(key);
      assets.push({
        ...parsed,
        caption: joinCaptionContinuation(parsed.caption, lines, i),
        page: page.number,
      });
    }
  }
  return assets;
}

/** Words too common to identify an asset by. */
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'what', 'where', 'which',
  'are', 'was', 'table', 'tables', 'figure', 'figures', 'image', 'images', 'show',
  'shows', 'showing', 'find', 'about', 'various', 'value', 'values', 'ies', 'lighting',
  'standard', 'standards', 'diagram', 'diagrams', 'chart', 'graph', 'can', 'need',
]);

/** The words of a query that could name an asset. */
export function assetQueryTerms(query) {
  return [...new Set(
    String(query || '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(w => w.length >= 4 && !STOPWORDS.has(w))
  )];
}

/** Does the query explicitly ask for a table, a figure or an image? */
export function asksForAsset(query) {
  return /\b(?:table|tabulated|figure|fig\.?|image|images|photo|diagram|chart|graph|illustration|drawing|photometric web)\b/i
    .test(String(query || ''));
}

/** A word reduced to its stem for matching: "Coefficients" → "coefficient". */
const stem = (word) => String(word || '').toLowerCase().replace(/(?:ies|es|s)$/, m => (m === 'ies' ? 'y' : ''));

/** The stemmed words of a caption, as a set. */
function captionTokens(asset) {
  return new Set(
    `${asset.label} ${asset.caption}`
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean)
      .map(stem)
  );
}

/**
 * Rank a document's assets against a query.
 *
 * Matched on stemmed WORDS, not substrings, and with a floor: without one, "table
 * of light loss factors" — a table RP-1-24 does not have — filled its quota with
 * five figures whose captions merely contain the word "lighting". Measured, that
 * was the one bad answer in the client's four examples, and a confident wrong
 * table is worse than "no asset matched".
 *
 * @returns the matching assets, best first, at most `limit`.
 */
export function matchAssets(assets, query, limit = 4) {
  const terms = assetQueryTerms(query).map(stem);
  if (terms.length === 0 || !Array.isArray(assets)) return [];
  const wantsAsset = asksForAsset(query);

  const scored = [];
  for (const asset of assets) {
    if (!asset || !asset.caption) continue;
    const tokens = captionTokens(asset);
    const hits = terms.filter(t => tokens.has(t)).length;
    if (hits === 0) continue;
    // TWO matching words, or one when that is all the question had to give and
    // the reader explicitly asked for a table or a figure.
    const enough = hits >= 2 || (hits === 1 && terms.length === 1 && wantsAsset);
    if (!enough) continue;
    scored.push({ asset, score: hits / terms.length, hits });
  }

  return scored
    .sort((a, b) => b.hits - a.hits || b.score - a.score || a.asset.page - b.asset.page)
    .slice(0, limit)
    .map(s => s.asset);
}
