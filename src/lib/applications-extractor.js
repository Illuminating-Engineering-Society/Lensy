/**
 * IES Applications Extractor
 *
 * Extracts structured illuminance application records from IES PDF pages.
 *
 * Uses X coordinate (indentation) from pdfjs line data to reconstruct
 * the hierarchy of IES illuminance tables, which is lost in plain text.
 *
 * IES Table A-1 structure (x=indentation, approximate):
 *   x≈69   INTERIORS - COMMON APPLICATIONS  ← section header
 *   x≈73   Administration                   ← App (depth 0)
 *   x≈78     Copy rooms, print rooms        ← App_s1 (depth 1)
 *   x≈82       GeneralAM100 @ 0.00(...)     ← data row (has illuminance)
 *   x≈82       MachinesTP300 @ TS(...)      ← data row
 *   x≈82       Printed material             ← App_s2 (no data, sub-header)
 *   x≈82         THR500 @ TS(...)           ← data row
 */

// ─── Public API ───────────────────────────────────────────────────────────────

export function extractApplicationsFromTables(_tables, _standardId, _meta) {
  return []; // legacy — use extractApplicationsFromPages instead
}

/**
 * Main entry: extract application records from parsed PDF pages.
 * Requires pages with line-level data (x, y, fontSize) from parsePDFNode().
 */
export function extractApplicationsFromPages(pages, standardId, standardMeta = {}) {
  const fullDesignation = standardMeta.fullDesignation || `ANSI/IES ${standardId}`;
  const records = [];

  // Find pages that contain illuminance table data
  const tablePages = pages.filter(p => isIlluminancePage(p));

  // Extract across all table pages, preserving hierarchy state between pages
  const allRecords = extractFromPages(tablePages, standardId, fullDesignation);
  records.push(...allRecords);

  return deduplicate(records);
}

// ─── Page Detection ───────────────────────────────────────────────────────────

function isIlluminancePage(page) {
  // Must have at least 3 lines matching the IES illuminance pattern
  const ILLUM_RE = /[A-Y]\d{2,4}\s*@\s*[\d.]+|[A-Y]\d{2,4}\s*@\s*TS/;
  const matches = (page.lines || []).filter(l => ILLUM_RE.test(l.text)).length;
  return matches >= 2;
}

// ─── Multi-Page Extractor ─────────────────────────────────────────────────────
// Processes all table pages together, preserving hierarchy state across page breaks.

