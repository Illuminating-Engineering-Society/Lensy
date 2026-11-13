/**
 * One person's Lighting Library comps, for the staff tools (Dan, 2026-11):
 *
 *   "let's see if we can pull Lighting Library comps and display them in
 *    Wicket and/or Lightroom - so all staff can see at a glance every product
 *    a user should have access to.
 *      - COMP: each specific document — Start date, end date · Bonus: Note
 *      - COMP: Subscription          — Start date, end date · Bonus: Note"
 *
 * Server-to-server only:
 *
 *   GET /api/staff/comps?email=<address>[&email=<address>…][&history=1]
 *   Authorization: Bearer STAFF_COMPS_API_SECRET
 *
 * Lens is where a comp is cut (/admin → Comp access, comp_access_grants), so
 * the staff tool READS it here; nothing is copied into Wicket (AuthIES's
 * Wicket client is read-only by policy, and a second copy of a grant is a
 * second thing to keep true). The caller is Light Room, or any staff tool that
 * shows a person: it passes the person's address — every address Wicket holds
 * for them, since a comp is matched by email — and prints what comes back.
 *
 * How this differs from GET /api/entitlements (the member's own "My Standards"
 * on ies.org): that one answers "what can I open today" — documents only,
 * purchases included, only what reached the Library. This one answers "what
 * was this person given" — comps only, the subscription comp included, with
 * the staff note, who granted it, and a row that has NOT reached the Library
 * shown as such (`applied: false`) instead of hidden: that is the row staff
 * most need to see.
 *
 * READ-ONLY and its own secret: it discloses staff notes and who was granted
 * what, which the member-facing bearer must not open, and it must not be the
 * key that can create or revoke grants. Unset secret → 404.
 */

import { bearerMatches } from '../lib/auth';
import { normalizeEmail } from '../lib/invites';

/** A person has a handful of addresses, not a list. */
const MAX_EMAILS = 10;
/** A view of one person, not an export (that is /api/admin/comp-access.csv). */
const MAX_GRANTS = 500;
/** D1 binds at most 100 parameters per statement. */
const CATALOG_CHUNK = 90;

export type StaffCompState = 'active' | 'scheduled' | 'expired' | 'revoked';

export interface StaffComp {
  /** comp_access_grants.id — one grant of several documents repeats it. */
  grantId: number;
  kind: 'document' | 'subscription';
  /** Ready to print: "COMP: ANSI/IES RP-8-25+E2 Recommended Practice: …" / "COMP: Subscription". */
  label: string;
  email: string;
  name: string | null;
  /** Document comps only. */
  standardId: string | null;
  designation: string | null;
  title: string | null;
  /** Inclusive dates, 'YYYY-MM-DD'. */
  startsAt: string;
  expiresAt: string;
  state: StaffCompState;
  /** Whether the grant reached the Library (AuthIES → Vitrium). False = recorded, opens nothing yet. */
  applied: boolean;
  note: string | null;
  grantedBy: string | null;
  createdAt: string;
}

interface GrantRow {
  id: number;
  created_at: string;
  email: string;
  name: string | null;
  standard_ids: string;
  start_date: string;
  end_date: string;
  created_by: string | null;
  notes: string | null;
  status: string;
  vitrium_applied_at: string | null;
  scope: string | null;
}

export async function handleStaffComps(request: Request, env: Env, url: URL): Promise<Response> {
  if (!String(env.STAFF_COMPS_API_SECRET || '').trim()) return json({ error: 'Not found' }, 404);
  if (!(await bearerMatches(request, env.STAFF_COMPS_API_SECRET))) return json({ error: 'Unauthorized' }, 401);

  const raw = url.searchParams.getAll('email').flatMap(v => v.split(',')).map(v => v.trim()).filter(Boolean);
  if (raw.length === 0) return json({ error: 'invalid_email' }, 400);
  if (raw.length > MAX_EMAILS) return json({ error: 'too_many_emails', max: MAX_EMAILS }, 400);
  const emails: string[] = [];
  for (const value of raw) {
    const email = normalizeEmail(value);
    if (!email) return json({ error: 'invalid_email' }, 400);
    if (!emails.includes(email)) emails.push(email);
  }

  const history = /^(1|true|yes)$/i.test(url.searchParams.get('history') || '');
  try {
    const comps = await compsForEmails(env.DB, emails, { history });
    return json({ emails, history, comps }, 200);
  } catch (err) {
    return json({ error: `comps unavailable: ${err instanceof Error ? err.message : String(err)}` }, 500);
  }
}

/**
 * The comps of these addresses, current first.
 *
 * Without `history`: what the person holds or is about to hold — active and
 * scheduled grants. With it: expired and revoked ones too.
 *
 * @param opts.today 'YYYY-MM-DD' (UTC), for tests; the dates are inclusive and
 *   compared as strings, the way the session gate and /api/entitlements do.
 */
