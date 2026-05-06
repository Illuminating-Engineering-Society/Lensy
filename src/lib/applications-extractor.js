/**
 * IES Applications Extractor — NEW TABLE STRUCTURE (260420+)
 *
 * Extracts structured illuminance application records from IES PDF pages
 * following the schema in pdfs/Others/IlluminanceTables_Reference_260421.pdf.
 *
 * The new table format (e.g. RP-43-25) is concatenation-on-a-line:
 *   "Lower limit (avg.)A50 lx @ 0.00 m5:1Avg:Min5%500 lmOff to 50%2400 K to 4000 K"
 *
 * Tokens parsed (any subset may be present per row):
 *   • Row label  : leading prose ("Lower limit (avg.)", "Spa", "Pool deck")
 *   • Area/Task  : single 'A' or 'T' character before the lux value
 *   • Hor lux    : "<n> lx @ <height> m"   (height may be "TS")
 *   • Hor fc     : "<n> fc @ <height> ft"  (older standards)
 *   • Hor cat    : "Cat <letter>"           (when present)
 *   • V lux/fc   : same patterns, second occurrence in row
 *   • Uniformity : "<n>:<n>"                e.g. 5:1
 *   • CV         : "CV <n>%"                e.g. CV 3%
 *   • Ratio basis: "Avg:Min", "Max:Avg", "Max:Min", "Max:Avg:Min"
 *   • Glare(max) : "<n>%" trailing token (or "B<n>" BUG class)
 *   • Uplight    : "<n> lm" or "U<n>"
 *   • Controls   : "Off to <n>%" / "Dim to <n>%" / "Curfew" / "Occ"
 *   • Spectrum   : "<n>K to <n>K" or "<n> K to <n> K"
 *   • Veiling    : "Veiling: L|M|H"          (when present in row)
 *   • Class      : Roman numeral I/II/III/IV (sports venues)
 *
 * Hierarchy is reconstructed from the X coordinate:
 *   The minimum X across all rows in tables is the baseline. Each ~7px
 *   increment is one hierarchy level deeper.
 *
 * lux→fc conversion: 10:1 (per reference doc, NOT 10.764).
 */

// ─── Public API ───────────────────────────────────────────────────────────────

export function extractApplicationsFromTables(_tables, _standardId, _meta) {
  return []; // legacy — use extractApplicationsFromPages instead
}

export function extractApplicationsFromPages(pages, standardId, standardMeta = {}) {
  const fullDesignation = standardMeta.fullDesignation || `ANSI/IES ${standardId}`;
  const records = [];

  const tablePages = pages.filter(isIlluminancePage);
  const allRecords = extractFromPages(tablePages, standardId, fullDesignation);
  records.push(...allRecords);

  return deduplicate(records);
}

// ─── Page Detection ───────────────────────────────────────────────────────────

/**
 * Detect a "real" table page: many short lines containing the lux/fc unit
 * tokens that appear in IES illuminance tables.
 */
function isIlluminancePage(page) {
  const lines = page.lines || [];
  if (lines.length < 10) return false;
  const dataLineRe = /\d+\s*(?:lx|lux|fc|footcandle)\b|\d+\s*lm\b/i;
  const matches = lines.filter(l => dataLineRe.test(l.text)).length;
  return matches >= 3;
}

// ─── Multi-Page Extractor ─────────────────────────────────────────────────────

