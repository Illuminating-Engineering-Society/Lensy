/**
 * Lucius Search Worker
 *
 * Handles all search requests against the IES standards database.
 *
 * ─── Search Pipeline ──────────────────────────────────────────────────────────
 *
 *  For each sub-query (supports comma-separated multi-queries):
 *
 *  1. Clean + expand query   (query-expander.js)
 *     "how bright should a spa be?" → "spa wellness relaxation therapeutic..."
 *
 *  2. Embed expanded query   (@cf/baai/bge-base-en-v1.5)
 *
 *  3. Vector search          (Cloudflare Vectorize, topK=30)
 *     Returns mix of:
 *       a. Application vectors  (chunk_type = 'application') → structured D1 data
 *       b. PDF chunk vectors    (chunk_type = 'text'|'table') → excerpt context
 *
 *  4. Enrich application vectors   (D1 applications table)
 *     Fetch full 68-column records for matched application codes.
 *
 *  5. Attach PDF excerpts          (D1 standards table)
 *     For each application result, find the best PDF chunk excerpt from
 *     the same standard (from step 3 chunk vectors).
 *
 *  6. Related applications         (D1 same-standard + same-category lookup)
 *     Return up to 4 related applications per result for project building.
 *
 *  7. Text search fallback         (D1 LIKE query)
 *     If vector results < 3, supplement with keyword matching.
 *
 *  8. Optional AI summary          (Workers AI, only if requested)
 *     Max 3 paragraphs, copyright-checked, collapsed by default in UI.
 *
 * ─── Request / Response ───────────────────────────────────────────────────────
 *
 *  POST /api/search
 *  {
 *    query:            string,           // required
 *    includeAISummary: boolean,          // default false
 *    filters: {
 *      indoor_outdoor: 'Indoor'|'Outdoor'|'Both',
 *      standard:       'RP-9-20',        // exact Standard field value
 *      tm24_eligible:  boolean,
 *    },
 *    limit:            number,           // default 10, max 20
 *    units:            'lux'|'fc'|'both' // default 'both'
 *  }
 *
 *  → {
 *      query:          string,           // original query
 *      expandedQuery:  string,           // after synonym expansion
 *      isMultiQuery:   boolean,
 *      results:        SearchResult[],
 *      aiSummary:      AISummary|null,
 *      timestamp:      string,
 *    }
 */

import { prepareQueryForEmbedding, splitMultiQuery, cleanQuery, isVersionComparisonQuery } from '../lib/query-expander.js';
import { generateResponse } from '../lib/ai-summary.js';
import { formatCitation } from '../lib/citations.js';

const EMBED_MODEL = '@cf/baai/bge-base-en-v1.5';
const VECTOR_TOP_K = 40;      // fetch extra; deduplicate down to limit
const MAX_LIMIT = 20;
const MIN_VECTOR_RESULTS = 3; // below this, run text fallback
const STRONG_MATCH_THRESHOLD = 0.60; // top relevanceScore below this → flag noStrongMatch

const NO_STRONG_MATCH_MESSAGE =
  "There may not be explicit lighting recommendations for that application within the current body of IES Standards. " +
  "Please review the monthly IES Ignite Newsletter for upcoming public review periods and publications. " +
  "The results below are the closest matches we found — review them for related guidance, or contact Standards@ies.org for authoritative assistance.";

// ─── Entry Point ──────────────────────────────────────────────────────────────

