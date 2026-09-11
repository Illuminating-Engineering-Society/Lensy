/**
 * DOCX manuscript extraction — Phase A of the dual-upload ingest
 * (docs/DOCX_INGEST.md; client, 2026-09-11: "The Word doc should be
 * responsible for feeding … the AI system on the content. The PDF should be
 * responsible for directing the page in which the content exists").
 *
 * A .docx is ZIP + OOXML, so unlike the PDF — which needs the staff browser's
 * pdfjs — it is parsed IN THE WORKER, with no library: a minimal ZIP reader
 * over DecompressionStream plus a non-validating XML walk. Everything here is
 * runtime-agnostic (workerd and Node ≥18 for the tests; raw-deflate entries
 * additionally need DecompressionStream('deflate-raw'), which workerd has).
 *
 * What comes out carries NO page numbers, by construction — a .docx has no
 * pages; pagination is a rendering artifact of fonts and printer metrics.
 * src/lib/page-align.js stamps every chunk with the page of the PUBLISHED
 * PDF, which stays the citation authority (rule 3 of the design).
 *
 * Where the PDF path fights layout, this path reads structure:
 *   - headings are Heading styles / outlineLvl, so section numbers and titles
 *     need none of section-titles.js's subsetted-font heuristics (DO071);
 *   - a reference entry is one PARAGRAPH, not an x-indent guess;
 *   - a table is w:tbl — every cell is text, including the tables that are
 *     raster images in the PDF (DO086 limit 2);
 *   - captions are whole paragraphs, never split by a column boundary;
 *   - math is OMML, linearized to readable text instead of the underscore
 *     soup pdfjs produces (the query-time formula guard still applies to what
 *     a CARD shows — but the embedding now sees real content, not noise).
 *
 * Deliberate limits, matching the design doc:
 *   - Sub/superscript runs are flattened to plain text — the same form the
 *     PDF path produces, so one query matches both corpora and the UI's
 *     sciNotate restoration (DO070) keeps working unchanged.
 *   - A heading with NO literal number in its text is only given a number
 *     when Word itself numbers it (w:numPr) — synthesizing a locator for a
 *     genuinely unnumbered heading would print a section number the document
 *     never carried, the exact failure DO071 exists to prevent.
 *   - footnotes.xml is not walked (footnote text is out of the body flow and
 *     could not be page-aligned honestly); tracked changes are REFUSED, never
 *     silently resolved — indexing either side of an unaccepted revision is
 *     indexing text nobody approved (design rule 2).
 */

import { looksLikeFormalReference } from './references.js';
import { parseCaptionLine } from './document-assets.js';

// Mirrors the PDF chunker's DEFAULTS (src/lib/chunker.js) — one sizing policy,
// so a manuscript-sourced corpus retrieves like a PDF-sourced one.
const DEFAULTS = {
  targetWords: 200,
  overlapWords: 60,
  minWords: 30,
  minReferenceWords: 5,
};

// Same vocabulary as the chunker's REFERENCES_HEADING_RE.
const REFERENCES_HEADING_RE =
  /^(?:(?:\d+(?:\.\d+)*|Annex\s+[A-Z]|Appendix\s+[A-Z])[\s.:—-]*)?(?:Normative\s+|Informative\s+)?(?:References?|Bibliography)\s*$/i;

const ANNEX_HEADING_RE = /^(Annex|Appendix)\s+([A-Z])\b[\s.:—–-]*(.*)$/i;
// "4.2 Task Plane Lighting" / "A.1.1.3 Regular Area…". The first numeric
// component is capped below ("2026 Compliance Deadlines" is a title, not
// section 2026 — the trustedSectionLabel lesson).
const LITERAL_NUMBER_RE = /^((?:\d+(?:\.\d+)*)|(?:[A-Z](?:\.\d+)+))[.\s:—–-]+(\S.*)$/;

const DESIGNATION_RE = /\b[A-Z]{1,3}-\d+(?:\.\d+)?-\d+(?:\+E\d+)?\b/;

// ─── ZIP reading ──────────────────────────────────────────────────────────────

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;

/**
 * Read a ZIP archive into Map<entry name, Uint8Array>. Supports stored (0) and
 * deflate (8) entries — everything Word writes. No ZIP64 (a .docx is nowhere
 * near 4 GB) and no CRC verification (a corrupt part fails XML parsing anyway).
 */
