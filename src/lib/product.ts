/**
 * What IES Lens IS, in the client's own marketing language (client 9/30/26 DO#3:
 * "Train Lens on its new name and harmonize with marketing language … if asked
 * 'what are you?' it should respond like 'This is IES Lens…' … Train it on the
 * following marketing language & product definitions: 260930_LL+Lens_Definitions").
 *
 * The source is `pdfs/Others/Lens definitions.pdf` ("Version 1 for review: IES
 * Assets & Definitions"). Kept here, in one place, because three consumers read
 * it: the AI Guide's system prompt (so the model describes the product the way
 * marketing does), the canned answer to a question ABOUT the product (which no
 * standard can answer, so retrieval would only produce noise), and the tests.
 *
 * Also the one support destination (client 9/30/26 DO#4: "Remove all language
 * similar to 'contact Standards@ies.org for authoritative assistance'. Staff
 * should not be viewed as the subject matter experts for standards. Instead,
 * provide a more generic 'For technical support, please complete this form'").
 * ies.org/contact-us/ is IES's own form; it has a "The Lighting Library"
 * department, so no custom form is needed.
 */

export const SUPPORT_FORM_URL = 'https://ies.org/contact-us/';
export const SUPPORT_SENTENCE = 'For technical support, please complete the IES support form';

/** The three IES assets, as the definitions document names them. */
export const PRODUCT_DEFINITIONS = [
  {
    name: 'IES Lighting Library',
    verb: 'Read',
    definition: 'The complete library of IES standards and guidelines.',
    description: 'Read lighting standards from IES committees, or explore with IES Lens for guided access to definitions, documents, references, and more.',
  },
  {
    name: 'IES Lens',
    verb: 'Ask',
    definition: 'An AI-assisted guide to navigate IES resources.',
    description: 'Ask IES Lens to find standards excerpts, references, definitions, illuminance recommendations, and more.',
  },
  {
    name: 'IES eLearning (elearning.ies.org)',
    verb: 'Learn',
    definition: 'An education hub for IES expertise.',
    description: 'Learn from IES experts through in-depth courses, archived webinars and symposia, and more.',
  },
] as const;

/** The product statements, verbatim from the definitions document. */
export const PRODUCT_STATEMENTS = [
  'The enhanced IES Lighting Library brings subscriptions and leases into one browser-based collection, available on two personal devices: standards can be viewed, bookmarked and annotated on a computer, tablet or phone, with offline browser access.',
  'IES Lens interprets a question written in natural language and links directly to the most relevant excerpts from IES resources — excerpts from standards, definitions, references, and illuminance recommendations — and to the source within the Lighting Library.',
  'IES Lens searches exclusively within IES technical content. Results display as referenced excerpts and link directly to the relevant pages of IES standards, so the source and its full context can always be reviewed.',
  'AI assistance is optional. IES Lens is included with a Lighting Library subscription at no additional cost; the AI-assisted semantic search adds curation, and the AI Guide can be disabled in the account to use IES Lens for keyword search only.',
  'The Lighting Library, Illuminance Selector, Reference Retriever, and Document Comparison capabilities come together in one experience, with IES Lens connecting questions to relevant standards, tables, references, and source material.',
  'A question may use everyday language: IES Lens uses context to identify the relevant IES terminology, guidance, and table data, then connects to the right page in the standard for further reading.',
  'Access options: a subscription to the complete Lighting Library (with IES Lens), or individual documents through a three-year lease. Both use the same browser-based tools (bookmarks and annotations) and support offline browser access.',
  'IES Lens can explore differences between editions, including summaries of changes and additions. Subscribers receive access to deprecated standards for historical reference.',
] as const;

/** The block the AI Guide's system prompt carries. */
export function productPromptBlock(): string {
  return [
    ...PRODUCT_DEFINITIONS.map(d => `- ${d.name} ("${d.verb}"): ${d.definition} ${d.description}`),
    ...PRODUCT_STATEMENTS.map(s => `- ${s}`),
  ].join('\n');
}

// A question about the product itself, not about lighting. Anchored on the
// product's names and on "you" addressed to the tool, so "what is luminance?"
// or "what are the requirements for…" never match.
const PRODUCT_QUESTION_PATTERNS: RegExp[] = [
  /^\s*(?:who|what)\s+(?:are|r)\s+(?:you|u)\b/i,
  /^\s*what\s+(?:can|do)\s+you\s+do\b/i,
  /^\s*how\s+(?:do|can)\s+(?:i|we)\s+use\s+(?:you|this(?:\s+tool)?|ies\s+lens|lens(?:y)?)\b/i,
  /^\s*(?:what|who)\s+(?:is|'s)\s+(?:ies\s+)?lens(?:y)?\b/i,
  /^\s*what\s+is\s+(?:the\s+)?(?:ies\s+)?lighting\s+library\b/i,
  /^\s*(?:tell\s+me\s+)?about\s+(?:ies\s+)?lens(?:y)?\b/i,
  /^\s*(?:are\s+you|is\s+this)\s+(?:an?\s+)?(?:ai|chat\s*gpt|bot|chatbot|human|person)\b/i,
  /^\s*(?:hi|hello|hey)\b[\s!.,?]*$/i,
];

/** Is this a question about IES Lens / the Lighting Library rather than about lighting? */
export function isProductQuestion(query: string): boolean {
  const q = String(query || '').trim();
  if (!q || q.length > 120) return false;
  return PRODUCT_QUESTION_PATTERNS.some(re => re.test(q));
}

/**
 * The canned answer to a product question, in the client's words and in the
 * third person (9/30/26 DO#3: "Always prevent 1st-person and 2nd-person
 * responses"). Markdown, rendered by the Guide card like any other answer.
 */
export function productAnswerText(): string {
  const lens = PRODUCT_DEFINITIONS[1];
  const library = PRODUCT_DEFINITIONS[0];
  const learn = PRODUCT_DEFINITIONS[2];
  return [
    `This is IES Lens — ${lens.definition.charAt(0).toLowerCase()}${lens.definition.slice(1)} ${lens.description}`,
    '',
    PRODUCT_STATEMENTS[1],
    '',
    PRODUCT_STATEMENTS[2],
    '',
    `**${library.name}** ("${library.verb}"): ${library.definition} ${library.description}`,
    '',
    `**${learn.name}** ("${learn.verb}"): ${learn.definition} ${learn.description}`,
    '',
    PRODUCT_STATEMENTS[3],
  ].join('\n');
}
