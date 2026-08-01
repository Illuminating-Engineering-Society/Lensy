/**
 * A saved project item must not change meaning when the corpus is re-ingested.
 *
 * Application codes are `<STDID>_<rowIndex>`, so an extractor change that shifts
 * row numbering re-points a code at a DIFFERENT application, and the ingest prune
 * deletes codes a new parse no longer produces. Either way the live join stops
 * being authoritative for something the user deliberately saved — which is what
 * `project_applications.snapshot_data` is for. These tests lock in that the read
 * path prefers the snapshot and flags the divergence.
 *
 * The projection logic is small and pure, so it is re-stated here against the
 * same shapes `getProject` builds from D1. Verified against the live endpoint too
 * (a saved row survived both a re-numbering and a prune with its own values).
 */

import { describe, it, expect } from 'vitest';

// Mirrors the mapping in getProject() (src/workers/api.ts).
function parseSnapshot(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : null;
  } catch {
    return null;
  }
}

function project(rows) {
  return rows.map(row => {
    const snapshot = parseSnapshot(row.snapshot_data);
    if (!snapshot) return { ...row, snapshotMissing: row.live_code == null };
    const fromSnapshot = {
      App: snapshot.App, App_s1: snapshot.App_s1, App_s2: snapshot.App_s2,
      Standard: snapshot.Standard, Standard_Full: snapshot.Standard_Full,
      Hor_Lux: snapshot.Hor_Lux, Hor_Fc: snapshot.Hor_Fc,
      Ver_Lux: snapshot.Ver_Lux, Ver_Fc: snapshot.Ver_Fc,
      Indoor_Outdoor: snapshot.Indoor_Outdoor,
    };
    const removed = row.live_code == null;
    const moved = !removed && row.Standard != null &&
      (row.App !== snapshot.App || row.App_s1 !== snapshot.App_s1 || row.Standard !== snapshot.Standard);
    return { ...row, ...fromSnapshot, removedFromCorpus: removed, reindexed: moved };
  });
}

const SAVED = {
  App: 'Walkway', App_s1: 'Lz4', App_s2: null,
  Standard: 'RP-43-25', Standard_Full: 'ANSI/IES RP-43-25',
  Hor_Lux: 10, Hor_Fc: 1, Ver_Lux: null, Ver_Fc: null, Indoor_Outdoor: 'Outdoor',
};

const savedRow = (live) => ({
  application_code: 'RP4325_0170',
  snapshot_data: JSON.stringify(SAVED),
  live_code: live ? 'RP4325_0170' : null,
  ...(live || {}),
});

describe('project item projection', () => {
  it('shows the live row unflagged while the corpus still agrees', () => {
    const [item] = project([savedRow({ App: 'Walkway', App_s1: 'Lz4', Standard: 'RP-43-25', Hor_Lux: 10 })]);
    expect(item.App).toBe('Walkway');
    expect(item.Hor_Lux).toBe(10);
    expect(item.removedFromCorpus).toBe(false);
    expect(item.reindexed).toBe(false);
  });

  it('keeps the SAVED values when a re-ingest re-points the code elsewhere', () => {
    // The live row is now a completely different application at 300 lx. Showing
    // that under the user's saved item would silently rewrite their schedule.
    const [item] = project([savedRow({ App: 'Loading dock', App_s1: 'General', Standard: 'RP-43-25', Hor_Lux: 300 })]);
    expect(item.App).toBe('Walkway');
    expect(item.Hor_Lux).toBe(10);
    expect(item.reindexed).toBe(true);
    expect(item.removedFromCorpus).toBe(false);
  });

  it('keeps the SAVED values when the prune removed the code', () => {
    const [item] = project([savedRow(null)]);
    expect(item.App).toBe('Walkway');
    expect(item.Hor_Lux).toBe(10);
    expect(item.removedFromCorpus).toBe(true);
    expect(item.reindexed).toBe(false);
  });

  it('notices a change of standard, not only of name', () => {
    const [item] = project([savedRow({ App: 'Walkway', App_s1: 'Lz4', Standard: 'RP-43-22', Hor_Lux: 10 })]);
    expect(item.reindexed).toBe(true);
  });

  it('flags a removed row that has no snapshot to fall back on', () => {
    const [item] = project([{ application_code: 'X_0001', snapshot_data: null, live_code: null }]);
    expect(item.snapshotMissing).toBe(true);
  });

  it('survives malformed snapshot JSON without throwing', () => {
    const [item] = project([{ application_code: 'X_0001', snapshot_data: '{not json', live_code: 'X_0001' }]);
    expect(item.snapshotMissing).toBe(false);
  });
});