export async function handleSearch(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 400);
  }

  const {
    query,
    includeAISummary = false,
    filters = {},
    limit = 10,
    units = 'both',
  } = body;

  if (!query || typeof query !== 'string' || !query.trim()) {
    return jsonResponse({ error: 'query is required' }, 400);
  }

  const cleanLimit = Math.min(Math.max(1, Math.floor(limit)), MAX_LIMIT);
  const rawQuery = query.trim().substring(0, 500);

  // ── Multi-query detection ────────────────────────────────────────────────────
  const subQueries = splitMultiQuery(rawQuery);
  const isMultiQuery = subQueries.length > 1;

  // ── Version-comparison intent ("what's new", "what changed") ─────────────────
  // Signals to the UI that ADDED/REVISED should be auto-shown and REMOVED gated.
  const isVersionComparison = isVersionComparisonQuery(rawQuery);

  // ── Structural filter inference from query ───────────────────────────────────
  // A bare "LZ1 walkways" in the query string should narrow results to that
  // lighting zone even when the caller didn't pass an explicit filter.
  const inferred = inferFiltersFromQuery(rawQuery);
  const mergedFilters = { ...inferred, ...filters };

  let allResults;

  if (isMultiQuery) {
    // Fan out to individual searches, merge and deduplicate
    allResults = await runMultiSearch(subQueries, mergedFilters, cleanLimit, env);
  } else {
    allResults = await runSingleSearch(rawQuery, mergedFilters, cleanLimit, env);
  }

  // ── Related applications (top result only for performance) ───────────────────
  // Exclude only the seed itself, not the rest of the result list. If we
  // excluded all results, true sibling rows already shown in the main list
  // would be filtered out and `related` would fall through to a wider —
  // less useful — layer (cousins or banner-mates).
  if (allResults.results.length > 0) {
    const seed = allResults.results[0].application;
    allResults.results[0].relatedApplications = await getRelatedApplications(
      env,
      seed,
      [seed.code]
    );
  }

  // ── Optional AI summary ──────────────────────────────────────────────────────
  let aiSummary = null;
  if (includeAISummary && allResults.results.length > 0) {
    try {
      aiSummary = await generateResponse(
        env.AI,
        rawQuery,
        allResults.results
      );
    } catch (err) {
      console.error('AI summary error (non-fatal):', err.message);
    }
  }

  // ── Confidence flag ──────────────────────────────────────────────────────────
  // The UI uses noStrongMatch to render a yellow advisory banner above the
  // results. We never filter the list itself — the user still sees the closest
  // matches we found; we just signal that confidence is low.
  const topScore = allResults.results.length > 0
    ? (allResults.results[0].relevanceScore || 0)
    : 0;
  const noStrongMatch = topScore < STRONG_MATCH_THRESHOLD;

  return jsonResponse({
    query: rawQuery,
    expandedQuery: allResults.expandedQuery,
    isMultiQuery,
    subQueries: isMultiQuery ? subQueries : undefined,
    isVersionComparison,
    noStrongMatch,
    noStrongMatchMessage: noStrongMatch ? NO_STRONG_MATCH_MESSAGE : null,
    results: applyUnits(allResults.results, units),
    aiSummary,
    timestamp: new Date().toISOString(),
  });
}

// ─── Single Search ────────────────────────────────────────────────────────────

