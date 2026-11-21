/**
 * AI-grouped trending search topics for /admin → Search analytics (client,
 * 2026-10-27 (D): "an AI-generated ranking of top-20 trending search topics …
 * This wouldn't need to refresh more than once daily").
 *
 * Revised 11/19/26 #8 — Dan: "The list of 'topics' tends to be very bland,
 * mostly aligned with a word from the referenced standard (roadway,
 * healthcare, offices, etc). When I use CoPilot and ask it 'Identify 20
 * trending topics which could be indicative of research trends,
 * design/engineering trends and problems to solve' I receive more interesting
 * insights like 'Circadian and melanopic metrics | Temporal light artifacts
 * and photobiological safety | Wildlife, sky glow and dark sky | Hybrid and
 * multi-use spaces'."
 *
 * Why the old list was bland, measured on the log that day (1,187 searches,
 * 890 distinct, last 30 days): the model was asked to group by "what the
 * reader is lighting", and most searches ARE a space and nothing else — "Desk"
 * 15, "OFFICE" 11, "corridor" 10. Ranked by volume, the building types won
 * every time, and the questions that reveal a trend sat in the long tail, most
 * of them outside the 250-query sample altogether.
 *
 * So the ranking now separates two kinds of search:
 *
 *   THEMES   — a cross-cutting subject or a problem someone is trying to solve
 *              ("Circadian & Melanopic Metrics", "Light Trespass & Lighting
 *              Zones"). These are the ranking.
 *   ROUTINE  — a light-level lookup for a space, a bare designation, a
 *              question about the platform. Counted and reported, in their own
 *              line, but never competing with the themes for a place.
 *
 * Division of labour (unchanged): the MODEL only names themes and says which
 * numbered queries belong to each; every COUNT is computed here from
 * search_log. A model asked to add up searches gets the arithmetic wrong, and
 * a ranking whose numbers cannot be traced back to the log is not analytics.
 *
 * Two passes, because one prompt asked to invent the themes AND place 500
 * queries does both badly: pass 1 reads the queries and proposes the themes
 * (with one line on what each suggests), pass 2 places the queries against
 * that fixed list, in batches that run in parallel.
 *
 * The searches counted are the dashboard's own (lib/analytics-scope.ts): IES
 * staff and the "Try searching for" demos are left out (11/19/26 #7), and so
 * are a reader's rephrasings of their own question (#4 — a search logged with
 * attempt 2+), so one frustrated reader is one search, not five.
 *
 * Computed by the daily cron (api.ts `scheduled`) and on demand from the
 * dashboard, stored in KV, read by GET /api/admin/analytics. A custom date
 * range is computed on demand and returned without being stored. Fail-soft: no
 * usable model answer → nothing is stored and the previous ranking stays.
 */

import { extractText } from './ai-summary';
import { isHelpQuestion } from './help-pages';
import { isProductQuestion } from './product';
import { hasColumn, logScope, parseAnalyticsWindow, type AnalyticsWindow } from './analytics-scope';

export const TRENDING_TOPICS_KEY = 'analytics:trending-topics';
export const TRENDING_TOPICS_MAX = 20;
/** Distinct queries read — the long tail is where the themes are (a month's
 *  log held 890 distinct queries on 11/20/26, and this reads all of them). */
const QUERY_SAMPLE = 1000;
/** How many of them pass 1 is shown when it proposes the themes. */
const THEME_SAMPLE = 400;
/** Queries labelled per call — small, because a model sorting 100 at once misfiles them. */
const ASSIGN_BATCH = 50;
const MAX_THEMES = 24;
/** A short window reads as "trending"; a quiet week falls back to a month. */
const WINDOWS_DAYS = [7, 30];
const MIN_SEARCHES_FOR_WINDOW = 100;

const TOPIC_MODELS = [
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  '@cf/meta/llama-3.1-8b-instruct-fp8',
];

/** The routine groups, in the order they are reported. */
export const ROUTINE_GROUPS = ['Illuminance Lookups', 'Standard Lookups', 'Platform & Account', 'Other'] as const;
export type RoutineGroup = typeof ROUTINE_GROUPS[number];

export interface TrendingTopic {
  topic: string;
  searches: number;
  /** Distinct queries grouped under it. */
  queries: number;
  /** Its most-searched queries, for the dashboard tooltip. */
  examples: string[];
  /** One line on what the searches suggest (themes only; the model's words). */
  signal?: string;
}

