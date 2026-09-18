/**
 * Complimentary document access (client DO110).
 *
 * "Establish a simple method for IES staff to assign 90-day complimentary
 *  access to any single document, for a single user OR an uploaded csv of
 *  users … to assign an entire classroom or committee (or single volunteer)
 *  complimentary 90-day access to one or more documents without providing
 *  access to the 'full' Lensy toolset."
 *
 * ── WHAT THIS DOES NOT DO ────────────────────────────────────────────────────
 * It does not grant anything. The permission is applied by hand, today in the
 * Vitrium admin app, and a row here records that it should be. Two separate
 * reasons it cannot be automated from Lensy yet, and they need different
 * people to resolve:
 *
 *   1. Vitrium's API refuses us. support@ies.org authenticates but every
 *      controller answers 403 "insufficient privileges" — a programmatic
 *      session grant pending with Vitrium's rep (see the AuthIES repo, which
 *      owns the Vitrium relationship). Code that called it today would fail on
 *      every grant.
 *   2. The client's proposed mechanism — a Vitrium group called "90-day
 *      document comp" — does not exist in the mode IES runs. Under Vitrium
 *      External Services "there is no concept of a Group … access is decided
 *      per document by our authorization response" (AuthIES CLAUDE.md), and
 *      that response is AuthIES's `authenticate` webhook, not Lensy's. So the
 *      eventual automation is most likely a per-person, per-document,
 *      date-bounded entitlement AuthIES reads — not a Vitrium API call at all.
 *      Flagged to the client rather than guessed at here.
 *
 * Until one of those lands this follows the shape the device-limit reset queue
 * already uses for exactly this situation (workers/library-support.ts + the
 * Vitrium "Clear Use" click): Lensy RECORDS the grant, tells the recipient, and
 * tracks whether a human has done the Vitrium half yet.
 *
 * What Lensy owns end to end: validating the documents against the indexed
 * corpus (current OR deprecated — the client asked for both), computing the
 * window, emailing each recipient the full designations, titles and branded
 * Library links, and keeping the queue of what still needs applying.
 *
 * Auth: requireAdminAccess — an SSO admin session, or the staff bearer for
 * scripts (workers/session.ts), the same gate as every /api/admin/* route.
 *
 * Endpoints:
 *   POST  /api/admin/comp-access       Create grants (one recipient or a list;
 *                                      the CSV upload is parsed in the browser)
 *   GET   /api/admin/comp-access       The queue + per-status counts
 *   PATCH /api/admin/comp-access/:id   Revoke / reinstate, mark applied in
 *                                      Vitrium, or re-send the email
 *   GET   /api/admin/comp-access.csv   Export
 */

import { requireAdminAccess } from './session';
import { getSsoState } from '../lib/sso';
import { normalizeEmail } from '../lib/invites';
import { sendCompAccessEmail, type CompAccessDocument, type SendOutcome } from '../lib/email';
import { toLibraryUrlOrNull } from '../lib/library-url.js';
import { csvCell } from '../lib/collections.js';

/** The client's number. Overridable per grant, not per deployment. */
const DEFAULT_DAYS = 90;

/** A comp window measured in years is a subscription; refuse it as a typo. */
const MAX_DAYS = 730;

/** A grant is "one or more documents", not the whole library. */
const MAX_DOCUMENTS = 50;

/**
 * Recipients per request, matching the invite endpoint's cap: each one costs a
 * mail subrequest, and a classroom or committee roster fits comfortably inside
 * it. A larger CSV is split by the uploader.
 */
const MAX_RECIPIENTS = 200;

/** Same reason as users.ts: 200 serial sends would risk the wall-clock limit. */
const EMAIL_CONCURRENCY = 8;

/** A queue view, not an export — the CSV endpoint is the way to pull history. */
const LIST_LIMIT_DEFAULT = 500;
const LIST_LIMIT_MAX = 2000;

interface CompGrantRow {
  id: number;
  created_at: string;
  email: string;
  name: string | null;
  standard_ids: string;
  start_date: string;
  end_date: string;
  days: number;
  created_by: string | null;
  notes: string | null;
  status: string;
  notify_sent: number;
  notify_sent_at: string | null;
  notify_error: string | null;
  vitrium_applied_at: string | null;
  vitrium_applied_by: string | null;
  revoked_at: string | null;
  revoked_by: string | null;
}

