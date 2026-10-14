/**
 * AI curation of the result-card order (client request, 2026-08-20).
 *
 * "The cards' selection and priority [should be] heavily influenced by the
 *  logic used by the AI Guide (promote the cards the Guide actually cites) …
 *  have the rest of the cards also curated by the same logic … If they disable
 *  'AI Guide' then they lose that curation."
 *
 * This closes the mismatch the on-by-default Guide made visible: the Guide
 * reads better than the first few cards because it sees more context (up to 3
 * passages per result, 8 results at once, and may answer from the 6th), while
 * the card list is pure vector ranking — table rows reach the top partly on
 * sheer volume of application vectors, and the tie epsilon clusters sibling
 * rows so the top cards are often four variants of one row.
 *
 * Two signals, combined in curateResults():
 *
 *   1. rerankResults() — a second, cheap AI pass over compact descriptors of
 *      the WHOLE pool (up to RERANK_MAX results, not just the Guide's 8),
 *      returning a best-first order. Run IN PARALLEL with the Guide generation
 *      so it adds no wall-clock time: its output is a short JSON array while
 *      the Guide writes paragraphs.
 *   2. extractGuideCitations() — the results the Guide's own answer actually
 *      cites (designation + the section or page the prose names), promoted to
 *      the very top and flagged `citedByGuide` so the UI can badge them.
 *
 * Both signals only exist when the AI Guide is on (`includeAISummary`), which
 * is the client's rule: turning the Guide off returns the list to the plain
 * vector ranking. Version comparisons are never curated — their order is a
 * client specification of its own (current edition first, then deprecated
 * editions newest → oldest, DO27/DO42).
 *
 * Everything here is fail-open: a rerank that errors, times out or returns
 * garbage yields `null` and the list keeps the order it had.
 */

import { extractText } from './ai-summary';
import { committeeScope, isFoundationalCommittee } from './committees.js';
import type { SearchResult } from '../types';

/** How many results are described to the rerank model. Beyond this, the tail
 *  keeps its vector order — descriptors are ~40 tokens each, so 40 results is
 *  a ~2k-token prompt, well inside the fast models' context. */
export const RERANK_MAX = 40;

/** Promotion cap: a Guide that cites one standard heavily must not drag a
 *  whole chapter's worth of rows above everything else. Results beyond the cap
 *  keep their `citedByGuide` badge but stay where the ranking put them. */
export const PROMOTED_MAX = 12;

/** A rank response must order at least this many results to be trusted —
 *  a model that emits "[1]" and stops has not ranked anything. */
const RANK_MIN_ENTRIES = 3;

// Same primary as the Guide (quality decides the order the user reads), with
// the small model as the fallback. Output is a short JSON array, so even the
// 70B answers quickly relative to the Guide's paragraphs.
const RERANK_MODELS = [
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  '@cf/meta/llama-3.1-8b-instruct-fp8',
];

const RERANK_MAX_TOKENS = 512;

// ─── Rerank prompt ────────────────────────────────────────────────────────────

const TYPE_LABELS: Record<string, string> = {
  application: 'Illuminance Table row',
  excerpt: 'Document passage',
  reference: 'Reference entry',
  definition: 'Definition',
  standard: 'Whole standard',
};

/** One compact line per result — enough to judge fit, cheap enough to send 40. */
export function describeForRerank(r: SearchResult, idx: number): string {
  const app = r.application || ({} as SearchResult['application']);
  const type = TYPE_LABELS[r.resultType] || 'Result';
  const name =
    r.definition?.term
    || r.document?.title
    || app.fullName
    || app.category
    || (r.excerpt?.section
      ? `§${r.excerpt.section}${r.excerpt.sectionTitle ? ` ${r.excerpt.sectionTitle}` : ''}`
      : '');
  const snippet = (r.excerpt?.text || r.document?.description || '').substring(0, 160);
  const committee = shortCommittee(r.committee?.name);
  return `[${idx + 1}] ${type} — ${app.standard || ''}${committee ? ` (${committee})` : ''}${name ? ` — ${name}` : ''}${snippet ? ` — "${snippet}"` : ''}`;
}