export interface TrendingTopics {
  generatedAt: string;
  windowDays: number;
  /** The days counted, both inclusive (UTC). */
  from?: string;
  to?: string;
  /** True for a custom range computed on demand (never stored). */
  custom?: boolean;
  /** Searches in the window / searches whose query was read and placed. */
  totalSearches: number;
  coveredSearches: number;
  model: string;
  /** The themes, most-searched first. */
  topics: TrendingTopic[];
  /** Routine searches by kind — counted, never ranked against the themes. */
  routine?: TrendingTopic[];
}

export interface QueryCount { query: string; searches: number }

// ─── What needs no model ─────────────────────────────────────────────────────

const DESIGNATION_ONLY_RE = /^(?:ANSI\s*\/\s*)?(?:(?:IES|ASHRAE)\s*[\/ -]\s*)*(?:(?:RP|TM|HB|LM|LP|LS|DG|LEM|G)[\s-]*\d+(?:\.\d+)?(?:[\s-]+\d{2,4})?|90\.1(?:-\d{4})?)(?:\s*\(R\s*\d{2,4}\))?(?:[\s+]*(?:R\d{4}|E\s*\d+))*\.?$/i;
/** A search launched from an application suggestion: "RP-9-23 Lobbies > Reception". */
const PINNED_APPLICATION_RE = /^(?:RP|TM|LM|LP|LS|DG|G)-\d+(?:\.\d+)?-\d{2}\S*\s+.+\s>\s.+/i;

/**
 * The words of a light-level lookup: "what are the light levels for a lobby",
 * "how should I light a k-12 classroom", "recommended illuminance for kitchen
 * tasks", "how many footcandles for a flag".
 */
const LOOKUP_WORDS_RE = /\b(?:illumin\w*|light(?:ing)?\s+levels?|foot[\s-]?candles?|fc|lux|how\s+(?:much|many)\s+light|how\s+bright(?:ly)?|how\s+(?:should|do|can|would|to)\s+(?:(?:i|we|you)\s+)?(?:best\s+)?light|(?:best|recommended)\s+way\s+to\s+light|considerations\s+for\s+lighting|lighting\s+(?:for|of|in|a|an|the)\b|light\s+(?:a|an|the)\b|recommend\w*\s+for\b)/i;

/**
 * The words that make a search MORE than a lookup — the subjects the themes
 * are made of. A query carrying one is always left to the model, however much
 * it also reads like a lookup ("illuminance and light trespass recommendations
 * for a parking lot", "what are the recommended UGR level for offices").
 * Broad on purpose: wrongly sending a lookup to the model costs nothing, while
 * wrongly filing a trend under lookups hides it.
 */
const THEME_CUE_RE = /\b(?:glare|ugr|trespass|spill|obtrusive|curfew|dim(?:s|med|ming)?|controls?|sensors?|occupancy|daylight\w*|sunlight|circadian|melanop\w*|sleep|health|well-?being|flicker\w*|strobos\w*|temporal|colou?r\w*|cct|kelvin|temperature|tm-?30|cri|spectr\w*|uv\w*|ultraviolet|germicidal|guv|photobiolog\w*|blue\s+light|wildlife|turtles?|birds?|insects?|sky\s?glow|dark\s?sky|pollution|bug|uplight|backlight|zones?|lz\d|energy|codes?|ordinances?|ashrae|90\.1|title\s?24|necb|iecc|lpd|power\s+density|maintenance|depreciation|llf|ldd|lld|light\s+loss|lumen\s+maintenance|l70|life(?:time)?|tm-?21|lm-?\d+|test(?:s|ed|ing)?|measur\w*|meters?|calibrat\w*|goniophotomet\w*|photomet\w*|verif\w*|commission\w*|security|safety|crime|aging|older|elderly|seniors?|low\s+vision|visibility|contrast|adaptation|mesopic|s\/p|emergency|egress|exit|retrofit\w*|replace\w*|leds?|drivers?|thermal|heat|conservation|damage|fading|horticult\w*|adaptive|connected|iot|poe|wireless|protocols?|dali|dmx|bim|software|calculat\w*|grids?|pole\s+heights?|mounting|spacing|veiling|reflect\w*|luminance|uniformit\w*|ratios?|class\s+of\s+play|economics?|cost|payback|sustainab\w*|carbon|embodied|recycl\w*|circular|specification|specs?|warrant\w*|standards?\s+apply|difference|compare|versus|vs)\b/i;