function extractFromPages(tablePages, standardId, fullDesignation) {
  const records = [];

  // Compute baseline X across all candidate hierarchy lines
  // (skip page header/footer X's by ignoring lines outside the body)
  const candidateXs = tablePages.flatMap(p =>
    (p.lines || [])
      .filter(l => l.x > 50 && l.x < 250 && l.fontSize < 9)
      .map(l => l.x)
  );
  const baseX = candidateXs.length > 0 ? Math.min(...candidateXs) : 60;
  const X_STEP = 7;  // calibrated from RP-43-25 (74.6 → 81.6 → 88.4)

  // Boilerplate / header lines to skip
  const SKIP_RE = /^(?:ANSI\/IES|Recommended Practice|Recommended Illuminance|APPLICATION|Target E[hv]|Horizontal Illuminance|Vertical Illuminance|Environmental and Visual|Uniformity|TaskRatio|Lux\s*@|Fc\s*@|@\s*Height|See Notes|TS\s*=|Class of Play|Veiling Risk|Sub Category|Hierarchy|App_s)/i;

  // Recognize start of a new table (could be A-1, A-2, A-3 ...)
  // We don't reset hierarchy on new table — the IES schema treats them
  // as sub-views of the same application taxonomy.

  const hierarchy = {
    subCategory: null,   // INTERIOR/EXTERIOR or higher-level grouping
    app: null,           // App
    s1: null, s2: null, s3: null, s4: null, s5: null, s6: null,
  };
  let currentSection = inferSectionFromStandard(standardId);
  let rowIndex = 0;
  let tableRef = 'Table A-1';

  for (const page of tablePages) {
    const ref = detectTableRef(page.text);
    if (ref) tableRef = ref;

    // Detect a "Sub Category" announce line if present
    for (const line of (page.lines || [])) {
      const text = line.text?.trim();
      if (!text || text.length < 2) continue;
      if (SKIP_RE.test(text)) continue;
      if (/^Table\s+[A-Z]?-?\d/i.test(text)) continue;
      if (/^\d+$/.test(text)) continue;     // page number
      if (text.length > 200) continue;      // body prose

      const sub = detectSubCategory(text);
      if (sub) {
        currentSection = sub.indoorOutdoor;
        hierarchy.subCategory = sub.label;
        hierarchy.app = null;
        hierarchy.s1 = hierarchy.s2 = hierarchy.s3 = null;
        hierarchy.s4 = hierarchy.s5 = hierarchy.s6 = null;
        continue;
      }

      const parsed = parseDataRow(text);
      const xDelta = (line.x || baseX) - baseX;
      const depth = Math.max(0, Math.round(xDelta / X_STEP));

      if (!parsed.hasData) {
        // Pure hierarchy line — fill the slot at this depth
        const name = cleanAppName(parsed.label);
        if (name.length < 2) continue;
        applyHierarchyAtDepth(hierarchy, depth, name);
        continue;
      }

      // Data row — snapshot hierarchy with leaf, build record
      const leafName = cleanAppName(parsed.label);
      const snapshot = snapshotHierarchyWithLeaf(hierarchy, depth, leafName);

      const tm24 = isTM24EligibleCat(parsed.horCat) || isTM24EligibleCat(parsed.verCat);
      const code = `${standardId.replace(/[^A-Z0-9]/gi, '')}_${String(rowIndex).padStart(4, '0')}`;

      records.push({
        code,
        Sub_Category: snapshot.subCategory,
        App:    snapshot.app,
        App_s1: snapshot.s1,
        App_s2: snapshot.s2,
        App_s3: snapshot.s3,
        App_s4: snapshot.s4,
        App_s5: snapshot.s5,
        App_s6: snapshot.s6,
        Standard:      standardId,
        Standard_Full: fullDesignation,
        Table_Ref:     tableRef,
        Row_Ref:       `Row ${rowIndex + 1}`,
        Link_Mapping:  null,
        Area_or_Task:   parsed.areaOrTask || 'Area',
        Indoor_Outdoor: currentSection,
        App_Type:       null,
        Veiling_Risk:   parsed.veilingRisk,
        Class_of_Play:  parsed.classOfPlay,
        // Horizontal
        Hor_Cat:         parsed.horCat,
        Hor_Lux:         parsed.horLux,
        Hor_Fc:          parsed.horFc ?? (parsed.horLux != null ? luxToFc(parsed.horLux) : null),
        Hor_Height_m:    parsed.horHeightM,
        Hor_Height_ft:   parsed.horHeightFt ?? (parsed.horHeightM != null ? mToFt(parsed.horHeightM) : null),
        Hor_Avg_Max_Min: parsed.horBasis || 'Avg',
        Hor_Uniformity:  parsed.uniformity,
        Hor_CV:          parsed.cv,
        Hor_Ratio_Basis: parsed.ratioBasis,
        Hor_Notes:       null,
        // Vertical (only populate when an actual vertical lux/fc value exists)
        Ver_Cat:         parsed.verLux != null ? parsed.verCat : null,
        Ver_Lux:         parsed.verLux,
        Ver_Fc:          parsed.verFc ?? (parsed.verLux != null ? luxToFc(parsed.verLux) : null),
        Ver_Height_m:    parsed.verLux != null ? parsed.verHeightM : null,
        Ver_Height_ft:   parsed.verLux != null ? (parsed.verHeightFt ?? (parsed.verHeightM != null ? mToFt(parsed.verHeightM) : null)) : null,
        Ver_Avg_Max_Min: parsed.verLux != null ? (parsed.verBasis || 'Avg') : null,
        Ver_Uniformity:  parsed.verLux != null ? (parsed.verUniformity || null) : null,
        Ver_CV:          parsed.verLux != null ? (parsed.verCV || null) : null,
        Ver_Ratio_Basis: parsed.verLux != null ? (parsed.verRatioBasis || parsed.ratioBasis) : null,
        Ver_Notes:       null,
        Task_Cat: null, Task_Lux: null, Task_Fc: null,
        Task_Height_m: null, Task_Height_ft: null,
        Task_Avg_Max_Min: null, Task_Uniformity: null, Task_Notes: null,
        TM24_Eligible: tm24 ? 1 : 0,
        TM24_Notes:    null,
        // Lighting Zone is a hierarchy slot in the new schema (Lz0–Lz4 may
        // appear as App_s1 etc.) — also surface explicitly for outdoor apps:
        Lighting_Zone:     extractLightingZone(snapshot),
        Max_Glare_Rating:  parsed.glareMax,
        Max_Uplight:       parsed.uplightMax,
        Curfew_Dimming:    null,
        Spectrum_Guidance: parsed.spectrum,
        Controls_Required: parsed.controls,
        Footnotes:     null,
        General_Notes: null,
        App_Notes:     null,
        Vitrium_Doc_ID:    null,
        Vitrium_Deep_Link: null,
        Active: 1,
      });

      rowIndex++;
    }
  }

  return records;
}

