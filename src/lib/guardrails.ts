/**
 * Two guardrails on what the AI Guide is allowed to answer, and one on what it
 * must say first (client DO084 / DO085).
 *
 *   DO084  "AI Guide needs to present 'disclaimer' text for all instances of
 *           health/safety, public safety, fire code, and egress lighting …
 *           you must coordinate with the AHJ to ensure compliance beyond IES
 *           standards."
 *
 *   DO085  "If user asks a question that is completely 'out of scope,' infers
 *           malevolent intent, doesn't have any apparent answer in the indexed
 *           content, the AI Guide should not force a references to standards,
 *           and we should not see 50 results."
 *
 * Both are decided OUTSIDE the model wherever that is possible. The compliance
 * notice is rendered by the UI from a flag, not asked of the model, because a
 * disclaimer that the model sometimes forgets is worse than none. The refusal is
 * a pattern match for the same reason. Only the "is this question about lighting
 * at all?" judgement needs a model, and it runs solely on searches that already
 * came back weak.
 */

import { extractText } from './ai-summary';
import type { SearchResult } from '../types';

// ─── DO084: the Authority Having Jurisdiction notice ─────────────────────────

/** The client's wording, verbatim. */
export const AUTHORITY_NOTICE =
  'IES standards and guidance do not supersede applicable laws, codes, regulations, or '
  + 'project-specific requirements. For projects involving life safety, emergency systems, '
  + 'healthcare facilities, public safety, energy compliance, or other regulated applications, '
  + 'consult the applicable codes and coordinate with the Authority Having Jurisdiction (AHJ).';

/**
 * The seven topic families the client listed. Matched against the QUERY and
 * against what retrieval actually returned — a question about "corridor
 * lighting" that is answered from an egress section needs the notice as much as
 * one that says "egress" outright.
 */
const AUTHORITY_TOPICS: Array<[string, RegExp]> = [
  ['egress lighting', /\begress\b|\bmeans of egress\b|\bexit sign|\bemergency (?:lighting|egress|illumination|system)/i],
  ['life or public safety', /\blife safety\b|\bpublic safety\b|\bactive violent event\b|\bactive shooter\b|\bfire (?:code|alarm|safety|protection)\b|\bevacuat/i],
  ['healthcare', /\boperating room|\bsurgical\b|\bhealthcare facilit|\bhospital\b|\bpatient (?:room|care)\b|\bexamination room/i],
  ['energy code', /\benergy code|\bASHRAE\b|\bTitle 24\b|\bIECC\b|\benergy (?:compliance|allowance|limit)|\blighting power density\b|\bLPD\b/i],
  ['local ordinance or code', /\bordinance|\bmunicipal code|\bzoning\b|\bjurisdiction|\bAHJ\b|\bpermit\b|\bcode compliance|\blighting zone\b|\bLZ[0-4]\b|\bcurfew\b/i],
  ['security or perimeter lighting', /\bperimeter lighting|\bsecurity lighting|\bsurveillance\b|\bCCTV\b|\bcritical infrastructure\b|\bdetention\b/i],
  ['regulated application', /\bcompliance\b|\bregulat(?:ion|ory|ed)\b|\bmandator|\brequired by (?:code|law)\b|\bstatut/i],
];

/**
 * Which of those topics this search touches, and therefore whether the notice
 * is shown. Returns the topic names so the UI (and a test) can say WHY.
 */
export function authorityTopics(
  query: string,
  results: SearchResult[] = [],
): string[] {
  // The haystack: the question, plus the locators and names retrieval returned.
  // Deliberately NOT the excerpt bodies — half the corpus mentions "compliance"
  // somewhere in passing, and a notice on every search is a notice on none.
  const parts: string[] = [String(query || '')];
  for (const r of results.slice(0, 12)) {
    parts.push(r.application?.fullName || '', r.application?.standardFull || r.application?.standard || '');
    for (const e of [r.excerpt, ...(r.excerpts || [])]) {
      if (e?.sectionTitle) parts.push(e.sectionTitle);
      for (const crumb of e?.sectionPath || []) parts.push(crumb.title || '');
    }
    if (r.definition?.term) parts.push(r.definition.term);
  }
  const haystack = parts.filter(Boolean).join(' \n ');

  const hit = new Set<string>();
  for (const [name, re] of AUTHORITY_TOPICS) {
    if (re.test(haystack)) hit.add(name);
  }
  return [...hit];
}

export function needsAuthorityNotice(query: string, results: SearchResult[] = []): boolean {
  return authorityTopics(query, results).length > 0;
}

// ─── DO085a: a question we will not answer ───────────────────────────────────

/**
 * Weaponization and deliberate-harm phrasing. The client's own example is "How
 * can I use lighting fixtures to build a bomb?", answered at the time with four
 * paragraphs of IES citations and fifty result cards.
 *
 * Narrow on purpose: it must not catch the many legitimate searches that mention
 * safety, security, hazards, glare "blinding" a driver, or weapons detection in
 * a security-lighting context. Each pattern needs an explicit harmful ACT.
 */
