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
import type { AIMode, AISummary, ComparisonContext, SearchResult } from '../types';

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
const MAX_TOKENS: Record<AIMode, number> = {
  guide: 3000,
  comparison: 4000,
  references: 2500,
};

// How many results are described to the model. Comparisons need room for both
// editions; references mode is a listing, so it gets the widest window.
const PROMPT_RESULTS: Record<AIMode, number> = {
  guide: 8,
  comparison: 10,
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
  const userPrompt = buildPrompt(query, searchResults, mode, opts.comparison);

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
        max_tokens: MAX_TOKENS[mode],
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
    degraded: true,
  });

  // Every model errored — degrade to the standards list instead of vanishing.
  if (text == null) {
    return fallback();
  }

  // Enforce the copyright limits by TRIMMING, not by discarding the answer
  // (DO24). Only an answer that is unusable after trimming falls back.
  const sanitized = sanitizeQuotes(text).trim();
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
    disclaimer: mode === 'comparison'
      ? 'AI-generated comparison — unverified. Perform a manual review of both documents before relying on it.'
      : 'This AI-generated response is for informational purposes only and may contain errors. Always refer to the full IES Standards for authoritative guidance.',
    mode,
    ...(opts.comparison ? { comparison: opts.comparison } : {}),
  };
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

// ─── Prompt building ──────────────────────────────────────────────────────────

function buildPrompt(query: string, searchResults: SearchResult[], mode: AIMode, comparison?: ComparisonContext): string {
  const picked = pickResults(searchResults, mode);
  const resultsSummary = picked.map((r, idx) => describeResult(r, idx)).join('\n\n');

  const header = `User Query: "${query}"\n\nSearch Results (from IES Standards database):\n${resultsSummary}\n`;

  if (mode === 'comparison') return header + comparisonInstructions(comparison);
  if (mode === 'references') return header + referencesInstructions();
  return header + guideInstructions();
}

/**
 * Choose which results are described to the model. Deprecated excerpts are
 * appended after current results by the search worker (version-comparison
 * queries only), so a plain slice would cut off exactly the content the
 * comparison needs — reserve slots for both editions.
 */
function pickResults(searchResults: SearchResult[], mode: AIMode): SearchResult[] {
  const budget = PROMPT_RESULTS[mode];
  const current = searchResults.filter(r => !r.isDeprecated);
  const deprecated = searchResults.filter(r => r.isDeprecated);
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
    : (excerptText ? [{ text: excerptText, pageNumber: r.excerpt?.pageNumber ?? null, section: r.excerpt?.section ?? null }] : []);
  const excerptLines = excerpts.length > 0
    ? excerpts.map(e => `  Excerpt${e.section ? ` §${e.section}` : ''}${e.pageNumber != null ? ` (p. ${e.pageNumber})` : ''}: "${(e.text || '').substring(0, 320)}"`).join('\n')
    : '  (No excerpt available)';

  return `[Result ${idx + 1}] ${app.fullName || app.category}
  Standard: ${app.standardFull || app.standard}${app.tableRef ? ` (${app.tableRef})` : ''}
  ${meta.join(', ')}
  Citation: ${r.citation}
${excerptLines}`;
}

function guideInstructions(): string {
  return `
Instructions — write a GUIDE, not a list (client requirement):
- Open with 1–2 paragraphs that answer the question directly and orient the reader on how the IES standards treat this application or topic.
- Then explain, standard by standard, WHAT the relevant guidance covers and WHY that section matters. Use the excerpts above as your only source.
- Where the results include illuminance-table rows, explain how to read and apply them (Task vs Area, maintained targets, uniformity/ratio basis, measurement height) and point the user to the result cards for the values themselves.
- Mention the governing criteria that apply here (±10% design tolerance, doubling for occupants over 65, S/P TM-24 variance, veiling reflection risk, Class of Play, lighting zone / curfew) whenever relevant.
- Close with "Further reading": at least one additional IES standard, with a sentence on what it adds.
- Name each standard by its exact designation as printed above (e.g. ANSI/IES RP-2-20+E1) every time you refer to it.
- Never quote more than 15 words from any single source; never repeat a quote from the same source.
- Do NOT state specific lux / footcandle values — refer the user to the result cards and PDF excerpts.
- If the results genuinely do not answer the question, say so plainly and suggest contacting Standards@ies.org.
- A response consisting only of a list of standards is NOT acceptable.

Write the guidance now:`;
}

function comparisonInstructions(comparison?: ComparisonContext): string {
  const current = comparison?.current;
  const deprecated = comparison?.deprecated || [];
  const pair = current && deprecated.length > 0
    ? `The current standard is ${current.name}. The deprecated edition(s) being compared: ${deprecated.map(d => d.name).join(', ')}.`
    : 'Identify the current and deprecated editions from the results above.';

  return `
This is a VERSION COMPARISON request. ${pair}

Produce a substantive, objective, high-level comparison using EXACTLY these three sections, in this order, each as a heading on its own line:

What appears to be new
Likely technical updates
Possible deletions

Rules for every section:
- Break the analysis up BY SECTION or chapter of the standard (e.g. "Chapter 17: Parking Lots and Parking Garages", "Annex H", "Section 11.3.1") so a reader can look each item up. One short bullet per item, with the section/page reference.
- Use hedged, verifiable language: "appears to", "updates appear to include", "is no longer printed". You are inferring from excerpts, not from a diff of the full documents.
- Frame possible deletions as historical context only, never as guidance, and note that the content may have been relocated rather than removed.
- Recommend ONLY the current standard for further reading; the deprecated edition is referenced for comparison alone.
- State plainly that the deprecated edition has been replaced by the current one.
- End with one line advising a manual review of both documents to verify the findings.
- Never quote more than 15 words from any single source. Do NOT state specific lux / footcandle values.
- The response may be long — completeness matters more than brevity here.

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
      disclaimer: 'Comparison unavailable — this response lists the editions involved without AI interpretation.',
    };
  }

  return {
    text: `For "${query}", I found relevant IES standards in the results below. Please review the application cards for specific illuminance values and standard references.\n\nRelevant standards:\n${standardsList}`,
    watermark: null,
    disclaimer: 'This response lists relevant standards without AI interpretation. Always refer to the full IES Standards.',
  };
}