async function runSingleSearch(rawQuery, filters, limit, env) {
  const expandedQuery = prepareQueryForEmbedding(rawQuery);

  // 1. Embed
  const embResult = await env.AI.run(EMBED_MODEL, { text: [expandedQuery] });
  const queryVector = embResult.data[0];

  // 2. Vector search
  const vectorFilter = buildVectorFilter(filters);
  const vectorResults = await env.VECTORIZE.query(queryVector, {
    topK: VECTOR_TOP_K,
    returnMetadata: 'all',
    ...(vectorFilter ? { filter: vectorFilter } : {}),
  });

  const matches = vectorResults.matches || [];

  // 3. Split matches by type
  const appMatches = matches.filter(m => m.metadata?.chunk_type === 'application' && m.metadata?.application_code);
  const chunkMatches = matches.filter(m => m.metadata?.chunk_type !== 'application' && m.metadata?.standard_id);

  // 4. Fetch application records from D1
  const appCodes = dedupeByCode(appMatches).slice(0, limit * 2).map(m => m.metadata.application_code);
  const appMap = await fetchApplications(env.DB, appCodes, filters);

  // 5. Build excerpt index: standardId → best chunk match
  const excerptIndex = buildExcerptIndex(chunkMatches);

  // 6. Assemble results
  const scored = appMatches
    .filter(m => appMap[m.metadata.application_code])
    .map(m => ({
      score: m.score,
      app: appMap[m.metadata.application_code],
      chunkMeta: m.metadata,
    }));

  // Deduplicate, keep highest score per application code
  const deduped = deduplicateScored(scored);

  let results = deduped.slice(0, limit).map(({ score, app, chunkMeta }) =>
    buildResult(app, score, chunkMeta, excerptIndex)
  );

  // 7. Text fallback if sparse — and re-sort the merged list so fallback
  //    rows interleave by hierarchy/score with the vector hits instead of
  //    being appended in arbitrary D1 insertion order.
  if (results.length < MIN_VECTOR_RESULTS) {
    const fallback = await textFallback(env.DB, cleanQuery(rawQuery), filters, limit, excerptIndex);
    mergeResults(results, fallback);
    results.sort(compareResults);
  }

  // 8. Chunk fallback: if still no results, surface PDF chunks directly.
  //    Filter against the D1 standards table — Vectorize can hold orphan
  //    chunks from deleted/renamed standards (re-ingests with smaller chunk
  //    counts leave the tail behind), and we don't want those reaching the UI.
  if (results.length === 0 && chunkMatches.length > 0) {
    const validStandards = await fetchValidStandardIds(env.DB);
    const liveChunks = chunkMatches.filter(m => {
      const id = m.metadata?.standard_id || m.metadata?.standard_code;
      return id && validStandards.has(id);
    });
    if (liveChunks.length > 0) {
      const chunkResults = buildChunkResults(liveChunks.slice(0, limit));
      results.push(...chunkResults);
    }
  }

  return { results, expandedQuery };
}

/**
 * Lookup of every standard_id currently present in the D1 `standards` table.
 * Used to filter Vectorize chunk fallbacks so orphan vectors from previous
 * ingests don't surface to users. Runs once per request (small set: ~dozens).
 */
async function fetchValidStandardIds(db) {
  const result = await db.prepare('SELECT id FROM standards').all();
  return new Set((result.results || []).map(r => r.id));
}

// ─── Multi-Search ─────────────────────────────────────────────────────────────

async function runMultiSearch(subQueries, filters, limitPerQuery, env) {
  // Run all sub-queries in parallel; limit per sub-query = max 5 to keep total reasonable
  const perQueryLimit = Math.min(5, limitPerQuery);
  const searches = await Promise.all(
    subQueries.map(q => runSingleSearch(q, filters, perQueryLimit, env))
  );

  const seen = new Set();
  const merged = [];

  for (const search of searches) {
    for (const result of search.results) {
      if (!seen.has(result.application.code)) {
        seen.add(result.application.code);
        merged.push(result);
      }
    }
  }

  const expandedQuery = searches.map(s => s.expandedQuery).join(' | ');
  return { results: merged, expandedQuery };
}

// ─── D1 Helpers ───────────────────────────────────────────────────────────────

async function fetchApplications(db, codes, filters = {}) {
  if (codes.length === 0) return {};

  const placeholders = codes.map(() => '?').join(',');
  let sql = `SELECT * FROM applications WHERE code IN (${placeholders}) AND Active = 1`;
  const bindings = [...codes];

  // Apply filters at D1 level as well (Vectorize filter is best-effort)
  if (filters.indoor_outdoor && filters.indoor_outdoor !== 'Both') {
    sql += ' AND (Indoor_Outdoor = ? OR Indoor_Outdoor = ?)';
    bindings.push(filters.indoor_outdoor, 'Both');
  }
  if (filters.standard) {
    sql += ' AND Standard = ?';
    bindings.push(filters.standard);
  }
  if (filters.standard_prefix) {
    sql += ' AND Standard LIKE ?';
    bindings.push(`${filters.standard_prefix}-%`);
  }
  if (filters.tm24_eligible) {
    sql += ' AND TM24_Eligible = 1';
  }
  if (filters.lighting_zone) {
    sql += ' AND Lighting_Zone = ?';
    bindings.push(filters.lighting_zone);
  }

  const result = await db.prepare(sql).bind(...bindings).all();
  return Object.fromEntries(result.results.map(a => [a.code, a]));
}