// ─── Row Parser ───────────────────────────────────────────────────────────────

/**
 * Parse a single concatenated data line.
 *
 * Returns { hasData, label, areaOrTask, horLux, horFc, horHeightM, horHeightFt,
 *           horCat, horBasis, verLux, verFc, verHeightM, verHeightFt, verCat,
 *           uniformity, cv, ratioBasis, glareMax, uplightMax, controls,
 *           spectrum, veilingRisk, classOfPlay }
 */
function parseDataRow(text) {
  const result = {
    hasData: false,
    label: text,
    areaOrTask: null,
    horCat: null, horLux: null, horFc: null, horHeightM: null, horHeightFt: null,
    horBasis: null,
    verCat: null, verLux: null, verFc: null, verHeightM: null, verHeightFt: null,
    verBasis: null, verUniformity: null, verCV: null, verRatioBasis: null,
    uniformity: null, cv: null, ratioBasis: null,
    glareMax: null, uplightMax: null, controls: null, spectrum: null,
    veilingRisk: null, classOfPlay: null,
  };

  // ─ Lux occurrences (Hor first, Ver second) ─
  // Pattern: "<n> lx @ <h> m"   with optional T/A prefix glued to the number
  const LUX_RE = /([AT])?\s*(\d+(?:\.\d+)?)\s*l(?:x|ux)\s*@\s*(\d+(?:\.\d+)?|TS)\s*m/gi;
  const luxMatches = [...text.matchAll(LUX_RE)];
  if (luxMatches.length >= 1) {
    const m = luxMatches[0];
    if (m[1]) result.areaOrTask = m[1].toUpperCase() === 'T' ? 'Task' : 'Area';
    result.horLux = parseFloat(m[2]);
    const h = m[3] === 'TS' ? null : parseFloat(m[3]);
    result.horHeightM = h === 0 ? null : h;  // "0.00 m" = ground level (no useful AFF info)
    result.hasData = true;
  }
  if (luxMatches.length >= 2) {
    const m = luxMatches[1];
    result.verLux = parseFloat(m[2]);
    const h = m[3] === 'TS' ? null : parseFloat(m[3]);
    result.verHeightM = h === 0 ? null : h;
  }

  // ─ Fc occurrences (older standards only) ─
  const FC_RE = /([AT])?\s*(\d+(?:\.\d+)?)\s*(?:fc|footcandles?)\s*@\s*(\d+(?:\.\d+)?|TS)\s*ft/gi;
  const fcMatches = [...text.matchAll(FC_RE)];
  if (fcMatches.length >= 1) {
    if (!result.areaOrTask && fcMatches[0][1]) {
      result.areaOrTask = fcMatches[0][1].toUpperCase() === 'T' ? 'Task' : 'Area';
    }
    result.horFc = parseFloat(fcMatches[0][2]);
    result.horHeightFt = fcMatches[0][3] === 'TS' ? null : parseFloat(fcMatches[0][3]);
    result.hasData = true;
  }
  if (fcMatches.length >= 2) {
    result.verFc = parseFloat(fcMatches[1][2]);
    result.verHeightFt = fcMatches[1][3] === 'TS' ? null : parseFloat(fcMatches[1][3]);
  }

  // ─ Bare A/T marker before the first lux ─
  if (!result.areaOrTask) {
    const m = text.match(/(^|[^A-Za-z])([AT])(?:\d+(?:\.\d+)?\s*(?:lx|lux|fc))/);
    if (m) result.areaOrTask = m[2] === 'T' ? 'Task' : 'Area';
  }

  // ─ Illuminance Category (RP-10 letter A–Y) ─
  // E.g. "Cat M" or standalone " M " token. Conservative.
  const catMatch = text.match(/\bCat\s+([A-Y])\b/i);
  if (catMatch) result.horCat = catMatch[1].toUpperCase();

  // ─ Uniformity Ratio "n:n" — must NOT be followed/preceded by another colon
  //   (otherwise we eat the first half of "Avg:Min", "Max:Avg:Min", etc.)
  const urMatch = text.match(/(?<![A-Za-z:])(\d+:\d+)(?![:\d])/);
  if (urMatch) result.uniformity = urMatch[1];

  // ─ CV "<n>%" — only if explicitly preceded by CV ─
  const cvMatch = text.match(/\bCV\s*[:=]?\s*(\d+(?:\.\d+)?)\s*%/i);
  if (cvMatch) result.cv = parseFloat(cvMatch[1]);

  // ─ Ratio Basis ─
  const rbMatch = text.match(/(Max:Avg:Min|Max:Avg|Max:Min|Avg:Min)/i);
  if (rbMatch) result.ratioBasis = rbMatch[1];

  // ─ Avg/Max/Min basis token (when not part of Ratio Basis) ─
  const basisMatch = text.match(/\b(Avg|Max|Min)\b(?!\s*:)/);
  if (basisMatch && !result.ratioBasis) result.horBasis = basisMatch[1];

  // ─ Glare (max) — trailing "<n>%" not consumed by CV ─
  // Only assign if a percent token exists outside the CV match.
  const cleanedForGlare = cvMatch ? text.replace(cvMatch[0], '') : text;
  const glareMatch = cleanedForGlare.match(/(\d+(?:\.\d+)?)\s*%/);
  if (glareMatch) result.glareMax = `${glareMatch[1]}%`;
  // BUG-class glare token (e.g. G2)
  const bugMatch = text.match(/\bG([0-5])\b/);
  if (bugMatch) result.glareMax = `G${bugMatch[1]}`;

  // ─ Uplight: "<n> lm" or "U<n>" ─
  const uplightLm = text.match(/(\d+(?:\.\d+)?)\s*lm\b/);
  if (uplightLm) result.uplightMax = `${uplightLm[1]} lm`;
  const uplightU = text.match(/\bU([0-5])\b/);
  if (uplightU) result.uplightMax = `U${uplightU[1]}`;

  // ─ Controls — common phrases ─
  const ctrlMatch = text.match(/\b(Off to \d+%|Dim to \d+%|Dimmed|Curfew|Occupancy|Daylight|Auto|Manual)\b/i);
  if (ctrlMatch) result.controls = ctrlMatch[1];

  // ─ Spectrum: "NNNN K to NNNN K" or "NNNNK to NNNNK" ─
  const specMatch = text.match(/(\d{3,5})\s*K\s*(?:to|–|-)\s*(\d{3,5})\s*K/i);
  if (specMatch) result.spectrum = `${specMatch[1]}K to ${specMatch[2]}K`;

  // ─ Veiling Risk ─
  const vrMatch = text.match(/\bVeiling(?:\s*Risk)?\s*[:=]?\s*([LMH])\b/i);
  if (vrMatch) result.veilingRisk = vrMatch[1].toUpperCase();

  // ─ Class of Play ─
  const copMatch = text.match(/\bClass\s*(?:of\s*Play)?\s*[:=]?\s*(IV|III|II|I)\b/i);
  if (copMatch) result.classOfPlay = copMatch[1].toUpperCase();

  // ─ Extract a clean leading label (what comes BEFORE first data token) ─
  const earliest = earliestDataIndex(text, luxMatches, fcMatches);
  if (earliest > 0) {
    result.label = text.substring(0, earliest).trim();
  } else {
    result.label = text.trim();
  }

  return result;
}