/**
 * The routine group a query belongs to WITHOUT asking the model, or null. A
 * bare designation, a suggestion-launched row lookup and a question about the
 * platform are recognized by the same rules search itself applies — and a
 * plain light-level lookup by its own words — which is both cheaper and more
 * reliable than a model's guess.
 *
 * The lookup rule is what keeps the themes from being bland (11/19/26 #8). On
 * the first run against the real log the model, shown everything, proposed
 * "Illuminance Levels & Metrics" (250 of 484 searches), "Office Lighting
 * Guidelines" and "Parking Lot Lighting" — the very list this was meant to
 * replace — because that is honestly what most of the queries were. So the
 * lookups are taken out BEFORE the model is asked anything: a query that reads
 * like one (or is just a space's name, three words or fewer) and carries no
 * theme cue is filed here, and the model only ever sees the rest.
 */
export function routineGroupOf(query: string): RoutineGroup | null {
  const q = String(query || '').replace(/\s+/g, ' ').trim();
  if (!q) return 'Other';
  if (DESIGNATION_ONLY_RE.test(q)) return 'Standard Lookups';
  if (PINNED_APPLICATION_RE.test(q)) return 'Illuminance Lookups';
  if (isProductQuestion(q) || isHelpQuestion(q)) return 'Platform & Account';
  if (THEME_CUE_RE.test(q)) return null;
  if (LOOKUP_WORDS_RE.test(q)) return 'Illuminance Lookups';
  // "Desk", "OFFICE", "exam room", "courthouse detainee cell": a space and nothing else.
  if (q.split(' ').length <= 3) return 'Illuminance Lookups';
  return null;
}

// ─── Pass 1: the themes ──────────────────────────────────────────────────────

const numbered = (queries: QueryCount[]) =>
  queries.map((q, i) => `${i + 1}. ${q.query.replace(/\s+/g, ' ').slice(0, 140)}`).join('\n');

export function buildThemePrompt(queries: QueryCount[]): string {
  return `You are analysing search queries typed by lighting professionals into IES Lens, the search tool for the standards of the Illuminating Engineering Society. The reader of your analysis is the IES standards staff, who want to know which RESEARCH TRENDS, DESIGN AND ENGINEERING TRENDS and PROBLEMS TO SOLVE the searches point to.

Read the numbered queries below and identify the THEMES in them.

What a theme is:
- A cross-cutting subject or a problem practitioners are trying to solve, named in 2 to 6 words, Title Case — the way an analyst would title a slide: "Circadian & Melanopic Metrics", "Temporal Light Artifacts & Flicker", "Sky Glow, Wildlife & Dark Sky". Those three only show the STYLE of a name. Do not use them, or any theme, unless queries below are about it.
- Every theme must be EVIDENCED: list the numbers of at least two queries below that are about it. A theme you cannot evidence with two queries does not exist.

What a theme is NOT:
- NOT a building type, a space or an application: never "Offices", "Roadway", "Healthcare", "Sports", "Parking".
- NOT a catch-all: never "Lighting for Specific Applications", "General Lighting Questions", "Various Topics", "Other".
- NOT a single standard: never "RP-8" or "TM-30 Lookups".
- A query that only names a space or asks for its light level is evidence of nothing. But a query about a space that ALSO carries a problem ("parking lot light spilling onto residences", "office with video conferencing") is evidence for the theme of that PROBLEM.

For each theme write:
- "name"
- "type": exactly one of "research" (a metric, a science question, a method), "design" (a design or engineering practice), "problem" (something going wrong that people want fixed), or "space" (it is really just a kind of building or application — say so honestly; those are discarded).
- "evidence": the numbers of the queries that are about it (at least two).
- "signal": ONE sentence of 12 to 25 words saying what THOSE queries show people are trying to solve or decide, naming the concrete things they ask. Good: "Readers ask which UGR to specify for offices and whether glare can be measured in the field." Bad (says nothing): "Practitioners seek guidance on glare."

Return at most ${MAX_THEMES} themes, the best-evidenced first. Fewer true themes are better than a padded list.

Queries:
${numbered(queries)}

Answer with JSON only:
{"themes": [{"name": "Theme Name", "type": "problem", "evidence": [3, 17], "signal": "One specific sentence."}]}`;
}

