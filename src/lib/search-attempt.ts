/**
 * "Was this search a retry?" — without a session id (Dan, Teams 11/19/26 #4).
 *
 *   "for search-log.csv, is there anything like a 'session ID' that does not
 *    cross-reference in search-usage (so it remains anonymous) but could help
 *    us distinguish popular topics/questions from a user who keeps re-trying a
 *    search with slightly different phrasing (a sign of frustration or not
 *    finding the 'right' answer)?"
 *
 * The honest answer to "a session id that cannot be cross-referenced" is that
 * there is none. Any identifier a reader's rows share lets those rows be
 * COUNTED, and search_usage_daily holds each account's count per day: a visit
 * of 25 searches points at the one account that searched 25 times that day.
 * The privacy of search_log rests on its rows not being linkable to each
 * other, so nothing that links them is added.
 *
 * What is recorded instead is a COUNTER on each row: `attempt` is 1 for a
 * fresh question, and 2, 3, … when the same reader rephrased their previous
 * question within ten minutes. It answers exactly what was asked — is this a
 * popular question, or one person trying five phrasings — and two rows with
 * attempt 2 are indistinguishable from each other.
 *
 * To compute it, the reader's LAST query is remembered for ten minutes in KV,
 * as one-way 32-bit hashes of its words (never the text), keyed by account.
 * That record is transient, is never written to D1, and expires on its own.
 *
 *   identical words        → the same attempt again (a re-run: filters, a
 *                            reload, the same demo twice — not a rephrase)
 *   overlapping words      → attempt + 1
 *   anything else, or > 10 min later → attempt 1 (a new question)
 *
 * Fail-open in every direction: no KV, an unreadable record or a query with no
 * content words all mean attempt 1 or null, and search never waits on the write.
 */

const WINDOW_SECONDS = 600;
/** KV refuses a TTL under 60 s; the window is well above it. */
const RECORD_TTL_SECONDS = WINDOW_SECONDS + 60;
const MAX_TOKENS = 40;
const MAX_ATTEMPT = 20;

const STOPWORDS = new Set((
  'a an the and or of to for in on at by with from is are was were be been do does did can could should would will '
  + 'how what where when why which who whom i we my our me you your it its this that these those there as if not no '
  + 'about into than then so such per vs versus please tell show give provide list find need want get have has '
  + 'ies ansi standard standards lighting light lights recommended recommendation recommendations requirements required'
).split(' '));

/** Plural first, then the verb ending — "ratings" and "rating" must meet. */
function stem(word: string): string {
  let w = word;
  if (w.length > 5 && w.endsWith('ies')) w = `${w.slice(0, -3)}y`;
  else if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
  if (w.length > 5 && w.endsWith('ing')) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith('ed')) return w.slice(0, -2);
  return w;
}

/** FNV-1a, 32 bits — enough to compare two short word sets, useless to read. */
function hash(word: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < word.length; i++) {
    h ^= word.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** A query as the sorted hashes of its content words. */
export function queryFingerprint(query: string): number[] {
  const words = String(query || '').toLowerCase().split(/[^a-z0-9.]+/)
    .map(w => w.replace(/^\.+|\.+$/g, ''))
    .filter(w => w.length > 1 && !STOPWORDS.has(w))
    .map(stem);
  return [...new Set(words.map(hash))].sort((a, b) => a - b).slice(0, MAX_TOKENS);
}

export type Relation = 'same' | 'rephrase' | 'new';

/**
 * How a query relates to the one before it. A rephrase shares at least half of
 * the smaller query's words with the other ("how to light a parking lot" →
 * "parking lot illuminance levels"); a single shared word is enough only when
 * one of the two IS a single word ("glare" → "glare rating").
 */
export function relate(previous: number[], current: number[]): Relation {
  if (previous.length === 0 || current.length === 0) return 'new';
  const prev = new Set(previous);
  const shared = current.filter(h => prev.has(h)).length;
  if (shared === previous.length && shared === current.length) return 'same';
  const smaller = Math.min(previous.length, current.length);
  if (shared === 0) return 'new';
  return shared / smaller >= 0.5 ? 'rephrase' : 'new';
}

interface AttemptRecord { h: number[]; n: number; at: number }

function parseRecord(raw: string | null): AttemptRecord | null {
  if (!raw) return null;
  try {
    const r = JSON.parse(raw) as AttemptRecord;
    if (!r || !Array.isArray(r.h) || !Number.isInteger(r.n) || !Number.isFinite(r.at)) return null;
    return { h: r.h.filter(Number.isInteger).slice(0, MAX_TOKENS), n: Math.min(Math.max(1, r.n), MAX_ATTEMPT), at: r.at };
  } catch {
    return null;
  }
}

/** The attempt number for a query, given the record of the one before it. */
export function decideAttempt(
  record: AttemptRecord | null, fingerprint: number[], nowSeconds: number,
): number {
  if (!record || nowSeconds - record.at > WINDOW_SECONDS || nowSeconds < record.at) return 1;
  const relation = relate(record.h, fingerprint);
  if (relation === 'same') return record.n;
  if (relation === 'rephrase') return Math.min(record.n + 1, MAX_ATTEMPT);
  return 1;
}

export function searchAttemptsEnabled(env: { LENSY_SEARCH_ATTEMPTS?: string }): boolean {
  return String(env?.LENSY_SEARCH_ATTEMPTS ?? '').trim().toLowerCase() !== 'off';
}

interface AttemptEnv { SESSIONS?: KVNamespace; LENSY_SEARCH_ATTEMPTS?: string }

/**
 * This search's attempt number, and the write that remembers it for the next
 * one. `write` is for ctx.waitUntil — the search never waits on it. Returns
 * `attempt: null` when the counter is off or KV is unavailable.
 */
export async function nextSearchAttempt(
  env: AttemptEnv, scope: string, sub: string, query: string, now: Date = new Date(),
): Promise<{ attempt: number | null; write: Promise<void> }> {
  const none = { attempt: null, write: Promise.resolve() };
  if (!searchAttemptsEnabled(env) || !env.SESSIONS || !sub) return none;
  const fingerprint = queryFingerprint(query);
  // A query with no content words ("the", "?") is nobody's retry.
  if (fingerprint.length === 0) return { attempt: 1, write: Promise.resolve() };

  const key = `search-attempt:${scope}:${sub}`;
  const nowSeconds = Math.floor(now.getTime() / 1000);
  try {
    const record = parseRecord(await env.SESSIONS.get(key));
    const attempt = decideAttempt(record, fingerprint, nowSeconds);
    const next: AttemptRecord = { h: fingerprint, n: attempt, at: nowSeconds };
    const write = env.SESSIONS.put(key, JSON.stringify(next), { expirationTtl: RECORD_TTL_SECONDS })
      .catch((err) => { console.error('search attempt write failed (non-fatal):', err instanceof Error ? err.message : String(err)); });
    return { attempt, write };
  } catch (err) {
    console.error('search attempt read failed (non-fatal):', err instanceof Error ? err.message : String(err));
    return none;
  }
}
