import { describe, it, expect } from 'vitest';
import {
  isHelpQuestion, matchHelpLinks, defaultHelpLinks, helpAnswerText, helpTokens,
  extractSections, looksLikeChallenge, tutorialEntries, pageEntries, refreshHelpIndex,
  loadHelpIndex, HELP_PAGES, HELP_INDEX_KEY, HELP_INDEXER_USER_AGENT,
} from './help-pages';

// Dan, Teams 11/12/26 #5: account / FAQ / product questions are sent to the
// help pages rather than answered.

describe('isHelpQuestion', () => {
  it('recognizes account, subscription and how-to questions', () => {
    for (const q of [
      'how do I renew my subscription',
      'subscription price',
      'how much does the Lighting Library cost',
      'IES Lens pricing',
      'cancel my membership',
      'I forgot my password',
      'can’t log in',
      'how do I sign in on a second device',
      'reset my devices',
      'how many devices can I use to access my account',
      'how do I get access to the standards',
      'how can I download a standard',
      'lease a standard',
      'where are my leased documents',
      'sustaining membership',
      'company subscription for our team',
      'IES membership benefits',
      'how do I become an IES member',
      'FAQ',
      'tutorials',
      'IES Lens tutorial',
      'technical support',
      'contact IES',
      'how do I bookmark a result',
      'how to share a collection',
      'offline access',
      'daily search limit',
      'refund',
    ]) {
      expect(isHelpQuestion(q), q).toBe(true);
    }
  });

  it('leaves lighting questions alone', () => {
    for (const q of [
      'how much light does a library need',
      'library stacks illuminance',
      'access control lighting at a parking entrance',
      'lighting for access roads',
      'license plate illumination',
      'what to take into account for glare',
      'lighting for an illuminated sign in a lobby',
      'lighting site plans',
      'cost effective lighting controls',
      'new lighting control devices for dimming',
      'lens optics for a floodlight',
      'how do I highlight artwork',
      'lighting design tutorial for offices',
      'structural member lighting',
      'office lighting recommendations',
      'what is illuminance',
      'RP-8-25',
      'daily light exposure limits',
      'lease space lighting in a mall',
    ]) {
      expect(isHelpQuestion(q), q).toBe(false);
    }
  });

  it('ignores empty and very long input', () => {
    expect(isHelpQuestion('')).toBe(false);
    expect(isHelpQuestion(`subscription ${'x'.repeat(220)}`)).toBe(false);
  });
});

describe('helpAnswerText', () => {
  it('points at the pages without answering, in the third person', () => {
    const text = helpAnswerText();
    expect(text).toMatch(/pages below/);
    expect(text).not.toMatch(/\b(?:I|we|you|your)\b/);
    expect(text).not.toMatch(/\$\d/);
  });
});

const CATALOGUE = [
  { section: 'Getting Started', items: [
    { slug: 'accessing-leased-documents', title: 'Accessing Your Leased Documents', summary: 'This video shows where a leased standard appears after purchase and how to open it.' },
    { slug: 'subscriber-vs-free-access', title: 'Subscriber vs Free Access', summary: 'What IES members and subscribers can open.' },
  ] },
  { section: 'Lighting Library', items: [
    { slug: 'offline-access', title: 'Offline Access', summary: 'Reading a standard offline in the browser.' },
    { slug: 'Bad Slug', title: 'Ignored' },
  ] },
];

describe('tutorialEntries', () => {
  it('lists each tutorial at its permanent URL and skips a malformed slug', () => {
    const entries = tutorialEntries(CATALOGUE);
    expect(entries.map(e => e.url)).toEqual([
      'https://lens.ies.org/tutorials/accessing-leased-documents',
      'https://lens.ies.org/tutorials/subscriber-vs-free-access',
      'https://lens.ies.org/tutorials/offline-access',
    ]);
    expect(entries[0].title).toBe('Tutorial: Accessing Your Leased Documents');
  });

  it('prefers the title and summary staff edited', () => {
    const [first] = tutorialEntries(CATALOGUE, { 'accessing-leased-documents': { title: 'Open a Leased Standard', summary: null } });
    expect(first.title).toBe('Tutorial: Open a Leased Standard');
    expect(first.description).toMatch(/leased standard appears/);
  });
});

describe('extractSections', () => {
  const html = `<html><head><title>Lighting Library</title><style>h2{color:red}</style></head><body>
    <nav><h2>Menu</h2><a href="/">Home</a></nav>
    <main><h1>The IES Lighting Library</h1><p>Read every IES standard.</p>
      <h2>Digital&nbsp;Access</h2><p>A subscription opens <b>all</b> documents &amp; IES Lens.</p><script>var x = 1;</script>
      <h3>Lease</h3><ul><li>Three years</li><li>One document</li></ul></main>
    <footer><h4>Contact</h4></footer></body></html>`;

  it('returns each heading with the text under it, without chrome or scripts', () => {
    expect(extractSections(html)).toEqual([
      { heading: 'The IES Lighting Library', text: 'Read every IES standard.' },
      { heading: 'Digital Access', text: 'A subscription opens all documents & IES Lens.' },
      { heading: 'Lease', text: 'Three years One document' },
    ]);
  });

  it('yields nothing for a page with no headings', () => {
    expect(extractSections('<p>Just a paragraph.</p>')).toEqual([]);
    expect(extractSections('')).toEqual([]);
  });

  it('recognizes the bot-challenge page', () => {
    expect(looksLikeChallenge('<html><head><title>Just a moment...</title></head></html>')).toBe(true);
    expect(looksLikeChallenge(html)).toBe(false);
  });
});

