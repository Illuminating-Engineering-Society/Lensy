/**
 * The RP-4-26 replacement upload (client, 2026-10-06): "there are instances
 * where AI Guide is referencing RP-4-20 (in addition to RP-4-26) as current."
 *
 * Deprecating an edition flipped its standards row and left its ILLUMINANCE
 * rows and their vectors in place, and the application path of the search
 * never looked at the standard's status — so RP-4-20+E1's 40 rows kept
 * surfacing, and the excerpt backfill they triggered pulled the deprecated
 * edition's prose into the cards and the Guide's prompt. One predicate now
 * decides "is this vector's standard current?" for chunks, references,
 * application rows and backfill targets alike.
 */
import { describe, it, expect } from 'vitest';
import { isCurrentStandardMatch } from './search';

const index = new Map([
  ['RP-4-26', { status: 'Active' }],
  ['RP-4-20+E1', { status: 'Deprecated', supersededBy: 'RP-4-26' }],
]);

describe('isCurrentStandardMatch', () => {
  it('rejects an application vector of a deprecated edition (standard_code only, no standard_id)', () => {
    const appVector = { application_code: 'RP420E1_0000', chunk_type: 'application', standard_code: 'RP-4-20+E1', standard_id: null };
    expect(isCurrentStandardMatch(appVector, index)).toBe(false);
  });

  it('rejects a chunk whose standards row is Deprecated', () => {
    expect(isCurrentStandardMatch({ standard_id: 'RP-4-20+E1', standard_code: 'RP-4-20+E1', chunk_type: 'text' }, index)).toBe(false);
  });

  it('rejects a vector tagged deprecated at ingest regardless of the row', () => {
    expect(isCurrentStandardMatch({ standard_id: 'RP-4-26', status: 'deprecated' }, index)).toBe(false);
  });

  it('admits the current edition', () => {
    expect(isCurrentStandardMatch({ standard_id: 'RP-4-26', standard_code: 'RP-4-26' }, index)).toBe(true);
    expect(isCurrentStandardMatch({ application_code: 'RP426_0000', standard_code: 'RP-4-26', standard_id: null }, index)).toBe(true);
  });

  it('keeps the existing posture for a standard the index does not know (orphans are dropped elsewhere)', () => {
    expect(isCurrentStandardMatch({ standard_id: 'TM-99-26' }, index)).toBe(true);
    expect(isCurrentStandardMatch({}, index)).toBe(true);
    expect(isCurrentStandardMatch(undefined, index)).toBe(true);
  });

  it('accepts a plain standard id as well as a metadata object', () => {
    expect(isCurrentStandardMatch('RP-4-20+E1', index)).toBe(false);
    expect(isCurrentStandardMatch('RP-4-26', index)).toBe(true);
  });
});
