/**
 * The 10/06/26 Teams notes, #6: "Can we train Lens to understand that RP-43 is
 * the default standard for all exterior applications, unless they are
 * explicitly addressed in application-specific standards?" The probe and the
 * Guide fact both key off isExteriorQuery; the façade vocabulary comes from
 * the query expander.
 */
import { describe, it, expect } from 'vitest';
import { isExteriorQuery } from './search';
import { expandQuery } from '../lib/query-expander';

describe('isExteriorQuery', () => {
  it.each([
    'How do I light the exterior of a downtown store?',
    'lighting a building façade',
    'outdoor lighting for a hotel entrance',
    'parking lot lighting',
    'storefront lighting at night',
  ])('recognizes "%s"', q => expect(isExteriorQuery(q)).toBe(true));

  it.each([
    'office lighting',
    'How bright should a classroom be?',
    'what is the difference between illuminance and luminance',
  ])('leaves "%s" alone', q => expect(isExteriorQuery(q)).toBe(false));
});

describe('façade vocabulary', () => {
  it('reads "the exterior of" a building as its façade', () => {
    expect(expandQuery('How do I light the exterior of a downtown store?')).toMatch(/facade/);
  });
});
