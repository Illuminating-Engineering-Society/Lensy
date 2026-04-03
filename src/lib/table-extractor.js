/**
 * IES Illuminance Table Extractor
 *
 * Extracts and parses illuminance recommendation tables from IES standard PDFs.
 *
 * IES Table Structure (e.g. ANSI/IES RP-9-20, Table A-1):
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ Table A-1: Illuminance Criteria                                         │ ← TABLE_HEADING
 * │                                                                         │
 * │         Application       │ H-Cat │ H-Lux │ V-Cat │ V-Lux │ Notes      │ ← COL_HEADERS (2-3 rows)
 * │ Area → Sub1 → Sub2        │       │       │       │       │            │
 * │ ────────────────────────────────────────────────────────────────────    │
 * │ Healthcare                │       │       │       │       │            │ ← DATA ROW (category)
 * │   Hospitals               │       │       │       │       │            │
 * │     Patient rooms         │  M    │  300  │  L    │  150  │            │ ← DATA ROW (application)
 * │     ICU                   │  O    │  500  │  N    │  300  │            │
 * │     Operating Room        │  P    │ 1000  │  P    │ 1000  │  Task      │
 * │                           │       │       │       │       │            │
 * │ [1] See note A-1 for...   │                                            │ ← FOOTNOTES
 * │ General Notes:            │                                            │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Extract all illuminance tables from an array of parsed pages.
 * @param {Array<{number, text, lines}>} pages - from parsePDFNode()
 * @returns {Array<IESTable>}
 *
 * IESTable: {
 *   pageNumber: number,
 *   tableId: string,          // e.g. "A-1"
 *   title: string,            // e.g. "Table A-1: Illuminance Criteria"
 *   columnHeaders: string[],
 *   rows: string[][],         // each row is an array of cell strings
 *   footnotes: string,
 *   generalNotes: string,
 * }
 */
export function extractIESTables(pages) {
  const tables = [];

  for (const page of pages) {
    const lines = getLines(page);
    const tableBlocks = findTableBlocks(lines, page.number);

    for (const block of tableBlocks) {
      const parsed = parseTableBlock(block);
      if (parsed && parsed.rows.length >= 1) {
        tables.push({ pageNumber: page.number, ...parsed });
      }
    }
  }

  return tables;
}

// ─── Table Block Detection ────────────────────────────────────────────────────

const TABLE_TITLE_RE = /^Table\s+([A-Z0-9]+-?\d*)\s*[:.]?\s*(.*)/i;
const ANNEX_TITLE_RE = /^(?:Annex|Appendix)\s+([A-Z])\s*[:.]?\s*(.*)/i;
// Column header keywords — presence identifies the header rows
const COL_KEYWORDS = [
  'illuminance', 'category', 'maintained', 'lux', 'footcandle', 'fc',
  'horizontal', 'vertical', 'task', 'uniformity', 'height', 'zone',
  'area', 'application', 'type',
];
const FOOTNOTE_START_RE = /^(?:\[?\d+\]?|\*+)\s+\w|^Note\s*\d*\s*:|^General Notes?:|^Annex\s+A/i;

function findTableBlocks(lines, pageNumber) {
  const blocks = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const isTableTitle = TABLE_TITLE_RE.test(line) || ANNEX_TITLE_RE.test(line);

    if (isTableTitle) {
      const startIdx = i;
      const endIdx = findBlockEnd(lines, i);
      blocks.push({
        lines: lines.slice(startIdx, endIdx + 1),
        startLine: startIdx,
        endLine: endIdx,
        pageNumber,
      });
      i = endIdx + 1;
    } else {
      i++;
    }
  }

  return blocks;
}

