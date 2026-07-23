/**
 * Lensy Search Worker
 *
 * Handles all search requests against the IES standards database.
 *
 * ─── Search Pipeline ──────────────────────────────────────────────────────────
 *
 *  0. Response cache check   (KV, keyed by params + corpus data version)
 *     On hit, the entire pipeline below is skipped — no Workers AI,
 *     Vectorize, or D1 usage. Invalidated automatically on ingest.
 *
 *  For each sub-query (supports comma-separated multi-queries):
 *
 *  1. Clean + expand query   (query-expander.js)
 *     "how bright should a spa be?" → "spa wellness relaxation therapeutic..."
 *
 *  2. Embed expanded query   (@cf/baai/bge-base-en-v1.5, KV-cached)
 *
 *  3. Vector search          (Cloudflare Vectorize, topK=50)
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
 *    limit:            number,           // default 10, max 30
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

import { prepareQueryForEmbedding, splitMultiQuery, cleanQuery, isVersionComparisonQuery, isReferenceQuery } from '../lib/query-expander';
import { generateResponse } from '../lib/ai-summary';
import { formatCitation, composeStandardName } from '../lib/citations';
import {
  getDataVersion,
  buildSearchCacheKey,
  getCachedSearch,
  putCachedSearch,
  getCachedEmbedding,
  putCachedEmbedding,
  buildAISummaryCacheKey,
  getCachedAISummary,
  putCachedAISummary,
} from '../lib/cache';
import standardsSchema from '../config/standards-schema.json';
import type {
  ApplicationRow, ContentType, FootnoteMarks, FormattedApplication, ReferenceLink,
  RelatedApplication, SearchFilters, SearchResult, StandardIndexEntry, StandardRow, StandardsIndex, VectorMetadata,
} from '../types';

// ── Local shapes for internal plumbing ──────────────────────────────────────
type LinkCtx = { standardsIndex?: StandardsIndex };
type VMatch = { id: string; score: number; values?: number[]; metadata?: Partial<VectorMetadata> };
type ExcerptChunk = Partial<VectorMetadata> & { score: number };
type ExcerptIndex = Record<string, ExcerptChunk[]>;
type ScoredApp = { score: number; app: ApplicationRow; chunkMeta?: Partial<VectorMetadata> };
type DepDbg = Record<string, unknown>;
type SearchOutput = { results: SearchResult[]; expandedQuery: string };

// NOTE: this previously returned `errMsg(err)` for Error instances — infinite
// recursion that turned ANY caught Error into a RangeError inside the catch
// block, escalating "non-fatal" failures (AI summary, backfills, probes) into
// failed requests. Likely contributor to the "AI Guide never populates" report.
function errMsg(err: unknown): string { return err instanceof Error ? err.message : String(err); }

const EMBED_MODEL = '@cf/baai/bge-base-en-v1.5';
const VECTOR_TOP_K = 50;      // Vectorize caps topK at 50 when returning metadata; fetch the max, dedupe down to limit
const MAX_LIMIT = 50;         // upper bound on the result pool the UI paginates over (client-side; 25/page)
const MIN_VECTOR_RESULTS = 3; // below this, run text fallback
const STRONG_MATCH_THRESHOLD = 0.60; // top relevanceScore below this → flag noStrongMatch

// Content-type filter (client filter overhaul): independent checkboxes for
// what KINDS of results appear. Defaults mirror the UI (tables + body on,
// references off). 'compare' additionally forces version-comparison handling.
const DEFAULT_CONTENT_TYPES: ContentType[] = ['tables', 'body'];
const VALID_CONTENT_TYPES = new Set(['tables', 'body', 'references', 'compare']);

export function normalizeContentTypes(filters: SearchFilters | undefined, rawQuery: string): Set<ContentType> {
  const raw = Array.isArray(filters?.content_types) ? filters.content_types : null;
  const cleaned = (raw || [])
    .map(t => String(t).toLowerCase())
    .filter((t): t is ContentType => VALID_CONTENT_TYPES.has(t));
  const ct = new Set(cleaned.length > 0 ? cleaned : DEFAULT_CONTENT_TYPES);

  // 'compare' is a MODIFIER (forces version-comparison handling), not a
  // content kind — a selection of just ['compare'] still gets the default
  // kinds, otherwise every content source is disabled and the search is
  // structurally empty.
  const substantive = [...ct].filter(t => t !== 'compare');
  if (substantive.length === 0) { ct.add('tables'); ct.add('body'); }

  // Reference-seeking phrasing ("list of IES references to ...") scopes the
  // search to References-section entries (client request, references mode) —
  // but only REPLACES the default tables+body selection. A caller who
  // customized the checkboxes keeps their choices; references is added, not
  // swapped in. 'compare' survives either way.
  if (isReferenceQuery(rawQuery)) {
    const isDefaultSelection = cleaned.length === 0 ||
      (ct.has('tables') && ct.has('body') && !ct.has('references') && substantive.length === 2);
    if (isDefaultSelection) {
      ct.delete('tables');
      ct.delete('body');
    }
    ct.add('references');
  }
  return ct;
}

const NO_STRONG_MATCH_MESSAGE =
  "There may not be explicit lighting recommendations for that application within the current body of IES Standards. " +
  "Please review the monthly IES Ignite Newsletter for upcoming public review periods and publications. " +
  "The results below are the closest matches we found — review them for related guidance, or contact Standards@ies.org for authoritative assistance.";

// ─── Entry Point ──────────────────────────────────────────────────────────────

export async function handleSearch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  // ── Rate limiting (Workers Rate Limiting binding; fail-open) ──────────────
  // Protects the Workers AI budget from abusive clients. Keyed by client IP.
  // If the binding isn't configured (or the limiter errors) search proceeds.
  if (env.SEARCH_RATE_LIMITER) {
    try {
      const key = request.headers.get('cf-connecting-ip') || 'unknown';
      const { success } = await env.SEARCH_RATE_LIMITER.limit({ key });
      if (!success) {
        return jsonResponse({ error: 'Too many searches — please wait a moment and try again.' }, 429);
      }
    } catch (err) {
      console.error('rate limiter error (fail-open):', errMsg(err));
    }
  }

  let body: any;
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

  // ── Response cache ───────────────────────────────────────────────────────────
  // Identical searches skip the entire pipeline (Workers AI embedding,
  // Vectorize query, D1 lookups, and the optional 70B AI summary — the
  // expensive part). The key embeds a corpus "data version" that bumps on
  // every ingest, so a cache hit can never serve stale standards data.
  const kv = env.SESSIONS;
  const dataVersion = await getDataVersion(kv);
  const cacheKey = await buildSearchCacheKey(dataVersion, {
    query: rawQuery,
    filters,
    limit: cleanLimit,
    units,
    includeAISummary,
  });
  // debug requests bypass the cache entirely: they must observe the live
  // pipeline, and their _depDbg payload must never be served to real users.
  const cachedPayload = body.debug ? null : await getCachedSearch(kv, cacheKey);
  if (cachedPayload) {
    // Cache hits are logged too — staff analytics must see every query, not
    // only the ones that missed the cache.
    const logWrite = logSearch(env, cachedPayload, true);
    if (ctx?.waitUntil) ctx.waitUntil(logWrite); else await logWrite;
    return jsonResponse({ ...cachedPayload, cached: true });
  }

  // ── Multi-query detection ────────────────────────────────────────────────────
  const subQueries = splitMultiQuery(rawQuery);
  const isMultiQuery = subQueries.length > 1;

  // ── Content types (filter overhaul) ──────────────────────────────────────────
  // Which result kinds this search returns: illuminance-table rows ('tables'),
  // document-body excerpts ('body'), References-section entries ('references').
  const contentTypes = normalizeContentTypes(filters, rawQuery);

  // ── Version-comparison intent ("what's new", "what changed") ─────────────────
  // Signals to the UI that ADDED/REVISED should be auto-shown and REMOVED gated.
  // The "Compare Versions" filter checkbox forces the same handling.
  const isVersionComparison = isVersionComparisonQuery(rawQuery) || contentTypes.has('compare');

  // ── Structural filter inference from query ───────────────────────────────────
  // A bare "LZ1 walkways" in the query string should narrow results to that
  // lighting zone even when the caller didn't pass an explicit filter.
  const inferred = inferFiltersFromQuery(rawQuery, isVersionComparison);
  const mergedFilters = { ...inferred, ...filters };

  let allResults;

  if (isMultiQuery) {
    // Fan out to individual searches, merge and deduplicate
    allResults = await runMultiSearch(subQueries, mergedFilters, cleanLimit, env, contentTypes);
  } else {
    allResults = await runSingleSearch(rawQuery, mergedFilters, cleanLimit, env, contentTypes);
  }

  // ── Deprecated content (version-comparison queries ONLY) ─────────────────────
  // "what's new in RP-6?" may cite the deprecated edition alongside the
  // current one. This is the single code path that touches the deprecated
  // Vectorize index; every other query shape never sees deprecated content
  // (IS-AI Prototype p.1 §6, p.5). Results are flagged so the UI can label
  // them "deprecated — replaced by <current>".
  // Diagnostics for the deprecated-comparison path, which is fail-open by
  // design (errors and empty stages silently yield no deprecated excerpts).
  // Populated only when the caller passes body.debug.
  let depDbg = null;
  if (isVersionComparison) {
    depDbg = body.debug ? {} : null;
    // Topical anchor: the current edition's best excerpt. Embedding the raw
    // "what's new in X?" phrasing retrieves TOC lines from the deprecated
    // index ("9.12 New Light Sources . . ."), not substantive provisions.
    const topicHint = allResults.results[0]?.excerpt?.text || '';
    const deprecatedResults = await searchDeprecatedForComparison(rawQuery, mergedFilters, env, topicHint, depDbg);
    allResults.results.push(...deprecatedResults);
  }

  // ── Related applications + optional AI summary (run concurrently) ────────────
  // Related apps: top result only, and only for true application rows — chunk
  // results have no D1 identity to find siblings for. Exclude only the seed
  // itself, not the rest of the result list: excluding all results would
  // filter out true sibling rows and `related` would fall through to a wider,
  // less useful layer (cousins or banner-mates).
  //
  // The AI summary is the slowest step in the pipeline (70B model), so it is
  // KV-cached by (query + result set + corpus version): a repeat of the same
  // question with different limit/units/filters reuses the generated summary
  // instead of re-billing the model.
  const seed = allResults.results[0]?.application;
  const relatedPromise = (seed && seed.rowRef != null)
    ? getRelatedApplications(env, seed, [seed.code])
    : Promise.resolve([]);

  const aiPromise = (includeAISummary && allResults.results.length > 0)
    ? (async () => {
        try {
          const resultCodes = allResults.results.slice(0, 5).map(r => r.application?.code).filter(Boolean);
          const aiKey = await buildAISummaryCacheKey(dataVersion, 'summary', rawQuery, resultCodes);
          const cached = body.debug ? null : await getCachedAISummary(kv, aiKey);
          if (cached) return cached;
          const generated = await generateResponse(env.AI, rawQuery, allResults.results);
          // Degraded summaries (every model errored) are never cached — the
          // next identical search retries the models instead of pinning the
          // fallback text for the cache TTL (client bug DO9).
          const cacheable = !body.debug && !generated.degraded;
          if (cacheable && ctx?.waitUntil) ctx.waitUntil(putCachedAISummary(kv, aiKey, generated));
          else if (cacheable) await putCachedAISummary(kv, aiKey, generated);
          return generated;
        } catch (err) {
          // generateResponse degrades internally; this only catches plumbing
          // failures (KV, prompt building). Still return SOMETHING — an AI
          // Guide the user turned on must never silently vanish (DO9).
          console.error('AI summary error (non-fatal):', errMsg(err));
          return {
            text: 'The AI Guide could not generate a response for this search. The results below are unaffected — please try again in a moment.',
            watermark: null,
            disclaimer: 'AI Guide temporarily unavailable.',
            degraded: true,
          };
        }
      })()
    : Promise.resolve(null);

  const [related, aiSummary] = await Promise.all([relatedPromise, aiPromise]);
  if (allResults.results.length > 0) {
    allResults.results[0].relatedApplications = related;
  }

  // ── Confidence flag ──────────────────────────────────────────────────────────
  // The UI uses noStrongMatch to render a yellow advisory banner above the
  // results. We never filter the list itself — the user still sees the closest
  // matches we found; we just signal that confidence is low. Use the max score
  // across the list: publication-order clustering can move a lower-scored
  // sibling row into first position. References-only searches skip the banner:
  // reference entries legitimately score lower than application rows, and the
  // advisory text (about missing lighting recommendations) doesn't apply.
  const topScore = allResults.results.reduce(
    (max, r) => Math.max(max, r.relevanceScore || 0), 0
  );
  // The advisory doesn't apply to References or version-comparison searches
  // (client feedback DO11): reference entries legitimately score lower, and a
  // comparison isn't looking for lighting recommendations in the first place.
  const referencesOnly = contentTypes.has('references') && !contentTypes.has('tables') && !contentTypes.has('body');
  const noStrongMatch = !referencesOnly && !isVersionComparison && topScore < STRONG_MATCH_THRESHOLD;

  // Comparison searches need the AI Guide to synthesize "what changed" across
  // editions — without it the user just sees raw excerpts. Tell them to turn
  // it on (client request DO11); this notice REPLACES the no-strong-match
  // advisory for comparison searches.
  const aiGuideRequiredNotice = (isVersionComparison && !includeAISummary)
    ? 'AI Guide is required for document comparisons. Please toggle the AI Guide filter on and repeat your search.'
    : null;

  const payload = {
    query: rawQuery,
    expandedQuery: allResults.expandedQuery,
    isMultiQuery,
    subQueries: isMultiQuery ? subQueries : undefined,
    isVersionComparison,
    contentTypes: [...contentTypes],
    noStrongMatch,
    noStrongMatchMessage: noStrongMatch ? NO_STRONG_MATCH_MESSAGE : null,
    aiGuideRequiredNotice,
    results: applyUnits(allResults.results, units),
    aiSummary,
    timestamp: new Date().toISOString(),
    _depDbg: depDbg || undefined,
  };

  // Store after responding when possible (waitUntil); never blocks the user.
  // A payload whose requested AI summary degraded is NOT cached: serving it
  // from cache would pin the fallback text even after the models recover.
  const skipCache = body.debug || (includeAISummary && (aiSummary as { degraded?: boolean } | null)?.degraded === true);
  const cacheWrite = skipCache ? Promise.resolve() : putCachedSearch(kv, cacheKey, payload);
  const logWrite = logSearch(env, payload, false);
  if (ctx?.waitUntil) {
    ctx.waitUntil(cacheWrite);
    ctx.waitUntil(logWrite);
  } else {
    await cacheWrite;
    await logWrite;
  }

  return jsonResponse({ ...payload, cached: false });
}

/**
 * Append one row to the anonymous search log (D1 search_log table).
 *
 * PRIVACY: no user id, no IP, no session — only the query text and what the
 * response referenced. Staff export it via GET /api/admin/search-log.csv.
 * Fail-open: a missing table or a D1 hiccup never breaks search.
 */
