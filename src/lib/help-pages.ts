/**
 * Help pages: where a question about accounts, subscriptions or how to use
 * the product is SENT, instead of being answered (Dan, Teams 11/12/26 #5).
 *
 *   "we have several users searching for info about accounts, FAQ, etc. Can
 *    you include these pages in recurring indexing, but with a primary focus
 *    on driving users to these pages to find the answer rather than allowing
 *    Lens to answer detailed account/product questions?
 *      • lens.ies.org/tutorials
 *      • ies.org/products/lighting-library/ (especially the 'Digital Access' tab content)
 *      • ies.org/membership/sustaining-membership/"
 *
 * Three parts:
 *
 *   1. `isHelpQuestion` — is this search about the product or an account
 *      rather than about lighting? Decided by PATTERN, before retrieval, like
 *      the product question next to it (src/lib/product.ts): no standard
 *      answers "how do I renew my subscription", so a search would return noise
 *      and the AI Guide would improvise an answer about prices and policies
 *      that IES changes without telling the index. Anchored on words lighting
 *      questions do not use — "access control lighting" and "what to take
 *      into account for glare" must stay ordinary searches.
 *
 *   2. The index (`buildHelpIndex`, refreshed by the daily cron): every
 *      tutorial (title + summary, staff edits included) and each help page's
 *      sections. It only chooses WHICH link to offer — the reader gets a
 *      title, one line and a link, never the page's text.
 *
 *   3. `matchHelpLinks` — the links for one question, best first, always
 *      ending in the page that owns the topic, so there is never no link.
 *
 * The two ies.org pages cannot be read by an indexer today (measured
 * 2026-11-12): their HTML sits behind the site's bot challenge, and the
 * WordPress REST API returns them with empty content (both are template-built).
 * Until IES lets the indexer through, each page is represented by the curated
 * `topics` below; the cron keeps trying and records what it got.
 */

export interface HelpLink {
  title: string;
  url: string;
  description: string;
}

export interface HelpEntry {
  /** Which help page the entry belongs to. */
  page: string;
  title: string;
  url: string;
  /** One line shown to the reader. */
  description: string;
  /** What the matcher reads; never shown. */
  text: string;
  /**
   * Longer text behind the entry — a tutorial's How-To guide. Also read by the
   * matcher, at half weight: a guide is long, and two of its words coinciding
   * with a question says less than two words of the title or summary.
   */
  more?: string;
}

export interface HelpPageStatus {
  page: string;
  url: string;
  ok: boolean;
  entries: number;
  detail: string;
}

export interface HelpIndex {
  refreshedAt: string;
  entries: HelpEntry[];
  pages: HelpPageStatus[];
}

export const HELP_INDEX_KEY = 'help-pages:index:v1';
export const HELP_INDEXER_USER_AGENT = 'IES-Lens-Help-Index/1.0 (+https://lens.ies.org)';
const MAX_SECTIONS_PER_PAGE = 40;
const MAX_SECTION_TEXT = 600;
const MAX_LINKS = 4;

export interface HelpPage {
  key: string;
  title: string;
  url: string;
  description: string;
  /** Curated vocabulary of the page, used whether or not it could be fetched. */
  topics: string;
  /** Fetched by the cron when true (the tutorials come from the catalogue). */
  fetch: boolean;
}

