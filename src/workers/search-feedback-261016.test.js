import { describe, it, expect } from 'vitest';
import { dropUngroundedDesignations, UNGROUNDED_FALLBACK } from '../lib/guide-links';
import { nonSubscriberCards } from './search';

// Dan, 2026-10-16: recording a tutorial as a Non-Subscriber, the AI Guide opened
// "According to ANSI/IES RP-33-99, Section 5, p. 12, exterior facade lighting …".
// RP-33-99 is a real 1999 IESNA document, but it is in no index IES Lens holds:
// the only RP-33 text in the corpus is "IES RP-33-14" in RP-39-19's bibliography,
// and RP-39 is outside the Lighting Science Collection a Non-Subscriber searches.
// The model wrote it — and its "Section 5, p. 12" — from memory.
describe('the AI Guide may not name a standard nothing grounded (client 10/16/26)', () => {
  const index = new Map([
    ['RP-43-25', { status: 'Active', webUrl: 'https://lighting.ies.org/r43' }],
    ['LS-6-20(R2025)', { status: 'Active', webUrl: 'https://lighting.ies.org/ls6' }],
    ['RP-33-14', { status: 'Deprecated', webUrl: 'https://lighting.ies.org/ayRAxj' }],
    ['RP-8-22', { status: 'Deprecated', webUrl: 'https://lighting.ies.org/r822' }],
  ]);

  it('drops the paragraph built on a designation the catalogue does not hold', () => {
    const text = 'According to ANSI/IES RP-33-99, Section 5, p. 12, exterior facade lighting should balance aesthetics and visibility. In simplified terms, this means considering the overall visual impact.\n\n'
      + 'ANSI/IES LS-6-20 defines the luminance quantities involved.';
    const out = dropUngroundedDesignations(text, index, ['ANSI/IES LS-6-20(R2025)']);
    expect(out.removed).toEqual(['RP-33-99']);
    expect(out.text).toBe('ANSI/IES LS-6-20 defines the luminance quantities involved.');
  });

  it('replaces an answer with nothing grounded left by the honest fallback', () => {
    const text = 'According to ANSI/IES RP-33-99, Section 5, p. 12, facades need balance.\n\nIn simplified terms, consider the park.';
    const out = dropUngroundedDesignations(text, index, []);
    expect(out.removed).toEqual(['RP-33-99']);
    expect(out.text).toBe(UNGROUNDED_FALLBACK);
  });

  it('keeps a designation the results themselves printed, even a deprecated one', () => {
    // A reference entry legitimately cites an old edition.
    const text = 'ANSI/IES RP-39-19 refers readers to IES RP-33-14 for lighting zones.';
    const out = dropUngroundedDesignations(text, index, ['IES RP-33-14, Lighting for Exterior Environments. New York: IES; 2014.', 'RP-39-19']);
    expect(out.removed).toEqual([]);
    expect(out.text).toBe(text);
  });

  it('does not let a cited edition vouch for another edition of its family', () => {
    const text = 'ANSI/IES RP-33-99 covers exterior environments.';
    const out = dropUngroundedDesignations(text, index, ['IES RP-33-14, Lighting for Exterior Environments.']);
    expect(out.removed).toEqual(['RP-33-99']);
  });

  it('allows a CURRENT catalogue standard outside the results (further reading)', () => {
    const text = 'ANSI/IES LS-6-20 defines luminance.\n\n**Further reading:** ANSI/IES RP-43-25 covers facade lighting.';
    const out = dropUngroundedDesignations(text, index, ['LS-6-20(R2025)']);
    expect(out.removed).toEqual([]);
    expect(out.text).toBe(text);
  });

  it('refuses a deprecated edition from memory, except on a comparison', () => {
    const text = 'ANSI/IES LS-6-20 defines luminance.\n\nANSI/IES RP-8-22 also covers roadways.';
    expect(dropUngroundedDesignations(text, index, ['LS-6-20']).removed).toEqual(['RP-8-22']);
    expect(dropUngroundedDesignations(text, index, ['LS-6-20'], { allowDeprecated: true }).removed).toEqual([]);
  });

  it('drops only the offending item of a list', () => {
    const text = 'Two standards apply:\n- ANSI/IES RP-43-25, Section 8, for facades.\n- ANSI/IES RP-33-99, Section 5, for parks.';
    const out = dropUngroundedDesignations(text, index, ['RP-43-25']);
    expect(out.removed).toEqual(['RP-33-99']);
    expect(out.text).toBe('Two standards apply:\n- ANSI/IES RP-43-25, Section 8, for facades.');
  });

  it('leaves an answer that names nothing untouched', () => {
    const text = 'The standards in these results do not appear to cover this question.';
    expect(dropUngroundedDesignations(text, index, [])).toEqual({ text, removed: [] });
  });
});

// Dan, 10/16/26: "All 3 responses should be the same in AI Guide (the difference
// being that subscribers can open anything it references and others can't)".
// The Guide now reads the subscriber's pool; this is the one place the
// Non-Subscriber's cards are cut from it.
describe('nonSubscriberCards (client 10/16/26)', () => {
  const card = (resultType, standard) => ({ resultType, application: { standard } });
  const allowed = new Set(['LS-6-20+E1']);

  it('keeps References, Definitions and document cards of the collection, in order', () => {
    const out = nonSubscriberCards([
      card('application', 'RP-43-25'),     // a table row — subscriber content
      card('excerpt', 'LS-6-20+E1'),       // a passage — subscriber content
      card('reference', 'RP-43-25'),       // outside the collection
      card('reference', 'LS-6-20+E1'),
      card('definition', 'LS-1-25'),
      card('standard', 'LS-6-20+E1'),
      card(undefined, 'LS-6-20+E1'),       // no resultType = a table row
    ], allowed);
    expect(out.map(r => `${r.resultType}:${r.application.standard}`))
      .toEqual(['reference:LS-6-20+E1', 'definition:LS-1-25', 'standard:LS-6-20+E1']);
  });
});