async function logSearch(env: Env, payload: { query: string; results?: SearchResult[]; noStrongMatch?: boolean }, cached: boolean): Promise<void> {
  try {
    const standards = [
      ...new Set((payload.results || [])
        .map(r => r.application?.standard)
        .filter(Boolean)),
    ];
    await env.DB.prepare(`
      INSERT INTO search_log (query, result_count, standards_referenced, no_strong_match, cached)
      VALUES (?, ?, ?, ?, ?)
    `).bind(
      payload.query,
      (payload.results || []).length,
      JSON.stringify(standards),
      payload.noStrongMatch ? 1 : 0,
      cached ? 1 : 0
    ).run();
  } catch (err) {
    console.error('search log write failed (non-fatal):', errMsg(err));
  }
}

// ─── Single Search ────────────────────────────────────────────────────────────

async function runSingleSearch(rawQuery: string, filters: SearchFilters, limit: number, env: Env, contentTypes: Set<ContentType> = new Set(DEFAULT_CONTENT_TYPES)): Promise<SearchOutput> {
  const expandedQuery = prepareQueryForEmbedding(rawQuery);
  const includeTables = contentTypes.has('tables');
  const includeBody = contentTypes.has('body');
  const includeRefs = contentTypes.has('references');

  // 1. Embed — KV-cached. Embeddings are deterministic per model, so a
  //    repeated query (or a sub-query of a repeated multi-query) skips the
  //    Workers AI call entirely. Cache hits here also cover requests that
  //    miss the response cache only because filters/limit/units differ.
  let queryVector = await getCachedEmbedding(env.SESSIONS, EMBED_MODEL, expandedQuery);
  if (!queryVector) {
    const embResult = await env.AI.run(EMBED_MODEL, { text: [expandedQuery] }) as unknown as { data: number[][] };
    queryVector = embResult.data[0];
    await putCachedEmbedding(env.SESSIONS, EMBED_MODEL, expandedQuery, queryVector);
  }

  // 2. Vector search
  const vectorFilter = buildVectorFilter(filters);
  const vectorResults = await env.VECTORIZE.query(queryVector, {
    topK: VECTOR_TOP_K,
    returnMetadata: 'all',
    ...(vectorFilter ? { filter: vectorFilter } : {}),
  });

  const matches = (vectorResults.matches || []) as unknown as VMatch[];

  // 3. Split matches by type. Reference-section chunks are handled by their
  //    own step (11) and never join the general body-chunk pool: they are
  //    bibliography entries, useful when asked for but noise as excerpts.
  const appMatches = includeTables
    ? matches.filter(m => m.metadata?.chunk_type === 'application' && m.metadata?.application_code)
    : [];
  let chunkMatches = matches.filter(m =>
    m.metadata?.chunk_type !== 'application' &&
    m.metadata?.chunk_type !== 'reference' &&
    m.metadata?.standard_id
  );
  let referenceMatches = matches.filter(m =>
    m.metadata?.chunk_type === 'reference' && m.metadata?.standard_id
  );

  // 3b. Body-scoped supplemental query: the shared top-K pool is dominated
  //     by application vectors, so the prose share can be tiny or empty —
  //     originally run only for body-ONLY searches, but the same starvation
  //     hits the default Tables+Body search (client feedback DO5: filtering
  //     to both returned almost no document-body results). Pull text chunks
  //     directly with a chunk_type filter whenever Document Body is checked.
  //     Fail-open: without the metadata index the filtered query errors and
  //     the main pool stands.
  if (includeBody) {
    try {
      const bodyQuery = await env.VECTORIZE.query(queryVector, {
        topK: VECTOR_TOP_K,
        returnMetadata: 'all',
        filter: { ...(vectorFilter || {}), chunk_type: 'text' },
      });
      const dedupe = new Map(chunkMatches.map(m => [m.id, m]));
      for (const m of (bodyQuery.matches || []) as unknown as VMatch[]) {
        if (m.metadata?.standard_id) dedupe.set(m.id, m);
      }
      chunkMatches = [...dedupe.values()];
    } catch (err) {
      console.error('body-scoped vector query failed, using main pool (non-fatal):', errMsg(err));
    }
  }

  // 4. Fetch application records from D1 (plus the standards index, used
  //    for full-title citations, Vitrium links, and orphan-chunk filtering)
  const appCodes = dedupeByCode(appMatches).slice(0, limit * 2)
    .map(m => m.metadata?.application_code)
    .filter((c): c is string => !!c);
  const [appMap, standardsIndex] = await Promise.all([
    fetchApplications(env.DB, appCodes, filters),
    fetchStandardsIndex(env.DB),
  ]);
  const linkCtx = { standardsIndex };

  // 4b. Deprecated standards NEVER contribute excerpts or chunk results to a
  //     regular search. Their vectors live in a separate index and should not
  //     appear here at all — this is defense in depth against vectors tagged
  //     'deprecated' or D1 rows flipped to Deprecated after ingestion.
  //     Version-comparison queries pull deprecated content through the
  //     dedicated searchDeprecatedForComparison() path instead.
  const notDeprecated = (m: VMatch) => {
    if (m.metadata?.status === 'deprecated') return false;
    const entry = standardsIndex.get((m.metadata?.standard_id || m.metadata?.standard_code) ?? '');
    return !entry || entry.status !== 'Deprecated';
  };
  chunkMatches = chunkMatches.filter(notDeprecated);
  referenceMatches = referenceMatches.filter(notDeprecated);

  // 5. Build excerpt index: standardId → best chunk match
  const excerptIndex = buildExcerptIndex(chunkMatches);

  // 6. Assemble results
  const scored: ScoredApp[] = [];
  for (const m of appMatches) {
    const code = m.metadata?.application_code;
    if (!code) continue;
    const app = appMap[code];
    if (!app) continue;
    scored.push({ score: m.score, app, chunkMeta: m.metadata });
  }

  // Deduplicate, keep highest score per application code
  const deduped = deduplicateScored(scored);
  const top = deduped.slice(0, limit);

  // 6.5 Excerpt backfill — the shared top-50 pool is dominated by application
  //     vectors, so standards behind the top results often have NO text chunk
  //     in it and their cards render without a "From the Standard" excerpt
  //     even though the PDF has relevant prose (client feedback: fitting
  //     rooms exist in RP-2 pp. 29-31 but no excerpt was shown). For each top
  //     standard missing prose, run one narrow chunk query pinned to that
  //     standard and merge the hits into the excerpt index.
  await backfillExcerpts(env, queryVector, top.map(t => t.app), excerptIndex);

  let results = top.map(({ score, app, chunkMeta }) =>
    buildResult(app, score, chunkMeta, excerptIndex, linkCtx)
  );

  // 7. Text fallback if sparse — and re-sort the merged list so fallback
  //    rows interleave by hierarchy/score with the vector hits instead of
  //    being appended in arbitrary D1 insertion order.
  if (includeTables && results.length < MIN_VECTOR_RESULTS) {
    const fallback = await textFallback(env.DB, cleanQuery(rawQuery), filters, limit, excerptIndex, linkCtx);
    mergeResults(results, fallback);
    results.sort(compareResults);
  }

  // 8. Blend PDF-chunk results into the list — not only as a zero-result
  //    fallback. Application vectors vastly outnumber chunk vectors, so any
  //    query matches SOME application row; standards without structured
  //    illuminance tables (LS/LP/TM/LM/G series and prose RPs) would never
  //    surface if chunks only appeared when the app list came back empty.
  //    Body excerpts are blended even for standards that ALSO have table hits
  //    (client feedback: broad conceptual queries like "transition and
  //    circulation space" returned 30 table rows and zero document-body
  //    results — the mix matters). Best chunk per standard; the D1 standards
  //    filter drops orphan vectors from deleted/renamed standards.
  //    compareResults handles the final order: score first, and its
  //    hierarchy tie-break favors application rows on near-equal scores.
  if (includeBody && chunkMatches.length > 0) {
    const liveChunks = chunkMatches.filter(m => {
      const id = m.metadata?.standard_id || m.metadata?.standard_code;
      return id && standardsIndex.has(id);
    });
    // A chunk-only result has no structured illuminance data — its excerpt IS
    // the card. Raw table dumps and heading stubs render as an empty card
    // (client feedback: "transition and circulation space", "elevator"), so
    // only chunks with real prose are allowed to become standalone results.
    const displayableChunks = liveChunks.filter(m => {
      const meta = m.metadata || {};
      const text = String(meta.excerpt_text || '');
      return meta.chunk_type !== 'table' && text.trim().length >= 60 && !isTableLike(text);
    });
    const chunkResults = buildChunkResults(displayableChunks, linkCtx);
    if (chunkResults.length > 0) {
      results.push(...chunkResults);
      results.sort(compareResults);
      results = results.slice(0, limit);
    }
  }

  // 11. References mode — surface References/Bibliography entries as results.
  //     The main pool rarely holds many reference chunks (application vectors
  //     dominate), so run a dedicated query scoped to chunk_type='reference'
  //     for real recall. Requires a Vectorize metadata index on chunk_type
  //     (see wrangler.toml); if the filtered query fails or returns nothing,
  //     fall back to whatever the main pool surfaced.
  if (includeRefs) {
    let refPool = referenceMatches;
    try {
      const refQuery = await env.VECTORIZE.query(queryVector, {
        topK: VECTOR_TOP_K,
        returnMetadata: 'all',
        filter: { ...(vectorFilter || {}), chunk_type: 'reference' },
      });
      const dedupe = new Map(refPool.map(m => [m.id, m]));
      for (const m of (refQuery.matches || []) as unknown as VMatch[]) {
        if (m.metadata?.chunk_type === 'reference' && notDeprecated(m)) dedupe.set(m.id, m);
      }
      refPool = [...dedupe.values()];
    } catch (err) {
      console.error('reference-scoped vector query failed, using main pool (non-fatal):', errMsg(err));
    }
    // Last-resort recall (client bug DO12: "References filter displays but is
    // not populating results"): the chunk_type-filtered query silently returns
    // NOTHING when the metadata index was created after ingest (filters only
    // apply to vectors inserted afterwards), and the shared pool is dominated
    // by application vectors. Reference chunks have deterministic ids near the
    // tail of each document (References sections sit at the back), and D1
    // coverage stats say exactly how many each standard has — probe them
    // directly and rank in-process. Fail-open.
    if (refPool.length === 0) {
      try {
        refPool = await probeReferenceChunks(env, queryVector, filters);
      } catch (err) {
        console.error('reference chunk probe failed (non-fatal):', errMsg(err));
      }
    }
    const liveRefs = refPool.filter(m => {
      const id = m.metadata?.standard_id || m.metadata?.standard_code;
      return id && standardsIndex.has(id);
    });
    // Every reference entry is its own result (perStandard: Infinity) — a
    // reference listing that collapsed to one entry per standard would be
    // useless as a bibliography view.
    const refResults = buildChunkResults(liveRefs, linkCtx, { perStandard: Infinity })
      .map(r => ({
        ...r,
        referenceLink: buildReferenceLink(r.excerpt?.text || '', standardsIndex),
      }));
    if (refResults.length > 0) {
      results.push(...refResults);
      results.sort(compareResults);
      results = results.slice(0, limit);
    }
  }

  // 9. Publication-order clustering — sibling rows of the same application
  //    block print together, ordered as in the source table (client
  //    feedback: Figure Skating Class I–IV / Recreational must follow the
  //    standard's row order, not raw vector-score order).
  return { results: clusterSiblings(results), expandedQuery };
}

