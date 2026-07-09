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

// ─── Structure Detection ──────────────────────────────────────────────────────

// "… 30 lx @ 0.00 m 3 fc @ 0.0 ft …" — both units glued on one line. This is
// the signature of a criteria-grid DATA row; prose that merely discusses lux
// values never produces it. Shared by detectNewTableStructure (document-level
// classification) and isIlluminancePage (page-level selection).
const NEW_TABLE_ROW_RE = /\d+(?:\.\d+)?\s*l(?:x|ux)\s*@.*\bfc\b\s*@/i;

/**
 * Detect whether a PDF uses the "NEW TABLE" Recommended Illuminance Criteria
 * layout (260420+ prototypes, e.g. RP-43-25) versus a STANDARD prose document
 * (e.g. RP-1-24, the LP-/LS-/TM- series, and the pre-prototype RPs).
 *
 * Why this matters for ingest:
 *   • NEW_TABLE PDFs render the full application taxonomy as a dense, landscape
 *     grid of concatenated rows ("30 lx @ 0.00 m 3 fc @ 0.0 ft 5:1 Avg:Min …").
 *     extractApplicationsFromPages() reconstructs hundreds of structured records
 *     from these — this is the schema the extractor was built for.
 *   • STANDARD PDFs have no such grid. They are ordinary prose with occasional
 *     small inline tables. Running the application extractor over them yields
 *     only a handful of incidental, low-quality rows that would pollute D1.
 *     These documents are still fully ingested for semantic text search
 *     (chunks, general notes, embeddings) — just without application records.
 *
 * The discriminator is the concatenated dual-unit row ("<n> lx @ … fc @ …"),
 * which is unique to the new format. Validated to agree 100% with the
 * "-NEW_TABLE" filename convention across the current corpus (70 PDFs).
 *
 * @param {Array<{number, text, lines, width, height}>} pages
 * @returns {{ isNewTable: boolean, rowHits: number, criteriaPages: number }}
 */
