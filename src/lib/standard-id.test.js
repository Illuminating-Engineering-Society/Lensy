/**
 * Standard-id derivation — shared by scripts/ingest-pdfs.js and the staff
 * dashboard (src/workers/staff-ingest.ts). The cases are the documented ones
 * from the original script implementation, so moving the function cannot have
 * changed what any existing filename derives to.
 */

import { describe, it, expect } from 'vitest';
import {
  deriveStandardId, inferFullDesignation, standardFamilyOf,
  normalizeJointDesignation, normalizeStandardIdInput, STANDARD_ID_RE,
} from './standard-id.js';

describe('deriveStandardId', () => {
  it('handles the documented prototype-filename shapes', () => {
    expect(deriveStandardId('RP-43-25_v7_Prototype_260420-NEW_TABLE.pdf')).toBe('RP-43-25');
    expect(deriveStandardId('RP-3-20+E1 Prototype_260519-NEW_TABLE.pdf')).toBe('RP-3-20+E1');
    expect(deriveStandardId('RP-8-25 + E2_v1 260527-NEW_TABLE.pdf')).toBe('RP-8-25+E2');
    expect(deriveStandardId('RP-27.1-22.pdf')).toBe('RP-27.1-22');
  });

  it('accepts a full path, both separator styles', () => {
    expect(deriveStandardId('pdfs/Lighting Science/LM-63-19.pdf')).toBe('LM-63-19');
    expect(deriveStandardId('pdfs\\Deprecated Standards\\RP-6-15.pdf')).toBe('RP-6-15');
  });

  it('falls back to the first token when nothing designation-shaped leads', () => {
    expect(deriveStandardId('draft_notes v2.pdf')).toBe('draft');
  });

  it('keeps a reaffirmation marker out of the id (it is not part of the edition)', () => {
    expect(deriveStandardId('LM-47-20(R2023).pdf')).toBe('LM-47-20');
  });

  it('derives a joint standard published under another body\'s numbering', () => {
    // ANSI/ASHRAE/IES 90.1-2025 — the uploader refused it (client, 2026-09-28).
    expect(deriveStandardId('ANSI_ASHRAE_IES 90.1-2025.pdf')).toBe('ASHRAE-IES-90.1-2025');
    expect(deriveStandardId('ANSI-ASHRAE-IES-90.1-2025_final.pdf')).toBe('ASHRAE-IES-90.1-2025');
    expect(deriveStandardId('ASHRAE IES 90.1-2025.pdf')).toBe('ASHRAE-IES-90.1-2025');
  });
});

describe('joint designations and the shared id shape', () => {
  it('turns the printed form into the id form, dropping the ANSI approval prefix', () => {
    expect(normalizeJointDesignation('ANSI/ASHRAE/IES 90.1-2025')).toBe('ASHRAE-IES-90.1-2025');
    expect(normalizeJointDesignation('ANSI/ASHRAE/IES-90.1-2025')).toBe('ASHRAE-IES-90.1-2025');
    expect(normalizeJointDesignation('ANSI/IES/NALMCO RP-36-24')).toBe(null);   // an IES id, not a joint number
    expect(normalizeJointDesignation('meeting notes v3')).toBe(null);
  });

  it('normalizes what the dashboard field accepts', () => {
    expect(normalizeStandardIdInput(' RP-27-26 ')).toBe('RP-27-26');
    expect(normalizeStandardIdInput('ANSI/ASHRAE/IES 90.1-2025')).toBe('ASHRAE-IES-90.1-2025');
    expect(normalizeStandardIdInput('ASHRAE-IES-90.1-2025')).toBe('ASHRAE-IES-90.1-2025');
    expect(normalizeStandardIdInput('nonsense')).toBe('nonsense');
  });

  it('STANDARD_ID_RE admits the catalogue\'s ids and the joint form, nothing looser', () => {
    for (const ok of ['RP-43-25', 'LM-63-19', 'RP-8-25+E2', 'RP-27.1-22', 'LS-1', 'ASHRAE-IES-90.1-2025']) {
      expect(STANDARD_ID_RE.test(ok), ok).toBe(true);
    }
    for (const bad of ['ANSI/ASHRAE/IES 90.1-2025', 'meeting', 'RP 43 25', '90.1-2025', 'A-B-C-D-1']) {
      expect(STANDARD_ID_RE.test(bad), bad).toBe(false);
    }
  });
});

describe('inferFullDesignation', () => {
  it('prefixes ANSI/IES for the series that carry it', () => {
    expect(inferFullDesignation('RP-1-24', '')).toBe('ANSI/IES RP-1-24');
    expect(inferFullDesignation('TM-30-24', '')).toBe('ANSI/IES TM-30-24');
  });
  it('leaves an already-prefixed id and fishes a designation out of the title', () => {
    expect(inferFullDesignation('ANSI/IES LS-1-25', '')).toBe('ANSI/IES LS-1-25');
    expect(inferFullDesignation('LS-1-25', 'ANSI/IES LS-1-25 Lighting Science')).toBe('ANSI/IES LS-1-25');
  });
  it('prints a joint id the way its cover does', () => {
    expect(inferFullDesignation('ASHRAE-IES-90.1-2025', '')).toBe('ANSI/ASHRAE/IES 90.1-2025');
  });
});

describe('standardFamilyOf', () => {
  it('strips the edition year and any errata suffix', () => {
    expect(standardFamilyOf('RP-6-15')).toBe('RP-6');
    expect(standardFamilyOf('RP-27.1-22')).toBe('RP-27.1');
    expect(standardFamilyOf('RP-36-20+E2')).toBe('RP-36');
  });
  it('is null for an id without an edition year', () => {
    expect(standardFamilyOf('LS-1')).toBe(null);
    expect(standardFamilyOf('')).toBe(null);
  });
  it('keeps the dot family distinct from the dash family (RP-27 ≠ RP-27.1)', () => {
    expect(standardFamilyOf('RP-27-20+E1')).toBe('RP-27');
    expect(standardFamilyOf('RP-27.1-22')).not.toBe(standardFamilyOf('RP-27-20+E1'));
  });
});