/**
 * Hyperlink for one References-section entry, in the client-specified
 * priority order — and NEVER fabricated:
 *   1. IES standard citation → the standard's Lighting Library (Vitrium) web
 *      viewer URL, when that standard is indexed and has a known URL
 *   2. DOI in the text → https://doi.org/<doi>
 *   3. Bare URL in the text → that URL
 *   4. Otherwise → null (the UI renders no link)
 *
 * @returns {{ url: string, type: 'library'|'doi'|'url' } | null}
 */
export function buildReferenceLink(text: string, standardsIndex?: StandardsIndex): ReferenceLink {
  if (!text) return null;

  // 1. IES standard citation → Lighting Library
  const stdMatch = /\b(?:ANSI\/|BSR\/)?IES(?:\/NALMCO)?\s+((?:RP|TM|LM|LP|LS|DG|HB|G|LEM)-\d+(?:\.\d+)?)(-\d{2})?(\+E\d+)?/i.exec(text);
  if (stdMatch && standardsIndex) {
    const cited = `${stdMatch[1]}${stdMatch[2] || ''}${stdMatch[3] || ''}`.toUpperCase();
    // Exact edition first ("RP-8-25"), then the newest Active edition of the
    // family — references often cite editionless ids ("IES TM-30"). The
    // family is the structural prefix+number from the regex capture, NOT a
    // suffix-strip: stripping a trailing 2-digit group off "TM-30" would
    // yield family "TM" and link the citation to an arbitrary TM-* standard.
    let entry = standardsIndex.get(cited);
    let entryOk: boolean = !!(entry && entry.status !== 'Deprecated' && entry.webUrl);
    if (!entryOk) {
      const family = stdMatch[1].toUpperCase();
      // Candidate ids must be exactly "<family>-<2-digit edition>[+E]".
      const editionRe = /^-\d{2}(?:\+E\d+)?$/;
      let bestEdition = -1;
      let bestId: string | null = null;
      for (const [id, info] of standardsIndex) {
        const idU = id.toUpperCase();
        if (!idU.startsWith(family)) continue;
        const rest = idU.slice(family.length);
        if (!editionRe.test(rest)) continue;
        if (info.status === 'Deprecated' || !info.webUrl) continue;
        const edition = parseInt(rest.slice(1, 3), 10);
        if (edition > bestEdition || (edition === bestEdition && (!bestId || idU > bestId))) {
          bestEdition = edition;
          bestId = idU;
          entry = info;
        }
      }
      entryOk = bestId != null;
    }
    if (entryOk && entry?.webUrl) return { url: entry.webUrl, type: 'library' };
  }

  // 2. DOI
  const doiMatch = /\b10\.\d{4,9}\/[^\s"<>]+/.exec(text);
  if (doiMatch) {
    const doi = doiMatch[0].replace(/[).,;:\]]+$/, '');
    return { url: `https://doi.org/${doi}`, type: 'doi' };
  }

  // 3. Bare URL
  const urlMatch = /\bhttps?:\/\/[^\s"<>)]+/i.exec(text);
  if (urlMatch) {
    return { url: urlMatch[0].replace(/[.,;:\]]+$/, ''), type: 'url' };
  }

  return null;
}