export async function compsForEmails(
  db: D1Database,
  emails: string[],
  opts: { history?: boolean; today?: string } = {},
): Promise<StaffComp[]> {
  if (emails.length === 0) return [];
  const today = opts.today || new Date().toISOString().slice(0, 10);

  const grants = await db.prepare(`
    SELECT id, created_at, email, name, standard_ids, start_date, end_date,
           created_by, notes, status, vitrium_applied_at, scope
    FROM comp_access_grants
    WHERE email IN (${emails.map(() => '?').join(', ')})
    ORDER BY start_date DESC, id DESC
    LIMIT ${MAX_GRANTS}
  `).bind(...emails).all<GrantRow>();

  const kept: Array<{ row: GrantRow; state: StaffCompState }> = [];
  for (const row of grants.results || []) {
    const state = stateOf(row, today);
    if (!opts.history && (state === 'expired' || state === 'revoked')) continue;
    kept.push({ row, state });
  }
  if (kept.length === 0) return [];

  const ids = new Set<string>();
  for (const { row } of kept) {
    if (scopeOf(row) === 'documents') for (const id of parseIds(row.standard_ids)) ids.add(id);
  }
  const catalog = await catalogFor(db, [...ids]);

  const out: StaffComp[] = [];
  for (const { row, state } of kept) {
    const base = {
      grantId: row.id,
      email: row.email,
      name: clean(row.name),
      startsAt: row.start_date,
      expiresAt: row.end_date,
      state,
      applied: !!row.vitrium_applied_at,
      note: clean(row.notes),
      grantedBy: clean(row.created_by),
      createdAt: row.created_at,
    };
    if (scopeOf(row) === 'lens') {
      out.push({
        ...base, kind: 'subscription', label: 'COMP: Subscription',
        standardId: null, designation: null, title: null,
      });
      continue;
    }
    for (const id of parseIds(row.standard_ids)) {
      const entry = catalog.get(id.toLowerCase());
      const standardId = entry ? entry.id : id;
      // An id the catalogue no longer holds is still printed: staff granted it.
      const designation = entry?.designation || standardId;
      const title = entry?.title || null;
      out.push({
        ...base, kind: 'document',
        label: `COMP: ${title ? `${designation} ${title}` : designation}`,
        standardId, designation, title,
      });
    }
  }

  const stateRank: Record<StaffCompState, number> = { active: 0, scheduled: 1, expired: 2, revoked: 3 };
  out.sort((a, b) =>
    (stateRank[a.state] - stateRank[b.state])
    // The subscription comp opens everything, so it leads its group.
    || (a.kind === b.kind ? 0 : a.kind === 'subscription' ? -1 : 1)
    || (a.designation || '').localeCompare(b.designation || '', undefined, { numeric: true })
    || b.expiresAt.localeCompare(a.expiresAt)
    || (b.grantId - a.grantId));
  return out;
}

/**
 * 'expired' is derived from the window, as everywhere else a comp is read —
 * the stored status only ever holds 'active' or 'revoked' (migration 0020).
 */
function stateOf(row: GrantRow, today: string): StaffCompState {
  if (String(row.status || '').toLowerCase() === 'revoked') return 'revoked';
  if (row.end_date < today) return 'expired';
  if (row.start_date > today) return 'scheduled';
  return 'active';
}

/** Rows written before migration 0023 carry no scope and are document grants. */
function scopeOf(row: GrantRow): 'documents' | 'lens' {
  return row.scope === 'lens' ? 'lens' : 'documents';
}

async function catalogFor(
  db: D1Database, ids: string[],
): Promise<Map<string, { id: string; designation: string | null; title: string | null }>> {
  const byId = new Map<string, { id: string; designation: string | null; title: string | null }>();
  for (let i = 0; i < ids.length; i += CATALOG_CHUNK) {
    const chunk = ids.slice(i, i + CATALOG_CHUNK);
    const rows = await db.prepare(`
      SELECT id, full_designation, title FROM standards
      WHERE id COLLATE NOCASE IN (${chunk.map(() => '?').join(', ')})
    `).bind(...chunk).all<{ id: string; full_designation: string | null; title: string | null }>();
    for (const row of rows.results || []) {
      const id = String(row.id);
      const title = clean(row.title);
      byId.set(id.toLowerCase(), {
        id,
        designation: clean(row.full_designation),
        // A row the cover reader could not title holds its own id there.
        title: title && title !== id ? title : null,
      });
    }
  }
  return byId;
}

function parseIds(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((v): v is string => typeof v === 'string' && v.trim() !== '').map(v => v.trim())
      : [];
  } catch {
    return [];
  }
}

function clean(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const s = value.trim();
  return s ? s : null;
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
