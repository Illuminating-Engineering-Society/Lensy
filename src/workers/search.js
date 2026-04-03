/**
 * Lucius Search Worker
 * Handles semantic vector search against Vectorize + structured lookup from D1.
 *
 * Flow:
 *  1. Embed user query via Workers AI (@cf/baai/bge-base-en-v1.5)
 *  2. Query Vectorize for top-k matching chunks
 *  3. Enrich with structured data from D1 applications table
 *  4. Optionally generate AI summary via Claude API
 *  5. Return formatted results with citations
 */

import { generateEmbeddings } from '../lib/embeddings.js';
import { generateResponse } from '../lib/claude.js';
import { formatCitation } from '../lib/citations.js';

const TOP_K = 20;

export async function handleSearch(request, env) {
  const body = await request.json();
  const {
    query,
    includeAISummary = false,
    filters = {},
    limit = 10,
  } = body;

  if (!query || typeof query !== 'string' || query.trim().length === 0) {
    return jsonResponse({ error: 'query is required' }, 400);
  }

  const cleanQuery = query.trim().substring(0, 500); // max 500 chars

  // ── 1. Generate query embedding ─────────────────────────────────────────────
  const queryEmbedding = await env.AI.run('@cf/baai/bge-base-en-v1.5', {
    text: [cleanQuery],
  });

  const queryVector = queryEmbedding.data[0];

  // ── 2. Vector search ─────────────────────────────────────────────────────────
  const vectorFilter = buildVectorFilter(filters);
  const searchResults = await env.VECTORIZE.query(queryVector, {
    topK: TOP_K,
    returnMetadata: 'all',
    ...(vectorFilter ? { filter: vectorFilter } : {}),
  });

  if (!searchResults.matches || searchResults.matches.length === 0) {
    return jsonResponse({
      query: cleanQuery,
      results: [],
      aiSummary: null,
      timestamp: new Date().toISOString(),
    });
  }

  // ── 3. Structured lookup from D1 ────────────────────────────────────────────
  // Extract unique application codes from vector results
  const appCodes = [...new Set(
    searchResults.matches
      .map(m => m.metadata?.application_code)
      .filter(Boolean)
  )].slice(0, limit);

  const placeholders = appCodes.map(() => '?').join(',');
  const appsResult = await env.DB.prepare(
    `SELECT * FROM applications WHERE code IN (${placeholders}) AND Active = 1`
  ).bind(...appCodes).all();

  const appMap = Object.fromEntries(
    appsResult.results.map(a => [a.code, a])
  );

  // ── 4. Format results ────────────────────────────────────────────────────────
  // Re-order by vector score; attach structured data
  const scored = searchResults.matches
    .filter(m => m.metadata?.application_code && appMap[m.metadata.application_code])
    .map(m => ({
      score: m.score,
      application: appMap[m.metadata.application_code],
      chunk: m.metadata,
    }));

  // Deduplicate by application code, keep highest score
  const deduped = deduplicateByCode(scored);

  const formattedResults = deduped.slice(0, limit).map(({ score, application, chunk }) => ({
    application: formatApplication(application),
    relevanceScore: Math.round(score * 1000) / 1000,
    excerpt: chunk.excerpt_text || null,
    pageNumber: chunk.page_number || null,
    citation: formatCitation(application),
    vitriumLink: buildVitriumLink(application),
    relatedApplications: [],  // populated by getRelated() in Phase 2
  }));

  // Also do a direct text search fallback if vector results are sparse
  if (formattedResults.length < 3) {
    const fallback = await textSearchFallback(env, cleanQuery, filters, limit);
    mergeResults(formattedResults, fallback);
  }

  // ── 5. Optional AI summary ───────────────────────────────────────────────────
  let aiSummary = null;
  if (includeAISummary && formattedResults.length > 0 && env.ANTHROPIC_API_KEY) {
    try {
      aiSummary = await generateResponse(
        env.ANTHROPIC_API_KEY,
        cleanQuery,
        formattedResults
      );
    } catch (err) {
      console.error('AI summary failed:', err.message);
      // Non-fatal: return results without AI summary
    }
  }

  return jsonResponse({
    query: cleanQuery,
    results: formattedResults,
    aiSummary,
    timestamp: new Date().toISOString(),
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildVectorFilter(filters) {
  // Vectorize metadata filters (must match fields set during upsert)
  const filter = {};
  if (filters.indoor_outdoor) filter.indoor_outdoor = filters.indoor_outdoor;
  if (filters.standard) filter.standard_code = filters.standard;
  if (filters.tm24_eligible) filter.tm24_eligible = true;
  return Object.keys(filter).length > 0 ? filter : null;
}

function deduplicateByCode(scored) {
  const seen = new Map();
  for (const item of scored) {
    const code = item.application.code;
    if (!seen.has(code) || seen.get(code).score < item.score) {
      seen.set(code, item);
    }
  }
  return [...seen.values()].sort((a, b) => b.score - a.score);
}

function formatApplication(app) {
  // Build a clean display object from the 68-column DB row
  return {
    code: app.code,
    // Hierarchy
    category: app.App,
    sub1: app.App_s1,
    sub2: app.App_s2,
    sub3: app.App_s3,
    fullName: [app.App, app.App_s1, app.App_s2, app.App_s3]
      .filter(Boolean).join(' → '),
    // Standard
    standard: app.Standard,
    standardFull: app.Standard_Full,
    tableRef: app.Table_Ref,
    rowRef: app.Row_Ref,
    // Type
    areaOrTask: app.Area_or_Task,
    indoorOutdoor: app.Indoor_Outdoor,
    // Horizontal Illuminance
    horizontal: app.Hor_Lux != null ? {
      category: app.Hor_Cat,
      lux: app.Hor_Lux,
      fc: app.Hor_Fc,
      heightM: app.Hor_Height_m,
      heightFt: app.Hor_Height_ft,
      avgMaxMin: app.Hor_Avg_Max_Min,
      uniformity: app.Hor_Uniformity,
      notes: app.Hor_Notes,
    } : null,
    // Vertical Illuminance
    vertical: app.Ver_Lux != null ? {
      category: app.Ver_Cat,
      lux: app.Ver_Lux,
      fc: app.Ver_Fc,
      heightM: app.Ver_Height_m,
      heightFt: app.Ver_Height_ft,
      avgMaxMin: app.Ver_Avg_Max_Min,
      uniformity: app.Ver_Uniformity,
      notes: app.Ver_Notes,
    } : null,
    // Task Illuminance
    task: app.Task_Lux != null ? {
      category: app.Task_Cat,
      lux: app.Task_Lux,
      fc: app.Task_Fc,
      heightM: app.Task_Height_m,
      heightFt: app.Task_Height_ft,
      avgMaxMin: app.Task_Avg_Max_Min,
      uniformity: app.Task_Uniformity,
      notes: app.Task_Notes,
    } : null,
    // TM-24
    tm24Eligible: !!app.TM24_Eligible,
    tm24Notes: app.TM24_Notes,
    // Outdoor
    outdoor: app.Indoor_Outdoor !== 'Indoor' ? {
      lightingZone: app.Lighting_Zone,
      maxGlareRating: app.Max_Glare_Rating,
      maxUplight: app.Max_Uplight,
      curfewDimming: app.Curfew_Dimming,
      spectrumGuidance: app.Spectrum_Guidance,
      controlsRequired: app.Controls_Required,
    } : null,
    // Notes
    footnotes: app.Footnotes,
    generalNotes: app.General_Notes,
    appNotes: app.App_Notes,
  };
}

function buildVitriumLink(app) {
  if (app.Vitrium_Deep_Link) return app.Vitrium_Deep_Link;
  if (app.Vitrium_Doc_ID && app.Link_Mapping) {
    return `https://vitrium.ies.org/document/${app.Vitrium_Doc_ID}#${app.Link_Mapping}`;
  }
  return null;
}

async function textSearchFallback(env, query, filters, limit) {
  // Simple LIKE-based fallback for when vector results are sparse
  const terms = query.toLowerCase().split(/\s+/).slice(0, 3);
  const likeClause = terms.map(() => `(
    LOWER(App) LIKE ? OR LOWER(App_s1) LIKE ? OR LOWER(App_s2) LIKE ?
  )`).join(' OR ');
  const likeBindings = terms.flatMap(t => [`%${t}%`, `%${t}%`, `%${t}%`]);

  let sql = `SELECT * FROM applications WHERE Active = 1 AND (${likeClause})`;
  const bindings = [...likeBindings];

  if (filters.indoor_outdoor) {
    sql += ' AND Indoor_Outdoor = ?';
    bindings.push(filters.indoor_outdoor);
  }
  if (filters.standard) {
    sql += ' AND Standard = ?';
    bindings.push(filters.standard);
  }

  sql += ' LIMIT ?';
  bindings.push(limit);

  const result = await env.DB.prepare(sql).bind(...bindings).all();
  return result.results.map(app => ({
    application: formatApplication(app),
    relevanceScore: 0,
    excerpt: null,
    pageNumber: null,
    citation: formatCitation(app),
    vitriumLink: buildVitriumLink(app),
    relatedApplications: [],
  }));
}

function mergeResults(primary, fallback) {
  const existingCodes = new Set(primary.map(r => r.application.code));
  for (const item of fallback) {
    if (!existingCodes.has(item.application.code)) {
      primary.push(item);
    }
  }
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
