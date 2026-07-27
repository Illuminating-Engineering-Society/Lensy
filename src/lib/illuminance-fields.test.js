import { describe, it, expect } from 'vitest';
import { parseLightingZoneLabel, hasEnvConsiderationColumns } from './illuminance-fields.js';

// ─── DO20/DO21: every printed form of a lighting zone triggers the field ─────

describe('parseLightingZoneLabel', () => {
  it('accepts all equivalent printed forms', () => {
    for (const form of ['Lz4', 'LZ4', 'lz4', 'L Z 4', 'Lighting Zone 4', 'LIGHTING ZONE 4']) {
      const parsed = parseLightingZoneLabel(form);
      expect(parsed, form).not.toBeNull();
      expect(parsed.code).toBe('LZ4');
      expect(parsed.label).toBe(form.trim()); // display keeps the printed label
    }
  });

  it('keeps RP-2 curfew pairs intact and reports the curfew zone', () => {
    const parsed = parseLightingZoneLabel('Lz3 (and Lz4 curfew)');
    expect(parsed.code).toBe('LZ3');
    expect(parsed.label).toBe('Lz3 (and Lz4 curfew)');
    expect(parsed.curfew).toBe('Lz4 curfew');
  });

  it('reports no curfew when none is printed', () => {
    expect(parseLightingZoneLabel('Lz4').curfew).toBeNull();
  });

  it('is not fooled by other labels or by prose that mentions a zone', () => {
    expect(parseLightingZoneLabel('High activity')).toBeNull();
    expect(parseLightingZoneLabel('Loading dock 4')).toBeNull();
    expect(parseLightingZoneLabel('Class 4')).toBeNull();
    expect(parseLightingZoneLabel(
      'Exterior lighting zones are defined so that lighting zone 4 applies to high-activity urban areas.'
    )).toBeNull();
    expect(parseLightingZoneLabel(null)).toBeNull();
    expect(parseLightingZoneLabel(42)).toBeNull();
  });
});

// ─── DO21: Glare/Uplight/Controls/Spectrum only where the columns exist ──────

describe('hasEnvConsiderationColumns', () => {
  it('is true for the RP-43 family only', () => {
    expect(hasEnvConsiderationColumns('RP-43-25')).toBe(true);
    expect(hasEnvConsiderationColumns('rp-43-25')).toBe(true);
    expect(hasEnvConsiderationColumns('RP-43')).toBe(true);
  });

  it('is false for standards without the dedicated columns', () => {
    expect(hasEnvConsiderationColumns('RP-2-20+E1')).toBe(false);
    expect(hasEnvConsiderationColumns('RP-4-20+E1')).toBe(false);
    expect(hasEnvConsiderationColumns('RP-29-25')).toBe(false);
    // Not a prefix match on the bare number: RP-4 must never read as RP-43.
    expect(hasEnvConsiderationColumns('RP-430-99')).toBe(false);
    expect(hasEnvConsiderationColumns(null)).toBe(false);
  });
});
