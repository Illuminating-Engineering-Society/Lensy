/**
 * Query language: interpret in English, answer in the user's language
 * (client note, 2026-09-01).
 *
 * "Provide the AI Guide response in the same language the query was typed, but
 *  'interpret it in English' for its response (and for the result card
 *  curation) … If it were a person, the workflow would be (1) translate to
 *  English (2) provide response and card curation (3) translate the AI Guide
 *  response back to their native language. Our standards will always remain in
 *  English for accuracy."
 *
 * So the ENTIRE pipeline runs in English — the embedding model
 * (@cf/baai/bge-base-en-v1.5) is English-only, every intent regex
 * (isVersionComparisonQuery, isDefinitionQuery, the AHJ topics, the refusal
 * patterns) is English, and the client measured that citations are best in
 * English — and only the finished AI Guide text is translated back.
 *
 * Three parts:
 *
 *   1. looksNonEnglish() — a free heuristic deciding whether to spend a model
 *      call at all. Almost every query is English; those pay nothing.
 *   2. resolveQueryLanguage() — one small-model call that detects the language
 *      and translates the query to English in the same breath. Fail-open in
 *      every direction: an error, unreadable JSON, or a translation that lost a
 *      standard designation all mean "treat as English", i.e. exactly the
 *      behaviour that shipped before.
 *   3. localizeSummary() — translates the finished AI Guide answer into the
 *      query's language, keeping everything the reader must be able to look up
 *      IN ENGLISH: designations, direct quotes, printed section titles, and the
 *      locator forms the UI hyperlinks ("§8.6.1.4", "p. 42"). The English
 *      original travels along as `textEnglish`, because citation extraction for
 *      card curation (extractGuideCitations) reads English locator phrasing.
 *
 * What is deliberately NOT translated: result cards and excerpts (the standards
 * remain in English — the client's own rule), the disclaimer/watermark and every
 * other fixed UI string, and a degraded fallback answer (it is a bare standards
 * list, not prose, and it is never cached).
 */

import { extractText } from './ai-summary';
import type { AISummary } from '../types';

// Small model first for detection — it is one short JSON object on the critical
// path ahead of retrieval, so latency matters more than nuance.
const DETECT_MODELS = [
  '@cf/meta/llama-3.1-8b-instruct-fp8',
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
];
const DETECT_MAX_TOKENS = 384;

// The answer translation is quality-critical (it is the text the user reads),
// so it uses the Guide's own primary model, with the same fallbacks.
const TRANSLATE_MODELS = [
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  '@cf/meta/llama-4-scout-17b-16e-instruct',
  '@cf/meta/llama-3.1-8b-instruct-fp8',
];
// Ceiling on the translation output. A comparison answer can be ~6000 tokens;
// translations of European languages run ~15–25% longer than the English.
const TRANSLATE_MAX_TOKENS_CAP = 8000;

/** The query's language and its English interpretation. */
export interface QueryLanguage {
  /** ISO 639-1/2 code, lowercased ('es', 'fr', 'de', …; 'en' when English). */
  language: string;
  /** English name of the language, for prompts and display ('Spanish'). */
  languageName: string;
  /** The query as the pipeline should read it — a translation, or the original. */
  english: string;
  /** True only when `english` is a real translation of a non-English query. */
  translated: boolean;
}

export function englishQueryLanguage(query: string): QueryLanguage {
  return { language: 'en', languageName: 'English', english: query, translated: false };
}

// ─── The free heuristic ───────────────────────────────────────────────────────

// Any non-Latin script settles it without a model call being wasted on doubt.
const NON_LATIN_RE = new RegExp(
  '[\\u0370-\\u03FF'   // Greek
  + '\\u0400-\\u04FF'  // Cyrillic
  + '\\u0530-\\u058F'  // Armenian
  + '\\u0590-\\u05FF'  // Hebrew
  + '\\u0600-\\u06FF'  // Arabic
  + '\\u0900-\\u097F'  // Devanagari
  + '\\u0E00-\\u0E7F'  // Thai
  + '\\u1100-\\u11FF'  // Hangul jamo
  + '\\u3040-\\u30FF'  // Hiragana + Katakana
  + '\\u3400-\\u4DBF\\u4E00-\\u9FFF'  // CJK
  + '\\uAC00-\\uD7AF]', // Hangul syllables
);

// Latin letters English does not use. English queries occasionally borrow one
// ("café"), but the cost of a false hit is one small-model call that answers
// "en" — cheap, and fail-open.
const DIACRITIC_RE = /[àâäãåæçèéêëìíîïñòóôöõøùúûüýÿœßāēīōūąćęłńśźżčďěňřšťůž¿¡]/i;