/** "IES Color Committee" → "Color Committee": the descriptor is a budget. */
function shortCommittee(name: string | null | undefined): string {
  return String(name || '').replace(/^IES\s+/i, '').trim();
}

/** Longest scope text sent per committee — the Included/Excluded sentences. */
const SCOPE_MAX_CHARS = 320;

/**
 * The published scope of every authoring committee in the pool (client
 * 10/09/26 #3: "train Lens on each Committee's scope, as a way to improve
 * curation"). A question about what a quantity or term IS belongs to the
 * committees whose scope is nomenclature, photometry or vision science, not to
 * the application committees that merely use the term — the scope says which
 * is which in the committees' own words. Empty when no scope is on record.
 */
export function committeeScopesBlock(results: SearchResult[]): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const r of results.slice(0, RERANK_MAX)) {
    const name = shortCommittee(r.committee?.name);
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    const scope = committeeScope(name);
    if (!scope) continue;
    const text = scope.length > SCOPE_MAX_CHARS ? `${scope.slice(0, SCOPE_MAX_CHARS).replace(/\s+\S*$/, '')}…` : scope;
    lines.push(`- ${name}: ${text}`);
  }
  return lines.join('\n');
}

/** Foundational committees present in the pool, by display name (deduped). */
export function foundationalCommitteesIn(results: SearchResult[]): string[] {
  const names = new Map<string, string>();
  for (const r of results.slice(0, RERANK_MAX)) {
    const name = shortCommittee(r.committee?.name);
    if (name && isFoundationalCommittee(name)) names.set(name.toLowerCase(), name);
  }
  return [...names.values()];
}

export function buildRerankPrompt(query: string, results: SearchResult[], conceptQuery = false): string {
  const lines = results.slice(0, RERANK_MAX).map((r, i) => describeForRerank(r, i)).join('\n');
  const scopes = committeeScopesBlock(results);
  // Client, 2026-10-14: "weight the scope slightly more". On a concept question
  // the committee fit stops being one criterion among five and becomes the
  // first thing the ranking is told, naming the committees present.
  const foundational = conceptQuery ? foundationalCommitteesIn(results) : [];
  const conceptRule = foundational.length > 0
    ? `
THIS QUERY ASKS WHAT A TERM OR CONCEPT MEANS, OR HOW CONCEPTS DIFFER. The committee scope is therefore the FIRST criterion: rank results authored by ${foundational.join(', ')} ahead of results from application committees (retail, office, roadway, museum, sports …), unless an application result is plainly the only one that addresses the concept.
`
    : '';
  return `You are ranking search results for a lighting professional searching the IES standards library.

Query: "${query}"

Results:
${lines}
${scopes ? `
Scopes of the authoring technical committees (as IES publishes them):
${scopes}
` : ''}${conceptRule}
Rank ALL of these results from most to least useful for answering the query. Judge by:
- how directly the result's content answers the query — not mere topical overlap;
- whether the passage or table row addresses the asked application, space or topic itself;
- whose subject it is: prefer results from the committee whose scope covers what the query is asking about. A question about what a term, quantity or concept means or how two concepts differ belongs to the committees whose scope is nomenclature, measurement or the science of light and vision, ahead of application committees that only use the term; a question about lighting a particular space or application belongs to that application's committee;
- variety: when several rows are near-duplicates of one table block, the most representative one ranks ahead of its variants;
- a definition or a whole-standard card ranks highly only when the query asks for terminology or for that document.

Respond with ONLY a JSON array of the result numbers, best first, e.g. [3,1,2]. Include each number at most once. No other text.`;
}

/**
 * Parse the model's ranking into 0-based indices. Tolerant of partial output:
 * whatever was validly ranked leads, and the caller appends the rest in their
 * original order. Returns null when there is nothing trustworthy to apply.
 */
export function parseRankOrder(text: string | null | undefined, count: number): number[] | null {
  if (!text) return null;
  const match = /\[[\s\d,]*\]/.exec(text);
  if (!match) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const seen = new Set<number>();
  const order: number[] = [];
  for (const value of parsed) {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1 || n > count) continue;
    if (seen.has(n)) continue;
    seen.add(n);
    order.push(n - 1);
  }
  if (order.length < Math.min(RANK_MIN_ENTRIES, count)) return null;
  return order;
}