/**
 * Index of every standard currently present in the D1 `standards` table:
 * standard id → { docId, webUrl } (fields null when not yet synced).
 *
 * Serves two purposes:
 *   - Filter Vectorize chunk fallbacks so orphan vectors from previous
 *     ingests don't surface to users.
 *   - Provide the standard-level Vitrium web viewer URL used to build the
 *     "View in Vitrium" link on every result.
 *
 * Runs once per request (small set: ~dozens of rows).
 */
async function fetchStandardsIndex(db: D1Database): Promise<StandardsIndex> {
  const result = await db.prepare(
    'SELECT id, title, full_designation, status, superseded_by, vitrium_doc_id, vitrium_web_url FROM standards'
  ).all<StandardRow>();
  return new Map<string, StandardIndexEntry>((result.results || []).map((r): [string, StandardIndexEntry] => {
    const curated = curatedStandardInfo(r.id);
    return [
      r.id,
      {
        docId: r.vitrium_doc_id || null,
        webUrl: r.vitrium_web_url || null,
        status: r.status || 'Active',
        supersededBy: r.superseded_by || null,
        // Full-title citations (client requirement DO1): designation +
        // descriptive title on EVERY result. D1 title first (synced metadata),
        // then the curated schema title — PDF metadata is often missing or
        // equals the bare id, which previously left citations title-less.
        title: (r.title && r.title !== r.id) ? r.title : (curated?.title || null),
        fullDesignation: r.full_designation || curated?.fullDesignation || null,
      },
    ];
  }));
}

/**
 * Curated designation/title lookup from src/config/standards-schema.json —
 * the fallback that guarantees full-title citations even when a standard was
 * ingested before metadata sync populated D1. Errata suffixes match their
 * base edition ("RP-2-20+E1" → "RP-2-20") when no exact entry exists.
 */
type CuratedInfo = { title: string | null; fullDesignation: string | null };
const CURATED_STANDARDS = new Map<string, CuratedInfo>(
  (standardsSchema.standards || []).map((s: { id: string; title?: string; full_designation?: string }) => [
    s.id.toUpperCase(),
    { title: s.title || null, fullDesignation: s.full_designation || null },
  ])
);

