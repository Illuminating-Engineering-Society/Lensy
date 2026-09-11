/**
 * DOCX test-fixture builders — imported ONLY by tests (docx-extract.test.js,
 * staff-ingest.test.js). Never shipped in a request path.
 *
 * Entries are STORED (uncompressed), so fixtures need no CompressionStream and
 * the tests run on any Node ≥ 18; real Word files use deflate, which the
 * production reader inflates via DecompressionStream('deflate-raw') in workerd.
 */

export function buildStoredZip(entries) {
  const enc = new TextEncoder();
  const files = Object.entries(entries).map(([name, content]) => ({
    name: enc.encode(name),
    data: typeof content === 'string' ? enc.encode(content) : content,
  }));

  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const f of files) {
    const local = new Uint8Array(30 + f.name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint32(18, f.data.length, true);
    lv.setUint32(22, f.data.length, true);
    lv.setUint16(26, f.name.length, true);
    local.set(f.name, 30);
    locals.push(local, f.data);

    const cen = new Uint8Array(46 + f.name.length);
    const cv = new DataView(cen.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(10, 0, true); // method: stored
    cv.setUint32(20, f.data.length, true);
    cv.setUint32(24, f.data.length, true);
    cv.setUint16(28, f.name.length, true);
    cv.setUint32(42, offset, true);
    cen.set(f.name, 46);
    centrals.push(cen);
    offset += local.length + f.data.length;
  }

  let cdSize = 0;
  for (const c of centrals) cdSize += c.length;
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);

  const all = [...locals, ...centrals, eocd];
  const total = all.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const a of all) { out.set(a, pos); pos += a.length; }
  return out;
}

export const FIXTURE_STYLES_XML = `<?xml version="1.0"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:pPr><w:outlineLvl w:val="1"/></w:pPr></w:style>
  <w:style w:type="paragraph" w:styleId="Caption"><w:name w:val="caption"/></w:style>
  <w:style w:type="paragraph" w:styleId="TOC1"><w:name w:val="toc 1"/></w:style>
</w:styles>`;

export function fixturePara(text, opts = {}) {
  const pPr = [];
  if (opts.style) pPr.push(`<w:pStyle w:val="${opts.style}"/>`);
  if (opts.outline != null) pPr.push(`<w:outlineLvl w:val="${opts.outline}"/>`);
  if (opts.numPr) pPr.push('<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>');
  return `<w:p>${pPr.length ? `<w:pPr>${pPr.join('')}</w:pPr>` : ''}` +
    `<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
}

export function fixtureDocxBytes(body, { styles = FIXTURE_STYLES_XML, core } = {}) {
  const entries = {
    'word/document.xml': `<?xml version="1.0"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
            xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math">
  <w:body>${body}</w:body>
</w:document>`,
    'word/styles.xml': styles,
  };
  if (core) {
    entries['docProps/core.xml'] =
      `<?xml version="1.0"?><cp:coreProperties xmlns:cp="x" xmlns:dc="y"><dc:title>${core}</dc:title></cp:coreProperties>`;
  }
  return buildStoredZip(entries);
}