export const HELP_PAGES: HelpPage[] = [
  {
    key: 'tutorials',
    title: 'Tutorials',
    url: 'https://lens.ies.org/tutorials',
    description: 'Short videos and step-by-step guides for IES Lens and the Lighting Library.',
    topics: 'tutorial tutorials video guide how to use help faq getting started overview troubleshooting '
      + 'bookmark bookmarks share collection annotate annotation highlight note offline navigate viewer '
      + 'compare versions filter sort list standards',
    fetch: false,
  },
  {
    key: 'digital-access',
    title: 'Lighting Library: subscriptions and digital access',
    url: 'https://ies.org/products/lighting-library/',
    description: 'What a subscription, a lease and IES membership each include (the “Digital Access” tab), and how to subscribe.',
    topics: 'subscription subscribe subscriber renew renewal cancel refund price pricing cost fee plan billing invoice '
      + 'payment purchase buy lease leased access digital device devices license trial free member membership '
      + 'discount account login sign password expire expiration upgrade included features lighting library lens',
    fetch: true,
  },
  {
    key: 'sustaining',
    title: 'Sustaining Membership',
    url: 'https://ies.org/membership/sustaining-membership/',
    description: 'Company memberships, and the Lighting Library access they include for employees.',
    topics: 'sustaining company companies corporate organization organisation employer employee employees team firm '
      + 'seat seats group multi user users university institution institutional enterprise site',
    fetch: true,
  },
];

// ─── 1. Is this a help question? ─────────────────────────────────────────────

