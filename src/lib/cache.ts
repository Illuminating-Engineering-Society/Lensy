/**
 * KV-backed caching for Workers AI calls and search responses.
 *
 * Every helper is fail-open: if the KV binding is missing or a KV call throws,
 * we return null / no-op so search still works — just uncached.
 *
 * Layers (distinct key prefixes):
 *   1. Embedding cache   cache:emb:<model>:<sha256(text)>       — long TTL, deterministic
 *   2. Search response   cache:search:<schema>:<ver>:<hash>     — 24h, corpus-versioned
 *   3. AI summary        cache:ai:<schema>:<ver>:<hash>         — 7d, keyed by query+results
 */

import type { AISummary, SearchResponse } from '../types';

type KV = KVNamespace | null | undefined;

const EMBEDDING_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days — deterministic data
const SEARCH_TTL_SECONDS = 60 * 60 * 24;         // 24 hours — bounds out-of-band staleness
const AI_SUMMARY_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days — keyed by query+results+dataVersion
const DATA_VERSION_KEY = 'cache:data-version';

// Bump whenever the search pipeline changes what a cached response contains.
// v4: full-title citations, content-type filters, footnote marks, reference
//     results, referenceLink field.
const SEARCH_CACHE_SCHEMA = 'v4';

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ─── Hashing ──────────────────────────────────────────────────────────────────

export async function sha256Hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Deterministic JSON serialization (sorted object keys) so logically equal
 * filter objects produce the same cache key regardless of property order.
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter(k => obj[k] !== undefined).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

// ─── Data Version ─────────────────────────────────────────────────────────────

export async function getDataVersion(kv: KV): Promise<string> {
  if (!kv) return '0';
  try {
    return (await kv.get(DATA_VERSION_KEY)) || '0';
  } catch {
    return '0';
  }
}

export async function bumpDataVersion(kv: KV): Promise<void> {
  if (!kv) return;
  try {
    await kv.put(DATA_VERSION_KEY, String(Date.now()));
  } catch (err) {
    console.error('cache: failed to bump data version (non-fatal):', errMsg(err));
  }
}

// ─── Embedding Cache ──────────────────────────────────────────────────────────

export async function getCachedEmbedding(kv: KV, model: string, text: string): Promise<number[] | null> {
  if (!kv) return null;
  try {
    const key = `cache:emb:${model}:${await sha256Hex(text)}`;
    return await kv.get(key, { type: 'json' });
  } catch {
    return null;
  }
}

export async function putCachedEmbedding(kv: KV, model: string, text: string, vector: number[]): Promise<void> {
  if (!kv || !Array.isArray(vector)) return;
  try {
    const key = `cache:emb:${model}:${await sha256Hex(text)}`;
    await kv.put(key, JSON.stringify(vector), { expirationTtl: EMBEDDING_TTL_SECONDS });
  } catch (err) {
    console.error('cache: embedding put failed (non-fatal):', errMsg(err));
  }
}

// ─── Search Response Cache ────────────────────────────────────────────────────

export async function buildSearchCacheKey(dataVersion: string, params: unknown): Promise<string> {
  const hash = await sha256Hex(stableStringify(params));
  return `cache:search:${SEARCH_CACHE_SCHEMA}:${dataVersion}:${hash}`;
}

export async function getCachedSearch(kv: KV, key: string): Promise<SearchResponse | null> {
  if (!kv) return null;
  try {
    return await kv.get(key, { type: 'json' });
  } catch {
    return null;
  }
}

export async function putCachedSearch(kv: KV, key: string, payload: unknown): Promise<void> {
  if (!kv) return;
  try {
    await kv.put(key, JSON.stringify(payload), { expirationTtl: SEARCH_TTL_SECONDS });
  } catch (err) {
    console.error('cache: search put failed (non-fatal):', errMsg(err));
  }
}

// ─── AI Summary Cache ─────────────────────────────────────────────────────────
// The 70B summary model is the most expensive Workers AI call. This layer keys
// on (model + query + top result codes) so any request shape that produces the
// same top results reuses the generated summary. The data version keeps
// summaries from outliving the corpus they describe.

export async function buildAISummaryCacheKey(
  dataVersion: string, model: string, query: string, resultCodes: (string | null | undefined)[],
): Promise<string> {
  const hash = await sha256Hex(`${model}\n${query}\n${(resultCodes || []).join(',')}`);
  return `cache:ai:${SEARCH_CACHE_SCHEMA}:${dataVersion}:${hash}`;
}

export async function getCachedAISummary(kv: KV, key: string): Promise<AISummary | null> {
  if (!kv) return null;
  try {
    return await kv.get(key, { type: 'json' });
  } catch {
    return null;
  }
}

export async function putCachedAISummary(kv: KV, key: string, summary: AISummary | null): Promise<void> {
  if (!kv || !summary) return;
  try {
    await kv.put(key, JSON.stringify(summary), { expirationTtl: AI_SUMMARY_TTL_SECONDS });
  } catch (err) {
    console.error('cache: AI summary put failed (non-fatal):', errMsg(err));
  }
}
