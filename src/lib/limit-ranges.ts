/**
 * RP-43's lower and upper limits, merged into one range (client 10/06/26 #1).
 *
 * "Much of RP-43 has 'upper limit' and 'lower limit' in each of 4 LZs. Can we
 *  merge upper & lower and display as a range in the illuminance cell? So when
 *  we click on Lz1 it might read '2-4 lx'."
 *
 * The table prints each zone as TWO rows — "Lower limit (avg.)" and "Upper
 * limit (avg.)" — and the extractor stores them as two application rows whose
 * hierarchy differs only in that level. Measured on production (2026-10-09):
 * all 226 of RP-43-25's rows are limit rows, and within a pair NOTHING but the
 * illuminance values differs (uniformity, glare, uplight, controls, spectrum
 * and page are identical across all 100 pairs checked) — so a merge loses no
 * information. The pair becomes one result whose planes carry `luxMax`/`fcMax`
 * beside `lux`/`fc`, and the limit level leaves the hierarchy, which is what
 * lets the zones of one application fall into a single tabbed card.
 *
 * Pure: the caller supplies the partner rows it fetched (search.ts), so this
 * runs without D1 in the tests. A row whose partner cannot be found is left
 * exactly as it was — it still says "Lower limit (avg.)", which is true.
 */
import type { FormattedApplication, IlluminancePlane, SearchResult } from '../types';

export const LIMIT_LEVEL_RE = /^\s*(lower|upper)\s+limit\b/i;
const LEVELS = ['sub1', 'sub2', 'sub3', 'sub4', 'sub5', 'sub6'] as const;
type Level = typeof LEVELS[number];

export interface LimitInfo {
  level: Level;
  which: 'lower' | 'upper';
}

export function limitInfo(app: FormattedApplication | null | undefined): LimitInfo | null {
  if (!app) return null;
  for (const level of LEVELS) {
    const m = LIMIT_LEVEL_RE.exec(String(app[level] ?? ''));
    if (m) return { level, which: m[1].toLowerCase() as 'lower' | 'upper' };
  }
  return null;
}

/** Identity of a lower/upper pair: everything but the limit level itself. */
export function limitPairKey(app: FormattedApplication | null | undefined): string | null {
  const info = limitInfo(app);
  if (!app || !info) return null;
  const levels = LEVELS.map(l => (l === info.level ? '*' : String(app[l] ?? '')));
  return [app.standard, app.tableRef, app.subCategory, app.category, ...levels]
    .map(v => String(v ?? '').trim().toLowerCase())
    .join('|');
}

export interface LimitPair {
  lower?: FormattedApplication;
  upper?: FormattedApplication;
}

/** Index rows (from the pool and from D1) by pair key. */
export function indexLimitPairs(apps: Iterable<FormattedApplication>, into: Map<string, LimitPair> = new Map()): Map<string, LimitPair> {
  for (const app of apps) {
    const key = limitPairKey(app);
    const info = limitInfo(app);
    if (!key || !info) continue;
    const pair = into.get(key) || {};
    if (!pair[info.which]) pair[info.which] = app;
    into.set(key, pair);
  }
  return into;
}

function mergePlane(lower: IlluminancePlane | null | undefined, upper: IlluminancePlane | null | undefined): IlluminancePlane | null {
  if (!lower && !upper) return null;
  if (!lower || !upper) return { ...(lower || upper)! };
  const out: IlluminancePlane = { ...lower };
  if (upper.lux != null && upper.lux !== lower.lux) out.luxMax = upper.lux;
  if (upper.fc != null && upper.fc !== lower.fc) out.fcMax = upper.fc;
  return out;
}

/** The pair as one application: lower values + upper maxima, limit level removed. */
export function mergeLimitPair(base: FormattedApplication, pair: LimitPair): FormattedApplication {
  const info = limitInfo(base)!;
  const lower = pair.lower!;
  const upper = pair.upper!;
  const merged: FormattedApplication = {
    ...base,
    horizontal: mergePlane(lower.horizontal, upper.horizontal),
    vertical: mergePlane(lower.vertical, upper.vertical),
    task: mergePlane(lower.task, upper.task),
  };
  // "(avg.)" travels with the range so the card can still say what the limits
  // are limits OF.
  const qualifier = /\(([^)]+)\)/.exec(String(base[info.level] ?? ''))?.[1] ?? null;
  merged[info.level] = null;
  merged.fullName = [merged.category, merged.sub1, merged.sub2, merged.sub3, merged.sub4, merged.sub5, merged.sub6]
    .filter(Boolean).join(' → ');
  merged.limitRange = { lowerCode: lower.code, upperCode: upper.code, qualifier };
  return merged;
}

/**
 * Collapse every complete lower/upper pair in `results` into one result, at the
 * position of whichever half ranked higher. `known` holds partner rows fetched
 * from outside the pool; pool rows are indexed here.
 */
export function mergeLimitPairs(results: SearchResult[], known: Map<string, LimitPair> = new Map()): SearchResult[] {
  const pairs = indexLimitPairs(
    results.filter(r => r.resultType === 'application').map(r => r.application),
    new Map([...known].map(([k, v]) => [k, { ...v }])),
  );
  const done = new Set<string>();
  const out: SearchResult[] = [];
  for (const r of results) {
    const key = r.resultType === 'application' ? limitPairKey(r.application) : null;
    const pair = key ? pairs.get(key) : undefined;
    if (!key || !pair?.lower || !pair?.upper) { out.push(r); continue; }
    if (done.has(key)) continue;   // the other half already took this slot
    done.add(key);
    out.push({ ...r, application: mergeLimitPair(r.application, pair) });
  }
  return out;
}