// Each pattern names something a lighting question does not: an account, a
// payment, a subscription, the product's own features. Deliberately absent,
// because lighting questions use them: bare "access" (access roads, access
// control), "license" (license plates), "account" ("take into account"),
// "library" (how much light a library needs), "lens" (optics), "sign in"
// (a sign in a lobby), "site plans", "highlight", "member", "cost".
const PRODUCT = String.raw`(?:ies\s+lens|lighting\s+library|ai\s+guide)`;
const HELP_QUESTION_PATTERNS: RegExp[] = [
  // Subscriptions and payments.
  /\b(?:subscri(?:be|ber|bers|bing|ption|ptions)|unsubscribe|renew(?:al|ing|s)?|refunds?|invoices?|billing|receipts?|coupon|promo\s*code|free\s+trial)\b/i,
  new RegExp(String.raw`\b(?:pric(?:e|es|ing)|cost|costs|fees?|how\s+much)\b[^?]{0,60}\b(?:${PRODUCT}|membership|lease|leasing)\b`, 'i'),
  new RegExp(String.raw`\b(?:${PRODUCT}|membership|lease)\b[^?]{0,40}\b(?:pric(?:e|es|ing)|cost|costs|fees?)\b`, 'i'),
  /\b(?:buy|purchase|purchasing|order|lease|leasing|rent)\s+(?:an?\s+|the\s+|this\s+|individual\s+|single\s+)?(?:ies\s+)?(?:standards?|documents?|pdfs?|cop(?:y|ies))\b/i,
  /\b(?:leased|purchased)\s+(?:standards?|documents?)\b/i,
  // "Can I download a PDF of the lighting standards" (in the log, 11/19/26).
  /\bdownload(?:s|ing|able)?\b[^?]{0,50}\b(?:pdfs?|standards?|documents?|cop(?:y|ies))\b/i,
  /\bcancel(?:l?ing|l?ation)?\b[^?]{0,40}\b(?:subscription|membership|account|order|lease)\b/i,
  // Accounts and signing in.
  /\b(?:log[\s-]?in|log[\s-]?out|logged\s+(?:in|out)|sign-(?:in|out|up)|signed\s+(?:in|out))\b/i,
  /\b(?:can(?:'|’)?t|cannot|can\s+not|unable\s+to|how\s+(?:do|can)\s+(?:i|we)|trouble|problems?)\s+(?:\w+\s+){0,2}sign(?:ing)?\s+(?:in|up|out)\b/i,
  /\b(?:passwords?|username|user\s+name|two[\s-]factor|single\s+sign[\s-]on|sso)\b/i,
  /\b(?:my|an|ies|new|your|our|user|member)\s+accounts?\b|\baccount\s+(?:settings?|number|page|login|holder|setup)\b|\b(?:create|delete|close|register|update)\s+(?:an?\s+|my\s+)?account\b/i,
  // Access to the product (never "access" in the building sense).
  new RegExp(String.raw`\b(?:get|gain|lost|lose|losing|no|have|need|request)\s+access\s+to\b[^?]{0,30}\b(?:${PRODUCT}|standards?|documents?|collection|account)\b`, 'i'),
  new RegExp(String.raw`\b(?:can(?:'|’)?t|cannot|can\s+not|unable\s+to|how\s+(?:do|can)\s+(?:i|we))\s+(?:access|open|download|print)\b[^?]{0,40}\b(?:${PRODUCT}|standards?|pdfs?|account)\b`, 'i'),
  /\b(?:digital|offline|subscriber|trial)\s+access\b/i,
  /\bdevice\s+(?:limit|limits|reset|usage)\b|\b(?:reset|clear)\s+(?:my\s+)?devices?\b|\b(?:how\s+many|two|2|second|another|additional)\s+(?:personal\s+)?devices?\b[^?]{0,40}\b(?:log|sign|access|account|subscription|library|lens)\b/i,
  /\b(?:multi[\s-]?user|group|team|company|corporate|enterprise|institutional)\s+(?:licen[cs]es?|subscriptions?|accounts?)\b/i,
  /\bsearch\s+(?:limit|cap)\b|\bsearches\s+per\s+day\b/i,
  // Membership.
  /\bsustaining\s+members?(?:hip)?\b/i,
  /\b(?:ies\s+)?members?(?:hip)?\s+(?:benefits?|discounts?|dues|price|pricing|cost|fees?|renewal|login|portal)\b/i,
  /\b(?:become|becoming)\s+an?\s+(?:ies\s+)?member\b|\bjoin(?:ing)?\s+(?:the\s+)?ies\b/i,
  // The product's own help.
  /\b(?:faqs?|frequently\s+asked|user\s+guide|help\s+(?:page|pages|center|centre|desk)|customer\s+(?:service|support)|technical\s+support|tech\s+support)\b/i,
  /\bcontact\s+(?:ies|support|us|staff)\b/i,
  new RegExp(String.raw`\bhow\s+(?:do|can|to)\b[^?]{0,40}\b(?:bookmark|bookmarks|share\s+(?:a|my|this)?\s*(?:collection|bookmark|bookmarks)|compare\s+versions|annotat(?:e|ion|ions)|use\s+(?:the\s+)?(?:${PRODUCT}|viewer))\b`, 'i'),
  /\b(?:work|read|use|view)\w*\s+offline\b|\boffline\s+(?:mode|reading|viewing|browser)\b/i,
];

// ─── 1b. A question about one of the product's own tools (Dan, 11/19/26 #3) ──
//
//   "We have a few searches like 'where are the illuminance tables?' or 'what
//    is the compare versions tool' which ask about the platform. Answers to
//    these might be pulled from Tutorials, but when I searched the tutorials
//    were not referenced in AI Guide … several searches for 'where is the
//    illuminance selector tool?' which relate to products that are sunsetting."
//
// The tutorials WERE indexed (25 of them, refreshed daily). What failed is the
// gate above: none of those three phrasings names an account, a payment or a
// subscription, so they ran as ordinary searches and the Guide wrote about
// RP-7's Annex A and TM-30. They are recognized here instead, by the NAME of
// the tool they ask about.
//
// The difficulty is that the tools are named after lighting words. "Where are
// the illuminance tables?" asks about the product; "where are the illuminance
// tables for hospitals" and "ELECTRICAL ROOM illuminance selector" (both in
// the log) ask about lighting. So a query is a tool question only when NOTHING
// is left once the tool's name and the words of the question itself are taken
// out — and it names no standard.

export interface ProductFeature {
  key: string;
  title: string;
  url: string;
  /** What it is and where it is found — the one line the reader is given. */
  description: string;
  /** How readers name it. Matched case-insensitively, whole words. */
  names: RegExp;
  /**
   * False for a name that would also be an ordinary search on its own: the
   * bare name is then NOT a tool question, only the name inside a question
   * ("where are…", "what is…", "how do I…") is. Every tool is true today.
   */
  bareNameIsQuestion: boolean;
  /** A tool of the original Lighting Library that IES is retiring. */
  retired?: boolean;
}

export const PRODUCT_FEATURES: ProductFeature[] = [
  {
    key: 'illuminance-tables',
    title: 'List Illuminance Tables',
    url: 'https://lens.ies.org/illuminance-tables',
    description: 'Lists the illuminance tables of the current IES standards, each with the page it starts on; it is in the '
      + 'Lighting Library Tools menu. For the recommended values of one application, search for the application '
      + '(for example “classroom illuminance”) and keep Illuminance Tables selected under Sort/Filter.',
    // "Illuminace tables" is in the log three times; the typo is accepted.
    names: /\b(?:list\s+(?:of\s+)?illumina(?:n)?ce\s+tables?|illumina(?:n)?ce\s+tables?(?:\s+(?:list|page))?|illuminance\s+recommendations?\s+tables?)\b/i,
    // The bare name was searched six times in a month ("Illuminance Tables",
    // "Illuminace tables"): nobody types that to read prose ABOUT tables.
    bareNameIsQuestion: true,
  },
  {
    key: 'compare-versions',
    title: 'Compare Versions',
    url: 'https://lens.ies.org/?compare=1',
    description: 'Summarizes what was added and revised between the current edition of a standard and the edition before it, '
      + 'with links to both. It is in the Lighting Library Tools menu, for Lighting Library subscribers.',
    names: /\b(?:compar(?:e|ing)\s+(?:versions?|editions?|documents?)|version\s+comparisons?)\b/i,
    bareNameIsQuestion: true,
  },
  {
    key: 'list-standards',
    title: 'List Standards',
    url: 'https://lens.ies.org/contents',
    description: 'Lists every current IES standard — by collection, publication type or technical committee — with its table '
      + 'of contents. It is in the Lighting Library Tools menu.',
    names: /\b(?:list\s+(?:of\s+)?(?:ies\s+)?standards|standards\s+list)\b/i,
    bareNameIsQuestion: true,
  },
  {
    key: 'bookmarks',
    title: 'My Bookmarks',
    url: 'https://lens.ies.org/bookmarks',
    description: 'Holds the results saved from IES Lens, in collections that can be shared. It is in the profile menu.',
    names: /\b(?:my\s+bookmarks?|bookmark\s+collections?|saved\s+(?:searches|bookmarks?|results))\b/i,
    bareNameIsQuestion: true,
  },
  {
    key: 'toolbox',
    title: 'IES Standards Toolbox',
    url: 'https://www.ies.org/standards/standards-toolbox/',
    description: 'The calculators and tools that accompany IES standards, on ies.org. It is linked from the Lighting Library Tools menu.',
    names: /\b(?:(?:ies\s+)?standards\s+toolbox|toolbox)\b/i,
    bareNameIsQuestion: true,
  },
  {
    key: 'illuminance-selector',
    title: 'Illuminance Selector',
    url: 'https://lens.ies.org/tutorials/whats-new',
    description: 'The Illuminance Selector belongs to the original Lighting Library platform, which IES is retiring. Recommended '
      + 'illuminance values are now found by searching IES Lens for the application (for example “hotel lobby illuminance”) '
      + 'or in List Illuminance Tables. The tutorials below explain the transition.',
    names: /\billuminance\s+selectors?\b/i,
    bareNameIsQuestion: true,
    retired: true,
  },
  {
    key: 'reference-retriever',
    title: 'IES Reference Retriever',
    url: 'https://lens.ies.org/tutorials/whats-new',
    description: 'The IES Reference Retriever belongs to the original Lighting Library platform, which IES is retiring; its '
      + 'capabilities are part of IES Lens. The tutorials below explain the transition.',
    names: /\breference\s+retrievers?\b/i,
    bareNameIsQuestion: true,
    retired: true,
  },
];

/** A standard named in the query makes it a question about that standard. */
const NAMES_A_STANDARD_RE = /\b(?:RP|TM|HB|LM|LP|LS|DG|LEM|G)-\s*\d|\b90\.1\b/i;
/** The words of the question itself — what is left after them is the subject. */
const QUESTION_SHAPE_RE = /\b(?:where|what|how|which|why|is\s+there|are\s+there|can|could|does|do|did|find|explain|tell|show|locate)\b/i;
const QUESTION_FILLER = new Set((
  'where what how which why is are was were be there here the a an this that it its can could would should do does did '
  + 'i we you me my our your find finding found use using used open opening get getting go access accessing locate located '
  + 'see show tell explain about work works working mean means meant happened gone still anymore now new old original '
  + 'tool tools page pages feature features function option options button menu link app application platform site website '
  + 'online internet in on of to at by with within from and or not no any ies lens lighting library provide provides '
  + 'provided offer offers available exactly please thanks t cant cannot'
).split(' '));

/**
 * The product tool a query asks about, or null. See the note above: the tool's
 * name must be the whole SUBJECT of the query.
 */
export function featureQuestion(query: string): ProductFeature | null {
  const q = String(query || '').trim();
  if (!q || q.length > 200 || NAMES_A_STANDARD_RE.test(q)) return null;
  for (const feature of PRODUCT_FEATURES) {
    if (!feature.names.test(q)) continue;
    const rest = q.replace(new RegExp(feature.names.source, 'gi'), ' ')
      .toLowerCase().split(/[^a-z0-9]+/)
      .filter(w => w && !QUESTION_FILLER.has(w));
    if (rest.length > 0) continue;
    if (!feature.bareNameIsQuestion && !QUESTION_SHAPE_RE.test(q)) continue;
    return feature;
  }
  return null;
}

/**
 * A RETIRED tool named inside an ordinary search ("ELECTRICAL ROOM illuminance
 * selector"): the search runs as it is, and the reader is told the tool is
 * going away. Null when the query IS the question (featureQuestion answers it).
 */
export function retiredToolMentioned(query: string): ProductFeature | null {
  const q = String(query || '');
  return PRODUCT_FEATURES.find(f => f.retired && f.names.test(q)) || null;
}

/** The answer above the links for a tool question: what the tool is, in one line. */
export function featureAnswerText(feature: ProductFeature): string {
  return [
    `**${feature.title}** — ${feature.description}`,
    '',
    feature.retired
      ? 'To ask about lighting, describe the application or topic — for example “office lighting recommendations”.'
      : 'The pages below show how it works.',
  ].join('\n');
}

/** The banner line for a retired tool named inside an ordinary search. */
export function retiredToolNotice(feature: ProductFeature): string {
  return `The ${feature.title} belongs to the original Lighting Library platform, which IES is retiring; `
    + `IES Lens now provides its capabilities. [See what changed](${feature.url})`;
}

/**
 * The links for a tool question: the tool itself first (a retired tool has no
 * page, so its transition tutorial stands in), then what the index matched.
 */
export function featureHelpLinks(feature: ProductFeature, query: string, index: HelpIndex | null | undefined): HelpLink[] {
  const own: HelpLink = feature.retired
    ? { title: 'Tutorial: What’s New in the Lighting Library with IES Lens?', url: feature.url, description: 'What replaced the tools of the original Lighting Library.' }
    : { title: feature.title, url: feature.url, description: feature.description.split('; ')[0].split('. ')[0].replace(/\.$/, '') + '.' };
  // Matched on the tool's NAME as well as the question, so "where is it?"
  // phrasings still find the tutorials that mention the tool.
  const matched = matchHelpLinks(`${query} ${feature.title}`, index);
  const links: HelpLink[] = [own];
  for (const link of matched) {
    if (links.length >= MAX_LINKS) break;
    if (!links.some(l => l.url === link.url)) links.push(link);
  }
  return links;
}

// "tutorial" alone is a help word; "lighting design tutorial" is a question.
const TUTORIAL_RE = /\btutorials?\b/i;
const PRODUCT_RE = new RegExp(String.raw`${PRODUCT}|\b(?:bookmarks?|viewer|account|subscription)\b`, 'i');

/** Is this search about an account, a subscription or how to use the product? */
export function isHelpQuestion(query: string): boolean {
  const q = String(query || '').trim();
  if (!q || q.length > 200) return false;
  if (HELP_QUESTION_PATTERNS.some(re => re.test(q))) return true;
  if (featureQuestion(q)) return true;
  return TUTORIAL_RE.test(q) && (q.split(/\s+/).length <= 3 || PRODUCT_RE.test(q));
}

/** The fixed answer above the links — third person, and it answers nothing itself. */
export function helpAnswerText(): string {
  return [
    'IES Lens answers questions from the content of IES standards. Questions about accounts, subscriptions, '
      + 'leases, memberships and how to use the Lighting Library or IES Lens are answered on the pages below, '
      + 'which IES keeps current.',
    '',
    'To ask about lighting, describe the application or topic — for example “office lighting recommendations”.',
  ].join('\n');
}

// ─── 2. The index ────────────────────────────────────────────────────────────

const STOPWORDS = new Set((
  'a an the and or of to for in on at by with from is are was be do does did can could should would will how what '
  + 'where when why which who i we my our me you your it its this that these those there as if not no yes about into '
  + 'ies lens lighting library standard standards please need want get have has'
).split(' '));

function stem(word: string): string {
  if (word.length > 5 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.length > 5 && word.endsWith('ing')) return word.slice(0, -3);
  if (word.length > 4 && word.endsWith('ed')) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

/** The words of a text the matcher compares: lower-cased, stemmed, no filler. */
export function helpTokens(text: string): string[] {
  return String(text || '').toLowerCase().split(/[^a-z0-9]+/)
    .filter(w => w.length > 1 && !STOPWORDS.has(w))
    .map(stem);
}

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—',
  rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', hellip: '…', trade: '™', reg: '®',
};

function decodeEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, n) => safeCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => safeCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m);
}

