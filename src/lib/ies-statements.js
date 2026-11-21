/**
 * IES Statements: a position of the Society printed INSIDE a standard (Dan,
 * Teams 11/19/26 #1).
 *
 *   "BUG ratings are incredibly sensitive at the moment … AI Guide provided an
 *    erroneous statement 'the bug rating is a measure of the attractiveness of a
 *    luminaire to insects' and it did not ever reference the 'IES Statement' on
 *    the inside cover of TM-15-20 (which would have been good), despite the
 *    first search result quoting it … Perhaps we can train more broadly for
 *    bold direct phrases like 'IES Statement on...' and 'The Illuminating
 *    Engineering Society recognizes' to indicate critical contextual guidance?"
 *
 * Why the Guide never used it (measured 11/20/26 on TM-15-20): the Statement
 * is page 2 of the PDF, the cover is page 1, and the two share one chunk. A
 * vector carries a 500-character excerpt, the cover's boilerplate takes the
 * first 150 of them, and the Guide's prompt takes 320 — so the model was shown
 * the Statement's TITLE and the first clause of its first sentence, and not one
 * word of what it says. No retrieval tuning fixes that: the text was never
 * there to retrieve.
 *
 * So a Statement is not left to retrieval. It is read whole at ingest
 * (`detectIesStatements`), stored on the standard (standards.statements_json,
 * migration 0032), and handed to the Guide in full — as the Society's own
 * position, ahead of the excerpts — whenever the search touches its subject or
 * its document (`pickStatements`). The reader gets a notice naming it either
 * way, AI Guide on or off.
 *
 * Detection is the two phrases the client named, and deliberately no more: a
 * page that OPENS with a heading "IES Statement on …" (or "IES Position
 * Statement …"), or whose first sentence is "The Illuminating Engineering
 * Society (IES) recognizes …". Both must stand at the top of a page — the
 * same words in running prose are an ordinary sentence, not a Statement.
 *
 * Plain JS: the Node ingest script, the dashboard ingest in the Worker and the
 * search Worker all import it, so the three cannot disagree about what a
 * Statement is.
 */

/** A page is a Statement only when one of these stands in its opening lines. */
const HEADING_RE = /^IES\s+(?:Position\s+)?Statement\b(?:\s+(?:on|regarding|concerning|about)\b)?.{0,170}$/i;
const OPENING_RE = /^The\s+Illuminating\s+Engineering\s+Society(?:\s*\(IES\))?\s+recogni[sz]es\b/i;
/** How far into a page the heading / opening sentence may stand. */
const HEADING_WITHIN_LINES = 3;
const OPENING_WITHIN_LINES = 5;
/** Shorter than this is a caption or a cross-reference, not a Statement. */
const MIN_BODY_CHARS = 300;
const MAX_TEXT_CHARS = 6000;
const MAX_TITLE_CHARS = 180;
const MAX_STATEMENTS = 4;

const DATE_LINE_RE = /^(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4}\.?$/i;

/** One page's lines as clean strings (a page from pdf-pages.js, or bare text). */
function linesOf(page) {
  const raw = Array.isArray(page?.lines)
    ? page.lines.map(l => (typeof l === 'string' ? l : l?.text))
    : String(page?.text || '').split('\n');
  return raw
    // Subsetted fonts put punctuation on C0 control code points; inside a
    // sentence the one that occurs is the hyphen of a designation.
    .map(l => String(l ?? '').replace(/[\u0000-\u0008\u000b-\u001f]/g, '-').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

/**
 * Lines → one paragraph of running text. A line that ends on a hyphen before a
 * digit is a designation cut by the line break ("TM-15-" / "20"), which is
 * rejoined without a space; every other break is a space.
 */
function joinLines(lines) {
  let out = '';
  for (const line of lines) {
    if (!out) { out = line; continue; }
    out += (/[A-Za-z0-9]-$/.test(out) && /^\d/.test(line)) ? line : ` ${line}`;
  }
  return out;
}

/**
 * The Statements printed in a document.
 *
 * @param {Array<{number?: number, lines?: Array<{text: string}|string>, text?: string}>} pages
 * @returns {Array<{title: string, page: number, date: string|null, text: string}>}
 */
export function detectIesStatements(pages) {
  const out = [];
  const list = Array.isArray(pages) ? pages : [];
  for (let i = 0; i < list.length && out.length < MAX_STATEMENTS; i++) {
    const lines = linesOf(list[i]);
    if (lines.length < 3) continue;

    const headingAt = lines.slice(0, HEADING_WITHIN_LINES).findIndex(l => HEADING_RE.test(l) && l.length >= 16);
    const openingAt = lines.slice(0, OPENING_WITHIN_LINES).findIndex(l => OPENING_RE.test(l));
    if (headingAt === -1 && openingAt === -1) continue;

    // A table of contents lists "IES Statement on … 2" — a title with a page
    // number and nothing under it. The body test below rejects it too; this
    // only keeps the heading from being read off a dotted leader line.
    if (headingAt !== -1 && /\.{3,}\s*\d+$|\s\d+$/.test(lines[headingAt]) && openingAt === -1) continue;

    const bodyFrom = headingAt !== -1 ? headingAt + 1 : openingAt;
    let bodyLines = lines.slice(bodyFrom);
    let date = null;
    const last = bodyLines[bodyLines.length - 1] || '';
    if (DATE_LINE_RE.test(last)) {
      date = last.replace(/\.$/, '');
      bodyLines = bodyLines.slice(0, -1);
    }
    const text = joinLines(bodyLines).slice(0, MAX_TEXT_CHARS).trim();
    if (text.length < MIN_BODY_CHARS) continue;

    const title = (headingAt !== -1 ? lines[headingAt] : 'IES Statement').slice(0, MAX_TITLE_CHARS);
    const page = Number.isInteger(list[i]?.number) && list[i].number > 0 ? list[i].number : i + 1;
    out.push({ title, page, date, text });
  }
  return out;
}

/** standards.statements_json → a validated list (never throws; [] for anything else). */
export function parseStatements(raw) {
  let value = raw;
  if (typeof raw === 'string') {
    if (!raw.trim()) return [];
    try { value = JSON.parse(raw); } catch { return []; }
  }
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const s of value) {
    if (!s || typeof s !== 'object') continue;
    const title = String(s.title || '').replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE_CHARS);
    const text = String(s.text || '').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT_CHARS);
    const page = Number(s.page);
    if (!title || text.length < MIN_BODY_CHARS || !Number.isInteger(page) || page < 1) continue;
    const date = typeof s.date === 'string' && s.date.trim() ? s.date.trim().slice(0, 40) : null;
    out.push({ title, page, date, text });
    if (out.length >= MAX_STATEMENTS) break;
  }
  return out;
}

