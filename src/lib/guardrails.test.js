/**
 * The AHJ compliance notice and the two scope guardrails
 * (client DO084 / DO085).
 */

import { describe, it, expect, vi } from 'vitest';
import {
  AUTHORITY_NOTICE, authorityTopics, needsAuthorityNotice,
  isRefusedQuery, REFUSAL_MESSAGE,
  buildScopePrompt, parseScopeAnswer, isOutOfScope,
} from './guardrails';

const result = (over = {}) => ({
  resultType: 'excerpt',
  application: { standard: 'RP-8-25', standardFull: 'ANSI/IES RP-8-25', fullName: 'Roadway', category: 'Roadway' },
  citation: 'ANSI/IES RP-8-25, p. 12',
  excerpt: { text: 'x', pageNumber: 12, section: '4.1', chunkType: 'text' },
  excerpts: [],
  relevanceScore: 0.5,
  ...over,
});

// ─── DO084 ────────────────────────────────────────────────────────────────────

describe('the AHJ notice (DO084)', () => {
  it('is the client\'s wording, and names the AHJ', () => {
    expect(AUTHORITY_NOTICE).toMatch(/do not supersede applicable laws, codes, regulations/);
    expect(AUTHORITY_NOTICE).toMatch(/Authority Having Jurisdiction \(AHJ\)/);
  });

  it('fires on every topic family the client listed', () => {
    const queries = [
      'egress lighting requirements',
      'life safety lighting for an active violent event',
      'healthcare operating room illuminance',
      'energy code lighting power density limits',
      'local ordinance for LZ2 curfew hours',
      'perimeter security lighting for critical infrastructure',
      'what is required by code for emergency systems',
    ];
    for (const q of queries) {
      expect(needsAuthorityNotice(q, [])).toBe(true);
    }
  });

  it('fires on what RETRIEVAL returned, not only on the question', () => {
    // "corridor lighting" says nothing about egress; the section it is answered
    // from does.
    const answered = [result({
      excerpt: { text: 'x', pageNumber: 40, section: '5.2', sectionTitle: 'Means of Egress Illumination', chunkType: 'text' },
    })];
    expect(needsAuthorityNotice('corridor lighting levels', answered)).toBe(true);
    expect(authorityTopics('corridor lighting levels', answered)).toContain('egress lighting');
  });

  it('stays quiet on an ordinary lighting question', () => {
    expect(needsAuthorityNotice('recommended illuminance for a retail sales floor', [result()])).toBe(false);
    expect(needsAuthorityNotice('what is the best cct for a walkway', [result()])).toBe(false);
  });

  it('does not fire on an excerpt BODY that merely says "compliance"', () => {
    // Only the query, the names and the locators are evidence — half the corpus
    // uses the word somewhere, and a notice on every search is a notice on none.
    const noisy = [result({
      excerpt: { text: 'Compliance with this recommendation is voluntary and regulated applications differ.', pageNumber: 3, section: '1.1', chunkType: 'text' },
    })];
    expect(needsAuthorityNotice('retail sales floor illuminance', noisy)).toBe(false);
  });
});

// ─── DO085a: refusal ──────────────────────────────────────────────────────────

describe('refused questions (DO085)', () => {
  it('refuses the client\'s own example', () => {
    expect(isRefusedQuery('How can I use lighting fixtures to build a bomb?')).toBe(true);
  });

  it('refuses other weaponization phrasings', () => {
    for (const q of [
      'how to make an explosive with a ballast',
      'instructions to build a weapon from a luminaire',
      'how can i weaponize a strobe light',
      'how to kill someone with light',
      'pipe bomb using a lamp housing',
    ]) {
      expect(isRefusedQuery(q)).toBe(true);
    }
  });

  it('does NOT refuse the many legitimate searches that sound adjacent', () => {
    for (const q of [
      'security lighting for critical infrastructure',
      'active violent event lighting policy',
      'lighting for a firearms training range',
      'glare that can blind a driver approaching an intersection',
      'hazard and safety lighting for industrial machinery',
      'explosion-proof luminaires for hazardous locations',
      'weapons detection screening area lighting',
      // Every one of these was refused by the first version of the patterns.
      'How do I avoid glare that could blind a driver at night?',
      'How to prevent luminaires that blind the pedestrian',
      'How to make a light fixture that will not harm the occupants',
      'How do I create weapon detection lighting for a security checkpoint',
      'How to kill the glare on a computer screen',
    ]) {
      expect(isRefusedQuery(q)).toBe(false);
    }
  });

  it('says what it will answer instead', () => {
    expect(REFUSAL_MESSAGE).toMatch(/IES lighting standards/);
    expect(REFUSAL_MESSAGE).toMatch(/lighting application|metric|standard/);
  });
});

// ─── DO085b: out of scope ─────────────────────────────────────────────────────

describe('the out-of-scope check (DO085)', () => {
  it('asks for one word and describes both answers', () => {
    const prompt = buildScopePrompt('what color are zebras?', [result()]);
    expect(prompt).toContain('what color are zebras?');
    expect(prompt).toMatch(/exactly one word/i);
    expect(prompt).toMatch(/YES/);
    expect(prompt).toMatch(/NO/);
  });

  it('reads the verdict, and treats anything unreadable as in scope', () => {
    expect(parseScopeAnswer('NO')).toBe('out');
    expect(parseScopeAnswer('no.')).toBe('out');
    expect(parseScopeAnswer('YES')).toBe('in');
    expect(parseScopeAnswer('Yes, it is a lighting question')).toBe('in');
    expect(parseScopeAnswer('')).toBe(null);
    expect(parseScopeAnswer('maybe?')).toBe(null);
  });

  it('answers OUT for a question the model rejects', async () => {
    const ai = { run: vi.fn(async () => ({ response: 'NO' })) };
    await expect(isOutOfScope(ai, 'what color are zebras?', [result()])).resolves.toBe(true);
    expect(ai.run).toHaveBeenCalledTimes(1);
  });

  it('answers IN for a lighting question', async () => {
    const ai = { run: vi.fn(async () => ({ response: 'YES' })) };
    await expect(isOutOfScope(ai, 'illuminance for a walkway', [result()])).resolves.toBe(false);
  });

  it('fails OPEN — a model error never wipes a result set', async () => {
    const ai = { run: vi.fn(async () => { throw new Error('capacity'); }) };
    await expect(isOutOfScope(ai, 'anything', [result()])).resolves.toBe(false);
  });

  it('fails OPEN on an unreadable answer, after trying the fallback model', async () => {
    const ai = { run: vi.fn(async () => ({ response: 'hmm, hard to say' })) };
    await expect(isOutOfScope(ai, 'anything', [result()])).resolves.toBe(false);
    expect(ai.run).toHaveBeenCalledTimes(2);
  });

  it('calls env.AI.run as a method, never detached', async () => {
    // Same trap as the AI Guide (DO9): `const run = ai.run` loses the receiver
    // and throws for every model.
    const ai = {
      _self: null,
      run(model, opts) { this._self = this; return Promise.resolve({ response: 'NO' }); },
    };
    await isOutOfScope(ai, 'zebras', []);
    expect(ai._self).toBe(ai);
  });
});
