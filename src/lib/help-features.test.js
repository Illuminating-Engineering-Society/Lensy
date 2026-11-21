import { describe, it, expect } from 'vitest';
import {
  isHelpQuestion, featureQuestion, retiredToolMentioned, featureAnswerText, featureHelpLinks,
  retiredToolNotice, tutorialEntries, matchHelpLinks, PRODUCT_FEATURES,
} from './help-pages';

// Dan, Teams 11/19/26 #3: questions about the platform's own tools.

describe('featureQuestion', () => {
  it('recognizes the searches from the log', () => {
    const cases = [
      ['where are the illuminance tables?', 'illuminance-tables'],
      ['where are the illuminance tables', 'illuminance-tables'],
      ['Where can I find the list of illuminance tables?', 'illuminance-tables'],
      ['what is the compare versions tool', 'compare-versions'],
      ['how do I compare versions', 'compare-versions'],
      ['compare versions', 'compare-versions'],
      ['where is the illuminance selector tool?', 'illuminance-selector'],
      ['ies illuminance selector', 'illuminance-selector'],
      ["Is there an illuminance selector that IES provides still? I can't find it on the internet", 'illuminance-selector'],
      ['where is the reference retriever', 'reference-retriever'],
      ['where is list standards', 'list-standards'],
      ['where are my bookmarks', 'bookmarks'],
      ['where is the standards toolbox?', 'toolbox'],
      ['Illuminance Tables', 'illuminance-tables'],        // the bare name, six times in a month
      ['Illuminace tables', 'illuminance-tables'],         // …three of them spelled like this
    ];
    for (const [q, key] of cases) {
      expect(featureQuestion(q)?.key, q).toBe(key);
      expect(isHelpQuestion(q), q).toBe(true);
    }
  });

  it('leaves lighting searches that merely use the same words alone', () => {
    for (const q of [
      'ELECTRICAL ROOM illuminance selector',
      'industrial illuminance selector',
      'recommended illuminance selector',
      'illuminance tables for hospitals',
      'where are the illuminance tables for hospitals',
      'where are the illuminance tables in RP-8?',        // names a standard
      'what is illuminance',
      'compare versions of RP-43',
      'what changed in the list of standards for roadway lighting',
      'office lighting recommendations',
      'how do I light a hospital corridor',
      'list standards for sports lighting',
    ]) {
      expect(featureQuestion(q), q).toBeNull();
    }
  });

  it('still tells the reader a retired tool is going away when it is named inside a search', () => {
    expect(retiredToolMentioned('ELECTRICAL ROOM illuminance selector')?.key).toBe('illuminance-selector');
    expect(retiredToolMentioned('office illuminance')).toBeNull();
    expect(retiredToolMentioned('compare versions')).toBeNull();
    const notice = retiredToolNotice(retiredToolMentioned('industrial illuminance selector'));
    expect(notice).toContain('Illuminance Selector');
    expect(notice).toMatch(/\[See what changed\]\(https:\/\/lens\.ies\.org\/tutorials\/whats-new\)$/);
  });
});

describe('the answer to a tool question', () => {
  const CATALOGUE = [{
    section: 'IES Lens',
    items: [
      { slug: 'whats-new', title: 'What’s New in the Lighting Library with IES Lens?',
        summary: 'The Illuminance Selector and IES Reference Retriever options will sunset, with their capabilities integrated into IES Lens.' },
      { slug: 'transition', title: 'Preparing for IES Lighting Library Transition',
        summary: 'The original platform, including the IES Reference Retriever app and Illuminance Selector tool, will sunset.' },
      { slug: 'comparing-versions', title: 'IES Lens: Comparing Versions of a Standard',
        summary: 'How to use the Compare Versions tool to see what may be new in an updated standard.' },
      { slug: 'illuminance-values', title: 'IES Lens: Recommended Illuminance Values',
        summary: 'How to find recommended illuminance values and filter results to illuminance table results.' },
      { slug: 'ai-guide', title: 'IES Lens: AI Guide', summary: 'How the AI Guide surfaces relevant standards.',
        guide: { title: 'AI Guide', steps: [{ title: 'Coming from the old tools', points: ['The Illuminance Selector tool is replaced by table cards.', { text: 'More', items: ['Selector reports do not carry over'] }] }] } },
    ],
  }];
  const index = { refreshedAt: 'x', pages: [], entries: tutorialEntries(CATALOGUE) };
  const urls = (links) => links.map(l => l.url);

  it('says what the tool is and where it is, in the third person', () => {
    const f = featureQuestion('what is the compare versions tool');
    const text = featureAnswerText(f);
    expect(text.startsWith('**Compare Versions** — Summarizes what was added and revised')).toBe(true);
    expect(text).toContain('Lighting Library Tools menu');
    expect(text).not.toMatch(/\b(?:I|we|our)\b/);
  });

  it('links the tool itself first, then its tutorial', () => {
    const q = 'what is the compare versions tool';
    const links = featureHelpLinks(featureQuestion(q), q, index);
    expect(links[0]).toMatchObject({ title: 'Compare Versions', url: 'https://lens.ies.org/?compare=1' });
    expect(urls(links)).toContain('https://lens.ies.org/tutorials/comparing-versions');
    expect(links.length).toBeLessThanOrEqual(4);
    expect(new Set(urls(links)).size).toBe(links.length);
  });

  it('"where are the illuminance tables?" opens the list page and names the tutorial', () => {
    const q = 'where are the illuminance tables?';
    const links = featureHelpLinks(featureQuestion(q), q, index);
    expect(links[0].url).toBe('https://lens.ies.org/illuminance-tables');
    expect(urls(links)).toContain('https://lens.ies.org/tutorials/illuminance-values');
  });

  it('a retired tool is answered with the transition tutorials', () => {
    const q = 'where is the illuminance selector tool?';
    const f = featureQuestion(q);
    expect(featureAnswerText(f)).toContain('which IES is retiring');
    const links = urls(featureHelpLinks(f, q, index));
    expect(links[0]).toBe('https://lens.ies.org/tutorials/whats-new');
    expect(links).toContain('https://lens.ies.org/tutorials/transition');
  });

  it('reads a tutorial\'s How-To guide, at half the weight of its title and summary', () => {
    const guided = index.entries.find(e => e.url.endsWith('/ai-guide'));
    expect(guided.more).toContain('Selector reports do not carry over');
    expect(guided.text).not.toContain('Selector reports');
    // Two guide-only words are one point: not enough on their own…
    expect(urls(matchHelpLinks('selector reports', index))).not.toContain('https://lens.ies.org/tutorials/ai-guide');
    // …four are.
    expect(urls(matchHelpLinks('illuminance selector reports carry over', { ...index, entries: [guided] })))
      .toContain('https://lens.ies.org/tutorials/ai-guide');
  });

  it('every tool has a line that fits a link description', () => {
    for (const f of PRODUCT_FEATURES) {
      expect(f.description.length, f.key).toBeGreaterThan(40);
      expect(f.url.startsWith('https://'), f.key).toBe(true);
    }
  });
});