function earliestDataIndex(text, luxMatches, fcMatches) {
  const indices = [];
  if (luxMatches.length > 0) indices.push(luxMatches[0].index);
  if (fcMatches.length > 0) indices.push(fcMatches[0].index);
  // Strip the leading A/T marker too if it's right at the data boundary
  if (indices.length === 0) return -1;
  const min = Math.min(...indices);
  // Walk back over an immediately preceding A or T marker
  let i = min;
  if (i > 0 && /[AT]/.test(text[i - 1])) i--;
  return i;
}

// ─── Hierarchy Helpers ────────────────────────────────────────────────────────

function applyHierarchyAtDepth(h, depth, name) {
  switch (depth) {
    case 0:
      h.subCategory = name;
      h.app = h.s1 = h.s2 = h.s3 = h.s4 = h.s5 = h.s6 = null;
      break;
    case 1:
      h.app = name;
      h.s1 = h.s2 = h.s3 = h.s4 = h.s5 = h.s6 = null;
      break;
    case 2:
      h.s1 = name; h.s2 = h.s3 = h.s4 = h.s5 = h.s6 = null;
      break;
    case 3:
      h.s2 = name; h.s3 = h.s4 = h.s5 = h.s6 = null;
      break;
    case 4:
      h.s3 = name; h.s4 = h.s5 = h.s6 = null;
      break;
    case 5:
      h.s4 = name; h.s5 = h.s6 = null;
      break;
    case 6:
      h.s5 = name; h.s6 = null;
      break;
    default:
      h.s6 = name;
  }
}