async function getRelatedApplications(env, application, excludeCodes) {
  if (!application) return [];

  const TARGET = 4;
  const collected = new Map(); // code → row, preserves insertion order
  const exclude = new Set(excludeCodes);

  /**
   * Sibling layers, narrowest to widest. Each layer adds rows that share
   * progressively less hierarchy with the seed application:
   *
   *   1. Same App_s1 (true siblings — e.g. other Playground rows)
   *   2. Same App   (cousins — e.g. Stairs and Ramps under the same category)
   *   3. Same Standard, same Sub_Category banner (distant relatives)
   *
   * We stop as soon as we have TARGET rows.
   */
  const layers = [
    { App: application.category, App_s1: application.sub1 },
    { App: application.category },
    { Sub_Category: application.subCategory },
  ];

  for (const filters of layers) {
    if (collected.size >= TARGET) break;

    const conditions = ['Active = 1', 'Standard = ?'];
    const bindings = [application.standard];
    for (const [col, val] of Object.entries(filters)) {
      if (val == null) { conditions.length = 0; break; } // skip layer if filter value is null
      conditions.push(`${col} = ?`);
      bindings.push(val);
    }
    if (conditions.length === 0) continue;

    const remaining = TARGET - collected.size;
    const sql = `
      SELECT code, App, App_s1, App_s2, App_s3, Standard, Standard_Full,
             Hor_Lux, Ver_Lux, Row_Ref
      FROM applications
      WHERE ${conditions.join(' AND ')}
      LIMIT ?
    `;
    bindings.push(remaining + collected.size + exclude.size);

    const result = await env.DB.prepare(sql).bind(...bindings).all();

    for (const row of result.results) {
      if (exclude.has(row.code) || collected.has(row.code)) continue;
      collected.set(row.code, row);
      if (collected.size >= TARGET) break;
    }
  }

  // Order siblings the same way the main result list does (hierarchy + row#)
  const ordered = [...collected.values()].sort((a, b) => {
    for (const key of ['App_s1', 'App_s2', 'App_s3']) {
      const cmp = compareHierarchyField(a[key], b[key]);
      if (cmp !== 0) return cmp;
    }
    return rowRefNumber(a.Row_Ref) - rowRefNumber(b.Row_Ref);
  });

  return ordered.map(a => ({
    code: a.code,
    fullName: [a.App, a.App_s1, a.App_s2, a.App_s3].filter(Boolean).join(' → '),
    standard: a.Standard,
    standardFull: a.Standard_Full,
    horLux: a.Hor_Lux,
    verLux: a.Ver_Lux,
  }));
}

// ─── Text Fallback ────────────────────────────────────────────────────────────

async function textFallback(db, query, filters, limit, excerptIndex) {
  const terms = query.toLowerCase().split(/\s+/).filter(t => t.length >= 3).slice(0, 4);
  if (terms.length === 0) return [];

  // Build LIKE clauses across all hierarchy columns. Use AND between terms
  // (each term must match SOME column) so a query like "playground lighting"
  // does not also surface every row containing the word "lighting" alone.
  const cols = ['App', 'App_s1', 'App_s2', 'App_s3', 'App_Notes'];
  const likeClause = terms.map(() =>
    `(${cols.map(c => `LOWER(${c}) LIKE ?`).join(' OR ')})`
  ).join(' AND ');
  const likeBindings = terms.flatMap(t => cols.map(() => `%${t}%`));

  let sql = `SELECT * FROM applications WHERE Active = 1 AND (${likeClause})`;
  const bindings = [...likeBindings];

  if (filters.indoor_outdoor && filters.indoor_outdoor !== 'Both') {
    sql += ' AND (Indoor_Outdoor = ? OR Indoor_Outdoor = ?)';
    bindings.push(filters.indoor_outdoor, 'Both');
  }
  if (filters.standard) {
    sql += ' AND Standard = ?';
    bindings.push(filters.standard);
  }
  if (filters.standard_prefix) {
    sql += ' AND Standard LIKE ?';
    bindings.push(`${filters.standard_prefix}-%`);
  }
  if (filters.tm24_eligible) {
    sql += ' AND TM24_Eligible = 1';
  }
  if (filters.lighting_zone) {
    sql += ' AND Lighting_Zone = ?';
    bindings.push(filters.lighting_zone);
  }

  sql += ' LIMIT ?';
  bindings.push(limit * 2);

  const result = await db.prepare(sql).bind(...bindings).all();
  return result.results.map(app =>
    buildResult(app, 0, null, excerptIndex)
  );
}

