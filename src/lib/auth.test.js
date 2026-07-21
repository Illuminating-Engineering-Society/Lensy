import { describe, it, expect } from 'vitest';
import { checkAuth } from './auth.js';

function req(token) {
  return {
    headers: {
      get: (name) => (name === 'authorization' && token != null ? token : null),
    },
  };
}

describe('checkAuth', () => {
  it('accepts the correct bearer token', async () => {
    const env = { LUCIUS_API_SECRET: 's3cret' };
    expect((await checkAuth(req('Bearer s3cret'), env)).ok).toBe(true);
    expect((await checkAuth(req('s3cret'), env)).ok).toBe(true); // bare token accepted
  });

  it('rejects a wrong or missing token', async () => {
    const env = { LUCIUS_API_SECRET: 's3cret' };
    expect((await checkAuth(req('Bearer wrong'), env)).ok).toBe(false);
    expect((await checkAuth(req(null), env)).ok).toBe(false);
  });

  it('fails CLOSED in production when no secret is configured', async () => {
    const res = await checkAuth(req('anything'), { ENVIRONMENT: 'production' });
    expect(res.ok).toBe(false);
    expect(res.reason).toContain('LUCIUS_API_SECRET');
  });

  it('allows local dev without a secret', async () => {
    expect((await checkAuth(req(null), { ENVIRONMENT: 'development' })).ok).toBe(true);
    expect((await checkAuth(req(null), {})).ok).toBe(true);
  });
});