function extractFromPages(tablePages, standardId, fullDesignation) {
  const records = [];

  // Compute baseX once across all table pages (leftmost non-zero x)
  const allX = tablePages.flatMap(p => (p.lines || []).map(l => l.x)).filter(x => x > 0);
  const baseX = Math.min(...allX);

  const HEADER_RE = /^(ANSI\/IES|Recommended Practice|Table A-|TS =|Veiling|Light Level|Task.*High|orMed|APPLICATION|MinRatioBasis|TargetEh|TargetEv)/i;
  const SECTION_RE = /^(INTERIORS?|EXTERIORS?)\s*[-–]?\s*(COMMON|OUTDOOR|SPECIAL)?/i;
  const DATA_RE = /[A-Y]\d{2,4}\s*@\s*[\d.TS]/;

  // Hierarchy persists across pages
  const hierarchy = { app: null, s1: null, s2: null, s3: null };
  let currentSection = 'Indoor';
  let rowIndex = 0;
  let tableRef = 'Table A-1';

  for (const page of tablePages) {
    // Update tableRef from this page if found
    const ref = detectTableRef(page.text);
    if (ref) tableRef = ref;

    for (const line of (page.lines || [])) {
      const text = line.text?.trim();
      if (!text || text.length < 2) continue;

      // Skip header/boilerplate
      if (HEADER_RE.test(text)) continue;

      // Detect section change
      if (SECTION_RE.test(text)) {
        currentSection = /EXTERIOR|OUTDOOR/i.test(text) ? 'Outdoor' : 'Indoor';
        hierarchy.app = null; hierarchy.s1 = null;
        hierarchy.s2 = null; hierarchy.s3 = null;
        continue;
      }

      const hasData = DATA_RE.test(text);
      const xDelta = line.x - baseX;

      if (!hasData) {
        const name = cleanAppName(text);
        if (name.length < 2) continue;

        if (xDelta <= 12) {
          hierarchy.app = name; hierarchy.s1 = null;
          hierarchy.s2 = null; hierarchy.s3 = null;
        } else if (xDelta <= 17) {
          hierarchy.s1 = name; hierarchy.s2 = null; hierarchy.s3 = null;
        } else if (xDelta <= 21) {
          hierarchy.s2 = name; hierarchy.s3 = null;
        } else {
          hierarchy.s3 = name;
        }
        continue;
      }

      const appName = extractAppName(text);
      const cols = parseIlluminanceRow(text);
      if (cols.length === 0) continue;

      const leafName = cleanAppName(appName);
      const hor = cols[0] || null;
      const ver = cols[1] || null;
      const code = `${standardId.replace(/[^A-Z0-9]/gi, '')}_${String(rowIndex).padStart(4, '0')}`;

      records.push({
        code,
        App:    hierarchy.app,
        App_s1: hierarchy.s1,
        App_s2: hierarchy.s2,
        App_s3: hierarchy.s3,
        App_s4: leafName || null,
        App_s5: null,
        App_s6: null,
        Standard:      standardId,
        Standard_Full: fullDesignation,
        Table_Ref:     tableRef,
        Row_Ref:       `Row ${rowIndex + 1}`,
        Link_Mapping:  null,
        Area_or_Task:  hor?.areaOrTask || 'Area',
        Indoor_Outdoor: currentSection,
        App_Type:      null,
        Hor_Cat:        hor?.cat || null,
        Hor_Lux:        hor?.lux || null,
        Hor_Fc:         hor?.fc || (hor?.lux ? luxToFc(hor.lux) : null),
        Hor_Height_m:   hor?.heightM || null,
        Hor_Height_ft:  hor?.heightFt || (hor?.heightM ? mToFt(hor.heightM) : null),
        Hor_Avg_Max_Min: hor?.basis || 'Avg',
        Hor_Uniformity: hor?.uniformity || null,
        Hor_Notes:      null,
        Ver_Cat:        ver?.cat || null,
        Ver_Lux:        ver?.lux || null,
        Ver_Fc:         ver?.fc || (ver?.lux ? luxToFc(ver.lux) : null),
        Ver_Height_m:   ver?.heightM || null,
        Ver_Height_ft:  ver?.heightFt || (ver?.heightM ? mToFt(ver.heightM) : null),
        Ver_Avg_Max_Min: ver?.basis || 'Avg',
        Ver_Uniformity: ver?.uniformity || null,
        Ver_Notes:      null,
        Task_Cat:       null, Task_Lux: null, Task_Fc: null,
        Task_Height_m:  null, Task_Height_ft: null,
        Task_Avg_Max_Min: null, Task_Uniformity: null, Task_Notes: null,
        TM24_Eligible:  0, TM24_Notes: null,
        Lighting_Zone: null, Max_Glare_Rating: null, Max_Uplight: null,
        Curfew_Dimming: null, Spectrum_Guidance: null, Controls_Required: null,
        Footnotes:     extractFootnoteRefs(appName),
        General_Notes: null, App_Notes: null,
        Vitrium_Doc_ID: null, Vitrium_Deep_Link: null,
        Active: 1,
      });

      rowIndex++;
    }
  }

  return records;
}

// ─── Row Parsers ──────────────────────────────────────────────────────────────

// Matches one IES illuminance column group:
// [A/T prefix][Cat letter][Lux]@[height_m]([Fc]@[height_ft])[Avg/Max/Min][ratio]
const ILLUM_COL_RE = /([AT]?)([A-Y])(\d+(?:\.\d+)?)\s*@\s*([\d.]+|TS)\(([\d.]+(?:\.\d+)?)\s*@\s*([\d.]+|TS)\)(?:(Avg|Max|Min)(?:[3-9]:1)?)?/g;
const SIMPLE_ILLUM_RE = /([AT]?)([A-Y])(\d{2,4})\(([\d.]+)\)/g;

