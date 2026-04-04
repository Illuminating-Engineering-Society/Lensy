import { describe, it, expect } from 'vitest';
import { formatCitation, validateCitation, checkCopyrightViolations } from './citations.js';

describe('citations', () => {
  it('formats application citation with table and row references', () => {
    const text = formatCitation({
      Standard_Full: 'ANSI/IES RP-9-20',
      Table_Ref: 'Table A-1',
      Row_Ref: 'Row 45',
    });
    expect(text).toBe('ANSI/IES RP-9-20, Table A-1, Row 45');
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
