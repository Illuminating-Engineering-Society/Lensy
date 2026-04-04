/**
 * IES Applications Extractor
 *
 * Converts raw IES illuminance table data (from table-extractor.js)
 * into structured application records matching the D1 applications schema.
 *
 * This is the core of the "PDFs as source of truth" architecture:
 * as IES publishes updated standards, re-ingesting the PDF automatically
 * updates the applications table without manual CSV maintenance.
 *
 * ─── How IES Tables Are Structured ────────────────────────────────────────────
 *
 * IES illuminance tables (e.g. Table A-1 in RP-9-20) follow a consistent pattern:
 *
 *   COLUMN HEADERS (2-4 rows):
 *     Row 1: "Application | Horizontal Illuminance | Vertical Illuminance | Notes"
 *     Row 2: "            | Category | Maintained  | Category | Maintained |      "
 *     Row 3: "            | (lux)    | (fc)        | (lux)    | (fc)       |      "
 *
 *   DATA ROWS (hierarchical):
 *     "Healthcare"                               ← category row (depth 0)
 *       "Hospitals and Ambulatory Care"          ← sub-category row (depth 1)
 *         "Patient rooms"    M  300  30  L  150  ← leaf row with data (depth 2+)
 *         "ICU"              O  500  50  N  300
 *         "Operating room"   P 1000 100  P 1000
 *       "Nursing Homes"                          ← sub-category row (depth 1)
 *         "Resident rooms"   L   75   7  K   50
 *
 * The hierarchy depth is determined by indentation level in the PDF text.
 * We track it by monitoring which rows have numeric values vs. which are text-only.
 *
 * ─── Column Mapping ────────────────────────────────────────────────────────────
 *
 * Different IES standards have slightly different column arrangements, but
 * we can identify column purposes from the header text keywords:
 *   - "Category" / "Cat" → illuminance category (letter A-P)
 *   - "Maintained" / "Target" / "lux" → illuminance value in lux
 *   - "fc" / "footcandle" → illuminance in footcandles
 *   - "Horizontal" / "H." → horizontal illuminance block
 *   - "Vertical" / "V." → vertical illuminance block
 *   - "Task" → task illuminance block
 *   - "Height" / "m" / "ft" → measurement height
 *   - "Uniformity" → uniformity ratio
 *   - "Notes" / "Footnote" → notes column
 *   - "Type" / "Area" / "Task" → area-or-task classification
 *
 * ─── Output ────────────────────────────────────────────────────────────────────
 *
 * Each extracted record matches the 68-column D1 applications table.
 * Fields not extractable from the PDF are set to null and can be enriched
 * via sync-metadata.js (Vitrium links) or manual review.
 */

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Extract application records from all tables in a standard.
 *
 * @param {Array} tables        - From extractIESTables()
 * @param {string} standardId   - e.g. "RP-9-20"
 * @param {Object} standardMeta - { fullDesignation, year, author }
 * @returns {Array<ApplicationRecord>}
 */
export function extractApplicationsFromTables(tables, standardId, standardMeta = {}) {
  const fullDesignation = standardMeta.fullDesignation || `ANSI/IES ${standardId}`;
  const allApplications = [];

  for (const table of tables) {
    const colMap = buildColumnMap(table.columnHeaders || []);
    if (!colMap.hasData) {
      // Not an illuminance table — skip (e.g. bibliography, figure list)
      continue;
    }

    const records = extractFromTable(table, colMap, standardId, fullDesignation);
    allApplications.push(...records);
  }

  // Deduplicate by generated code (same app may span page breaks)
  return deduplicate(allApplications);
}

// ─── Column Map Builder ───────────────────────────────────────────────────────

/**
 * Analyze column header rows to determine what each column position contains.
 *
 * Column headers are multi-row and need to be "projected" per-column:
 *   Col 0 = everything from the leftmost header segments
 *   Col 1 = everything above column 1 in all header rows
 *   etc.
 *
 * We tokenize each header row into cells (2+ space separator) and build
 * a "column fingerprint" — the concatenated header text for each column.
 * Then we pattern-match fingerprints against known field types.
 */