function findBlockEnd(lines, startIdx) {
  for (let i = startIdx + 3; i < lines.length; i++) {
    const line = lines[i];
    // End at next table title (at least 3 lines after this one started)
    if (TABLE_TITLE_RE.test(line) || ANNEX_TITLE_RE.test(line)) return i - 1;
    // End at a numbered section heading (e.g. "3.1 Something")
    if (/^\d+\.\d+\s+[A-Z]/.test(line) && i > startIdx + 10) return i - 1;
  }
  return lines.length - 1;
}

// ─── Table Parsing ────────────────────────────────────────────────────────────

function parseTableBlock(block) {
  const lines = block.lines;
  if (lines.length < 4) return null;

  // Extract table title (first line)
  const titleLine = lines[0];
  const titleMatch = titleLine.match(TABLE_TITLE_RE) || titleLine.match(ANNEX_TITLE_RE);
  const tableId = titleMatch ? titleMatch[1] : '';
  const tableDesc = titleMatch ? titleMatch[2] : titleLine;
  const title = `Table ${tableId}${tableDesc ? ': ' + tableDesc : ''}`.trim();

  // Find column header rows (lines containing column keywords)
  let headerEndIdx = 0;
  for (let i = 1; i < Math.min(lines.length, 10); i++) {
    const lower = lines[i].toLowerCase();
    if (COL_KEYWORDS.some(kw => lower.includes(kw))) {
      headerEndIdx = i;
    } else if (i > 1 && headerEndIdx > 0 && !COL_KEYWORDS.some(kw => lower.includes(kw))) {
      // Two consecutive non-header lines after finding headers = headers done
      break;
    }
  }

  const columnHeaderLines = lines.slice(1, headerEndIdx + 1);
  const columnHeaders = columnHeaderLines.map(l => l.trim()).filter(Boolean);

  // Find footnote start
  const footnoteStartIdx = lines.findIndex(
    (l, idx) => idx > headerEndIdx + 1 && FOOTNOTE_START_RE.test(l)
  );
  const dataEnd = footnoteStartIdx >= 0 ? footnoteStartIdx : lines.length;

  // Parse data rows
  const dataLines = lines.slice(headerEndIdx + 1, dataEnd);
  const rows = parseDataRows(dataLines);

  // Extract footnotes and general notes
  const footnoteLines = footnoteStartIdx >= 0 ? lines.slice(footnoteStartIdx) : [];
  const footnotes = footnoteLines.join('\n').trim();
  const generalNotesMatch = footnotes.match(/(?:General Notes?|Annex\s+A)[\s\S]*/i);
  const generalNotes = generalNotesMatch ? generalNotesMatch[0].trim() : '';

  return {
    tableId,
    title,
    columnHeaders,
    rows,
    footnotes,
    generalNotes,
  };
}

/**
 * Parse data rows from the table body.
 * IES tables use 2+ spaces as column separator and may have
 * hierarchical rows (category rows vs. leaf application rows).
 */
function parseDataRows(lines) {
  const rows = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Split by 2+ spaces (IES column separator pattern)
    const cells = splitTableRow(trimmed);
    if (cells.length >= 2) {
      rows.push(cells);
    } else if (cells.length === 1 && trimmed.length > 3) {
      // Single-cell row = category/section header row in table
      rows.push([trimmed]);
    }
  }

  return rows;
}

/**
 * Split a table row into cells.
 * IES tables use 2+ spaces as the column delimiter, but application names
 * may contain single spaces. This function handles that correctly.
 */
function splitTableRow(line) {
  // Try splitting by 2+ spaces first
  const bySpacer = line.split(/\s{2,}/).map(c => c.trim()).filter(Boolean);
  if (bySpacer.length >= 2) return bySpacer;

  // Fallback: try tab split
  const byTab = line.split('\t').map(c => c.trim()).filter(Boolean);
  if (byTab.length >= 2) return byTab;

  // Single column
  return [line.trim()];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getLines(page) {
  if (page.lines && page.lines.length > 0) {
    return page.lines.map(l => l.text);
  }
  return page.text.split('\n');
}