function safeCodePoint(n: number): string {
  return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : ' ';
}

function plainText(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/**
 * A page's HTML → its sections: each heading with the text under it. Scripts,
 * styles and the site chrome (nav, header, footer, forms) are dropped first.
 * Text only — whatever markup the page carried is gone.
 */
export function extractSections(html: string): Array<{ heading: string; text: string }> {
  let body = String(html || '');
  const main = /<main\b[\s\S]*?<\/main>/i.exec(body);
  if (main) body = main[0];
  body = body
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|nav|header|footer|form|template)\b[\s\S]*?<\/\1>/gi, ' ');

  const sections: Array<{ heading: string; text: string }> = [];
  const headingRe = /<h([1-4])\b[^>]*>([\s\S]*?)<\/h\1>/gi;
  let last: { heading: string; from: number } | null = null;
  const close = (until: number) => {
    if (!last) return;
    const text = plainText(body.slice(last.from, until)).slice(0, MAX_SECTION_TEXT);
    if (last.heading && (text || sections.length === 0)) sections.push({ heading: last.heading, text });
  };
  let m: RegExpExecArray | null;
  while ((m = headingRe.exec(body)) !== null) {
    close(m.index);
    last = { heading: plainText(m[2]).slice(0, 160), from: m.index + m[0].length };
    if (sections.length >= MAX_SECTIONS_PER_PAGE) { last = null; break; }
  }
  close(body.length);
  return sections.slice(0, MAX_SECTIONS_PER_PAGE);
}

