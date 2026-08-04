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

import {
  prepareQueryForEmbedding, splitMultiQuery, cleanQuery,
  isVersionComparisonQuery, isReferenceQuery, isDefinitionQuery, normalizeTypography,
} from '../lib/query-expander';
import {
  DEFINITIONS_STANDARD_FULL, DEFINITIONS_STANDARD_TITLE,
} from '../lib/definitions.js';
import { resolveCommittee } from '../lib/committees.js';
import { generateResponse } from '../lib/ai-summary';
import { formatCitation, composeStandardName } from '../lib/citations';
import { looksLikeFormalReference, referenceCitationKey } from '../lib/references.js';
import { referenceEntryNumber } from '../lib/reference-markers.js';
import { hasEnvConsiderationColumns, parseLightingZoneLabel } from '../lib/illuminance-fields.js';
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
  AIMode, ApplicationRow, ComparisonContext, ContentType, Excerpt, FootnoteMarks, FormattedApplication,
  OutdoorGuidance, ReferenceLink, ReferenceMarker, RelatedApplication, SearchFilters, SearchResult,
  StandardIndexEntry, StandardRow, StandardsIndex, VectorMetadata,
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

// "From the Standard" drop-down (client DO22): up to 10 relevant excerpts per
// result card, each with its own page-targeted "Open in Library" link.
const EXCERPTS_PER_RESULT = 10;

// Document-body share of the result pool (client DO23): with Illuminance
// Tables + Document Body both selected, application vectors outnumber prose
// chunks so heavily that body excerpts were squeezed out of the top `limit`.
// At least this fraction of the pool is reserved for body results when that
// many are available.
// Raised 0.3→0.4 and 3→5 (client DO23, second pass): with both boxes ticked a
// broad conceptual query still came back with a single document-body card.
const BODY_RESULT_MIN_SHARE = 0.4;
const BODY_CHUNKS_PER_STANDARD = 5; // body excerpts kept per standard (was 1, then 3)

/**
 * Resolve the lighting zone for an application row (client DO20/DO21).
 *
 * The zone is a hierarchy slot in the new table schema (it appears as App_s1…
 * App_s6, e.g. RP-2 Table A-2 "Ramps, Stairs, and Steps › High activity › Lz4"),
 * and only sometimes lands in the Lighting_Zone column — the extractor used to
 * accept the bare `Lz4` form only, so every RP-2 curfew row ("Lz3 (and Lz4
 * curfew)") produced a NULL zone and its card showed no Lighting Zone field at
 * all, leaving several otherwise-identical rows indistinguishable.
 *
 * Derived here, at query time, so existing indexed data displays correctly
 * without a re-ingest.
 *
 * @returns label as printed (for display), the normalized LZ code (for
 *          filtering/sorting), and the curfew zone when the label pairs one.
 */
export function deriveLightingZone(app: {
  Lighting_Zone?: string | null; Curfew_Dimming?: string | null;
  App?: string | null; App_s1?: string | null; App_s2?: string | null; App_s3?: string | null;
  App_s4?: string | null; App_s5?: string | null; App_s6?: string | null;
}): { label: string | null; code: string | null; curfew: string | null } {
  const candidates = [
    app.Lighting_Zone,
    // Deepest hierarchy level first: the zone is the most specific label on
    // the row, so a deeper match beats a shallower one.
    app.App_s6, app.App_s5, app.App_s4, app.App_s3, app.App_s2, app.App_s1, app.App,
  ];

  for (const raw of candidates) {
    const parsed = parseLightingZoneLabel(raw);
    if (!parsed) continue;
    return { ...parsed, curfew: parsed.curfew || app.Curfew_Dimming || null };
  }

  return { label: null, code: null, curfew: app.Curfew_Dimming || null };
}

// Content-type filter (client filter overhaul): independent checkboxes for
// what KINDS of results appear. Defaults mirror the UI (tables + body on,
// references off). 'compare' additionally forces version-comparison handling.
const DEFAULT_CONTENT_TYPES: ContentType[] = ['tables', 'body'];
const VALID_CONTENT_TYPES = new Set(['tables', 'body', 'references', 'definitions', 'compare']);

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

  // Same rule for definition-seeking phrasing ("define illuminance", "what does
  // mesopic mean") — client DO33 adds Definitions as its own content type, and
  // an explicit request for terminology should not have to be filtered by hand.
  if (isDefinitionQuery(rawQuery)) {
    const isDefaultSelection = cleaned.length === 0 ||
      (ct.has('tables') && ct.has('body') && !ct.has('definitions') && substantive.length === 2);
    if (isDefaultSelection) {
      ct.delete('tables');
      ct.delete('body');
    }
    ct.add('definitions');
  }
  return ct;
}

// ── Result mix by type (client DO39) ─────────────────────────────────────────
//
// "Increase density of Document & Definitions & References results, even if match
//  is lower %. Decrease density of low-quality Illuminance Table results."
//
// Two levers, both deliberately gentle:
//
//   1. A per-type FLOOR on match quality. An illuminance-table row has to clear a
//      high bar to earn a slot, because a weak table row is actively misleading —
//      it looks like a recommendation for the wrong application. Prose and
//      references are useful at much lower similarity: the reader judges the
//      passage themselves.
//   2. A small type BONUS applied only when two results are otherwise close, so
//      relevance still decides the ordering and the type preference only breaks
//      near-ties. A hard type sort would bury a 90% table row under a 30%
//      reference, which is not what "gently prioritize" means.
const TYPE_MATCH_FLOOR: Record<string, number> = {
  excerpt: 0.25,     // Document
  definition: 0.40,
  reference: 0.25,
  application: 0.50, // Illuminance Table
};

// Priority order: Document, Definitions, Illuminance Tables, References. Spaced
// by 0.004 so the whole span (0.012) stays inside compareResults' 0.01 score
// epsilon — i.e. it can only ever reorder results already treated as tied.
const TYPE_PRIORITY: Record<string, number> = {
  excerpt: 0.012,
  definition: 0.008,
  application: 0.004,
  reference: 0,
};

/** The floor a result of this type must clear to be shown at all (DO39). */
export function typeMatchFloor(resultType: string | undefined): number {
  return TYPE_MATCH_FLOOR[resultType || 'application'] ?? 0;
}

/**
 * Drop results that do not clear their type's match floor (client DO39).
 *
 * Never returns an empty list when the search DID find something: if every
 * result is below its floor, the best few are kept rather than telling the user
 * there is nothing — the low-confidence banner already says confidence is poor,
 * and "here are the closest matches" beats a blank page.
 */