export function detectNewTableStructure(pages) {
  const CRITERIA_TITLE_RE = /Recommended Illuminance Criteria/i;

  let rowHits = 0;
  let criteriaPages = 0;

  for (const page of pages || []) {
    const landscape = (page.width || 0) > (page.height || 0);
    const lines = page.lines || [];
    const pageRowHits = lines.filter((l) => NEW_TABLE_ROW_RE.test(l.text || '')).length;
    rowHits += pageRowHits;
    const hasCriteriaTitle = lines.some((l) => CRITERIA_TITLE_RE.test(l.text || ''));
    if (landscape && (hasCriteriaTitle || pageRowHits >= 3)) criteriaPages++;
  }

  const isNewTable = rowHits >= 5 && criteriaPages >= 1;
  return { isNewTable, rowHits, criteriaPages };
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function extractApplicationsFromTables(_tables, _standardId, _meta) {
  return []; // legacy — use extractApplicationsFromPages instead
}

export function extractApplicationsFromPages(pages, standardId, standardMeta = {}) {
  const fullDesignation = standardMeta.fullDesignation || `ANSI/IES ${standardId}`;

  const tablePages = pages.filter(isIlluminancePage);
  const allRecords = extractFromPages(tablePages, standardId, fullDesignation);

  finalizeFootnotes(allRecords, pages, tablePages);

  // Validation gate: a record with data tokens or prose fragments in its
  // hierarchy labels is a mis-parse and must never reach D1 — it renders as
  // the garbled titles the client flagged ("museum", "airport" searches).
  return deduplicate(allRecords.filter(isValidRecord));
}

/**
 * Second-pass footnote resolution, scanning the WHOLE document.
 *
 * Two layouts exist across the prototypes:
 *   • RP-2/RP-30 style: per-row tiny-font refs, notes printed on the data
 *     pages themselves. Mostly resolved in extractFromPages; refs whose
 *     definitions live on a different page resolve here.
 *   • RP-43 style: no recoverable per-row refs (superscripts are lost in
 *     text extraction) and an "Application Task/Area Notes" section on a
 *     dedicated page. Those notes govern the whole table, so they attach to
 *     every record as General_Notes — the UI's collapsed notes disclosure
 *     then has content for each result (client feedback).
 */
function finalizeFootnotes(records, allPages, tablePages) {
  const bodyFont = medianDataFont(tablePages);
  const docNotes = new Map();
  for (const page of allPages) {
    for (const [n, text] of collectPageNotes(page, bodyFont)) {
      if (!docNotes.has(n)) docNotes.set(n, text); // first definition wins
    }
  }

  let hasRowRefs = records.some(r => r.Footnotes != null);
  for (const rec of records) {
    const refs = rec._noteRefs;
    if (!refs) continue;
    delete rec._noteRefs;
    hasRowRefs = true;
    const resolved = refs
      .map(n => (docNotes.get(n) ? `${n}. ${docNotes.get(n)}` : null))
      .filter(Boolean);
    rec.Footnotes = resolved.length > 0
      ? resolved.join('\n')
      : `See Application Task/Area Notes: ${refs.join(', ')}`;
  }

  if (!hasRowRefs && docNotes.size > 0) {
    const all = [...docNotes.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([n, t]) => `${n}. ${t}`)
      .join('\n');
    const capped = all.length > 2000 ? `${all.slice(0, 2000)}…` : all;
    for (const rec of records) rec.General_Notes = capped;
  }
}

// ─── Record Validation ────────────────────────────────────────────────────────

// Tokens that must never appear inside a hierarchy label — their presence
// means row data leaked into the name (mis-parsed row) or discussion prose
// was mistaken for a table line. Note: "@ <n> m" alone is NOT a data token —
// legitimate names carry it ("Target @ 18.3 m (60 ft)", RP-6 archery).
const LABEL_DATA_TOKEN_RE =
  /\d+\s*(?:lx|lux|fc)\b|#\s*\d|\b(?:Max|Avg|Min):(?:Max|Avg|Min)\b|\b\d+(?:\.\d+)?:\d+\b/i;
// Longest legitimate label observed: RP-2 "Centers, Outdoors (Vehicular
// traffic restricted; Open-air malls or centers dedicated to shoppers)"
// at 99 chars — the cap must sit above real names, below prose sentences.
const MAX_LABEL_LENGTH = 120;

function isCleanHierarchyValue(v) {
  if (v == null || v === '') return true;
  const s = String(v).trim();
  if (s.length > MAX_LABEL_LENGTH) return false; // sentence-length → prose, not a label
  if (/[a-z]-$/.test(s)) return false;           // hyphenated line-break fragment ("…visi-")
  if (LABEL_DATA_TOKEN_RE.test(s)) return false; // leaked data tokens
  return true;
}

function isValidRecord(r) {
  const labels = [r.Sub_Category, r.App, r.App_s1, r.App_s2, r.App_s3, r.App_s4, r.App_s5, r.App_s6];
  if (!labels.every(isCleanHierarchyValue)) return false;
  // A record must carry SOME name — a row whose whole hierarchy is empty has
  // no identity the UI could display.
  if (!labels.some(v => v != null && String(v).trim().length >= 2)) return false;
  return true;
}

// ─── Page Detection ───────────────────────────────────────────────────────────

/**
 * Detect a "real" criteria-table page.
 *
 * "≥3 lines mentioning lux/fc" is NOT enough: discussion prose in standards
 * like RP-30-25 mentions illuminance values constantly, and running the row
 * parser over those pages produced dozens of garbage records with sentence
 * fragments as application names (client feedback: "museum" search). A page
 * qualifies only when it shows criteria-grid structure:
 *   • at least one dual-unit data row ("<n> lx @ … <n> fc @ …"), which prose
 *     never produces, or
 *   • landscape orientation (the grid layout) with several data lines —
 *     covers continuation pages whose rows might drop one unit column.
 */
function isIlluminancePage(page) {
  const lines = page.lines || [];
  if (lines.length < 10) return false;
  if (lines.some(l => NEW_TABLE_ROW_RE.test(l.text || ''))) return true;
  const landscape = (page.width || 0) > (page.height || 0);
  if (!landscape) return false;
  const dataLineRe = /\d+\s*(?:lx|lux|fc|footcandle)\b|\d+\s*lm\b/i;
  const matches = lines.filter(l => dataLineRe.test(l.text)).length;
  return matches >= 3;
}

// ─── Multi-Page Extractor ─────────────────────────────────────────────────────

function extractFromPages(tablePages, standardId, fullDesignation) {
  const records = [];

  // Derive the table's indentation grid from the actual X positions of body
  // lines, instead of assuming a fixed pixel step. Each IES standard renders
  // its hierarchy at slightly different left margins and indent increments
  // (RP-43 ≈7px, RP-2 ≈8px), so a hard-coded X_STEP=7 drifts and mis-assigns
  // depth (e.g. App_s3 rounding up to App_s4, leaving the App level empty).
  // depthForX() snaps a line's X to the nearest derived level → its depth.
  // The table body (every hierarchy level AND every data row) renders at one
  // consistent small font in these prototypes (≈7.5pt), while page headers,
  // table titles and discussion prose on the same pages use larger fonts
  // (9–10pt). Anchor to the data-row font and ignore lines outside that band
  // so prose at the left margin can't inject a phantom shallow indent level
  // (which previously pushed the App level down a rank, leaving App empty).
  const bodyFont = medianDataFont(tablePages);
  const levels = deriveIndentLevels(tablePages, bodyFont);
  const baseX = levels.length > 0 ? levels[0] : 60;

  const offGrid = (line) =>
    bodyFont != null && Math.abs((line.fontSize ?? bodyFont) - bodyFont) > BODY_FONT_TOLERANCE;

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
  let pendingLink = null;  // cross-reference captured from a "Refer to ANSI/IES ..." hierarchy line

  for (const page of tablePages) {
    const ref = detectTableRef(page.text);
    if (ref) tableRef = ref;

    // Footnote support (client feedback: associate footnotes with results).
    // The criteria grid renders each row's note references as a separate
    // TINY-font line right below the row ("1, 3, 6" at ~4.7pt under a 7.1pt
    // body), and the note definitions under an "Application Task/Area Notes"
    // heading at the prose font. Collect the definitions first, attach the
    // refs to rows as we walk, resolve at end of page.
    const noteMap = collectPageNotes(page, bodyFont);
    const pageRecords = [];
    let lastRecord = null; // most recent data row — target for footnote refs

    // Detect a "Sub Category" announce line if present
    for (const line of (page.lines || [])) {
      const text = line.text?.trim();
      if (!text) continue;

      // Attach tiny-font numeric ref lines BEFORE the generic skips — a bare
      // single-digit "4" would otherwise be discarded by the length/page-number
      // checks below.
      if (lastRecord && isFootnoteRefLine(text, line, bodyFont)) {
        lastRecord._noteRefs = (lastRecord._noteRefs || []).concat(parseNoteRefs(text));
        continue;
      }

      if (text.length < 2) continue;
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
        lastRecord = null;
        continue;
      }

      // Off the table-body font (titles, headers, discussion prose) → not a
      // hierarchy or data node. Sub-category banners were already handled above.
      if (offGrid(line)) continue;

      const parsed = parseDataRow(text);
      const depth = depthForX(line.x ?? baseX, levels);

      if (!parsed.hasData) {
        // Pure hierarchy line — fill the slot at this depth.
        // Ignore lines that start to the right of the indent grid: those are
        // stray column-header fragments ("Target Eh @ Height AFF", "Ratio
        // Basis") that share a Y band with the table but are not hierarchy.
        const deepestLevel = levels[levels.length - 1] ?? baseX;
        if ((line.x ?? baseX) > deepestLevel + INDENT_TOLERANCE) continue;
        const { name, link } = splitNameAndLink(parsed.label);
        if (name.length < 2) continue;
        applyHierarchyAtDepth(hierarchy, depth, name);
        if (link) pendingLink = link;
        // A ref line after a header annotates the header, not the last row.
        lastRecord = null;
        continue;
      }

      // Data row — snapshot hierarchy with leaf, build record
      const { name: leafRaw, link: leafLink } = splitNameAndLink(parsed.label);
      const leafName = cleanAppName(leafRaw);
      const rowLink = leafLink || pendingLink;
      pendingLink = null;
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
        Page_Number:   page.number,
        Link_Mapping:  rowLink,
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

      lastRecord = records[records.length - 1];
      pageRecords.push(lastRecord);
      rowIndex++;
    }

    // Resolve this page's footnote refs against the page's note definitions.
    // Unresolved refs stay on the record for a document-level second pass —
    // some standards print the notes on a separate page (finalizeFootnotes).
    for (const rec of pageRecords) {
      const refs = rec._noteRefs;
      if (!refs || refs.length === 0) continue;
      const uniq = [...new Set(refs)].sort((a, b) => a - b);
      const resolved = uniq
        .map(n => (noteMap.get(n) ? `${n}. ${noteMap.get(n)}` : null))
        .filter(Boolean);
      if (resolved.length > 0) {
        rec.Footnotes = resolved.join('\n');
        delete rec._noteRefs;
      } else {
        rec._noteRefs = uniq;
      }
    }
  }

  return records;
}