function parseIlluminanceRow(line) {
  const columns = [];

  ILLUM_COL_RE.lastIndex = 0;
  let match;
  while ((match = ILLUM_COL_RE.exec(line)) !== null) {
    columns.push({
      areaOrTask: match[1] === 'T' ? 'Task' : 'Area',
      cat: match[2],
      lux: parseFloat(match[3]) || null,
      heightM: match[4] === 'TS' ? null : (parseFloat(match[4]) || null),
      fc: parseFloat(match[5]) || null,
      heightFt: match[6] === 'TS' ? null : (parseFloat(match[6]) || null),
      basis: match[7] || 'Avg',
      uniformity: null,
    });
  }

  if (columns.length > 0) return columns;

  SIMPLE_ILLUM_RE.lastIndex = 0;
  while ((match = SIMPLE_ILLUM_RE.exec(line)) !== null) {
    columns.push({
      areaOrTask: match[1] === 'T' ? 'Task' : 'Area',
      cat: match[2],
      lux: parseFloat(match[3]) || null,
      heightM: null,
      fc: parseFloat(match[4]) || null,
      heightFt: null,
      basis: 'Avg',
      uniformity: null,
    });
  }

  return columns;
}

function extractAppName(line) {
  ILLUM_COL_RE.lastIndex = 0;
  const firstMatch = ILLUM_COL_RE.exec(line);
  ILLUM_COL_RE.lastIndex = 0;
  if (firstMatch) return line.substring(0, firstMatch.index).trim();

  SIMPLE_ILLUM_RE.lastIndex = 0;
  const simpleMatch = SIMPLE_ILLUM_RE.exec(line);
  SIMPLE_ILLUM_RE.lastIndex = 0;
  if (simpleMatch) return line.substring(0, simpleMatch.index).trim();

  return line.trim();
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function detectTableRef(pageText) {
  const m = pageText?.match(/Table\s+(A-\d+)/i);
  return m ? `Table ${m[1]}` : 'Table A-1';
}

function cleanAppName(name) {
  return name
    .replace(/\s*[¹²³⁴⁵⁶⁷⁸⁹⁰]+$/, '')
    .replace(/\s+\d+$/, '')           // trailing footnote number
    .replace(/\s*\([a-z]\)$/, '')     // trailing (a), (b)
    .replace(/^[AT][A-Y]\s*/, '')     // strip leading type+category prefix
    .trim();
}

function extractFootnoteRefs(text) {
  const matches = text.match(/\d+$/);
  return matches ? matches[0] : null;
}

function luxToFc(lux) {
  return Math.round(lux / 10.764 * 10) / 10;
}

function mToFt(m) {
  return Math.round(m * 3.28084 * 10) / 10;
}

function deduplicate(records) {
  const seen = new Map();
  for (const r of records) {
    if (!seen.has(r.code)) seen.set(r.code, r);
  }
  return [...seen.values()];
}

// ─── Quality Report ───────────────────────────────────────────────────────────

export function reportExtractionQuality(records) {
  const total = records.length;
  const withHorLux = records.filter(r => r.Hor_Lux !== null).length;
  const withApp = records.filter(r => r.App !== null).length;
  const withCat = records.filter(r => r.Hor_Cat !== null).length;

  return {
    total,
    withHorLux,
    withApp,
    withIlluminanceCategory: withCat,
    qualityScore: total > 0 ? Math.round((withHorLux / total) * 100) : 0,
    warnings: [
      ...(withHorLux < total * 0.8 ? [`Only ${withHorLux}/${total} records have horizontal lux`] : []),
      ...(withApp < total * 0.5 ? [`${total - withApp} records missing App category`] : []),
    ],
  };
}