// ─── Result Builder ───────────────────────────────────────────────────────────

function buildResult(app, score, chunkMeta, excerptIndex) {
  const formatted = formatApplication(app);
  // Pass the application's own page (where its table row lives), not the
  // excerpt's page — the citation should point at the source row, while
  // the excerpt's pageNumber stays in the excerpt object.
  const citation = formatCitation(app, null, app.Page_Number ?? null);
  const vitriumLink = buildVitriumLink(app);

  // Find the best PDF excerpt for this application — preferring a chunk
  // near the application's table page over a globally top-scored chunk.
  const excerpt = pickExcerptForApp(excerptIndex, app);

  return {
    application: formatted,
    relevanceScore: Math.round(score * 1000) / 1000,
    excerpt: excerpt ? {
      text: excerpt.excerpt_text,
      pageNumber: excerpt.page_number,
      section: excerpt.section,
    } : null,
    citation,
    vitriumLink,
    relatedApplications: [], // filled in for top result only
  };
}

/**
 * Build a lookup of standardId → array of chunk matches (sorted by score).
 *
 * Stores ALL chunks per standard rather than only the top-scored one, so
 * each application result can later pick a chunk from a page near its
 * table — this avoids attaching the same generic excerpt to every row of
 * the same standard.
 */
function buildExcerptIndex(chunkMatches) {
  const index = {};
  for (const match of chunkMatches) {
    const stdId = match.metadata?.standard_id;
    if (!stdId) continue;
    if (!index[stdId]) index[stdId] = [];
    index[stdId].push({ ...match.metadata, score: match.score });
  }
  // Sort each bucket by score desc so the fallback path picks the best chunk.
  for (const stdId in index) {
    index[stdId].sort((a, b) => b.score - a.score);
  }
  return index;
}

/**
 * Pick the best PDF excerpt for a given application.
 *
 *  1. If the app has a Page_Number, prefer chunks within ±5 pages of that
 *     page. Among those, pick the highest-scoring NON-table chunk first —
 *     raw table dumps make poor excerpts because they read as truncated
 *     numbers when shown out of context. Tables are kept only as a last
 *     resort.
 *  2. Otherwise (or if no nearby chunk exists), fall back to the highest-
 *     scoring chunk for the standard, again preferring non-table.
 *  3. If the standard has no chunk matches at all, return null.
 */
function pickExcerptForApp(excerptIndex, app) {
  const bucket = excerptIndex[app.Standard];
  if (!bucket || bucket.length === 0) return null;

  const isTable = (c) => c.chunk_type === 'table';
  const appPage = app.Page_Number;

  if (appPage != null) {
    const NEAR_RADIUS = 5;
    const inRadius = bucket.filter(c => c.page_number != null && Math.abs(c.page_number - appPage) <= NEAR_RADIUS);
    const pickNearest = (pool) => {
      let best = null, bestDist = Infinity;
      for (const c of pool) {
        const dist = Math.abs(c.page_number - appPage);
        if (dist < bestDist || (dist === bestDist && (!best || c.score > best.score))) {
          best = c; bestDist = dist;
        }
      }
      return best;
    };
    const prose = inRadius.filter(c => !isTable(c));
    if (prose.length > 0) return pickNearest(prose);
    if (inRadius.length > 0) return pickNearest(inRadius);
  }

  // Global fallback: highest-scoring prose chunk; table only if nothing else.
  const proseAll = bucket.filter(c => !isTable(c));
  return proseAll[0] || bucket[0];
}

// ─── Application Formatter ────────────────────────────────────────────────────

