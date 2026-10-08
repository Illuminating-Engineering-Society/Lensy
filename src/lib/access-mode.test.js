import { describe, it, expect } from 'vitest';
import { parseAccessMode, readAccessMode, writeAccessMode } from './access-mode';

function fakeKv({ failGet = false } = {}) {
  const store = new Map();
  return {
    store,
    async get(key) {
      if (failGet) throw new Error('kv down');
      return store.has(key) ? store.get(key) : null;
    },
    async put(key, value) { store.set(key, value); },
  };
}

describe('parseAccessMode', () => {
  it('accepts the two modes, loosely spelled', () => {
    expect(parseAccessMode('open')).toBe('open');
    expect(parseAccessMode('staff_only')).toBe('staff_only');
    expect(parseAccessMode('Staff-Only')).toBe('staff_only');
  });
  it('rejects anything else', () => {
    expect(parseAccessMode('closed')).toBeNull();
    expect(parseAccessMode(undefined)).toBeNull();
  });
});

describe('readAccessMode', () => {
  it('falls back to the var, then to open', async () => {
    expect((await readAccessMode({ SESSIONS: fakeKv() }, 'prod')).mode).toBe('open');
    const state = await readAccessMode({ SESSIONS: fakeKv(), LENSY_ACCESS_MODE: 'staff_only' }, 'prod');
    expect(state).toMatchObject({ mode: 'staff_only', source: 'default', defaultMode: 'staff_only' });
  });

  it('the dashboard choice overrides the var', async () => {
    const env = { SESSIONS: fakeKv(), LENSY_ACCESS_MODE: 'staff_only' };
    await writeAccessMode(env, 'prod', 'open', 'staffer@ies.org');
    expect(await readAccessMode(env, 'prod')).toMatchObject({
      mode: 'open', source: 'dashboard', updatedBy: 'staffer@ies.org',
    });
  });

  it('staging and production are switched apart', async () => {
    const env = { SESSIONS: fakeKv() };
    await writeAccessMode(env, 'stg', 'staff_only', null);
    expect((await readAccessMode(env, 'stg')).mode).toBe('staff_only');
    expect((await readAccessMode(env, 'prod')).mode).toBe('open');
  });

  it('a KV failure keeps the deployment default rather than reopening', async () => {
    const env = { SESSIONS: fakeKv({ failGet: true }), LENSY_ACCESS_MODE: 'staff_only' };
    expect((await readAccessMode(env, 'prod')).mode).toBe('staff_only');
  });
});
