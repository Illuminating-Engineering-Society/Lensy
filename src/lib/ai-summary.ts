/**
 * AI Summary Client
 * Generates optional AI summaries for search results using Cloudflare Workers AI.
 *
 * Three prompt modes (client feedback DO24 / DO25 / DO26.5):
 *   'guide'       — substantive guidance + context + overview, with citations
 *   'comparison'  — "what's new" analysis in three fixed sections
 *   'references'  — how often a topic is referenced, related search terms,
 *                   and which standards reference the listed items
 *
 * Copyright Rules (CRITICAL — enforced here):
 *   - Never quote more than 15 words from a single source
 *   - Use at most ONE quote per source
 *   - Default to paraphrasing
 *   - Never transcribe illuminance table values directly
 *
 * Over-long quotes are TRIMMED (sanitizeQuotes) rather than causing the whole
 * answer to be replaced by a bare standards list — that replacement was the
 * DO24 regression ("AI Guide is no longer providing useful guidance; it is only
 * listing the documents cited in result cards").
 */

import { checkCopyrightViolations, sanitizeQuotes } from './citations';
import { hasFormula, stripInlineFormula } from './formula.js';
import type { AIMode, AISummary, AnswerStyle, ComparisonContext, SearchResult } from '../types';

// Model chain (client bug DO9: "AI Guide results are not populating on any
// search"): a failure of the primary model must degrade, never disappear.
// Each model is tried in order; if every one errors, a safe standards-list
// fallback is returned (flagged `degraded` so it is never cached).
//
// Every id here MUST exist in `wrangler ai models` — the previous second entry
// ('@cf/meta/llama-3.1-8b-instruct-fast') does not, so the chain had exactly
// one working link: any hiccup on the 70B model went straight to the bare
// standards-list fallback the client reported in DO24.
const MODELS = [
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  '@cf/meta/llama-4-scout-17b-16e-instruct',
  '@cf/mistralai/mistral-small-3.1-24b-instruct',
  '@cf/meta/llama-3.1-8b-instruct-fp8',
];

// Output budget per mode (client DO24: answers read as length-capped; DO25:
// comparisons need "greatly expanded" capacity to convey changes accurately).
//
// comparison raised 4000 → 6000 for client DO062: "Permit much longer 'AI
// Document Comparison' response lengths (for these comparison responses only)."
// The chapter-grouped bullet list the same item asks for is structurally longer
// than the prose it replaces — a chapter heading plus a bullet per finding —
// and a comparison that stops mid-chapter is worse than a short one.
const MAX_TOKENS: Record<AIMode, number> = {
  guide: 3000,
  comparison: 6000,
  references: 2500,
};

/**
 * The output budget for one request.
 *
 * A 'brief' answer is capped hard as well as asked for: the client's note is
 * about answers that ramble past what the question needed, and a cap is the one
 * instruction a model cannot talk itself out of. 'full' and 'auto' keep the
 * mode's own budget — 'auto' must be able to write a long answer when the
 * question deserves one.
 */
export function tokenBudget(mode: AIMode, style: AnswerStyle = 'auto'): number {
  if (mode === 'guide' && style === 'brief') return 700;
  return MAX_TOKENS[mode];
}

// How many results are described to the model. Comparisons need room for both
// editions; references mode is a listing, so it gets the widest window.
const PROMPT_RESULTS: Record<AIMode, number> = {
  guide: 8,
  // Raised 10→18 (client DO28: "greater depth of responses and greater
  // accuracy"). The search worker now returns up to 12 prior-edition excerpts
  // spread across chapters; the prompt has to be able to hold both editions.
  comparison: 18,
  references: 12,
};