// ─── Footnotes ────────────────────────────────────────────────────────────────

/** A row's footnote references render as a bare numeric list ("4", "1, 3, 6")
 *  in a visibly smaller font than the table body. Page numbers and data
 *  fragments render at body size or larger, so the font gap is the signal. */
function isFootnoteRefLine(text, line, bodyFont) {
  if (!/^\d{1,2}(?:\s*,\s*\d{1,2})*$/.test(text)) return false;
  return line.fontSize != null && bodyFont != null && line.fontSize <= bodyFont - 1.5;
}

function parseNoteRefs(text) {
  return text.split(',').map(s => parseInt(s.trim(), 10)).filter(Number.isFinite);
}

const MAX_NOTE_LENGTH = 600;

/**
 * Collect the "Application Task/Area Notes" definitions printed on a criteria
 * page: numbered notes ("1 General principles…") at the prose font, with
 * unnumbered continuation lines appended to the current note. Table-body
 * lines (data rows sharing the page) are ignored via the font check.
 */
function collectPageNotes(page, bodyFont) {
  const noteMap = new Map();
  const lines = page.lines || [];
  const startIdx = lines.findIndex(l => /^Application Task\/Area Notes\b/i.test((l.text || '').trim()));
  if (startIdx < 0) return noteMap;

  let currentNum = null;
  for (let i = startIdx + 1; i < lines.length; i++) {
    const raw = (lines[i].text || '').trim();
    if (!raw) continue;
    // Skip lines at the table-body font — they are grid rows, not note text.
    const fs = lines[i].fontSize;
    if (bodyFont != null && fs != null && Math.abs(fs - bodyFont) <= BODY_FONT_TOLERANCE) continue;
    if (/^Table\s/i.test(raw)) break; // next table block — notes are done

    const m = raw.match(/^(\d{1,2})\s+(\S.*)$/);
    if (m && parseInt(m[1], 10) <= 30) {
      currentNum = parseInt(m[1], 10);
      noteMap.set(currentNum, m[2].trim());
    } else if (currentNum != null) {
      const merged = `${noteMap.get(currentNum)} ${raw}`.trim();
      noteMap.set(currentNum, merged.length > MAX_NOTE_LENGTH ? merged.slice(0, MAX_NOTE_LENGTH) : merged);
    }
  }
  return noteMap;
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
export function parseDataRow(text) {
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

  // ── Lux occurrences ───────────────────────────────────────────────────────
  // Canonical row grammar (verified across RP-2/6/7/9/10/29/43 prototypes):
  //   "<Cat A-Y> <n> lx @ <TS | n m>"
  // The illuminance Category is the single letter glued immediately before the
  // lux value ("A M 100 lx" → Area, Cat M;  "T W 3000 lx" → Task, Cat W). The
  // height may be "TS" (task surface, no unit), "<n> m", or absent entirely.
  // First lux match = horizontal plane, second = vertical plane.
  const LUX_RE = /(?:([A-Y])\s+)?(\d+(?:\.\d+)?)\s*l(?:x|ux)\s*@?\s*(TS|\d+(?:\.\d+)?\s*m)?/gi;
  const luxMatches = [...text.matchAll(LUX_RE)];

  //   "<n> fc @ <TS | n ft>"  (every prototype carries both lx and fc)
  const FC_RE = /(\d+(?:\.\d+)?)\s*(?:fc|footcandles?)\s*@?\s*(TS|\d+(?:\.\d+)?\s*ft)?/gi;
  const fcMatches = [...text.matchAll(FC_RE)];

  // ── "#" placeholder targets ────────────────────────────────────────────────
  // Prototypes print "#" where a plane has no maintained target, e.g.
  //   "Conference rm, < 50 people T # 0.76 m # 2.5 ft … O 200 lx @ 1.22 m …"
  // A "#" BEFORE the first real lux value means the horizontal block is a
  // placeholder and the first real lux/fc pair belongs to the VERTICAL plane.
  // Without this, the vertical data lands on the horizontal plane and the
  // "# 0.76 m # 2.5 ft…" fragment leaks into the application title (client
  // feedback: "airport" search, unexpected data in title).
  const phMatch = text.match(/#\s*(?:\d+(?:\.\d+)?\s*(?:m|ft)|TS)?/);
  const horIsPlaceholder = phMatch != null &&
    (luxMatches.length === 0 || phMatch.index < luxMatches[0].index);

  const horLuxM = horIsPlaceholder ? null : (luxMatches[0] ?? null);
  const verLuxM = horIsPlaceholder ? (luxMatches[0] ?? null) : (luxMatches[1] ?? null);
  const horFcM  = horIsPlaceholder ? null : (fcMatches[0] ?? null);
  const verFcM  = horIsPlaceholder ? (fcMatches[0] ?? null) : (fcMatches[1] ?? null);

  if (horLuxM) {
    result.horCat = horLuxM[1] ? horLuxM[1].toUpperCase() : null;
    result.horLux = parseFloat(horLuxM[2]);
    result.horHeightM = parseHeight(horLuxM[3]);
    result.hasData = true;
  }
  if (verLuxM) {
    result.verCat = verLuxM[1] ? verLuxM[1].toUpperCase() : null;
    result.verLux = parseFloat(verLuxM[2]);
    result.verHeightM = parseHeight(verLuxM[3]);
    result.hasData = true;
  }
  if (horFcM) {
    result.horFc = parseFloat(horFcM[1]);
    result.horHeightFt = parseHeight(horFcM[2]);
    result.hasData = true;
  }
  if (verFcM) {
    result.verFc = parseFloat(verFcM[1]);
    result.verHeightFt = parseHeight(verFcM[2]);
    result.hasData = true;
  }

  // ── Split the row into horizontal / vertical halves at the vertical lux ──
  // so the basis / uniformity / ratio tokens are parsed against the correct
  // plane instead of leaking the horizontal values into the vertical block.
  const firstDataIdx = result.hasData ? firstDataIndex(text, luxMatches, fcMatches) : -1;
  const splitIdx = verLuxM ? verLuxM.index : text.length;
  const horTail = (horLuxM || horFcM) ? sliceMetricsTail(text, horLuxM, horFcM, splitIdx) : '';
  const verTail = verLuxM ? text.slice(splitIdx) : '';

  const horMetrics = parseHalfMetrics(horTail);
  result.horBasis = horMetrics.basis;
  result.uniformity = horMetrics.uniformity;
  result.cv = horMetrics.cv;
  result.ratioBasis = horMetrics.ratioBasis;

  if (verTail) {
    const verMetrics = parseHalfMetrics(verTail);
    result.verBasis = verMetrics.basis;
    result.verUniformity = verMetrics.uniformity;
    result.verCV = verMetrics.cv;
    result.verRatioBasis = verMetrics.ratioBasis;
  }

  // ── Area vs Task + Veiling Risk — read the marker tokens that precede the ──
  // horizontal Category, i.e. the text between the leaf label and the data.
  // For pure hierarchy lines (no data tokens) the whole line is the label.
  // The label always ends at the first data token OR the first "#" placeholder,
  // whichever comes first — placeholder fragments are never part of a name.
  let labelEnd = firstDataIdx;
  if (phMatch && (labelEnd < 0 || phMatch.index < labelEnd)) labelEnd = phMatch.index;
  const prefix = labelEnd >= 0 ? text.slice(0, labelEnd) : text;
  const markers = parsePrefixMarkers(prefix);
  result.areaOrTask = markers.areaOrTask;
  result.veilingRisk = markers.veilingRisk;
  result.label = markers.label;

  // Glued A/T fallback for the concatenated RP-43 layout ("…(avg.)A50 lx").
  if (!result.areaOrTask) {
    const glued = text.match(/(?:^|[^A-Za-z])([AT])\s*\d+(?:\.\d+)?\s*l(?:x|ux)/);
    if (glued) {
      result.areaOrTask = glued[1] === 'T' ? 'Task' : 'Area';
      // strip the glued marker from the label tail
      result.label = result.label.replace(/([AT])\s*$/, '').trim();
    }
  }

  // ── Environmental & Visual Considerations (RP-43-25; spec p.6) ────────────
  // These columns sit after the vertical block. Parse from the whole row.
  // CV percentages are explicitly tagged ("CV 3%"); strip them before the
  // generic glare-percent match so we don't mistake a CV value for glare.
  const cvAll = text.match(/\bCV\s*[:=]?\s*\d+(?:\.\d+)?\s*%/gi) || [];
  let envText = text;
  for (const c of cvAll) envText = envText.replace(c, '');

  const glareMatch = envText.match(/(\d+(?:\.\d+)?)\s*%/);
  if (glareMatch) result.glareMax = `${glareMatch[1]}%`;
  const bugMatch = text.match(/\bG([0-5])\b/);
  if (bugMatch) result.glareMax = `G${bugMatch[1]}`;

  const uplightLm = text.match(/(\d+(?:\.\d+)?)\s*lm\b/);
  if (uplightLm) result.uplightMax = `${uplightLm[1]} lm`;
  const uplightU = text.match(/\bU([0-5])\b/);
  if (uplightU) result.uplightMax = `U${uplightU[1]}`;

  // No trailing \b: the "% "-terminated alternatives ("Off to 50%") have no
  // word boundary after the percent sign, which would defeat the match.
  const ctrlMatch = text.match(/\b(Off to \d+%|Dim to \d+%|Dimmed|Curfew|Occupancy|Daylight|Auto|Manual)/i);
  if (ctrlMatch) result.controls = ctrlMatch[1];

  const specMatch = text.match(/(\d{3,5})\s*K\s*(?:to|–|-)\s*(\d{3,5})\s*K/i);
  if (specMatch) result.spectrum = `${specMatch[1]}K to ${specMatch[2]}K`;

  // ── Class of Play (RP-6 sports: I/II/III/IV) ──────────────────────────────
  const copMatch = text.match(/\bClass\s*(?:of\s*Play)?\s*[:=]?\s*(IV|III|II|I)\b/i);
  if (copMatch) result.classOfPlay = copMatch[1].toUpperCase();

  return result;
}

/** Parse a height token ("TS" | "0.00 m" | "3.0 ft" | undefined) → number|null.
 *  "0" (ground level / AFF baseline) carries no useful height info → null. */
function parseHeight(token) {
  if (!token) return null;
  const t = token.trim();
  if (/^TS$/i.test(t)) return null;
  const n = parseFloat(t);
  if (Number.isNaN(n) || n === 0) return null;
  return n;
}

/** Index in `text` where the data portion (Cat letter / lux / fc) begins. */
function firstDataIndex(text, luxMatches, fcMatches) {
  const idxs = [];
  if (luxMatches.length) idxs.push(luxMatches[0].index);
  if (fcMatches.length) idxs.push(fcMatches[0].index);
  return idxs.length ? Math.min(...idxs) : -1;
}

/** The metrics (basis/uniformity/ratio/CV) for a plane appear AFTER its
 *  lux/fc values. Slice the horizontal half from the end of its fc/lux match
 *  up to the start of the vertical block so the leaf label (which may itself
 *  contain "Min"/"Max", e.g. "Room Min") never pollutes the basis token. */
function sliceMetricsTail(text, luxMatch, fcMatch, splitIdx) {
  let start = 0;
  if (fcMatch) start = Math.max(start, fcMatch.index + fcMatch[0].length);
  if (luxMatch) start = Math.max(start, luxMatch.index + luxMatch[0].length);
  return text.slice(start, splitIdx);
}

/** Parse the basis / uniformity ratio / ratio basis / CV from a plane tail. */
function parseHalfMetrics(tail) {
  const out = { basis: null, uniformity: null, ratioBasis: null, cv: null };
  if (!tail) return out;

  const rb = tail.match(/(Max:Avg:Min|Max:Avg|Max:Min|Avg:Min)/i);
  if (rb) out.ratioBasis = rb[1];

  // Uniformity "n:n" (e.g. 3:1, 1.2:1) — not part of a Max:Avg:Min chain.
  const ur = tail.match(/(?<![A-Za-z:])(\d+(?:\.\d+)?:\d+(?:\.\d+)?)(?![:\d])/);
  if (ur) out.uniformity = ur[1];

  const cv = tail.match(/\bCV\s*[:=]?\s*(\d+(?:\.\d+)?)\s*%/i);
  if (cv) out.cv = parseFloat(cv[1]);

  // Standalone Avg/Max/Min basis (not the ratio-basis chain).
  const basis = tail.match(/(?<![:\w])(Avg|Max|Min)(?![:\w])/);
  if (basis) out.basis = basis[1];

  return out;
}

/** Given the text BEFORE the data portion (= leaf label + marker letters),
 *  peel the trailing single-letter Area/Task and Veiling-Risk markers off the
 *  label. Data layout is "<label> <A|T> [veiling L/M/H]" with the Category
 *  already consumed by LUX_RE. */
function parsePrefixMarkers(prefix) {
  const out = { areaOrTask: null, veilingRisk: null, label: prefix.trim() };
  const tokens = out.label.split(/\s+/);
  // Pull off up to two trailing single-letter tokens.
  for (let n = 0; n < 2 && tokens.length > 1; n++) {
    const last = tokens[tokens.length - 1];
    if (/^[AT]$/.test(last)) { out.areaOrTask = last === 'T' ? 'Task' : 'Area'; tokens.pop(); }
    else if (/^[LMH]$/.test(last)) { out.veilingRisk = last.toUpperCase(); tokens.pop(); }
    else break;
  }
  out.label = tokens.join(' ').trim();
  return out;
}

// ─── Hierarchy Helpers ────────────────────────────────────────────────────────

function applyHierarchyAtDepth(h, depth, name) {
  // Clamp so a hierarchy line can't skip an empty ancestor slot (same nesting
  // invariant as the leaf snapshot). The source occasionally indents a child
  // header two levels below its parent with no intermediate row.
  const chain = [h.subCategory, h.app, h.s1, h.s2, h.s3, h.s4, h.s5, h.s6];
  let lastFilled = -1;
  for (let i = 0; i < chain.length; i++) if (chain[i] != null && chain[i] !== '') lastFilled = i;
  depth = Math.min(depth, lastFilled + 1);
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
    // Clamp the leaf depth so it never skips an empty ancestor slot. A data row
    // whose X lands two levels below the deepest established hierarchy line
    // (no intermediate header in the source) would otherwise leave a gap; we
    // attach it directly beneath the last known ancestor instead.
    const chain = [h.subCategory, h.app, h.s1, h.s2, h.s3, h.s4, h.s5, h.s6];
    let lastFilled = -1;
    for (let i = 0; i < chain.length; i++) if (chain[i] != null && chain[i] !== '') lastFilled = i;
    depth = Math.min(depth, lastFilled + 1);
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

// ─── Indentation Grid (hierarchy depth) ───────────────────────────────────────

const INDENT_TOLERANCE = 4;      // px; X positions within this are the same level
const BODY_FONT_TOLERANCE = 1.0; // pt; lines outside this band off the data font are non-table

const DATA_LINE_RE = /\d+\s*(?:lx|lux|fc|footcandle)\b/i;

/** Median font size of the table's data rows — the table-body font anchor. */
function medianDataFont(tablePages) {
  const sizes = [];
  for (const page of tablePages) {
    for (const line of (page.lines || [])) {
      if (line.fontSize == null) continue;
      if (DATA_LINE_RE.test(line.text || '')) sizes.push(line.fontSize);
    }
  }
  if (sizes.length === 0) return null;
  sizes.sort((a, b) => a - b);
  return sizes[Math.floor(sizes.length / 2)];
}

/**
 * Derive the table's indentation grid from the actual left-edge X positions of
 * body lines across all table pages. IES tables align each hierarchy level at a
 * fixed left margin; clustering the observed X values yields the ordered list of
 * level positions (ascending = shallow→deep). This adapts to each standard's own
 * indent step instead of assuming a fixed pixel increment.
 */
function deriveIndentLevels(tablePages, bodyFont) {
  const xs = [];
  for (const page of tablePages) {
    const pageWidth = page.width || 842;
    for (const line of (page.lines || [])) {
      const t = (line.text || '').trim();
      if (t.length < 2) continue;
      if (/^\d+$/.test(t)) continue;                 // page numbers / footnote markers
      const x = line.x;
      if (x == null) continue;
      // Only the table-body font defines the grid — headers/titles/prose at the
      // left margin use larger fonts and would otherwise add phantom levels.
      if (bodyFont != null && Math.abs((line.fontSize ?? bodyFont) - bodyFont) > BODY_FONT_TOLERANCE) continue;
      // Hierarchy + data rows live in the left portion of the (landscape) table;
      // column-header fragments sit far right and must not define a level.
      if (x > pageWidth * 0.45) continue;
      const isData = DATA_LINE_RE.test(t);
      const isShortName = t.length < 70;
      if (isData || isShortName) xs.push(x);
    }
  }
  if (xs.length === 0) return [];

  // Cluster sorted X values: merge any within INDENT_TOLERANCE of the running
  // cluster mean. Drop clusters with trivial support (likely stray fragments).
  xs.sort((a, b) => a - b);
  const clusters = [];
  let bucket = [xs[0]];
  for (let i = 1; i < xs.length; i++) {
    const mean = bucket.reduce((s, v) => s + v, 0) / bucket.length;
    if (xs[i] - mean <= INDENT_TOLERANCE) bucket.push(xs[i]);
    else { clusters.push(bucket); bucket = [xs[i]]; }
  }
  clusters.push(bucket);

  // Keep clusters with non-trivial support (kills in-band noise and right-side
  // header fragments), but ALWAYS keep the shallowest cluster — it is the depth
  // anchor (top banner / App level). A sparse banner that appears only a couple
  // of times must not be dropped, or every depth shifts up one rank and the App
  // level is left permanently empty. `clusters` is already ascending by X.
  const MIN_SUPPORT = 3;
  const centers = clusters
    .filter((b, idx) => idx === 0 || b.length >= MIN_SUPPORT)
    .map(b => b.reduce((s, v) => s + v, 0) / b.length)
    .sort((a, b) => a - b);

  if (centers.length === 0) return [];

  // The hierarchy/data grid is a left-anchored run of levels spaced by the
  // indent step (~7–9px). Multi-row column-header cells render at the body
  // font too but sit far to the right; they appear as clusters separated from
  // the grid by a large gap. Trim the level list at the first such gap.
  const MAX_LEVEL_GAP = 30;
  const grid = [centers[0]];
  for (let i = 1; i < centers.length; i++) {
    if (centers[i] - centers[i - 1] > MAX_LEVEL_GAP) break;
    grid.push(centers[i]);
  }

  return grid.slice(0, 9); // schema caps at Sub_Category + App + s1..s6 → 8 levels
}

/** Snap an X position to the nearest indent level → its depth (0 = shallowest). */
function depthForX(x, levels) {
  if (!levels || levels.length === 0) return 0;
  let best = 0, bestDist = Infinity;
  for (let i = 0; i < levels.length; i++) {
    const d = Math.abs(x - levels[i]);
    if (d < bestDist) { bestDist = d; best = i; }
  }
  return best;
}

/**
 * Split a hierarchy/leaf label from an inline cross-reference. Per the spec the
 * "Link" column holds a hyperlinked reference such as
 * "Refer to ANSI/IES RP-10-20: Table A-3". Returns { name, link }.
 */
function splitNameAndLink(raw) {
  const text = (raw || '').trim();
  // Draft standards are referenced with a BSR/IES prefix ("Refer to BSR/IES
  // RP-43") — treat them like ANSI/IES so the reference never sticks to the
  // application name.
  const m = text.match(/\b(Refer to\s+(?:ANSI|BSR)\/IES.*|See\s+(?:ANSI|BSR)\/IES.*|(?:ANSI|BSR)\/IES\s+[A-Z]{1,3}-\d.*)$/i);
  if (m && m.index > 0) {
    return { name: text.slice(0, m.index).trim(), link: m[1].trim() };
  }
  return { name: text, link: null };
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
  const withVertical = records.filter(r => r.Ver_Lux !== null).length;
  const withDeepHierarchy = records.filter(r => r.App_s4 || r.App_s5 || r.App_s6).length;
  const withEnvVisual = records.filter(r =>
    r.Max_Glare_Rating || r.Max_Uplight || r.Controls_Required || r.Spectrum_Guidance
  ).length;
  const withLightingZone = records.filter(r => r.Lighting_Zone).length;

  // Hierarchy integrity: per the IES schema (reference PDF p.1-2) the levels are
  // nested. A null *between* two filled levels is a depth-assignment error. A
  // leading null is fine — Sub_Category is an optional top banner that many
  // standards omit (the hierarchy then starts at App).
  const hierarchyGaps = records.filter(r => {
    const chain = [r.Sub_Category, r.App, r.App_s1, r.App_s2, r.App_s3, r.App_s4, r.App_s5, r.App_s6];
    const filled = chain.map(v => v != null && v !== '');
    const first = filled.indexOf(true);
    const last = filled.lastIndexOf(true);
    if (first < 0) return false;
    for (let i = first; i < last; i++) if (!filled[i]) return true; // hole between filled levels
    return false;
  }).length;

  return {
    total,
    withHorLux,
    withApp,
    withIlluminanceCategory: withCat,
    withRatioBasis,
    withVertical,
    withDeepHierarchy,
    withEnvVisual,
    withLightingZone,
    hierarchyGaps,
    qualityScore: total > 0 ? Math.round((withHorLux / total) * 100) : 0,
    warnings: [
      ...(total === 0 ? ['No records extracted'] : []),
      ...(withHorLux < total * 0.8 ? [`Only ${withHorLux}/${total} records have horizontal lux`] : []),
      ...(withApp < total * 0.5 ? [`${total - withApp} records missing App category`] : []),
      ...(withCat < total * 0.5 ? [`${total - withCat} records missing illuminance Category (expected for RP-43-style tables only)`] : []),
      ...(hierarchyGaps > 0 ? [`${hierarchyGaps} records have hierarchy gaps (deeper level filled above an empty one)`] : []),
    ],
  };
}
