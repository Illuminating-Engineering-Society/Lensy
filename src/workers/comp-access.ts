/**
 * Complimentary document access (client DO110).
 *
 * "Establish a simple method for IES staff to assign 90-day complimentary
 *  access to any single document, for a single user OR an uploaded csv of
 *  users … to assign an entire classroom or committee (or single volunteer)
 *  complimentary 90-day access to one or more documents without providing
 *  access to the 'full' Lensy toolset."
 *
 * ── SINCE 10/16/26 (client #6) ──────────────────────────────────────────────
 * Two scopes: 'documents' (below) and 'lens' — complimentary FULL IES Lens plus
 * subscriber-level Lighting Library, default 7 days. And the grant IS applied:
 * each row goes to AuthIES's /api/comp-grants (lib/comp-grants.ts), whose
 * Vitrium webhook reads it on every call, and IES Lens itself reads 'lens'
 * rows in the session gate (hasActiveLensComp). The history below is why the
 * Vitrium half lives in AuthIES; the manual route ("Mark applied") remains for
 * whatever AuthIES cannot take — no COMP_GRANTS_API_SECRET, or a standard with
 * no synced vitrium_doc_id.
 *
 * ── WHAT THIS DID NOT DO, BEFORE 10/16 ───────────────────────────────────────
 * It did not grant anything. The permission is applied by hand, today in the
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
import { compGrantsConfigured, pushCompGrant, revokeCompGrant } from '../lib/comp-grants';

/** The client's numbers (DO110; 10/16/26 #6). Overridable per grant. */
const DEFAULT_DAYS = 90;
const DEFAULT_LENS_DAYS = 7;

/** What a row grants — see migration 0023. */
type CompScope = 'documents' | 'lens';

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
  scope: CompScope;
  authies_error: string | null;
}

/** One standards row, as everything here needs it. */
interface CatalogEntry {
  id: string;
  designation: string;
  title: string | null;
  status: string;
  libraryUrl: string | null;
  /** What AuthIES's Vitrium webhook matches a document grant on. */
  vitriumDocId: string | null;
}

const GRANT_COLUMNS =
  `id, created_at, email, name, standard_ids, start_date, end_date, days,
   created_by, notes, status, notify_sent, notify_sent_at, notify_error,
   vitrium_applied_at, vitrium_applied_by, revoked_at, revoked_by,
   scope, authies_error`;

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

  // 'lens' = complimentary FULL IES Lens + subscriber-level Lighting Library
  // (client 10/16/26 #6); anything else is the DO110 document grant.
  const scope: CompScope = input.scope === 'lens' ? 'lens' : 'documents';

  // ── Documents ───────────────────────────────────────────────────────────────
  // A Lens comp opens the whole library, so it carries no document list.
  const requestedIds = scope === 'lens' ? [] : uniqueStrings(input.standard_ids);
  if (scope === 'documents' && requestedIds.length === 0) {
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
  const window = resolveWindow(input, scope === 'lens' ? DEFAULT_LENS_DAYS : DEFAULT_DAYS);
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
          (email, name, standard_ids, start_date, end_date, days, created_by, notes, scope)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        email, item.name, idsJson, window.startDate, window.endDate, window.days,
        createdBy, notes, scope,
      ).run();
      created.push({ id: res.meta.last_row_id as number, email, name: item.name });
    } catch (err) {
      // Unlike the mail, the ROW is the product — if it could not be written,
      // say so per recipient rather than reporting a grant that does not exist.
      rejected.push({ email, reason: `Could not record the grant: ${errMsg(err)}` });
    }
  }

  // The Vitrium half, through AuthIES (client 10/16/26 #6) — BEFORE the mail,
  // so the mail can say whether the access is already live.
  const pushed = await pushGrants(env, request.url, created, scope, resolved, window, createdBy, notes);

  const notify = input.notify !== false;
  const emailed = notify
    ? await mailGrants(env, created, scope, resolved, window, createdBy, pushed)
    : { sent: 0, failed: [] as EmailFailure[], skipped: true };

  const notPushed = created.filter(r => !pushed.has(r.id)).length;
  return json({
    created,
    rejected,
    emailed,
    scope,
    documents: resolved.map(d => ({ id: d.id, designation: d.designation, title: d.title, status: d.status })),
    window,
    vitrium: { applied: created.length - notPushed, pending: notPushed },
    // Printed by the dashboard after every create while anything is pending:
    // that recipient's Library access does not exist until it is done.
    vitriumStep: notPushed === 0 ? null : (scope === 'lens'
      ? 'The Lighting Library half could not be applied automatically — use "Retry" on the row, or give the recipient subscriber access in Vitrium by hand and mark it applied.'
      : 'The Lighting Library half could not be applied automatically — use "Retry" on the row, or enable these documents for the recipient in Vitrium by hand and mark it applied.'),
  }, created.length > 0 ? 201 : 200);
}

