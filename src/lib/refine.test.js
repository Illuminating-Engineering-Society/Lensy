/**
 * The AI-written "Refine your search?" follow-up (client wireframes, 2026-08-20).
 *
 * The gating (only on a low-confidence search) lives in handleSearch; these
 * tests cover the prompt and the parser — in particular the two rules that
 * decide what a user actually sees: the question is short, and the suggested
 * terms are vocabulary rather than document designations.
 */

import { describe, it, expect } from 'vitest';
import {
  buildRefinePrompt, parseRefineResponse,
  REFINE_QUESTION_MAX_WORDS, REFINE_TERMS_MAX,
} from './refine';

const result = (category) => ({
  resultType: 'application',
  application: { standard: 'RP-6-24', category },
  excerpt: { text: 'x' },
});

describe('buildRefinePrompt', () => {
  it('asks for a short question and concrete answers, and names the query', () => {
    const prompt = buildRefinePrompt('How do I light a sport?', [result('Soccer')]);
    expect(prompt).toContain('How do I light a sport?');
    expect(prompt).toContain(`${REFINE_QUESTION_MAX_WORDS} words or less`);
    expect(prompt).toContain('NEVER a standard designation');
    expect(prompt).toContain('"question"');
  });

  it('offers the result topics as context but never a designation', () => {
    // An excerpt card's application.category IS the designation — the very
    // thing that put "G-1-22" on screen as a suggestion in the first place.
    const prompt = buildRefinePrompt('circadian', [result('RP-8-25+E2'), result('Parking garages')]);
    expect(prompt).toContain('Parking garages');
    expect(prompt).not.toContain('RP-8-25+E2');
  });
});

describe('parseRefineResponse', () => {
  it('reads the question and terms out of a clean JSON answer', () => {
    const out = parseRefineResponse('{"question": "What sport are you lighting?", "terms": ["soccer", "tennis"]}');
    expect(out.question).toBe('What sport are you lighting?');
    expect(out.terms).toEqual(['soccer', 'tennis']);
  });

  it('finds the JSON inside surrounding chatter', () => {
    const out = parseRefineResponse('Sure! {"question": "Which space type?", "terms": ["lobby"]} Hope that helps.');
    expect(out.question).toBe('Which space type?');
  });

  it('drops designations from the suggested terms', () => {
    const out = parseRefineResponse(
      '{"question": "Which application?", "terms": ["parking garages", "RP-8-25", "ANSI/IES G-1-22", "walkways"]}',
    );
    expect(out.terms).toEqual(['parking garages', 'walkways']);
  });

  it('rejects a question that ignored the word limit', () => {
    const long = Array.from({ length: REFINE_QUESTION_MAX_WORDS + 5 }, (_, i) => `word${i}`).join(' ');
    expect(parseRefineResponse(`{"question": "${long}", "terms": []}`)).toBe(null);
  });

  it('caps the number of terms', () => {
    const terms = Array.from({ length: REFINE_TERMS_MAX + 4 }, (_, i) => `term${i}`);
    const out = parseRefineResponse(`{"question": "Which one?", "terms": ${JSON.stringify(terms)}}`);
    expect(out.terms.length).toBe(REFINE_TERMS_MAX);
  });

  it('returns null for prose, broken JSON, a missing question, or nothing', () => {
    expect(parseRefineResponse('Which sport are you lighting?')).toBe(null);
    expect(parseRefineResponse('{"question": ')).toBe(null);
    expect(parseRefineResponse('{"terms": ["soccer"]}')).toBe(null);
    expect(parseRefineResponse('')).toBe(null);
    expect(parseRefineResponse(null)).toBe(null);
  });

  it('keeps a question with no usable terms — the prompt still helps', () => {
    const out = parseRefineResponse('{"question": "Which space type?", "terms": ["RP-1-24"]}');
    expect(out.question).toBe('Which space type?');
    expect(out.terms).toEqual([]);
  });
});