/** Is this the bot-challenge interstitial rather than the page? */
export function looksLikeChallenge(html: string): boolean {
  return /<title>\s*Just a moment/i.test(html) || /_cf_chl_opt|challenge-platform/i.test(html);
}

export interface TutorialGuide {
  title?: string;
  steps?: Array<{ title?: string; points?: Array<string | { text?: string; items?: string[] }> }>;
}

export interface TutorialCatalogueSection {
  section?: string;
  items?: Array<{ slug?: string; title?: string; summary?: string | null; guide?: TutorialGuide | null }>;
}

/** How much of a tutorial's How-To guide the matcher reads. */
const MAX_GUIDE_TEXT = 6000;

/** A catalogue guide ({title, steps:[{title, points}]}) as plain words. */
function catalogueGuideText(guide: TutorialGuide | null | undefined): string {
  if (!guide || typeof guide !== 'object') return '';
  const parts: string[] = [String(guide.title || '')];
  for (const step of guide.steps || []) {
    parts.push(String(step?.title || ''));
    for (const point of step?.points || []) {
      if (typeof point === 'string') parts.push(point);
      else parts.push(String(point?.text || ''), ...(point?.items || []).map(String));
    }
  }
  return parts.join(' ').replace(/\*\*/g, '');
}

/**
 * One entry per tutorial, with staff edits (title, summary) applied.
 *
 * The matcher also reads the tutorial's How-To GUIDE — the staff-pasted one
 * when there is one, else the catalogue's (Dan, 11/19/26 #3: "The sunsetting
 * tools are referenced in at least 2 tutorials" — and a third names them only
 * in its guide). The guide is never shown: the reader still gets a title, one
 * line and a link.
 */
