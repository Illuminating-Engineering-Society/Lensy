import { describe, it, expect, vi } from 'vitest';
import { generateResponse, extractText } from './ai-summary';

// Minimal result shape the prompt builder reads.
const RESULTS = [
  {
    application: {
      fullName: 'Parking Garage → General',
      category: 'Parking Garage',
      standard: 'RP-8-25',
      standardFull: 'ANSI/IES RP-8-25',
      tableRef: 'Table 17-2',
    },
    citation: 'ANSI/IES RP-8-25, Table 17-2, p. 141',
    excerpt: { text: 'Parking garages require uniform illuminance for safety.' },
  },
];

function aiStub(impl) {
  return { run: vi.fn(impl) };
}

describe('generateResponse model fallback (DO9: AI Guide must never vanish)', () => {
  it('returns the primary model response when it succeeds', async () => {
    const ai = aiStub(async () => ({ response: 'Primary model answer citing ANSI/IES RP-8-25.' }));
    const summary = await generateResponse(ai, 'parking garages', RESULTS);
    expect(summary.text).toContain('Primary model answer');
    expect(summary.degraded).toBeUndefined();
    expect(ai.run).toHaveBeenCalledTimes(1);
  });

  it('falls back to the next model when the primary errors', async () => {
    let call = 0;
    const ai = aiStub(async () => {
      call++;
      if (call === 1) throw new Error('model unavailable');
      return { response: 'Fallback model answer.' };
    });
    const summary = await generateResponse(ai, 'parking garages', RESULTS);
    expect(summary.text).toBe('Fallback model answer.');
    expect(summary.degraded).toBeUndefined();
    expect(ai.run).toHaveBeenCalledTimes(2);
  });

  it('treats an empty response as a failure and tries the next model', async () => {
    let call = 0;
    const ai = aiStub(async () => {
      call++;
      return call === 1 ? { response: '   ' } : { response: 'Real answer.' };
    });
    const summary = await generateResponse(ai, 'parking garages', RESULTS);
    expect(summary.text).toBe('Real answer.');
  });

  it('degrades to the standards-list fallback when every model errors — never null', async () => {
    const ai = aiStub(async () => { throw new Error('capacity'); });
    const summary = await generateResponse(ai, 'parking garages', RESULTS);
    expect(summary).not.toBeNull();
    expect(summary.degraded).toBe(true);
    expect(summary.text).toContain('ANSI/IES RP-8-25');

    // The whole chain is attempted, each model exactly once. A chain with only
    // one WORKING link is how DO24 regressed: the second id
    // ('@cf/meta/llama-3.1-8b-instruct-fast') was not a real Workers AI model,
    // so any hiccup on the primary went straight to the fallback.
    const tried = ai.run.mock.calls.map(c => c[0]);
    expect(tried.length).toBeGreaterThan(1);
    expect(new Set(tried).size).toBe(tried.length);
  });
});

// ─── DO25: a degraded comparison still states the deprecation ────────────────

describe('generateResponse comparison mode', () => {
  const COMPARISON = {
    current: { id: 'RP-8-25', name: 'ANSI/IES RP-8-25', url: 'https://view.protectedpdf.com/RP8' },
    deprecated: [{ id: 'RP-8-22', name: 'ANSI/IES RP-8-22', url: 'https://view.protectedpdf.com/RP8OLD' }],
  };

  it('keeps the comparison context and the deprecation statement when every model fails', async () => {
    const ai = aiStub(async () => { throw new Error('capacity'); });
    const summary = await generateResponse(ai, "what's new in RP-8?", RESULTS, {
      mode: 'comparison',
      comparison: COMPARISON,
    });

    expect(summary.mode).toBe('comparison');
    // The UI renders the hyperlinked advisory from this — it must survive.
    expect(summary.comparison).toEqual(COMPARISON);
    expect(summary.text).toContain('ANSI/IES RP-8-22 is deprecated');
    expect(summary.text).toContain('ANSI/IES RP-8-25');
    expect(summary.text).toMatch(/manual review/i);
  });

  it('carries the mode and context through on a successful generation', async () => {
    const ai = aiStub(async () => ({ response: 'What appears to be new\n- Chapter 17 adds EV charging guidance (§17.4.3).' }));
    const summary = await generateResponse(ai, "what's new in RP-8?", RESULTS, {
      mode: 'comparison',
      comparison: COMPARISON,
    });

    expect(summary.mode).toBe('comparison');
    expect(summary.comparison).toEqual(COMPARISON);
    expect(summary.text).toContain('What appears to be new');
    expect(summary.disclaimer).toMatch(/manual review/i);
  });
});

// ─── DO24: read the answer whatever shape the model returns ──────────────────
// Workers AI is not uniform: classic Llama models answer with `{ response }`,
// newer ones (and the OpenAI-compatible endpoint) with
// `{ choices: [{ message: { content } }] }`. Reading only `.response` made a
// good answer look empty and sent the AI Guide to its standards-list fallback.

describe('extractText', () => {
  it('reads the classic Workers AI shape', () => {
    expect(extractText({ response: 'Guidance text.' })).toBe('Guidance text.');
  });

  it('reads the OpenAI-compatible shape', () => {
    expect(extractText({ choices: [{ message: { content: 'Guidance text.' } }] })).toBe('Guidance text.');
    expect(extractText({ choices: [{ text: 'Guidance text.' }] })).toBe('Guidance text.');
  });

  it('reads wrapped and array-of-parts shapes', () => {
    expect(extractText({ result: { response: 'Guidance text.' } })).toBe('Guidance text.');
    expect(extractText({ response: [{ text: 'Guidance ' }, { text: 'text.' }] })).toBe('Guidance text.');
  });

  it('treats blank and unreadable payloads as no text', () => {
    expect(extractText({ response: '   ' })).toBeNull();
    expect(extractText({ usage: { tokens: 0 } })).toBeNull();
    expect(extractText(null)).toBeNull();
    expect(extractText(undefined)).toBeNull();
  });

  it('is used by generateResponse, so an OpenAI-shaped model is not a failure', async () => {
    const ai = aiStub(async () => ({ choices: [{ message: { content: 'Real guidance citing ANSI/IES RP-8-25.' } }] }));
    const summary = await generateResponse(ai, 'parking garages', RESULTS);
    expect(summary.text).toContain('Real guidance');
    expect(summary.degraded).toBeUndefined();
    expect(ai.run).toHaveBeenCalledTimes(1); // first model accepted — no chain walk
  });
});