/** One standards row, as everything here needs it. */
interface CatalogEntry {
  id: string;
  designation: string;
  title: string | null;
  status: string;
  libraryUrl: string | null;
}

const GRANT_COLUMNS =
  `id, created_at, email, name, standard_ids, start_date, end_date, days,
   created_by, notes, status, notify_sent, notify_sent_at, notify_error,
   vitrium_applied_at, vitrium_applied_by, revoked_at, revoked_by`;

// ─── Router ───────────────────────────────────────────────────────────────────

export async function handleAdminCompAccess(request: Request, env: Env, url: URL): Promise<Response> {
  const denied = await requireAdminAccess(request, env);
  if (denied) return denied;

  const parts = url.pathname.split('/').filter(Boolean); // ['api','admin','comp-access',':id']
  const id = parts[3];

  switch (request.method) {
    case 'GET':
      if (id) return json({ error: 'Not found' }, 404);
      return listGrants(env, url);
    case 'POST':
      if (id) return json({ error: 'POST takes no id' }, 400);
      return createGrants(request, env);
    case 'PATCH':
      if (!id) return json({ error: 'Grant id required' }, 400);
      return updateGrant(request, env, id);
    default:
      return json({ error: 'Method not allowed' }, 405);
  }
}

// ─── Create ───────────────────────────────────────────────────────────────────

/**
 * POST /api/admin/comp-access
 *
 * Body: { recipients, standard_ids[], start_date?, days?, end_date?, notes?,
 *         notify? }
 *
 * `recipients` accepts every shape the two entry paths produce: the single-user
 * form sends one object, and the CSV picker (parsed in the browser) sends a
 * list of addresses or of {email, name} pairs.
 *
 * Documents are validated as a SET before anything is written: a grant naming a
 * standard that is not in the corpus is a typo, and half-applying it would mail
 * some of a classroom a link to a document IES never enabled.
 */
