/**
 * Alternative paths for a search that found nothing (client DO077).
 *
 * "If no results found, provide alternative paths. Offer guided recommendations
 *  for improving search experience (this would likely be a recommendation to
 *  broaden the search or clear filters, or 'try rephrasing your question' or
 *  'try searching by keyword or application' or suggest spelling corrections,
 *  depending on the nature of the query)."
 *
 * Their own worked example is the first rule below: "what is the difference
 * between luminance and illuminance?" with only Illuminance Tables selected
 * returns nothing, and the useful answer is "enable Document Body and search
 * again" — not "No results found".
 *
 * Everything here is deterministic and cheap: the guidance is built from the
 * query text and the filters that were actually applied, so it costs no AI call
 * and cannot itself fail. The one input from outside is `vocabulary` — the LS-1
 * definition terms, read from D1 only on a zero-result search — which powers the
 * spelling correction.
 */

import type { ContentType, NoResultsGuidance, NoResultsSuggestion, SearchFilters } from '../types';

export interface NoResultsInput {
  query: string;
  /** The content kinds the search actually ran with. */
  contentTypes: Iterable<ContentType>;
  filters?: SearchFilters;
  /** LS-1 terms (and any other known vocabulary) for the spelling check. */
  vocabulary?: string[];
  /** LensyLite searches only one collection, which is often the real reason. */
  tier?: string;
  /**
   * The question was judged not to be about lighting at all (client DO085), or
   * was refused outright. Then no filter change can help, and the only honest
   * offer is to restate the question.
   */
  outOfScope?: boolean;
  /** Overrides the message — used for the refusal wording. */
  message?: string;
}

/** A question about what something IS, or how two things differ — prose, not a table. */
const CONCEPTUAL_RE = /\b(?:what\s+is|what\s+are|difference\s+between|meaning\s+of|define|definition\s+of|why|how\s+(?:do(?:es)?|to|can|should)|explain|compare)\b/i;
/** A query asking for numbers — the Illuminance Tables are the right place. */
const QUANTITATIVE_RE = /\b(?:how\s+(?:bright|much|many)|lux|lumens?|footcandles?|fc\b|illuminance\s+levels?|light\s+levels?|uniformity\s+ratio)\b/i;
/** Words that carry no meaning for the spelling check. */
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'what', 'when', 'where', 'which', 'that', 'this', 'from',
  'are', 'was', 'were', 'have', 'has', 'does', 'should', 'would', 'could', 'about',
  'between', 'into', 'over', 'under', 'there', 'their', 'they', 'you', 'your', 'ies',
  'standard', 'standards', 'lighting', 'light', 'please', 'provide', 'give', 'list',
  'show', 'find', 'search', 'tell', 'need', 'want', 'used', 'using', 'recommendations',
]);

const CONTACT: NoResultsSuggestion = {
  label: 'Ask Standards@ies.org',
  action: 'contact',
};

/**
 * Levenshtein distance, bounded: it stops as soon as the distance is known to
 * exceed `max`, so the vocabulary scan stays cheap.
 */
export function editDistance(a: string, b: string, max = 2): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost);
      if (row[j] < best) best = row[j];
    }
    if (best > max) return max + 1;
    prev = row;
  }
  return prev[b.length];
}

/**
 * The query with one misspelt word corrected, or null.
 *
 * Deliberately at most ONE correction: two simultaneous corrections are almost
 * always the wrong guess, and a wrong "did you mean" is worse than none.
 */
export function suggestSpelling(query: string, vocabulary: string[] = []): { term: string; correction: string; query: string } | null {
  const words = String(query || '').split(/\s+/);
  if (words.length === 0 || vocabulary.length === 0) return null;

  // One flat set of single words: "correlated color temperature" contributes
  // three candidates, which is what a typed word can be compared against.
  const terms = new Set<string>();
  for (const entry of vocabulary) {
    for (const word of String(entry || '').toLowerCase().split(/[^a-z]+/)) {
      if (word.length >= 4) terms.add(word);
    }
  }
  if (terms.size === 0) return null;

  for (let i = 0; i < words.length; i++) {
    const bare = words[i].toLowerCase().replace(/[^a-z]/g, '');
    if (bare.length < 5 || STOPWORDS.has(bare)) continue;
    if (terms.has(bare)) continue;                     // spelt fine
    // Nearest vocabulary word within two edits; a longer word may be two edits
    // out, a five-letter word only one.
    const budget = bare.length >= 8 ? 2 : 1;
    let best: string | null = null;
    let bestDistance = budget + 1;
    for (const term of terms) {
      if (Math.abs(term.length - bare.length) > budget) continue;
      const d = editDistance(bare, term, budget);
      if (d < bestDistance) { bestDistance = d; best = term; }
      if (bestDistance === 1) break;
    }
    if (!best || bestDistance > budget) continue;
    const corrected = [...words];
    corrected[i] = words[i].replace(/[A-Za-z]+/, best);
    return { term: words[i], correction: best, query: corrected.join(' ') };
  }
  return null;
}

