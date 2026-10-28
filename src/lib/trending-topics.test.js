import { describe, it, expect } from 'vitest';
import { buildTopicPrompt, rankTopics } from './trending-topics';

const queries = [
  { query: 'football field lighting', searches: 9 },
  { query: 'stadium', searches: 4 },
  { query: 'office lighting', searches: 6 },
  { query: 'pool lighting', searches: 2 },
  { query: 'TM-30', searches: 3 },
];

describe('rankTopics', () => {
  it('counts searches from the log, not from the model, and ranks by them', () => {
    const topics = rankTopics('Here: {"Sports": [1, 2, 4], "Offices": [3], "Color Rendition": [5]}', queries);
    expect(topics.map(t => [t.topic, t.searches, t.queries])).toEqual([
      ['Sports', 15, 3], ['Offices', 6, 1], ['Color Rendition', 3, 1],
    ]);
    expect(topics[0].examples[0]).toBe('football field lighting');
  });

  it('ignores out-of-range numbers, repeats across topics and empty topics', () => {
    const topics = rankTopics('{"Sports": [1, 1, 99, 0], "sports": [2], "Empty": [], "Again": [1]}', queries);
    expect(topics).toEqual([{ topic: 'Sports', searches: 13, queries: 2, examples: ['football field lighting', 'stadium'] }]);
  });

  it('returns nothing for an answer that is not a JSON object', () => {
    expect(rankTopics('I cannot help with that.', queries)).toEqual([]);
    expect(rankTopics('[1, 2]', queries)).toEqual([]);
  });
});

describe('buildTopicPrompt', () => {
  it('numbers every query from 1', () => {
    const p = buildTopicPrompt(queries);
    expect(p).toContain('1. football field lighting');
    expect(p).toContain('5. TM-30');
  });
});