function snapshotHierarchyWithLeaf(h, depth, leafName) {
  const snap = { ...h };
  if (leafName && leafName.length >= 2) {
    switch (depth) {
      case 0: snap.subCategory = leafName; break;
      case 1: snap.app = leafName; break;
      case 2: snap.s1 = leafName; break;
      case 3: snap.s2 = leafName; break;
      case 4: snap.s3 = leafName; break;
      case 5: snap.s4 = leafName; break;
      case 6: snap.s5 = leafName; break;
      default: snap.s6 = leafName;
    }
  }
  return snap;
}

// ─── Sub-Category / Section Detection ─────────────────────────────────────────

// Only ALL-CAPS section banners count as Sub_Category in the IES schema.
// Mixed-case lines like "Outdoor Restaurants and Dining Areas (...)" are
// App-level entries, NOT Sub_Categories.
const SUB_CATEGORY_RE = /^(INTERIORS?|EXTERIORS?|INDOOR\s+APPLICATIONS?|OUTDOOR\s+APPLICATIONS?|COMMON\s+APPLICATIONS?)\b/;

function detectSubCategory(text) {
  if (!SUB_CATEGORY_RE.test(text)) return null;
  const indoorOutdoor = /EXTERIOR|OUTDOOR/i.test(text) ? 'Outdoor' : 'Indoor';
  return { label: text.trim(), indoorOutdoor };
}

