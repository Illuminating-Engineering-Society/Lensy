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
// v5: multi-excerpt results + split citation links + derived lighting zones +
//     mode-aware AI Guide (client feedback DO18–DO26).
// v6: REQUIRED whenever the prompts or the retrieval scope change. The AI
//     summary cache holds generated text for 7 days keyed on
//     (schema, dataVersion, mode, query, top result codes) — none of which move
//     when a prompt is edited. Observed 2026-07-27: after shipping the
//     family-scope fix and the reworked prompts, both the comparison and the
//     guide came back byte-identical (still citing TM-30-24, still naming Class
//     of Play), because they were served from the v5 entries generated minutes
//     earlier. Bump this line in the same commit as any prompt change.
// v7: comparison retrieval now excludes front/back matter (errata pages,
//     reference lists, tables of contents) — see looksLikeFrontMatter().
//     Different excerpts reach the model, so the stored answers are stale.
// v8: client feedback DO23/DO27/DO28/DO31/DO33 — comparison results are ordered
//     current → newest deprecated and sampled across chapters, the comparison
//     prompt forbids invented locators, document-body recall was widened, DOI
//     links are validated, and Definitions became a content type. Every stored
//     result set and generated summary predates all of it.
// v9: client feedback DO40–DO47 — excerpts now carry section titles and their
//     parent chain, a comparison returns a card for every edition of the family
//     and probes the current edition directly, a designation or title search
//     returns the document itself, the pasted "Sample Search:" label is stripped
//     before the query is read, and the comparison prompt gained the
//     compare-the-content and packaging rules. Stored result sets have neither
//     the new fields nor the new cards, and stored summaries predate the prompt.
// v10: every Lighting Library link is served on lighting.ies.org instead of
//     Vitrium's own viewer host (src/lib/library-url.js). The URL is baked into
//     the stored result set — every vitriumLink, standardLink, reference-marker
//     and reference link, and the AI Guide's citation hyperlinks — so a cached
//     v9 answer keeps sending readers to the host that rejects the session and
//     drops #page. Observed after the fix shipped: the Table of Contents
//     (uncached) linked correctly while "Open in Library" on a result did not.
// v11: client feedback DO062–DO079. The prompts changed (the AI Guide now sizes
//     its answer to the question and may answer in one paragraph; the comparison
//     answers as a chapter-grouped bulleted list with bold section numbers and
//     titles; both are forbidden to write formulae, and any formula that slips
//     through is stripped from the text). The RESULTS changed too: an
//     untrustworthy section number is now suppressed rather than printed,
//     excerpts carry their chapter, a designation search returns no Guide at
//     all, and an empty result set carries its guidance. Every stored v10
//     response predates all of it.
// v12: client feedback DO080–DO088. The prompts changed again (a comparison now
//     opens with "Extent of the changes" and takes its length from that
//     classification; the Guide is forbidden to restate the question and is told
//     when the AHJ notice is displayed above it; tables and figures are described
//     to it by caption). The RESULTS changed too: excerpts carry matched table and
//     figure locators, a regulated search carries the AHJ notice, and a question
//     that is not about lighting returns no cards at all. Every stored v11
//     response predates all of it.
const SEARCH_CACHE_SCHEMA = 'v12';

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