/**
 * Ask the model for a best-first order over the pool. Returns 0-based indices
 * (possibly a partial prefix), or null — never throws.
 */
export async function rerankResults(ai: Ai, query: string, results: SearchResult[], conceptQuery = false): Promise<number[] | null> {
  const pool = results.slice(0, RERANK_MAX);
  if (pool.length < 2) return null;
  const prompt = buildRerankPrompt(query, pool, conceptQuery);

  // Receiver-bound call — `Ai#run` writes a private field, so a detached
  // reference throws for every model (the DO9 root cause in ai-summary.ts).
  const run = (model: string, opts: unknown): Promise<unknown> =>
    (ai.run as unknown as (m: string, o: unknown) => Promise<unknown>).call(ai, model, opts);

  for (const model of RERANK_MODELS) {
    try {
      const response = await run(model, {
        max_tokens: RERANK_MAX_TOKENS,
        messages: [{ role: 'user', content: prompt }],
      });
      const order = parseRankOrder(extractText(response), pool.length);
      if (order) return order;
      console.warn(`AI rerank model ${model} returned no usable ranking — trying next model.`);
    } catch (err) {
      console.error(`AI rerank model ${model} failed — trying next model:`, err instanceof Error ? err.message : String(err));
    }
  }
  return null;
}

/**
 * The order the AI Guide reads a concept question's results in: foundational
 * committees lifted by up to SCOPE_LIFT places. The Guide sees the first few
 * results only and tends to lead with Result 1, so this decides which
 * standards its answer is built from.
 */
export function conceptOrderForGuide(results: SearchResult[]): SearchResult[] {
  const indices = results.map((_, i) => i);
  return liftWithin(indices, i => isFoundationalCommittee(results[i]?.committee?.name)).map(i => results[i]);
}

// ─── Guide citations ──────────────────────────────────────────────────────────

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/**
 * Which results the Guide's answer actually cites, as a set of indices into
 * `results`.
 *
 * A result is cited when its standard's designation appears in the prose AND
 * the prose also names one of the result's own locators — its section number
 * ("§4.2" / "Section 4.2") or its page ("p. 21"). When the Guide names a
 * standard without a locator we can match, its best-ranked result stands in:
 * the Guide talked about the document, so the document's strongest card is
 * what the reader should meet first.
 *
 * Never call this with a degraded summary: the fallback text is a bare list of
 * every standard in the result set, which would "cite" everything.
 */
export function extractGuideCitations(text: string | null | undefined, results: SearchResult[]): Set<number> {
  const cited = new Set<number>();
  if (!text || !results.length) return cited;

  // Group result indices by standard, keeping ranking order within each group.
  const byStandard = new Map<string, number[]>();
  const names = new Map<string, Set<string>>(); // standard id → designations to look for
  results.forEach((r, i) => {
    const id = r.application?.standard;
    if (!id) return;
    if (!byStandard.has(id)) {
      byStandard.set(id, []);
      names.set(id, new Set());
    }
    byStandard.get(id)!.push(i);
    names.get(id)!.add(id);
    if (r.application?.standardFull) names.get(id)!.add(r.application.standardFull);
  });

  for (const [id, indices] of byStandard) {
    const designations = [...(names.get(id) || [])].sort((a, b) => b.length - a.length);
    const mentioned = designations.some(d =>
      new RegExp(`(?<![\\w-])${escapeRe(d)}(?![\\w-])`, 'i').test(text));
    if (!mentioned) continue;

    let locatorHit = false;
    for (const i of indices) {
      const r = results[i];
      const sections = new Set<string>();
      if (r.excerpt?.section) sections.add(String(r.excerpt.section));
      for (const e of r.excerpts || []) if (e.section) sections.add(String(e.section));

      const sectionCited = [...sections].some(sec =>
        new RegExp(`(?:§\\s*|Section\\s+)${escapeRe(sec)}(?![\\d.])`, 'i').test(text));
      const page = r.citationPage ?? r.excerpt?.pageNumber ?? null;
      const pageCited = page != null
        && new RegExp(`(?:p\\.\\s*|page\\s+)${page}(?!\\d)`, 'i').test(text);

      if (sectionCited || pageCited) {
        cited.add(i);
        locatorHit = true;
      }
    }
    // Designation named but no locator we can pin: the standard's best card
    // stands in for it.
    if (!locatorHit) cited.add(indices[0]);
  }

  return cited;
}

