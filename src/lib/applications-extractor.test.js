import { describe, it, expect } from 'vitest';
import {
  parseDataRow,
  extractApplicationsFromPages,
  reportExtractionQuality,
} from './applications-extractor.js';

// ─── Row grammar ────────────────────────────────────────────────────────────
// Canonical IES table row (verified against the RP-2/6/7/9/10/29/43 prototypes
// and the schema in pdfs/Others/IlluminanceTables_Reference_260421.pdf):
//   <label> <A|T> [veiling L/M/H] <Cat A-Y> <n> lx @ <TS|n m> <n> fc @ <TS|n ft>
//           <Avg|Max|Min> [n:n] [ratio basis]   …repeated for the vertical plane

describe('parseDataRow — illuminance category', () => {
  it('reads the bare category letter glued before the lux value', () => {
    const r = parseDataRow('General A M 100 lx @ 0.00 m 10 fc @ 0.0 ft Avg 3:1 Avg:Min');
    expect(r.hasData).toBe(true);
    expect(r.areaOrTask).toBe('Area');
    expect(r.horCat).toBe('M');
    expect(r.horLux).toBe(100);
    expect(r.horFc).toBe(10);
    expect(r.label).toBe('General');
  });

  it('separates Task marker, Veiling risk and Category (T H R …)', () => {
    const r = parseDataRow('Printed material inspection T H R 500 lx @ TS 50 fc @ TS Avg 2:1 Avg:Min');
    expect(r.areaOrTask).toBe('Task');
    expect(r.veilingRisk).toBe('H');
    expect(r.horCat).toBe('R');
    expect(r.horLux).toBe(500);
    expect(r.label).toBe('Printed material inspection');
  });

  it('distinguishes the Task marker from a category that is also "T"', () => {
    const r = parseDataRow('Difficult T T 1000 lx @ TS 100 fc @ TS Avg 3:1 Max:Min');
    expect(r.areaOrTask).toBe('Task');
    expect(r.horCat).toBe('T');
    expect(r.horLux).toBe(1000);
    expect(r.label).toBe('Difficult');
  });
});

describe('parseDataRow — task-surface heights without a unit', () => {
  it('parses "@ TS" (no m/ft) — the bug that dropped RP-7 industrial rows', () => {
    const r = parseDataRow('Exacting T W 3000 lx @ TS 300 fc @ TS Avg 3:1 Max:Min');
    expect(r.horLux).toBe(3000);
    expect(r.horFc).toBe(300);
    expect(r.horHeightM).toBeNull();   // TS → no fixed AFF height
    expect(r.horHeightFt).toBeNull();
  });

  it('treats a "0.00 m" ground-level height as no useful height', () => {
    const r = parseDataRow('Aisle A K 50 lx @ 0.00 m 5 fc @ 0.0 ft Avg');
    expect(r.horLux).toBe(50);
    expect(r.horHeightM).toBeNull();
  });
});

describe('parseDataRow — horizontal vs vertical split', () => {
  it('assigns the second lux/fc block + its metrics to the vertical plane', () => {
    const r = parseDataRow('General A M 100 lx @ 0.00 m 10 fc @ 0.0 ft Avg 3:1 Avg:Min I 30 lx @ 1.50 m 3 fc @ 5.0 ft Max 2:1 Max:Min');
    expect(r.horCat).toBe('M');
    expect(r.horLux).toBe(100);
    expect(r.horBasis).toBe('Avg');
    expect(r.uniformity).toBe('3:1');
    expect(r.ratioBasis).toBe('Avg:Min');
    // vertical
    expect(r.verCat).toBe('I');
    expect(r.verLux).toBe(30);
    expect(r.verHeightM).toBe(1.5);
    expect(r.verBasis).toBe('Max');
    expect(r.verRatioBasis).toBe('Max:Min');
  });

  it('does not leak a "Min/Max" label word into the basis token', () => {
    const r = parseDataRow('Room Min T P 300 lx @ 0.91 m 30 fc @ 3.0 ft Min');
    expect(r.label).toBe('Room Min');
    expect(r.areaOrTask).toBe('Task');
    expect(r.horCat).toBe('P');
    expect(r.horBasis).toBe('Min');
  });
});

describe('parseDataRow — RP-43 Environmental & Visual columns', () => {
  it('parses glare %, uplight lm and spectrum without a category', () => {
    const r = parseDataRow('Lower limit (avg.)A50 lx @ 0.00 m 5:1 Avg:Min 5% 500 lm Off to 50% 2400 K to 4000 K');
    expect(r.areaOrTask).toBe('Area');
    expect(r.horCat).toBeNull();          // RP-43 tables carry no RP-10 category
    expect(r.horLux).toBe(50);
    expect(r.glareMax).toBe('5%');
    expect(r.uplightMax).toBe('500 lm');
    expect(r.controls).toBe('Off to 50%');
    expect(r.spectrum).toBe('2400K to 4000K');
  });
});

// ─── Hierarchy reconstruction (depth via X clustering) ────────────────────────

function line(text, x, fontSize = 7.5, y = 0) {
  return { text, x, y, fontSize, bold: false };
}