export function tutorialEntries(
  catalogue: TutorialCatalogueSection[] | null | undefined,
  overrides: Record<string, { title?: string | null; summary?: string | null; guideHtml?: string | null }> = {},
): HelpEntry[] {
  const page = HELP_PAGES[0];
  const out: HelpEntry[] = [];
  for (const section of catalogue || []) {
    for (const item of section?.items || []) {
      const slug = String(item?.slug || '').trim();
      if (!/^[a-z0-9][a-z0-9-]{1,60}$/.test(slug)) continue;
      const o = overrides[slug] || {};
      const title = String(o.title || item.title || '').trim();
      if (!title) continue;
      const summary = String(o.summary || item.summary || '').replace(/\s+/g, ' ').trim();
      out.push({
        page: page.key,
        title: `Tutorial: ${title}`,
        url: `${page.url}/${slug}`,
        description: summary.length > 180 ? `${summary.slice(0, 177).replace(/\s+\S*$/, '')}…` : summary,
        text: `${title} ${section.section || ''} ${summary}`,
        more: (o.guideHtml ? plainText(String(o.guideHtml)) : catalogueGuideText(item.guide)).slice(0, MAX_GUIDE_TEXT),
      });
    }
  }
  return out;
}

/** A fetched page's sections as entries; the link is the page (no anchors are guessed). */
export function pageEntries(page: HelpPage, sections: Array<{ heading: string; text: string }>): HelpEntry[] {
  return sections
    .filter(s => s.heading)
    .map(s => ({
      page: page.key,
      title: page.title,
      url: page.url,
      description: `See “${s.heading}”.`,
      text: `${s.heading} ${s.text}`,
    }));
}