function formatApplication(app) {
  return {
    code: app.code,
    // Hierarchy
    category:  app.App,
    sub1:      app.App_s1,
    sub2:      app.App_s2,
    sub3:      app.App_s3,
    fullName:  [app.App, app.App_s1, app.App_s2, app.App_s3, app.App_s4, app.App_s5, app.App_s6].filter(Boolean).join(' → '),
    // Standard
    standard:      app.Standard,
    standardFull:  app.Standard_Full,
    tableRef:      app.Table_Ref,
    rowRef:        app.Row_Ref,
    linkMapping:   app.Link_Mapping,
    // Type
    areaOrTask:    app.Area_or_Task,
    indoorOutdoor: app.Indoor_Outdoor,
    veilingRisk:   app.Veiling_Risk,
    classOfPlay:   app.Class_of_Play,
    subCategory:   app.Sub_Category,
    sub4:          app.App_s4,
    sub5:          app.App_s5,
    sub6:          app.App_s6,
    // Horizontal Illuminance
    horizontal: app.Hor_Lux != null ? {
      category:   app.Hor_Cat,
      lux:        app.Hor_Lux,
      fc:         app.Hor_Fc,
      heightM:    app.Hor_Height_m,
      heightFt:   app.Hor_Height_ft,
      avgMaxMin:  app.Hor_Avg_Max_Min,
      uniformity: app.Hor_Uniformity,
      cv:         app.Hor_CV,
      ratioBasis: app.Hor_Ratio_Basis,
      notes:      app.Hor_Notes,
    } : null,
    // Vertical Illuminance
    vertical: app.Ver_Lux != null ? {
      category:   app.Ver_Cat,
      lux:        app.Ver_Lux,
      fc:         app.Ver_Fc,
      heightM:    app.Ver_Height_m,
      heightFt:   app.Ver_Height_ft,
      avgMaxMin:  app.Ver_Avg_Max_Min,
      uniformity: app.Ver_Uniformity,
      cv:         app.Ver_CV,
      ratioBasis: app.Ver_Ratio_Basis,
      notes:      app.Ver_Notes,
    } : null,
    // Task Illuminance
    task: app.Task_Lux != null ? {
      category:   app.Task_Cat,
      lux:        app.Task_Lux,
      fc:         app.Task_Fc,
      heightM:    app.Task_Height_m,
      heightFt:   app.Task_Height_ft,
      avgMaxMin:  app.Task_Avg_Max_Min,
      uniformity: app.Task_Uniformity,
      notes:      app.Task_Notes,
    } : null,
    // TM-24
    tm24Eligible: !!app.TM24_Eligible,
    tm24Notes:    app.TM24_Notes,
    // Outdoor guidance (only for outdoor/both applications)
    outdoor: (app.Indoor_Outdoor === 'Outdoor' || app.Indoor_Outdoor === 'Both') ? {
      lightingZone:     app.Lighting_Zone,
      maxGlareRating:   app.Max_Glare_Rating,
      maxUplight:       app.Max_Uplight,
      curfewDimming:    app.Curfew_Dimming,
      spectrumGuidance: app.Spectrum_Guidance,
      controlsRequired: app.Controls_Required,
    } : null,
    // Notes
    footnotes:    app.Footnotes,
    generalNotes: app.General_Notes,
    appNotes:     app.App_Notes,
  };
}

// ─── Unit Filtering ───────────────────────────────────────────────────────────

/**
 * Strip lux or fc fields based on user preference.
 * Default is 'both' — only strip when explicitly requested.
 */
function applyUnits(results, units) {
  if (units === 'both' || !units) return results;

  return results.map(r => {
    const app = { ...r.application };
    for (const block of ['horizontal', 'vertical', 'task']) {
      if (!app[block]) continue;
      if (units === 'lux') {
        const { fc, heightFt, ...rest } = app[block]; // eslint-disable-line no-unused-vars
        app[block] = rest;
      } else if (units === 'fc') {
        const { lux, heightM, ...rest } = app[block]; // eslint-disable-line no-unused-vars
        app[block] = rest;
      }
    }
    return { ...r, application: app };
  });
}

// ─── Chunk Fallback Builder ───────────────────────────────────────────────────
// When no structured application records exist yet, surface PDF chunks directly.

