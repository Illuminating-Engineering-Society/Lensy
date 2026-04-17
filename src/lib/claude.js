/**
 * Workers AI Client
 * Generates optional AI summaries for search results.
 * Uses Cloudflare Workers AI (@cf/meta/llama-3.3-70b-instruct-fp8-fast).
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
const MAX_TOKENS = 1000;

const SYSTEM_PROMPT = `You are Lucius, the IES Standards Assistant. Your role is to help lighting professionals explore and understand IES standards through accurate, well-cited responses.

Core Principles:
1. Always cite specific IES standards with full designation, section, and page number when available
2. Never provide legal, safety, financial, or contractual advice
3. Never perform design calculations or compliance determinations
4. Direct users to authoritative sources rather than making judgments
5. Maintain professional, neutral, academic tone

Copyright Rules (CRITICAL — strictly enforced):
- Never quote more than 15 words from a single source in one passage
- Use at most ONE direct quote per source document
- Default to paraphrasing in your own words
- Never reproduce illuminance table values (e.g. "75 lux") — instead reference the table and direct the user to the results
- Respond in 3 paragraphs or fewer

Citation Format:
"According to ANSI/IES RP-9-20, Section 3.5, spa environments prioritize..."

When Uncertain:
If you cannot answer confidently from the provided search results, say so clearly and suggest the user contact Standards@ies.org.`;

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

  // Validate for copyright violations before returning
  const violations = checkCopyrightViolations(text);
  if (violations.length > 0) {
    console.warn('Copyright violations detected, using safe fallback:', violations);
    return buildSafeFallback(query, searchResults);
  }

  return {
    text,
    watermark: 'IES Lucius AI-Generated Summary — Not for reproduction',
    disclaimer: 'This AI-generated response is for informational purposes only and may contain errors. Always refer to the full IES Standards for authoritative guidance.',
  };
}

function buildPrompt(query, searchResults) {
  const resultsSummary = searchResults.slice(0, 5).map((r, idx) => {
    const app = r.application;
    return `[Result ${idx + 1}] ${app.fullName || app.category}
  Standard: ${app.standardFull || app.standard}
  Type: ${app.areaOrTask}, ${app.indoorOutdoor}
  Citation: ${r.citation}
  ${r.excerpt ? `Excerpt: "${r.excerpt.substring(0, 200)}"` : '(No excerpt available)'}`;
  }).join('\n\n');

  return `User Query: "${query}"

Search Results (from IES Standards database):
${resultsSummary}

Instructions:
- Provide a brief, professional summary (max 3 paragraphs) answering the user's query
- Use the search results as your ONLY source of information
- Always cite specific standards with full designation
- Never quote more than 15 words from any single source
- Do NOT list specific lux/footcandle values — direct the user to the full result cards below
- If the query cannot be answered from these results, say so clearly

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