// ─── 3. The links for one question ───────────────────────────────────────────

function overlap(queryTokens: string[], text: string): number {
  const have = new Set(helpTokens(text));
  let n = 0;
  for (const t of queryTokens) if (have.has(t)) n++;
  return n;
}

/**
 * The help links for a question, best first. Indexed entries (tutorials, page
 * sections) are scored on shared words — a word in the title counts double —
 * and the page that owns the topic by its curated vocabulary always closes
 * the list, so a question the index cannot place still gets a destination.
 */
export function matchHelpLinks(query: string, index: HelpIndex | null | undefined): HelpLink[] {
  const tokens = [...new Set(helpTokens(query))];
  const links: HelpLink[] = [];
  const seen = new Set<string>();
  const add = (title: string, url: string, description: string) => {
    if (seen.has(url) || links.length >= MAX_LINKS) return;
    seen.add(url);
    links.push({ title, url, description });
  };

  const scored = (index?.entries || [])
    .map((entry, order) => ({
      entry, order,
      score: overlap(tokens, entry.text) + overlap(tokens, entry.title)
        + (entry.more ? 0.5 * overlap(tokens.filter(t => !helpTokens(entry.text).includes(t)), entry.more) : 0),
    }))
    // One shared word is a coincidence unless the question is one word long.
    .filter(s => s.score >= Math.min(2, tokens.length) && s.score > 0)
    .sort((a, b) => b.score - a.score || a.order - b.order);
  for (const s of scored.slice(0, 2)) add(s.entry.title, s.entry.url, s.entry.description);

  const owners = HELP_PAGES
    .map((page, order) => ({ page, order, score: overlap(tokens, page.topics) }))
    .sort((a, b) => b.score - a.score || a.order - b.order);
  const matchedOwners = owners.filter(o => o.score > 0);
  for (const o of (matchedOwners.length ? matchedOwners : owners)) add(o.page.title, o.page.url, o.page.description);
  return links;
}