export function applyTypeFloors(results: SearchResult[], keepAtLeast = 3): SearchResult[] {
  const kept = results.filter(r => (r.relevanceScore || 0) >= typeMatchFloor(r.resultType));
  if (kept.length > 0) return kept;
  return [...results]
    .sort((a, b) => (b.relevanceScore || 0) - (a.relevanceScore || 0))
    .slice(0, keepAtLeast);
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
    // Several anchors, not one: RP-8 is a long document and "all standards
    // contain critical details throughout each chapter" (client DO28). One
    // anchor retrieved one chapter's worth of prior-edition text, so the
    // comparison could only speak about that chapter. Anchor on the top few
    // current excerpts from DIFFERENT pages so the prior edition is sampled
    // across the document.
    const topicHints = collectTopicHints(allResults.results);
    const deprecatedResults = await searchDeprecatedForComparison(rawQuery, mergedFilters, env, topicHints, depDbg);
    allResults.results.push(...deprecatedResults);
    // Current edition first, then prior editions newest → oldest (client DO27).
    allResults.results = orderComparisonResults(allResults.results);
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

  // Which AI Guide prompt applies (client DO24 / DO25 / DO26.5): a comparison
  // gets the three-section "what changed" analysis, a References-only search
  // gets the reference-frequency answer, everything else gets guidance.
  const referencesOnly = contentTypes.has('references') && !contentTypes.has('tables') && !contentTypes.has('body');
  // A Definitions-only search is a terminology lookup, not a request for lighting
  // recommendations (client DO33) — the low-confidence advisory does not apply.
  const definitionsOnly = contentTypes.has('definitions')
    && !contentTypes.has('tables') && !contentTypes.has('body') && !contentTypes.has('references');
  const aiMode: AIMode = isVersionComparison ? 'comparison' : (referencesOnly ? 'references' : 'guide');
  const currentIdForComparison = allResults.results.find(r => !r.isDeprecated)?.application?.standard || null;
  const comparisonContext = aiMode === 'comparison'
    ? buildComparisonContext(allResults.results, requestedDeprecatedEdition(rawQuery, currentIdForComparison))
    : undefined;

  const aiPromise = (includeAISummary && allResults.results.length > 0)
    ? (async () => {
        try {
          const resultCodes = allResults.results.slice(0, 5).map(r => r.application?.code).filter(Boolean);
          // The mode is part of the key: the same query+results can produce a
          // guide OR a comparison, and they must not share a cache entry.
          const aiKey = await buildAISummaryCacheKey(dataVersion, aiMode, rawQuery, resultCodes);
          const cached = body.debug ? null : await getCachedAISummary(kv, aiKey);
          if (cached) return cached;
          const generated = await generateResponse(env.AI, rawQuery, allResults.results, {
            mode: aiMode,
            comparison: comparisonContext,
          });
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
            mode: aiMode,
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
  const noStrongMatch = !referencesOnly && !definitionsOnly && !isVersionComparison
    && topScore < STRONG_MATCH_THRESHOLD;

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
    // Front-cover Library URLs for every standard in this result set, so the UI
    // can hyperlink the standards the AI Guide names in its prose (DO24).
    standardLinks: buildStandardLinkMap(allResults.results),
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
 * Front-cover Lighting Library URL for every standard in a result set, keyed by
 * BOTH its id ("RP-2-20+E1") and its full designation ("ANSI/IES RP-2-20+E1").
 *
 * The AI Guide names standards in prose; the UI turns those names into links
 * (client DO24: "can standards referenced within the AI Explanation be
 * hyperlinked to each document in Vitrium?"). Only standards actually in the
 * result set are included — the model is instructed to cite from them, and a
 * link is never fabricated for anything else.
 */
function buildStandardLinkMap(results: SearchResult[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const r of results) {
    const url = r.standardLink;
    if (!url) continue;
    for (const key of [r.application?.standard, r.application?.standardFull]) {
      if (key && !map[key]) map[key] = url;
    }
  }
  return map;
}

/**
 * Does a standard id fall inside the request's standard/family scope?
 *
 * Mirrors the D1 predicates (`Standard = ?` / `Standard LIKE '<family>-%'`) for
 * Vectorize results, which cannot express a LIKE filter. Without it a scoped
 * search narrowed only its application rows while body and reference chunks from
 * every other standard came through — the AI Guide then analysed the wrong
 * document on a version comparison (client DO25).
 */
export function matchesStandardScope(filters: SearchFilters, id: string | null | undefined): boolean {
  if (!filters.standard && !filters.standard_prefix) return true;
  const upper = String(id || '').toUpperCase();
  if (!upper) return false;
  if (filters.standard) return upper === filters.standard.toUpperCase();
  const family = String(filters.standard_prefix).toUpperCase();
  // "RP-8" matches RP-8-25+E2 but never RP-80-*.
  return upper === family || upper.startsWith(`${family}-`);
}

/** The family prefix of a standard id: "RP-8-25" → "RP-8", "TM-30-18" → "TM-30". */
function standardFamily(id: string | null | undefined): string {
  if (!id) return '';
  const upper = String(id).toUpperCase();
  const m = /^(.+?)-\d{2}(?:R\d{2})?(?:\+E\d+)?$/.exec(upper);
  return m ? m[1] : upper;
}

/**
 * The publication year encoded in a standard id, as a full 4-digit year.
 * "RP-8-25" → 2025, "RP-8-99" → 1999, "LM-63-19R25" → 2019 (the edition, not
 * the reaffirmation), "RP-8-25+E2" → 2025.
 *
 * IES ids carry two digits, so the century is inferred: anything above the
 * current two-digit year window belongs to the 1900s. Used to order deprecated
 * editions newest → oldest (client DO27).
 */
export function editionYear(id: string | null | undefined): number {
  if (!id) return -1;
  const m = /-(\d{2})(?:R\d{2})?(?:\+E\d+)?$/.exec(String(id).toUpperCase());
  if (!m) return -1;
  const yy = Number(m[1]);
  // 00–49 → 2000s, 50–99 → 1900s. No IES standard in this corpus predates 1950
  // and none is dated past 2049.
  return yy <= 49 ? 2000 + yy : 1900 + yy;
}

/**
 * Order a comparison result list the way the client specified (DO27):
 *
 *   1. the CURRENT standard's results first, in relevance order
 *   2. then the deprecated editions, newest → oldest, each edition's excerpts
 *      kept together and in relevance order
 *
 * "Easy access to quickly open both files for manual comparison" — the reader
 * scans down from the current edition through the prior ones in publication
 * order, so the pairing is obvious without reading match percentages.
 */
export function orderComparisonResults(results: SearchResult[]): SearchResult[] {
  const current = results.filter(r => !r.isDeprecated);
  const deprecated = results.filter(r => r.isDeprecated);
  if (deprecated.length === 0) return results;

  // Group by edition so an edition's excerpts never interleave with another's.
  const byEdition = new Map<string, SearchResult[]>();
  for (const r of deprecated) {
    const id = r.application?.standard || '';
    if (!byEdition.has(id)) byEdition.set(id, []);
    byEdition.get(id)!.push(r);
  }
  const orderedDeprecated = [...byEdition.entries()]
    .sort((a, b) => editionYear(b[0]) - editionYear(a[0]) || b[0].localeCompare(a[0]))
    .flatMap(([, group]) => group.sort((x, y) => (y.relevanceScore || 0) - (x.relevanceScore || 0)));

  return [...current, ...orderedDeprecated];
}

/**
 * Which editions a version comparison is actually between (client DO25 / DO27).
 *
 * The deprecated results carry a `supersededBy` pointer, so the current edition
 * is resolved in that order: the explicitly-superseding result → any current
 * result of the same family → the top current result.
 *
 * `deprecated` holds ONLY the edition the analysis is against — the most recent
 * deprecated one, unless the query names a different edition explicitly (client
 * DO27: "in AI Summary, only compare the current standard to the most recent
 * deprecated standard unless otherwise requested by user"). The older editions
 * move to `alsoDeprecated`, which the UI still lists and links but the model is
 * told to leave alone. Comparing against four prior editions at once is what
 * produced the DO28 answer that named RP-8-14 as the edition RP-8-25+E2
 * replaced.
 */
export function buildComparisonContext(results: SearchResult[], requestedEdition?: string | null): ComparisonContext {
  const editions: NonNullable<ComparisonContext['deprecated']> = [];
  const seen = new Set<string>();
  for (const r of results) {
    if (!r.isDeprecated) continue;
    const id = r.application?.standard;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    editions.push({
      id,
      name: r.application?.standardFull || id,
      url: r.standardLink || null,
    });
  }
  // Newest first, so [0] is the comparison target.
  editions.sort((a, b) => editionYear(b.id) - editionYear(a.id) || b.id.localeCompare(a.id));

  const wanted = requestedEdition ? requestedEdition.toUpperCase() : null;
  const targetIdx = wanted
    ? Math.max(0, editions.findIndex(e => e.id.toUpperCase().startsWith(wanted)))
    : 0;
  const target = editions[targetIdx] ? [editions[targetIdx]] : [];
  const alsoDeprecated = editions.filter((_, i) => i !== targetIdx);

  const currents = results.filter(r => !r.isDeprecated && r.application?.standard);
  const supersededBy = results.find(r => r.isDeprecated && r.supersededBy)?.supersededBy || null;
  const family = editions.length > 0 ? standardFamily(editions[0].id) : '';
  const pick =
    (supersededBy && currents.find(r => r.application.standard === supersededBy)) ||
    (family && currents.find(r => standardFamily(r.application.standard) === family)) ||
    currents[0] ||
    null;

  return {
    current: pick
      ? {
          id: pick.application.standard || '',
          name: pick.application.standardFull || pick.application.standard || '',
          url: pick.standardLink || null,
        }
      : null,
    deprecated: target,
    alsoDeprecated,
  };
}

/**
 * A specific prior edition named in the query ("what changed between RP-8-25
 * and RP-8-18?"), so the comparison targets that edition instead of the most
 * recent deprecated one. Returns the bare edition id, or null.
 */
export function requestedDeprecatedEdition(rawQuery: string, currentId?: string | null): string | null {
  const query = normalizeTypography(rawQuery).toUpperCase();
  const re = /\b((?:RP|TM|HB|LM|LP|LS|DG|LEM|G)-\d+(?:\.\d+)?-\d{2}(?:\+E\d+)?)\b/g;
  const named = [...query.matchAll(re)].map(m => m[1]);
  if (named.length === 0) return null;
  const current = (currentId || '').toUpperCase();
  // An edition the query names that is NOT the current one is the requested
  // prior edition. Errata suffixes are ignored when comparing against current.
  const base = (id: string) => id.replace(/\+E\d+$/, '');
  return named.find(id => base(id) !== base(current)) || null;
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
  const includeDefs = contentTypes.has('definitions');

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

  // 4c. Honour a standard/family filter on CHUNK results too. Vectorize has no
  //     LIKE operator, so `standard_prefix` was only ever applied in D1 — to
  //     application rows — while body and reference chunks from every other
  //     standard came through untouched. On a version comparison that is
  //     actively wrong: "what's new in RP-8?" pinned the search to the RP-8
  //     family, then fed the AI Guide excerpts from TM-30-24, and the analysis
  //     discussed changes to a different document (client DO25).
  const inStandardScope = (m: VMatch): boolean =>
    matchesStandardScope(filters, m.metadata?.standard_id || m.metadata?.standard_code);
  if (filters.standard || filters.standard_prefix) {
    chunkMatches = chunkMatches.filter(inStandardScope);
    referenceMatches = referenceMatches.filter(inStandardScope);
  }

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
  if (includeBody) {
    // 8a. Harvest the backfill's prose into the body pool (client DO23, second
    //     pass: "increase qty of results from body of document"). Step 6.5
    //     already pulled up to 20 chunks per top standard through a
    //     standard_code-filtered query, and those chunks are strictly better
    //     body candidates than what survives in the shared top-50 pool — where
    //     application vectors crowd prose out. Reusing them costs no extra
    //     Vectorize calls, and it works even when the chunk_type metadata index
    //     post-dates the corpus (the case that silently emptied the
    //     body-scoped query in step 3b).
    const poolIds = new Set(chunkMatches.map(m => m.id));
    const harvested: VMatch[] = [];
    for (const [stdId, bucket] of Object.entries(excerptIndex)) {
      for (const c of bucket) {
        if (c.chunk_type === 'application' || c.chunk_type === 'reference') continue;
        // Synthesize the deterministic-looking id the pool dedupes on. The
        // excerpt index drops vector ids, so key on (standard, page, opening).
        const id = `harvest:${stdId}:${c.page_number ?? '?'}:${(c.excerpt_text || '').slice(0, 40)}`;
        if (poolIds.has(id)) continue;
        poolIds.add(id);
        harvested.push({ id, score: c.score, metadata: { ...c, standard_id: c.standard_id || stdId } });
      }
    }
    const bodyPool = [...chunkMatches, ...harvested];

    const liveChunks = bodyPool.filter(m => {
      const id = m.metadata?.standard_id || m.metadata?.standard_code;
      return id && standardsIndex.has(id);
    });
    // A chunk-only result has no structured illuminance data — its excerpt IS
    // the card. Raw table dumps and heading stubs render as an empty card
    // (client feedback: "transition and circulation space", "elevator"), so
    // only chunks with real prose are allowed to become standalone results.
    // On a version comparison, packaging pages (errata, reference lists, TOC)
    // are worse than useless: they crowd out the provisions the comparison is
    // supposed to be about. Ordinary searches keep them.
    const comparisonIntent = contentTypes.has('compare') || isVersionComparisonQuery(rawQuery);
    // Content-level dedupe: the harvested backfill chunks and the shared pool
    // legitimately overlap (same vector reached both ways) but carry different
    // ids, so identity alone would print the same passage twice.
    const seenPassages = new Set<string>();
    const displayableChunks = liveChunks.filter(m => {
      const meta = m.metadata || {};
      const text = String(meta.excerpt_text || '');
      if (meta.chunk_type === 'table' || text.trim().length < 60 || isTableLike(text)) return false;
      if (comparisonIntent && looksLikeFrontMatter(text)) return false;
      const key = `${meta.standard_id || meta.standard_code || ''}|${meta.page_number ?? '?'}|${text.slice(0, 80)}`;
      if (seenPassages.has(key)) return false;
      seenPassages.add(key);
      return true;
    });
    const chunkResults = buildChunkResults(displayableChunks, linkCtx, { perStandard: BODY_CHUNKS_PER_STANDARD });
    if (chunkResults.length > 0) {
      const merged = [...results, ...chunkResults].sort(compareResults);
      // Reserve a share of the pool for document-body excerpts (client DO23:
      // "increase qty of results from body of document when both illuminance
      // table and body of document are selected" — score ordering alone lets
      // the far more numerous application rows take every slot).
      results = includeTables
        ? reserveBodySlots(merged, limit, chunkResults.length)
        : merged.slice(0, limit);
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
    // Only entries that are actually listed as a FORMAL reference in the
    // REFERENCES chapter may appear (client DO26.1). The chunker opens a
    // reference run on any line reading "References", so form/checklist prose
    // ("Please verify that all attachments and references are relevant…") had
    // been indexed as reference chunks; content-level validation rejects it
    // here regardless of when the document was ingested.
    // The reference-scoped queries above re-fetch from Vectorize, whose filter
    // cannot express a family prefix — re-apply the scope (see 4c).
    const scopedRefPool = (filters.standard || filters.standard_prefix)
      ? refPool.filter(inStandardScope)
      : refPool;
    const formalRefs = scopedRefPool.filter(m => looksLikeFormalReference(m.metadata?.excerpt_text || ''));
    const liveRefs = formalRefs.filter(m => {
      const id = m.metadata?.standard_id || m.metadata?.standard_code;
      return id && standardsIndex.has(id);
    });
    // Which standards' References sections carry each cited work (DO26.4).
    // Built from the whole formal pool, so a work cited by several standards
    // lists them all even when only one entry became a result.
    const markerIndex = buildReferenceMarkerIndex(formalRefs);
    // Every reference entry is its own result (perStandard: Infinity) — a
    // reference listing that collapsed to one entry per standard would be
    // useless as a bibliography view.
    const refResults = buildChunkResults(liveRefs, linkCtx, { perStandard: Infinity })
      .map(r => ({
        ...r,
        referenceLink: buildReferenceLink(r.excerpt?.text || '', standardsIndex),
        referenceMarkers: lookupReferenceMarkers(markerIndex, r.excerpt?.text || '', standardsIndex),
      }));
    if (refResults.length > 0) {
      results.push(...refResults);
      results.sort(compareResults);
      results = results.slice(0, limit);
    }
  }

  // 12. Definitions mode (client DO33) — ANSI/IES LS-1 terminology as its own
  //     result type. Definition vectors live in the main index tagged
  //     chunk_type='definition'; the rich text is hydrated from D1 so the card
  //     can print the definition in full, tables and images included.
  if (includeDefs) {
    try {
      const defResults = await searchDefinitions(env, queryVector, rawQuery, limit, linkCtx);
      if (defResults.length > 0) {
        const definitionsOnly = !includeTables && !includeBody && !includeRefs;
        // A Definitions-only search IS the definition list — never let a stray
        // application row outrank a term the user explicitly asked to look up.
        results = definitionsOnly
          ? defResults.slice(0, limit)
          : [...results, ...defResults].sort(compareResults).slice(0, limit);
      }
    } catch (err) {
      console.error('definition search failed (non-fatal):', errMsg(err));
    }
  }

  // 13. Per-type match floors (client DO39) — a weak illuminance-table row is
  //     worse than no row (it reads as a recommendation for the wrong
  //     application), while prose and reference entries stay useful much lower
  //     down. Applied last so it trims the assembled mix rather than starving an
  //     earlier stage of candidates.
  results = applyTypeFloors(results);

  // 9. Publication-order clustering — sibling rows of the same application
  //    block print together, ordered as in the source table (client
  //    feedback: Figure Skating Class I–IV / Recreational must follow the
  //    standard's row order, not raw vector-score order).
  return { results: clusterSiblings(results), expandedQuery };
}

// ─── Definitions (client DO33) ────────────────────────────────────────────────

const DEFINITION_TOP_K = 30;
// An exact term hit is never merely "relevant" — it is the answer. Scored above
// any vector match so "Color" returns the `color` definition first, whatever the
// embedding thinks.
const DEFINITION_EXACT_SCORE = 1;
const DEFINITION_PREFIX_SCORE = 0.95;

/**
 * Search the ANSI/IES LS-1 definitions.
 *
 * Two retrieval paths, unioned:
 *   1. Exact / prefix term match in D1 — a bare term query ("color", "mesopic")
 *      must land on that term's own definition, and this also carries the mode
 *      when the Vectorize chunk_type metadata index post-dates the definition
 *      ingest (the failure that silently emptied References mode, DO12).
 *   2. Semantic match over definition vectors, for descriptive queries
 *      ("the ratio of absorbed flux to incident flux").
 *
 * Rich text always comes from D1: Vectorize metadata holds a truncated plain-text
 * copy, but the card prints the definition IN FULL with its original emphasis,
 * inline math and images (client DO33).
 */
export async function searchDefinitions(
  env: Env, queryVector: number[], rawQuery: string, limit: number, linkCtx: LinkCtx = {},
): Promise<SearchResult[]> {
  const term = definitionSearchTerm(rawQuery);
  const scores = new Map<string, number>(); // slug → score

  // 1. Term match in D1.
  if (term) {
    const rows = await env.DB.prepare(`
      SELECT slug, term FROM definitions
      WHERE LOWER(term) = ?1 OR LOWER(term) LIKE ?2 OR LOWER(term) LIKE ?3
      LIMIT 25
    `).bind(term, `${term}, %`, `${term} %`).all<{ slug: string; term: string }>();
    for (const r of rows.results || []) {
      const exact = r.term.toLowerCase() === term;
      scores.set(r.slug, exact ? DEFINITION_EXACT_SCORE : DEFINITION_PREFIX_SCORE);
    }
  }

  // 2. Semantic match. Fail-open: without the chunk_type metadata index this
  //    query errors or returns nothing, and the term match above still answers.
  try {
    const res = await env.VECTORIZE.query(queryVector, {
      topK: DEFINITION_TOP_K,
      returnMetadata: 'all',
      filter: { chunk_type: 'definition' },
    });
    for (const m of (res.matches || []) as unknown as VMatch[]) {
      const slug = (m.metadata as { definition_slug?: string } | undefined)?.definition_slug;
      if (!slug) continue;
      const prev = scores.get(slug);
      // Cap semantic scores below the term-match band so an exact term always wins.
      const score = Math.min(m.score, DEFINITION_PREFIX_SCORE - 0.01);
      if (prev == null || prev < score) scores.set(slug, score);
    }
  } catch (err) {
    console.error('definition vector query failed, using term match only (non-fatal):', errMsg(err));
  }

  if (scores.size === 0) return [];

  const slugs = [...scores.keys()]
    .sort((a, b) => (scores.get(b) || 0) - (scores.get(a) || 0))
    .slice(0, limit);

  const placeholders = slugs.map(() => '?').join(',');
  const rows = await env.DB.prepare(
    `SELECT slug, term, clause, html, text, source_url, standard_id FROM definitions WHERE slug IN (${placeholders})`
  ).bind(...slugs).all<{
    slug: string; term: string; clause: string | null; html: string;
    text: string; source_url: string | null; standard_id: string;
  }>();

  const bySlug = new Map((rows.results || []).map(r => [r.slug, r]));
  return slugs
    .map(slug => {
      const row = bySlug.get(slug);
      return row ? buildDefinitionResult(row, scores.get(slug) || 0, linkCtx) : null;
    })
    .filter((r): r is SearchResult => r !== null);
}

/**
 * The TERM a query is looking up, or null when it is not a term lookup.
 *
 * Strips the lookup phrasing ("define …", "definition of …", "what does … mean")
 * and rejects anything long enough to be a question rather than a term — a
 * seven-word phrase is not going to match `definitions.term` exactly, and running
 * the LIKE against it only costs a round-trip.
 */
export function definitionSearchTerm(rawQuery: string): string | null {
  let q = normalizeTypography(rawQuery).trim().toLowerCase();
  q = q
    .replace(/^(?:please\s+)?(?:define|definition\s+of|definitions\s+of|meaning\s+of|what\s+is\s+the\s+(?:term|definition)\s+(?:of\s+)?|what\s+does|what\s+do)\s+/i, '')
    .replace(/\s+mean(?:ing)?s?\s*\??$/i, '')
    .replace(/\s+(?:in|per|according\s+to)\s+(?:ansi\/ies\s+)?ls-?1(?:-\d{2})?\s*\??$/i, '')
    .replace(/[?.!]+$/, '')
    .replace(/^(?:a|an|the)\s+/i, '')
    .trim();
  if (!q || q.length < 2) return null;
  if (q.split(/\s+/).length > 6) return null;
  return q;
}

/** One D1 definitions row → a Definition result card. */
function buildDefinitionResult(
  row: { slug: string; term: string; clause: string | null; html: string; text: string; source_url: string | null; standard_id: string },
  score: number,
  linkCtx: LinkCtx,
): SearchResult {
  // Every Definition card is titled with the current LS-1 designation (client
  // DO33), whether or not LS-1 itself is indexed as a PDF yet.
  const stdInfo = linkCtx.standardsIndex?.get(row.standard_id);
  const designation = stdInfo?.fullDesignation || DEFINITIONS_STANDARD_FULL;
  const title = stdInfo?.title || DEFINITIONS_STANDARD_TITLE;
  const fullName = composeStandardName(designation, title);
  // Until the glossary moves into Vitrium (client: expected late 2027) the
  // authoritative location is the ies.org page, so that is what the card opens.
  const link = row.source_url || stdInfo?.webUrl || null;

  const excerpt: Excerpt = {
    text: row.text,
    pageNumber: null,
    section: row.clause,
    chunkType: 'definition',
    vitriumLink: link,
  };

  return {
    resultType: 'definition',
    definition: {
      slug: row.slug,
      term: row.term,
      clause: row.clause,
      html: row.html,
      sourceUrl: row.source_url,
    },
    vitriumLink: link,
    // Front-of-document link ONLY (DO1R2) — deliberately NOT the definition's own
    // page. buildStandardLinkMap turns this into the URL the AI Guide's mentions
    // of "ANSI/IES LS-1-25" hyperlink to, and pointing that at one definition
    // would mislabel the whole standard. Null until LS-1 is in the Library, in
    // which case the citation title simply renders unlinked.
    standardLink: stdInfo?.webUrl || null,
    application: {
      code: `definition:${row.slug}`,
      category: row.term,
      sub1: null, sub2: null, sub3: null,
      fullName: row.term,
      standard: row.standard_id,
      standardFull: designation,
      standardTitle: title,
      tableRef: null,
      rowRef: null,
      areaOrTask: null,
      indoorOutdoor: null,
      horizontal: null, vertical: null, task: null,
      tm24Eligible: false, tm24Notes: null,
      outdoor: null,
      footnotes: null, footnoteMarks: null, generalNotes: null, appNotes: null,
    },
    relevanceScore: Math.round(score * 1000) / 1000,
    excerpt,
    excerpts: [excerpt],
    citation: row.clause ? `${fullName}, §${row.clause}` : fullName,
    citationName: fullName,
    citationPage: null,
    relatedApplications: [],
  };
}

/**
 * Trim a merged result list to `limit` while keeping a minimum number of
 * document-body excerpts in it (client DO23).
 *
 * With Illuminance Tables + Document Body both selected, application vectors
 * outnumber prose chunks so heavily that pure score ordering pushed every body
 * excerpt past the cut — the client saw 30 table rows and one body result for a
 * broad conceptual query. Body results below the cut therefore displace the
 * weakest application rows until the reserved share is filled; the pool size is
 * unchanged and relevance ordering inside it is preserved.
 */
export function reserveBodySlots(all: SearchResult[], limit: number, availableBody: number): SearchResult[] {
  const kept = all.slice(0, limit);
  if (all.length <= limit) return kept;

  const isBody = (r: SearchResult) => r.resultType === 'excerpt';
  const target = Math.min(availableBody, Math.ceil(limit * BODY_RESULT_MIN_SHARE));
  let have = kept.filter(isBody).length;
  if (have >= target) return kept;

  const out = [...kept];
  for (const candidate of all.slice(limit).filter(isBody)) {
    if (have >= target) break;
    // Evict the weakest non-body result (the list is score-sorted, so that is
    // the last one) to make room without growing the pool.
    let idx = -1;
    for (let i = out.length - 1; i >= 0; i--) {
      if (!isBody(out[i])) { idx = i; break; }
    }
    if (idx < 0) break; // nothing left to trade away
    out.splice(idx, 1);
    out.push(candidate);
    have++;
  }
  return out.sort(compareResults);
}

// ─── Reference markers (DO26.4) ───────────────────────────────────────────────

/** citation key → standard id → { count, earliest References page, entry # }. */
type ReferenceMarkerIndex = Map<string, Map<string, { count: number; page: number | null; entryNumber: number | null }>>;

const REFERENCE_MARKERS_MAX = 16;

/**
 * Group the reference pool by the WORK each entry cites, so a result card can
 * show which other standards list the same item and where.
 *
 * Scope note: the index is built from the reference chunks this search
 * retrieved, so it reports the standards we actually saw citing the work — not
 * a corpus-wide census.
 *
 * Each standard's own entry NUMBER is recorded alongside, because that is the
 * numeral its body superscripts (client DO31.4): the same work is reference 6 in
 * LS-5-25 and reference 8 in RP-30-25, so the citing page can only be resolved
 * per standard.
 */
function buildReferenceMarkerIndex(matches: VMatch[]): ReferenceMarkerIndex {
  const index: ReferenceMarkerIndex = new Map();
  for (const m of matches) {
    const text = m.metadata?.excerpt_text || '';
    const key = referenceCitationKey(text);
    if (!key) continue;
    const std = m.metadata?.standard_id || m.metadata?.standard_code;
    if (!std) continue;
    if (!index.has(key)) index.set(key, new Map());
    const byStandard = index.get(key)!;
    const page = m.metadata?.page_number ?? null;
    const entryNumber = referenceEntryNumber(text);
    const prev = byStandard.get(std);
    if (prev) {
      prev.count++;
      if (page != null && (prev.page == null || page < prev.page)) prev.page = page;
      if (prev.entryNumber == null) prev.entryNumber = entryNumber;
    } else {
      byStandard.set(std, { count: 1, page, entryNumber });
    }
  }
  return index;
}

function lookupReferenceMarkers(index: ReferenceMarkerIndex, text: string, standardsIndex: StandardsIndex): ReferenceMarker[] {
  const key = referenceCitationKey(text);
  if (!key) return [];
  const byStandard = index.get(key);
  if (!byStandard) return [];

  const out: ReferenceMarker[] = [];
  for (const [std, info] of byStandard) {
    const entry = standardsIndex.get(std);
    // Never point a user at a deprecated edition (agent policy).
    if (entry?.status === 'Deprecated') continue;
    const webUrl = entry?.webUrl || null;

    // Prefer the page in the BODY where this standard superscripts its own
    // reference number — the location the client asked the chip to open
    // (DO31.4). Falls back to the References page for standards ingested before
    // markers were captured, or that cite by author-date rather than by number.
    const markerPage = (info.entryNumber != null && entry?.referenceMarkers)
      ? entry.referenceMarkers[String(info.entryNumber)] ?? null
      : null;
    const targetPage = markerPage ?? info.page;

    out.push({
      standard: std,
      standardFull: entry?.fullDesignation || null,
      count: info.count,
      pageNumber: targetPage,
      referenceNumber: info.entryNumber,
      // 'citation' = the page in the body that cites the work; 'references' =
      // the bibliography page. The UI words its tooltip from this.
      target: markerPage != null ? 'citation' : 'references',
      url: webUrl ? (targetPage != null ? `${webUrl}#page=${targetPage}` : webUrl) : null,
    });
  }
  return out
    .sort((a, b) => b.count - a.count || a.standard.localeCompare(b.standard))
    .slice(0, REFERENCE_MARKERS_MAX);
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
    if (isResolvableDoi(doi)) return { url: `https://doi.org/${doi}`, type: 'doi' };
  }

  // 3. Bare URL
  const urlMatch = /\bhttps?:\/\/[^\s"<>)]+/i.exec(text);
  if (urlMatch) {
    const url = urlMatch[0].replace(/[.,;:\]]+$/, '');
    // A doi.org URL carrying only the registrant prefix resolves to doi.org's
    // "DOI Not Found — you have requested a DOI prefix only" page (client
    // DO31.3). That happens when the printed entry itself stops at the prefix,
    // or when PDF extraction dropped the suffix. Better no link than a link to
    // an error page: fall through and let the UI render the entry unlinked.
    if (!isBrokenDoiUrl(url)) return { url, type: 'url' };
  }

  return null;
}

/**
 * Does this DOI have a real item suffix, not just a registrant prefix?
 *
 * A DOI is `10.<registrant>/<suffix>`. doi.org rejects a bare `10.<registrant>`
 * (and a trailing-slash-only form) with "you have requested a DOI prefix only".
 * The suffix must also carry at least one alphanumeric character — extraction
 * artifacts leave things like "10.1080/-" behind.
 */
export function isResolvableDoi(doi: string): boolean {
  const m = /^10\.\d{4,9}\/(.+)$/.exec(String(doi || '').trim());
  if (!m) return false;
  return /[a-z0-9]/i.test(m[1]);
}

/** A doi.org URL that would land on the "DOI prefix only" error page. */
export function isBrokenDoiUrl(url: string): boolean {
  const m = /^https?:\/\/(?:dx\.)?doi\.org\/(.*)$/i.exec(String(url || '').trim());
  if (!m) return false;
  return !isResolvableDoi(decodeURIComponent(m[1]));
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
    'SELECT id, title, full_designation, status, superseded_by, author, vitrium_doc_id, vitrium_web_url, reference_markers_json FROM standards'
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
        // marker number → first body page citing it (DO31.4); null pre-0009.
        referenceMarkers: parseReferenceMarkers(r.reference_markers_json),
        // Authoring technical committee, credited on every result card and
        // linked to its public page (client DO34). Vitrium's Author metadata
        // carries the committee name; resolveCommittee() refuses to invent a
        // link for anything that is not a committee.
        committee: resolveCommittee(r.author),
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

/** standards.reference_markers_json → { markerNumber: pageNumber }. */
function parseReferenceMarkers(raw: string | null | undefined): Record<string, number> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : null;
  } catch {
    return null;
  }
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
// Raised 3→6 (client DO25), then 6→12 (client DO28: "indexing may be too shallow
// for the level of detail needed"): a long standard like RP-8 needs prior-edition
// passages from several chapters before the comparison can say anything concrete.
const MAX_DEPRECATED_RESULTS = 12;  // flagged excerpts appended to the response
// Distinct anchors used to sample the prior edition. Each is a top current
// excerpt from a different page, so the probes spread across the document
// instead of all landing in one chapter (client DO28).
const DEPRECATED_TOPIC_HINTS = 3;
// Chapter diversity: no more than this many prior-edition excerpts from the same
// section. Without it, one dense chapter fills the whole comparison window.
const MAX_DEPRECATED_PER_SECTION = 3;

/**
 * Topical anchors for the deprecated-index probes: the best current-edition
 * excerpts, one per page, so each anchor pulls a different part of the prior
 * edition. Embedding "what's new in X?" directly retrieves table-of-contents
 * lines, not provisions — the anchor supplies the subject matter.
 */
function collectTopicHints(results: SearchResult[], max = DEPRECATED_TOPIC_HINTS): string[] {
  const hints: string[] = [];
  const seenPages = new Set<number>();
  for (const r of results) {
    if (r.isDeprecated) continue;
    for (const e of (r.excerpts && r.excerpts.length > 0 ? r.excerpts : (r.excerpt ? [r.excerpt] : []))) {
      const text = (e?.text || '').trim();
      if (text.length < 60) continue;
      const page = e?.pageNumber ?? -1;
      if (page >= 0 && seenPages.has(page)) continue;
      if (page >= 0) seenPages.add(page);
      hints.push(text);
      if (hints.length >= max) return hints;
    }
  }
  return hints;
}

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
async function searchDeprecatedForComparison(rawQuery: string, filters: SearchFilters, env: Env, topicHints: string[] = [], dbg: DepDbg | null = null): Promise<SearchResult[]> {
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
    // content. Anchor the deprecated-index queries on the family's TOPIC —
    // the current edition's best excerpts — so the excerpts pulled for
    // comparison are real provisions about the same subject.
    //
    // One anchor per current excerpt (client DO28): a single anchor sampled a
    // single chapter, which is why the RP-8 comparison could only report that
    // the retrieved passages showed nothing substantive.
    const embedTexts = topicHints
      .filter(h => h.trim().length >= 60)
      .map(h => `${scope} ${h.slice(0, 400)}`);
    if (embedTexts.length === 0) embedTexts.push(prepareQueryForEmbedding(rawQuery));
    D.anchors = embedTexts.length;

    const queryVectors: number[][] = [];
    for (const embedText of embedTexts) {
      let vec = await getCachedEmbedding(env.SESSIONS, EMBED_MODEL, embedText);
      if (!vec) {
        const embResult = await env.AI.run(EMBED_MODEL, { text: [embedText] }) as unknown as { data: number[][] };
        vec = embResult.data[0];
        await putCachedEmbedding(env.SESSIONS, EMBED_MODEL, embedText, vec);
      }
      queryVectors.push(vec);
    }

    // The deprecated index has no metadata index (filters only apply to
    // vectors inserted after one exists), so scoping happens client-side.
    // With returnMetadata:'all' Vectorize caps topK at 20 — too small a pool
    // for one family among ~150 deprecated standards. Instead: fetch 100
    // ids+scores per anchor, scope by vector-id prefix
    // (`<standardId>-chunk-<i>`), then pull metadata for the scoped hits.
    const bestScoreById = new Map<string, number>();
    for (const queryVector of queryVectors) {
      const res = await env.VECTORIZE_DEPRECATED.query(queryVector, {
        topK: DEPRECATED_TOP_K,
        returnMetadata: 'none',
      });
      // Keep only chunks of the compared standard family (RP-6 → RP-6-15,
      // RP-6-20, ...). `RP-6-` never matches RP-60-* since ids are `RP-60-...`.
      for (const m of (res.matches || [])) {
        if (!String(m.id).toUpperCase().startsWith(scopePrefix)) continue;
        const prev = bestScoreById.get(m.id);
        if (prev == null || prev < m.score) bestScoreById.set(m.id, m.score);
      }
    }

    const scoped = [...bestScoreById.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_DEPRECATED_RESULTS * 3);

    let candidates: VMatch[] = [];
    for (let i = 0; i < scoped.length; i += PROBE_BATCH) {
      const batch = scoped.slice(i, i + PROBE_BATCH);
      const fetched = await env.VECTORIZE_DEPRECATED.getByIds(batch.map(([id]) => id));
      candidates.push(...(fetched || []).map(v => ({
        id: v.id, score: bestScoreById.get(v.id) || 0, metadata: v.metadata as Partial<VectorMetadata>,
      })));
    }

    // Prose only, and only PROVISIONS: an errata notice or a reference list from
    // the prior edition gives the comparison nothing to compare.
    const proseOnly = (list: VMatch[]): VMatch[] => list.filter((m: VMatch) => {
      const meta = m.metadata || {};
      const text = String(meta.excerpt_text || '');
      return meta.chunk_type !== 'table' && text.trim().length >= 60
        && !isTableLike(text) && !looksLikeFrontMatter(text);
    });

    let matches = proseOnly(candidates);
    D.scopedCount = scoped.length;
    D.globalProse = matches.length;

    // Fallback: the global top-100 pool often misses small families entirely
    // (or surfaces only their TOC chunks). Vector ids are deterministic
    // (`<standardId>-chunk-<n>`), so probe the family's chunks directly via
    // getByIds and rank them against the query vector in-process. Also runs
    // when the ANN pool was THIN (not only empty): a handful of hits from one
    // chapter is exactly the shallow coverage the client flagged (DO28).
    if (matches.length < MAX_DEPRECATED_RESULTS) {
      const probed = await probeDeprecatedFamily(env, scopePrefix, queryVectors, D);
      const seenIds = new Set(matches.map(m => m.id));
      matches.push(...proseOnly(probed).filter(m => !seenIds.has(m.id)));
      D.probedRaw = probed.length;
      D.probedProse = matches.length;
    }
    if (matches.length === 0) { D.step = 'all-filtered-out'; return []; }

    const standardsIndex = await fetchStandardsIndex(env.DB);
    const linkCtx = { standardsIndex };

    return spreadAcrossSections(
      buildChunkResults(matches, linkCtx)
        .sort((a, b) => (b.relevanceScore || 0) - (a.relevanceScore || 0)),
      MAX_DEPRECATED_RESULTS,
    )
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
          citationName: `${r.citationName || r.citation} (deprecated)`,
        };
      });
  } catch (err) {
    D.step = 'error';
    D.error = errMsg(err);
    console.error('deprecated comparison search failed (non-fatal):', errMsg(err));
    return [];
  }
}

// Chunk-probe parameters for the deprecated-family fallback. 600 chunks
// (~210k words) covers even RP-8-class documents end to end — the client's DO28
// point was precisely that "all standards contain critical details throughout
// each chapter", so a probe that stops a third of the way in cannot support a
// comparison. getByIds rejects batches over 20 ids.
const PROBE_BATCH = 20;
const PROBE_MAX_CHUNKS = 600;

/**
 * Keep a ranked list from collapsing into one chapter.
 *
 * Walks the list in relevance order and admits an item only while its section
 * (falling back to its page band) is under quota; a second pass fills any
 * remaining slots from what was skipped. The result is still relevance-ordered,
 * but spans the document — which is what a "what changed" analysis needs to say
 * anything per chapter (client DO27/DO28).
 */
export function spreadAcrossSections(results: SearchResult[], limit: number, perSection = MAX_DEPRECATED_PER_SECTION): SearchResult[] {
  if (results.length <= limit) return results;

  const keyOf = (r: SearchResult) => {
    const section = r.excerpt?.section;
    if (section) return `s:${section}`;
    const page = r.excerpt?.pageNumber;
    // 10-page bands stand in for chapters when a chunk carries no section.
    return page != null ? `p:${Math.floor(page / 10)}` : 'unknown';
  };

  const counts = new Map<string, number>();
  const kept: SearchResult[] = [];
  const skipped: SearchResult[] = [];
  for (const r of results) {
    const key = keyOf(r);
    const n = counts.get(key) || 0;
    if (kept.length < limit && n < perSection) {
      counts.set(key, n + 1);
      kept.push(r);
    } else {
      skipped.push(r);
    }
  }
  for (const r of skipped) {
    if (kept.length >= limit) break;
    kept.push(r);
  }
  return kept.slice(0, limit);
}

/**
 * Directly fetch a deprecated family's chunk vectors by deterministic id
 * (`<standardId>-chunk-<n>`) and rank them against the query vectors with
 * in-process cosine similarity (best score across anchors). Used when the
 * family is absent from — or thinly represented in — the global ANN pool;
 * guarantees recall for any indexed family at the cost of a few getByIds
 * round-trips.
 */
async function probeDeprecatedFamily(env: Env, scopePrefix: string, queryVectors: number[][], D: DepDbg = {}): Promise<VMatch[]> {
  const rows = await env.DB.prepare(
    "SELECT id FROM standards WHERE status = 'Deprecated' AND id LIKE ?"
  ).bind(`${scopePrefix}%`).all<{ id: string }>();
  const members = (rows.results || []).map(r => r.id);
  D.probeMembers = members;
  if (members.length === 0 || queryVectors.length === 0) return [];

  // Only the edition(s) the comparison actually targets are worth probing —
  // newest deprecated first (client DO27). Probing five prior editions of a long
  // family would blow the subrequest budget before reaching the relevant one.
  members.sort((a, b) => editionYear(b) - editionYear(a) || b.localeCompare(a));
  const targets = members.slice(0, 2);
  D.probeTargets = targets;

  const qNorms = queryVectors.map(vec => {
    let n = 0;
    for (const x of vec) n += x * x;
    return Math.sqrt(n) || 1;
  });

  const scored: VMatch[] = [];
  for (const member of targets) {
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
        if (looksLikeFrontMatter(text)) continue; // packaging, not a provision

        const vals = v.values || [];
        let norm = 0;
        for (let k = 0; k < vals.length; k++) norm += vals[k] * vals[k];
        const vNorm = Math.sqrt(norm) || 1;

        // Best similarity across anchors: a chunk that answers ANY chapter's
        // anchor earns its slot.
        let best = -1;
        for (let q = 0; q < queryVectors.length; q++) {
          const queryVector = queryVectors[q];
          let dot = 0;
          for (let k = 0; k < vals.length; k++) dot += vals[k] * queryVector[k];
          const sim = dot / (qNorms[q] * vNorm);
          if (sim > best) best = sim;
        }
        scored.push({ id: v.id, score: best, metadata: v.metadata });
      }
      if (got.length < PROBE_BATCH) break;
    }
  }

  return scored.sort((a, b) => b.score - a.score).slice(0, MAX_DEPRECATED_RESULTS * 3);
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