function buildChunkResults(chunkMatches) {
  // Group by standard_id, keep best chunk per standard
  const byStandard = new Map();
  for (const match of chunkMatches) {
    const stdId = match.metadata?.standard_id || match.metadata?.standard_code;
    if (!stdId) continue;
    if (!byStandard.has(stdId) || byStandard.get(stdId).score < match.score) {
      byStandard.set(stdId, match);
    }
  }

  return [...byStandard.entries()].map(([stdId, match]) => ({
    application: {
      code: match.id,
      category: stdId,
      sub1: null,
      sub2: null,
      sub3: null,
      fullName: stdId,
      standard: stdId,
      standardFull: match.metadata?.standard_code || stdId,
      tableRef: null,
      rowRef: null,
      areaOrTask: null,
      indoorOutdoor: match.metadata?.indoor_outdoor || null,
      horizontal: null,
      vertical: null,
      task: null,
      tm24Eligible: false,
      tm24Notes: null,
      outdoor: null,
      footnotes: null,
      generalNotes: null,
      appNotes: null,
    },
    relevanceScore: Math.round((match.score || 0) * 1000) / 1000,
    excerpt: {
      text: match.metadata?.excerpt_text || '',
      pageNumber: match.metadata?.page_number || null,
      section: match.metadata?.section || null,
      chunkType: match.metadata?.chunk_type || 'text',
    },
    citation: match.metadata?.standard_code
      ? `${match.metadata.standard_code}${match.metadata.page_number ? `, p. ${match.metadata.page_number}` : ''}`
      : stdId,
    vitriumLink: null,
    relatedApplications: [],
  }));
}

// ─── Utility Helpers ──────────────────────────────────────────────────────────

function buildVectorFilter(filters) {
  const f = {};
  if (filters.indoor_outdoor && filters.indoor_outdoor !== 'Both') {
    f.indoor_outdoor = filters.indoor_outdoor;
  }
  if (filters.standard) f.standard_code = filters.standard;
  if (filters.tm24_eligible) f.tm24_eligible = true;
  // Lighting_Zone is not stored in vector metadata today, so we rely on the
  // D1-level filter applied in fetchApplications/textFallback. Leaving the
  // vector filter open keeps recall while D1 narrows the final set.
  return Object.keys(f).length > 0 ? f : null;
}

/**
 * Infer structural filters from the raw query string.
 *   - "LZ0".."LZ4" (case-insensitive) → filters.lighting_zone = "LZ<n>"
 *   - For "what's new in RP-43" / "what changed in TM-24" style queries,
 *     pin the search to the mentioned standard so unrelated results don't
 *     drown out the comparison target.
 *
 * Caller-supplied filters take precedence (see mergedFilters in handleSearch).
 */
function inferFiltersFromQuery(query) {
  const out = {};

  const lzMatch = /\b(?:lz)\s*([0-4])\b/i.exec(query);
  if (lzMatch) out.lighting_zone = `LZ${lzMatch[1]}`;

  // Only constrain to a specific standard for version-comparison intent.
  // Outside that intent, mentioning a standard ID in passing should not
  // hide adjacent standards from the result list.
  //
  // Use standard_prefix (LIKE) rather than standard (=) because users say
  // "RP-43" but the D1 Standard column carries the year suffix ("RP-43-25").
  if (isVersionComparisonQuery(query)) {
    const stdMatch = /\b((?:RP|TM|HB|LM|LP|LS|G)-\d+)\b/i.exec(query);
    if (stdMatch) out.standard_prefix = stdMatch[1].toUpperCase();
  }

  return out;
}

function dedupeByCode(matches) {
  const seen = new Map();
  for (const m of matches) {
    const code = m.metadata?.application_code;
    if (!code) continue;
    if (!seen.has(code) || seen.get(code).score < m.score) {
      seen.set(code, m);
    }
  }
  return [...seen.values()].sort((a, b) => b.score - a.score);
}