// ─── The Vitrium half, through AuthIES (client 10/16/26 #6) ──────────────────

/**
 * Hand each fresh row to AuthIES and stamp what happened. Returns the ids that
 * landed. A document whose standard has no synced Vitrium id cannot be granted
 * automatically, so such a grant stays "awaiting Vitrium" with the reason.
 */
async function pushGrants(
  env: Env,
  requestUrl: string,
  rows: Array<{ id: number; email: string }>,
  scope: CompScope,
  documents: CatalogEntry[],
  window: GrantWindow,
  grantedBy: string | null,
  note: string | null,
): Promise<Set<number>> {
  const landed = new Set<number>();
  if (rows.length === 0 || !compGrantsConfigured(env)) return landed;

  const missing = documents.filter(d => !d.vitriumDocId).map(d => d.id);
  for (let i = 0; i < rows.length; i += EMAIL_CONCURRENCY) {
    const group = rows.slice(i, i + EMAIL_CONCURRENCY);
    await Promise.all(group.map(async row => {
      const outcome = scope === 'documents' && missing.length > 0
        ? { ok: false as const, error: `No Vitrium document id synced for ${missing.join(', ')} — apply by hand.` }
        : await pushCompGrant(env, requestUrl, {
            rowId: row.id,
            email: row.email,
            kind: scope === 'lens' ? 'subscriber' : 'documents',
            documents: documents.map(d => d.vitriumDocId as string),
            labels: documents.map(d => d.id),
            startDate: window.startDate,
            endDate: window.endDate,
            grantedBy,
            note,
          });
      if (outcome.ok) landed.add(row.id);
      await stampPush(env, row.id, outcome.ok ? null : outcome.error);
    }));
  }
  return landed;
}

/** Record a push outcome on the row; a D1 hiccup here must not fail the request. */
async function stampPush(env: Env, id: number, error: string | null): Promise<void> {
  if (error != null) return stampAuthiesError(env, id, error);
  try {
    await env.DB.prepare(`
      UPDATE comp_access_grants
      SET vitrium_applied_at = datetime('now'), vitrium_applied_by = ?, authies_error = NULL
      WHERE id = ?
    `).bind(AUTHIES_APPLIER, id).run();
  } catch (err) {
    console.error('comp_access_push_status_write_failed', { id, detail: errMsg(err) });
  }
}

async function stampAuthiesError(env: Env, id: number, error: string | null): Promise<void> {
  try {
    await env.DB.prepare('UPDATE comp_access_grants SET authies_error = ? WHERE id = ?').bind(error, id).run();
  } catch (err) {
    console.error('comp_access_push_status_write_failed', { id, detail: errMsg(err) });
  }
}