/** JSON as models write it: a comma before a closing bracket is forgiven. */
function parseLoose(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    try { return JSON.parse(json.replace(/,\s*([\]}])/g, '$1')); } catch { return undefined; }
  }
}

/** The first JSON object in a model's answer, or null. */
function firstJsonObject(text: string | null | undefined): Record<string, unknown> | null {
  const match = String(text || '').match(/\{[\s\S]*\}/);
  if (!match) return null;
  const parsed = parseLoose(match[0]);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
}

/**
 * The theme objects in pass 1's answer. Normally `{"themes": [...]}`; when
 * that does not parse — the 70B model ended its list with a trailing comma on
 * one real run in three, and a long list can be cut off by the token limit —
 * every COMPLETE `{…"name"…}` object in the text is salvaged instead, so one
 * malformed character does not cost the whole ranking.
 */
function themeItems(text: string | null | undefined): unknown[] {
  const parsed = firstJsonObject(text);
  if (Array.isArray(parsed?.themes)) return parsed!.themes as unknown[];
  const out: unknown[] = [];
  for (const m of String(text || '').matchAll(/\{[^{}]*\}/g)) {
    const item = parseLoose(m[0]);
    if (item && typeof item === 'object' && typeof (item as { name?: unknown }).name === 'string') out.push(item);
  }
  return out;
}

const cleanLabel = (value: unknown, max: number) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/** Building types and bare standards are not themes, whatever the model says. */
const NOT_A_THEME_RE = /^(?:(?:the\s+)?(?:offices?|roadways?|streets?|healthcare|hospitals?|sports?|parking(?:\s+lots?)?|education(?:al)?|schools?|classrooms?|retail|residential|industrial|hospitality|museums?|libraries|interiors?|exteriors?|outdoors?|general|miscellaneous|misc|other|lighting)(?:\s+(?:lighting|facilities|spaces|applications))?(?:\s+(?:guidelines|recommendations|requirements|levels|design|standards))?|(?:RP|TM|LM|LP|LS|DG|G)-\d+\S*(?:\s+lookups?)?)$/i;
/** A "theme" named after looking a light level up is the lookups again. */
const LOOKUP_THEME_RE = /\b(?:illuminance|light(?:ing)?)\s+(?:levels?|values?|targets?|recommendations?|requirements?|tables?|lookups?)\b|^recommended\s+(?:illuminance|light)/i;

/** A catch-all is not a theme either ("Lighting For Specific Applications" took 94 queries). */
const CATCH_ALL_THEME_RE = /\b(?:specific|special|various|general|miscellaneous|other|different|multiple)\s+(?:applications?|spaces?|topics?|questions?|areas?|lighting|tasks?|uses?|needs?|requirements?|situations?|cases?|scenarios?|purposes?)\b|^(?:general|other|miscellaneous)\b|\bstandards?\s+(?:and|&)\s+regulations?\b/i;

/**
 * Words that name a place to be lit, and the filler a model wraps around
 * them. A "theme" made of nothing else — "Pedestrian And Roadway Lighting",
 * "Lighting For Healthcare And Wellness", "Pedestrian Walkways" — is a
 * building type with extra words, which the prompt forbids and the model
 * writes anyway on some runs.
 */
const SPACE_NAME_WORDS = new Set((
  'office offices roadway roadways road roads street streets highway highways healthcare hospital hospitals wellness '
  + 'sport sports parking lot lots garage garages education educational school schools classroom classrooms retail '
  + 'residential industrial hospitality museum museums library libraries interior interiors exterior exteriors outdoor '
  + 'outdoors indoor pedestrian pedestrians walkway walkways pathway pathways sidewalk sidewalks stair stairs corridor '
  + 'corridors lobby lobbies warehouse warehouses restaurant restaurants hotel hotels airport airports site sites '
  + 'building buildings commercial public urban landscape facility facilities space spaces area areas application '
  + 'applications lighting for of the and in design guidelines recommendations requirements'
).split(' '));

function isSpaceName(name: string): boolean {
  const words = name.toLowerCase().split(/[^a-z]+/).filter(Boolean);
  return words.length > 0 && words.every(w => SPACE_NAME_WORDS.has(w));
}
/** How many of the queries it was shown a theme must cite as evidence. */
const MIN_THEME_EVIDENCE = 2;