describe('extractApplicationsFromPages — hierarchy nesting', () => {
  // A miniature single-table page laid out like a real IES table: every indent
  // level carries several rows so the X-clustering has enough support to derive
  // the grid (70/78/86/94 px = Sub_Category / App / App_s1 / data+App_s2).
  const lines = [
    line('INTERIOR - OFFICE', 70),
    line('Open Plan Offices', 78),
    line('Workstations', 86),
    line('General A M 100 lx @ 0.00 m 10 fc @ 0.0 ft Avg 3:1 Avg:Min', 94),
    line('Detailed T R 500 lx @ TS 50 fc @ TS Avg 3:1 Max:Min', 94),
    line('Reference Tasks', 86),
    line('Reading A P 300 lx @ 0.76 m 30 fc @ 2.5 ft Avg 3:1 Avg:Min', 94),
    line('Private Offices', 78),
    line('Executive', 86),
    line('Desk T Q 400 lx @ 0.76 m 40 fc @ 2.5 ft Avg 3:1 Avg:Min', 94),
    line('Conference Rooms', 78),
    line('Video Meeting', 86),
    line('Wall A N 150 lx @ 1.20 m 15 fc @ 4.0 ft Avg 3:1 Avg:Min', 94),
  ];
  const pages = [{ number: 1, width: 792, height: 612, text: lines.map(l => l.text).join('\n'), lines }];
  const records = extractApplicationsFromPages(pages, 'RP-1-25', { fullDesignation: 'ANSI/IES RP-1-25' });

  it('extracts one record per data row', () => {
    expect(records.length).toBe(5);
  });

  it('nests each leaf under its full ancestor chain', () => {
    const general = records.find(r => r.App_s2 === 'General');
    expect(general.Sub_Category).toBe('INTERIOR - OFFICE');
    expect(general.App).toBe('Open Plan Offices');
    expect(general.App_s1).toBe('Workstations');
    expect(general.Hor_Cat).toBe('M');
    expect(general.Hor_Lux).toBe(100);
    expect(general.Indoor_Outdoor).toBe('Indoor');
  });

  it('re-parents correctly when the hierarchy moves back up a level', () => {
    const wall = records.find(r => r.App_s2 === 'Wall');
    expect(wall.App).toBe('Conference Rooms');
    expect(wall.App_s1).toBe('Video Meeting');
  });

  it('produces no hierarchy gaps and full lux/category coverage', () => {
    const q = reportExtractionQuality(records);
    expect(q.hierarchyGaps).toBe(0);
    expect(q.withHorLux).toBe(records.length);
    expect(q.withApp).toBe(records.length);
    expect(q.withIlluminanceCategory).toBe(records.length);
  });
});

// ─── Footnote association (client bug: "ambulance" reproduction) ──────────────
// A footnote marker printed on a HEADER line ("Emergency department entry¹")
// scopes to that header — it must attach to the header LEVEL in
// Footnote_Marks, never independently to the Day/Night sub-rows. A marker
// printed beside a DATA row attaches to that row only. Marker ref lines are
// tiny-font numeric lines bound to their target by Y proximity.

describe('extractApplicationsFromPages — footnote scoping', () => {
  const lines = [
    line('INTERIOR - HEALTHCARE', 70, 7.5, 10),
    line('Emergency Department', 78, 7.5, 20),
    line('Emergency department entry', 86, 7.5, 30),
    line('1', 86, 4.5, 27), // tiny superscript ref, printed beside the HEADER
    line('Day A M 100 lx @ 0.00 m 10 fc @ 0.0 ft Avg', 94, 7.5, 40),
    line('Night A K 50 lx @ 0.00 m 5 fc @ 0.0 ft Avg', 94, 7.5, 50),
    line('Triage T P 300 lx @ 0.76 m 30 fc @ 2.5 ft Avg', 94, 7.5, 60),
    line('3', 94, 4.5, 63), // tiny ref printed beside the Triage DATA row
    line('Waiting Rooms', 78, 7.5, 70),
    line('Family Areas', 86, 7.5, 80),
    line('General A N 150 lx @ 0.76 m 15 fc @ 2.5 ft Avg', 94, 7.5, 90),
    line('Imaging', 78, 7.5, 100),
    line('Control Rooms', 86, 7.5, 110),
    line('Console T Q 400 lx @ 0.76 m 40 fc @ 2.5 ft Avg', 94, 7.5, 120),
    line('Application Task/Area Notes', 60, 9.5, 130),
    line('1 Applies to the emergency department entry as a whole.', 60, 9.5, 140),
    line('3 Verify local code requirements before final design.', 60, 9.5, 150),
  ];
  const pages = [{ number: 1, width: 792, height: 612, text: lines.map(l => l.text).join('\n'), lines }];
  const records = extractApplicationsFromPages(pages, 'RP-28-25', { fullDesignation: 'ANSI/IES RP-28-25' });
  const byLeaf = (leaf) => records.find(r => r.App_s2 === leaf);
  const marksOf = (r) => JSON.parse(r.Footnote_Marks);

  it('attaches a header footnote to the header LEVEL, not the sub-rows', () => {
    for (const leaf of ['Day', 'Night']) {
      const rec = byLeaf(leaf);
      const marks = marksOf(rec);
      expect(marks.levels.App_s1).toEqual([1]);     // on "Emergency department entry"
      expect(marks.row).toEqual([]);                 // NOT independently on the sub-row
    }
  });

  it('attaches a row footnote to that row only, alongside inherited header marks', () => {
    const triage = byLeaf('Triage');
    const marks = marksOf(triage);
    expect(marks.row).toEqual([3]);
    expect(marks.levels.App_s1).toEqual([1]);
  });

  it('resolves note text for all referenced numbers', () => {
    expect(byLeaf('Day').Footnotes).toContain('1. Applies to the emergency department entry');
    const triage = byLeaf('Triage');
    expect(triage.Footnotes).toContain('1. Applies to the emergency department entry');
    expect(triage.Footnotes).toContain('3. Verify local code requirements');
  });

  it('does not leak header footnotes to later application branches', () => {
    expect(byLeaf('General').Footnote_Marks).toBeNull();
    expect(byLeaf('Console').Footnote_Marks).toBeNull();
  });

  it('keeps the header footnote off unrelated rows entirely', () => {
    expect(byLeaf('General').Footnotes ?? null).toBeNull();
  });
});
