/**
 * Application names for the search box's auto-suggest (Dan, Teams 11/11/26:
 * "adding 'application' names (from illuminance tables) into the auto-filter
 * for searches … under a new 'Illuminance Recommendations' header").
 *
 * Two halves, one per end of the feature:
 *
 *   • `buildApplicationNames` — the compact payload GET /api/applications/names
 *     serves: every Active row's hierarchy and table banner, by standard.
 *     NAMES ONLY. No lux, no
 *     page, no note — a row's values are what the Illuminance Table card is for,
 *     and that card is where the subscription is enforced.
 *
 *   • `pinnedApplicationCodes` — a clicked suggestion sends the codes of the
 *     rows under it as `filters.application_codes`; the search then leads with
 *     exactly those rows instead of trusting the embedding to rank them first.
 *     The reader picked an application by name, so a near miss is a wrong answer.
 *
 * The matching itself runs in the browser (src/frontend/utils/application-suggest.js).
 */

/** The hierarchy columns that make up a row's displayed path, top level first. */
export const APPLICATION_PATH_COLUMNS = ['App', 'App_s1', 'App_s2', 'App_s3', 'App_s4', 'App_s5', 'App_s6'] as const;

/** How many rows one suggestion may pin. Mirrored by MAX_PINNED_CODES in the page's util. */
export const MAX_PINNED_APPLICATIONS = 12;

/** The score a pinned row carries: the reader named it, which is a match by definition. */
export const PINNED_APPLICATION_SCORE = 1;

// Row codes are "<standard without punctuation>_<row>" (RP923_0094), older ones
// "<standard>_<n>" (RP-9-20_1). Anything else is not a code and is dropped.
const APPLICATION_CODE_RE = /^[A-Za-z0-9][A-Za-z0-9+._-]{2,48}$/;

export interface ApplicationNameRow {
  code: string;
  Standard: string | null;
  /** The table banner the row sits under ("INTERIOR - HOSPITALITY"). */
  Sub_Category?: string | null;
  App?: string | null; App_s1?: string | null; App_s2?: string | null; App_s3?: string | null;
  App_s4?: string | null; App_s5?: string | null; App_s6?: string | null;
}

export interface ApplicationNamesPayload {
  /** Standard ids; `applications[n].s` indexes this list. */
  standards: string[];
  /**
   * Table banners — the top level of the hierarchy (client 11/12/26 #4);
   * `applications[n].g` indexes this list.
   */
  groups: string[];
  /**
   * c = row code, s = index into `standards`, p = the hierarchy path,
   * g = index into `groups` (absent when the row has no banner).
   */
  applications: Array<{ c: string; s: number; p: string[]; g?: number }>;
}

/** One hierarchy label as printed: whitespace collapsed, empty → dropped by the caller. */
function cleanLabel(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

/**
 * @param opts.withCodes false for a reader below `full` (Dan, Teams 11/14/26
 *   #4: Non-Subscribers see the names padlocked). Every `c` is then '' — the
 *   names, and no handle on the rows behind them.
 */
export function buildApplicationNames(
  rows: ApplicationNameRow[],
  opts: { withCodes?: boolean } = {},
): ApplicationNamesPayload {
  const withCodes = opts.withCodes !== false;
  const standards: string[] = [];
  const standardIndex = new Map<string, number>();
  const groups: string[] = [];
  const groupIndex = new Map<string, number>();
  const applications: ApplicationNamesPayload['applications'] = [];

  for (const row of rows || []) {
    const code = cleanLabel(row?.code);
    const standard = cleanLabel(row?.Standard);
    if (!code || !standard) continue;
    const path = APPLICATION_PATH_COLUMNS.map(col => cleanLabel(row[col])).filter(Boolean);
    if (path.length === 0) continue;

    let s = standardIndex.get(standard);
    if (s === undefined) {
      s = standards.length;
      standards.push(standard);
      standardIndex.set(standard, s);
    }
    const entry: ApplicationNamesPayload['applications'][number] = { c: withCodes ? code : '', s, p: path };
    const group = cleanLabel(row.Sub_Category);
    if (group) {
      let g = groupIndex.get(group);
      if (g === undefined) {
        g = groups.length;
        groups.push(group);
        groupIndex.set(group, g);
      }
      entry.g = g;
    }
    applications.push(entry);
  }
  return { standards, groups, applications };
}

/**
 * `filters.application_codes` as sent by the page → the codes to pin: strings
 * shaped like a row code, de-duplicated, capped. Anything else yields [] —
 * the search then runs exactly as it would have without the field.
 */
export function pinnedApplicationCodes(filters: unknown): string[] {
  const raw = (filters as { application_codes?: unknown } | null | undefined)?.application_codes;
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const value of raw) {
    if (typeof value !== 'string') continue;
    const code = value.trim();
    if (!APPLICATION_CODE_RE.test(code) || out.includes(code)) continue;
    out.push(code);
    if (out.length >= MAX_PINNED_APPLICATIONS) break;
  }
  return out;
}

/**
 * Move the pinned rows to the front, keeping their relative order and
 * everything else's. A limit-range card (RP-43's lower/upper pair merged into
 * one row) answers to either of its two codes.
 */
export function pinApplicationsFirst<T extends {
  resultType?: string;
  application?: { code?: string; limitRange?: { lowerCode: string; upperCode: string } } | null;
}>(results: T[], codes: string[]): T[] {
  if (!Array.isArray(results) || results.length === 0 || !codes || codes.length === 0) return results;
  const wanted = new Set(codes);
  const isPinned = (r: T): boolean => {
    if ((r.resultType || 'application') !== 'application') return false;
    const app = r.application;
    if (!app) return false;
    if (app.code && wanted.has(app.code)) return true;
    const range = app.limitRange;
    return !!range && (wanted.has(range.lowerCode) || wanted.has(range.upperCode));
  };
  const pinned = results.filter(isPinned);
  if (pinned.length === 0) return results;
  return [...pinned, ...results.filter(r => !isPinned(r))];
}