// Standalone function/domain words that are strong non-English signals even in
// plain ASCII ("iluminacion de oficinas" carries no diacritic at all). Every
// entry must NOT be an English word, or an English query would pay a detection
// call on every search. This list settles a query instantly; it is NOT the only
// way a non-English query is caught — see ENGLISH_WORDS below.
const NON_ENGLISH_WORDS = new Set([
  // Spanish
  'que', 'como', 'cual', 'cuales', 'cuanto', 'cuanta', 'donde', 'para', 'debe',
  'iluminacion', 'alumbrado', 'oficina', 'oficinas', 'niveles',
  // Portuguese
  'iluminacao', 'qual', 'quais', 'quanto', 'escritorio', 'onde', 'deve',
  // French ("pour" and "bureau" are English homographs — deliberately absent)
  'quelle', 'quel', 'quelles', 'quels', 'combien', 'eclairage', 'luminosite',
  'niveaux',
  // German
  'wie', 'welche', 'welcher', 'welches', 'beleuchtung', 'helligkeit', 'buero',
  'braucht', 'muss', 'wieviel', 'beleuchtungsstaerke',
  // Italian ("dove" is an English homograph — deliberately absent)
  'quale', 'quali', 'quanta', 'illuminazione', 'ufficio',
  // Dutch
  'hoeveel', 'welke', 'verlichting', 'kantoor',
  // Polish
  'jakie', 'ile', 'oswietlenie', 'biuro',
]);