const SYSTEM_PROMPT = `You are Lensy, the IES Standards Assistant. Your role is to help lighting professionals explore and understand IES (Illuminating Engineering Society) standards through accurate, well-cited responses.

═══════════════════════════════════════════════════════════════
CORE PRINCIPLES
═══════════════════════════════════════════════════════════════
1. Always cite specific IES standards with full designation, section, and page number when available.
2. Never provide legal, safety, financial, or contractual advice.
3. Never perform design calculations or compliance determinations.
4. Direct users to authoritative sources rather than making judgments.
5. Maintain a professional, neutral, academic tone.

═══════════════════════════════════════════════════════════════
WHAT A GOOD ANSWER LOOKS LIKE
═══════════════════════════════════════════════════════════════
You are an expert guide, not a search-result index. A good answer ORIENTS the
reader: it explains what the standards actually say about the topic, why the
cited sections matter, and where to read further.

NEVER answer with only a list of standard designations. A bare list of
documents is not an acceptable response — the result cards below the answer
already show the documents. Your job is the substance between them.

Write in prose paragraphs (short headings are welcome). Name every standard by
its exact designation as it appears in the search results, so it can be
hyperlinked.

═══════════════════════════════════════════════════════════════
GOVERNING CRITERIA FOR ILLUMINANCE TABLES
(per IES Illuminance Table reference — General Notes a–b)
═══════════════════════════════════════════════════════════════
- Maintained Illuminance Target values are CONSENSUS RECOMMENDATIONS for Min/Avg/Max maintained levels at heights AFF (above finished floor) for normally-sighted people UNDER 65 years of age.
- "TS" (task surface) means the criterion applies at the height of the visual task itself, not a fixed AFF.
- "T" = Task (localized — e.g. desk, library stack); "A" = Area (whole room/space — e.g. corridor floor, field of play).
- When multiple tasks share a space, the most-frequent task with the highest recommended illuminance governs. Use localized task lighting for infrequent demanding tasks rather than over-lighting the area.
- DESIGN TOLERANCE: ±10%. Predicted values >10% below target → poor visibility for many users. Predicted values >10% above target → over-lighting and energy misuse.
- Light loss factors (luminaire dirt depreciation, lumen depreciation, surface reflectance changes) MUST be applied; reference ANSI/IES LS-6 and ANSI/IES/NALMCO RP-36.

═══════════════════════════════════════════════════════════════
VARIANCES (always note when relevant)
═══════════════════════════════════════════════════════════════
- Health-code and safety-code requirements SUPERSEDE these recommendations.
- Safety/security or human-vehicular proximity contexts → values are MINIMUM maintained illuminances (refer to IES G-1).
- When the majority of occupants are over 65 → DOUBLE the illuminance recommendations (or use localized task lighting first; refer to ANSI/IES RP-28).
- Visual tasks in Categories P–Y under non-1.0 S/P-value sources → variances allowed per ANSI/IES TM-24.

═══════════════════════════════════════════════════════════════
TABLE COLUMN VOCABULARY (use these terms precisely)
═══════════════════════════════════════════════════════════════
HIERARCHY (8 levels): Sub Category → App → App_s1 → App_s2 → App_s3 → App_s4 → App_s5 → App_s6.
GENERAL: T/A (Task/Area), Veiling Risk (L/M/H), Class of Play (I–IV; I is highest skill/illuminance, IV is lowest).
HORIZONTAL/VERTICAL: Cat (A–Y per RP-10 Table A-2), Lux, @ Meters, Fc, @ Feet, Max/Avg/Min, CV (Coefficient of Variation), Uniformity Ratio, Ratio Basis (Max:Avg:Min | Max:Avg | Max:Min | Avg:Min).
ENVIRONMENTAL & VISUAL (currently RP-43-25): Glare (max), Uplight (max), Controls, Spectrum.
LIGHTING ZONES: Lz0–Lz4 (equivalently "LZ4", "L Z 4", "Lighting Zone 4"); a row may also carry a curfew zone ("Lz3 (and Lz4 curfew)").
UNITS: lux→fc conversion in these tables uses 10:1 (NOT 10.76:1).

CV vs Uniformity Ratio:
- Uniformity Ratio = highest÷lowest measurement (single pair).
- CV = standard deviation ÷ mean across ALL measurement points (statistical, more robust).

═══════════════════════════════════════════════════════════════
CITATION FORMAT (mandatory)
═══════════════════════════════════════════════════════════════
"According to ANSI/IES RP-43-25 Recommended Practice: Lighting Design for Outdoor Pedestrian Applications, Section 8.6.1.4, p. 42, ..."

Each response must include:
1. Full standard designation (ANSI/IES XX-YY)
2. Section or page reference
3. Brief explanation of WHY the cited section is relevant
4. At least one ADDITIONAL READING recommendation when helpful (relevant, non-redundant).

═══════════════════════════════════════════════════════════════
COPYRIGHT RULES (CRITICAL — strictly enforced)
═══════════════════════════════════════════════════════════════
- ≤15 words quoted from any single source per passage.
- ≤1 direct quote per source document; after one quote, that source is CLOSED — paraphrase only.
- Default to paraphrasing in your own words.
- NEVER transcribe illuminance values (e.g. "300 lux at 0.76 m") — direct the user to view the table card or PDF excerpt.
- NEVER reproduce song lyrics, poems, haikus, or substantial article passages.

═══════════════════════════════════════════════════════════════
FORMULAE (never reproduce one)
═══════════════════════════════════════════════════════════════
A formula in a PDF is a LAYOUT, not a line of text: the excerpts you are given
have lost the fraction bars, superscripts and alignment, so any equation you
write from them WILL be wrong. Never write an equation, expression or symbolic
definition — not even one that appears in an excerpt, and not "approximately".
Say what the formula computes and where it is printed, then send the reader
there: "TM-28-20 gives an exponential decay formula for projected lumen
maintenance in Annex B, p. 14."

═══════════════════════════════════════════════════════════════
DEPRECATED STANDARDS POLICY
═══════════════════════════════════════════════════════════════
- Refer to outdated IES Standards as "deprecated".
- Only recommend the CURRENT (latest revision) standard for further reading.
- Exception: when the user explicitly asks "what's new" / "what changed" / "what's different":
  - Show ADDED items (with citations to the current standard)
  - Show REVISED items (with citations to current and deprecated)
  - Frame possible deletions as historical context, never as guidance.

═══════════════════════════════════════════════════════════════
HANDLING UNCERTAINTY
═══════════════════════════════════════════════════════════════
If you cannot confidently answer from the provided search results:
1. Say so clearly — do not guess.
2. Direct the user to Standards@ies.org for authoritative assistance.
3. If the application is not covered, mention reviewing the monthly IES Ignite Newsletter for upcoming public reviews and publications, and offer recommendations for similar applications that ARE covered.`;

export interface AIRequestOptions {
  mode?: AIMode;
  /** Editions involved in a version comparison (mode 'comparison'). */
  comparison?: ComparisonContext;
  /**
   * How long an answer to write (client note, 2026-08-20). 'auto' — the default
   * — tells the model to match the question: one paragraph for a question one
   * standard answers, several for a broad one.
   */
  answerStyle?: AnswerStyle;
  /**
   * The AHJ compliance notice the UI is printing above this answer (client
   * DO084). Passing it here does two things: the model is told not to repeat it,
   * and it travels back on the summary so the card and a cached response carry
   * the same text.
   */
  authorityNotice?: string | null;
}

/**
 * Generate an AI summary for search results.
 *
 * @param ai - Cloudflare Workers AI binding (env.AI)
 * @param query - User's original search query
 * @param searchResults - Formatted search results
 * @param opts - prompt mode + comparison context
 */
