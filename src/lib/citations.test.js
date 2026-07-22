import { describe, it, expect } from 'vitest';
import { formatCitation, validateCitation, checkCopyrightViolations, composeStandardName } from './citations';

describe('composeStandardName', () => {
  it('appends the descriptive title to the designation', () => {
    expect(composeStandardName('ANSI/IES RP-2-20+E1', 'Recommended Practice: Lighting Retail Spaces'))
      .toBe('ANSI/IES RP-2-20+E1 Recommended Practice: Lighting Retail Spaces');
  });

  it('does not duplicate a designation already embedded in the title', () => {
    expect(composeStandardName('ANSI/IES RP-9-20', 'ANSI/IES RP-9-20 Lighting Hospitals and Healthcare Facilities'))
      .toBe('ANSI/IES RP-9-20 Lighting Hospitals and Healthcare Facilities');
  });

  it('reattaches the ANSI/IES prefix when the title starts with the bare id', () => {
    expect(composeStandardName('ANSI/IES RP-2-20', 'RP-2-20 Lighting Retail Spaces'))
      .toBe('ANSI/IES RP-2-20 Lighting Retail Spaces');
  });

  it('falls back to the designation when no title is known', () => {
    expect(composeStandardName('ANSI/IES RP-9-20', null)).toBe('ANSI/IES RP-9-20');
    expect(composeStandardName('ANSI/IES RP-9-20', '')).toBe('ANSI/IES RP-9-20');
  });
});

describe('citations', () => {
  it('formats application citation with table and row references', () => {
    const text = formatCitation({
      Standard_Full: 'ANSI/IES RP-9-20',
      Table_Ref: 'Table A-1',
      Row_Ref: 'Row 45',
    });
    expect(text).toBe('ANSI/IES RP-9-20, Table A-1, Row 45');
  });

  it('carries the full standard title when provided (client requirement)', () => {
    const text = formatCitation({
      Standard_Full: 'ANSI/IES RP-2-20+E1',
      Table_Ref: 'Table A-1',
      Row_Ref: 'Row 2',
    }, null, 61, 'Recommended Practice: Lighting Retail Spaces');
    expect(text).toBe('ANSI/IES RP-2-20+E1 Recommended Practice: Lighting Retail Spaces, Table A-1, Row 2, p. 61');
  });

  it('validates expected citation pattern', () => {
    const result = validateCitation('ANSI/IES RP-9-20, Table A-1, p. 42');
    expect(result.valid).toBe(true);
  });

  it('flags long quoted passages for copyright checks', () => {
    const violations = checkCopyrightViolations(
      '"This quoted passage intentionally contains far too many words to satisfy the policy limit for direct quoting in generated output."'
    );
    expect(violations.some(v => v.type === 'long_quote')).toBe(true);
  });
});
