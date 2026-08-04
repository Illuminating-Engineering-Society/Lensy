/**
 * Saved Search Collections page (client DO37).
 *
 * Same approach as index.test.js: pull the inline app script out of the HTML and
 * run it against a DOM stub, then call the render functions directly. The point
 * is to catch what a syntax check cannot — a collection row that starts printing
 * excerpt text or illuminance values, a field that no longer hides when empty, a
 * share link that writes to an account just by being opened.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import vm from 'vm';

const here = dirname(fileURLToPath(import.meta.url));

let ctx, elements, run;

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
    setAttribute() {}, getAttribute() { return null; },
    querySelector() { return null; }, querySelectorAll() { return []; },
    closest() { return null; }, focus() {}, scrollIntoView() {},
  };
  return el;
}

beforeAll(() => {
  const html = readFileSync(join(here, 'projects.html'), 'utf8');
  const blocks = [...html.matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  const app = blocks[blocks.length - 1];

  elements = new Map();
  const byId = (id) => {
    if (!elements.has(id)) elements.set(id, stubElement(id));
    return elements.get(id);
  };

  const sandbox = {
    document: {
      getElementById: byId,
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener() {},
      body: { style: {} },
    },
    window: { scrollTo() {}, location: { search: '', origin: 'https://lensy.ies.org' } },
    location: { search: '', origin: 'https://lensy.ies.org', href: '' },
    navigator: { clipboard: { writeText: async () => {} } },
    URLSearchParams, encodeURIComponent, console, setTimeout, clearTimeout,
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    LensyAPI: {
      listProjects: async () => ({ projects: [] }),
      collectionCsvUrl: (id) => `/api/projects/${id}/csv`,
      shareCollection: async () => ({ share_token: 'abc123' }),
    },
  };
  sandbox.globalThis = sandbox;
  ctx = vm.createContext(sandbox);
  vm.runInContext(app, ctx, { filename: 'projects.html:app' });
  run = (expr) => vm.runInContext(expr, ctx);
});

// ─── The no-contents rule, at the render layer ────────────────────────────────

describe('saved item rows', () => {
  const item = (over = {}) => JSON.stringify({
    id: 7, application_code: 'RP220E1_0162', result_type: 'tables',
    standard_id: 'RP-2-20+E1',
    resource_title: 'ANSI/IES RP-2-20+E1 Recommended Practice: Lighting Retail Spaces',
    page_number: 72, library_url: 'https://view.protectedpdf.com/x#page=72',
    application_name: 'EXTERIOR - RETAIL > Ramps, Stairs, and Steps > Low activity > Lz4',
    custom_notes: 'Check against the curfew rows', added_at: '2026-06-15',
    ...over,
  });

  it('prints the citation, the page and the Open in Library link', () => {
    const html = run(`renderApplicationRow(${item()}, 1)`);
    expect(html).toContain('ANSI/IES RP-2-20+E1');
    expect(html).toContain('p.&nbsp;72');
    expect(html).toContain('Open in Library');
    expect(html).toContain('Illuminance Table');
  });

  it('prints the application name for an illuminance row', () => {
    expect(run(`renderApplicationRow(${item()}, 1)`)).toContain('Ramps, Stairs, and Steps');
  });

  it('never prints illuminance VALUES — a saved search is a reference, not a copy', () => {
    // The old row printed Horizontal/Vertical lux; the client's collection view
    // has no such columns and the CSV spec has no such fields.
    // The sentinel values are deliberately odd so they cannot collide with a
    // Tailwind class name like `text-gray-400`.
    const html = run(`renderApplicationRow(${item({
      snapshot_data: JSON.stringify({ Hor_Lux: 4137, Ver_Lux: 9271, App: 'Desk' }),
    })}, 1)`);
    expect(html).not.toContain('4137');
    expect(html).not.toContain('9271');
    expect(html).not.toContain('Horizontal');
    expect(html).not.toContain('Vertical');
    expect(html).not.toContain('lux-value');
  });

  it('prints the reference entry in full for a Reference item', () => {
    const entry = '6 International Commission on Illumination (CIE). CIE 015:2018, Colorimetry, 4th ed.';
    const html = run(`renderApplicationRow(${item({
      result_type: 'references', application_name: null, reference_text: entry,
    })}, 1)`);
    expect(html).toContain('Reference');
    expect(html).toContain('CIE 015:2018');
  });

  it('does NOT print an application name on a non-illuminance item', () => {
    const html = run(`renderApplicationRow(${item({
      result_type: 'body', application_name: 'LEAKED APPLICATION NAME',
    })}, 1)`);
    expect(html).not.toContain('LEAKED APPLICATION NAME');
    expect(html).toContain('Documents &amp; Annexes');
  });

  it('does NOT print reference text on a non-reference item', () => {
    const html = run(`renderApplicationRow(${item({
      result_type: 'definitions', reference_text: 'LEAKED REFERENCE TEXT',
    })}, 1)`);
    expect(html).not.toContain('LEAKED REFERENCE TEXT');
    expect(html).toContain('Definitions');
  });

  it('labels every result type the way the client spells it', () => {
    const labels = JSON.parse(run('JSON.stringify(ITEM_TYPE_LABELS)'));
    expect(labels).toEqual({
      body: 'Documents & Annexes',
      tables: 'Illuminance Table',
      references: 'References',
      definitions: 'Definitions',
    });
  });

  it('treats a legacy row with no result_type as an illuminance row', () => {
    const html = run(`renderApplicationRow(${item({ result_type: null })}, 1)`);
    expect(html).toContain('Illuminance Table');
  });

  it('surfaces a note field even when the note is empty', () => {
    const html = run(`renderApplicationRow(${item({ custom_notes: null })}, 1)`);
    expect(html).toContain('User Note');
    expect(html).toContain('item-note');
  });

  it('shows the Buy button only when a webstore URL exists', () => {
    expect(run(`renderApplicationRow(${item()}, 1)`)).not.toContain('>Buy<');
    expect(run(`renderApplicationRow(${item({ buy_url: 'https://store.ies.org/p/1' })}, 1)`)).toContain('Buy');
  });

  it('warns when a re-ingest moved or removed the underlying row', () => {
    expect(run(`renderApplicationRow(${item({ removedFromCorpus: true })}, 1)`))
      .toContain('No longer in the current standard');
    expect(run(`renderApplicationRow(${item({ reindexed: true })}, 1)`))
      .toContain('re-numbered');
  });

  it('escapes user-supplied text so it can never become markup', () => {
    // The escaped text still READS as "onerror=alert(1)" — that is fine, and
    // asserting its absence would be measuring the wrong thing. What matters is
    // that no tag is formed: the angle brackets are entities.
    const html = run(`renderApplicationRow(${item({ custom_notes: '<img src=x onerror=alert(1)>' })}, 1)`);
    expect(html).toContain('&lt;img');
    expect(html).not.toContain('<img');
  });

  it('escapes a citation that contains markup', () => {
    const html = run(`renderApplicationRow(${item({ resource_title: '<script>bad()</script>' })}, 1)`);
    expect(html).not.toContain('<script>bad()');
    expect(html).toContain('&lt;script&gt;');
  });
});

// ─── DO37: user-definable project type ────────────────────────────────────────

describe('user-definable collection type', () => {
  it('reveals the free-text box only for "Other"', () => {
    const select = elements.get('modal-project-type') || null;
    run(`document.getElementById('modal-project-type').value = 'Other'; toggleOtherProjectType()`);
    expect(elements.get('modal-project-type-other').classList.contains('hidden')).toBe(false);
    run(`document.getElementById('modal-project-type').value = 'Renovation'; toggleOtherProjectType()`);
    expect(elements.get('modal-project-type-other').classList.contains('hidden')).toBe(true);
    expect(select === null || true).toBe(true);
  });

  it('clears the free-text value when the type is no longer "Other"', () => {
    run(`document.getElementById('modal-project-type').value = 'Other'; toggleOtherProjectType();
         document.getElementById('modal-project-type-other').value = 'Historic retrofit';
         document.getElementById('modal-project-type').value = 'Addition'; toggleOtherProjectType()`);
    expect(elements.get('modal-project-type-other').value).toBe('');
  });
});

// ─── Dates ────────────────────────────────────────────────────────────────────

describe('formatDate', () => {
  it('renders a D1 timestamp', () => {
    expect(run(`formatDate('2026-06-15 14:19:31')`)).toMatch(/2026/);
  });

  it('passes through something unparseable rather than printing "Invalid Date"', () => {
    expect(run(`formatDate('not a date')`)).toBe('not a date');
  });

  it('is empty for no value', () => {
    expect(run(`formatDate(null)`)).toBe('');
    expect(run(`formatDate('')`)).toBe('');
  });
});
