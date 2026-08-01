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
      querySelector(sel) {
        const m = /\.filter-pill\[data-filter="([^"]+)"\]/.exec(sel);
        if (!m) return null;
        if (!pills.has(m[1])) pills.set(m[1], stubElement(`pill:${m[1]}`));
        return pills.get(m[1]);
      },
      querySelectorAll() { return []; },
      addEventListener() {},
      body: { style: {} },
    },
    window: { scrollTo() {}, location: { search: '' } },
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

// ─── DO32: Content / View filter rows ─────────────────────────────────────────

describe('filter pills', () => {
  it('defaults to Documents + Illuminance Tables, everything else off', () => {
    run('resetFilters()');
    expect(JSON.parse(run('JSON.stringify(filterState)'))).toEqual({
      body: true, tables: true,
      definitions: false, references: false, guide: false, compare: false,
      interior: true, exterior: true,
    });
  });

  it('relabels Enable Guide to Disable Guide once selected', () => {
    run('resetFilters(); toggleFilter("guide")');
    expect(pills.get('guide').textContent).toBe('Disable Guide');
    run('toggleFilter("guide")');
    expect(pills.get('guide').textContent).toBe('Enable Guide');
  });

  it('locks the Content row while Document Comparison is selected', () => {
    run('resetFilters(); toggleFilter("compare")');
    for (const name of ['body', 'definitions', 'references', 'tables']) {
      expect(pills.get(name).disabled).toBe(true);
    }
    run('toggleFilter("compare")');
    expect(pills.get('body').disabled).toBe(false);
  });

  it('never leaves a comparison with no content selected', () => {
    run('resetFilters(); toggleFilter("body"); toggleFilter("tables"); toggleFilter("compare")');
    const st = JSON.parse(run('JSON.stringify(filterState)'));
    expect(st.body || st.tables).toBe(true);
  });

  it('shows Interior/Exterior only while Illuminance Tables is selected', () => {
    run('resetFilters()');
    expect(elements.get('location-pills').style.display).toBe('flex');
    run('toggleFilter("tables")');
    expect(elements.get('location-pills').style.display).toBe('none');
  });

  it('reset restores the defaults', () => {
    run('toggleFilter("definitions"); toggleFilter("tables"); resetFilters()');
    const st = JSON.parse(run('JSON.stringify(filterState)'));
    expect(st.tables).toBe(true);
    expect(st.definitions).toBe(false);
  });

  it('sends the pill state as content_types', () => {
    run('applyFilterState({ definitions: true, body: false, tables: false })');
    expect(JSON.parse(run('JSON.stringify(collectFilters())')))
      .toEqual({ content_types: ['definitions'] });
    run('resetFilters()');
  });

  it('narrows by location only when exactly one of Interior/Exterior is on', () => {
    run('resetFilters()');
    expect(JSON.parse(run('JSON.stringify(collectFilters())')).indoor_outdoor).toBeUndefined();
    run('toggleFilter("interior")');
    expect(JSON.parse(run('JSON.stringify(collectFilters())')).indoor_outdoor).toBe('Outdoor');
    run('resetFilters()');
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

  it('gives every type its own line style and chip palette', () => {
    const styles = JSON.parse(run('JSON.stringify(RESULT_TYPE_STYLES)'));
    const lines = Object.values(styles).map(s => s.line);
    expect(new Set(lines).size).toBe(lines.length);
    for (const s of Object.values(styles)) {
      expect(s.chip).toBeTruthy();
      expect(s.banner).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
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