export function buildResult(app: ApplicationRow, score: number, chunkMeta: Partial<VectorMetadata> | undefined, excerptIndex: ExcerptIndex, linkCtx: LinkCtx): SearchResult {
  const formatted = formatApplication(app);
  // Pass the application's own page (where its table row lives), not the
  // excerpt's page — the citation should point at the source row, while
  // the excerpt's pageNumber stays in the excerpt object. The standard's
  // descriptive title (from D1) makes the citation carry the FULL name:
  // "ANSI/IES RP-2-20+E1 Recommended Practice: Lighting Retail Spaces, ...".
  const stdInfo = linkCtx.standardsIndex?.get(app.Standard ?? '');
  // Citation split in two (client DO18): the NAME opens the front cover, the
  // page opens the internal reference. One hyperlink spanning both — with
  // "p. 25" pointing at the cover — was the confusing part.
  const citationName = formatCitation(app, null, null, stdInfo?.title || null);
  const citationPage = app.Page_Number ?? null;
  const citation = formatCitation(app, null, citationPage, stdInfo?.title || null);
  const vitriumLink = buildVitriumLink(app, linkCtx);

  // Up to EXCERPTS_PER_RESULT PDF excerpts for this application — preferring
  // chunks near the application's table page over globally top-scored ones
  // (client DO22: the "From the Standard" drop-down shows several relevant
  // passages, each with its own "Open in Library" link).
  const excerpts = pickExcerptsForApp(excerptIndex, app)
    .map(c => toExcerpt(c, app.Standard, linkCtx));

  return {
    resultType: 'application',
    application: formatted,
    // Authoring technical committee credit (client DO34).
    committee: stdInfo?.committee || null,
    // Front-of-document link (DO1R2): the citation title opens the standard
    // itself — deliberately WITHOUT the #page fragment vitriumLink carries.
    standardLink: stdInfo?.webUrl || null,
    relevanceScore: Math.round(score * 1000) / 1000,
    // `excerpt` stays the single best passage (back-compat); `excerpts` carries
    // the full drop-down list.
    excerpt: excerpts[0] || null,
    excerpts,
    citation,
    citationName,
    citationPage,
    vitriumLink,
    relatedApplications: [], // filled in for top result only
  };
}