function inferSectionFromStandard(standardId) {
  // RP-43 = outdoor pedestrian, RP-8 = roadway, RP-6 = sports
  if (/^RP-(?:6|8|33|43|47)/i.test(standardId)) return 'Outdoor';
  return 'Indoor';
}

function extractLightingZone(snapshot) {
  for (const v of [snapshot.s1, snapshot.s2, snapshot.s3, snapshot.s4, snapshot.s5, snapshot.s6]) {
    if (typeof v === 'string' && /^Lz[0-4]$/i.test(v.trim())) {
      return v.trim().toUpperCase();
    }
  }
  return null;
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function detectTableRef(pageText) {
  const m = pageText?.match(/Table\s+(A-?\d+)/i);
  return m ? `Table ${m[1].replace(/^A(\d)/, 'A-$1')}` : null;
}

function cleanAppName(name) {
  return name
    .replace(/\s*[¹²³⁴⁵⁶⁷⁸⁹⁰]+$/, '')
    .replace(/\s+\d+$/, '')
    .replace(/\s*\([a-z]\)$/, '')
    .replace(/^[AT]\s+/, '')
    .trim();
}

function isTM24EligibleCat(cat) {
  if (!cat) return false;
  const c = cat.toUpperCase();
  return c >= 'P' && c <= 'Y';
}

/** lux → fc using IES tables convention (10:1, NOT 10.764) */
function luxToFc(lux) {
  return Math.round(lux / 10 * 10) / 10;
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
  const withRatioBasis = records.filter(r => r.Hor_Ratio_Basis !== null).length;
  const withDeepHierarchy = records.filter(r => r.App_s4 || r.App_s5 || r.App_s6).length;
  const withEnvVisual = records.filter(r =>
    r.Max_Glare_Rating || r.Max_Uplight || r.Controls_Required || r.Spectrum_Guidance
  ).length;
  const withLightingZone = records.filter(r => r.Lighting_Zone).length;

  return {
    total,
    withHorLux,
    withApp,
    withIlluminanceCategory: withCat,
    withRatioBasis,
    withDeepHierarchy,
    withEnvVisual,
    withLightingZone,
    qualityScore: total > 0 ? Math.round((withHorLux / total) * 100) : 0,
    warnings: [
      ...(total === 0 ? ['No records extracted'] : []),
      ...(withHorLux < total * 0.8 ? [`Only ${withHorLux}/${total} records have horizontal lux`] : []),
      ...(withApp < total * 0.5 ? [`${total - withApp} records missing App category`] : []),
    ],
  };
}