export function curatedStandardInfo(id: string | null | undefined): CuratedInfo | null {
  if (!id) return null;
  const key = String(id).toUpperCase();
  const exact = CURATED_STANDARDS.get(key);
  if (exact) return exact;
  const base = key.replace(/\+E\d+$/, '');
  return base !== key ? (CURATED_STANDARDS.get(base) || null) : null;
}

// ─── Deprecated Standards (version comparison only) ───────────────────────────

const DEPRECATED_TOP_K = 100;       // ids+scores pool from the deprecated index (max without metadata)
const MAX_DEPRECATED_RESULTS = 3;   // flagged excerpts appended to the response

/**
 * Fetch excerpts from DEPRECATED standards for a version-comparison query.
 *
 * Only called when isVersionComparisonQuery() matched. Requires the query to
 * name the standard being compared ("what's new in RP-6?") — an unscoped
 * comparison has no deprecated edition to pull, so it returns [].
 *
 * Deprecated vectors live in their own index (env.VECTORIZE_DEPRECATED);
 * regular searches and any future external API never query it. Results are
 * flagged isDeprecated with a supersededBy pointer so both the UI and the
 * AI summary can frame them strictly as comparison context, never guidance.
 *
 * Fail-open: any error returns [] and the comparison proceeds with current
 * content only.
 */
async function searchDeprecatedForComparison(rawQuery: string, filters: SearchFilters, env: Env, topicHint = '', dbg: DepDbg | null = null): Promise<SearchResult[]> {
  const D = dbg || {};
  if (!env.VECTORIZE_DEPRECATED) { D.step = 'no-binding'; return []; }

  // Scope: the standard FAMILY being compared. standard_prefix is already a
  // family ("RP-6"); an exact filters.standard ("RP-6-24") is reduced to its
  // family so prior editions (RP-6-15, RP-6-20) match too.
  let scope = (filters.standard_prefix || '').toUpperCase();
  if (!scope && filters.standard) {
    const std = String(filters.standard).toUpperCase();
    const fam = /^(.+)-\d{2}(?:\+E\d+)?$/.exec(std);
    scope = fam ? fam[1] : std;
  }
  if (!scope) { D.step = 'no-scope'; return []; }
  D.scope = scope;

  const scopePrefix = scope.endsWith('-') ? scope : `${scope}-`;

  try {
    // "What's new in X?" is meta-phrasing: embedded as-is it matches TOC
    // lines ("9.12 New Light Sources . . . .") instead of substantive
    // content. Anchor the deprecated-index query on the family's TOPIC —
    // the current edition's best excerpt — so the excerpts pulled for
    // comparison are real provisions about the same subject.
    const embedText = topicHint.trim().length >= 60
      ? `${scope} ${topicHint.slice(0, 400)}`
      : prepareQueryForEmbedding(rawQuery);

    let queryVector = await getCachedEmbedding(env.SESSIONS, EMBED_MODEL, embedText);
    if (!queryVector) {
      const embResult = await env.AI.run(EMBED_MODEL, { text: [embedText] }) as unknown as { data: number[][] };
      queryVector = embResult.data[0];
      await putCachedEmbedding(env.SESSIONS, EMBED_MODEL, embedText, queryVector);
    }

    // The deprecated index has no metadata index (filters only apply to
    // vectors inserted after one exists), so scoping happens client-side.
    // With returnMetadata:'all' Vectorize caps topK at 20 — too small a pool
    // for one family among ~150 deprecated standards. Instead: fetch 100
    // ids+scores, scope by vector-id prefix (`<standardId>-chunk-<i>`), then
    // pull metadata for just the scoped hits via getByIds.
    const res = await env.VECTORIZE_DEPRECATED.query(queryVector, {
      topK: DEPRECATED_TOP_K,
      returnMetadata: 'none',
    });

    // Keep only chunks of the compared standard family (RP-6 → RP-6-15,
    // RP-6-20, ...). `RP-6-` never matches RP-60-* since ids are `RP-60-...`.
    const scoped = (res.matches || []).filter(m =>
      String(m.id).toUpperCase().startsWith(scopePrefix)
    ).slice(0, 20);

    let candidates: VMatch[] = [];
    if (scoped.length > 0) {
      const scoreById = new Map(scoped.map(m => [m.id, m.score]));
      const fetched = await env.VECTORIZE_DEPRECATED.getByIds(scoped.map(m => m.id));
      candidates = (fetched || []).map(v => ({
        id: v.id, score: scoreById.get(v.id) || 0, metadata: v.metadata as Partial<VectorMetadata>,
      }));
    }

    const proseOnly = (list: VMatch[]): VMatch[] => list.filter((m: VMatch) => {
      const meta = m.metadata || {};
      const text = String(meta.excerpt_text || '');
      return meta.chunk_type !== 'table' && text.trim().length >= 60 && !isTableLike(text);
    });

    let matches = proseOnly(candidates);
    D.scopedCount = scoped.length;
    D.globalProse = matches.length;

    // Fallback: the global top-100 pool often misses small families entirely
    // (or surfaces only their TOC chunks). Vector ids are deterministic
    // (`<standardId>-chunk-<n>`), so probe the family's chunks directly via
    // getByIds and rank them against the query vector in-process.
    if (matches.length === 0) {
      const probed = await probeDeprecatedFamily(env, scopePrefix, queryVector, D);
      matches = proseOnly(probed);
      D.probedRaw = probed.length;
      D.probedProse = matches.length;
    }
    if (matches.length === 0) { D.step = 'all-filtered-out'; return []; }

    const standardsIndex = await fetchStandardsIndex(env.DB);
    const linkCtx = { standardsIndex };

    return buildChunkResults(matches, linkCtx)
      .sort((a, b) => (b.relevanceScore || 0) - (a.relevanceScore || 0))
      .slice(0, MAX_DEPRECATED_RESULTS)
      .map(r => {
        const info = standardsIndex.get(r.application.standard ?? '');
        const supersededBy = info?.supersededBy || null;
        const name = r.application.standardFull || r.application.standard;
        return {
          ...r,
          isDeprecated: true,
          supersededBy,
          deprecationNotice: supersededBy
            ? `${name} is deprecated and has been replaced by ${supersededBy}.`
            : `${name} is deprecated.`,
          citation: `${r.citation} (deprecated)`,
        };
      });
  } catch (err) {
    D.step = 'error';
    D.error = errMsg(err);
    console.error('deprecated comparison search failed (non-fatal):', errMsg(err));
    return [];
  }
}

// Chunk-probe parameters for the deprecated-family fallback. 300 chunks
// (~105k words) covers the substantive front of even the largest standards;
// getByIds rejects batches over 20 ids.
const PROBE_BATCH = 20;
const PROBE_MAX_CHUNKS = 300;

/**
 * Directly fetch a deprecated family's chunk vectors by deterministic id
 * (`<standardId>-chunk-<n>`) and rank them against the query vector with
 * in-process cosine similarity. Used when the family is absent from the
 * global ANN pool — guarantees recall for any indexed family at the cost
 * of a few getByIds round-trips.
 */
async function probeDeprecatedFamily(env: Env, scopePrefix: string, queryVector: number[], D: DepDbg = {}): Promise<VMatch[]> {
  const rows = await env.DB.prepare(
    "SELECT id FROM standards WHERE status = 'Deprecated' AND id LIKE ?"
  ).bind(`${scopePrefix}%`).all<{ id: string }>();
  const members = (rows.results || []).map(r => r.id);
  D.probeMembers = members;
  if (members.length === 0) return [];

  let qNorm = 0;
  for (const x of queryVector) qNorm += x * x;
  qNorm = Math.sqrt(qNorm) || 1;

  const scored: VMatch[] = [];
  for (const member of members) {
    for (let start = 0; start < PROBE_MAX_CHUNKS; start += PROBE_BATCH) {
      const ids = Array.from({ length: PROBE_BATCH }, (_, j) => `${member}-chunk-${start + j}`);
      const got = await env.VECTORIZE_DEPRECATED.getByIds(ids);
      if (!got || got.length === 0) break; // past the end of the document
      for (const v of got) {
        // Rank prose chunks only: TOC dot-leader lines and table dumps score
        // deceptively high on similarity and would crowd out real provisions.
        const meta = v.metadata || {};
        const text = String(meta.excerpt_text || '');
        if (meta.chunk_type === 'table' || text.trim().length < 60 || isTableLike(text)) continue;

        const vals = v.values || [];
        let dot = 0, norm = 0;
        for (let k = 0; k < vals.length; k++) {
          dot += vals[k] * queryVector[k];
          norm += vals[k] * vals[k];
        }
        scored.push({
          id: v.id,
          score: dot / (qNorm * (Math.sqrt(norm) || 1)),
          metadata: v.metadata,
        });
      }
      if (got.length < PROBE_BATCH) break;
    }
  }

  return scored.sort((a, b) => b.score - a.score).slice(0, 20);
}