function buildColumnMap(headerLines) {
  // Flatten: split each header line into cells
  const headerGrid = headerLines.map(line =>
    line.split(/\s{2,}/).map(c => c.trim().toLowerCase()).filter(Boolean)
  ).filter(row => row.length > 0);

  if (headerGrid.length === 0) return { hasData: false };

  // Determine the approximate number of columns from the widest header row
  const maxCols = Math.max(...headerGrid.map(r => r.length));
  if (maxCols < 2) return { hasData: false };

  // Build column fingerprints by collecting header text per column position
  const fingerprints = [];
  for (let col = 0; col < maxCols; col++) {
    const texts = headerGrid
      .map(row => row[Math.min(col, row.length - 1)])
      .filter(Boolean)
      .join(' ');
    fingerprints.push(texts);
  }

  // Identify the column range for application name (first col, always text-heavy)
  const appCol = 0;

  // Now identify illuminance columns by scanning fingerprints
  const horBlock = findIlluminanceBlock(fingerprints, ['horizontal', 'horiz', 'h.', 'h ']);
  const verBlock = findIlluminanceBlock(fingerprints, ['vertical', 'vert', 'v.', 'v ']);
  const taskBlock = findIlluminanceBlock(fingerprints, ['task', 'task ']);

  // If no horizontal block found by name, fall back to positional heuristic:
  // First numeric column group = horizontal, second = vertical
  const numericStart = fingerprints.findIndex((fp, i) =>
    i > 0 && (fp.includes('cat') || fp.includes('lux') || fp.includes('fc') || fp.includes('maintain'))
  );

  const colMap = {
    hasData: numericStart >= 0 || horBlock.catCol !== null,
    appCol,
    // Horizontal illuminance
    horCatCol: horBlock.catCol ?? (numericStart >= 0 ? numericStart : null),
    horLuxCol: horBlock.luxCol ?? (numericStart >= 0 ? numericStart + 1 : null),
    horFcCol:  horBlock.fcCol  ?? (numericStart >= 0 ? numericStart + 2 : null),
    horHtCol:  horBlock.htCol  ?? null,
    horUnifCol: horBlock.unifCol ?? null,
    // Vertical illuminance
    verCatCol: verBlock.catCol,
    verLuxCol: verBlock.luxCol,
    verFcCol:  verBlock.fcCol,
    verHtCol:  verBlock.htCol,
    verUnifCol: verBlock.unifCol,
    // Task illuminance
    taskCatCol: taskBlock.catCol,
    taskLuxCol: taskBlock.luxCol,
    taskFcCol:  taskBlock.fcCol,
    // Misc
    notesCol: findColByKeyword(fingerprints, ['note', 'footnote']),
    typeCol:  findColByKeyword(fingerprints, ['type', 'area/task']),
    tmCol:    findColByKeyword(fingerprints, ['tm-24', 'tm24', 'spectral']),
    totalCols: maxCols,
  };

  return colMap;
}

function findIlluminanceBlock(fingerprints, nameKeywords) {
  // Find the starting column of an illuminance block by its heading keyword
  const blockStart = fingerprints.findIndex(fp =>
    nameKeywords.some(kw => fp.includes(kw))
  );
  if (blockStart < 0) return { catCol: null, luxCol: null, fcCol: null, htCol: null, unifCol: null };

  // Within the block, find specific sub-columns
  const blockFPs = fingerprints.slice(blockStart, blockStart + 6);
  const offset = (kws) => blockFPs.findIndex(fp => kws.some(kw => fp.includes(kw)));

  return {
    catCol:  blockStart + Math.max(0, offset(['cat', 'categ', 'class'])),
    luxCol:  blockStart + Math.max(0, offset(['lux', 'maintain', 'target', 'illum'])),
    fcCol:   blockStart + (offset(['fc', 'footcandle', 'foot-candle']) >= 0 ? offset(['fc', 'footcandle']) : -1),
    htCol:   blockStart + (offset(['height', 'elev', 'meter', 'm)']) >= 0 ? offset(['height', 'elev']) : -1),
    unifCol: blockStart + (offset(['uniform', 'ratio']) >= 0 ? offset(['uniform', 'ratio']) : -1),
  };
}

