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
 *  2. Embed expanded query   (Workers AI @cf/baai/bge-base-en-v1.5)
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
 *  8. Optional AI summary          (Claude API, only if requested)
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

import { prepareQueryForEmbedding, splitMultiQuery, cleanQuery } from '../lib/query-expander.js';
import { generateResponse } from '../lib/claude.js';
import { formatCitation } from '../lib/citations.js';

const EMBED_MODEL = '@cf/baai/bge-base-en-v1.5';
const VECTOR_TOP_K = 40;      // fetch extra; deduplicate down to limit
const MAX_LIMIT = 20;
const MIN_VECTOR_RESULTS = 3; // below this, run text fallback

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

  let allResults;

  if (isMultiQuery) {
    // Fan out to individual searches, merge and deduplicate
    allResults = await runMultiSearch(subQueries, filters, cleanLimit, env);
  } else {
    allResults = await runSingleSearch(rawQuery, filters, cleanLimit, env);
  }

  // ── Related applications (top result only for performance) ───────────────────
  if (allResults.results.length > 0) {
    allResults.results[0].relatedApplications = await getRelatedApplications(
      env,
      allResults.results[0].application,
      allResults.results.map(r => r.application.code)
    );
  }

  // ── Optional AI summary ──────────────────────────────────────────────────────
  let aiSummary = null;
  if (includeAISummary && allResults.results.length > 0 && env.ANTHROPIC_API_KEY) {
    try {
      aiSummary = await generateResponse(
        env.ANTHROPIC_API_KEY,
        rawQuery,
        allResults.results
      );
    } catch (err) {
      console.error('AI summary error (non-fatal):', err.message);
    }
  }

  return jsonResponse({
    query: rawQuery,
    expandedQuery: allResults.expandedQuery,
    isMultiQuery,
    subQueries: isMultiQuery ? subQueries : undefined,
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

  // 7. Text fallback if sparse
  if (results.length < MIN_VECTOR_RESULTS) {
    const fallback = await textFallback(env.DB, cleanQuery(rawQuery), filters, limit, excerptIndex);
    mergeResults(results, fallback);
  }

  return { results, expandedQuery };
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
  if (filters.tm24_eligible) {
    sql += ' AND TM24_Eligible = 1';
  }

  const result = await db.prepare(sql).bind(...bindings).all();
  return Object.fromEntries(result.results.map(a => [a.code, a]));
}

async function getRelatedApplications(env, application, excludeCodes) {
  if (!application) return [];

  // Strategy 1: same standard, same top-level category, different application
  const sql = `
    SELECT code, App, App_s1, App_s2, Standard, Standard_Full, Hor_Lux, Ver_Lux
    FROM applications
    WHERE Active = 1
      AND Standard = ?
      AND App = ?
      AND code NOT IN (${excludeCodes.map(() => '?').join(',')})
    ORDER BY App_s1, App_s2
    LIMIT 4
  `;

  const result = await env.DB.prepare(sql)
    .bind(application.standard, application.category, ...excludeCodes)
    .all();

  return result.results.map(a => ({
    code: a.code,
    fullName: [a.App, a.App_s1, a.App_s2].filter(Boolean).join(' → '),
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

  // Build LIKE clauses across all hierarchy columns
  const cols = ['App', 'App_s1', 'App_s2', 'App_s3', 'App_Notes'];
  const likeClause = terms.map(() =>
    `(${cols.map(c => `LOWER(${c}) LIKE ?`).join(' OR ')})`
  ).join(' OR ');
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
  if (filters.tm24_eligible) {
    sql += ' AND TM24_Eligible = 1';
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
  const citation = formatCitation(app);
  const vitriumLink = buildVitriumLink(app);

  // Find the best PDF excerpt for this standard
  const excerpt = excerptIndex[app.Standard] || null;

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
 * Build a lookup of standardId → best chunk match for attaching
 * PDF excerpts to application results.
 */
function buildExcerptIndex(chunkMatches) {
  const index = {};
  for (const match of chunkMatches) {
    const stdId = match.metadata?.standard_id;
    if (!stdId) continue;
    // Keep highest-scoring chunk per standard
    if (!index[stdId] || index[stdId].score < match.score) {
      index[stdId] = { ...match.metadata, score: match.score };
    }
  }
  return index;
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
    fullName:  [app.App, app.App_s1, app.App_s2, app.App_s3].filter(Boolean).join(' → '),
    // Standard
    standard:      app.Standard,
    standardFull:  app.Standard_Full,
    tableRef:      app.Table_Ref,
    rowRef:        app.Row_Ref,
    linkMapping:   app.Link_Mapping,
    // Type
    areaOrTask:    app.Area_or_Task,
    indoorOutdoor: app.Indoor_Outdoor,
    // Horizontal Illuminance
    horizontal: app.Hor_Lux != null ? {
      category:   app.Hor_Cat,
      lux:        app.Hor_Lux,
      fc:         app.Hor_Fc,
      heightM:    app.Hor_Height_m,
      heightFt:   app.Hor_Height_ft,
      avgMaxMin:  app.Hor_Avg_Max_Min,
      uniformity: app.Hor_Uniformity,
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

// ─── Utility Helpers ──────────────────────────────────────────────────────────

function buildVectorFilter(filters) {
  const f = {};
  if (filters.indoor_outdoor && filters.indoor_outdoor !== 'Both') {
    f.indoor_outdoor = filters.indoor_outdoor;
  }
  if (filters.standard) f.standard_code = filters.standard;
  if (filters.tm24_eligible) f.tm24_eligible = true;
  return Object.keys(f).length > 0 ? f : null;
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
  return [...seen.values()].sort((a, b) => b.score - a.score);
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