/** The links under a "what is IES Lens?" answer: the three pages, as listed. */
export function defaultHelpLinks(): HelpLink[] {
  return HELP_PAGES.map(p => ({ title: p.title, url: p.url, description: p.description }));
}

// ─── Refresh (daily cron, or Admin) ──────────────────────────────────────────

interface HelpEnv {
  SESSIONS: KVNamespace;
  /** Optional shared secret IES can allow through the ies.org bot challenge. */
  HELP_INDEX_TOKEN?: string;
}

/**
 * Rebuild the index: the tutorials from the catalogue, each fetchable page
 * from its own URL. A page that cannot be read (today: both ies.org pages)
 * contributes nothing and says why in `pages` — its curated topics still
 * route questions to it. Never throws; an index with tutorials only is stored.
 */
export async function refreshHelpIndex(
  env: HelpEnv,
  tutorials: HelpEntry[],
  fetcher: typeof fetch = fetch,
): Promise<HelpIndex> {
  const entries: HelpEntry[] = [...tutorials];
  const pages: HelpPageStatus[] = [{
    page: HELP_PAGES[0].key, url: HELP_PAGES[0].url, ok: tutorials.length > 0,
    entries: tutorials.length, detail: 'Read from the tutorials catalogue and staff edits.',
  }];

  for (const page of HELP_PAGES.filter(p => p.fetch)) {
    let status: HelpPageStatus = { page: page.key, url: page.url, ok: false, entries: 0, detail: '' };
    try {
      const headers: Record<string, string> = { Accept: 'text/html', 'User-Agent': HELP_INDEXER_USER_AGENT };
      if (env.HELP_INDEX_TOKEN) headers['X-IES-Lens-Indexer'] = env.HELP_INDEX_TOKEN;
      const res = await fetcher(page.url, { headers, redirect: 'follow' });
      const html = await res.text();
      if (looksLikeChallenge(html)) {
        status.detail = `HTTP ${res.status}: the site's bot challenge answered instead of the page.`;
      } else if (!res.ok) {
        status.detail = `HTTP ${res.status}.`;
      } else {
        const found = pageEntries(page, extractSections(html));
        entries.push(...found);
        status = { ...status, ok: found.length > 0, entries: found.length,
          detail: found.length ? 'Read from the page.' : 'The page was read but no headed sections were found.' };
      }
    } catch (err) {
      status.detail = `Fetch failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 200);
    }
    pages.push(status);
  }

  const index: HelpIndex = { refreshedAt: new Date().toISOString(), entries, pages };
  try {
    await env.SESSIONS.put(HELP_INDEX_KEY, JSON.stringify(index));
  } catch (err) {
    console.error('help index: could not store:', err instanceof Error ? err.message : String(err));
  }
  return index;
}

/** The stored index, or null — the curated topics then route every question. */
export async function loadHelpIndex(env: HelpEnv): Promise<HelpIndex | null> {
  try {
    const raw = await env.SESSIONS.get(HELP_INDEX_KEY, { cacheTtl: 300 });
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && Array.isArray(parsed.entries) ? parsed as HelpIndex : null;
  } catch {
    return null;
  }
}