function findColByKeyword(fingerprints, keywords) {
  const idx = fingerprints.findIndex(fp => keywords.some(kw => fp.includes(kw)));
  return idx >= 0 ? idx : null;
}

// ─── Table Row Extraction ─────────────────────────────────────────────────────

/**
 * Walk table rows, tracking application hierarchy and extracting leaf records.
 */
function extractFromTable(table, colMap, standardId, fullDesignation) {
  const records = [];

  // Application name hierarchy stack: [App, App_s1, App_s2, App_s3, App_s4, App_s5, App_s6]
  // Each level is null or a string. When a new name appears at a depth, it
  // replaces that level and clears all deeper levels.
  const hierarchy = [null, null, null, null, null, null, null];
  let rowIndex = 0;

  for (const rawRow of table.rows) {
    if (!rawRow || rawRow.length === 0) continue;

    const row = rawRow.map(c => (c || '').trim());
    const appName = row[colMap.appCol] || '';

    // Determine hierarchy depth from leading whitespace or indentation level
    // In the extracted text, depth is inferred by how much of the row is name-only
    const depth = inferHierarchyDepth(row, colMap);

    if (depth === null) continue; // unrecognizable row

    // Update hierarchy stack
    hierarchy[depth] = cleanAppName(appName);
    // Clear deeper levels
    for (let d = depth + 1; d < hierarchy.length; d++) hierarchy[d] = null;

    // Only emit a record if this row has actual illuminance data
    if (!hasNumericData(row, colMap)) continue;

    const horLux = parseNum(row[colMap.horLuxCol]);
    const horFc  = parseNum(row[colMap.horFcCol]);
    const verLux = parseNum(row[colMap.verLuxCol]);
    const verFc  = parseNum(row[colMap.verFcCol]);

    // Build a stable code: standardId + table + row index
    const code = buildCode(standardId, table.tableId || 'A', rowIndex);

    records.push({
      code,
      // Hierarchy
      App:    hierarchy[0] || null,
      App_s1: hierarchy[1] || null,
      App_s2: hierarchy[2] || null,
      App_s3: hierarchy[3] || null,
      App_s4: hierarchy[4] || null,
      App_s5: hierarchy[5] || null,
      App_s6: hierarchy[6] || null,
      // Standard
      Standard:      standardId,
      Standard_Full: fullDesignation,
      Table_Ref:     table.title ? table.title.split(':')[0].trim() : null,
      Row_Ref:       `Row ${rowIndex + 1}`,
      Link_Mapping:  null, // set by sync-metadata.js
      // Type
      Area_or_Task:   extractAreaOrTask(row, colMap),
      Indoor_Outdoor: inferIndoorOutdoor(hierarchy),
      App_Type:       null,
      // Horizontal Illuminance
      Hor_Cat:        row[colMap.horCatCol] || null,
      Hor_Lux:        horLux,
      Hor_Fc:         horFc ?? luxToFc(horLux),
      Hor_Height_m:   parseNum(row[colMap.horHtCol]),
      Hor_Height_ft:  mToFt(parseNum(row[colMap.horHtCol])),
      Hor_Avg_Max_Min: inferAvgMaxMin(row),
      Hor_Uniformity: row[colMap.horUnifCol] || null,
      Hor_Notes:      null,
      // Vertical Illuminance
      Ver_Cat:        row[colMap.verCatCol] || null,
      Ver_Lux:        verLux,
      Ver_Fc:         verFc ?? luxToFc(verLux),
      Ver_Height_m:   parseNum(row[colMap.verHtCol]),
      Ver_Height_ft:  mToFt(parseNum(row[colMap.verHtCol])),
      Ver_Avg_Max_Min: inferAvgMaxMin(row),
      Ver_Uniformity: row[colMap.verUnifCol] || null,
      Ver_Notes:      null,
      // Task Illuminance
      Task_Cat:       row[colMap.taskCatCol] || null,
      Task_Lux:       parseNum(row[colMap.taskLuxCol]),
      Task_Fc:        parseNum(row[colMap.taskFcCol]),
      Task_Height_m:  null,
      Task_Height_ft: null,
      Task_Avg_Max_Min: null,
      Task_Uniformity: null,
      Task_Notes:     null,
      // TM-24
      TM24_Eligible:  row[colMap.tmCol] ? 1 : 0,
      TM24_Notes:     null,
      // Outdoor (populated for outdoor applications via post-processing)
      Lighting_Zone:     null,
      Max_Glare_Rating:  null,
      Max_Uplight:       null,
      Curfew_Dimming:    null,
      Spectrum_Guidance: null,
      Controls_Required: null,
      // Notes
      Footnotes:    extractFootnoteRefs(appName),
      General_Notes: null,
      App_Notes:    row[colMap.notesCol] || null,
      // Vitrium (filled by sync-metadata.js)
      Vitrium_Doc_ID:   null,
      Vitrium_Deep_Link: null,
      // Status
      Active:       1,
      Deprecated_By: null,
    });

    rowIndex++;
  }

  return records;
}

