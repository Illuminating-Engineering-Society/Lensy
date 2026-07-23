import { describe, it, expect, vi } from 'vitest';
import { generateResponse } from './ai-summary';

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
    expect(ai.run).toHaveBeenCalledTimes(2); // both models attempted
  });
});