/** Vector-chunk metadata → wire Excerpt, with a page-targeted Library link. */
function toExcerpt(c: ExcerptChunk, standard: string | null | undefined, linkCtx: LinkCtx): Excerpt {
  return {
    text: c.excerpt_text ?? '',
    pageNumber: c.page_number ?? null,
    section: c.section ?? null,
    // Surface the chunk type so the UI can hide raw table dumps in the
    // "From the Standard" panel — that section is only useful when it shows
    // prose context from the body of the standard, not a repeat of the table.
    chunkType: c.chunk_type ?? 'text',
    vitriumLink: buildVitriumLink(
      { Standard: standard ?? null, Page_Number: c.page_number ?? null },
      linkCtx,
    ),
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
// Vectorize caps topK at 20 when returnMetadata:'all' — take the maximum, since
// the standard_code filter also returns that standard's application vectors and
// only the prose ones are usable as excerpts.
const EXCERPT_BACKFILL_TOP_K = 20; // chunks fetched per backfilled standard
// Backfill now fires for standards that are merely THIN on prose, not only
// those with none: the "From the Standard" drop-down holds up to 10 passages
// (client DO22/DO4 — "continue to increase frequency ... increase contextual
// search depth").
const EXCERPT_BACKFILL_MIN_PROSE = 6;

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
    const proseCount = bucket.filter(c =>
      c.chunk_type !== 'table' && c.chunk_type !== 'reference' && !isTableLike(c.excerpt_text)
    ).length;
    if (proseCount < EXCERPT_BACKFILL_MIN_PROSE) targets.push(std);
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

// Front matter and back matter: pages that belong to a standard's packaging
// rather than its provisions. Harmless as general search hits, but poison for a
// version comparison — an errata notice or an Annex reference list has no
// substantive content to compare, and the AI Guide can only report that the
// passages show nothing (observed 2026-07-27: the RP-8 comparison leaned
// entirely on the ERRATA page and "CONTINUED REFERENCES FOR ANNEX B").
const FRONT_MATTER_PATTERNS: RegExp[] = [
  /\bERRATA\b/,
  /\bCONTINUED REFERENCES\b/i,
  /\ball rights reserved\b/i,
  /\bISBN\b/,
  /©\s*\d{4}|\bcopyright\s+(?:©\s*)?\d{4}/i,
  /\be-?mail your information\b/i,
  /\bprinted in the united states\b/i,
  /\btable of contents\b/i,
  /\bsenior manager of technical content\b/i,
  // Dot leaders — a table-of-contents line. PDF extraction often spaces them
  // out ("New Light Sources . . . . . 143"), so allow whitespace between dots.
  /(?:\.\s*){5,}/,
];

/**
 * Is this chunk packaging rather than a provision?
 *
 * Two signals: an explicit front/back-matter marker, or bibliography density —
 * a passage carrying several publication years AND several standards-body names
 * is a reference list, not guidance. Both thresholds are deliberately high so a
 * real provision that happens to cite two standards is never dropped.
 *
 * Applied ONLY on version-comparison retrieval, where a front-matter excerpt
 * actively degrades the answer. Ordinary searches keep every chunk.
 */
export function looksLikeFrontMatter(text: string | null | undefined): boolean {
  if (!text) return true;
  const t = String(text);
  if (FRONT_MATTER_PATTERNS.some(re => re.test(t))) return true;

  const years = (t.match(/\b(?:19|20)\d{2}\b/g) || []).length;
  const bodies = (t.match(/\b(?:ANSI|IES|CIE|ISO|IEC|IEEE|NFPA|ASTM|NEMA)\b/g) || []).length;
  return years >= 3 && bodies >= 3;
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
 * Pick up to `max` PDF excerpts for a given application, best first
 * (client DO22: "allow the drop-down to display multiple relevant results").
 *
 *  1. Prose is preferred over tables: a raw table dump reads as truncated
 *     numbers out of context and just repeats the data already on the card.
 *     Tables are used only when the standard yielded no prose at all.
 *  2. Chunks within ±5 pages of the application's own table page come first,
 *     nearest page first — that is the context AROUND the row the user matched.
 *  3. The rest follow by relevance score.
 *  4. Duplicate passages (same page + same opening) are collapsed.
 */
function pickExcerptsForApp(excerptIndex: ExcerptIndex, app: ApplicationRow, max = EXCERPTS_PER_RESULT): ExcerptChunk[] {
  const bucket = app.Standard ? excerptIndex[app.Standard] : undefined;
  if (!bucket || bucket.length === 0) return [];

  const isTable = (c: ExcerptChunk) => c.chunk_type === 'table';
  // Reference entries are bibliography lines — never body context.
  const usable = bucket.filter(c => c.excerpt_text && c.chunk_type !== 'reference');
  const prose = usable.filter(c => !isTable(c) && !isTableLike(c.excerpt_text));
  const pool = prose.length > 0 ? prose : usable;

  const appPage = app.Page_Number;
  const NEAR_RADIUS = 5;
  const near: Array<{ c: ExcerptChunk; dist: number }> = [];
  const far: ExcerptChunk[] = [];
  for (const c of pool) {
    const dist = (appPage != null && c.page_number != null)
      ? Math.abs(c.page_number - appPage)
      : Infinity;
    if (dist <= NEAR_RADIUS) near.push({ c, dist });
    else far.push(c);
  }
  near.sort((a, b) => a.dist - b.dist || b.c.score - a.c.score);
  far.sort((a, b) => b.score - a.score);

  const out: ExcerptChunk[] = [];
  const seen = new Set<string>();
  for (const c of [...near.map(n => n.c), ...far]) {
    const key = `${c.page_number ?? '?'}|${(c.excerpt_text || '').slice(0, 80)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
    if (out.length >= max) break;
  }
  return out;
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
    // Outdoor guidance. Lighting Zone / Curfew come from the row wherever the
    // printed table puts them (column OR hierarchy label — client DO20);
    // Glare / Uplight / Controls / Spectrum are shown ONLY for standards that
    // actually print those columns (client DO21).
    outdoor: buildOutdoorGuidance(app),
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

/**
 * Environmental & Visual Considerations block for one application row.
 *
 * Two independent decisions (client DO20/DO21):
 *   - Lighting Zone and Curfew are printed by several standards (RP-2, RP-43,
 *     …) as a hierarchy label rather than a column, so they are DERIVED from
 *     the row and shown whenever present — including for rows the extractor
 *     never tagged Outdoor.
 *   - Glare / Uplight / Controls / Spectrum are shown only for standards that
 *     print those dedicated columns (RP-43-25 today). Elsewhere the row parser
 *     infers them from stray tokens in the row text, which produced the wrong
 *     "Controls: curfew" field on RP-2 cards.
 */
function buildOutdoorGuidance(app: ApplicationRow): OutdoorGuidance | null {
  const zone = deriveLightingZone(app);
  const isOutdoor = app.Indoor_Outdoor === 'Outdoor' || app.Indoor_Outdoor === 'Both';
  const envOk = hasEnvConsiderationColumns(app.Standard);

  const guidance: OutdoorGuidance = {
    lightingZone:     zone.label,
    curfewDimming:    zone.curfew,
    maxGlareRating:   envOk ? app.Max_Glare_Rating : null,
    maxUplight:       envOk ? app.Max_Uplight : null,
    spectrumGuidance: envOk ? app.Spectrum_Guidance : null,
    controlsRequired: envOk ? app.Controls_Required : null,
  };

  const hasAny = Object.values(guidance).some(v => v != null && v !== '');
  if (!hasAny) return isOutdoor ? guidance : null;
  return guidance;
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

export function buildChunkResults(chunkMatches: VMatch[], linkCtx: LinkCtx = {}, { perStandard = 1 }: { perStandard?: number } = {}): SearchResult[] {
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

    const excerpt: Excerpt = {
      text: match.metadata?.excerpt_text || '',
      pageNumber: pageNum,
      section: match.metadata?.section || null,
      chunkType: match.metadata?.chunk_type || 'text',
      vitriumLink: buildVitriumLink({ Standard: stdId, Page_Number: pageNum }, linkCtx),
    };

    return {
      resultType: match.metadata?.chunk_type === 'reference' ? 'reference' : 'excerpt',
      // Chunk results have no application row, so synthesize the minimal
      // fields buildVitriumLink needs: standard id + the chunk's page.
      vitriumLink: buildVitriumLink({
        Standard: stdId,
        Page_Number: pageNum,
      }, linkCtx),
      // Authoring technical committee credit (client DO34).
      committee: stdInfo?.committee || null,
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
      excerpt,
      excerpts: [excerpt],
      citation: `${fullName}${pageNum ? `, p. ${pageNum}` : ''}`,
      // Split for the two-link citation (DO18): name → front cover, page →
      // internal reference.
      citationName: fullName,
      citationPage: pageNum,
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
export function inferFiltersFromQuery(rawQuery: string, forceComparison = false): SearchFilters {
  const out: SearchFilters = {};
  // Fold smart punctuation first: a pasted "RP–8" (en dash) or "RP‑8"
  // (non-breaking hyphen) must still scope the comparison to the RP-8 family.
  const query = normalizeTypography(rawQuery);

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

  // Near-tie: nudge by content type — Document, Definitions, Illuminance Tables,
  // References (client DO39, "gently prioritize"). The whole priority span is
  // narrower than SCORE_EPSILON, so this only ever reorders results relevance
  // already considers equivalent.
  const typeDiff = (TYPE_PRIORITY[b.resultType] ?? 0) - (TYPE_PRIORITY[a.resultType] ?? 0);
  if (typeDiff !== 0) return typeDiff;

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