// ─── Hierarchy Depth Inference ────────────────────────────────────────────────

/**
 * Determine the hierarchy depth of a table row.
 *
 * IES tables have 3-4 levels of nesting in the application column:
 *   Depth 0: Top-level category (e.g. "Healthcare")
 *   Depth 1: Sub-category (e.g. "Hospitals and Ambulatory Care")
 *   Depth 2: Application (e.g. "Patient rooms") ← usually has data
 *   Depth 3+: Sub-application (e.g. "General", "Emergency", "Recovery")
 *
 * In extracted text, depth is typically indicated by:
 *   - Leading spaces in the original PDF (lost in extraction)
 *   - The PRESENCE of numeric data (deeper rows have values; category rows don't)
 *   - The number of non-empty cells (category rows often have only 1 non-empty cell)
 *
 * Strategy: use column fill ratio to infer depth
 *   - All-text row with 1 non-empty cell → category header
 *   - 1 text cell + several numeric cells → leaf application (depth 2-3)
 */
function inferHierarchyDepth(row, colMap) {
  const appName = (row[colMap.appCol] || '').trim();
  if (!appName) return null; // blank row

  const numericCols = countNumericCells(row, colMap);

  if (numericCols === 0) {
    // Text-only row — determine depth from category stack context
    // We can't always tell depth 0 from depth 1 purely from text,
    // so we use a simple heuristic: shorter names tend to be higher-level
    if (appName.length <= 25 && !appName.includes(' and ') && !appName.includes(',')) {
      return 0;
    }
    return 1;
  }

  if (numericCols >= 1) {
    // Has data — this is a leaf application row
    // Try to infer sub-depth from number of filled cells
    return 2;
  }

  return null;
}

function countNumericCells(row, colMap) {
  const numericColIndices = [
    colMap.horLuxCol, colMap.horFcCol, colMap.verLuxCol, colMap.verFcCol,
    colMap.taskLuxCol, colMap.taskFcCol,
  ].filter(c => c !== null && c !== undefined);

  return numericColIndices.filter(col => {
    const val = row[col];
    return val && /^\d/.test(val.trim());
  }).length;
}

function hasNumericData(row, colMap) {
  return countNumericCells(row, colMap) > 0;
}

// ─── Field Parsers ────────────────────────────────────────────────────────────

function parseNum(val) {
  if (val === null || val === undefined || val === '') return null;
  const str = String(val).replace(/[^\d.]/g, '');
  const n = parseFloat(str);
  return isNaN(n) ? null : n;
}

function luxToFc(lux) {
  if (lux === null || lux === undefined) return null;
  return Math.round(lux / 10.764 * 10) / 10;
}

function mToFt(m) {
  if (m === null || m === undefined) return null;
  return Math.round(m * 3.28084 * 10) / 10;
}

function cleanAppName(name) {
  // Remove footnote markers (superscript numbers/letters in extracted text)
  return name.replace(/\s*[¹²³⁴⁵⁶⁷⁸⁹⁰]+$/, '')
             .replace(/\s+\d+$/, '')   // trailing digit (footnote ref)
             .replace(/\s*\([a-z]\)$/, '') // trailing (a), (b), (c)
             .trim();
}

