/**
 * KV-backed caching for Workers AI calls and search responses.
 *
 * Why: every search makes at least one Workers AI call (query embedding),
 * and opt-in AI summaries call a 70B model — both bill "neurons". Identical
 * queries are common (demos, repeated lookups, multi-tab users), so we cache
 * in the existing SESSIONS KV namespace. KV reads/writes are orders of
 * magnitude cheaper than neurons.
 *
 * Two cache layers, both stored under distinct key prefixes:
 *
 *   1. Embedding cache  (cache:emb:<model>:<sha256(text)>)
 *      Embeddings are deterministic for a fixed model, so these entries are
 *      safe for a long TTL and never need invalidation — the model name is
 *      part of the key, so a model upgrade naturally misses the old entries.
 *
 *   2. Search response cache  (cache:search:<dataVersion>:<sha256(params)>)
 *      Caches the full /api/search response body. Correctness is handled by
 *      a "data version" stamp: any write to the corpus (PDF ingest,
 *      application re-embed, orphan vector deletion) bumps the version,
 *      which changes every search cache key — stale entries are simply
 *      never read again and expire via TTL. A moderate TTL also bounds
 *      staleness from out-of-band edits (e.g. direct D1 writes that bypass
 *      the API; use POST /api/admin/flush-cache after those).
 *
 * Every helper is fail-open: if the KV binding is missing or a KV call
 * throws, we return null / no-op so search still works — just uncached.
 */

const EMBEDDING_TTL_SECONDS = 60 * 60 * 24 * 30;  // 30 days — deterministic data
const SEARCH_TTL_SECONDS = 60 * 60 * 24;          // 24 hours — bounds out-of-band staleness
const AI_SUMMARY_TTL_SECONDS = 60 * 60 * 24 * 7;  // 7 days — keyed by query+results+dataVersion
const DATA_VERSION_KEY = 'cache:data-version';

// Bump whenever the search pipeline changes what a cached response contains
// (result ordering, excerpt attachment, chunk filtering, payload shape...).
// The data version only tracks corpus changes, so without this stamp a deploy
// would keep serving responses computed by the previous code for up to a TTL.
// v4: full-title citations, content-type filters, footnote marks, reference
//     results, referenceLink field.
const SEARCH_CACHE_SCHEMA = 'v4';

// ─── Hashing ──────────────────────────────────────────────────────────────────

export async function sha256Hex(text) {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Deterministic JSON serialization (sorted object keys) so logically equal
 * filter objects produce the same cache key regardless of property order.
 */
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).filter(k => value[k] !== undefined).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

// ─── Data Version ─────────────────────────────────────────────────────────────

/**
 * Current corpus version stamp. Part of every search cache key, so bumping
 * it invalidates all cached search responses at once without deleting keys.
 */
export async function getDataVersion(kv) {
  if (!kv) return '0';
  try {
    return (await kv.get(DATA_VERSION_KEY)) || '0';
  } catch {
    return '0';
  }
}

/**
 * Invalidate all cached search responses. Call after any corpus mutation
 * (ingest, re-embed, orphan deletion). No TTL — the version must persist.
 */
export async function bumpDataVersion(kv) {
  if (!kv) return;
  try {
    await kv.put(DATA_VERSION_KEY, String(Date.now()));
  } catch (err) {
    console.error('cache: failed to bump data version (non-fatal):', err.message);
  }
}

// ─── Embedding Cache ──────────────────────────────────────────────────────────

export async function getCachedEmbedding(kv, model, text) {
  if (!kv) return null;
  try {
    const key = `cache:emb:${model}:${await sha256Hex(text)}`;
    return await kv.get(key, { type: 'json' });
  } catch {
    return null;
  }
}

export async function putCachedEmbedding(kv, model, text, vector) {
  if (!kv || !Array.isArray(vector)) return;
  try {
    const key = `cache:emb:${model}:${await sha256Hex(text)}`;
    await kv.put(key, JSON.stringify(vector), { expirationTtl: EMBEDDING_TTL_SECONDS });
  } catch (err) {
    console.error('cache: embedding put failed (non-fatal):', err.message);
  }
}

// ─── Search Response Cache ────────────────────────────────────────────────────

/**
 * Build the cache key for a search request. Includes everything that
 * changes the response: query, filters, limit, units, AI summary flag,
 * and the corpus data version.
 */
export async function buildSearchCacheKey(dataVersion, params) {
  const hash = await sha256Hex(stableStringify(params));
  return `cache:search:${SEARCH_CACHE_SCHEMA}:${dataVersion}:${hash}`;
}

export async function getCachedSearch(kv, key) {
  if (!kv) return null;
  try {
    return await kv.get(key, { type: 'json' });
  } catch {
    return null;
  }
}

export async function putCachedSearch(kv, key, payload) {
  if (!kv) return;
  try {
    await kv.put(key, JSON.stringify(payload), { expirationTtl: SEARCH_TTL_SECONDS });
  } catch (err) {
    console.error('cache: search put failed (non-fatal):', err.message);
  }
}

// ─── AI Summary Cache ─────────────────────────────────────────────────────────
//
// The 70B summary model is by far the most expensive Workers AI call. The
// full-response cache only covers EXACT parameter matches — the same query
// with a different limit/units/filter combination re-runs the summary even
// though its inputs (query + the results fed into the prompt) are identical.
// This layer keys on exactly those inputs, so any request shape that produces
// the same top results reuses the generated summary. The data version keeps
// summaries from outliving the corpus they describe.

export async function buildAISummaryCacheKey(dataVersion, model, query, resultCodes) {
  const hash = await sha256Hex(`${model}\n${query}\n${(resultCodes || []).join(',')}`);
  return `cache:ai:${SEARCH_CACHE_SCHEMA}:${dataVersion}:${hash}`;
}

export async function getCachedAISummary(kv, key) {
  if (!kv) return null;
  try {
    return await kv.get(key, { type: 'json' });
  } catch {
    return null;
  }
}

export async function putCachedAISummary(kv, key, summary) {
  if (!kv || !summary) return;
  try {
    await kv.put(key, JSON.stringify(summary), { expirationTtl: AI_SUMMARY_TTL_SECONDS });
  } catch (err) {
    console.error('cache: AI summary put failed (non-fatal):', err.message);
  }
}
