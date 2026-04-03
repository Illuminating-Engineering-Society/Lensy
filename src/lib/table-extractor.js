/**
 * IES Illuminance Table Extractor
 * Detects and parses illuminance tables from IES standard PDFs.
 * IES tables typically follow: "Table X-N" header → multi-row header → data rows → footnotes.
 */

/**
 * Extract all illuminance tables from parsed PDF pages.
 * @param {ArrayBuffer} _pdfBytes - raw PDF (unused for text extraction, reserved for future image extraction)
 * @param {Array<{number, text}>} pages
 * @returns {Array<{pageNumber, header, rows, footnotes, generalNotes, rawText}>}
 */
export async function extractTables(_pdfBytes, pages) {
  const tables = [];

  for (const page of pages) {
    const potentialTables = detectTableStructures(page.text);

    for (const tableText of potentialTables) {
      const parsed = parseIlluminanceTable(tableText);
      if (parsed && parsed.rows.length > 0) {
        tables.push({
          pageNumber: page.number,
          header: parsed.header,
          rows: parsed.rows,
          footnotes: parsed.footnotes,
          generalNotes: parsed.generalNotes,
          rawText: tableText,
        });
      }
    }
  }

  return tables;
}

/**
 * Find table-like blocks in page text using IES-specific markers.
 */
function detectTableStructures(text) {
  const tables = [];

  // IES tables start with "Table A-1", "Table B-2", "Annex A", etc.
  const tableStartPattern = /(?:Table\s+[A-Z]-\d+|Annex\s+[A-Z]|Illuminance\s+Criteria)/gi;
  let match;

  // Find all table start positions
  const starts = [];
  while ((match = tableStartPattern.exec(text)) !== null) {
    starts.push(match.index);
  }

  // Extract from each start to the next start (or end of text)
  for (let i = 0; i < starts.length; i++) {
    const start = starts[i];
    const end = i + 1 < starts.length ? starts[i + 1] : text.length;
    const block = text.slice(start, end).trim();

    // Only include if it's substantial enough to be a real table
    if (block.length > 200 && block.split('\n').length > 5) {
      tables.push(block);
    }
  }

  return tables;
}

/**
 * Parse a single table block into structured data.
 */
function parseIlluminanceTable(tableText) {
  const lines = tableText.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length < 3) return null;

  // Find where data rows begin (after header rows)
  const headerEndIdx = findHeaderEnd(lines);
  if (headerEndIdx < 0) return null;

  const header = lines.slice(0, headerEndIdx).join('\n');

  // Find where footnotes begin
  const footnoteStartIdx = lines.findIndex((l, idx) =>
    idx > headerEndIdx && (
      l.match(/^General Notes:/i) ||
      l.match(/^\[\d+\]/) ||
      l.match(/^Note\s*\d+:/i) ||
      l.match(/^Annex\s+A/i)
    )
  );

  const dataEnd = footnoteStartIdx >= 0 ? footnoteStartIdx : lines.length;
  const dataLines = lines.slice(headerEndIdx, dataEnd);
  const rows = dataLines
    .map(parseRow)
    .filter(row => row.length >= 2);

  const footnoteLines = footnoteStartIdx >= 0 ? lines.slice(footnoteStartIdx) : [];
  const footnotes = footnoteLines.join('\n');
  const generalNotes = extractGeneralNotes(footnoteLines);

  return { header, rows, footnotes, generalNotes };
}

/**
 * Find the index of the first data row (end of header).
 * IES tables always have at least 2-3 header rows.
 */
function findHeaderEnd(lines) {
  for (let i = 2; i < lines.length; i++) {
    const line = lines[i];
    // Data rows typically: start with a number, contain lux/fc values, or match application name pattern
    if (
      /^\d+/.test(line) ||
      line.match(/\d+\s+lux/i) ||
      (i >= 3 && line.match(/^[A-Z][a-z]+.*\d+/))
    ) {
      return i;
    }
  }
  return -1;
}

/**
 * Split a data row into columns (IES tables use 2+ spaces as separator).
 */
function parseRow(rowText) {
  return rowText.split(/\s{2,}/).map(c => c.trim()).filter(Boolean);
}

/**
 * Extract Annex A general notes if present in footnotes block.
 */
function extractGeneralNotes(footnoteLines) {
  const text = footnoteLines.join('\n');
  const match = text.match(/Annex\s+A[\s\S]+/i);
  return match ? match[0].trim() : '';
}
