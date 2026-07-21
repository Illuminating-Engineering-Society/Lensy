/**
 * AI Summary Client
 * Generates optional AI summaries for search results using Cloudflare Workers AI.
 *
 * Copyright Rules (CRITICAL — enforced here):
 *   - Never quote more than 15 words from a single source
 *   - Use at most ONE quote per source
 *   - Default to paraphrasing
 *   - Never transcribe illuminance table values directly
 *   - Max 3 paragraphs per response
 */

import { checkCopyrightViolations } from './citations.js';

const MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
// Doubled from 1000 (client feedback: AI Guide answers read as length-capped).
// The paragraph guidance below was relaxed in step so the budget is usable.
const MAX_TOKENS = 2000;

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
- Respond in 6 paragraphs or fewer.

═══════════════════════════════════════════════════════════════
DEPRECATED STANDARDS POLICY
═══════════════════════════════════════════════════════════════
- Refer to outdated IES Standards as "deprecated".
- Only cite the CURRENT (latest revision) standard for guidance.
- Exception: when the user explicitly asks "what's new" / "what changed" / "what's different":
  - Show ADDED items (with citations to the current standard)
  - Show REVISED items (with citations to current and deprecated)
  - Only show REMOVED items if the user explicitly opts in
  - NEVER present removed content as guidance — it is historical context only.

═══════════════════════════════════════════════════════════════
HANDLING UNCERTAINTY
═══════════════════════════════════════════════════════════════
If you cannot confidently answer from the provided search results:
1. Say so clearly — do not guess.
2. Direct the user to Standards@ies.org for authoritative assistance.
3. If the application is not covered, mention reviewing the monthly IES Ignite Newsletter for upcoming public reviews and publications, and offer recommendations for similar applications that ARE covered.`;

/**
 * Generate an AI summary for search results.
 * @param {object} ai - Cloudflare Workers AI binding (env.AI)
 * @param {string} query - User's original search query
 * @param {Array} searchResults - Formatted search results
 * @returns {Promise<{text: string, watermark: string, disclaimer: string}>}
 */
export async function generateResponse(ai, query, searchResults) {
  const userPrompt = buildPrompt(query, searchResults);

  const response = await ai.run(MODEL, {
    max_tokens: MAX_TOKENS,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
  });

  const text = response.response;

  const violations = checkCopyrightViolations(text);
  if (violations.length > 0) {
    console.warn('Copyright violations detected, using safe fallback:', violations);
    return buildSafeFallback(query, searchResults);
  }

  return {
    text,
    watermark: 'IES Lensy AI-Generated Summary — Not for reproduction',
    disclaimer: 'This AI-generated response is for informational purposes only and may contain errors. Always refer to the full IES Standards for authoritative guidance.',
  };
}

function buildPrompt(query, searchResults) {
  // Deprecated excerpts are appended after current results by the search
  // worker (version-comparison queries only). Reserve prompt slots for them —
  // a plain slice(0, 5) would cut off exactly the content the comparison
  // needs.
  const current = searchResults.filter(r => !r.isDeprecated);
  const deprecated = searchResults.filter(r => r.isDeprecated);
  const picked = deprecated.length > 0
    ? [...current.slice(0, 3), ...deprecated.slice(0, 2)]
    : current.slice(0, 5);

  const resultsSummary = picked.map((r, idx) => {
    const app = r.application;
    const excerptText = r.excerpt?.text ?? (typeof r.excerpt === 'string' ? r.excerpt : null);
    const meta = [];
    if (app.areaOrTask)     meta.push(`Type: ${app.areaOrTask}`);
    if (app.indoorOutdoor)  meta.push(app.indoorOutdoor);
    if (app.veilingRisk)    meta.push(`Veiling Risk: ${app.veilingRisk}`);
    if (app.classOfPlay)    meta.push(`Class of Play: ${app.classOfPlay}`);
    if (app.tm24Eligible)   meta.push('TM-24 eligible (P–Y)');
    if (r.isDeprecated) {
      meta.push(`DEPRECATED STANDARD${r.supersededBy ? ` — replaced by ${r.supersededBy}` : ''}. ` +
        'Cite ONLY to describe what changed between editions; never as current guidance.');
    }
    return `[Result ${idx + 1}] ${app.fullName || app.category}
  Standard: ${app.standardFull || app.standard}${app.tableRef ? ` (${app.tableRef})` : ''}
  ${meta.join(', ')}
  Citation: ${r.citation}
  ${excerptText ? `Excerpt: "${excerptText.substring(0, 220)}"` : '(No excerpt available)'}`;
  }).join('\n\n');

  return `User Query: "${query}"

Search Results (from IES Standards database):
${resultsSummary}

Instructions:
- Provide a professional, well-developed summary (up to 6 paragraphs) answering the user's query — thorough, but never padded beyond what the results support.
- Use the search results above as your ONLY source of information.
- Always cite specific standards with full designation, section, and page when available.
- Never quote more than 15 words from any single source; never repeat a quote from the same source.
- Do NOT list specific lux / footcandle values — refer the user to the result cards and PDF excerpts.
- When relevant, mention the governing criteria (±10% tolerance, age-65 doubling, S/P TM-24 variance, T vs A, Class of Play meaning, Veiling Risk).
- Recommend at least one additional IES Standard for further reading when it would deepen understanding (non-redundant).
- If the query cannot be answered from these results, say so clearly and suggest contacting Standards@ies.org.

Generate a concise, cited response:`;
}

function buildSafeFallback(query, searchResults) {
  const standardsList = [...new Set(
    searchResults.map(r => r.application?.standardFull || r.application?.standard).filter(Boolean)
  )].map(s => `- ${s}`).join('\n');

  return {
    text: `For "${query}", I found relevant IES standards in the results below. Please review the application cards for specific illuminance values and standard references.\n\nRelevant standards:\n${standardsList}`,
    watermark: null,
    disclaimer: 'This response lists relevant standards without AI interpretation. Always refer to the full IES Standards.',
  };
}