export async function generateResponse(
  ai: Ai,
  query: string,
  searchResults: SearchResult[],
  opts: AIRequestOptions = {},
): Promise<AISummary> {
  const mode: AIMode = opts.mode || 'guide';
  const answerStyle: AnswerStyle = opts.answerStyle || 'auto';
  const userPrompt = buildPrompt(query, searchResults, mode, opts.comparison, answerStyle, opts.authorityNotice);

  // Invoke through `ai` — NEVER a detached reference.
  //
  // `const run = ai.run` loses the receiver: `Ai#run` writes to a private class
  // field, so calling it with `this === undefined` throws
  //   "Cannot set properties of undefined (setting '#options')"
  // for EVERY model on EVERY request. That is the real root cause behind DO9
  // ("AI Guide results are not populating"), DO24 ("only listing the documents")
  // and DO25 (no comparison analysis): the model loop always fell through to the
  // standards-list fallback. Embeddings were unaffected because they are called
  // as `env.AI.run(...)`, a normal method call.
  //
  // The model-string overloads in workers-types don't cover every model's
  // request/response shape, so the cast narrows at this one boundary and the
  // text is read through extractText().
  const run = (model: string, opts: unknown): Promise<unknown> =>
    (ai.run as unknown as (m: string, o: unknown) => Promise<unknown>).call(ai, model, opts);

  let text: string | null = null;
  for (const model of MODELS) {
    try {
      const response = await run(model, {
        max_tokens: tokenBudget(mode, answerStyle),
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userPrompt },
        ],
      });
      const extracted = extractText(response);
      if (extracted) {
        text = extracted;
        break;
      }
      // Log the SHAPE, not just "empty": a response we can't read looks
      // identical to a model failure from the outside, and that ambiguity is
      // what made the DO24 fallback so hard to diagnose.
      console.warn(
        `AI Guide model ${model} returned no readable text — trying next model. Shape:`,
        describeShape(response),
      );
    } catch (err) {
      console.error(`AI Guide model ${model} failed — trying next model:`, err instanceof Error ? err.message : String(err));
    }
  }

  // Every fallback keeps the mode AND the comparison context: when a comparison
  // degrades, the user must still get "[old] is deprecated and has been replaced
  // by [new]" with both editions hyperlinked (client DO25) — that advisory is
  // exactly what disappeared when the model failed.
  // `degraded: true` on EVERY fallback path, not only the all-models-errored
  // one: the flag is what keeps the answer out of the cache. A fallback from the
  // copyright or empty-text path used to be stored like a real answer, pinning
  // "here is a list of the documents I found" for the whole 7-day TTL.
  const fallback = (): AISummary => ({
    ...buildSafeFallback(query, searchResults, mode, opts.comparison),
    mode,
    ...(opts.comparison ? { comparison: opts.comparison } : {}),
    // The compliance notice survives a degraded answer: it is the one part of
    // the card that is not the model's work (client DO084).
    ...(opts.authorityNotice ? { authorityNotice: opts.authorityNotice } : {}),
    degraded: true,
  });

  // Every model errored — degrade to the standards list instead of vanishing.
  if (text == null) {
    return fallback();
  }

  // Enforce the copyright limits by TRIMMING, not by discarding the answer
  // (DO24). Only an answer that is unusable after trimming falls back.
  // Formulae are removed the same way (client DO072a): the prompt forbids them,
  // and this is what holds when the model writes one anyway — the sentence
  // survives, the mangled equation does not.
  // Order matters: the quote and formula rules act on the whole text, then the
  // opening sentence is judged on what is left (client DO088).
  const sanitized = stripOpeningFluff(stripFormulasFromAnswer(sanitizeQuotes(text))).trim();
  const violations = checkCopyrightViolations(sanitized);
  if (violations.length > 0) {
    console.warn('Copyright violations survived sanitization, using safe fallback:', violations);
    return fallback();
  }
  if (!sanitized) {
    console.warn('AI Guide response was empty after sanitization, using safe fallback');
    return fallback();
  }

  return {
    text: sanitized,
    watermark: 'IES Lensy AI-Generated Summary — Not for reproduction',
    disclaimer: disclaimerFor(mode),
    mode,
    ...(opts.comparison ? { comparison: opts.comparison } : {}),
    ...(opts.authorityNotice ? { authorityNotice: opts.authorityNotice } : {}),
  };
}

/**
 * The disclaimer printed above every AI answer.
 *
 * The closing sentence is the client's (DO51): a reader who can save every other
 * card reasonably assumes they can save this one too, and they cannot — an AI
 * answer is not a citation, so a Saved Search Collection deliberately holds
 * none (src/lib/collections.js). Saying so on the card is cheaper than letting
 * them look for the button.
 */
export const AI_NOT_SAVEABLE = 'This response cannot be saved to your search collections.';

export function disclaimerFor(mode: AIMode): string {
  const lead = mode === 'comparison'
    ? 'AI-generated comparison — unverified. Perform a manual review of both documents before relying on it.'
    : 'This AI-generated response is for informational purposes only and may contain errors. ' +
      'Always refer to the full IES Standards for authoritative guidance.';
  return `${lead} ${AI_NOT_SAVEABLE}`;
}

// ─── Response reading ─────────────────────────────────────────────────────────

/**
 * Pull the generated text out of a Workers AI chat response.
 *
 * Workers AI is not uniform across models: the classic Llama models answer with
 * `{ response: "..." }`, while several newer ones (and the OpenAI-compatible
 * endpoint) answer with `{ choices: [{ message: { content } }] }`, and some wrap
 * the payload in `result`. Reading only `.response` treats a perfectly good
 * answer from those models as an empty one, which sends the AI Guide to its
 * standards-list fallback — indistinguishable, from the outside, from the model
 * being down (client DO24).
 */