/** `vitrium_applied_by` when AuthIES applied it, rather than a staff member. */
export const AUTHIES_APPLIER = 'authies';

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
  scope: CompScope,
  documents: CatalogEntry[],
  window: GrantWindow,
  grantedBy: string | null,
  applied: Set<number>,
): Promise<EmailReport> {
  const report: EmailReport = { sent: 0, failed: [] };
  for (let i = 0; i < rows.length; i += EMAIL_CONCURRENCY) {
    const group = rows.slice(i, i + EMAIL_CONCURRENCY);
    const outcomes = await Promise.all(
      group.map(row => deliverGrant(env, row, scope, documents, window, grantedBy, applied.has(row.id))),
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
  scope: CompScope,
  documents: CatalogEntry[],
  window: GrantWindow,
  grantedBy: string | null,
  applied: boolean,
): Promise<SendOutcome> {
  const outcome = await sendCompAccessEmail(env, {
    to: row.email,
    name: row.name,
    scope,
    applied,
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
 *   { retry: true }                         hand the grant to AuthIES again
 *
 * Revoking and reinstating follow through to AuthIES (client 10/16/26 #6), so
 * the Lighting Library half ends or resumes with the row. Marking applied by
 * hand remains for a grant AuthIES could not take (no COMP_GRANTS_API_SECRET,
 * or a standard with no synced Vitrium id).
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
  const wantsRetry = patch.retry === true;
  if (fields.length === 0 && !wantsResend && !wantsRetry) {
    return json({ error: 'Nothing to update (send status, vitrium_applied, resend or retry)' }, 400);
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
  const grantRow = row;
  const grantDocuments = async (): Promise<CatalogEntry[]> => {
    const known = await catalog();
    return parseIdList(grantRow.standard_ids)
      .map(sid => known.get(sid.toLowerCase()))
      .filter((d): d is CatalogEntry => Boolean(d));
  };
  const scope: CompScope = row.scope === 'lens' ? 'lens' : 'documents';
  const window: GrantWindow = { startDate: row.start_date, endDate: row.end_date, days: row.days };

  // ── AuthIES follows the row (client 10/16/26 #6) ────────────────────────────
  const newStatus = 'status' in patch ? String(patch.status).trim().toLowerCase() : null;
  let authies: { ok: boolean; error?: string } | undefined;
  if (newStatus === 'revoked') {
    if (compGrantsConfigured(env)) {
      const out = await revokeCompGrant(env, request.url, id, row.email, by);
      authies = out.ok ? { ok: true } : { ok: false, error: out.error };
      await stampAuthiesError(env, id, out.ok ? null : out.error);
    }
  } else if ((newStatus === 'active' || wantsRetry)
      && effectiveGrantStatus({ status: newStatus ?? row.status, end_date: row.end_date }, todayUtc()) === 'active') {
    const landed = await pushGrants(env, request.url, [{ id, email: row.email }], scope, await grantDocuments(), window, row.created_by, row.notes);
    authies = landed.has(id) ? { ok: true } : { ok: false, error: 'AuthIES did not take the grant — the row says why.' };
  }

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

    const documents = await grantDocuments();
    if (scope === 'documents' && documents.length === 0) {
      return json({ error: 'None of this grant\'s documents are in the corpus any more.' }, 409);
    }
    // Whether the Library half is live NOW (a retry above may just have
    // applied it) decides what the mail promises.
    const appliedNow = authies?.ok === true || (!!row.vitrium_applied_at && newStatus !== 'active');
    resend = await deliverGrant(env, { id, email: row.email, name: row.name }, scope, documents, window,
      row.created_by, appliedNow);
    if (!resend.sent) return json({ error: resend.error }, 502);
  }

  const updated = await env.DB.prepare(
    `SELECT ${GRANT_COLUMNS} FROM comp_access_grants WHERE id = ?`
  ).bind(id).first<CompGrantRow>();
  return json({
    updated: true,
    resent: resend?.sent === true,
    ...(authies ? { authies } : {}),
    grant: updated ? shapeGrant(updated, await catalog(), todayUtc()) : null,
  });
}

// ─── CSV export ───────────────────────────────────────────────────────────────

const CSV_COLUMNS = [
  'id', 'created_at', 'email', 'name', 'standards', 'standard_ids',
  'start_date', 'end_date', 'days', 'status', 'effective_status',
  'created_by', 'notes', 'notify_sent', 'notify_sent_at', 'notify_error',
  'vitrium_applied_at', 'vitrium_applied_by', 'revoked_at', 'revoked_by',
  'scope', 'authies_error',
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
export function resolveWindow(
  input: Record<string, unknown>,
  defaultDays: number = DEFAULT_DAYS,
): GrantWindow | { error: string } {
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

  const days = input.days == null || input.days === '' ? defaultDays : Number(input.days);
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
    'SELECT id, full_designation, title, status, vitrium_web_url, vitrium_doc_id FROM standards'
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
      vitriumDocId: typeof row.vitrium_doc_id === 'string' && row.vitrium_doc_id.trim() ? row.vitrium_doc_id.trim() : null,
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