// ─── Which Statements bear on a search ───────────────────────────────────────

const TITLE_FILLER = new Set((
  'ies statement position on of the and for in a an to regarding concerning about its their with from by'
).split(' '));

function stem(word) {
  if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

/**
 * What a Statement's title is about, for matching a query:
 *   words     — its content words, lower-cased and stemmed ("zonal", "lumen",
 *               "classification", "bug", "rating")
 *   acronyms  — the ones printed in capitals ("BUG"), matched case-SENSITIVELY
 *   families  — the standards it names ("TM-15")
 */
export function statementTopics(title) {
  const text = String(title || '');
  const families = [...text.matchAll(/\b((?:RP|TM|HB|LM|LP|LS|DG|LEM|G)-\d+(?:\.\d+)?)/gi)].map(m => m[1].toUpperCase());
  const acronyms = [...text.matchAll(/\b([A-Z]{2,6})\b/g)].map(m => m[1])
    .filter(a => !['IES', 'ANSI', 'IESNA'].includes(a) && !families.some(f => f.startsWith(`${a}-`)));
  const words = text.toLowerCase()
    .replace(/\b(?:rp|tm|hb|lm|lp|ls|dg|lem|g)-\d+(?:\.\d+)?(?:-\d{2})?/g, ' ')
    .split(/[^a-z0-9]+/)
    .filter(w => w.length > 2 && !TITLE_FILLER.has(w))
    .map(stem);
  return { words: [...new Set(words)], acronyms: [...new Set(acronyms)], families: [...new Set(families)] };
}

/**
 * Does the QUERY itself reach this Statement?
 *
 *   - it names a standard the title names ("TM-15"), or
 *   - it carries one of the title's acronyms as printed ("BUG"), or
 *   - it shares two of the title's content words ("bug rating", "zonal lumen").
 *
 * One shared word is not enough on purpose: "bug" alone is an insect, and
 * "rating" alone is an IP rating. That pair of everyday words is the whole
 * reason this module exists.
 */
export function queryNamesStatement(query, title) {
  const q = String(query || '');
  if (!q.trim()) return false;
  const topics = statementTopics(title);
  const upper = q.toUpperCase();
  if (topics.families.some(f => new RegExp(`(?<![A-Z0-9])${f.replace(/[.]/g, '\\.')}(?![0-9.])`).test(upper))) return true;
  if (topics.acronyms.some(a => new RegExp(`(?<![A-Za-z])${a}(?![A-Za-z])`).test(q))) return true;
  const have = new Set(q.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).map(stem));
  return topics.words.filter(w => have.has(w)).length >= 2;
}

/**
 * The Statements that apply to one search.
 *
 * @param {object} input
 * @param {string} input.query                     the (English) query
 * @param {string[]} input.leadingStandards        ids of the standards the first results come from
 * @param {Array<{standardId: string, statements: Array}>} input.catalogue   every current standard that prints one
 * @param {number} [input.max]
 * @returns {Array<{standardId: string, title: string, page: number, date: string|null, text: string, matched: 'query'|'results'}>}
 */
export function pickStatements({ query, leadingStandards, catalogue, max = 2 }) {
  const leading = new Set((leadingStandards || []).map(id => String(id || '').toUpperCase()).filter(Boolean));
  const byQuery = [];
  const byResults = [];
  for (const entry of catalogue || []) {
    const standardId = String(entry?.standardId || '');
    if (!standardId) continue;
    for (const s of entry.statements || []) {
      if (queryNamesStatement(query, s.title)) byQuery.push({ standardId, ...s, matched: 'query' });
      else if (leading.has(standardId.toUpperCase())) byResults.push({ standardId, ...s, matched: 'results' });
    }
  }
  return [...byQuery, ...byResults].slice(0, max);
}

/** Where a Statement is printed, in words a reader can act on. */
export function statementLocation(page, pageLabel) {
  // The page straight after the cover is the inside front cover, which is how
  // IES itself refers to it; anything else is a page like any other.
  if (page === 2) return 'inside the front cover';
  return `on p. ${pageLabel || page}`;
}