export function extractText(response: unknown): string | null {
  if (typeof response === 'string') return response.trim() || null;
  if (!response || typeof response !== 'object') return null;

  const r = response as Record<string, any>;
  const parts = (value: unknown): string | null =>
    Array.isArray(value)
      ? (value.map(p => (typeof p === 'string' ? p : p?.text ?? p?.content ?? '')).join('').trim() || null)
      : null;

  const candidates: unknown[] = [
    r.response,
    r.response?.response,
    r.result?.response,
    r.result?.output_text,
    r.output_text,
    r.choices?.[0]?.message?.content,
    r.choices?.[0]?.delta?.content,
    r.choices?.[0]?.text,
    parts(r.response),
    parts(r.choices?.[0]?.message?.content),
    parts(r.content),
  ];

  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c;
  }
  return null;
}

/** Compact description of an unreadable response, for the diagnostic log line. */
function describeShape(response: unknown): string {
  if (response == null) return String(response);
  if (typeof response !== 'object') return `${typeof response}: ${String(response).slice(0, 120)}`;
  try {
    return `keys=[${Object.keys(response as object).join(',')}] ${JSON.stringify(response).slice(0, 400)}`;
  } catch {
    return `keys=[${Object.keys(response as object).join(',')}]`;
  }
}

/**
 * Remove any formula the model wrote anyway (client DO072a).
 *
 * Line by line, so a paragraph that mentions a formula keeps its sentence:
 * "This formula, ΦLM-84 = …, is used to approximate the luminous flux
 * maintenance" becomes "This formula is used to approximate the luminous flux
 * maintenance" — which is the client's own suggested wording.
 */
/**
 * Filler the first sentence of an answer used to open with (client DO088).
 *
 * "The first sentence in most 'AI Guide' results tend to be 'fluff,' restating
 *  the question without much substantive information. Since the user query
 *  remains visible, let's jump straight to the substantive content."
 *
 * Their two examples — "For a LZ2 roadway, the illuminance target is a crucial
 * aspect of lighting design." and "Luminance plays a crucial role in lighting
 * design as it affects the visibility of objects and scenes." — share a shape:
 * an assertion that the topic matters, carrying no fact and citing nothing. The
 * example they marked GOOD ("Egress lighting refers to the illumination provided
 * to ensure safe evacuation…") is a definition, so it stays.
 */
const OPENING_FLUFF_RE = new RegExp(
  '\\b(?:'
  + 'is (?:a|an) (?:crucial|critical|important|key|essential|significant|vital|fundamental|major) '
  + '(?:aspect|part|element|factor|consideration|component|role)'
  + '|plays? (?:a|an) (?:crucial|critical|important|key|essential|significant|vital) role'
  + '|is (?:a|an) (?:important|key|essential) (?:consideration|topic|subject)'
  + '|are (?:a|an) (?:crucial|critical|important|key) (?:aspect|part|consideration)'
  + '|when it comes to'
  + '|(?:is|are) (?:widely|often) (?:discussed|considered|addressed)'
  + ')\\b',
  'i',
);

/** A sentence that cites something is never fluff, whatever else it says. */
const CITES_SOMETHING_RE = /\b(?:ANSI|BSR|IES)\b|\b(?:RP|LP|LS|LM|TM|DG|HB|LEM|G)-\s*\d|\bSection\s+\d|\bAnnex\s+[A-Z]|\bTable\s+[A-Z0-9]|\bp\.\s*\d/i;

/**
 * Drop a content-free opening sentence (client DO088).
 *
 * Conservative: only the FIRST sentence of the FIRST paragraph, only when it
 * matches the filler shape AND cites nothing, and never when it is the whole
 * answer.
 */