export async function unzipDocx(bytes) {
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (buf.length < 22) throw new Error('File is too small to be a .docx');
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  // The end-of-central-directory record sits at the very end, behind an
  // optional comment of up to 65535 bytes — scan backwards for its signature.
  let eocd = -1;
  for (let i = buf.length - 22, min = Math.max(0, buf.length - 22 - 65535); i >= min; i--) {
    if (view.getUint32(i, true) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a ZIP archive (no end-of-central-directory record) — is this really a .docx?');

  const count = view.getUint16(eocd + 10, true);
  let off = view.getUint32(eocd + 16, true);
  const parts = new Map();
  const decoder = new TextDecoder();

  for (let n = 0; n < count; n++) {
    if (off + 46 > buf.length || view.getUint32(off, true) !== CEN_SIG) {
      throw new Error('Corrupt ZIP central directory');
    }
    const method = view.getUint16(off + 10, true);
    const compSize = view.getUint32(off + 20, true);
    const nameLen = view.getUint16(off + 28, true);
    const extraLen = view.getUint16(off + 30, true);
    const commentLen = view.getUint16(off + 32, true);
    const localOff = view.getUint32(off + 42, true);
    const name = decoder.decode(buf.subarray(off + 46, off + 46 + nameLen));

    if (localOff + 30 > buf.length || view.getUint32(localOff, true) !== LOC_SIG) {
      throw new Error(`Corrupt ZIP local header for ${name}`);
    }
    // The local header carries its own name/extra lengths — they can differ
    // from the central directory's copy, so the data offset must use them.
    const lNameLen = view.getUint16(localOff + 26, true);
    const lExtraLen = view.getUint16(localOff + 28, true);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const data = buf.subarray(dataStart, dataStart + compSize);

    if (method === 0) parts.set(name, data);
    else if (method === 8) parts.set(name, await inflateRaw(data));
    else throw new Error(`Unsupported ZIP compression method ${method} for ${name}`);

    off += 46 + nameLen + extraLen + commentLen;
  }
  return parts;
}

async function inflateRaw(data) {
  let ds;
  try {
    ds = new DecompressionStream('deflate-raw');
  } catch {
    throw new Error('This runtime cannot inflate deflate-raw ZIP entries (needs workerd or Node ≥ 21.2)');
  }
  const stream = new Blob([data]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// ─── Minimal XML ──────────────────────────────────────────────────────────────
// Non-validating, tuned to what Word's serializer actually emits: double-quoted
// attributes with entities escaped (a raw '>' inside an attribute value would
// mis-tokenize, but Word never writes one).

const XML_TOKEN_RE = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<[^>]+>|[^<]+/g;

/** Parse XML into { tag, attrs (raw string), children: (node|string)[] }. */
export function parseXml(xml) {
  const root = { tag: '#root', attrs: '', children: [] };
  const stack = [root];
  XML_TOKEN_RE.lastIndex = 0;
  let m;
  while ((m = XML_TOKEN_RE.exec(xml)) !== null) {
    const tok = m[0];
    if (tok.startsWith('<!--')) continue;
    if (tok.startsWith('<![CDATA[')) {
      stack[stack.length - 1].children.push(tok.slice(9, -3));
      continue;
    }
    if (tok[0] !== '<') {
      stack[stack.length - 1].children.push(decodeEntities(tok));
      continue;
    }
    if (tok[1] === '?' || tok[1] === '!') continue;
    if (tok[1] === '/') {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const selfClosing = tok.endsWith('/>');
    const inner = tok.slice(1, selfClosing ? -2 : -1).trim();
    const sp = inner.search(/\s/);
    const node = {
      tag: sp < 0 ? inner : inner.slice(0, sp),
      attrs: sp < 0 ? '' : inner.slice(sp + 1),
      children: [],
    };
    stack[stack.length - 1].children.push(node);
    if (!selfClosing) stack.push(node);
  }
  return root;
}

export function xmlAttr(node, name) {
  if (!node || !node.attrs) return null;
  const re = new RegExp(`(?:^|\\s)${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}="([^"]*)"`);
  const found = re.exec(node.attrs);
  return found ? decodeEntities(found[1]) : null;
}

function decodeEntities(s) {
  if (s.indexOf('&') < 0) return s;
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, ent) => {
    if (ent[0] === '#') {
      const code = ent[1] === 'x' || ent[1] === 'X'
        ? parseInt(ent.slice(2), 16)
        : parseInt(ent.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[ent] || m;
  });
}

const isElem = (c) => typeof c !== 'string';

function firstKid(node, tag) {
  for (const c of node.children) if (isElem(c) && c.tag === tag) return c;
  return null;
}

function findFirstDeep(node, tag) {
  for (const c of node.children) {
    if (!isElem(c)) continue;
    if (c.tag === tag) return c;
    const found = findFirstDeep(c, tag);
    if (found) return found;
  }
  return null;
}

function* findAllDeep(node, tag) {
  for (const c of node.children) {
    if (!isElem(c)) continue;
    if (c.tag === tag) yield c;
    else yield* findAllDeep(c, tag);
  }
}

function textContent(node) {
  let out = '';
  for (const c of node.children) {
    if (typeof c === 'string') out += c;
    else out += textContent(c);
  }
  return out;
}

// ─── OMML math → readable linear text ─────────────────────────────────────────
// pdfjs hands a printed equation back as layout noise (the fraction bar is a
// run of underscores, the numerator lands beside its denominator — DO072).
// OMML is the equation's STRUCTURE, so a linear rendering is possible:
// fractions as (num)/(den), sub/superscripts as _x and ^x, radicals as √(…).
// What a result CARD shows is still governed by the query-time formula guard;
// this is about the index seeing real content instead of underscore soup.

export function linearizeOmml(node) {
  let out = '';
  for (const c of node.children) {
    if (!isElem(c)) continue;
    switch (c.tag) {
      case 'm:t':
        out += textContent(c);
        break;
      case 'm:f': {
        const num = firstKid(c, 'm:num');
        const den = firstKid(c, 'm:den');
        out += `(${num ? linearizeOmml(num) : ''})/(${den ? linearizeOmml(den) : ''})`;
        break;
      }
      case 'm:sSub': {
        const base = firstKid(c, 'm:e');
        const sub = firstKid(c, 'm:sub');
        out += `${base ? linearizeOmml(base) : ''}_${sub ? linearizeOmml(sub) : ''}`;
        break;
      }
      case 'm:sSup': {
        const base = firstKid(c, 'm:e');
        const sup = firstKid(c, 'm:sup');
        out += `${base ? linearizeOmml(base) : ''}^${sup ? linearizeOmml(sup) : ''}`;
        break;
      }
      case 'm:sSubSup': {
        const base = firstKid(c, 'm:e');
        const sub = firstKid(c, 'm:sub');
        const sup = firstKid(c, 'm:sup');
        out += `${base ? linearizeOmml(base) : ''}_${sub ? linearizeOmml(sub) : ''}^${sup ? linearizeOmml(sup) : ''}`;
        break;
      }
      case 'm:rad': {
        const e = firstKid(c, 'm:e');
        out += `√(${e ? linearizeOmml(e) : ''})`;
        break;
      }
      case 'm:d': {
        const inner = c.children.filter(k => isElem(k) && k.tag === 'm:e').map(linearizeOmml);
        out += `(${inner.join(', ')})`;
        break;
      }
      default:
        // Property containers carry no content text; everything else recurses.
        if (!/Pr$/.test(c.tag)) out += linearizeOmml(c);
    }
  }
  return out;
}

// ─── Paragraph text ───────────────────────────────────────────────────────────

function paragraphText(p) {
  let out = '';
  const visit = (node) => {
    for (const c of node.children) {
      if (!isElem(c)) continue;
      switch (c.tag) {
        case 'w:t': out += textContent(c); break;
        case 'w:tab': out += ' '; break;
        case 'w:br':
        case 'w:cr': out += ' '; break;
        case 'w:noBreakHyphen': out += '-'; break;
        case 'm:oMath':
        case 'm:oMathPara': out += ` ${linearizeOmml(c).replace(/\s+/g, ' ').trim()} `; break;
        // Field CODES (PAGEREF, TOC, SEQ…) are instructions, not content — the
        // field RESULT arrives as ordinary w:t runs and is kept.
        case 'w:instrText': break;
        // Never in an accepted-changes document, but never index either way.
        case 'w:delText': break;
        // Properties, notes and embedded objects carry no body prose.
        case 'w:pPr':
        case 'w:rPr':
        case 'w:footnoteReference':
        case 'w:endnoteReference':
        case 'w:commentReference':
        case 'w:drawing':
        case 'w:pict':
        case 'w:object': break;
        default: visit(c);
      }
    }
  };
  visit(p);
  return out.replace(/\s+/g, ' ').trim();
}

// ─── Styles / headings ────────────────────────────────────────────────────────

function parseStyles(stylesXml) {
  const map = new Map();
  if (!stylesXml) return map;
  const root = parseXml(stylesXml);
  for (const style of findAllDeep(root, 'w:style')) {
    if (xmlAttr(style, 'w:type') !== 'paragraph') continue;
    const id = xmlAttr(style, 'w:styleId');
    if (!id) continue;
    const pPr = firstKid(style, 'w:pPr');
    const lvl = pPr ? xmlAttr(firstKid(pPr, 'w:outlineLvl') || {}, 'w:val') : null;
    map.set(id, {
      name: xmlAttr(firstKid(style, 'w:name') || {}, 'w:val') || '',
      basedOn: xmlAttr(firstKid(style, 'w:basedOn') || {}, 'w:val') || null,
      outlineLvl: lvl != null ? parseInt(lvl, 10) : null,
    });
  }
  return map;
}

function paragraphStyleId(p) {
  const pPr = firstKid(p, 'w:pPr');
  return pPr ? xmlAttr(firstKid(pPr, 'w:pStyle') || {}, 'w:val') : null;
}

/** 1-based heading level, or 0 when the paragraph is not a heading. */
function headingLevelOf(p, styles) {
  const pPr = firstKid(p, 'w:pPr');
  if (pPr) {
    const direct = xmlAttr(firstKid(pPr, 'w:outlineLvl') || {}, 'w:val');
    if (direct != null) {
      const v = parseInt(direct, 10);
      if (v >= 0 && v <= 8) return v + 1;
    }
  }
  let cur = paragraphStyleId(p);
  for (let depth = 0; cur && depth < 8; depth++) {
    const s = styles.get(cur);
    const label = `${cur} ${s ? s.name : ''}`;
    const named = /(?:^|\s)heading\s*([1-9])\b/i.exec(label);
    if (named) return parseInt(named[1], 10);
    if (s && s.outlineLvl != null && s.outlineLvl <= 8) return s.outlineLvl + 1;
    cur = s ? s.basedOn : null;
  }
  return 0;
}

function paragraphHasNumbering(p) {
  const pPr = firstKid(p, 'w:pPr');
  return !!(pPr && firstKid(pPr, 'w:numPr'));
}

/** Word's ToC lives in the body (usually inside an SDT) styled TOC1…TOC9 —
 *  indexing it would duplicate every heading as body prose. */
function isTocParagraph(p, styles) {
  const id = paragraphStyleId(p);
  if (!id) return false;
  if (/^TOC/i.test(id)) return true;
  const s = styles.get(id);
  return !!(s && /^toc\b|table of contents/i.test(s.name));
}

// ─── Tables ───────────────────────────────────────────────────────────────────

function tableRows(tbl, styles) {
  const rows = [];
  for (const tr of tbl.children) {
    if (!isElem(tr) || tr.tag !== 'w:tr') continue;
    const cells = [];
    for (const tc of tr.children) {
      if (!isElem(tc) || tc.tag !== 'w:tc') continue;
      const parts = [];
      for (const block of blockChildren(tc)) {
        if (block.tag === 'w:p') {
          const t = paragraphText(block);
          if (t) parts.push(t);
        } else if (block.tag === 'w:tbl') {
          rows.push(...tableRows(block, styles)); // nested table: flatten
        }
      }
      if (parts.length) cells.push(parts.join(' '));
    }
    if (cells.length) rows.push(cells.join('  '));
  }
  return rows;
}

/** Body-level blocks (w:p / w:tbl), descending through structured-document-tag
 *  and customXml wrappers — Word puts the ToC and content controls in those. */
function* blockChildren(node) {
  for (const c of node.children) {
    if (!isElem(c)) continue;
    if (c.tag === 'w:p' || c.tag === 'w:tbl') yield c;
    else if (c.tag === 'w:sdt' || c.tag === 'w:sdtContent' || c.tag === 'w:customXml' || c.tag === 'w:smartTag') {
      yield* blockChildren(c);
    }
  }
}

// ─── Main extraction ──────────────────────────────────────────────────────────

const countWords = (t) => t.split(/\s+/).filter(Boolean).length;

function lastWords(text, n) {
  const words = text.split(/\s+/).filter(Boolean);
  return words.slice(Math.max(0, words.length - n)).join(' ');
}

/**
 * @param {Uint8Array|ArrayBuffer} bytes - the .docx file
 * @param {object} [options] - chunk sizing overrides (tests only)
 * @returns {Promise<{
 *   designation: string|null, coreTitle: string,
 *   chunks: Array<{text, section, type, wordCount}>,        // NO pageNumber
 *   outline: Array<{number, title, level}>,                 // NO page
 *   sections: Record<string, string>,
 *   assets: Array<{kind, label, caption}>,                  // NO page
 *   stats: { paragraphs, headings, tables, referenceEntries, numbering },
 * }>}
 */
export async function extractDocx(bytes, options = {}) {
  const cfg = { ...DEFAULTS, ...options };
  const parts = await unzipDocx(bytes);

  const docPart = parts.get('word/document.xml');
  if (!docPart) throw new Error('No word/document.xml inside the archive — this is not a Word .docx');
  const documentXml = new TextDecoder().decode(docPart);

  // Refused, never resolved: taking either side of an unaccepted revision is
  // indexing text nobody approved (design rule 2 in docs/DOCX_INGEST.md).
  if (/<w:(?:ins|del)[\s/>]/.test(documentXml)) {
    throw new Error('The manuscript contains unaccepted tracked changes — in Word choose Review → Accept All Changes, save, and upload it again.');
  }

  const styles = parseStyles(parts.has('word/styles.xml')
    ? new TextDecoder().decode(parts.get('word/styles.xml')) : null);

  let coreTitle = '';
  if (parts.has('docProps/core.xml')) {
    const core = new TextDecoder().decode(parts.get('docProps/core.xml'));
    const m = /<dc:title>([^<]*)<\/dc:title>/.exec(core);
    if (m) coreTitle = decodeEntities(m[1]).trim();
  }

  const root = parseXml(documentXml);
  const body = findFirstDeep(root, 'w:body');
  if (!body) throw new Error('word/document.xml carries no w:body');

  const chunks = [];
  const outline = [];
  const sections = {};
  const assets = [];
  const assetSeen = new Set();
  const stats = { paragraphs: 0, headings: 0, tables: 0, referenceEntries: 0, numbering: 'none' };
  let designation = null;

  // Multilevel counters approximate Word's auto-numbering when a heading
  // carries w:numPr but no literal number in its text. A LITERAL number always
  // resets them, so mixed documents stay consistent.
  const counters = new Array(9).fill(0);
  const noteNumbering = (kind) => {
    if (stats.numbering === 'none') stats.numbering = kind;
    else if (stats.numbering !== kind) stats.numbering = 'mixed';
  };

  let currentSection = null;
  let inReferences = false;
  let buffer = [];
  let bufferWords = 0;
  const refEntries = [];

  const flushBody = () => {
    if (bufferWords >= cfg.minWords) {
      const text = buffer.join('\n').trim();
      chunks.push({ text, section: currentSection, type: 'text', wordCount: countWords(text) });
    }
    buffer = [];
    bufferWords = 0;
  };

  const flushReferences = () => {
    for (const text of refEntries) {
      const words = countWords(text);
      // Same acceptance rule as the PDF chunker (client DO26.1): only formal
      // references enter the reference index; anything else stays body prose.
      if (words >= cfg.minReferenceWords && looksLikeFormalReference(text)) {
        chunks.push({ text, section: currentSection || 'References', type: 'reference', wordCount: words });
        stats.referenceEntries++;
      } else if (words >= cfg.minWords) {
        chunks.push({ text, section: currentSection || 'References', type: 'text', wordCount: words });
      }
    }
    refEntries.length = 0;
  };

  const pushBodyText = (text) => {
    const words = countWords(text);
    if (!words) return;
    buffer.push(text);
    bufferWords += words;
    if (bufferWords >= cfg.targetWords) {
      const flushedText = buffer.join('\n').trim();
      chunks.push({ text: flushedText, section: currentSection, type: 'text', wordCount: bufferWords });
      // Overlap carry-over with the same continuation marker the PDF chunker
      // prepends, so downstream (and the aligner, which strips it) see one form.
      const carry = lastWords(flushedText, cfg.overlapWords);
      buffer = currentSection ? [`[Section ${currentSection}]`, carry] : [carry];
      bufferWords = countWords(carry);
    }
  };

  const parseHeading = (text, level, hasNumPr) => {
    const annex = ANNEX_HEADING_RE.exec(text);
    if (annex) {
      noteNumbering('literal');
      const word = annex[1][0].toUpperCase() + annex[1].slice(1).toLowerCase();
      return { number: `${word} ${annex[2].toUpperCase()}`, title: annex[3].trim() };
    }
    const literal = LITERAL_NUMBER_RE.exec(text);
    if (literal) {
      const number = literal[1];
      const firstComponent = parseInt(number, 10);
      // "2026 Compliance Deadlines" is a title, not section 2026 — a number the
      // document cannot have printed is refused, the trustedSectionLabel rule.
      if (!Number.isFinite(firstComponent) || firstComponent < 100) {
        noteNumbering('literal');
        if (/^\d/.test(number)) {
          const comps = number.split('.').map(n => parseInt(n, 10));
          for (let i = 0; i < counters.length; i++) counters[i] = i < comps.length ? comps[i] : 0;
        }
        return { number, title: literal[2].trim() };
      }
    }
    if (hasNumPr && level >= 1 && level <= 9) {
      // Word numbers this heading itself; the counters approximate the printed
      // number. If an ancestor level never appeared, refuse rather than invent.
      if (level > 1 && counters[level - 2] === 0) return { number: null, title: text };
      counters[level - 1]++;
      for (let i = level; i < counters.length; i++) counters[i] = 0;
      noteNumbering('synthesized');
      return { number: counters.slice(0, level).join('.'), title: text };
    }
    return { number: null, title: text };
  };

  const onHeading = (text, level, hasNumPr) => {
    if (inReferences) flushReferences();
    flushBody();
    stats.headings++;

    const head = parseHeading(text, level, hasNumPr);
    // An unnumbered heading ("Introduction", a foreword) opens content that
    // belongs to NO numbered section — better a card with no locator than one
    // wearing the previous section's number (DO071).
    currentSection = head.number;
    if (head.number && head.title && /^[A-Z(]/.test(head.title) && !sections[head.number]) {
      sections[head.number] = head.title;
      outline.push({ number: head.number, title: head.title, level });
    }

    inReferences = REFERENCES_HEADING_RE.test(text.trim());
    if (!inReferences) pushBodyText(text);
  };

  const onTable = (tbl) => {
    if (!inReferences) flushBody();
    stats.tables++;
    const rows = tableRows(tbl, styles);
    let cur = [];
    let words = 0;
    const flushTable = () => {
      if (words >= cfg.minWords) {
        const text = cur.join('\n').trim();
        chunks.push({ text, section: currentSection, type: 'table', wordCount: countWords(text) });
      }
      cur = [];
      words = 0;
    };
    for (const row of rows) {
      cur.push(row);
      words += countWords(row);
      if (words >= cfg.targetWords * 2) flushTable();
    }
    flushTable();
  };

  for (const block of blockChildren(body)) {
    if (block.tag === 'w:tbl') {
      onTable(block);
      continue;
    }
    if (isTocParagraph(block, styles)) continue;

    const text = paragraphText(block);
    if (!text) continue;
    stats.paragraphs++;

    if (!designation) {
      const d = DESIGNATION_RE.exec(text);
      if (d) designation = d[0];
    }

    const cap = parseCaptionLine(text);
    if (cap && !assetSeen.has(`${cap.kind}|${cap.label}`)) {
      assetSeen.add(`${cap.kind}|${cap.label}`);
      assets.push(cap);
    }

    const level = headingLevelOf(block, styles);
    if (level >= 1 && text.length <= 200) {
      onHeading(text, level, paragraphHasNumbering(block));
    } else if (inReferences) {
      refEntries.push(text);
    } else {
      pushBodyText(text);
    }
  }
  if (inReferences) flushReferences();
  flushBody();

  if (!designation && coreTitle) {
    const d = DESIGNATION_RE.exec(coreTitle);
    if (d) designation = d[0];
  }

  return { designation, coreTitle, chunks, outline, sections, assets, stats };
}
