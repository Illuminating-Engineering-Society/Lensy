import { describe, it, expect } from 'vitest';
import { parseAnalyticsWindow, demoQueryKeys, logScope } from './analytics-scope';

const NOW = new Date('2026-11-20T15:30:00Z');
const win = (qs) => parseAnalyticsWindow(new URLSearchParams(qs), NOW);

describe('parseAnalyticsWindow (11/19/26 #6)', () => {
  it('defaults to the last 30 days, open-ended', () => {
    expect(win('')).toEqual({
      since: '2026-10-21 15:30:00', until: null, from: '2026-10-21', to: '2026-11-20', days: 30, custom: false,
    });
    expect(win('days=7').days).toBe(7);
    expect(win('days=99999').days).toBe(365);
    expect(win('days=abc').days).toBe(30);
  });

  it('reads a custom range as whole UTC days, both inclusive', () => {
    expect(win('from=2026-11-04&to=2026-11-06')).toEqual({
      since: '2026-11-04 00:00:00', until: '2026-11-07 00:00:00',
      from: '2026-11-04', to: '2026-11-06', days: 3, custom: true,
    });
    // One day is a range.
    expect(win('from=2026-11-05&to=2026-11-05')).toMatchObject({ days: 1, until: '2026-11-06 00:00:00' });
  });

  it('fills in a missing end', () => {
    expect(win('from=2026-11-10')).toMatchObject({ from: '2026-11-10', to: '2026-11-20', days: 11, custom: true });
    expect(win('to=2026-10-31')).toMatchObject({ from: '2026-10-02', to: '2026-10-31', days: 30, custom: true });
  });

  it('refuses what is not a range', () => {
    expect(win('from=2026-11-10&to=2026-11-01')).toEqual({ error: 'from must not be after to' });
    expect(win('from=11/10/2026')).toEqual({ error: 'from must be a date, YYYY-MM-DD' });
    expect(win('from=2026-02-31')).toEqual({ error: 'from must be a date, YYYY-MM-DD' });
    expect(win("to=2026-11-01'; DROP TABLE search_log;--")).toEqual({ error: 'to must be a date, YYYY-MM-DD' });
    expect(win('from=2024-01-01&to=2026-11-01').error).toMatch(/at most 366 days/);
  });
});

describe('logScope (11/19/26 #7)', () => {
  const window = win('from=2026-11-04&to=2026-11-06');

  it('knows the demo searches the page offers', () => {
    const demos = demoQueryKeys();
    expect(demos).toContain('what are considerations for lighting parking garages?');
    expect(demos).toHaveLength(4);
    expect(demos.every(d => d === d.toLowerCase().trim())).toBe(true);
  });

  it('leaves staff and demo searches out by default, with every value bound', () => {
    const scope = logScope(window, { hasAudience: true });
    expect(scope.where).toBe(
      "created_at >= ? AND created_at < ? AND (audience IS NULL OR audience <> 'staff') "
      + 'AND LOWER(TRIM(query)) NOT IN (?, ?, ?, ?)');
    expect(scope.binds).toEqual(['2026-11-04 00:00:00', '2026-11-07 00:00:00', ...demoQueryKeys()]);
  });

  it('includes them when asked', () => {
    const scope = logScope(window, { hasAudience: true, includeStaff: true, includeDemos: true });
    expect(scope.where).toBe('created_at >= ? AND created_at < ?');
    expect(scope.binds).toHaveLength(2);
  });

  it('works on a database without the audience column, and on the click log', () => {
    expect(logScope(window, { hasAudience: false }).where).not.toContain('audience');
    const events = logScope(win('days=7'), { hasAudience: true, hasQuery: false, table: 'search_events' });
    expect(events.where).toBe("search_events.created_at >= ? AND (search_events.audience IS NULL OR search_events.audience <> 'staff')");
    expect(events.binds).toEqual(['2026-11-13 15:30:00']);
  });
});