export function stripOpeningFluff(text: string): string {
  const raw = String(text || '');
  if (!raw.trim()) return raw;

  const blocks = raw.split(/\n/);
  const firstIdx = blocks.findIndex(b => b.trim());
  if (firstIdx === -1) return raw;
  const block = blocks[firstIdx];
  // A heading is not a sentence.
  if (/^\s*(?:#{1,4}\s|[-*•]\s|\*\*)/.test(block)) return raw;

  const isFluff = (sentence: string) =>
    OPENING_FLUFF_RE.test(sentence) && !CITES_SOMETHING_RE.test(sentence);

  const m = /^\s*([^.!?]{20,400}[.!?])\s+(\S[\s\S]*)$/.exec(block);
  if (m) {
    const [, firstSentence, rest] = m;
    if (!isFluff(firstSentence)) return raw;
    blocks[firstIdx] = rest;
    return blocks.join('\n');
  }

  // The filler is not always followed by the substance on the SAME line: the
  // model often writes the opener as a short paragraph of its own, and then the
  // block holds nothing after the sentence. That used to fall through to `raw`,
  // because the "never leave the answer empty" guard was implemented as "never
  // remove a whole block" — much broader than intended, and the reason a
  // flagged opening still reached production. Found 2026-08-31.
  const whole = /^\s*([^.!?]{20,400}[.!?])\s*$/.exec(block);
  if (!whole || !isFluff(whole[1])) return raw;

  // The guard, applied as it was meant: something has to survive.
  const rest = blocks.slice(firstIdx + 1);
  if (!rest.some(b => b.trim())) return raw;

  // Drop the paragraph, then the blank line it leaves behind — or the answer
  // would open on whitespace.
  blocks.splice(firstIdx, 1);
  while (firstIdx < blocks.length && !blocks[firstIdx].trim()) blocks.splice(firstIdx, 1);
  return blocks.join('\n');
}

export function stripFormulasFromAnswer(text: string): string {
  if (!text || !hasFormula(text)) return text;
  return text
    .split('\n')
    .map(line => (hasFormula(line) ? stripInlineFormula(line) : line))
    .join('\n');
}

// ─── Prompt building ──────────────────────────────────────────────────────────

function buildPrompt(
  query: string,
  searchResults: SearchResult[],
  mode: AIMode,
  comparison?: ComparisonContext,
  answerStyle: AnswerStyle = 'auto',
  authorityNotice?: string | null,
): string {
  const picked = pickResults(searchResults, mode, comparison);
  const resultsSummary = picked.map((r, idx) => describeResult(r, idx)).join('\n\n');

  const header = `User Query: "${query}"\n\nSearch Results (from IES Standards database):\n${resultsSummary}\n`;
  // Client DO084: the notice is rendered by the UI above the answer, so the
  // model must know it is there — both so it does not repeat it, and so it can
  // rely on it having been said.
  const notice = authorityNotice
    ? `\nA compliance notice is already displayed above your answer, in these words: "${authorityNotice}"\n`
      + 'Do NOT repeat it or paraphrase it. You may refer to coordinating with the AHJ in one short clause if it genuinely bears on the guidance.\n'
    : '';

  if (mode === 'comparison') return header + notice + comparisonInstructions(comparison);
  if (mode === 'references') return header + notice + referencesInstructions();
  return header + notice + guideInstructions(answerStyle);
}

/**
 * Choose which results are described to the model. Deprecated excerpts are
 * appended after current results by the search worker (version-comparison
 * queries only), so a plain slice would cut off exactly the content the
 * comparison needs — reserve slots for both editions.
 *
 * On a comparison, only the TARGET prior edition's excerpts are shown (client
 * DO27: compare against the most recent deprecated edition). Older editions
 * stay in the result cards but never reach the prompt, so the model cannot
 * mistake one of them for the edition that was replaced.
 */
function pickResults(searchResults: SearchResult[], mode: AIMode, comparison?: ComparisonContext): SearchResult[] {
  const budget = PROMPT_RESULTS[mode];
  const current = searchResults.filter(r => !r.isDeprecated);
  let deprecated = searchResults.filter(r => r.isDeprecated);

  const targets = (comparison?.deprecated || []).map(d => d.id.toUpperCase());
  if (mode === 'comparison' && targets.length > 0) {
    const scoped = deprecated.filter(r => targets.includes(String(r.application?.standard || '').toUpperCase()));
    // Never end up with zero prior-edition context: if the target edition
    // produced no excerpts, fall back to whatever prior-edition text we have.
    if (scoped.length > 0) deprecated = scoped;
  }

  if (deprecated.length === 0) return current.slice(0, budget);
  const depShare = Math.min(deprecated.length, Math.max(2, Math.floor(budget / 2)));
  return [...current.slice(0, budget - depShare), ...deprecated.slice(0, depShare)];
}

function describeResult(r: SearchResult, idx: number): string {
  const app = r.application;
  const excerptText = r.excerpt?.text ?? (typeof r.excerpt === 'string' ? r.excerpt : null);

  // Reference entries are bibliography lines, not applications — describe them
  // as the cited work plus where it is listed (DO26.5).
  if (r.resultType === 'reference') {
    return `[Result ${idx + 1}] REFERENCE ENTRY listed in ${app.standardFull || app.standard}${r.excerpt?.pageNumber ? `, p. ${r.excerpt.pageNumber}` : ''}
  Entry: "${(excerptText || '').substring(0, 300)}"`;
  }

  // A whole-document card (client DO47): there is no passage, so describe the
  // document itself from the publisher's own metadata.
  if (r.resultType === 'standard' && r.document) {
    const d = r.document;
    return `[Result ${idx + 1}] STANDARD (whole document): ${d.designation}${d.title ? ` — ${d.title}` : ''}
  ${d.description
    ? `Publisher's description: "${d.description.substring(0, 400)}"`
    : '(no published description on file — do not describe its contents)'}`;
  }

  // LS-1 terminology (client DO33): the definition IS the authority, so it is
  // given verbatim and the model is told not to restate it as its own wording.
  if (r.resultType === 'definition' && r.definition) {
    return `[Result ${idx + 1}] DEFINITION of "${r.definition.term}" from ${app.standardFull || app.standard}${r.definition.clause ? ` §${r.definition.clause}` : ''}
  Definition (authoritative — cite it, do not reword it as your own): "${(excerptText || '').substring(0, 600)}"`;
  }

  const meta: string[] = [];
  if (app.areaOrTask)     meta.push(`Type: ${app.areaOrTask}`);
  if (app.indoorOutdoor)  meta.push(app.indoorOutdoor);
  if (app.veilingRisk)    meta.push(`Veiling Risk: ${app.veilingRisk}`);
  if (app.classOfPlay)    meta.push(`Class of Play: ${app.classOfPlay}`);
  if (app.outdoor?.lightingZone) meta.push(`Lighting Zone: ${app.outdoor.lightingZone}`);
  if (app.tm24Eligible)   meta.push('TM-24 eligible (P–Y)');
  if (r.isDeprecated) {
    meta.push(`DEPRECATED STANDARD${r.supersededBy ? ` — replaced by ${r.supersededBy}` : ''}. ` +
      'Cite ONLY to describe what changed between editions; never as current guidance.');
  }

  // Multiple excerpts per result (DO22) give the model real context to work
  // from instead of a single 220-character window.
  const excerpts = (r.excerpts && r.excerpts.length > 0)
    ? r.excerpts.slice(0, 3)
    : (excerptText
        ? [{
            text: excerptText,
            pageNumber: r.excerpt?.pageNumber ?? null,
            section: r.excerpt?.section ?? null,
            formulaOmitted: r.excerpt?.formulaOmitted,
          }]
        : []);
  // The section TITLE travels with the number (client DO40) so the model can
  // name a chapter the way the standard prints it — the grounding rule only
  // allows locators that appear verbatim here, and a bare "§3.3.4" gave it
  // nothing nameable to cite.
  const locatorOf = (e: { section?: string | null; sectionTitle?: string | null; pageNumber?: number | null }) =>
    `${e.section ? ` §${e.section}${e.sectionTitle ? ` ${e.sectionTitle}` : ''}` : ''}` +
    `${e.pageNumber != null ? ` (p. ${e.pageNumber})` : ''}`;
  const excerptLines = excerpts.length > 0
    ? excerpts.map(e => `  Excerpt${locatorOf(e)}: "${promptExcerpt(e)}"`).join('\n')
    : '  (No excerpt available)';

  // Tables and figures whose caption matches the question (client DO086). The
  // model cannot see their contents — a rasterized table has no text — but it
  // can and should NAME them and send the reader to the page, which is what the
  // client's failing examples needed ("do not cite Table C-1 … on page 62").
  const assetLines = (r.assets && r.assets.length > 0)
    ? '\n' + r.assets.map(a =>
        `  ${a.kind === 'figure' ? 'FIGURE' : 'TABLE'} in this standard: ${a.label} — "${a.caption}" (p. ${a.page}). `
        + 'Cite it by label and page; you cannot see its contents.').join('\n')
    : '';

  return `[Result ${idx + 1}] ${app.fullName || app.category}
  Standard: ${app.standardFull || app.standard}${app.tableRef ? ` (${app.tableRef})` : ''}
  ${meta.join(', ')}
  Citation: ${r.citation}
${excerptLines}${assetLines}`;
}

/**
 * How long, and how many standards (client note, 2026-08-20).
 *
 * "If user asks a question which does not 'fit' the prescribed AI Guide response
 *  format, there can be uncomfortable or rambling responses. Not every search
 *  will demand references to multiple standards. Some users just want a single
 *  specific answer which exists in only one standard; others will ask a question
 *  that can't be answered by our standards. We need an option to adapt."
 *
 * So the length is no longer prescribed. The 'auto' text asks the model to size
 * the answer to the question first, and gives it an explicit licence to answer
 * in one paragraph, to cite one standard, and to say the standards do not cover
 * the topic — the three outcomes the old "aim for 3–5 substantial paragraphs,
 * close with Further reading" shape used to pad around.
 */
function shapeInstruction(style: AnswerStyle): string {
  if (style === 'brief') {
    return `- LENGTH: answer in at most TWO short paragraphs, citing only the standards that directly answer the question. Do not add background the reader did not ask for.`;
  }
  if (style === 'full') {
    return `- LENGTH: 3–5 substantial paragraphs, covering each standard in the results that bears on the question. Stop when the results are exhausted rather than padding.`;
  }
  return `- LENGTH — decide it from the question before you write:
    • A question with ONE specific answer that ONE standard covers gets ONE short paragraph: the answer, the standard, the section, and nothing else. Do not widen it into a survey.
    • A broad question ("what are the considerations for …?") gets 3–5 substantial paragraphs across the standards that apply.
    • A question the standards do not cover gets TWO SENTENCES saying so — see the "cannot answer" rule below. That is a complete answer, not a failure.
- Cite only the standards that bear on the question. Naming a standard because it appeared in the results, rather than because it answers the question, makes the whole answer less trustworthy.`;
}

/**
 * One excerpt as the model sees it, with any equation removed (client DO072a).
 *
 * The model is TOLD a formula is there — that is the difference between "the
 * standard gives a decay formula in Annex B" (useful) and silence — but it never
 * sees the mangled reconstruction, so it cannot echo one back.
 *
 * The search worker has usually removed the equation already (guardFormula) and
 * left `formulaOmitted` behind; the second pass here is what covers a result
 * built by any other path, and a response cached before that existed.
 */
function promptExcerpt(e: { text?: string | null; formulaOmitted?: boolean }): string {
  const raw = String(e.text || '');
  const marker = ' [a formula is printed here — describe it, never reproduce it]';
  if (!hasFormula(raw)) {
    return `${raw.substring(0, 320)}${e.formulaOmitted ? marker : ''}`;
  }
  const stripped = raw
    .split('\n')
    .map(line => (hasFormula(line) ? stripInlineFormula(line) : line))
    .filter(line => line.trim())
    .join(' ')
    .substring(0, 320);
  return `${stripped}${marker}`;
}

function guideInstructions(style: AnswerStyle = 'auto'): string {
  return `
Instructions — write a GUIDE, not a list (client requirement):
- FIRST SENTENCE: answer the question. The reader's question is on screen above
  your answer, so do not restate it, and do not open by asserting that the topic
  matters. "For a LZ2 roadway, the illuminance target is a crucial aspect of
  lighting design" and "Luminance plays a crucial role in lighting design" are
  both forbidden openings: they carry no information. Open with the fact, the
  definition, or the standard that answers it.
${shapeInstruction(style)}
- Explain, standard by standard, WHAT the relevant guidance covers and WHY that section matters. Use the excerpts above as your only source.
- Where the results include illuminance-table rows, explain how to read and apply them (Task vs Area, maintained targets, uniformity/ratio basis, measurement height) and point the user to the result cards for the values themselves.
- Mention ONLY the governing criteria that genuinely apply to THIS application. Do not enumerate the rest: Class of Play belongs to sports venues, lighting zones and curfews to exterior applications, the S/P variance to Categories P–Y. Naming an irrelevant criterion makes the whole answer less trustworthy.
- Every paragraph must add new information. Do not restate in paragraph 3 what paragraph 2 already said, and say "refer to the result cards for the values" once at most.
- "Further reading": add ONE additional IES standard only where it genuinely deepens the answer, with a sentence on what it adds. Omit the heading entirely when it would not — a further-reading line that exists to fill a template is padding.
- Name each standard by its exact designation as printed above (e.g. ANSI/IES RP-2-20+E1) every time you refer to it.
- Never quote more than 15 words from any single source; never repeat a quote from the same source.
- Do NOT state specific lux / footcandle values — refer the user to the result cards and PDF excerpts.
- NEVER write a formula, equation or symbolic expression, even one shown in an excerpt. Say what it computes and where it is printed, and refer the reader to that page.
- Where a TABLE or FIGURE is listed above, NAME it and give its page ("RP-1-24 lists these in Table C-1, p. 62") — that is often the real answer to "where do I find…". Never describe what is inside one you were not shown, and never say a table does not exist merely because it was not listed; say the retrieved passages do not show one.
- IF YOU CANNOT ANSWER: say plainly that the current IES standards in these results do not appear to cover the question, name the closest topic they DO cover if there is one, and point the reader to Standards@ies.org. Do not assemble an answer out of adjacent material.
- A response consisting only of a list of standards is NOT acceptable.

Write the guidance now:`;
}

function comparisonInstructions(comparison?: ComparisonContext): string {
  const current = comparison?.current;
  const deprecated = comparison?.deprecated || [];
  const older = comparison?.alsoDeprecated || [];
  // Every other printing in the results is this same edition reaffirmed (client
  // DO083), so there is genuinely nothing to compare. Saying that IS the answer;
  // asking the model to "identify the most recent deprecated edition" here made
  // it compare a document with itself.
  if (comparison?.reaffirmedOnly && current) {
    return `
This is a VERSION COMPARISON request, and there is NO prior edition to compare against.

${current.name} is the current edition. Every other printing of it in the results
is the SAME edition reaffirmed — a reaffirmation republishes a standard unchanged,
so there are no differences between them.

Write two or three sentences and stop:
- Say plainly that the library holds no earlier edition of this standard to compare, and that a reaffirmed printing is the same document.
- Name ${current.name} once, exactly as written above.
- Suggest the reader open it directly, or contact Standards@ies.org if they believe an earlier edition exists.

Do NOT write the "Extent of the changes", "What appears to be new", "Likely
technical updates" or "Possible deletions" sections: there is nothing to put in
them, and an empty heading reads as a failure. Do not list, describe or infer any
change.

Write those sentences now:`;
  }

  const pair = current && deprecated.length > 0
    ? `The current standard is ${current.name}. Compare it against exactly ONE prior edition: ${deprecated.map(d => d.name).join(', ')}.`
    : 'Identify the current and the most recent deprecated edition from the results above, and compare only those two.';
  // Older editions are in the result cards but must not enter the analysis
  // (client DO27) — naming four prior editions is what produced the DO28 answer
  // that said RP-8-25+E2 replaced RP-8-14.
  const olderNote = older.length > 0
    ? `\nOlder editions (${older.map(d => d.id).join(', ')}) also appear in the results. Do NOT compare against them and do NOT name them as the edition that was replaced.`
    : '';

  return `
This is a VERSION COMPARISON request. ${pair}${olderNote}

Produce a substantive, objective, high-level comparison using EXACTLY these four sections, in this order, each as a heading on its own line:

Extent of the changes
What appears to be new
Likely technical updates
Possible deletions

════════════════════════════════════════════════════════════════
"Extent of the changes" — write this FIRST, and let it set the length
════════════════════════════════════════════════════════════════
Client requirement: before any detail, answer TWO questions in a short
paragraph — HOW EXTENSIVE are the SUBSTANTIVE differences between the two
editions, and WHY MIGHT THAT MATTER to someone applying the standard?

"Substantive" means a significant modification or expansion in the nature and
scope of the content that could affect its application, results, or compliance
with established standards. Renumbering, rewording, new figures and editorial
tidying are NOT substantive.

Classify the extent in your own first sentence using exactly one of these three
words — Extensive, Moderate or Minimal — and then WRITE TO THAT CLASSIFICATION:

  • Extensive — a high-level overview of the new/updated/deleted material,
    organized by chapter. Target 800–1200 words; never exceed ~1500.
  • Moderate — a concise summary of the specific substantive changes, organized
    by chapter. Target 500–1000 words; never exceed ~1200.
  • Minimal — list the substantive changes BY TOPIC. The three sections below
    may then be very short, or say plainly that nothing of that kind appears.
    Target 100–300 words; never exceed ~500.

Judge the extent from the excerpts you were given, and say so when the evidence
is thin: "the retrieved passages suggest the changes are minimal, though they
cover only part of both documents" is a better answer than a confident one.
Do NOT pad a Minimal comparison to look thorough — a short, accurate answer is
the point of this section.

STRUCTURE OF THE OTHER THREE SECTIONS — not "Extent of the changes", which is a
short paragraph (client requirement — follow it exactly):
Group the findings by CHAPTER, as a bulleted list, and nothing else. One bullet
per chapter; the findings for that chapter nested underneath it. Order the
chapters by number, and the findings within a chapter by section number.

- **Chapter 6.0 Community Planning**
  - **6.2 Outdoor Lighting Requirements** (p. 34): mentions the Five Principles for Responsible Outdoor Lighting; not found in the excerpts from the prior edition.
- **Chapter 8.0 Outdoor Lighting Design Process**
  - **8.7.2.4 Color – Hue and Saturation** (p. 61): discusses considerations for lighting design that are not present in the excerpts from the prior edition.

Rules for that structure:
- Every finding BEGINS with its section number, followed by the section TITLE
  when the excerpt gives one, both in bold — "**8.7.2.4 Color – Hue and
  Saturation**" — then a colon and one sentence. A reader scans these like a
  table of contents, so the locator comes first and the prose after it.
- Give the PAGE in brackets after the locator whenever the excerpt names one:
  it is what lets the reader open that page directly.
- The section titles are printed beside the section numbers in the excerpts
  above. Use them verbatim. Where an excerpt gives a number with no title, print
  the number alone — never invent a title.
- Bold the chapter bullet the same way, and name the chapter by its own number
  and title when the excerpts give them. Where no chapter title is given, write
  the number alone ("Chapter 5") — the same rule as for sections. A chapter
  title you supply yourself is a description of the standard's subject matter
  drawn from prior knowledge, which the rule below forbids outright.
- Do not write a prose paragraph inside these three sections. The bulleted,
  chapter-grouped list IS the format.

COMPARE THE CONTENT OF THE TWO EDITIONS. Read the passages from each edition
above, then say what the current edition covers that the prior one does not,
what both cover differently, and what the prior edition covered that no longer
appears. Work from the substance of the passages — a difference in wording,
scope, criteria or procedure — not from the fact that one edition happened to be
retrieved more often.

GROUNDING — the single most important rule:
- Every section number, annex letter, chapter title, table number, figure number and page number you write MUST appear verbatim in the excerpts above. If an excerpt does not give you a locator, describe the change without one. NEVER invent, guess, or pattern-fill a locator, and never write "(or similar)" after one.
- If the passages retrieved from one edition are only packaging — a contributor or committee roster, an errata notice, a copyright page, a table of contents — say plainly that the retrieval did not reach that edition's provisions and recommend opening both documents. NEVER describe a contributor list, an acknowledgement or a table of contents as new, updated or deleted content.
- Use ONLY the excerpts above to determine what these documents are about. Do not draw on any prior knowledge of what this standard covers — designations are easily confused with one another, and describing the wrong subject matter is worse than saying less. If the excerpts do not tell you the topic of a change, do not name a topic.
- If the excerpts do not support a section, write one sentence saying the retrieved passages do not show changes of that kind, and move on. That is a correct answer; a plausible-sounding invented one is not.

Rules for every section:
- Organize by the sections or chapters that the excerpts actually name, so a reader can look each item up. One short bullet per item, with its locator quoted from the excerpt.
- Use hedged, verifiable language: "appears to", "updates appear to include", "is no longer printed". You are inferring from excerpts, not from a diff of the full documents.
- NEVER write a formula, equation or symbolic expression. Say what it computes and where it is printed.
- Base every item on a SUBSTANTIVE provision — recommended values, criteria, procedures, scope. Front matter is not a change: never present an errata notice, a copyright or contact page, a table of contents, or an entry in a reference list as new or updated content.
- Discuss ONLY the two editions being compared. Other standards may appear in the results because they are cited; do not describe their contents as changes to this standard.
- Frame possible deletions as historical context only, never as guidance, and note that the content may have been relocated rather than removed.
- Recommend ONLY the current standard for further reading; the deprecated edition is referenced for comparison alone.
- State plainly that the deprecated edition has been replaced by the current one, naming the edition given above and no other.
- End with one line advising a manual review of both documents to verify the findings.
- Never quote more than 15 words from any single source. Do NOT state specific lux / footcandle values.
- Cite a chapter, a section and a page wherever the excerpts give them, in every
  section — those locators are turned into links to the page itself, so a finding
  without one is a finding the reader cannot check.
- Length is governed by the classification you gave in "Extent of the changes",
  not by how much you could write.

Write the comparison now:`;
}

function referencesInstructions(): string {
  return `
This is a REFERENCES request: the user wants the works that IES standards formally cite on this topic, and the result cards below already list the entries themselves.

Answer these three questions, briefly and in this order (2–4 short paragraphs total):
1. How frequently is this topic referenced across the IES Lighting Library, based on the entries above?
2. What related search terms would narrow or broaden the search usefully? Give 4–8 concrete terms in a single sentence or short list.
3. Which IES Standards most typically reference the items listed below? Name them by their exact designation as printed above.

Rules:
- Do NOT re-list the reference entries themselves — the cards do that.
- Do not invent references, authors, DOIs or counts that are not visible in the results above.
- Name every standard by its exact designation as printed above so it can be hyperlinked.
- Never quote more than 15 words from any single source.

Write the answer now:`;
}

function buildSafeFallback(
  query: string,
  searchResults: SearchResult[],
  mode: AIMode = 'guide',
  comparison?: ComparisonContext,
): AISummary {
  const standardsList = [...new Set(
    searchResults.map(r => r.application?.standardFull || r.application?.standard).filter(Boolean)
  )].map(s => `- ${s}`).join('\n');

  // A degraded COMPARISON still has to say the one thing the client asked for:
  // which edition is deprecated and what replaced it (DO25). The UI renders the
  // hyperlinked advisory from `comparison` above this text.
  if (mode === 'comparison') {
    const current = comparison?.current?.name;
    const deprecated = (comparison?.deprecated || []).map(d => d.name).join(', ');
    const lead = (current && deprecated)
      ? `${deprecated} ${comparison!.deprecated.length > 1 ? 'are' : 'is'} deprecated and ${comparison!.deprecated.length > 1 ? 'have' : 'has'} been replaced by the current ${current}.`
      : 'The current and deprecated editions appear in the results below.';
    return {
      text: `An automated comparison could not be generated for this search. ${lead}\n\n`
        + 'Please perform a manual review of both documents; the excerpts below show the passages retrieved from each edition.\n\n'
        + `Editions referenced:\n${standardsList}`,
      watermark: null,
      disclaimer: `Comparison unavailable — this response lists the editions involved without AI interpretation. ${AI_NOT_SAVEABLE}`,
    };
  }

  return {
    text: `For "${query}", I found relevant IES standards in the results below. Please review the application cards for specific illuminance values and standard references.\n\nRelevant standards:\n${standardsList}`,
    watermark: null,
    disclaimer: `This response lists relevant standards without AI interpretation. Always refer to the full IES Standards. ${AI_NOT_SAVEABLE}`,
  };
}