function deduplicateScored(scored) {
  const seen = new Map();
  for (const item of scored) {
    const code = item.app.code;
    if (!seen.has(code) || seen.get(code).score < item.score) {
      seen.set(code, item);
    }
  }
  return [...seen.values()].sort(compareScoredApps);
}

/**
 * Tie-break ordering for scored application results.
 *
 * Vector search frequently produces near-identical scores for siblings of
 * the same hierarchy bucket (e.g. all Playground Lz1–Lz4 rows score
 * ~0.74–0.75). Without a stable tie-break, Vectorize's internal ordering
 * leaks through and the UI shows Lz1 → Lz1 → Lz4 → Lz3 → ... which is
 * confusing. We sort ties by hierarchy then by the row number embedded in
 * Row_Ref so siblings appear in the same order as in the source standard.
 *
 * Score equality uses a 0.01 epsilon — anything tighter is treated as a
 * tie because Vectorize's scores are not meaningfully different at that
 * resolution.
 */
function compareScoredApps(a, b) {
  const SCORE_EPSILON = 0.01;
  const scoreDiff = b.score - a.score;
  if (Math.abs(scoreDiff) > SCORE_EPSILON) return scoreDiff;

  const A = a.app, B = b.app;
  const hierarchyKeys = ['Sub_Category', 'App', 'App_s1', 'App_s2', 'App_s3', 'App_s4'];
  for (const key of hierarchyKeys) {
    const cmp = compareHierarchyField(A[key], B[key]);
    if (cmp !== 0) return cmp;
  }
  return rowRefNumber(A.Row_Ref) - rowRefNumber(B.Row_Ref);
}

/**
 * Same tie-break logic as compareScoredApps, but for the formatted
 * `result` shape returned by buildResult (used after a fallback merge).
 */
function compareResults(a, b) {
  const SCORE_EPSILON = 0.01;
  const scoreDiff = (b.relevanceScore || 0) - (a.relevanceScore || 0);
  if (Math.abs(scoreDiff) > SCORE_EPSILON) return scoreDiff;

  const A = a.application, B = b.application;
  const hierarchyKeys = ['subCategory', 'category', 'sub1', 'sub2', 'sub3', 'sub4'];
  for (const key of hierarchyKeys) {
    const cmp = compareHierarchyField(A[key], B[key]);
    if (cmp !== 0) return cmp;
  }
  return rowRefNumber(A.rowRef) - rowRefNumber(B.rowRef);
}

/**
 * Compare two hierarchy field values with IES-aware ordering:
 *   - nulls sort last
 *   - Lighting-zone strings (Lz0…Lz4) sort numerically
 *   - "Lower limit" sorts before "Upper limit"
 *   - everything else falls back to case-insensitive lexicographic
 */
function compareHierarchyField(a, b) {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;

  const lzA = /^Lz(\d)/i.exec(String(a));
  const lzB = /^Lz(\d)/i.exec(String(b));
  if (lzA && lzB) return Number(lzA[1]) - Number(lzB[1]);

  const isLowerA = /lower\s+limit/i.test(a);
  const isLowerB = /lower\s+limit/i.test(b);
  const isUpperA = /upper\s+limit/i.test(a);
  const isUpperB = /upper\s+limit/i.test(b);
  if (isLowerA && isUpperB) return -1;
  if (isUpperA && isLowerB) return 1;

  return String(a).toLowerCase().localeCompare(String(b).toLowerCase());
}

function rowRefNumber(rowRef) {
  if (!rowRef) return Number.MAX_SAFE_INTEGER;
  const m = /(\d+)/.exec(String(rowRef));
  return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
}

function mergeResults(primary, fallback) {
  const seen = new Set(primary.map(r => r.application.code));
  for (const item of fallback) {
    if (!seen.has(item.application.code)) {
      primary.push(item);
      seen.add(item.application.code);
    }
  }
}

function buildVitriumLink(app) {
  if (app.Vitrium_Deep_Link) return app.Vitrium_Deep_Link;
  if (app.Vitrium_Doc_ID && app.Link_Mapping) {
    return `https://vitrium.ies.org/document/${app.Vitrium_Doc_ID}#${app.Link_Mapping}`;
  }
  return null;
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
