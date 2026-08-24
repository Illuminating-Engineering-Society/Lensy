/**
 * Frontend behaviour tests for the 260729 client feedback round (DO20–DO33).
 *
 * The UI is a single HTML file with an inline script and no build step, so there
 * is no module to import. This suite pulls the app script out of index.html and
 * evaluates it against a minimal DOM stub, then calls the render functions
 * directly. It catches exactly what the Worker tests cannot: a filter that no
 * longer reflects its pill, a card that stops printing its label, a locator that
 * gets linked when it should not.
 *
 * Deliberately NOT jsdom: the stub below is ~40 lines, has no install cost, and
 * the functions under test only ever touch textContent / innerHTML / style /
 * classList / dataset.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import vm from 'vm';

const here = dirname(fileURLToPath(import.meta.url));

let ctx;          // the evaluated app script's context
let elements;     // id → stub element
let pills;        // filter name → stub element
let run;          // (expr) => value, evaluated inside the app scope

function stubElement(id) {
  const el = {
    id, textContent: '', innerHTML: '', value: '', checked: false, disabled: false,
    style: {}, dataset: {},
    classList: {
      _s: new Set(),
      add(...c) { c.forEach(x => this._s.add(x)); },
      remove(...c) { c.forEach(x => this._s.delete(x)); },
      toggle(c, on) {
        if (on === undefined) this._s.has(c) ? this._s.delete(c) : this._s.add(c);
        else if (on) this._s.add(c); else this._s.delete(c);
      },
      contains(c) { return this._s.has(c); },
    },
    addEventListener() {}, removeEventListener() {},
    setAttribute(k, v) { el[`attr_${k}`] = v; },
    getAttribute(k) { return el[`attr_${k}`] ?? null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    closest() { return null; },
    getBoundingClientRect() { return { top: 0 }; },
    focus() {}, scrollIntoView() {},
  };
  return el;
}

beforeAll(() => {
  const html = readFileSync(join(here, 'index.html'), 'utf8');
  const blocks = [...html.matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  const app = blocks[blocks.length - 1];

  elements = new Map();
  pills = new Map();
  const byId = (id) => {
    if (!elements.has(id)) elements.set(id, stubElement(id));
    return elements.get(id);
  };

  const sandbox = {
    document: {
      getElementById: byId,
      // Every control that reflects a filter is found by its data-filter
      // attribute alone (DO57): the pills, the AI Guide toggle inside the search
      // box, and the Compare Documents button in the banner.
      querySelector(sel) {
        const m = /\[data-filter="([^"]+)"\]/.exec(sel);
        if (!m) return null;
        if (!pills.has(m[1])) pills.set(m[1], stubElement(`pill:${m[1]}`));
        return pills.get(m[1]);
      },
      querySelectorAll(sel) {
        const s = String(sel);
        // A content kind now has two controls (the sidebar and the hero's
        // Advanced Search panel); everything that paints state paints them all,
        // so the stub answers with the one pill the assertions read.
        const f = /\[data-filter="([^"]+)"\]/.exec(s);
        if (f) {
          if (!pills.has(f[1])) pills.set(f[1], stubElement(`pill:${f[1]}`));
          return [pills.get(f[1])];
        }
        // The Interior / Exterior checkboxes under Illuminance Tables.
        if (/\[data-loc\]/.test(s)) {
          return ['interior', 'exterior'].map(name => {
            const id = `loc:${name}`;
            if (!elements.has(id)) {
              const el = stubElement(id);
              el.dataset.loc = name;
              elements.set(id, el);
            }
            return elements.get(id);
          });
        }
        // Per-kind result totals beside each Contents checkbox.
        if (/\[data-count-for\]/.test(s)) {
          return ['body', 'definitions', 'references', 'tables', 'interior', 'exterior'].map(kind => {
            const id = `count:${kind}`;
            if (!elements.has(id)) {
              const el = stubElement(id);
              el.dataset.countFor = kind;
              elements.set(id, el);
            }
            return elements.get(id);
          });
        }
        return [];
      },
      addEventListener() {},
      body: { style: {} },
    },
    window: { scrollTo() {}, addEventListener() {}, innerWidth: 1440, location: { search: '' } },
    location: { search: '' },
    localStorage: {
      _m: new Map(),
      getItem(k) { return this._m.get(k) ?? null; },
      setItem(k, v) { this._m.set(k, v); },
    },
    URLSearchParams, encodeURIComponent, console, setTimeout, clearTimeout,
    fetch: async () => { throw new Error('no network in tests'); },
    LensyAPI: { search: async () => ({ results: [] }) },
  };
  sandbox.globalThis = sandbox;

  ctx = vm.createContext(sandbox);
  vm.runInContext(app, ctx, { filename: 'index.html:app' });
  run = (expr) => vm.runInContext(expr, ctx);
});

// ─── DO32/DO57: the Content filter row ────────────────────────────────────────

describe('filter pills', () => {
  it('begins with every content kind selected (DO57 note 1) and the AI Guide on', () => {
    run('resetFilters()');
    expect(JSON.parse(run('JSON.stringify(filterState)'))).toEqual({
      body: true, tables: true, definitions: true, references: true,
      interior: true, exterior: true,
      // The AI Guide is on by default (client, Aug 2026) — Compare Documents is not.
      guide: true, compare: false,
    });
  });

  it('paints the AI Guide toggle pressed before any interaction', () => {
    run('renderFilterPills()');
    expect(pills.get('guide').getAttribute('aria-pressed')).toBe('true');
  });

  it('allows any combination of content kinds — nothing locks anything else', () => {
    run('resetFilters(); toggleFilter("compare")');
    for (const name of ['body', 'definitions', 'references', 'tables']) {
      expect(pills.get(name).disabled).toBe(false);
    }
    run('toggleFilter("definitions"); toggleFilter("references"); toggleFilter("body")');
    const st = JSON.parse(run('JSON.stringify(filterState)'));
    expect([st.body, st.definitions, st.references]).toEqual([false, false, false]);
    run('resetFilters()');
  });

  it('presses the AI Guide toggle in the account menu and names the action', () => {
    // On by default, so the first click switches it OFF — and the menu item
    // then offers to turn it back on (wireframe: "Disable … (or) Enable …").
    run('resetFilters(); toggleFilter("guide")');
    expect(pills.get('guide').getAttribute('aria-pressed')).toBe('false');
    expect(elements.get('menu-guide-label').textContent).toBe('Enable AI Guide');
    run('toggleFilter("guide")');
    expect(pills.get('guide').getAttribute('aria-pressed')).toBe('true');
    expect(elements.get('menu-guide-label').textContent).toBe('Disable AI Guide');
    run('resetFilters()');
  });

  // The hero hint is gone (client wireframes, 2026-08-20: "Compare Versions
  // results: delete this text") — Compare Versions is armed and run from its own
  // floating window, so the state never outlives the search it belongs to.
  it('still carries the Compare Versions state on its Library Tools control', () => {
    run('resetFilters()');
    expect(pills.get('compare').getAttribute('aria-pressed')).toBe('false');
    run('toggleFilter("compare")');
    expect(pills.get('compare').getAttribute('aria-pressed')).toBe('true');
    run('toggleFilter("compare")');
  });

  // 2026-08-20 wireframes: Illuminance Tables is the PARENT of its two
  // applications in the sidebar — toggling the kind switches both together.
  it('toggles both applications with the Illuminance Tables kind', () => {
    run('resetFilters(); toggleFilter("tables")');
    let st = JSON.parse(run('JSON.stringify(filterState)'));
    expect([st.tables, st.interior, st.exterior]).toEqual([false, false, false]);
    run('toggleFilter("tables")');
    st = JSON.parse(run('JSON.stringify(filterState)'));
    expect([st.tables, st.interior, st.exterior]).toEqual([true, true, true]);
  });

  it('excludes Illuminance Table results once both applications are cleared', () => {
    run('resetFilters(); setLocation("interior", false); setLocation("exterior", false)');
    const st = JSON.parse(run('JSON.stringify(filterState)'));
    expect(st.tables).toBe(false);
    expect(JSON.parse(run('JSON.stringify(collectFilters())')).content_types)
      .not.toContain('tables');
    // …and re-ticking one brings the kind back.
    run('setLocation("exterior", true)');
    expect(JSON.parse(run('JSON.stringify(filterState)')).tables).toBe(true);
    run('resetFilters()');
  });

  it('mirrors the panel checkboxes from the filter state', () => {
    run('resetFilters(); setLocation("interior", false)');
    const boxes = elements;
    expect(boxes.get('loc:interior').checked).toBe(false);
    expect(boxes.get('loc:exterior').checked).toBe(true);
    run('resetFilters()');
  });

  it('reset restores the defaults', () => {
    run('toggleFilter("definitions"); setLocation("interior", false); resetFilters()');
    const st = JSON.parse(run('JSON.stringify(filterState)'));
    expect(st.tables).toBe(true);
    expect(st.definitions).toBe(true);
    expect(st.interior).toBe(true);
  });

  it('sends the pill state as content_types', () => {
    run('applyFilterState({ definitions: true, body: false, tables: false, references: false })');
    expect(JSON.parse(run('JSON.stringify(collectFilters())')))
      .toEqual({ content_types: ['definitions'] });
    run('resetFilters()');
  });

  it('narrows by location only when exactly one of Interior/Exterior is on', () => {
    run('resetFilters()');
    expect(JSON.parse(run('JSON.stringify(collectFilters())')).indoor_outdoor).toBeUndefined();
    run('setLocation("interior", false)');
    expect(JSON.parse(run('JSON.stringify(collectFilters())')).indoor_outdoor).toBe('Outdoor');
    run('resetFilters()');
  });

  // A demo search that means to exclude a kind has to say so: the defaults now
  // have all four on, so a partial state would leave the others selected.
  it('lets a demo search narrow to exactly the kinds it names', () => {
    run(`applyFilterState(DEMO_SEARCHES[1].state)`);
    expect(JSON.parse(run('JSON.stringify(collectFilters())')).content_types)
      .toEqual(['references']);
    run('resetFilters()');
  });

  // An empty selection reaches the API as "no preference", which the Worker
  // answers with its own defaults — so the page refuses the search instead.
  it('refuses to search with no content kind selected', () => {
    run(`resetFilters();
         toggleFilter('body'); toggleFilter('definitions'); toggleFilter('references');
         setLocation('interior', false); setLocation('exterior', false)`);
    expect(run('anyContentSelected()')).toBe(false);
    expect(JSON.parse(run('JSON.stringify(collectFilters())')).content_types).toBeUndefined();
    run('resetFilters()');
    expect(run('anyContentSelected()')).toBe(true);
  });
});

// ─── DO32: result-card labels ─────────────────────────────────────────────────

describe('result-card type labels', () => {
  it('calls a body excerpt a "Document", not "Document Body"', () => {
    const styles = JSON.parse(run('JSON.stringify(RESULT_TYPE_STYLES)'));
    expect(styles.excerpt.label).toBe('Document');
    expect(styles.application.label).toBe('Illuminance Table');
    expect(styles.reference.label).toBe('Reference');
    expect(styles.definition.label).toBe('Definition');
  });

  // DO38 gives the line style a MEANING rather than just making types
  // distinguishable: solid = the whole document, dashed = a part of the whole.
  it('uses solid for Document and dashed for every extract type', () => {
    const styles = JSON.parse(run('JSON.stringify(RESULT_TYPE_STYLES)'));
    expect(styles.excerpt.line).toBe('solid');
    expect(styles.application.line).toBe('dashed');
    expect(styles.reference.line).toBe('dashed');
    expect(styles.definition.line).toBe('dashed');
  });

  it('still gives every type its own chip palette and banner colour', () => {
    const styles = JSON.parse(run('JSON.stringify(RESULT_TYPE_STYLES)'));
    const chips = Object.values(styles).map(s => s.chip);
    expect(new Set(chips).size).toBe(chips.length);
    for (const s of Object.values(styles)) {
      expect(s.banner).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
  });

  it('uses the Interior/Exterior fills the client specified', () => {
    const fill = JSON.parse(run('JSON.stringify(LOCATION_FILL)'));
    expect(fill.Indoor).toBe('#2E4A62');
    expect(fill.Outdoor).toBe('#2E4A34');
  });
});

// ─── DO34: authoring committee credit ─────────────────────────────────────────

describe('committee credit', () => {
  it('links an exact committee match to its own page', () => {
    const html = run(`committeeHtml({ committee: {
      name: 'IES Retail Lighting Committee',
      url: 'https://ies.org/committee/retail-lighting/', exact: true } })`);
    expect(html).toContain('IES Retail Lighting Committee');
    expect(html).toContain('href="https://ies.org/committee/retail-lighting/"');
    expect(html).toContain('roster');
    expect(html).not.toContain('↗'); // the arrow marks the fallback only
  });

  it('marks a fallback to the root committee list', () => {
    const html = run(`committeeHtml({ committee: {
      name: 'IES Ad Hoc Working Group',
      url: 'https://ies.org/about/committees/technical-committees/', exact: false } })`);
    expect(html).toContain('technical-committees');
    expect(html).toContain('↗');
    expect(html).toContain('no current page');
  });

  it('renders nothing when the standard has no committee attribution', () => {
    expect(run('committeeHtml({})')).toBe('');
    expect(run('committeeHtml({ committee: null })')).toBe('');
  });
});

// ─── DO33: Definition result card ─────────────────────────────────────────────

describe('Definition result card', () => {
  const result = `{
    resultType: 'definition', relevanceScore: 1,
    citationName: 'ANSI/IES LS-1-25 Lighting Science: Nomenclature and Definitions for Illuminating Engineering',
    citationPage: null,
    standardLink: 'https://ies.org/definitions/color/',
    vitriumLink: 'https://ies.org/definitions/color/',
    definition: { slug: 'color', term: 'color', clause: '4.1',
      html: '<p>[4.1] The characteristic of <strong>light</strong> by which an observer can distinguish.</p>',
      sourceUrl: 'https://ies.org/definitions/color/' },
    excerpt: { text: '[4.1] The characteristic of light.' }
  }`;

  it('prints the term, the clause, the LS-1 title and the rich text', () => {
    const card = run(`renderDefinitionCard(${result}, 0)`);
    expect(card).toContain('Definition');
    expect(card).toContain('§4.1');
    expect(card).toContain('Lighting Science: Nomenclature');
    expect(card).toContain('<strong>light</strong>');
    expect(card).toContain('definition-body');
    expect(card).toContain('Open Definition');
  });

  it('emits no script or event-handler markup', () => {
    const card = run(`renderDefinitionCard(${result}, 0)`);
    expect(card).not.toMatch(/<script/i);
    expect(card).not.toMatch(/\son[a-z]+=/i);
  });

  it('falls back to the plain excerpt for responses cached before the rich text', () => {
    const card = run(`renderDefinitionCard({ resultType: 'definition', relevanceScore: 0.8,
      citationName: 'ANSI/IES LS-1-25', citationPage: null,
      definition: { slug: 'glare', term: 'glare', clause: null, html: '', sourceUrl: null },
      excerpt: { text: 'Sensation produced by luminances in the field of view.' } }, 0)`);
    expect(card).toContain('Sensation produced by luminances');
  });

  it('is what renderResultCard picks for a definition result', () => {
    const card = run(`renderResultCard({ key: 'k', members: [${result}] }, 0)`);
    expect(card).toContain('definition-body');
  });
});

// ─── DO31.3: DOI locators ─────────────────────────────────────────────────────

describe('inline locator links', () => {
  it('leaves a prefix-only DOI as plain text', () => {
    const out = run(`linkifyText('See https://doi.org/10.1080 for details')`);
    expect(out).not.toContain('<a ');
  });

  it('still links a complete DOI', () => {
    const out = run(`linkifyText('See https://doi.org/10.1080/00994480.2020.1750207')`);
    expect(out).toContain('href="https://doi.org/10.1080/00994480.2020.1750207"');
  });

  it('links a bare DOI with a suffix and skips one without', () => {
    expect(run(`linkifyText('doi 10.1002/9781118534113')`)).toContain('<a ');
    expect(run(`linkifyText('doi 10.1002/')`)).not.toContain('<a ');
  });
});

// ─── DO20: Lighting Zone is always visible ────────────────────────────────────

describe('lighting zone badge', () => {
  it('prints the zone when it is not already one of the hierarchy crumbs', () => {
    const out = run(`rowBadges({ category: 'Ramps, Stairs, and Steps', sub1: 'Low activity',
      outdoor: { lightingZone: 'Lz3 (and Lz4 curfew)' } })`);
    expect(out).toContain('Lz3 (and Lz4 curfew)');
  });

  it('does not duplicate a zone already shown as a crumb', () => {
    const out = run(`rowBadges({ category: 'Ramps', sub1: 'Low activity', sub2: 'Lz4',
      outdoor: { lightingZone: 'Lz4' } })`);
    expect(out).not.toContain('Lz4');
  });

  it('is silent for rows with no zone', () => {
    expect(run(`rowBadges({ category: 'Fitting room', outdoor: {} })`)).toBe('');
  });
});

// ─── DO29: passage count ──────────────────────────────────────────────────────

describe('"From the Standard" passage count', () => {
  const passages = (n) => JSON.stringify(Array.from({ length: n }, (_, i) => ({
    text: `Lighting guidance passage number ${i} describing an application in prose form for the reader.`,
    chunkType: 'text', pageNumber: 10 + i,
  })));

  it('reads "Top 10 passages" once the cap is reached', () => {
    const out = run(`renderDataBlocks({ application: {}, excerpts: ${passages(14)} }, new Set())`);
    expect(out).toContain('Top 10 passages');
  });

  it('reads a plain count below the cap', () => {
    const out = run(`renderDataBlocks({ application: {}, excerpts: ${passages(3)} }, new Set())`);
    expect(out).toContain('3 passages');
    expect(out).not.toContain('Top 3');
  });
});

// ─── DO32: recent + demo searches ─────────────────────────────────────────────

describe('search suggestions', () => {
  it('remembers a performed query and offers it back', () => {
    run(`rememberSearch('What are considerations for lighting parking garages?')`);
    expect(JSON.parse(run('JSON.stringify(recentSearches())'))[0])
      .toBe('What are considerations for lighting parking garages?');
  });

  it('renders both the Recent and the "Try searching for" sections', () => {
    run(`document.getElementById('search-input').value = ''; renderSuggestions()`);
    const box = elements.get('search-suggestions').innerHTML;
    expect(box).toContain('Recent');
    expect(box).toContain('Try searching for');
  });

  it('de-duplicates and caps the recent list', () => {
    for (let i = 0; i < 9; i++) run(`rememberSearch('query ${i}')`);
    run(`rememberSearch('query 8')`);
    const recent = JSON.parse(run('JSON.stringify(recentSearches())'));
    expect(recent.length).toBeLessThanOrEqual(5);
    expect(recent[0]).toBe('query 8');
    expect(new Set(recent).size).toBe(recent.length);
  });
});

// ─── DO40: section number + title on body excerpts ────────────────────────────

describe('section heading on a Document excerpt', () => {
  const excerpt = `{
    text: 'In providing higher light levels for persons with low vision, every room or space should have ambient illumination.',
    chunkType: 'text', pageNumber: 39, section: '3.3.4',
    sectionTitle: 'Circulation Areas',
    sectionPath: [
      { number: '3', title: 'Design Guide' },
      { number: '3.3', title: 'Transition Spaces Between Exterior and Interior Spaces' },
      { number: '3.3.4', title: 'Circulation Areas' }
    ]
  }`;

  it('prints the number with every parent title, bolded', () => {
    const html = run(`sectionPathHtml(${excerpt})`);
    expect(html).toContain('font-bold');
    expect(html).toContain('3.3.4');
    expect(html).toContain('Design Guide');
    expect(html).toContain('Transition Spaces Between Exterior and Interior Spaces');
    expect(html).toContain('Circulation Areas');
  });

  it('falls back to the bare number when no titles were indexed', () => {
    const html = run(`sectionPathHtml({ section: '5.2' })`);
    expect(html).toContain('5.2');
    expect(html).not.toContain('›');
  });

  it('renders inside "From the Standard", replacing the duplicated § locator', () => {
    const out = run(`renderDataBlocks({ application: {}, excerpts: [${excerpt}] }, new Set())`);
    expect(out).toContain('Circulation Areas');
    expect(out).toContain('p. 39');
    expect(out).not.toContain('§3.3.4');
  });

  it('still heads an untitled section with its number, printed once', () => {
    const out = run(`renderDataBlocks({ application: {}, excerpts: [
      { text: 'A passage of prose long enough to render as a body excerpt on a card.',
        chunkType: 'text', pageNumber: 12, section: '5.2' }
    ] }, new Set())`);
    expect(out).toContain('font-bold text-gray-800 mb-1">5.2<');
    expect(out).not.toContain('§5.2');   // never both
  });
});

describe('same-section Document results are one card (DO40)', () => {
  const doc = (section, page) => `{
    resultType: 'excerpt', relevanceScore: 0.5,
    application: { standard: 'RP-28-25', code: 'RP-28-25-p${page}' },
    excerpt: { text: 'Passage ${page} of the section, long enough to survive the prose filter on a card.',
               chunkType: 'text', pageNumber: ${page}, section: '${section}' }
  }`;

  it('groups passages of one section, and keeps other sections apart', () => {
    const groups = JSON.parse(run(`JSON.stringify(groupSiblingResults([
      ${doc('3.3.4', 39)}, ${doc('4.1', 55)}, ${doc('3.3.4', 40)}
    ]).map(g => g.members.length))`));
    expect(groups).toEqual([2, 1]);
  });

  it('merges their passages into one list, in page order', () => {
    const merged = JSON.parse(run(`JSON.stringify(mergeDocumentGroup([${doc('3.3.4', 41)}, ${doc('3.3.4', 39)}]))`));
    expect(merged.excerpts.map(e => e.pageNumber)).toEqual([39, 41]);
  });

  it('heads the card with the section it came from', () => {
    const card = run(`renderResultCard({ key: 'k', members: [${doc('3.3.4', 39)}, ${doc('3.3.4', 40)}] }, 0)`);
    expect(card).toContain('3.3.4');
    expect(card).toContain('border-left: 3px solid');   // solid = the whole document
  });
});

// ─── DO41: a pasted "Sample Search:" label never reaches the query ────────────

describe('pasted label', () => {
  it('is stripped from the search box', () => {
    expect(run(`stripQueryLabel("Sample Search: What's new in the latest version of rp-8?")`))
      .toBe("What's new in the latest version of rp-8?");
  });

  it('leaves an ordinary query alone', () => {
    expect(run(`stripQueryLabel('search and rescue lighting')`)).toBe('search and rescue lighting');
  });
});

// ─── DO44: reference markers open the FIRST printed marker ────────────────────

describe('reference marker footnote', () => {
  it('says the link opens where the marker is FIRST printed', () => {
    const html = run(`referenceMarkersBlock({ referenceMarkers: [
      { standard: 'G-1-22', standardFull: 'ANSI/IES G-1-22', count: 6, pageNumber: 12,
        referenceNumber: 6, target: 'citation', url: 'https://view.protectedpdf.com/g1#page=12' }
    ] })`);
    expect(html).toContain('first printed');
    expect(html).toContain('first cites this reference');
  });
});

// ─── DO47: a whole-document result card ───────────────────────────────────────

describe('Document card for a designation search', () => {
  const result = `{
    resultType: 'standard', relevanceScore: 1,
    citationName: 'ANSI/IES RP-3-20+E1 Recommended Practice: Lighting Educational Facilities',
    citationPage: null,
    standardLink: 'https://view.protectedpdf.com/rp3',
    vitriumLink: 'https://view.protectedpdf.com/rp3',
    committee: { name: 'IES Education, Library and Office Lighting Committee',
                 url: 'https://ies.org/committee/education-library-office-lighting/', exact: true },
    application: { standard: 'RP-3-20+E1', code: 'standard:RP-3-20+E1' },
    document: { id: 'RP-3-20+E1', designation: 'ANSI/IES RP-3-20+E1',
                title: 'Recommended Practice: Lighting Educational Facilities',
                description: 'Best practices to light classrooms and corridors.',
                thumbnailUrl: 'https://ies.org/cover.jpg', buyUrl: 'https://store.ies.org/rp-3',
                collection: 'Lighting Applications', matchedOn: 'designation' }
  }`;

  it('prints the designation, the full title, the description and the thumbnail', () => {
    const card = run(`renderStandardCard(${result}, 0)`);
    expect(card).toContain('RP-3-20+E1');
    expect(card).toContain('Recommended Practice: Lighting Educational Facilities');
    expect(card).toContain('Best practices to light classrooms');
    expect(card).toContain('https://ies.org/cover.jpg');
  });

  it('hyperlinks the authoring committee and offers the document itself', () => {
    const card = run(`renderStandardCard(${result}, 0)`);
    expect(card).toContain('IES Education, Library and Office Lighting Committee');
    expect(card).toContain('Open in Library');
    expect(card).toContain('Bookmark');
    expect(card).toContain('https://store.ies.org/rp-3');
  });

  it('reads as a Document — same label and line style as a body excerpt (DO32/DO38)', () => {
    const card = run(`renderStandardCard(${result}, 0)`);
    expect(card).toContain('>Document<');
    expect(card).toContain('border-left: 3px solid');
  });

  it('is what renderResultCard picks for a standard result', () => {
    const card = run(`renderResultCard({ key: 'k', members: [${result}] }, 0)`);
    expect(card).toContain('Best practices to light classrooms');
  });

  it('marks a deprecated edition and withholds the Bookmark button', () => {
    const card = run(`renderStandardCard({ ...${result}, isDeprecated: true,
      deprecationNotice: 'ANSI/IES RP-8-22 is deprecated and has been replaced by RP-8-25+E2.' }, 0)`);
    expect(card).toContain('Deprecated');
    expect(card).toContain('replaced by RP-8-25+E2');
    expect(card).not.toContain('save-search-btn');
  });

  it('emits no script or event-handler markup', () => {
    const card = run(`renderStandardCard(${result}, 0)`);
    expect(card).not.toMatch(/<script/i);
    expect(card).not.toMatch(/\son[a-z]+=/i);
  });
});

// ─── DO42: one name for the AI Guide ──────────────────────────────────────────

describe('AI Guide naming', () => {
  it('calls the guide answer "AI Guide", matching the Enable Guide pill', () => {
    run(`renderAISummary({ text: 'Guidance.', disclaimer: '', watermark: '' })`);
    expect(elements.get('ai-summary-title').textContent).toBe('AI Guide');
  });

  it('keeps the comparison and references modes named for what they are', () => {
    run(`renderAISummary({ text: 'x', mode: 'comparison', disclaimer: '', watermark: '' })`);
    expect(elements.get('ai-summary-title').textContent).toBe('AI Document Comparison');
    run(`renderAISummary({ text: 'x', mode: 'references', disclaimer: '', watermark: '' })`);
    expect(elements.get('ai-summary-title').textContent).toBe('AI Guide — References');
  });
});

// ─── DO54: Definition cards are saveable ──────────────────────────────────────

describe('Bookmark button on a Definition card', () => {
  const definition = `{
    resultType: 'definition', relevanceScore: 1,
    citation: 'ANSI/IES LS-1-25, §4.1.5',
    citationName: 'ANSI/IES LS-1-25 Lighting Science: Nomenclature and Definitions',
    citationPage: null,
    vitriumLink: 'https://ies.org/definitions/goniophotometer/',
    definition: { slug: 'goniophotometer', term: 'goniophotometer', clause: '4.1.5',
      html: '<p>A photometer for measuring the directional light distribution.</p>',
      sourceUrl: 'https://ies.org/definitions/goniophotometer/' },
    excerpt: { text: 'A photometer for measuring the directional light distribution.' }
  }`;

  it('offers the same "+ Bookmark" button the other cards offer', () => {
    const card = run(`renderDefinitionCard(${definition}, 0)`);
    expect(card).toContain('Bookmark');
    expect(card).toContain('save-search-btn');
    expect(card).toContain('Open Definition');
  });

  it('saves it as a Definition, with the slug and no body text', () => {
    const payload = JSON.parse(run(`JSON.stringify(buildSavePayload(${definition}, 'goniophotometer'))`));
    expect(payload.result_type).toBe('definitions');
    expect(payload.definition_slug).toBe('goniophotometer');
    expect(payload.reference_text).toBeNull();
    expect(payload.application_name).toBeNull();
  });
});

// ─── DO50: a user note on the Save Search window ──────────────────────────────

describe('save-search note', () => {
  it('travels with every payload being saved', () => {
    run(`modalPendingCodes = [{ result_type: 'body', resource_title: 'A' }, { result_type: 'body', resource_title: 'B' }];
         document.getElementById('save-note').value = '  Needed for the atrium  '`);
    const out = JSON.parse(run('JSON.stringify(pendingWithNote())'));
    expect(out.every(p => p.note === 'Needed for the atrium')).toBe(true);
  });

  it('is omitted entirely when left blank', () => {
    run(`modalPendingCodes = [{ result_type: 'body', resource_title: 'A' }];
         document.getElementById('save-note').value = '   '`);
    expect(JSON.parse(run('JSON.stringify(pendingWithNote())'))[0].note).toBeUndefined();
  });
});

// ─── DO53: LensyLite ──────────────────────────────────────────────────────────

describe('LensyLite', () => {
  it('is off by default — every tool is available', () => {
    run(`applyTier('full'); resetFilters()`);
    expect(elements.get('wordmark').textContent).toBe('Lensy');
    expect(pills.get('tables').disabled).toBe(false);
    expect(JSON.parse(run('JSON.stringify(filterState)')).tables).toBe(true);
  });

  it('renames the product and locks the three tools a subscription unlocks', () => {
    run(`applyTier('lite')`);
    expect(elements.get('wordmark').textContent).toBe('LensyLite');
    for (const name of ['tables', 'guide', 'compare']) {
      expect(pills.get(name).disabled).toBe(true);
      expect(pills.get(name).title).toContain('Lighting Library subscription');
    }
    // …and leaves the rest of the tools alone.
    expect(pills.get('body').disabled).toBe(false);
    expect(pills.get('definitions').disabled).toBe(false);
    expect(pills.get('references').disabled).toBe(false);
  });

  it('shows the upgrade banner in the client\'s words', () => {
    run(`applyTier('lite')`);
    expect(elements.get('lite-banner').classList.contains('hidden')).toBe(false);
    expect(elements.get('lite-banner-text').textContent)
      .toContain('IES Members receive limited access to Lighting Science Collection');
  });

  it('never lets a locked tool be switched on', () => {
    run(`applyTier('lite'); resetFilters(); toggleFilter('tables'); toggleFilter('guide')`);
    const state = JSON.parse(run('JSON.stringify(filterState)'));
    expect(state.tables).toBe(false);
    expect(state.guide).toBe(false);
    // A demo search that asks for them is normalized too.
    run(`applyFilterState({ tables: true, guide: true, compare: true })`);
    const demo = JSON.parse(run('JSON.stringify(filterState)'));
    expect(demo.tables || demo.guide || demo.compare).toBe(false);
    expect(demo.body).toBe(true);   // never left with nothing selected
  });

  it('sends no blocked content type to the API', () => {
    run(`applyTier('lite'); resetFilters()`);
    const filters = JSON.parse(run('JSON.stringify(collectFilters())'));
    expect(filters.content_types || []).not.toContain('tables');
    expect(filters.content_types || []).not.toContain('compare');
    run(`applyTier('full'); resetFilters()`);
  });
});

// ─── DO59: sequential Document cards from one standard are joined ─────────────

describe('joined Document cards', () => {
  const doc = (std, section, page) => `{
    resultType: 'excerpt', relevanceScore: 0.5,
    citationName: 'ANSI/IES ${std} Recommended Practice: Landscape Lighting',
    citationPage: ${page},
    application: { standard: '${std}' },
    excerpt: { text: 'Passage on page ${page}, long enough in prose to survive the table-dump filter.',
               chunkType: 'text', pageNumber: ${page}, section: '${section}' }
  }`;

  const groupsOf = (results) =>
    JSON.parse(run(`JSON.stringify(joinDocumentGroups(groupSiblingResults([${results.join(',')}]))
      .map(g => g.joined ? { standard: g.standard, sections: g.sections.length } : { single: true }))`));

  it('collects adjacent sections of one standard into a single card', () => {
    expect(groupsOf([doc('RP-47-23', '7.5', 30), doc('RP-47-23', '2.1', 13)]))
      .toEqual([{ standard: 'RP-47-23', sections: 2 }]);
  });

  it('does not join across a different document', () => {
    expect(groupsOf([doc('RP-47-23', '7.5', 30), doc('RP-2-20', '4.1', 8), doc('RP-47-23', '2.1', 13)]))
      .toEqual([
        { standard: 'RP-47-23', sections: 1 },
        { standard: 'RP-2-20', sections: 1 },
        { standard: 'RP-47-23', sections: 1 },
      ].map(g => ({ single: true })));
  });

  it('renders one shell with one panel per section, each keeping its own citation', () => {
    const html = run(`renderJoinedDocumentCard({ joined: true, standard: 'RP-47-23', sections: [
      { key: 'a', members: [${doc('RP-47-23', '7.5', 30)}] },
      { key: 'b', members: [${doc('RP-47-23', '2.1', 13)}] }
    ] }, 0)`);
    expect((html.match(/<article/g) || []).length).toBe(3);       // shell + 2 sections
    expect((html.match(/border-left: 3px solid/g) || []).length).toBe(1); // stripe on the shell only
    expect(html).toContain('7.5');
    expect(html).toContain('2.1');
    expect((html.match(/p\.&nbsp;30/g) || []).length).toBe(1);
    expect((html.match(/p\.&nbsp;13/g) || []).length).toBe(1);
  });

  it('leaves a deprecated edition as its own card, so editions never share a box', () => {
    const groups = groupsOf([
      doc('RP-8-25', '5.1', 40),
      `{ ...${doc('RP-8-22', '5.1', 38)}, isDeprecated: true }`,
    ]);
    expect(groups).toEqual([{ single: true }, { single: true }]);
  });
});

// ─── DO60: "FROM THE STANDARD" reads as a control ─────────────────────────────

describe('"From the Standard" prominence', () => {
  const passages = (n) => JSON.stringify(Array.from({ length: n }, (_, i) => ({
    text: `Lighting guidance passage number ${i} describing an application in prose for the reader.`,
    chunkType: 'text', pageNumber: 10 + i,
  })));

  it('prints the heading and the passage count in bold black', () => {
    const out = run(`renderDataBlocks({ application: {}, excerpts: ${passages(2)} }, new Set())`);
    expect(out).toContain('font-bold text-gray-900 uppercase tracking-wider">From the Standard');
    expect(out).toContain('font-bold text-gray-900">— 2 passages');
    expect(out).not.toContain('font-semibold text-gray-400 uppercase');
  });
});

// ─── DO61: "+ Save Again" for a result already in a collection ─────────────────

describe('Bookmark / Bookmark Again', () => {
  const result = `{
    resultType: 'application', relevanceScore: 0.9,
    citation: 'ANSI/IES RP-6-24, Table A-2, Row 205, p. 83',
    citationName: 'ANSI/IES RP-6-24 Recommended Practice: Lighting Sports and Recreational Areas',
    citationPage: 83,
    vitriumLink: 'https://view.protectedpdf.com/rp6#page=83',
    application: { standard: 'RP-6-24', code: 'RP-6-24_205', fullName: 'Soccer — Class I' }
  }`;

  it('offers "Bookmark" for a result that is not saved yet', () => {
    run('savedResultKeys = new Set()');
    const html = run(`saveSearchButton(${result}, 'Soccer')`);
    expect(html).toContain('>Bookmark<');
    expect(html).not.toContain('Bookmark Again');
    expect(html).toContain('background-color: var(--brand-secondary)');
  });

  it('reads "Bookmark Again" in a less saturated fill once it is saved', () => {
    run(`savedResultKeys = new Set([savedResultKey(${result})])`);
    const html = run(`saveSearchButton(${result}, 'Soccer')`);
    expect(html).toContain('Bookmark Again');
    expect(html).toContain('background-color: #8FA3B4');
    expect(html).toContain('Already in one of your Bookmark Collections');
    run('savedResultKeys = new Set()');
  });

  it('keys a result by its own identity, not by the display name passed to the button', () => {
    const a = run(`savedResultKey(${result})`);
    const b = run(`savedResultKey({ ...${result}, application: { ...(${result}).application, code: 'RP-6-24_206' } })`);
    expect(a).not.toBe(b);
    // The same result reached from a different card context keys identically.
    expect(run(`savedResultKey(${result})`)).toBe(a);
  });

  it('carries the key on the button so a completed save can flip it', () => {
    const html = run(`saveSearchButton(${result}, 'Soccer')`);
    expect(html).toContain(`data-save-key="${run(`savedResultKey(${result})`).replace(/&/g, '&amp;')}"`);
  });

  it('is never offered on a deprecated comparison card', () => {
    expect(run(`saveSearchButton({ ...${result}, isDeprecated: true }, 'Soccer')`)).toBe('');
  });
});

// ─── DO27: comparison advisory names one prior edition ────────────────────────

describe('comparison notice', () => {
  it('states the pair being compared and lists older editions separately', () => {
    const notice = run(`buildComparisonNotice({
      current: { id: 'RP-8-25+E2', name: 'ANSI/IES RP-8-25+E2', url: 'https://view.protectedpdf.com/a' },
      deprecated: [{ id: 'RP-8-22', name: 'ANSI/IES RP-8-22', url: 'https://view.protectedpdf.com/b' }],
      alsoDeprecated: [
        { id: 'RP-8-18', name: 'ANSI/IES RP-8-18', url: null },
        { id: 'RP-8-14', name: 'ANSI/IES RP-8-14', url: null },
      ],
    })`);
    expect(notice).toContain('ANSI/IES RP-8-22');
    expect(notice).toContain('replaced by the current');
    expect(notice).toContain('between those two editions only');
    expect(notice).toContain('Earlier deprecated editions');
    expect(notice).toContain('ANSI/IES RP-8-18');
  });

  it('is empty without a comparison', () => {
    expect(run('buildComparisonNotice(null)')).toBe('');
  });
});

// ─── 2026-08-20 wireframes: client-side sort ──────────────────────────────────

describe('result sorting', () => {
  const r = (std, committee, score) => `{
    resultType: 'excerpt', relevanceScore: ${score},
    citationName: 'ANSI/IES ${std} Some Title',
    application: { standard: '${std}' },
    committee: ${committee ? `{ name: '${committee}' }` : 'null'},
    excerpt: { text: 'x', chunkType: 'text', pageNumber: 1 }
  }`;

  it('defaults to the API order (Relevance)', () => {
    run(`sortState = { key: 'relevance', dir: 'asc' }`);
    const out = JSON.parse(run(`JSON.stringify(sortResults([${r('RP-10-20', null, 0.9)}, ${r('RP-2-20', null, 0.8)}])
      .map(x => x.application.standard))`));
    expect(out).toEqual(['RP-10-20', 'RP-2-20']);
  });

  it('sorts designations numerically — RP-2 before RP-10', () => {
    run(`sortState = { key: 'designation', dir: 'asc' }`);
    const out = JSON.parse(run(`JSON.stringify(sortResults([${r('RP-10-20', null, 0.9)}, ${r('RP-2-20', null, 0.8)}])
      .map(x => x.application.standard))`));
    expect(out).toEqual(['RP-2-20', 'RP-10-20']);
  });

  it('sorts by edition year and keeps unsortable results last, whatever the direction', () => {
    run(`sortState = { key: 'date', dir: 'desc' }`);
    const out = JSON.parse(run(`JSON.stringify(sortResults([
      ${r('RP-8-18', null, 0.9)}, ${r('RP-6-24', null, 0.8)},
      { resultType: 'excerpt', citationName: 'No designation here', excerpt: { text: 'x' } }
    ]).map(x => x.application ? x.application.standard : null))`));
    expect(out).toEqual(['RP-6-24', 'RP-8-18', null]);
    run(`sortState = { key: 'relevance', dir: 'asc' }`);
  });

  it('sorts by the authoring committee name', () => {
    run(`sortState = { key: 'committee', dir: 'asc' }`);
    const out = JSON.parse(run(`JSON.stringify(sortResults([
      ${r('RP-6-24', 'IES Sports Lighting Committee', 0.9)},
      ${r('RP-1-24', 'IES Education Committee', 0.8)}
    ]).map(x => x.committee.name))`));
    expect(out).toEqual(['IES Education Committee', 'IES Sports Lighting Committee']);
    run(`sortState = { key: 'relevance', dir: 'asc' }`);
  });

  it('reads the edition year off the designation', () => {
    expect(run(`editionYearOf('RP-8-25+E2')`)).toBe(2025);
    expect(run(`editionYearOf('LM-63-19R25')`)).toBe(2019);
    expect(run(`editionYearOf('ANSI/IES RP-16-17')`)).toBe(2017);
    expect(run(`editionYearOf('nonsense')`)).toBe(null);
  });
});

// ─── 2026-08-20 wireframes: Documents narrowing in the sidebar ────────────────

describe('Documents narrowing', () => {
  it('derives the publication type from the designation, org prefixes included', () => {
    expect(run(`pubTypeOf('RP-3-20+E1')`)).toBe('RP');
    expect(run(`pubTypeOf('ANSI/IES/ALA RP-11-26')`)).toBe('RP');
    expect(run(`pubTypeOf('LEM-1-90')`)).toBe('LEM');
    expect(run(`pubTypeOf('not a designation')`)).toBe(null);
  });

  it('is inactive while everything — or nothing — is selected', () => {
    run(`docFilterUniverse = { pubtype: [{value:'RP',label:'x'},{value:'LM',label:'y'}], title: [], committee: [] };
         docFilterSelected = { pubtype: new Set(['RP','LM']), title: new Set(), committee: new Set() }`);
    expect(run(`docGroupActive('pubtype')`)).toBe(false);
    expect(run(`passesDocFilters({ application: { standard: 'LM-63-19' } })`)).toBe(true);
    run(`docFilterSelected.pubtype = new Set()`);
    expect(run(`docGroupActive('pubtype')`)).toBe(false);
    expect(run(`passesDocFilters({ application: { standard: 'LM-63-19' } })`)).toBe(true);
  });

  it('narrows to the selected publication types once a real subset is chosen', () => {
    run(`docFilterSelected.pubtype = new Set(['RP'])`);
    expect(run(`passesDocFilters({ application: { standard: 'RP-6-24' } })`)).toBe(true);
    expect(run(`passesDocFilters({ application: { standard: 'LM-63-19' } })`)).toBe(false);
  });

  it('matches Title selections by family, so deprecated editions stay with their standard', () => {
    run(`docFilterSelected.pubtype = new Set(['RP','LM']);
         docFilterUniverse.title = [{value:'RP-8-25+E2',label:'a'},{value:'RP-6-24',label:'b'}];
         docFilterSelected.title = new Set(['RP-8-25+E2'])`);
    expect(run(`passesDocFilters({ application: { standard: 'RP-8-22' }, isDeprecated: true })`)).toBe(true);
    expect(run(`passesDocFilters({ application: { standard: 'RP-6-24' } })`)).toBe(false);
    run(`resetFilters()`);
  });

  it('counts only APPLIED narrowing in the FILTER badge', () => {
    run(`resetFilters()`);
    expect(run(`filterAppliedTotal()`)).toBe(4);   // the four content kinds, nothing narrowed
    run(`docFilterSelected.pubtype = new Set(['RP'])`);
    expect(run(`filterAppliedTotal()`)).toBe(5);
    run(`resetFilters()`);
    expect(run(`filterAppliedTotal()`)).toBe(4);
  });
});

// ─── 2026-08-20 wireframes: Compare Versions overlay ──────────────────────────

describe('Compare Versions overlay', () => {
  it('builds the comparison query in the phrasing the comparison path answers', () => {
    expect(run(`buildCompareQuery(' RP-8 ')`)).toBe('What is new in the current version of RP-8?');
  });
});

// ─── 2026-08-20: AI curation — "Cited by AI Guide" badges ─────────────────────

describe('AI curation badges', () => {
  const cited = `{
    resultType: 'excerpt', relevanceScore: 0.7, citedByGuide: true,
    citationName: 'ANSI/IES RP-8-25+E2 Recommended Practice: Lighting Roadway and Parking Facilities',
    citationPage: 21,
    application: { standard: 'RP-8-25+E2' },
    excerpt: { text: 'A passage of prose long enough to survive the table-dump filter on a card.',
               chunkType: 'text', pageNumber: 21, section: '4.2' }
  }`;

  it('badges a card the AI Guide cites', () => {
    const card = run(`renderResultCard({ key: 'k', members: [${cited}] }, 0)`);
    expect(card).toContain('Cited by AI Guide');
  });

  it('leaves an uncited card unbadged', () => {
    const card = run(`renderResultCard({ key: 'k', members: [{ ...${cited}, citedByGuide: false }] }, 0)`);
    expect(card).not.toContain('Cited by AI Guide');
  });

  it('badges a merged section card when ANY of its passages was cited', () => {
    const card = run(`renderResultCard({ key: 'k', members: [
      { ...${cited}, citedByGuide: false },
      { ...${cited}, citedByGuide: true,
        excerpt: { text: 'Second passage of the same section, also long enough to render.',
                   chunkType: 'text', pageNumber: 22, section: '4.2' } }
    ] }, 0)`);
    expect(card).toContain('Cited by AI Guide');
  });

  it('badges Definition and whole-document cards the same way', () => {
    const def = run(`renderDefinitionCard({ resultType: 'definition', relevanceScore: 1, citedByGuide: true,
      citationName: 'ANSI/IES LS-1-25', citationPage: null,
      definition: { slug: 'glare', term: 'glare', clause: '4.9', html: '<p>x</p>', sourceUrl: null },
      excerpt: { text: 'Sensation produced by luminances.' } }, 0)`);
    expect(def).toContain('Cited by AI Guide');

    const std = run(`renderStandardCard({ resultType: 'standard', relevanceScore: 1, citedByGuide: true,
      citationName: 'ANSI/IES RP-3-20+E1', citationPage: null,
      application: { standard: 'RP-3-20+E1' },
      document: { id: 'RP-3-20+E1', designation: 'ANSI/IES RP-3-20+E1', title: 'T', description: 'D',
                  thumbnailUrl: null, buyUrl: null, collection: null, matchedOn: 'designation' } }, 0)`);
    expect(std).toContain('Cited by AI Guide');
  });
});

// ─── 2026-08-20 wireframes: the low-confidence tail ───────────────────────────

describe('low-confidence matches', () => {
  const hit = (score, over = '') => `{
    resultType: 'excerpt', relevanceScore: ${score},
    citationName: 'ANSI/IES RP-8-25+E2 Title', citationPage: 21,
    application: { standard: 'RP-8-25+E2' },
    excerpt: { text: 'A passage of prose long enough to survive the filter.', chunkType: 'text', pageNumber: 21 }
    ${over}
  }`;

  it('splits the pool at the threshold the server sent', () => {
    const split = JSON.parse(run(`confidenceThreshold = 0.6;
      sortState = { key: 'relevance', dir: 'asc' };
      JSON.stringify((() => {
        const s = splitByConfidence([${hit(0.9)}, ${hit(0.7)}, ${hit(0.4)}, ${hit(0.2)}]);
        return { shown: s.shown.length, hidden: s.hidden.length };
      })())`));
    expect(split).toEqual({ shown: 2, hidden: 2 });
  });

  it('treats a whole-document card as confident whatever it scored', () => {
    expect(run(`isHighConfidence({ resultType: 'standard', relevanceScore: 0.1 })`)).toBe(true);
    expect(run(`isHighConfidence({ resultType: 'excerpt', relevanceScore: 0.1 })`)).toBe(false);
  });

  it('does not split under a sort where "weaker below" would be a lie', () => {
    const split = JSON.parse(run(`sortState = { key: 'title', dir: 'asc' };
      JSON.stringify((() => {
        const s = splitByConfidence([${hit(0.9)}, ${hit(0.2)}]);
        return { shown: s.shown.length, hidden: s.hidden.length };
      })())`));
    expect(split).toEqual({ shown: 2, hidden: 0 });
    run(`sortState = { key: 'relevance', dir: 'asc' }`);
  });

  it('shows the whole list rather than an empty page when nothing clears the bar', () => {
    const split = JSON.parse(run(`sortState = { key: 'relevance', dir: 'asc' };
      JSON.stringify((() => {
        const s = splitByConfidence([${hit(0.3)}, ${hit(0.2)}]);
        return { shown: s.shown.length, hidden: s.hidden.length };
      })())`));
    expect(split).toEqual({ shown: 2, hidden: 0 });
  });

  it('offers the bar as a read-more element naming how many are folded away', () => {
    const html = run(`renderLowConfidenceBar(7)`);
    expect(html).toContain('View 7 low-confidence matches');
    expect(html).toContain('revealLowConfidence()');
    expect(run(`renderLowConfidenceBar(1)`)).toContain('View 1 low-confidence match<');
  });
});

// ─── 2026-08-20 wireframes: AI Guide "Continue Reading" ───────────────────────

describe('AI Guide fold', () => {
  it('shows the first paragraph and folds the rest behind Continue Reading', () => {
    const html = run(`renderAIText('First paragraph of guidance.\\n\\nSecond paragraph.\\n\\nThird paragraph.')`);
    expect(html).toContain('First paragraph of guidance.');
    expect(html).toContain('Continue Reading');
    expect(html).toContain('id="ai-summary-more"');
    // Everything is in the DOM from the start — the fold is presentation only.
    expect(html).toContain('Third paragraph.');
    // The lead sits outside the folded container.
    expect(html.indexOf('First paragraph')).toBeLessThan(html.indexOf('ai-summary-more'));
  });

  it('carries a heading into the lead so the fold never opens on a bare label', () => {
    const html = run(`renderAIText('## Overview\\n\\nThe guidance says this.\\n\\nAnd then this.')`);
    expect(html.indexOf('Overview')).toBeLessThan(html.indexOf('ai-summary-more'));
    expect(html.indexOf('The guidance says this.')).toBeLessThan(html.indexOf('ai-summary-more'));
  });

  it('does not fold a one-paragraph answer', () => {
    const html = run(`renderAIText('Only one paragraph here.')`);
    expect(html).not.toContain('Continue Reading');
  });
});

// ─── 2026-08-20: locator links in AI prose ────────────────────────────────────

describe('AI locator links', () => {
  const map = `{ 'RP-8-25+E2': {
    sections: { '4.2': 'https://lighting.ies.org/rp8#page=21' },
    pages: { '21': 'https://lighting.ies.org/rp8#page=21' } } }`;

  it('links a section to the page it was retrieved from, using the named standard', () => {
    run(`setSectionLinks(${map})`);
    const out = run(`linkifyLocators('ANSI/IES RP-8-25+E2, Section 4.2 covers parking.')`);
    expect(out).toContain('href="https://lighting.ies.org/rp8#page=21"');
    expect(out).toContain('Section 4.2</a>');
  });

  it('links a page reference the same way', () => {
    run(`setSectionLinks(${map})`);
    const out = run(`linkifyLocators('See RP-8-25+E2, p. 21 for the criteria.')`);
    expect(out).toContain('p. 21</a>');
  });

  it('leaves a locator with no retrieved page as plain text', () => {
    run(`setSectionLinks(${map})`);
    expect(run(`linkifyLocators('RP-8-25+E2, Section 9.9 says something.')`)).not.toContain('<a ');
  });

  it('leaves locators alone when no standard has been named yet', () => {
    run(`setSectionLinks(${map})`);
    expect(run(`linkifyLocators('Section 4.2 is relevant.')`)).not.toContain('<a ');
  });

  it('is inert without a map', () => {
    run('setSectionLinks(null)');
    expect(run(`linkifyLocators('RP-8-25+E2, Section 4.2')`)).not.toContain('<a ');
  });
});

// ─── 2026-08-20 wireframes: sidebar counts, derived from the results ──────────

describe('sidebar filter counts', () => {
  const app = (loc) => `{ resultType: 'application', relevanceScore: 0.8,
    application: { standard: 'RP-6-24', standardFull: 'ANSI/IES RP-6-24', indoorOutdoor: '${loc}' },
    committee: { name: 'IES Sports Lighting Committee' } }`;
  const doc = `{ resultType: 'excerpt', relevanceScore: 0.7,
    citationName: 'ANSI/IES RP-1-24 Title',
    application: { standard: 'RP-1-24', standardFull: 'ANSI/IES RP-1-24' },
    committee: { name: 'IES Education, Library and Office Lighting Committee' },
    excerpt: { text: 'x', pageNumber: 3 } }`;

  it('counts the results each content kind accounts for', () => {
    run(`allResults = [${app('Indoor')}, ${app('Outdoor')}, ${doc},
      { resultType: 'definition', relevanceScore: 1, application: { standard: 'LS-1-25' } },
      { resultType: 'reference', relevanceScore: 0.5, application: { standard: 'RP-6-24' } }]`);
    const counts = JSON.parse(run('JSON.stringify(contentKindCounts())'));
    expect(counts).toEqual({ body: 1, definitions: 1, references: 1, tables: 2, interior: 1, exterior: 1 });
  });

  it('builds the Documents lists from the results, with per-entry counts', () => {
    run(`allResults = [${app('Indoor')}, ${app('Outdoor')}, ${doc}]; seedUniverseFromResults()`);
    const universe = JSON.parse(run('JSON.stringify(docFilterUniverse)'));
    expect(universe.title.map(t => [t.value, t.count])).toEqual([['RP-1-24', 1], ['RP-6-24', 2]]);
    expect(universe.pubtype.map(p => [p.value, p.count])).toEqual([['RP', 3]]);
    expect(universe.committee.map(c => c.count)).toEqual([1, 2]);
  });

  it('starts with everything selected, so a fresh result set narrows nothing', () => {
    run(`allResults = [${app('Indoor')}, ${doc}]; seedUniverseFromResults()`);
    expect(run(`docGroupActive('title')`)).toBe(false);
    expect(run(`passesDocFilters(${doc})`)).toBe(true);
    run('resetFilters()');
  });
});

// ─── 2026-08-20 wireframes: standard-name auto-suggest ────────────────────────

describe('standard-name auto-suggest', () => {
  it('offers matching standards once the index is loaded', () => {
    run(`standardsIndex = [
      { id: 'RP-3-20+E1', full_designation: 'ANSI/IES RP-3-20+E1', title: 'Recommended Practice: Lighting Educational Facilities' },
      { id: 'RP-6-24', full_designation: 'ANSI/IES RP-6-24', title: 'Recommended Practice: Lighting Sports and Recreational Areas' },
    ]`);
    run(`document.getElementById('search-input').value = 'rp-3'; renderSuggestions()`);
    const box = elements.get('search-suggestions').innerHTML;
    expect(box).toContain('Standards');
    expect(box).toContain('RP-3-20+E1');
    expect(box).not.toContain('RP-6-24');
    run(`standardsIndex = []; document.getElementById('search-input').value = ''`);
  });

  it('stays silent for short or unmatched input', () => {
    run(`standardsIndex = [{ id: 'RP-3-20+E1', title: 'Lighting Educational Facilities' }]`);
    expect(JSON.parse(run(`JSON.stringify(standardsMatching('rp'))`))).toEqual([]);
    expect(JSON.parse(run(`JSON.stringify(standardsMatching('skating rink brightness'))`))).toEqual([]);
    run(`standardsIndex = []`);
  });
});