describe('matchHelpLinks', () => {
  const index = {
    refreshedAt: '2026-11-12T10:00:00Z',
    pages: [],
    entries: [
      ...tutorialEntries(CATALOGUE),
      ...pageEntries(HELP_PAGES[1], [{ heading: 'Digital Access', text: 'Subscription, lease and member access compared. Two personal devices.' }]),
    ],
  };

  it('leads with the tutorial that answers the question, then the page that owns the topic', () => {
    const links = matchHelpLinks('where are my leased documents', index);
    expect(links[0].url).toBe('https://lens.ies.org/tutorials/accessing-leased-documents');
    expect(links.map(l => l.url)).toContain('https://ies.org/products/lighting-library/');
  });

  it('routes by the curated topics when nothing is indexed', () => {
    expect(matchHelpLinks('how do I renew my subscription', null)[0].url).toBe('https://ies.org/products/lighting-library/');
    expect(matchHelpLinks('sustaining membership seats for employees', null)[0].url)
      .toBe('https://ies.org/membership/sustaining-membership/');
    expect(matchHelpLinks('tutorials', null)[0].url).toBe('https://lens.ies.org/tutorials');
  });

  it('always offers a destination, each link once, at most four', () => {
    const links = matchHelpLinks('zzz qqq', index);
    expect(links.map(l => l.url)).toEqual(HELP_PAGES.map(p => p.url));
    const many = matchHelpLinks('subscription lease offline access devices member company tutorial', index);
    expect(many.length).toBeLessThanOrEqual(4);
    expect(new Set(many.map(l => l.url)).size).toBe(many.length);
  });

  it('names the matched section of a fetched page', () => {
    const links = matchHelpLinks('two devices digital access', index);
    const page = links.find(l => l.url === 'https://ies.org/products/lighting-library/');
    expect(page.description).toBe('See “Digital Access”.');
  });

  it('the default links are the three pages', () => {
    expect(defaultHelpLinks().map(l => l.url)).toEqual(HELP_PAGES.map(p => p.url));
  });

  it('compares stemmed words without filler', () => {
    expect(helpTokens('How do I renew my subscriptions?')).toEqual(['renew', 'subscription']);
  });
});

describe('refreshHelpIndex', () => {
  const kv = () => {
    const store = new Map();
    return {
      store,
      put: async (k, v) => { store.set(k, v); },
      get: async (k) => store.get(k) ?? null,
    };
  };

  it('stores the tutorials and what each page answered, and identifies itself honestly', async () => {
    const SESSIONS = kv();
    const seen = [];
    const fetcher = async (url, init) => {
      seen.push({ url, headers: init.headers });
      if (url.includes('sustaining')) {
        return new Response('<html><head><title>Just a moment...</title></head></html>', { status: 403 });
      }
      return new Response('<main><h2>Digital Access</h2><p>Subscription and lease.</p></main>', { status: 200 });
    };
    const index = await refreshHelpIndex({ SESSIONS, HELP_INDEX_TOKEN: 'secret' }, tutorialEntries(CATALOGUE), fetcher);

    expect(seen.map(s => s.url)).toEqual(HELP_PAGES.filter(p => p.fetch).map(p => p.url));
    expect(seen[0].headers['User-Agent']).toBe(HELP_INDEXER_USER_AGENT);
    expect(seen[0].headers['X-IES-Lens-Indexer']).toBe('secret');
    expect(index.pages.map(p => [p.page, p.ok, p.entries])).toEqual([
      ['tutorials', true, 3], ['digital-access', true, 1], ['sustaining', false, 0],
    ]);
    expect(index.pages[2].detail).toMatch(/bot challenge/);
    expect(JSON.parse(SESSIONS.store.get(HELP_INDEX_KEY)).entries).toHaveLength(4);
    expect((await loadHelpIndex({ SESSIONS })).entries).toHaveLength(4);
  });

  it('survives a fetch that throws and a store that fails', async () => {
    const SESSIONS = { put: async () => { throw new Error('kv down'); }, get: async () => { throw new Error('kv down'); } };
    const index = await refreshHelpIndex({ SESSIONS }, [], async () => { throw new Error('network'); });
    expect(index.pages.every(p => !p.ok)).toBe(true);
    expect(await loadHelpIndex({ SESSIONS })).toBeNull();
  });
});
