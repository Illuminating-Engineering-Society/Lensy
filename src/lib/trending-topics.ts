/**
 * AI-grouped trending search topics for /admin → Search analytics (client,
 * 2026-10-27 (D): "an AI-generated ranking of top-20 trending search topics
 * (e.g. football, stadium, and pools might be categorized as 'sports'). This
 * wouldn't need to refresh more than once daily").
 *
 * Division of labour: the MODEL only names topics and says which numbered
 * queries belong to each; the COUNTS are computed here from search_log. A model
 * asked to add up searches gets the arithmetic wrong, and a ranking whose
 * numbers cannot be traced back to the log is not analytics.
 *
 * Computed by the daily cron (api.ts `scheduled`) and on demand from the
 * dashboard, stored in KV, read by GET /api/admin/analytics. Fail-soft: no
 * model answer → nothing is stored and the previous ranking stays.
 */

import { extractText } from './ai-summary';

export const TRENDING_TOPICS_KEY = 'analytics:trending-topics';
export const TRENDING_TOPICS_MAX = 20;
/** Distinct queries handed to the model — the head of the distribution. */
const QUERY_SAMPLE = 250;
/** A short window reads as "trending"; a quiet week falls back to a month. */
const WINDOWS_DAYS = [7, 30];
const MIN_SEARCHES_FOR_WINDOW = 100;

const TOPIC_MODELS = [
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  '@cf/meta/llama-3.1-8b-instruct-fp8',
];

export interface TrendingTopic {
  topic: string;
  searches: number;
  /** Distinct queries grouped under it. */
  queries: number;
  /** Its most-searched queries, for the dashboard tooltip. */
  examples: string[];
}

export interface TrendingTopics {
  generatedAt: string;
  windowDays: number;
  /** Searches in the window / searches whose query was in the sample. */
  totalSearches: number;
  coveredSearches: number;
  model: string;
  topics: TrendingTopic[];
}

interface QueryCount { query: string; searches: number }

export function buildTopicPrompt(queries: QueryCount[]): string {
  const lines = queries.map((q, i) => `${i + 1}. ${q.query.replace(/\s+/g, ' ').slice(0, 140)}`);
  return `You group search queries typed into IES Lens, a search tool for IES lighting standards, into broad TOPICS for a usage report.

Rules:
- Name each topic in 1-3 words, Title Case, by subject (e.g. "Sports", "Roadway", "Healthcare", "Offices", "Color Rendition", "Emergency Lighting", "Measurement & Testing").
- Group by what the reader is lighting or studying, not by wording: "football field", "stadium" and "pool lighting" are all "Sports".
- A query naming only a standard designation (e.g. "RP-8", "TM-30-24") belongs to the topic of that standard's subject if you know it, else "Standard Lookups".
- Use at most 30 topics. Every query number belongs to exactly one topic.

Queries:
${lines.join('\n')}

Answer with JSON only: {"Topic Name": [query numbers], ...}`;
}

/**
 * Turn the model's grouping into a ranking. Numbers outside the list, repeats
 * and empty topics are dropped; counts come from `queries`, never the model.
 */
export function rankTopics(text: string | null | undefined, queries: QueryCount[]): TrendingTopic[] {
  const match = String(text || '').match(/\{[\s\S]*\}/);
  if (!match) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(match[0]); } catch { return []; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];

  const claimed = new Set<number>();
  // Keyed case-insensitively so "Sports" and "sports" merge; first spelling wins.
  const byTopic = new Map<string, { label: string; items: QueryCount[] }>();
  for (const [rawName, nums] of Object.entries(parsed as Record<string, unknown>)) {
    const label = String(rawName).replace(/\s+/g, ' ').trim().slice(0, 40);
    if (!label || !Array.isArray(nums)) continue;
    const bucket = byTopic.get(label.toLowerCase()) || { label, items: [] };
    for (const n of nums) {
      const i = Number(n) - 1;
      if (!Number.isInteger(i) || i < 0 || i >= queries.length || claimed.has(i)) continue;
      claimed.add(i);
      bucket.items.push(queries[i]);
    }
    if (bucket.items.length) byTopic.set(label.toLowerCase(), bucket);
  }

  return [...byTopic.values()]
    .map(({ label, items }) => ({
      topic: label,
      searches: items.reduce((s, q) => s + q.searches, 0),
      queries: items.length,
      examples: [...items].sort((a, b) => b.searches - a.searches).slice(0, 5).map(q => q.query),
    }))
    .sort((a, b) => b.searches - a.searches || b.queries - a.queries)
    .slice(0, TRENDING_TOPICS_MAX);
}

async function queriesFor(env: Env, days: number): Promise<{ total: number; queries: QueryCount[] }> {
  const since = `-${days} days`;
  const [total, rows] = await Promise.all([
    env.DB.prepare(`SELECT COUNT(*) AS n FROM search_log WHERE created_at >= datetime('now', ?)`)
      .bind(since).first<{ n: number }>(),
    env.DB.prepare(`
      SELECT MIN(query) AS query, COUNT(*) AS searches
      FROM search_log WHERE created_at >= datetime('now', ?) AND TRIM(query) <> ''
      GROUP BY LOWER(TRIM(query))
      ORDER BY searches DESC, MAX(created_at) DESC LIMIT ?
    `).bind(since, QUERY_SAMPLE).all<QueryCount>(),
  ]);
  return { total: total?.n || 0, queries: rows.results || [] };
}

/** Compute the ranking and store it. Returns null (and stores nothing) on failure. */
export async function refreshTrendingTopics(env: Env): Promise<TrendingTopics | null> {
  let windowDays = WINDOWS_DAYS[0];
  let data = await queriesFor(env, windowDays);
  for (const days of WINDOWS_DAYS.slice(1)) {
    if (data.total >= MIN_SEARCHES_FOR_WINDOW) break;
    windowDays = days;
    data = await queriesFor(env, days);
  }
  if (data.queries.length === 0) return null;

  const prompt = buildTopicPrompt(data.queries);
  const ai = env.AI;
  // Receiver-bound call — a detached `ai.run` throws (see refine.ts).
  const run = (model: string, opts: unknown): Promise<unknown> =>
    (ai.run as unknown as (m: string, o: unknown) => Promise<unknown>).call(ai, model, opts);

  for (const model of TOPIC_MODELS) {
    try {
      const response = await run(model, {
        max_tokens: 3000,
        temperature: 0.1,
        messages: [{ role: 'user', content: prompt }],
      });
      const topics = rankTopics(extractText(response), data.queries);
      if (topics.length === 0) continue;
      const result: TrendingTopics = {
        generatedAt: new Date().toISOString(),
        windowDays,
        totalSearches: data.total,
        coveredSearches: data.queries.reduce((s, q) => s + q.searches, 0),
        model,
        topics,
      };
      await env.SESSIONS.put(TRENDING_TOPICS_KEY, JSON.stringify(result));
      return result;
    } catch (err) {
      console.error(`trending topics model ${model} failed:`, err instanceof Error ? err.message : String(err));
    }
  }
  return null;
}

export async function readTrendingTopics(env: Env): Promise<TrendingTopics | null> {
  try {
    const raw = await env.SESSIONS.get(TRENDING_TOPICS_KEY);
    return raw ? JSON.parse(raw) as TrendingTopics : null;
  } catch {
    return null;
  }
}