export interface Theme { name: string; signal: string }

/**
 * Pass 1's answer → the theme list: named, evidenced, de-duplicated, never a
 * building type or a catch-all.
 *
 * `queryCount` is how many queries the model was shown: a theme must cite at
 * least two of them as evidence, which is what stops the model reciting the
 * prompt's own example names — on the first real run it returned eight of
 * them. Omit it to skip the evidence test.
 */
export function parseThemes(text: string | null | undefined, queryCount?: number): Theme[] {
  const list = themeItems(text);
  const seen = new Set<string>();
  const out: Theme[] = [];
  for (const item of list) {
    const name = cleanLabel(typeof item === 'string' ? item : (item as { name?: unknown })?.name, 48);
    if (!name || NOT_A_THEME_RE.test(name) || LOOKUP_THEME_RE.test(name) || CATCH_ALL_THEME_RE.test(name) || isSpaceName(name)) continue;
    // The model's own label: it is asked to say when a theme is really a space.
    const type = cleanLabel(typeof item === 'string' ? '' : (item as { type?: unknown })?.type, 16).toLowerCase();
    if (type === 'space' || type === 'lookup' || type === 'application') continue;
    if ((ROUTINE_GROUPS as readonly string[]).some(r => r.toLowerCase() === name.toLowerCase())) continue;
    if (queryCount != null) {
      const cited = typeof item === 'string' ? [] : (item as { evidence?: unknown })?.evidence;
      const valid = new Set((Array.isArray(cited) ? cited : [])
        .map(Number).filter(n => Number.isInteger(n) && n >= 1 && n <= queryCount));
      if (valid.size < MIN_THEME_EVIDENCE) continue;
    }
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name, signal: cleanLabel(typeof item === 'string' ? '' : (item as { signal?: unknown })?.signal, 220) });
    if (out.length >= MAX_THEMES) break;
  }
  return out;
}

// ─── Pass 2: which queries belong to which theme ─────────────────────────────

export function buildAssignPrompt(themes: Theme[], queries: QueryCount[]): string {
  const themeLines = themes.map((t, i) => `T${i + 1}. ${t.name}${t.signal ? ` — ${t.signal}` : ''}`).join('\n');
  return `You label search queries typed into IES Lens (a search tool for IES lighting standards). Give EACH query exactly one code.

THEME codes (a subject or problem practitioners are working on):
${themeLines}

ROUTINE codes:
R1 = Illuminance Lookups — the query only names a space, task or application, or only asks for its light level, illuminance or lighting recommendations ("office", "corridor", "how much light for a lobby", "how should I light a classroom").
R2 = Standard Lookups — the query is only the designation or title of a standard.
R3 = Platform & Account — a question about IES Lens itself, the Lighting Library, an account or a subscription.
R4 = Other — anything else: no theme fits, it is unintelligible, or it is not about lighting.

Rules:
- Use a THEME code only when the query is really about that theme's subject or problem. Sharing one word with a theme's name is not enough.
- A query about a space that also carries a problem ("parking lot light trespass onto houses") gets the theme of the problem.
- When in doubt, use R4. A wrong theme is worse than R4.

Queries:
${numbered(queries)}

Answer with one line per query and nothing else, in this form:
1=T3
2=R1
3=R4`;
}

/**
 * Pass 2's answer → group code per query index (0-based). Reads the
 * one-line-per-query form the prompt asks for ("12=T3") — a model labelling
 * one query at a time misfiles far fewer than one building groups — and the
 * grouped JSON form ({"T3": [12, 15]}) as well. Unknown codes and repeats are
 * dropped.
 */
export function parseAssignment(text: string | null | undefined, themeCount: number, queryCount: number): Map<number, string> {
  const out = new Map<number, string>();
  const validCode = (raw: string): string | null => {
    const m = /^([TR])(\d{1,2})$/.exec(String(raw).trim().toUpperCase());
    if (!m) return null;
    const n = Number(m[2]);
    return n >= 1 && n <= (m[1] === 'T' ? themeCount : ROUTINE_GROUPS.length) ? `${m[1]}${n}` : null;
  };
  const place = (rawIndex: unknown, code: string) => {
    const i = Number(rawIndex) - 1;
    if (Number.isInteger(i) && i >= 0 && i < queryCount && !out.has(i)) out.set(i, code);
  };

  for (const m of String(text || '').matchAll(/(?:^|[\s,;])(\d{1,4})\s*=\s*([TR]\d{1,2})\b/gi)) {
    const code = validCode(m[2]);
    if (code) place(m[1], code);
  }
  if (out.size > 0) return out;

  const parsed = firstJsonObject(text);
  if (!parsed) return out;
  for (const [rawCode, nums] of Object.entries(parsed)) {
    const code = validCode(rawCode);
    if (!code || !Array.isArray(nums)) continue;
    for (const raw of nums) place(raw, code);
  }
  return out;
}