// ─── Assembly ─────────────────────────────────────────────────────────────────

export interface CurationInput {
  /** 0-based best-first order from rerankResults(), possibly partial, or null. */
  order: number[] | null;
  /** Indices of the results the Guide cites (extractGuideCitations). */
  cited: Set<number>;
  /**
   * The query asks what a concept means or how two differ (isConceptQuery).
   * Results from foundational committees are then lifted within their band.
   */
  conceptQuery?: boolean;
}

/**
 * How far a foundational-committee result may move up within its band on a
 * concept question — past at most this many application-committee results.
 * Deliberately bounded ("slightly more", client 2026-10-14): the rerank and
 * the Guide's citations still decide the order; this settles the near-ties the
 * model leaves between a vision-science passage and a retail one.
 */
export const SCOPE_LIFT = 4;

/** Stable bounded lift: each favoured item moves ahead of at most `lift` others. */
export function liftWithin(band: number[], favoured: (i: number) => boolean, lift = SCOPE_LIFT): number[] {
  const out: number[] = [];
  for (const i of band) {
    if (!favoured(i)) {
      out.push(i);
      continue;
    }
    let pos = out.length;
    let passed = 0;
    while (pos > 0 && passed < lift && !favoured(out[pos - 1])) {
      pos--;
      passed++;
    }
    out.splice(pos, 0, i);
  }
  return out;
}

export interface CurationOutcome {
  results: SearchResult[];
  /** Did curation change the order at all? */
  changed: boolean;
  /** How many Guide-cited results were promoted to the front. */
  promoted: number;
}

/**
 * The curated order:
 *
 *   [ definition term-matches ] [ Guide-cited (≤ PROMOTED_MAX) ] [ the rest ]
 *
 * with the rerank order (falling back to the original order) deciding the
 * sequence WITHIN each band. Definition term-matches stay pinned in front —
 * "a search for 'Color' must return the color definition" is a client rule
 * (DO33) that no ranking may undo. Guide-cited results carry `citedByGuide`
 * for the UI badge whether or not they were promoted.
 */
export function curateResults(results: SearchResult[], { order, cited, conceptQuery = false }: CurationInput): CurationOutcome {
  // The exact/prefix term match scores LS-1 definitions 0.95–1.0
  // (DEFINITION_PREFIX_SCORE in the search worker); semantic definition
  // matches score below that and are curated like everything else.
  const isPinnedDefinition = (r: SearchResult) =>
    r.resultType === 'definition' && (r.relevanceScore || 0) >= 0.95;

  // Base sequence: rerank order first, then whatever it did not cover, in the
  // order the vector ranking had them.
  const base: number[] = [];
  const inBase = new Set<number>();
  for (const i of order || []) {
    if (i >= 0 && i < results.length && !inBase.has(i)) {
      base.push(i);
      inBase.add(i);
    }
  }
  for (let i = 0; i < results.length; i++) {
    if (!inBase.has(i)) base.push(i);
  }

  const pinned: number[] = [];
  const promotedList: number[] = [];
  const rest: number[] = [];
  for (const i of base) {
    if (isPinnedDefinition(results[i])) pinned.push(i);
    else if (cited.has(i) && promotedList.length < PROMOTED_MAX) promotedList.push(i);
    else rest.push(i);
  }

  // A concept question lifts the foundational committees' results within each
  // band (never across bands: a Guide citation still outranks an uncited card).
  const favoured = (i: number) => isFoundationalCommittee(results[i]?.committee?.name);
  const finalOrder = conceptQuery
    ? [...pinned, ...liftWithin(promotedList, favoured), ...liftWithin(rest, favoured)]
    : [...pinned, ...promotedList, ...rest];
  const changed = finalOrder.some((idx, pos) => idx !== pos);

  const curated = finalOrder.map(i =>
    cited.has(i) ? { ...results[i], citedByGuide: true } : results[i]);

  return { results: curated, changed, promoted: promotedList.length };
}