/** Anything the Worker reads as a scope: a designation, or a lighting zone. */
const SCOPE_TOKEN_RE = /\b(?:ANSI\s*\/\s*)?(?:ANSI|IES|BSR)?[\s/]*(?:RP|LP|LS|LM|TM|DG|HB|LEM|G|WP)-\s*\d+(?:\.\d+)?(?:-\d{2,4})?(?:\s*\+?\s*E\d+)?\b|\b(?:LZ|Lighting\s+Zone\s*)\s*[0-4]\b/gi;

/**
 * The same query with the words that narrowed it removed.
 *
 * Returns null when nothing was removed or nothing usable is left — a two-word
 * query that was entirely a designation cannot be broadened, it can only be
 * replaced.
 */
export function stripScopeFromQuery(query: string): string | null {
  const stripped = String(query || '')
    .replace(SCOPE_TOKEN_RE, ' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([,.?!])/g, '$1')
    .trim();
  if (!stripped || stripped === String(query || '').trim()) return null;
  // Two words is the floor for a search that can still mean something.
  return stripped.split(/\s+/).filter(w => /[a-z0-9]/i.test(w)).length >= 2 ? stripped : null;
}

/**
 * Build the guidance for a zero-result search.
 *
 * Order matters: the first suggestion is the one most likely to work, because
 * that is the one a reader will press.
 */
export function buildNoResultsGuidance(input: NoResultsInput): NoResultsGuidance {
  const query = String(input.query || '').trim();
  const types = new Set<ContentType>(input.contentTypes || []);
  const filters = input.filters || {};
  const suggestions: NoResultsSuggestion[] = [];
  let message = 'Nothing matched this search.';

  // ── Out of scope: no filter can fix a question the library cannot answer ───
  // Client DO085: "the 'Refine your search' prompt can be the first to state
  // that no relevant results were found, and offer the user an opportunity to
  // restate the question." Offering "enable Document Body" for "what color are
  // zebras?" would be worse than saying nothing.
  if (input.outOfScope) {
    return {
      message: input.message
        || 'No relevant results were found — this question does not appear to be answerable from the IES lighting standards.',
      suggestions: [
        { label: 'Restate the question', action: 'rephrase' },
        CONTACT,
      ],
    };
  }

  const conceptual = CONCEPTUAL_RE.test(query);
  const quantitative = QUANTITATIVE_RE.test(query);
  const onlyTables = types.has('tables') && !types.has('body') && !types.has('references') && !types.has('definitions');

  // 1. The content kind that would have answered it is switched off. This is the
  //    client's own example, and it is by far the most common cause.
  if (!types.has('body') && (conceptual || onlyTables || types.size <= 1)) {
    message = onlyTables
      ? 'This search only looked inside the Illuminance Tables.'
      : 'The Documents content type was not part of this search.';
    suggestions.push({
      label: 'Search document bodies too',
      action: 'enable_content_type',
      value: 'body',
    });
  }
  if (!types.has('definitions') && conceptual) {
    suggestions.push({
      label: 'Look in the ANSI/IES LS-1 definitions',
      action: 'enable_content_type',
      value: 'definitions',
    });
  }
  if (!types.has('tables') && quantitative) {
    message = 'This search did not include the Illuminance Tables, where recommended light levels live.';
    suggestions.push({
      label: 'Include the Illuminance Tables',
      action: 'enable_content_type',
      value: 'tables',
    });
  }

  // 2. A narrowing that was applied on top.
  if (filters.indoor_outdoor) {
    suggestions.push({
      label: `Drop the ${filters.indoor_outdoor === 'Indoor' ? 'Interior' : 'Exterior'}-only narrowing`,
      action: 'clear_location',
    });
  }
  // A standard/zone scope is INFERRED FROM THE QUERY (inferFiltersFromQuery), not
  // set by the UI, so "reset the filters" would re-run the identical search and
  // return the identical nothing. The actionable fix is to run the query without
  // the words that narrowed it.
  const scoped = filters.standard || filters.standard_prefix || filters.lighting_zone;
  if (scoped) {
    const named = filters.standard || filters.standard_prefix || filters.lighting_zone;
    message = `This search was narrowed to ${named}, because the query names it.`;
    const broadened = stripScopeFromQuery(query);
    if (broadened && broadened !== query) {
      suggestions.push({ label: 'Search the whole library', action: 'search', value: broadened });
    } else {
      suggestions.push({ label: 'Clear every filter and search again', action: 'clear_filters' });
    }
  } else if (filters.tm24_eligible) {
    suggestions.push({ label: 'Clear every filter and search again', action: 'clear_filters' });
  }

  // 3. A likely typo. Placed after the filter fixes: a filter is a certainty,
  //    a spelling guess is a guess.
  const spelling = suggestSpelling(query, input.vocabulary);
  if (spelling) {
    suggestions.push({
      label: `Did you mean “${spelling.correction}”?`,
      action: 'search',
      value: spelling.query,
    });
  }

  // 4. Always available, and last: rephrasing, and a human.
  suggestions.push({
    label: query.split(/\s+/).length > 6
      ? 'Try a shorter question, or a keyword or application name'
      : 'Try rephrasing, or search by keyword or application name',
    action: 'rephrase',
  });

  if (input.tier === 'lite') {
    message = 'LensyLite searches the Lighting Science collection only, which may not cover this topic.';
  }

  suggestions.push(CONTACT);
  return { message, suggestions };
}