// The inverse guard (2026-09-04, the client's Swahili test). The three positive
// signals above cannot enumerate every language: Swahili, Indonesian, Tagalog
// and unaccented Turkish are all plain-ASCII Latin script with no entry in
// NON_ENGLISH_WORDS, so "njia bora ya kuwasha mwangaza kwenye ofisi ni ipi?"
// sailed through as "confidently English" and was embedded RAW by the
// English-only embedding model — near-random retrieval (LM-83 for an
// office-lighting question) under an answer that read fine, because the Guide
// model understands Swahili even though the retriever does not. Rather than
// growing the word list one language at a time, recognize ENGLISH: a query of
// two or more words where a third or fewer are recognizably English spends the
// detection call. The cost of a false hit is unchanged — one small-model call
// that answers "en" — so this lexicon only has to cover MOST English queries
// (function words plus the domain's own vocabulary), never all of English.
const ENGLISH_WORDS = new Set([
  // Function and question words.
  'the', 'an', 'of', 'in', 'on', 'at', 'to', 'for', 'from', 'with', 'without',
  'and', 'or', 'nor', 'not', 'no', 'is', 'are', 'am', 'be', 'been', 'was',
  'were', 'do', 'does', 'did', 'have', 'has', 'had', 'can', 'could', 'should',
  'would', 'will', 'shall', 'may', 'might', 'must', 'what', 'whats', 'when',
  'where', 'which', 'who', 'whose', 'how', 'why', 'that', 'this', 'these',
  'those', 'there', 'their', 'they', 'them', 'than', 'then', 'it', 'its', 'as',
  'by', 'per', 'if', 'but', 'so', 'such', 'about', 'above', 'below', 'under',
  'over', 'between', 'through', 'during', 'before', 'after', 'into', 'near',
  'versus', 'vs', 'up', 'down', 'out', 'off', 'all', 'any', 'some', 'most',
  'more', 'less', 'least', 'few', 'many', 'much', 'each', 'every', 'both',
  'other', 'same', 'different', 'only', 'also', 'very', 'too', 'my', 'our',
  'your', 'you', 'we', 'us', 'me', 'use', 'used', 'using', 'get', 'give',
  'show', 'find', 'look', 'see', 'read', 'list', 'explain', 'define', 'tell',
  'mean', 'means', 'meaning', 'example', 'examples',
  // Asking for guidance.
  'need', 'needs', 'needed', 'want', 'require', 'requires', 'required',
  'requirement', 'requirements', 'recommend', 'recommends', 'recommended',
  'recommendation', 'recommendations', 'suggest', 'suggested', 'apply',
  'applies', 'applicable', 'allowed', 'permitted', 'best', 'better', 'good',
  'right', 'correct', 'proper', 'appropriate', 'ideal', 'optimal', 'way',
  'ways', 'method', 'methods', 'guide', 'guidance', 'guidelines', 'rule',
  'rules', 'criteria', 'criterion', 'specification', 'specifications',
  'practice', 'practices', 'procedure', 'procedures', 'standard', 'standards',
  'code', 'codes', 'compliance', 'comply', 'regulation', 'regulations',
  'definition', 'definitions', 'reference', 'references',
  // The domain's own vocabulary.
  'light', 'lights', 'lighting', 'lit', 'bright', 'brightness', 'illuminance',
  'illumination', 'illuminate', 'illuminated', 'luminance', 'luminous',
  'luminaire', 'luminaires', 'lux', 'lumen', 'lumens', 'footcandle',
  'footcandles', 'candela', 'glare', 'ugr', 'cri', 'cct', 'kelvin', 'color',
  'colour', 'colors', 'temperature', 'daylight', 'daylighting', 'sunlight',
  'dim', 'dimming', 'dimmer', 'fixture', 'fixtures', 'lamp', 'lamps', 'bulb',
  'bulbs', 'led', 'leds', 'fluorescent', 'incandescent', 'halogen', 'hid',
  'ballast', 'photometric', 'photometry', 'photopic', 'scotopic', 'mesopic',
  'uniformity', 'ratio', 'ratios', 'contrast', 'reflectance', 'reflections',
  'flicker', 'watt', 'watts', 'wattage', 'power', 'energy', 'efficiency',
  'efficient', 'efficacy', 'control', 'controls', 'sensor', 'sensors',
  'occupancy', 'vacancy', 'switch', 'switches', 'emergency', 'egress', 'exit',
  'task', 'ambient', 'accent', 'vertical', 'horizontal', 'mounting', 'mounted',
  'mount', 'height', 'spacing', 'layout', 'pole', 'poles', 'beam', 'angle',
  'distribution', 'optics', 'lens', 'shielding', 'cutoff', 'uplight',
  'downlight', 'troffer', 'pendant', 'recessed', 'retrofit',
  // Applications and places.
  'office', 'offices', 'workplace', 'workspace', 'desk', 'computer', 'screen',
  'classroom', 'classrooms', 'school', 'schools', 'education', 'educational',
  'university', 'college', 'hospital', 'healthcare', 'patient', 'clinic',
  'laboratory', 'lab', 'parking', 'garage', 'lot', 'roadway', 'road', 'roads',
  'street', 'streets', 'highway', 'intersection', 'crosswalk', 'tunnel',
  'bridge', 'sports', 'sport', 'field', 'fields', 'court', 'courts', 'rink',
  'pool', 'pools', 'stadium', 'arena', 'gym', 'gymnasium', 'track', 'golf',
  'tennis', 'baseball', 'football', 'soccer', 'basketball', 'skating',
  'museum', 'gallery', 'retail', 'store', 'stores', 'shop', 'mall',
  'warehouse', 'industrial', 'factory', 'manufacturing', 'plant',
  'residential', 'home', 'house', 'apartment', 'hotel', 'hospitality',
  'restaurant', 'dining', 'kitchen', 'bathroom', 'bedroom', 'hallway',
  'corridor', 'stairs', 'stair', 'stairwell', 'lobby', 'entrance', 'entry',
  'exterior', 'interior', 'outdoor', 'outdoors', 'indoor', 'indoors', 'area',
  'areas', 'room', 'rooms', 'space', 'spaces', 'building', 'buildings',
  'facility', 'facilities', 'site', 'sites', 'zone', 'zones', 'security',
  'safety', 'pedestrian', 'pedestrians', 'bicycle', 'bike', 'walkway',
  'sidewalk', 'path', 'pathway', 'sign', 'signs', 'signage', 'landscape',
  'garden', 'facade', 'canopy', 'church', 'worship', 'theater', 'theatre',
  'auditorium', 'library', 'airport', 'station', 'natatorium', 'meeting',
  // Version-comparison and lookup phrasing.
  'new', 'newest', 'current', 'latest', 'old', 'older', 'previous', 'version',
  'versions', 'edition', 'editions', 'changed', 'change', 'changes',
  'difference', 'differences', 'compare', 'comparison', 'added', 'removed',
  'revised', 'update', 'updated', 'level', 'levels', 'value', 'values',
  'minimum', 'maximum', 'min', 'max', 'average', 'target', 'range', 'table',
  'tables', 'chart', 'figure', 'figures', 'section', 'sections', 'chapter',
  'annex', 'appendix', 'page', 'pages', 'ies', 'ansi', 'open', 'plan', 'high',
  'low', 'night', 'day', 'time', 'general', 'design',
]);

