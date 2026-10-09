/**
 * RP-43 lower/upper limit rows merged into a range (client 10/06/26 #1).
 */

import { describe, it, expect } from 'vitest';
import { limitInfo, limitPairKey, mergeLimitPairs, indexLimitPairs } from './limit-ranges';

function app(code, zone, limit, lux, fc, extra = {}) {
  return {
    code,
    category: 'Common Pedestrian Areas for Parks, Malls, Campuses, Commercial Spaces',
    sub1: 'Walking Surfaces (general and adjacent to landscape)',
    sub2: zone,
    sub3: limit,
    sub4: null, sub5: null, sub6: null,
    fullName: 'x',
    standard: 'RP-43-25', standardFull: 'ANSI/IES RP-43-25',
    tableRef: 'Table A-3', rowRef: null, subCategory: 'PEDESTRIAN SAFETY',
    areaOrTask: 'Area', indoorOutdoor: 'Outdoor',
    horizontal: { category: 'A', lux, fc, avgMaxMin: 'Avg', uniformity: '8:1', notes: null },
    vertical: null, task: null, tm24Eligible: false, outdoor: null,
    footnotes: null, footnoteMarks: null, generalNotes: null, appNotes: null,
    ...extra,
  };
}
const result = (a, score = 0.7) => ({ resultType: 'application', application: a, relevanceScore: score });

describe('limitInfo / limitPairKey', () => {
  it('finds the limit level and pairs lower with upper', () => {
    const lo = app('L', 'Lz1', 'Lower limit (avg.)', 2, 0.2);
    const hi = app('U', 'Lz1', 'Upper limit (avg.)', 4, 0.4);
    expect(limitInfo(lo)).toEqual({ level: 'sub3', which: 'lower' });
    expect(limitInfo(hi)).toEqual({ level: 'sub3', which: 'upper' });
    expect(limitPairKey(lo)).toBe(limitPairKey(hi));
  });

  it('keeps zones apart and ignores rows with no limit level', () => {
    expect(limitPairKey(app('A', 'Lz1', 'Lower limit (avg.)', 2, 0.2)))
      .not.toBe(limitPairKey(app('B', 'Lz2', 'Lower limit (avg.)', 2, 0.2)));
    expect(limitInfo(app('C', 'Lz1', 'Pathways', 2, 0.2))).toBeNull();
  });
});

describe('mergeLimitPairs', () => {
  it('collapses a pair into one range at the better-ranked slot', () => {
    const out = mergeLimitPairs([
      result(app('U', 'Lz1', 'Upper limit (avg.)', 4, 0.4)),
      result({ ...app('X', 'Lz1', 'Pathways', 9, 0.9) }),
      result(app('L', 'Lz1', 'Lower limit (avg.)', 2, 0.2)),
    ]);
    expect(out).toHaveLength(2);
    const merged = out[0].application;
    expect(merged.code).toBe('U');
    expect(merged.horizontal).toMatchObject({ lux: 2, luxMax: 4, fc: 0.2, fcMax: 0.4 });
    expect(merged.sub3).toBeNull();
    expect(merged.limitRange).toEqual({ lowerCode: 'L', upperCode: 'U', qualifier: 'avg.' });
    expect(merged.fullName).not.toMatch(/limit/i);
  });

  it('completes a half from partner rows fetched outside the pool', () => {
    const known = indexLimitPairs([app('U', 'Lz2', 'Upper limit (avg.)', 10, 1)]);
    const out = mergeLimitPairs([result(app('L', 'Lz2', 'Lower limit (avg.)', 5, 0.5))], known);
    expect(out[0].application.horizontal).toMatchObject({ lux: 5, luxMax: 10 });
  });

  it('leaves a lone half untouched — it still says which limit it is', () => {
    const lone = result(app('L', 'Lz3', 'Lower limit (avg.)', 5, 0.5));
    expect(mergeLimitPairs([lone])).toEqual([lone]);
  });

  it('prints no range when both limits are equal', () => {
    const out = mergeLimitPairs([
      result(app('L', 'Lz0', 'Lower limit (avg.)', 1, 0.1)),
      result(app('U', 'Lz0', 'Upper limit (avg.)', 1, 0.1)),
    ]);
    expect(out[0].application.horizontal.luxMax).toBeUndefined();
  });
});