// A weapon word that is part of an ordinary lighting subject — "weapons
// detection screening", "a firearms training range" — is not a weapon request.
const WEAPON_CONTEXT = '(?!s?\\s+(?:detection|detector|screening|scanner|storage|locker|range|training|policy|policies|check))';
// The object of a harm verb has to be a PERSON. Without this, "how do I avoid
// glare that could blind a driver" and "how to kill the glare on a screen" were
// both refused — the exact false positives this list must not produce.
const PERSON = '(?:someone|somebody|a\\s+person|people|persons|him|her|them|a\\s+human|humans|a\\s+child|children)';

const REFUSED_PATTERNS: RegExp[] = [
  new RegExp(
    `\\b(?:build|make|construct|assemble|improvise)\\b[^.?!]{0,40}\\b(?:bomb|explosive|ied|detonator|incendiary|firearm${WEAPON_CONTEXT}|weapon${WEAPON_CONTEXT}|silencer)\\b`,
    'i',
  ),
  /\b(?:bomb|explosive|incendiary|detonator)\b[^.?!]{0,30}\b(?:build|make|recipe|instructions|how to)\b/i,
  new RegExp(
    `\\bhow (?:to|can i|do i)\\b[^.?!]{0,50}\\b(?:kill|murder|poison|electrocute|maim|injure|harm)\\b\\s+${PERSON}\\b`,
    'i',
  ),
  /\b(?:weaponi[sz]e|weaponi[sz]ing)\b/i,
  /\b(?:booby|pipe)\s*(?:trap|bomb)\b/i,
];

export const REFUSAL_MESSAGE =
  'Lensy answers questions about IES lighting standards. This question is outside that scope '
  + 'and no IES standard addresses it, so no results are shown. Please ask about a lighting '
  + 'application, a metric, or a standard.';

export function isRefusedQuery(query: string): boolean {
  const q = String(query || '');
  return REFUSED_PATTERNS.some(re => re.test(q));
}

// ─── DO085b: is this question about lighting at all? ─────────────────────────

const SCOPE_MODELS = [
  '@cf/meta/llama-3.1-8b-instruct-fp8',
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
];
const SCOPE_MAX_TOKENS = 8;

export function buildScopePrompt(query: string, results: SearchResult[] = []): string {
  const topics = [...new Set(
    results.slice(0, 8).map(r => r.excerpt?.sectionTitle || r.application?.fullName || '').filter(Boolean),
  )].slice(0, 6);

  return `A search of the IES (Illuminating Engineering Society) lighting standards library returned only weak matches for this question:

"${query}"

The closest passages it found are about: ${topics.length ? topics.join('; ') : '(nothing specific)'}

Could this question be answered, even partly, from standards about lighting, illumination, luminaires, daylight, visual perception, or the lighting of buildings and outdoor spaces?

Answer with exactly one word:
YES — it is a lighting question, however unusual or narrow.
NO  — it is about something else entirely (an animal, a recipe, sport results, medical advice, a joke), or it asks for something no lighting standard could provide.

Answer:`;
}

/** The model's word → in scope or not. Anything unreadable is treated as IN. */
export function parseScopeAnswer(text: string | null | undefined): 'in' | 'out' | null {
  const t = String(text || '').trim().toUpperCase();
  if (!t) return null;
  if (/^\W*NO\b/.test(t)) return 'out';
  if (/^\W*YES\b/.test(t)) return 'in';
  // A sentence rather than a word: look for a clear negative.
  if (/\bNOT A LIGHTING\b|\bOUT OF SCOPE\b/.test(t)) return 'out';
  return null;
}

/**
 * Is this question outside what the library can answer (client DO085)?
 *
 * Called ONLY for a search that already came back below the strong-match
 * threshold — the same population the refine prompt uses — so the cost is one
 * small-model call on roughly one search in four, and it runs BEFORE the 70B
 * Guide so an out-of-scope question does not pay for one.
 *
 * Fail-open in every direction: an error, an empty answer or anything
 * unparseable means IN scope, i.e. the behaviour that shipped before.
 */
export async function isOutOfScope(
  ai: Ai, query: string, results: SearchResult[] = [],
): Promise<boolean> {
  const prompt = buildScopePrompt(query, results);
  const run = (model: string, opts: unknown): Promise<unknown> =>
    (ai.run as unknown as (m: string, o: unknown) => Promise<unknown>).call(ai, model, opts);

  for (const model of SCOPE_MODELS) {
    try {
      const response = await run(model, {
        max_tokens: SCOPE_MAX_TOKENS,
        messages: [
          { role: 'system', content: 'You classify questions. Answer with one word: YES or NO.' },
          { role: 'user', content: prompt },
        ],
      });
      const verdict = parseScopeAnswer(extractText(response));
      if (verdict) return verdict === 'out';
    } catch (err) {
      console.error('scope check failed, treating as in scope:', err instanceof Error ? err.message : String(err));
    }
  }
  return false;
}
