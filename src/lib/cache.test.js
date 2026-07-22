import { describe, it, expect } from 'vitest';
import {
  sha256Hex,
  stableStringify,
  buildSearchCacheKey,
  getDataVersion,
  bumpDataVersion,
  getCachedEmbedding,
  putCachedEmbedding,
  getCachedSearch,
  putCachedSearch,
  buildAISummaryCacheKey,
  getCachedAISummary,
  putCachedAISummary,
} from './cache';

/** Minimal in-memory KV namespace mock. */
function mockKV() {
  const store = new Map();
  return {
    store,
    async get(key, opts) {
      const raw = store.get(key);
      if (raw == null) return null;
      return opts?.type === 'json' ? JSON.parse(raw) : raw;
    },
    async put(key, value) {
      store.set(key, value);
    },
  };
}

describe('stableStringify', () => {
  it('produces identical output regardless of key order', () => {
    expect(stableStringify({ a: 1, b: { c: 2, d: 3 } }))
      .toBe(stableStringify({ b: { d: 3, c: 2 }, a: 1 }));
  });

  it('distinguishes different values', () => {
    expect(stableStringify({ a: 1 })).not.toBe(stableStringify({ a: 2 }));
  });

  it('drops undefined values so absent and undefined filters match', () => {
    expect(stableStringify({ a: 1, b: undefined })).toBe(stableStringify({ a: 1 }));
  });

  it('handles arrays, nulls, and primitives', () => {
    expect(stableStringify([1, 'x', null])).toBe('[1,"x",null]');
    expect(stableStringify(null)).toBe('null');
  });
});

describe('buildSearchCacheKey', () => {
  it('is stable for logically equal params', async () => {
    const a = await buildSearchCacheKey('v1', { query: 'spa', filters: { x: 1, y: 2 } });
    const b = await buildSearchCacheKey('v1', { filters: { y: 2, x: 1 }, query: 'spa' });
    expect(a).toBe(b);
  });

  it('changes when the data version changes', async () => {
    const a = await buildSearchCacheKey('v1', { query: 'spa' });
    const b = await buildSearchCacheKey('v2', { query: 'spa' });
    expect(a).not.toBe(b);
  });

  it('changes when params change', async () => {
    const a = await buildSearchCacheKey('v1', { query: 'spa', includeAISummary: false });
    const b = await buildSearchCacheKey('v1', { query: 'spa', includeAISummary: true });
    expect(a).not.toBe(b);
  });
});

describe('sha256Hex', () => {
  it('hashes deterministically', async () => {
    expect(await sha256Hex('hello')).toBe(await sha256Hex('hello'));
    expect(await sha256Hex('hello')).not.toBe(await sha256Hex('Hello'));
  });
});

describe('data version', () => {
  it('defaults to "0" and changes after a bump', async () => {
    const kv = mockKV();
    expect(await getDataVersion(kv)).toBe('0');
    await bumpDataVersion(kv);
    const v = await getDataVersion(kv);
    expect(v).not.toBe('0');
  });
});

describe('embedding cache', () => {
  it('round-trips a vector', async () => {
    const kv = mockKV();
    const vec = [0.1, -0.2, 0.3];
    await putCachedEmbedding(kv, 'model-x', 'some query', vec);
    expect(await getCachedEmbedding(kv, 'model-x', 'some query')).toEqual(vec);
  });

  it('misses for a different model or text', async () => {
    const kv = mockKV();
    await putCachedEmbedding(kv, 'model-x', 'some query', [1]);
    expect(await getCachedEmbedding(kv, 'model-y', 'some query')).toBeNull();
    expect(await getCachedEmbedding(kv, 'model-x', 'other query')).toBeNull();
  });
});

describe('search cache', () => {
  it('round-trips a payload', async () => {
    const kv = mockKV();
    const key = await buildSearchCacheKey('v1', { query: 'spa' });
    const payload = { query: 'spa', results: [{ relevanceScore: 0.9 }] };
    await putCachedSearch(kv, key, payload);
    expect(await getCachedSearch(kv, key)).toEqual(payload);
  });
});

describe('AI summary cache', () => {
  it('keys on query + result set + data version', async () => {
    const a = await buildAISummaryCacheKey('v1', 'summary', 'spa lighting', ['A1', 'A2']);
    const same = await buildAISummaryCacheKey('v1', 'summary', 'spa lighting', ['A1', 'A2']);
    const otherResults = await buildAISummaryCacheKey('v1', 'summary', 'spa lighting', ['A1', 'B9']);
    const otherVersion = await buildAISummaryCacheKey('v2', 'summary', 'spa lighting', ['A1', 'A2']);
    expect(a).toBe(same);
    expect(a).not.toBe(otherResults);
    expect(a).not.toBe(otherVersion);
  });

  it('round-trips a summary and fails open without KV', async () => {
    const kv = mockKV();
    const key = await buildAISummaryCacheKey('v1', 'summary', 'q', ['A1']);
    const summary = { text: 'cited answer', watermark: 'w', disclaimer: 'd' };
    await putCachedAISummary(kv, key, summary);
    expect(await getCachedAISummary(kv, key)).toEqual(summary);
    expect(await getCachedAISummary(undefined, key)).toBeNull();
    await putCachedAISummary(undefined, key, summary); // no-op, must not throw
  });
});

describe('fail-open behavior (no KV binding)', () => {
  it('never throws and returns nulls/no-ops', async () => {
    expect(await getDataVersion(undefined)).toBe('0');
    await bumpDataVersion(undefined);
    expect(await getCachedEmbedding(undefined, 'm', 't')).toBeNull();
    await putCachedEmbedding(undefined, 'm', 't', [1]);
    expect(await getCachedSearch(undefined, 'k')).toBeNull();
    await putCachedSearch(undefined, 'k', {});
  });

  it('swallows KV errors', async () => {
    const broken = {
      get: async () => { throw new Error('kv down'); },
      put: async () => { throw new Error('kv down'); },
    };
    expect(await getDataVersion(broken)).toBe('0');
    await bumpDataVersion(broken);
    expect(await getCachedEmbedding(broken, 'm', 't')).toBeNull();
    await putCachedEmbedding(broken, 'm', 't', [1]);
    expect(await getCachedSearch(broken, 'k')).toBeNull();
    await putCachedSearch(broken, 'k', {});
  });
});