function extractFootnoteRefs(text) {
  const matches = text.match(/[¹²³⁴⁵⁶⁷⁸⁹⁰]+|\[\d+\]|\(\d+\)/g);
  if (!matches) return null;
  return matches.join(', ');
}

function extractAreaOrTask(row, colMap) {
  if (colMap.typeCol !== null && row[colMap.typeCol]) {
    const val = row[colMap.typeCol].toLowerCase();
    if (val.includes('task')) return 'Task';
    if (val.includes('area')) return 'Area';
  }
  // Heuristic: if there's task illuminance data, it's likely a task application
  if (colMap.taskLuxCol !== null && parseNum(row[colMap.taskLuxCol]) !== null) {
    return 'Task';
  }
  return 'Area';
}

/**
 * Infer Indoor/Outdoor from application hierarchy.
 * IES standards typically separate indoor and outdoor in their table structure.
 * Keywords in the hierarchy path signal the environment type.
 */
function inferIndoorOutdoor(hierarchy) {
  const fullPath = hierarchy.filter(Boolean).join(' ').toLowerCase();

  const outdoorKeywords = [
    'outdoor', 'exterior', 'parking lot', 'roadway', 'street',
    'athletic field', 'sports field', 'stadium', 'amphitheater',
    'pedestrian', 'walkway', 'plaza', 'park', 'landscape',
  ];
  const indoorKeywords = [
    'indoor', 'interior', 'office', 'hospital', 'retail', 'school',
    'industrial', 'warehouse', 'residential', 'hotel',
  ];

  if (outdoorKeywords.some(kw => fullPath.includes(kw))) return 'Outdoor';
  if (indoorKeywords.some(kw => fullPath.includes(kw))) return 'Indoor';
  return 'Indoor'; // IES tables default to indoor if ambiguous
}

function inferAvgMaxMin(row) {
  // Most IES illuminance values are "Average" (maintained average)
  const rowText = row.join(' ').toLowerCase();
  if (rowText.includes('max')) return 'Max';
  if (rowText.includes('min')) return 'Min';
  return 'Average';
}

// ─── Code Generation ──────────────────────────────────────────────────────────

/**
 * Generate a stable, unique code for each application record.
 * Format: STANDARDID_TABLEID_ROWINDEX (e.g. "RP-9-20_A-1_045")
 */
function buildCode(standardId, tableId, rowIndex) {
  const safeStd = standardId.replace(/[^A-Z0-9-]/gi, '').toUpperCase();
  const safeTable = (tableId || 'A').replace(/[^A-Z0-9-]/gi, '');
  const paddedRow = String(rowIndex).padStart(3, '0');
  return `${safeStd}_${safeTable}_${paddedRow}`;
}

// ─── Deduplication ────────────────────────────────────────────────────────────

function deduplicate(records) {
  const seen = new Map();
  for (const record of records) {
    const key = record.code;
    if (!seen.has(key)) {
      seen.set(key, record);
    }
  }
  return [...seen.values()];
}

// ─── Quality Report ───────────────────────────────────────────────────────────

/**
 * Produce a simple quality summary to help identify extraction issues.
 * @param {Array} records - Extracted application records
 * @returns {Object} summary stats
 */
export function reportExtractionQuality(records) {
  const total = records.length;
  const withHorLux = records.filter(r => r.Hor_Lux !== null).length;
  const withVerLux = records.filter(r => r.Ver_Lux !== null).length;
  const withCategory = records.filter(r => r.App !== null).length;
  const withCat = records.filter(r => r.Hor_Cat !== null).length;
  const missingDepth1 = records.filter(r => r.App === null).length;

  return {
    total,
    withHorLux,
    withVerLux,
    withCategory,
    withIlluminanceCategory: withCat,
    missingTopLevel: missingDepth1,
    qualityScore: total > 0
      ? Math.round((withHorLux / total) * 100)
      : 0,
    warnings: [
      ...(withHorLux < total * 0.7 ? [`Only ${withHorLux}/${total} records have horizontal lux values`] : []),
      ...(withCat < total * 0.5 ? [`Only ${withCat}/${total} records have illuminance category letters`] : []),
      ...(missingDepth1 > 0 ? [`${missingDepth1} records missing top-level App category`] : []),
    ],
  };
}