// Reference-probe parameters (References-mode fallback, DO12). References
// sections sit at the BACK of a standard, so probing a tail window of
// (2×refCount + 40) chunks reliably covers them even when annexes follow.
const REF_PROBE_MAX_STANDARDS = 8;   // standards probed per search
const REF_PROBE_BATCH = 20;          // getByIds max batch size
const REF_PROBE_MAX_BATCHES = 30;    // global getByIds budget per search
const REF_PROBE_KEEP = 30;           // top-ranked reference chunks returned

/**
 * Fetch reference chunks directly by deterministic id (`<standardId>-chunk-<n>`)
 * from the tail of each standard that D1 coverage stats say carries reference
 * entries, then rank them against the query vector with in-process cosine
 * similarity. Used only when both the chunk_type-filtered query and the shared
 * pool produced zero reference chunks — guarantees References-mode recall
 * regardless of Vectorize metadata-index state.
 */
async function probeReferenceChunks(env: Env, queryVector: number[], filters: SearchFilters): Promise<VMatch[]> {
  let sql = `
    SELECT id, chunk_count, coverage_json FROM standards
    WHERE status = 'Active' AND chunk_count IS NOT NULL AND coverage_json IS NOT NULL
  `;
  const bindings: string[] = [];
  if (filters.standard) { sql += ' AND id = ?'; bindings.push(filters.standard); }
  if (filters.standard_prefix) { sql += ' AND id LIKE ?'; bindings.push(`${filters.standard_prefix}-%`); }

  const rows = await env.DB.prepare(sql).bind(...bindings)
    .all<{ id: string; chunk_count: number; coverage_json: string }>();

  const targets: Array<{ id: string; chunkCount: number; refCount: number }> = [];
  for (const r of rows.results || []) {
    try {
      const cov = JSON.parse(r.coverage_json);
      const refCount = Number(cov?.byType?.reference) || 0;
      if (refCount > 0) targets.push({ id: r.id, chunkCount: r.chunk_count, refCount });
    } catch { /* malformed coverage row — skip */ }
  }
  if (targets.length === 0) return [];
  // Reference-richest standards first — most likely to hold the entry sought.
  targets.sort((a, b) => b.refCount - a.refCount);

  let qNorm = 0;
  for (const x of queryVector) qNorm += x * x;
  qNorm = Math.sqrt(qNorm) || 1;

  const scored: VMatch[] = [];
  let batchBudget = REF_PROBE_MAX_BATCHES;
  for (const t of targets.slice(0, REF_PROBE_MAX_STANDARDS)) {
    if (batchBudget <= 0) break;
    const window = Math.min(t.chunkCount, t.refCount * 2 + 40);
    const start = Math.max(0, t.chunkCount - window);
    // Walk the tail window newest-first so the References block (nearest the
    // end) is covered before the budget runs out.
    for (let hi = t.chunkCount; hi > start && batchBudget > 0; hi -= REF_PROBE_BATCH) {
      const lo = Math.max(start, hi - REF_PROBE_BATCH);
      const ids = Array.from({ length: hi - lo }, (_, j) => `${t.id}-chunk-${lo + j}`);
      batchBudget--;
      const got = await env.VECTORIZE.getByIds(ids);
      for (const v of got || []) {
        const meta = (v.metadata || {}) as Partial<VectorMetadata>;
        if (meta.chunk_type !== 'reference') continue;
        const vals = (v.values || []) as number[];
        let dot = 0, norm = 0;
        for (let k = 0; k < vals.length; k++) {
          dot += vals[k] * queryVector[k];
          norm += vals[k] * vals[k];
        }
        scored.push({ id: v.id, score: dot / (qNorm * (Math.sqrt(norm) || 1)), metadata: meta });
      }
    }
  }

  return scored.sort((a, b) => b.score - a.score).slice(0, REF_PROBE_KEEP);
}

// ─── Multi-Search ─────────────────────────────────────────────────────────────