// ─── The ranking ─────────────────────────────────────────────────────────────

function summarize(topic: string, items: QueryCount[], signal?: string): TrendingTopic {
  return {
    topic,
    searches: items.reduce((s, q) => s + q.searches, 0),
    queries: items.length,
    examples: [...items].sort((a, b) => b.searches - a.searches).slice(0, 5).map(q => q.query),
    ...(signal ? { signal } : {}),
  };
}

/**
 * Group code per query → the themes (ranked by searches) and the routine
 * groups (in their fixed order). A theme with a single query behind it is not
 * a trend and is left out; its query stays counted as placed.
 */
export function rankThemes(
  themes: Theme[], placed: Array<{ query: QueryCount; code: string }>,
): { topics: TrendingTopic[]; routine: TrendingTopic[] } {
  const byCode = new Map<string, QueryCount[]>();
  for (const p of placed) {
    if (!byCode.has(p.code)) byCode.set(p.code, []);
    byCode.get(p.code)!.push(p.query);
  }
  const topics = themes
    .map((t, i) => ({ theme: t, items: byCode.get(`T${i + 1}`) || [] }))
    .filter(x => x.items.length >= 2 || x.items.reduce((s, q) => s + q.searches, 0) >= 3)
    .map(x => summarize(x.theme.name, x.items, x.theme.signal))
    .sort((a, b) => b.searches - a.searches || b.queries - a.queries)
    .slice(0, TRENDING_TOPICS_MAX);
  const routine = ROUTINE_GROUPS
    .map((name, i) => summarize(name, byCode.get(`R${i + 1}`) || []))
    .filter(r => r.queries > 0);
  return { topics, routine };
}

// ─── Reading the log, calling the model ──────────────────────────────────────

async function queriesFor(
  env: Env, window: AnalyticsWindow,
): Promise<{ total: number; queries: QueryCount[] }> {
  const [hasAudience, hasAttempt] = await Promise.all([
    hasColumn(env.DB, 'search_log', 'audience'),
    hasColumn(env.DB, 'search_log', 'attempt'),
  ]);
  const scope = logScope(window, { hasAudience });
  // A reader's rephrasings of their own question are one search (11/19/26 #4).
  const firstAttempts = hasAttempt ? ' AND (attempt IS NULL OR attempt <= 1)' : '';
  const [total, rows] = await Promise.all([
    env.DB.prepare(`SELECT COUNT(*) AS n FROM search_log WHERE ${scope.where}${firstAttempts}`)
      .bind(...scope.binds).first<{ n: number }>(),
    env.DB.prepare(`
      SELECT MIN(query) AS query, COUNT(*) AS searches
      FROM search_log WHERE ${scope.where}${firstAttempts} AND TRIM(query) <> ''
      GROUP BY LOWER(TRIM(query))
      ORDER BY searches DESC, MAX(created_at) DESC LIMIT ?
    `).bind(...scope.binds, QUERY_SAMPLE).all<QueryCount>(),
  ]);
  return { total: total?.n || 0, queries: rows.results || [] };
}

type RunModel = (prompt: string, maxTokens: number) => Promise<{ text: string | null; model: string } | null>;

function modelRunner(ai: Ai): RunModel {
  // Receiver-bound call — a detached `ai.run` throws (see refine.ts).
  const run = (model: string, opts: unknown): Promise<unknown> =>
    (ai.run as unknown as (m: string, o: unknown) => Promise<unknown>).call(ai, model, opts);
  return async (prompt, maxTokens) => {
    for (const model of TOPIC_MODELS) {
      try {
        const text = extractText(await run(model, {
          max_tokens: maxTokens, temperature: 0.1, messages: [{ role: 'user', content: prompt }],
        }));
        if (text) return { text, model };
      } catch (err) {
        console.error(`trending topics model ${model} failed:`, err instanceof Error ? err.message : String(err));
      }
    }
    return null;
  };
}