async function createGrants(request: Request, env: Env): Promise<Response> {
  const body = await safeJson(request);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return json({ error: 'Invalid JSON body' }, 400);
  }
  const input = body as Record<string, unknown>;

  // ── Documents ───────────────────────────────────────────────────────────────
  const requestedIds = uniqueStrings(input.standard_ids);
  if (requestedIds.length === 0) {
    return json({ error: 'At least one standard id is required.' }, 400);
  }
  if (requestedIds.length > MAX_DOCUMENTS) {
    return json({ error: `At most ${MAX_DOCUMENTS} documents per grant.` }, 400);
  }

  let catalog: Map<string, CatalogEntry>;
  try {
    catalog = await loadStandardCatalog(env.DB);
  } catch (err) {
    return json({ error: `Could not read the standards catalog: ${errMsg(err)}` }, 500);
  }
  // Case-insensitively, because staff type designations by hand; the CANONICAL
  // id from the catalog is what gets stored, so the row always joins later.
  const resolved: CatalogEntry[] = [];
  const unknown: string[] = [];
  for (const raw of requestedIds) {
    const hit = catalog.get(raw.toLowerCase());
    if (hit) resolved.push(hit); else unknown.push(raw);
  }
  if (unknown.length > 0) {
    return json({
      error: `Not in the IES Lens corpus: ${unknown.join(', ')}`,
      unknownStandardIds: unknown,
    }, 400);
  }

  // ── Window ──────────────────────────────────────────────────────────────────
  const window = resolveWindow(input);
  if ('error' in window) return json({ error: window.error }, 400);

  // ── Recipients ──────────────────────────────────────────────────────────────
  const parsedRecipients = parseRecipients(input);
  if (parsedRecipients.length === 0) {
    return json({ error: 'At least one recipient is required.' }, 400);
  }
  if (parsedRecipients.length > MAX_RECIPIENTS) {
    return json({ error: `At most ${MAX_RECIPIENTS} recipients per request.` }, 400);
  }

  const notes = cleanText(input.notes, 1000);
  const createdBy = await staffIdentity(request, env);
  const idsJson = JSON.stringify(resolved.map(d => d.id));

  const created: Array<{ id: number; email: string; name: string | null }> = [];
  const rejected: Array<{ email: string | null; reason: string }> = [];
  const seen = new Set<string>();

  for (const item of parsedRecipients) {
    const email = normalizeEmail(item.email);
    if (!email) {
      rejected.push({ email: typeof item.email === 'string' ? item.email : null, reason: 'Invalid or missing email' });
      continue;
    }
    // Only within THIS request: a second grant to someone who already has one
    // is legitimate (a different document set, or an extension), so an existing
    // row is never a reason to refuse.
    if (seen.has(email)) {
      rejected.push({ email, reason: 'Duplicate in this request' });
      continue;
    }
    seen.add(email);

    try {
      const res = await env.DB.prepare(`
        INSERT INTO comp_access_grants
          (email, name, standard_ids, start_date, end_date, days, created_by, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        email, item.name, idsJson, window.startDate, window.endDate, window.days,
        createdBy, notes,
      ).run();
      created.push({ id: res.meta.last_row_id as number, email, name: item.name });
    } catch (err) {
      // Unlike the mail, the ROW is the product — if it could not be written,
      // say so per recipient rather than reporting a grant that does not exist.
      rejected.push({ email, reason: `Could not record the grant: ${errMsg(err)}` });
    }
  }

  const notify = input.notify !== false;
  const emailed = notify
    ? await mailGrants(env, created, resolved, window, createdBy)
    : { sent: 0, failed: [] as EmailFailure[], skipped: true };

  return json({
    created,
    rejected,
    emailed,
    documents: resolved.map(d => ({ id: d.id, designation: d.designation, title: d.title, status: d.status })),
    window,
    // Repeated in the response because the dashboard prints it after every
    // create: the grant does not exist for the reader until this is done.
    vitriumStep: 'Add each recipient to the Vitrium "90-day document comp" group and scope it to these documents in the Vitrium admin app, then mark the row applied here.',
  }, created.length > 0 ? 201 : 200);
}

// ─── The Vitrium half (not yet automatable) ───────────────────────────────────

/**
 * SEAM — where the automated grant will go, once there is one to call.
 *
 * Whatever mechanism wins (a privileged Vitrium session, or more likely a
 * date-bounded per-document entitlement AuthIES's `authenticate` webhook
 * reads — see the header), the contract from this file's side is fixed: after
 * the grant is applied, stamp `vitrium_applied_at = datetime('now')` and
 * `vitrium_applied_by` with the mechanism's name instead of a staff email, and
 * the dashboard's "awaiting Vitrium" count empties itself.
 *
 * Named here rather than left as a TODO so the stamp a future implementation
 * must write is unambiguous. The endpoints above deliberately do not pretend:
 * PATCH {vitrium_applied:true} is a human saying they did it by hand.
 */
export const VITRIUM_COMP_GROUP = '90-day document comp';

// ─── Recipient mail ───────────────────────────────────────────────────────────

interface EmailFailure { email: string; error: string }

interface EmailReport {
  sent: number;
  failed: EmailFailure[];
  /** True when sending was deliberately bypassed (notify:false). */
  skipped?: boolean;
}

/**
 * Email every freshly-created grant in small concurrent groups and record the
 * outcome on its row. Never throws and never unwinds a grant: a grant that
 * could not be emailed is still valid and re-sendable, the same trade the
 * invitation mail makes.
 */
async function mailGrants(
  env: Env,
  rows: Array<{ id: number; email: string; name: string | null }>,
  documents: CatalogEntry[],
  window: GrantWindow,
  grantedBy: string | null,
): Promise<EmailReport> {
  const report: EmailReport = { sent: 0, failed: [] };
  for (let i = 0; i < rows.length; i += EMAIL_CONCURRENCY) {
    const group = rows.slice(i, i + EMAIL_CONCURRENCY);
    const outcomes = await Promise.all(
      group.map(row => deliverGrant(env, row, documents, window, grantedBy)),
    );
    for (let j = 0; j < group.length; j++) {
      const outcome = outcomes[j];
      if (outcome.sent) report.sent++;
      else report.failed.push({ email: group[j].email, error: outcome.error });
    }
  }
  return report;
}

async function deliverGrant(
  env: Env,
  row: { id: number; email: string; name: string | null },
  documents: CatalogEntry[],
  window: GrantWindow,
  grantedBy: string | null,
): Promise<SendOutcome> {
  const outcome = await sendCompAccessEmail(env, {
    to: row.email,
    name: row.name,
    documents: documents.map(toEmailDocument),
    days: window.days,
    startDate: window.startDate,
    endDate: window.endDate,
    grantedBy,
  });

  // The send already happened either way, so a D1 problem here must not become
  // a 500 on the create — same swallow as deliverInvite.
  try {
    if (outcome.sent) {
      await env.DB.prepare(`
        UPDATE comp_access_grants
        SET notify_sent = 1, notify_sent_at = datetime('now'), notify_error = NULL
        WHERE id = ?
      `).bind(row.id).run();
    } else {
      await env.DB.prepare(
        'UPDATE comp_access_grants SET notify_sent = 0, notify_error = ? WHERE id = ?'
      ).bind(outcome.error, row.id).run();
    }
  } catch (err) {
    console.error('comp_access_email_status_write_failed', { id: row.id, detail: errMsg(err) });
  }

  return outcome;
}

function toEmailDocument(entry: CatalogEntry): CompAccessDocument {
  return {
    id: entry.id,
    designation: entry.designation,
    title: entry.title,
    libraryUrl: entry.libraryUrl,
  };
}

// ─── List ─────────────────────────────────────────────────────────────────────

/**
 * GET /api/admin/comp-access?status=&pending=1&q=&limit=
 *
 * Fails soft when migration 0020 has not been applied — an empty queue plus a
 * note, never a 500, matching handleAdminDeviceResetsList.
 */
async function listGrants(env: Env, url: URL): Promise<Response> {
  const statusFilter = (url.searchParams.get('status') || '').trim().toLowerCase();
  const pendingOnly = url.searchParams.get('pending') === '1';
  const q = (url.searchParams.get('q') || '').trim().toLowerCase();
  const limit = Math.min(LIST_LIMIT_MAX, Math.max(1, parseInt(url.searchParams.get('limit') || '', 10) || LIST_LIMIT_DEFAULT));

  let rows: CompGrantRow[] = [];
  let catalog = new Map<string, CatalogEntry>();
  let note: string | undefined;
  try {
    const [grantsRes, cat] = await Promise.all([
      env.DB.prepare(
        `SELECT ${GRANT_COLUMNS} FROM comp_access_grants ORDER BY created_at DESC, id DESC LIMIT ?`
      ).bind(limit).all<CompGrantRow>(),
      loadStandardCatalog(env.DB),
    ]);
    rows = grantsRes.results || [];
    catalog = cat;
  } catch (err) {
    note = `comp_access_grants unavailable (migration 0020 applied?): ${errMsg(err)}`;
  }

  const today = todayUtc();
  const grants = rows.map(row => shapeGrant(row, catalog, today));

  // Counted over everything loaded, not over the filtered view, so the chips
  // keep saying how big each bucket is while one of them is selected.
  const counts = { all: grants.length, active: 0, revoked: 0, expired: 0, pendingVitrium: 0 };
  for (const g of grants) {
    if (g.effective_status in counts) counts[g.effective_status as 'active' | 'revoked' | 'expired']++;
    if (g.effective_status === 'active' && !g.vitrium_applied_at) counts.pendingVitrium++;
  }

  let visible = grants;
  if (statusFilter && statusFilter !== 'all') {
    visible = visible.filter(g => g.effective_status === statusFilter);
  }
  if (pendingOnly) {
    visible = visible.filter(g => !g.vitrium_applied_at && g.effective_status === 'active');
  }
  if (q) {
    visible = visible.filter(g =>
      [g.email, g.name, g.created_by, g.notes, ...g.documents.map(d => d.designation)]
        .some(f => f && String(f).toLowerCase().includes(q))
    );
  }

  return json(note ? { grants: visible, counts, note } : { grants: visible, counts });
}

/** A row as the dashboard and the CSV read it: ids resolved, status derived. */
function shapeGrant(row: CompGrantRow, catalog: Map<string, CatalogEntry>, today: string) {
  const ids = parseIdList(row.standard_ids);
  const documents = ids.map(id => {
    const hit = catalog.get(id.toLowerCase());
    // A document deleted from the corpus after the grant was cut still has to
    // print — the reader was told about it, so the row must not lose it.
    return hit
      ? { id: hit.id, designation: hit.designation, title: hit.title, status: hit.status, libraryUrl: hit.libraryUrl }
      : { id, designation: id, title: null, status: 'unknown', libraryUrl: null };
  });
  return { ...row, documents, effective_status: effectiveGrantStatus(row, today) };
}

/**
 * 'revoked' always wins; otherwise a window whose end_date has passed reads as
 * expired. Derived rather than stored, so a lapsed grant needs no cron to close
 * it — the same rule invited_users uses (lib/invites.ts effectiveStatus).
 */
export function effectiveGrantStatus(
  row: { status: string; end_date: string },
  today: string,
): 'active' | 'revoked' | 'expired' {
  if (row.status === 'revoked') return 'revoked';
  return row.end_date && row.end_date < today ? 'expired' : 'active';
}

// ─── Update ───────────────────────────────────────────────────────────────────

/**
 * PATCH /api/admin/comp-access/:id
 *
 * Body (any combination):
 *   { status: 'revoked' | 'active', by? }   revoke, or undo a mis-click
 *   { vitrium_applied: true | false, by? }  the manual Vitrium step happened
 *   { resend: true }                        email the recipient again
 *
 * Marking applied is bookkeeping, exactly like the device-reset queue's "Mark
 * done": the permission is added in the Vitrium admin app, and this records
 * that a human did it.
 */
async function updateGrant(request: Request, env: Env, rawId: string): Promise<Response> {
  const id = Number(rawId);
  if (!Number.isInteger(id) || id < 1) return json({ error: 'Invalid grant id' }, 400);

  const body = await safeJson(request);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return json({ error: 'Invalid JSON body' }, 400);
  }
  const patch = body as Record<string, unknown>;

  let row: CompGrantRow | null = null;
  try {
    row = await env.DB.prepare(
      `SELECT ${GRANT_COLUMNS} FROM comp_access_grants WHERE id = ?`
    ).bind(id).first<CompGrantRow>();
  } catch (err) {
    return json({ error: `Could not read the grant: ${errMsg(err)}` }, 500);
  }
  if (!row) return json({ error: 'Grant not found' }, 404);

  const by = cleanText(patch.by, 200) ?? await staffIdentity(request, env);

  const fields: string[] = [];
  const values: (string | number | null)[] = [];

  if ('status' in patch) {
    const status = typeof patch.status === 'string' ? patch.status.trim().toLowerCase() : '';
    // 'expired' is derived from end_date and cannot be set: storing it would
    // freeze a grant that an extended end_date should have reopened.
    if (status !== 'active' && status !== 'revoked') {
      return json({ error: "status must be 'active' or 'revoked'" }, 400);
    }
    fields.push('status = ?', 'revoked_at = ?', 'revoked_by = ?');
    values.push(status, status === 'revoked' ? nowUtc() : null, status === 'revoked' ? by : null);
  }

  if ('vitrium_applied' in patch) {
    const applied = patch.vitrium_applied === true;
    fields.push('vitrium_applied_at = ?', 'vitrium_applied_by = ?');
    values.push(applied ? nowUtc() : null, applied ? by : null);
  }

  const wantsResend = patch.resend === true;
  if (fields.length === 0 && !wantsResend) {
    return json({ error: 'Nothing to update (send status, vitrium_applied or resend)' }, 400);
  }

  if (fields.length > 0) {
    const res = await env.DB.prepare(
      `UPDATE comp_access_grants SET ${fields.join(', ')} WHERE id = ?`
    ).bind(...values, id).run();
    if (res.meta.changes === 0) return json({ error: 'Grant not found' }, 404);
  }

  // Loaded at most once per request, whether the resend path or the response
  // shaping asks for it.
  let catalogPromise: Promise<Map<string, CatalogEntry>> | null = null;
  const catalog = () => (catalogPromise ??= loadStandardCatalog(env.DB).catch(() => new Map<string, CatalogEntry>()));

  let resend: SendOutcome | undefined;
  if (wantsResend) {
    const today = todayUtc();
    // A revoked grant must never be re-announced: "your access is ready" to
    // someone whose access was deliberately taken away is worse than silence.
    // The same refusal, for the same reason, as resendInvite.
    const statusNow = effectiveGrantStatus(
      { status: (('status' in patch) ? String(patch.status) : row.status), end_date: row.end_date },
      today,
    );
    if (statusNow === 'revoked') return json({ error: 'Cannot email a revoked grant. Reinstate it first.' }, 409);
    if (statusNow === 'expired') return json({ error: 'Cannot email an expired grant. Extend the end date first.' }, 409);

    const known = await catalog();
    const documents = parseIdList(row.standard_ids)
      .map(sid => known.get(sid.toLowerCase()))
      .filter((d): d is CatalogEntry => Boolean(d));
    if (documents.length === 0) {
      return json({ error: 'None of this grant\'s documents are in the corpus any more.' }, 409);
    }
    resend = await deliverGrant(env, { id, email: row.email, name: row.name }, documents, {
      startDate: row.start_date, endDate: row.end_date, days: row.days,
    }, row.created_by);
    if (!resend.sent) return json({ error: resend.error }, 502);
  }

  const updated = await env.DB.prepare(
    `SELECT ${GRANT_COLUMNS} FROM comp_access_grants WHERE id = ?`
  ).bind(id).first<CompGrantRow>();
  return json({
    updated: true,
    resent: resend?.sent === true,
    grant: updated ? shapeGrant(updated, await catalog(), todayUtc()) : null,
  });
}

// ─── CSV export ───────────────────────────────────────────────────────────────

const CSV_COLUMNS = [
  'id', 'created_at', 'email', 'name', 'standards', 'standard_ids',
  'start_date', 'end_date', 'days', 'status', 'effective_status',
  'created_by', 'notes', 'notify_sent', 'notify_sent_at', 'notify_error',
  'vitrium_applied_at', 'vitrium_applied_by', 'revoked_at', 'revoked_by',
] as const;

/**
 * GET /api/admin/comp-access.csv?status=&from=&to=&limit=
 *
 * Personal rows, like the device-reset export and unlike the anonymous search
 * logs — which is why it stays behind the admin gate. Cells go through the
 * shared csvCell (lib/collections.js): it quotes, doubles quotes, and prefixes
 * a leading = + - @ so a name or note cannot execute as a formula in Excel.
 */
export async function handleAdminCompAccessCsv(request: Request, env: Env): Promise<Response> {
  const denied = await requireAdminAccess(request, env);
  if (denied) return denied;

  const url = new URL(request.url);
  const statusFilter = (url.searchParams.get('status') || '').trim().toLowerCase();
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');
  const limit = Math.min(50000, Math.max(1, parseInt(url.searchParams.get('limit') || '10000', 10) || 10000));

  let sql = `SELECT ${GRANT_COLUMNS} FROM comp_access_grants WHERE 1=1`;
  const bindings: (string | number)[] = [];
  if (from) { sql += ' AND created_at >= ?'; bindings.push(from); }
  if (to) { sql += ' AND created_at <= ?'; bindings.push(to); }
  sql += ' ORDER BY created_at DESC LIMIT ?';
  bindings.push(limit);

  let rows: CompGrantRow[] = [];
  let catalog = new Map<string, CatalogEntry>();
  try {
    const [res, cat] = await Promise.all([
      env.DB.prepare(sql).bind(...bindings).all<CompGrantRow>(),
      loadStandardCatalog(env.DB),
    ]);
    rows = res.results || [];
    catalog = cat;
  } catch (err) {
    // Migration 0020 not applied — an empty export is a truer answer than a 500.
    console.error('comp access export failed (non-fatal):', errMsg(err));
  }

  const today = todayUtc();
  const csv = [
    CSV_COLUMNS.join(','),
    ...rows
      .map(row => shapeGrant(row, catalog, today))
      .filter(g => !statusFilter || statusFilter === 'all' || g.effective_status === statusFilter)
      .map(g => {
        const cells: Record<string, unknown> = {
          ...g,
          standards: g.documents.map(d => (d.title ? `${d.designation} ${d.title}` : d.designation)).join(' | '),
          standard_ids: g.documents.map(d => d.id).join(' '),
        };
        return CSV_COLUMNS.map(c => csvCell(cells[c])).join(',');
      }),
  ].join('\r\n');

  return new Response(csv, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="lensy-comp-access.csv"',
    },
  });
}

// ─── Parsing & validation ─────────────────────────────────────────────────────

interface GrantWindow { startDate: string; endDate: string; days: number }

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * "Assign 'start' date; auto-calculate end date (but allow override)."
 *
 * `days` drives the end date; an explicit end_date wins and `days` is then
 * RECOMPUTED from the span, because the recipient's email says "you have N
 * days" and it must agree with the dates printed beside it.
 */
export function resolveWindow(input: Record<string, unknown>): GrantWindow | { error: string } {
  const startDate = typeof input.start_date === 'string' && input.start_date.trim()
    ? input.start_date.trim() : todayUtc();
  if (!isDateOnly(startDate)) return { error: 'start_date must be YYYY-MM-DD' };

  const endRaw = typeof input.end_date === 'string' ? input.end_date.trim() : '';
  if (endRaw) {
    if (!isDateOnly(endRaw)) return { error: 'end_date must be YYYY-MM-DD' };
    const days = daysBetween(startDate, endRaw);
    if (days < 1) return { error: 'end_date must be after start_date' };
    if (days > MAX_DAYS) return { error: `A complimentary window longer than ${MAX_DAYS} days is not a comp — check the dates.` };
    return { startDate, endDate: endRaw, days };
  }

  const days = input.days == null || input.days === '' ? DEFAULT_DAYS : Number(input.days);
  if (!Number.isInteger(days) || days < 1 || days > MAX_DAYS) {
    return { error: `days must be a whole number between 1 and ${MAX_DAYS}` };
  }
  return { startDate, endDate: addDays(startDate, days), days };
}

interface ParsedRecipient { email: unknown; name: string | null }

/** Every shape the single-user form and the browser-parsed CSV produce. */
export function parseRecipients(input: Record<string, unknown>): ParsedRecipient[] {
  const raw = input.recipients ?? input.recipient ?? (input.email != null ? { email: input.email, name: input.name } : null);
  const list = Array.isArray(raw) ? raw : raw == null ? [] : [raw];
  return list.map(item => {
    if (typeof item === 'string') return { email: item.trim(), name: null };
    if (item && typeof item === 'object') {
      const obj = item as Record<string, unknown>;
      return { email: obj.email, name: cleanText(obj.name, 200) };
    }
    return { email: null, name: null };
  });
}

/**
 * The corpus, keyed by LOWERCASED id so a hand-typed designation still joins.
 * Both current and deprecated editions are included: the client explicitly
 * allows comping "1 or more documents (current or deprecated)".
 */
async function loadStandardCatalog(db: D1Database): Promise<Map<string, CatalogEntry>> {
  const res = await db.prepare(
    'SELECT id, full_designation, title, status, vitrium_web_url FROM standards'
  ).all<Record<string, unknown>>();
  const map = new Map<string, CatalogEntry>();
  for (const row of res.results || []) {
    const id = String(row.id);
    map.set(id.toLowerCase(), {
      id,
      designation: typeof row.full_designation === 'string' && row.full_designation
        ? row.full_designation : `ANSI/IES ${id}`,
      // The ingest writes title = id when a cover could not be read; printing
      // "RP-3-20 RP-3-20" in a recipient's email helps nobody.
      title: typeof row.title === 'string' && row.title && row.title !== id ? row.title : null,
      status: String(row.status || 'Active'),
      libraryUrl: toLibraryUrlOrNull(row.vitrium_web_url),
    });
  }
  return map;
}

// ─── Small helpers ────────────────────────────────────────────────────────────

/** The staff member's email off the SSO cookie; scripts on the bearer have none. */
async function staffIdentity(request: Request, env: Env): Promise<string> {
  try {
    const sso = await getSsoState(request, env);
    if (sso.state === 'ok') return sso.user.email;
  } catch { /* attribution is best-effort */ }
  return 'staff-bearer';
}

function uniqueStrings(value: unknown): string[] {
  const list = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    if (typeof item !== 'string') continue;
    const s = item.trim();
    if (!s || seen.has(s.toLowerCase())) continue;
    seen.add(s.toLowerCase());
    out.push(s);
  }
  return out;
}

function parseIdList(json: string): string[] {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function cleanText(value: unknown, maxLen: number): string | null {
  if (typeof value !== 'string') return null;
  const s = value.trim();
  return s ? s.slice(0, maxLen) : null;
}

function isDateOnly(s: string): boolean {
  if (!DATE_ONLY_RE.test(s)) return false;
  const ms = Date.parse(`${s}T00:00:00Z`);
  if (Number.isNaN(ms)) return false;
  // Round-trip catches '2026-02-30', which Date.parse accepts by rolling over.
  return new Date(ms).toISOString().slice(0, 10) === s;
}

const DAY_MS = 86400000;

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

function todayUtc(): string { return new Date().toISOString().slice(0, 10); }
function nowUtc(): string { return new Date().toISOString().replace('T', ' ').slice(0, 19); }

function errMsg(err: unknown): string { return err instanceof Error ? err.message : String(err); }

async function safeJson(request: Request): Promise<unknown | null> {
  try { return await request.json(); } catch { return null; }
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