async function runMultiSearch(subQueries: string[], filters: SearchFilters, limitPerQuery: number, env: Env, contentTypes: Set<ContentType>): Promise<SearchOutput> {
  // Run all sub-queries in parallel; limit per sub-query = max 5 to keep total reasonable
  const perQueryLimit = Math.min(5, limitPerQuery);
  const searches = await Promise.all(
    subQueries.map(q => runSingleSearch(q, filters, perQueryLimit, env, contentTypes))
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
  return { results: clusterSiblings(merged), expandedQuery };
}

/**
 * Re-cluster the final list so rows of the same application block sit
 * together in publication (Row_Ref) order.
 *
 * Vector scores interleave sibling rows arbitrarily (Class IV before
 * Recreational before Class I). Groups keep the list position of their
 * best-scoring member — the list arrives score-sorted, and Map preserves
 * first-insertion order — so relevance ordering BETWEEN groups is unchanged;
 * only members WITHIN a group are reordered to match the printed table.
 * Chunk-only results (no rowRef) never cluster.
 */
function clusterSiblings(results: SearchResult[]): SearchResult[] {
  const groups = new Map();
  for (const r of results) {
    const a = r.application || {};
    const key = a.rowRef != null
      ? `${a.standard}|${a.tableRef || ''}|${a.subCategory || ''}|${a.category || ''}`
      : `solo|${a.code}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }

  const out = [];
  for (const members of groups.values()) {
    if (members.length > 1) members.sort(comparePublicationOrder);
    out.push(...members);
  }
  return out;
}

function comparePublicationOrder(a: SearchResult, b: SearchResult): number {
  const A = a.application, B = b.application;
  const rowDiff = rowRefNumber(A.rowRef) - rowRefNumber(B.rowRef);
  if (rowDiff !== 0) return rowDiff;
  for (const key of ['sub1', 'sub2', 'sub3', 'sub4']) {
    const cmp = compareHierarchyField(A[key as keyof typeof A] as string | null, B[key as keyof typeof B] as string | null);
    if (cmp !== 0) return cmp;
  }
  return 0;
}

// ─── D1 Helpers ───────────────────────────────────────────────────────────────

async function fetchApplications(db: D1Database, codes: string[], filters: SearchFilters = {}): Promise<Record<string, ApplicationRow>> {
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

  const result = await db.prepare(sql).bind(...bindings).all<ApplicationRow>();
  return Object.fromEntries((result.results || []).map(a => [a.code, a]));
}

async function getRelatedApplications(env: Env, application: FormattedApplication, excludeCodes: string[]): Promise<RelatedApplication[]> {
  if (!application) return [];

  const TARGET = 4;
  const collected = new Map<string, Record<string, any>>(); // code → row, preserves insertion order
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
    const bindings: any[] = [application.standard];
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

    const result = await env.DB.prepare(sql).bind(...bindings).all<Record<string, any>>();

    for (const row of result.results || []) {
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

async function textFallback(db: D1Database, query: string, filters: SearchFilters, limit: number, excerptIndex: ExcerptIndex, linkCtx: LinkCtx): Promise<SearchResult[]> {
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
  const bindings: (string | number)[] = [...likeBindings];

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

  const result = await db.prepare(sql).bind(...bindings).all<ApplicationRow>();
  return result.results.map(app =>
    buildResult(app, 0, undefined, excerptIndex, linkCtx)
  );
}

// ─── Result Builder ───────────────────────────────────────────────────────────

function buildResult(app: ApplicationRow, score: number, chunkMeta: Partial<VectorMetadata> | undefined, excerptIndex: ExcerptIndex, linkCtx: LinkCtx): SearchResult {
  const formatted = formatApplication(app);
  // Pass the application's own page (where its table row lives), not the
  // excerpt's page — the citation should point at the source row, while
  // the excerpt's pageNumber stays in the excerpt object. The standard's
  // descriptive title (from D1) makes the citation carry the FULL name:
  // "ANSI/IES RP-2-20+E1 Recommended Practice: Lighting Retail Spaces, ...".
  const stdInfo = linkCtx.standardsIndex?.get(app.Standard ?? '');
  const citation = formatCitation(app, null, app.Page_Number ?? null, stdInfo?.title || null);
  const vitriumLink = buildVitriumLink(app, linkCtx);

  // Find the best PDF excerpt for this application — preferring a chunk
  // near the application's table page over a globally top-scored chunk.
  const excerpt = pickExcerptForApp(excerptIndex, app);

  return {
    resultType: 'application',
    application: formatted,
    // Front-of-document link (DO1R2): the citation title opens the standard
    // itself — deliberately WITHOUT the #page fragment vitriumLink carries.
    standardLink: stdInfo?.webUrl || null,
    relevanceScore: Math.round(score * 1000) / 1000,
    excerpt: excerpt ? {
      text: excerpt.excerpt_text ?? '',
      pageNumber: excerpt.page_number ?? null,
      section: excerpt.section ?? null,
      // Surface the chunk type so the UI can hide raw table dumps in the
      // "From the Standard" panel — that section is only useful when it shows
      // prose context from the body of the standard, not a repeat of the table.
      chunkType: excerpt.chunk_type ?? 'text',
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
function buildExcerptIndex(chunkMatches: VMatch[]): ExcerptIndex {
  const index: ExcerptIndex = {};
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

// Raised 5→10 / 10→15 (client feedback DO4: "From the Standard" excerpts
// should appear on more results — increase the frequency).
const EXCERPT_BACKFILL_MAX = 10;   // standards backfilled per search
const EXCERPT_BACKFILL_TOP_K = 15; // chunks fetched per backfilled standard

/**
 * Ensure the standards behind the top application results have at least one
 * prose chunk in the excerpt index, so their cards can show a "From the
 * Standard" excerpt whenever the PDF actually contains relevant prose.
 *
 * One extra Vectorize query per missing standard (bounded by
 * EXCERPT_BACKFILL_MAX), filtered by standard_code so it only returns that
 * standard's vectors. Fail-open per standard: on error the result simply
 * renders without an excerpt, as before.
 */
async function backfillExcerpts(env: Env, queryVector: number[], apps: ApplicationRow[], excerptIndex: ExcerptIndex): Promise<void> {
  const targets: string[] = [];
  const seen = new Set<string>();
  for (const app of apps) {
    const std = app.Standard;
    if (!std || seen.has(std)) continue;
    seen.add(std);
    const bucket = excerptIndex[std] || [];
    const hasProse = bucket.some(c => c.chunk_type !== 'table' && !isTableLike(c.excerpt_text));
    if (!hasProse) targets.push(std);
    if (targets.length >= EXCERPT_BACKFILL_MAX) break;
  }
  if (targets.length === 0) return;

  await Promise.all(targets.map(async (std) => {
    try {
      const res = await env.VECTORIZE.query(queryVector, {
        topK: EXCERPT_BACKFILL_TOP_K,
        returnMetadata: 'all',
        filter: { standard_code: std },
      });
      for (const m of (res.matches || []) as unknown as VMatch[]) {
        const meta = m.metadata || {};
        // The filter also matches this standard's application vectors — skip.
        // Reference entries make poor "From the Standard" excerpts too.
        if (meta.chunk_type === 'application' || meta.chunk_type === 'reference') continue;
        if (!meta.standard_id || !meta.excerpt_text) continue;
        if (!excerptIndex[meta.standard_id]) excerptIndex[meta.standard_id] = [];
        excerptIndex[meta.standard_id].push({ ...meta, score: m.score });
      }
      if (excerptIndex[std]) excerptIndex[std].sort((a, b) => b.score - a.score);
    } catch (err) {
      console.error(`excerpt backfill failed for ${std} (non-fatal):`, errMsg(err));
    }
  }));
}

/**
 * Heuristic mirror of the UI's looksLikeTableDump(): text that is mostly
 * digits (or barely letters) is a raw table dump, not prose. Used to decide
 * whether a standard still needs an excerpt backfill and to keep chunk-only
 * results with nothing displayable out of the list. No text = not prose.
 */
function isTableLike(text: string | null | undefined): boolean {
  if (!text) return true;
  const t = String(text);
  const digitRatio = (t.match(/\d/g) || []).length / t.length;
  const letterRatio = (t.match(/[a-zA-Z]/g) || []).length / t.length;
  return digitRatio > 0.22 || letterRatio < 0.45;
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
function pickExcerptForApp(excerptIndex: ExcerptIndex, app: ApplicationRow): ExcerptChunk | null {
  const bucket = app.Standard ? excerptIndex[app.Standard] : undefined;
  if (!bucket || bucket.length === 0) return null;

  const isTable = (c: ExcerptChunk) => c.chunk_type === 'table';
  const appPage = app.Page_Number;

  if (appPage != null) {
    const NEAR_RADIUS = 5;
    const inRadius = bucket.filter(c => c.page_number != null && Math.abs(c.page_number - appPage) <= NEAR_RADIUS);
    const pickNearest = (pool: ExcerptChunk[]): ExcerptChunk | null => {
      let best: ExcerptChunk | null = null, bestDist = Infinity;
      for (const c of pool) {
        const dist = Math.abs((c.page_number ?? 0) - appPage);
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

function formatApplication(app: ApplicationRow): FormattedApplication {
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
    // WHERE each footnote marker attaches in the printed table (see migration
    // 0006): { levels: { App_s1: [1] }, row: [3] }. The UI uses this to draw
    // inline superscripts on the exact hierarchy label the source table marks
    // — header-level notes never print independently on sub-rows.
    footnoteMarks: parseFootnoteMarks(app.Footnote_Marks),
    generalNotes: app.General_Notes,
    appNotes:     app.App_Notes,
  };
}

function parseFootnoteMarks(raw: string | null | undefined): FootnoteMarks | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === 'object') ? parsed : null;
  } catch {
    return null;
  }
}

// ─── Unit Filtering ───────────────────────────────────────────────────────────

/**
 * Strip lux or fc fields based on user preference.
 * Default is 'both' — only strip when explicitly requested.
 */
function applyUnits(results: SearchResult[], units: string): SearchResult[] {
  if (units === 'both' || !units) return results;

  return results.map(r => {
    const app = { ...r.application };
    for (const block of ['horizontal', 'vertical', 'task'] as const) {
      const plane = app[block];
      if (!plane) continue;
      if (units === 'lux') {
        const { fc, heightFt, ...rest } = plane; // eslint-disable-line no-unused-vars
        app[block] = rest;
      } else if (units === 'fc') {
        const { lux, heightM, ...rest } = plane; // eslint-disable-line no-unused-vars
        app[block] = rest;
      }
    }
    return { ...r, application: app };
  });
}

// ─── Chunk Fallback Builder ───────────────────────────────────────────────────
// When no structured application records exist yet, surface PDF chunks directly.

function buildChunkResults(chunkMatches: VMatch[], linkCtx: LinkCtx = {}, { perStandard = 1 }: { perStandard?: number } = {}): SearchResult[] {
  // Group by standard_id. Body-excerpt mode keeps the single best chunk per
  // standard; references mode keeps EVERY entry (perStandard: Infinity) —
  // each bibliography entry is its own result.
  const byStandard = new Map<string, VMatch[]>();
  for (const match of chunkMatches) {
    const stdId = match.metadata?.standard_id || match.metadata?.standard_code;
    if (!stdId) continue;
    if (!byStandard.has(stdId)) byStandard.set(stdId, []);
    byStandard.get(stdId)!.push(match);
  }

  const picked: Array<[string, VMatch]> = [];
  for (const [stdId, matches] of byStandard) {
    matches.sort((a, b) => (b.score || 0) - (a.score || 0));
    for (const match of matches.slice(0, perStandard === Infinity ? matches.length : perStandard)) {
      picked.push([stdId, match]);
    }
  }

  return picked.map(([stdId, match]) => {
    // Full-title citation (client requirement — applies to BOTH result
    // render paths): designation + descriptive title + page.
    const stdInfo = linkCtx.standardsIndex?.get(stdId);
    const designation = stdInfo?.fullDesignation || match.metadata?.standard_code || stdId;
    const fullName = composeStandardName(designation, stdInfo?.title || null);
    const pageNum = match.metadata?.page_number || null;

    return {
      resultType: match.metadata?.chunk_type === 'reference' ? 'reference' : 'excerpt',
      // Chunk results have no application row, so synthesize the minimal
      // fields buildVitriumLink needs: standard id + the chunk's page.
      vitriumLink: buildVitriumLink({
        Standard: stdId,
        Page_Number: pageNum,
      }, linkCtx),
      // Front-of-document link for the citation title (DO1R2) — no fragment.
      standardLink: stdInfo?.webUrl || null,
      application: {
        code: match.id,
        category: stdId,
        sub1: null,
        sub2: null,
        sub3: null,
        fullName: stdId,
        standard: stdId,
        standardFull: designation,
        standardTitle: stdInfo?.title || null,
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
        footnoteMarks: null,
        generalNotes: null,
        appNotes: null,
      },
      relevanceScore: Math.round((match.score || 0) * 1000) / 1000,
      excerpt: {
        text: match.metadata?.excerpt_text || '',
        pageNumber: pageNum,
        section: match.metadata?.section || null,
        chunkType: match.metadata?.chunk_type || 'text',
      },
      citation: `${fullName}${pageNum ? `, p. ${pageNum}` : ''}`,
      relatedApplications: [],
    };
  });
}

// ─── Utility Helpers ──────────────────────────────────────────────────────────

function buildVectorFilter(filters: SearchFilters): Record<string, string | boolean> | null {
  const f: Record<string, string | boolean> = {};
  // indoor_outdoor is deliberately NOT applied at the vector level:
  //   - Text chunks are ingested with indoor_outdoor: null (ingest.js), so an
  //     equality filter silently drops ALL chunk vectors — filtered searches
  //     lost every excerpt and every prose-only standard (client feedback:
  //     "church" returned different standards under All vs Indoor/Outdoor).
  //   - Application rows tagged 'Both' were also excluded, while the D1 layer
  //     includes them — two filters disagreeing on the same request.
  // fetchApplications/textFallback apply the authoritative location filter in
  // D1 (matching the location OR 'Both'); the vector query stays open so the
  // same pool feeds every location choice consistently.
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
function inferFiltersFromQuery(query: string, forceComparison = false): SearchFilters {
  const out: SearchFilters = {};

  const lzMatch = /\b(?:lz)\s*([0-4])\b/i.exec(query);
  if (lzMatch) out.lighting_zone = `LZ${lzMatch[1]}`;

  // Only constrain to a specific standard for version-comparison intent —
  // detected from phrasing OR forced by the "Compare Versions" filter.
  // Outside that intent, mentioning a standard ID in passing should not
  // hide adjacent standards from the result list.
  //
  // Use standard_prefix (LIKE) rather than standard (=) because users say
  // "RP-43" but the D1 Standard column carries the year suffix ("RP-43-25").
  if (forceComparison || isVersionComparisonQuery(query)) {
    const stdMatch = /\b((?:RP|TM|HB|LM|LP|LS|DG|LEM|G)-\d+(?:\.\d+)?)\b/i.exec(query);
    if (stdMatch) out.standard_prefix = stdMatch[1].toUpperCase();
  }

  return out;
}

function dedupeByCode(matches: VMatch[]): VMatch[] {
  const seen = new Map<string, VMatch>();
  for (const m of matches) {
    const code = m.metadata?.application_code;
    if (!code) continue;
    if (!seen.has(code) || seen.get(code)!.score < m.score) {
      seen.set(code, m);
    }
  }
  return [...seen.values()].sort((a, b) => b.score - a.score);
}

function deduplicateScored(scored: ScoredApp[]): ScoredApp[] {
  const seen = new Map<string, ScoredApp>();
  for (const item of scored) {
    const code = item.app.code;
    if (!seen.has(code) || seen.get(code)!.score < item.score) {
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
function compareScoredApps(a: ScoredApp, b: ScoredApp): number {
  const SCORE_EPSILON = 0.01;
  const scoreDiff = b.score - a.score;
  if (Math.abs(scoreDiff) > SCORE_EPSILON) return scoreDiff;

  const A = a.app, B = b.app;
  const hierarchyKeys = ['Sub_Category', 'App', 'App_s1', 'App_s2', 'App_s3', 'App_s4'];
  for (const key of hierarchyKeys) {
    const cmp = compareHierarchyField(A[key as keyof typeof A] as string | null, B[key as keyof typeof B] as string | null);
    if (cmp !== 0) return cmp;
  }
  return rowRefNumber(A.Row_Ref) - rowRefNumber(B.Row_Ref);
}

/**
 * Same tie-break logic as compareScoredApps, but for the formatted
 * `result` shape returned by buildResult (used after a fallback merge).
 */
function compareResults(a: SearchResult, b: SearchResult): number {
  const SCORE_EPSILON = 0.01;
  const scoreDiff = (b.relevanceScore || 0) - (a.relevanceScore || 0);
  if (Math.abs(scoreDiff) > SCORE_EPSILON) return scoreDiff;

  const A = a.application, B = b.application;
  const hierarchyKeys = ['subCategory', 'category', 'sub1', 'sub2', 'sub3', 'sub4'];
  for (const key of hierarchyKeys) {
    const cmp = compareHierarchyField(A[key as keyof typeof A] as string | null, B[key as keyof typeof B] as string | null);
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
function compareHierarchyField(a: string | null | undefined, b: string | null | undefined): number {
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

function rowRefNumber(rowRef: string | number | null | undefined): number {
  if (!rowRef) return Number.MAX_SAFE_INTEGER;
  const m = /(\d+)/.exec(String(rowRef));
  return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
}

function mergeResults(primary: SearchResult[], fallback: SearchResult[]): void {
  const seen = new Set(primary.map(r => r.application.code));
  for (const item of fallback) {
    if (!seen.has(item.application.code)) {
      primary.push(item);
      seen.add(item.application.code);
    }
  }
}

/**
 * Build the "View in Vitrium" link for an application result.
 *
 * Vitrium's web viewer uses opaque short-code URLs
 * (https://view.protectedpdf.com/XXXXXX) that cannot be constructed from a
 * doc ID, so the URL comes from data, not string-building:
 *
 *   1. Vitrium_Deep_Link — full URL curated on the application row, used as-is
 *   2. Standard-level web viewer URL (standards.vitrium_web_url, populated
 *      by scripts/sync-metadata.js), plus a best-effort fragment:
 *      Link_Mapping section anchor, else #page=N from the app's Page_Number.
 *      If the viewer ignores fragments, the link still opens the document.
 *
 * Returns null when no URL is known — the UI hides the button.
 */
function buildVitriumLink(app: { Standard?: string | null; Page_Number?: number | null; Link_Mapping?: string | null; Vitrium_Deep_Link?: string | null }, linkCtx: LinkCtx = {}): string | null {
  if (app.Vitrium_Deep_Link) return app.Vitrium_Deep_Link;

  const webUrl = linkCtx.standardsIndex?.get(app.Standard ?? '')?.webUrl;
  if (!webUrl) return null;

  if (app.Link_Mapping) return `${webUrl}#${app.Link_Mapping}`;
  if (app.Page_Number != null) return `${webUrl}#page=${app.Page_Number}`;
  return webUrl;
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
