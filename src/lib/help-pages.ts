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

// "tutorial" alone is a help word; "lighting design tutorial" is a question.
const TUTORIAL_RE = /\btutorials?\b/i;
const PRODUCT_RE = new RegExp(String.raw`${PRODUCT}|\b(?:bookmarks?|viewer|account|subscription)\b`, 'i');

/** Is this search about an account, a subscription or how to use the product? */
export function isHelpQuestion(query: string): boolean {
  const q = String(query || '').trim();
  if (!q || q.length > 200) return false;
  if (HELP_QUESTION_PATTERNS.some(re => re.test(q))) return true;
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

export interface TutorialCatalogueSection {
  section?: string;
  items?: Array<{ slug?: string; title?: string; summary?: string }>;
}

/** One entry per tutorial, with staff edits (title, summary) applied. */
export function tutorialEntries(
  catalogue: TutorialCatalogueSection[] | null | undefined,
  overrides: Record<string, { title?: string | null; summary?: string | null }> = {},
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
      score: overlap(tokens, entry.text) + overlap(tokens, entry.title),
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