/**
 * The ranking for a set of counted queries. Exported for tests, which pass a
 * scripted `runModel`. Null when pass 1 gives no usable themes.
 */
export async function groupQueries(
  queries: QueryCount[], runModel: RunModel,
): Promise<{ topics: TrendingTopic[]; routine: TrendingTopic[]; placed: number; model: string } | null> {
  const placed: Array<{ query: QueryCount; code: string }> = [];
  const open: QueryCount[] = [];
  for (const q of queries) {
    const routine = routineGroupOf(q.query);
    if (routine) placed.push({ query: q, code: `R${ROUTINE_GROUPS.indexOf(routine) + 1}` });
    else open.push(q);
  }
  if (open.length === 0) return { ...rankThemes([], placed), placed: placed.length, model: 'rules' };

  const shown = open.slice(0, THEME_SAMPLE);
  const proposed = await runModel(buildThemePrompt(shown), 2600);
  const themes = parseThemes(proposed?.text, shown.length);
  // No usable answer at all → give up, and the previous ranking stays. An
  // answer that simply holds no theme worth keeping is different: a week of
  // nothing but lookups is a true result, reported as routine counts alone.
  if (!proposed || (themes.length === 0 && !/"themes"\s*:\s*\[/.test(proposed.text || ''))) return null;
  if (themes.length === 0) {
    for (const q of open) placed.push({ query: q, code: `R${ROUTINE_GROUPS.indexOf('Other') + 1}` });
    return { ...rankThemes([], placed), placed: placed.length, model: proposed.model };
  }

  const batches: QueryCount[][] = [];
  for (let i = 0; i < open.length; i += ASSIGN_BATCH) batches.push(open.slice(i, i + ASSIGN_BATCH));
  const answers = await Promise.all(batches.map(batch => runModel(buildAssignPrompt(themes, batch), 700)));
  batches.forEach((batch, b) => {
    const assignment = parseAssignment(answers[b]?.text, themes.length, batch.length);
    for (const [i, code] of assignment) placed.push({ query: batch[i], code });
  });

  return { ...rankThemes(themes, placed), placed: placed.length, model: proposed.model };
}

/**
 * Compute the ranking. With no `window`: the rolling week (or month, in a
 * quiet week), stored for the dashboard. With a `window`: that range, returned
 * and NOT stored — a symposium's two days must not replace the daily ranking.
 * Returns null (and stores nothing) on failure.
 */
export async function refreshTrendingTopics(
  env: Env, window?: AnalyticsWindow,
): Promise<TrendingTopics | null> {
  let chosen = window;
  let data: { total: number; queries: QueryCount[] };
  if (chosen) {
    data = await queriesFor(env, chosen);
  } else {
    const rolling = (days: number) => parseAnalyticsWindow(new URLSearchParams({ days: String(days) })) as AnalyticsWindow;
    chosen = rolling(WINDOWS_DAYS[0]);
    data = await queriesFor(env, chosen);
    for (const days of WINDOWS_DAYS.slice(1)) {
      if (data.total >= MIN_SEARCHES_FOR_WINDOW) break;
      chosen = rolling(days);
      data = await queriesFor(env, chosen);
    }
  }
  if (data.queries.length === 0) return null;

  const grouped = await groupQueries(data.queries, modelRunner(env.AI));
  if (!grouped) return null;
  const covered = [...grouped.topics, ...grouped.routine].reduce((s, t) => s + t.searches, 0);
  const result: TrendingTopics = {
    generatedAt: new Date().toISOString(),
    windowDays: chosen.days,
    from: chosen.from,
    to: chosen.to,
    custom: chosen.custom,
    totalSearches: data.total,
    coveredSearches: covered,
    model: grouped.model,
    topics: grouped.topics,
    routine: grouped.routine,
  };
  if (!chosen.custom) await env.SESSIONS.put(TRENDING_TOPICS_KEY, JSON.stringify(result));
  return result;
}

export async function readTrendingTopics(env: Env): Promise<TrendingTopics | null> {
  try {
    const raw = await env.SESSIONS.get(TRENDING_TOPICS_KEY);
    return raw ? JSON.parse(raw) as TrendingTopics : null;
  } catch {
    return null;
  }
}