/**
 * Should this query spend a detection call at all?
 *
 * False means "confidently English": the pipeline runs exactly as before, with
 * zero added latency. A miss in either direction is safe — a non-English query
 * read as English gets today's behaviour, and an English query read as foreign
 * gets one small-model call that answers "en".
 *
 * Four signals, cheapest first: a non-Latin script, a Latin diacritic, or a
 * known non-English word each settle it as non-English outright; failing those,
 * a query of 2+ words where a third or fewer read as English words is worth a
 * detection call — that is what catches plain-ASCII languages the word list
 * does not know (Swahili, Indonesian, Tagalog). A single-word query with no
 * other signal stays English: it is usually a technical term or a name, and a
 * lone word gives the detector nothing to judge a language by.
 */
export function looksNonEnglish(query: string): boolean {
  const q = String(query || '');
  if (!q.trim()) return false;
  if (NON_LATIN_RE.test(q)) return true;
  if (DIACRITIC_RE.test(q)) return true;
  const words = (q.toLowerCase().match(/[a-z]+/g) || []).filter(w => w.length >= 2);
  if (words.some(w => NON_ENGLISH_WORDS.has(w))) return true;
  if (words.length < 2) return false;
  const recognized = words.reduce((n, w) => n + (ENGLISH_WORDS.has(w) ? 1 : 0), 0);
  return recognized * 3 <= words.length;
}

// ─── Detection + query translation (one call) ─────────────────────────────────

/** Designations must survive any translation — they are what retrieval and the
 *  whole-document lookup anchor on, and they are language-neutral by nature. */
const DESIGNATION_RE = /\b(?:ANSI\/IES\s+)?(?:RP|LP|LS|LM|TM|DG|HB|LEM|G|WP)-\d+(?:-\d+)?(?:\+E\d+)?(?:R\d+)?\b/gi;

function designationsOf(text: string): string[] {
  return (String(text || '').match(DESIGNATION_RE) || []).map(d => d.toUpperCase());
}

/** Every designation in `source` must appear in `translated` (case-insensitive). */
export function keepsDesignations(source: string, translated: string): boolean {
  const have = String(translated || '').toUpperCase();
  return designationsOf(source).every(d => have.includes(d));
}

export function buildDetectPrompt(query: string): string {
  return `A user typed this search query into an English-language lighting-standards library:

"${query}"

Identify the language it is written in, then translate it into English so the library can be searched. Keep technical lighting terms precise. Keep standard designations (like "RP-8-25" or "ANSI/IES LM-79") EXACTLY as written. Keep all numbers and units unchanged.

Respond with ONLY this JSON and nothing else:
{"language": "<ISO 639-1 code>", "languageName": "<English name of the language>", "english": "<the English translation>"}

If the query is already in English, answer with "language": "en" and the query unchanged.`;
}

/**
 * Read the detection JSON. Returns null (→ treat as English) for anything that
 * cannot be trusted on screen or in the pipeline: unreadable JSON, a bad code,
 * an empty translation, or a translation that dropped a designation.
 */
