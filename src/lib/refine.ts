/**
 * The "Refine your search?" follow-up (client wireframes, 2026-08-20).
 *
 * "Can the prompt be AI-generated? Instruction like: 'In 10 words or less,
 *  prompt the user for the most effective follow-up information to narrow down
 *  search results to achieve high-confidence matches'" … "Let's keep this to
 *  'keywords', 'lighting applications' or 'topics' and not display document
 *  designations (many users do not have these memorized). Should be coordinated
 *  with the nature of the follow-up question."
 *
 * So the question and the clickable terms are generated TOGETHER, by one small
 * model call, and the terms are vocabulary a lighting professional would
 * recognize — never designations, which is what the result set's own metadata
 * produced (an excerpt card's `application.category` IS the designation).
 *
 * Only generated for a low-confidence search, and run in parallel with the AI
 * Guide so it costs no wall-clock time. Fail-open in every direction: a model
 * that errors or answers with prose yields null, and the UI falls back to a
 * generic question with no chips.
 */

import { extractText } from './ai-summary';
import type { SearchResult } from '../types';

/** Results described to the model — enough to see the topical spread. */
const REFINE_CONTEXT_RESULTS = 12;
const REFINE_MAX_TOKENS = 256;
/** The client's cap, enforced after generation as well as asked for in the prompt. */
export const REFINE_QUESTION_MAX_WORDS = 10;
export const REFINE_TERMS_MAX = 6;

// Small model first: this is a one-line question plus a handful of words, and
// it must never delay the Guide it runs alongside.
const REFINE_MODELS = [
  '@cf/meta/llama-3.1-8b-instruct-fp8',
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
];

/** Anything shaped like a standard designation — never offered as a term. */
const DESIGNATION_RE = /\b(?:ANSI|BSR|IES)?[\s/]*(?:RP|LP|LS|LM|TM|DG|HB|LEM|G|WP)-\s*\d/i;

export function buildRefinePrompt(query: string, results: SearchResult[]): string {
  const topics = [...new Set(
    results.slice(0, REFINE_CONTEXT_RESULTS)
      .map(r => r.application?.category || r.excerpt?.sectionTitle || '')
      .filter(t => t && !DESIGNATION_RE.test(t))
  )].slice(0, 10);

  return `A lighting professional searched the IES standards library for: "${query}"

The search returned a wide, low-confidence range of results${topics.length ? `, touching on: ${topics.join(', ')}` : ''}.

In ${REFINE_QUESTION_MAX_WORDS} words or less, ask the user for the single most effective piece of follow-up information that would narrow these results to high-confidence matches. Then suggest up to ${REFINE_TERMS_MAX} concrete answers to your own question.

Rules for the suggested answers:
- They must be keywords, lighting applications, or topics — the words a designer would use.
- NEVER a standard designation (no "RP-8-25", no "ANSI/IES ..."): users do not have those memorized.
- They must be plausible answers to the question you asked, not a summary of the results.

Respond with ONLY this JSON and nothing else:
{"question": "...", "terms": ["...", "..."]}`;
}

export interface RefinePrompt {
  /** The follow-up question, ≤ REFINE_QUESTION_MAX_WORDS words. */
  question: string;
  /** Clickable suggestion terms — keywords/applications/topics, never designations. */
  terms: string[];
}

/**
 * Read the model's JSON. Rejects anything that would put the wrong thing on
 * screen: a missing question, an over-long one, or terms that are designations.
 */
export function parseRefineResponse(text: string | null | undefined): RefinePrompt | null {
  if (!text) return null;
  const match = /\{[\s\S]*\}/.exec(text);
  if (!match) return null;
  let parsed: any;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;

  const question = String(parsed.question || '').trim().replace(/\s+/g, ' ');
  if (!question) return null;
  // The client asked for ≤10 words; a model that ignores that is not put on
  // screen — a long question defeats the point of a single brief follow-up.
  if (question.split(' ').length > REFINE_QUESTION_MAX_WORDS + 2) return null;

  const terms = (Array.isArray(parsed.terms) ? parsed.terms : [])
    .map((t: unknown) => String(t || '').trim())
    .filter((t: string) => t && t.length <= 40 && !DESIGNATION_RE.test(t))
    .slice(0, REFINE_TERMS_MAX);

  return { question, terms };
}

/**
 * Generate the follow-up question and its suggestion terms. Never throws;
 * returns null when nothing usable came back.
 */
export async function generateRefinePrompt(
  ai: Ai,
  query: string,
  results: SearchResult[],
): Promise<RefinePrompt | null> {
  if (!results.length) return null;
  const prompt = buildRefinePrompt(query, results);

  // Receiver-bound call — a detached `ai.run` throws for every model
  // (the DO9 root cause in ai-summary.ts).
  const run = (model: string, opts: unknown): Promise<unknown> =>
    (ai.run as unknown as (m: string, o: unknown) => Promise<unknown>).call(ai, model, opts);

  for (const model of REFINE_MODELS) {
    try {
      const response = await run(model, {
        max_tokens: REFINE_MAX_TOKENS,
        messages: [{ role: 'user', content: prompt }],
      });
      const parsed = parseRefineResponse(extractText(response));
      if (parsed) return parsed;
    } catch (err) {
      console.error(`refine prompt model ${model} failed:`, err instanceof Error ? err.message : String(err));
    }
  }
  return null;
}
