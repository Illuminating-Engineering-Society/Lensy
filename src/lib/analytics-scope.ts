/**
 * Which rows of the search log an analytics view counts (Dan, Teams 11/19/26).
 *
 *   #6  "can you add a 'custom date range' (or similar) option for the
 *        analytics window? It would be useful for gaining insights during our
 *        virtual symposia"
 *   #7  "block any 'staff' role searches from appearing in search analytics …
 *        I think it's also advisable to block exact copies of the 'Try
 *        Searching For' searches"
 *
 * One definition, used by the dashboard's aggregates and by the trending
 * topics, so the two can never count different searches:
 *
 *   window   — the last N days, or a custom range of whole UTC days
 *   staff    — rows whose `audience` is 'staff' are left out (migration 0031;
 *              rows logged before it carry no audience and stay in)
 *   demos    — exact copies of the "Try searching for" demo searches are left
 *              out, compared case-insensitively on the trimmed text
 *
 * Every value reaches SQL as a bound parameter; the only SQL text built here is
 * column names and placeholders.
 */

// The search page's own list — a classic browser script that registers
// globalThis.LENS_DEMO_SEARCHES when imported here.
import '../frontend/utils/demo-searches.js';

export const MAX_WINDOW_DAYS = 366;

export interface AnalyticsWindow {
  /** Inclusive start and EXCLUSIVE end, as SQLite UTC datetimes. */
  since: string;
  until: string | null;
  /** The same window as calendar days, both inclusive (for the UI's bars). */
  from: string;
  to: string;
  days: number;
  custom: boolean;
}

const DAY_MS = 86_400_000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const sqlDateTime = (d: Date) => d.toISOString().slice(0, 19).replace('T', ' ');
const isoDay = (d: Date) => d.toISOString().slice(0, 10);

function parseDay(value: string | null): Date | null {
  if (!value || !DATE_RE.test(value)) return null;
  const d = new Date(`${value}T00:00:00Z`);
  // "2026-02-31" parses to March 3: only a date that round-trips is a date.
  return Number.isNaN(d.getTime()) || isoDay(d) !== value ? null : d;
}

/**
 * ?days=30, or ?from=YYYY-MM-DD&to=YYYY-MM-DD (either end may be omitted: no
 * `to` means today, no `from` means the 30 days ending at `to`). Days are UTC,
 * the clock search_log.created_at is written in.
 */
export function parseAnalyticsWindow(
  params: URLSearchParams, now: Date = new Date(),
): AnalyticsWindow | { error: string } {
  const rawFrom = params.get('from');
  const rawTo = params.get('to');

  if (rawFrom || rawTo) {
    const today = parseDay(isoDay(now))!;
    const to = rawTo ? parseDay(rawTo) : today;
    if (!to) return { error: 'to must be a date, YYYY-MM-DD' };
    const from = rawFrom ? parseDay(rawFrom) : new Date(to.getTime() - 29 * DAY_MS);
    if (!from) return { error: 'from must be a date, YYYY-MM-DD' };
    if (from.getTime() > to.getTime()) return { error: 'from must not be after to' };
    const days = Math.round((to.getTime() - from.getTime()) / DAY_MS) + 1;
    if (days > MAX_WINDOW_DAYS) return { error: `a range may cover at most ${MAX_WINDOW_DAYS} days` };
    return {
      since: sqlDateTime(from),
      until: sqlDateTime(new Date(to.getTime() + DAY_MS)),
      from: isoDay(from), to: isoDay(to), days, custom: true,
    };
  }

  const days = Math.min(365, Math.max(1, parseInt(params.get('days') || '30', 10) || 30));
  const start = new Date(now.getTime() - days * DAY_MS);
  return { since: sqlDateTime(start), until: null, from: isoDay(start), to: isoDay(now), days, custom: false };
}

/** The demo searches as the log would hold them: trimmed, lower-cased. */
export function demoQueryKeys(): string[] {
  const list = (globalThis as { LENS_DEMO_SEARCHES?: Array<{ query?: unknown }> }).LENS_DEMO_SEARCHES;
  if (!Array.isArray(list)) return [];
  return [...new Set(list.map(d => String(d?.query ?? '').trim().toLowerCase()).filter(Boolean))];
}

export interface ScopeOptions {
  /** Count IES staff searches too. Default: left out. */
  includeStaff?: boolean;
  /** Count the demo searches too. Default: left out. */
  includeDemos?: boolean;
  /** Does the table have the `audience` column (migration 0031)? */
  hasAudience: boolean;
  /** Table alias or name prefix for the columns, e.g. "search_log". */
  table?: string;
  /** False for search_events, whose rows are clicks rather than queries. */
  hasQuery?: boolean;
}

export interface SqlScope { where: string; binds: string[] }

/** The WHERE clause (without the keyword) and its bindings for one view. */
export function logScope(window: AnalyticsWindow, opts: ScopeOptions): SqlScope {
  const col = (name: string) => (opts.table ? `${opts.table}.${name}` : name);
  const parts = [`${col('created_at')} >= ?`];
  const binds = [window.since];
  if (window.until) {
    parts.push(`${col('created_at')} < ?`);
    binds.push(window.until);
  }
  if (!opts.includeStaff && opts.hasAudience) {
    parts.push(`(${col('audience')} IS NULL OR ${col('audience')} <> 'staff')`);
  }
  if (!opts.includeDemos && opts.hasQuery !== false) {
    const demos = demoQueryKeys();
    if (demos.length > 0) {
      parts.push(`LOWER(TRIM(${col('query')})) NOT IN (${demos.map(() => '?').join(', ')})`);
      binds.push(...demos);
    }
  }
  return { where: parts.join(' AND '), binds };
}

/** Does `table` have `column`? One cheap probe; false on any error. */
export async function hasColumn(db: D1Database, table: 'search_log' | 'search_events', column: 'audience' | 'attempt'): Promise<boolean> {
  try {
    await db.prepare(`SELECT ${column} FROM ${table} LIMIT 1`).first();
    return true;
  } catch {
    return false;
  }
}