export function parseDetectResponse(text: string | null | undefined, query: string): QueryLanguage | null {
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

  const language = String(parsed.language || '').trim().toLowerCase();
  if (!/^[a-z]{2,3}$/.test(language)) return null;
  if (language === 'en' || language === 'eng') return englishQueryLanguage(query);

  const english = String(parsed.english || '').trim().replace(/\s+/g, ' ').substring(0, 500);
  if (!english) return null;
  // A "translation" that is byte-identical to a query our heuristic flagged is
  // the model punting; treat it as English rather than paying to translate the
  // answer into a language we never confirmed.
  if (english === String(query || '').trim()) return null;
  if (!keepsDesignations(query, english)) return null;

  const rawName = String(parsed.languageName || '').trim();
  const languageName = /^[A-Za-z][A-Za-z ()'-]{1,39}$/.test(rawName) ? rawName : language;

  return { language, languageName, english, translated: true };
}

/**
 * The query's language and its English interpretation — the pipeline's very
 * first step on a cache miss. Never throws; anything short of a clean, complete
 * detection means English.
 */
export async function resolveQueryLanguage(ai: Ai, query: string): Promise<QueryLanguage> {
  if (!looksNonEnglish(query)) return englishQueryLanguage(query);

  const prompt = buildDetectPrompt(query);
  // Receiver-bound call — a detached `ai.run` throws for every model
  // (the DO9 root cause in ai-summary.ts).
  const run = (model: string, opts: unknown): Promise<unknown> =>
    (ai.run as unknown as (m: string, o: unknown) => Promise<unknown>).call(ai, model, opts);

  for (const model of DETECT_MODELS) {
    try {
      const response = await run(model, {
        max_tokens: DETECT_MAX_TOKENS,
        messages: [{ role: 'user', content: prompt }],
      });
      const parsed = parseDetectResponse(extractText(response), query);
      if (parsed) return parsed;
    } catch (err) {
      console.error(`language detection model ${model} failed:`, err instanceof Error ? err.message : String(err));
    }
  }
  return englishQueryLanguage(query);
}

// ─── Answer translation ───────────────────────────────────────────────────────

export function buildTranslatePrompt(text: string, languageName: string): string {
  return `Translate the answer below from an IES lighting-standards assistant into ${languageName}. The reader asked their question in ${languageName}, but the standards themselves are published in English — everything a reader must look up in the English documents stays in English.

RULES — follow every one:
1. Translate the prose faithfully. Do not add, summarize, shorten, or comment.
2. Keep EXACTLY as written, untranslated: standard designations (e.g. "ANSI/IES RP-8-25+E2", "LM-63-19R25"), anything inside double quotes, section and chapter titles quoted from a standard, table/figure labels ("Table C-1", "Annex B"), URLs, and email addresses.
3. Write every section reference as "§" followed by the number — "Section 8.6.1.4" becomes "§8.6.1.4" — and every page reference as "p. " followed by the number — "page 42" becomes "p. 42". Use these exact forms; never translate the words "Section" or "page" into ${languageName}.
4. Preserve the markdown structure line for line: **bold** markers, "-" bullets and their indentation, blank lines between paragraphs.
5. A line that is exactly one of these headings — "Extent of the changes", "What appears to be new", "Likely technical updates", "Possible deletions" — is translated and prefixed with "### ". A line beginning "Further reading:" keeps that one-line shape with the translated label in bold: "**<translated label>:** …".
6. Output ONLY the translation. No preamble, no notes, no English copy.

ANSWER TO TRANSLATE:
${text}`;
}

/**
 * Sanity checks on a translated answer. A translation that fails any of them is
 * discarded and the English answer ships — accuracy over completeness, the same
 * rule the client set for formulae and locators.
 */
export function isPlausibleTranslation(source: string, translated: string | null | undefined): boolean {
  const out = String(translated || '').trim();
  if (!out) return false;
  // A refusal, a summary, or a truncation — not a translation.
  if (out.length < source.length * 0.4) return false;
  if (out.length > source.length * 4) return false;
  // Every designation the English answer cites must still be citable.
  if (!keepsDesignations(source, out)) return false;
  return true;
}

async function translateText(ai: Ai, text: string, languageName: string): Promise<string | null> {
  const prompt = buildTranslatePrompt(text, languageName);
  const maxTokens = Math.min(TRANSLATE_MAX_TOKENS_CAP, Math.ceil(text.length / 3) + 400);
  const run = (model: string, opts: unknown): Promise<unknown> =>
    (ai.run as unknown as (m: string, o: unknown) => Promise<unknown>).call(ai, model, opts);

  for (const model of TRANSLATE_MODELS) {
    try {
      const response = await run(model, {
        max_tokens: maxTokens,
        messages: [{ role: 'user', content: prompt }],
      });
      const out = extractText(response);
      if (isPlausibleTranslation(text, out)) return String(out).trim();
      console.warn(`answer translation model ${model} returned an implausible translation — trying next model.`);
    } catch (err) {
      console.error(`answer translation model ${model} failed:`, err instanceof Error ? err.message : String(err));
    }
  }
  return null;
}

/**
 * The AI Guide's answer in the user's own language.
 *
 * The English text moves to `textEnglish` (curation's citation extraction and
 * any later audit read English), the translation becomes `text`, and `language`
 * records that the swap happened — its ABSENCE after a requested translation is
 * what tells handleSearch not to cache the payload, so a transient translation
 * failure is retried instead of pinning an English answer under a non-English
 * key for the TTL.
 *
 * No-ops, returning the summary untouched: an English query, a null summary,
 * and a degraded one (its fallback text is a bare standards list that is never
 * cached — spending a translation on it would double the cost of an outage).
 */
export async function localizeSummary(ai: Ai, summary: AISummary | null, lang: QueryLanguage): Promise<AISummary | null> {
  if (!summary || !lang.translated || summary.degraded) return summary;
  if (!summary.text || !summary.text.trim()) return summary;

  const translated = await translateText(ai, summary.text, lang.languageName);
  if (!translated) return summary;

  return {
    ...summary,
    text: translated,
    textEnglish: summary.text,
    language: lang.language,
  };
}
