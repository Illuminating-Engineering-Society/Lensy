/**
 * Lensy Invited-Users Endpoints (staff dashboard backend)
 *
 * Staff-managed guest-access allowlist (see migrations/0007_invited_users.sql).
 * Serves the dashboard at /admin/users.html and backs the SSO access decision
 * (lib/sso.ts decideAccess reads the same table).
 *
 * Auth: same gate as every admin endpoint — an SSO session with admin rights
 * (IdP `administrator` role, or an invite row with role 'admin'), or the
 * LUCIUS_API_SECRET bearer for scripts (workers/session.ts).
 *
 * Every new invite is emailed (lib/email.ts). The send is deliberately NOT
 * transactional with the insert: a mail failure leaves a perfectly usable
 * allowlist row plus a stored reason, and the row can be re-sent. Rolling the
 * invite back because SMTP hiccuped would be the worse trade.
 *
 * Endpoints:
 *   GET    /api/admin/users            List + status counts (?q= text filter,
 *                                      ?status=invited|active|revoked|expired)
 *   POST   /api/admin/users            Invite one ({email,...}) or bulk ([{...}])
 *                                      — emails each one; ?email=0 to skip
 *   PATCH  /api/admin/users/:id        Update name/org/role/status/expiry/notes
 *   DELETE /api/admin/users/:id        Remove the row entirely
 *   POST   /api/admin/users/:id/resend Re-send the invitation email
 */

import { requireAdminAccess } from './session';
import {
  parseInvite,
  normalizeExpiry,
  effectiveStatus,
  INVITE_ROLES,
  INVITE_STATUSES,
} from '../lib/invites';
import { sendInviteEmail, resolveAppUrl, type SendOutcome } from '../lib/email';
import type { InvitedUserRow } from '../types';

// The list endpoint loads everything and filters in JS so the status counts
// (including the computed 'expired' bucket) stay consistent with the rows
// shown. Fine for an invite list; revisit if it ever nears this cap.
const LIST_CAP = 1000;

// Invitations per request are capped at 200, and each send is a subrequest.
// Sending them one after another would run 200 round-trips in series and risk
// the request wall-clock limit, so they go out in small concurrent groups.
const EMAIL_CONCURRENCY = 8;

export async function handleAdminUsers(request: Request, env: Env, url: URL): Promise<Response> {
  const denied = await requireAdminAccess(request, env);
  if (denied) return denied;

  const parts = url.pathname.split('/').filter(Boolean); // ['api','admin','users',':id','resend']
  const id = parts[3];
  const action = parts[4];

  if (action && action !== 'resend') return json({ error: 'Not found' }, 404);

  switch (request.method) {
    case 'GET':
      if (id) return json({ error: 'Not found' }, 404);
      return listUsers(env, url);
    case 'POST':
      if (id && action === 'resend') return resendInvite(request, env, id);
      if (id) return json({ error: 'POST takes no id' }, 400);
      return createUsers(request, env);
    case 'PATCH':
      if (!id) return json({ error: 'User id required' }, 400);
      return updateUser(request, env, id);
    case 'DELETE':
      if (!id) return json({ error: 'User id required' }, 400);
      return deleteUser(env, id);
    default:
      return json({ error: 'Method not allowed' }, 405);
  }
}

async function listUsers(env: Env, url: URL): Promise<Response> {
  const q = (url.searchParams.get('q') || '').trim().toLowerCase();
  const statusFilter = (url.searchParams.get('status') || '').trim().toLowerCase();

  const result = await env.DB.prepare(
    `SELECT * FROM invited_users ORDER BY created_at DESC, id DESC LIMIT ${LIST_CAP}`
  ).all<InvitedUserRow>();

  const now = Date.now();
  const rows = (result.results || []).map((row) => ({
    ...row,
    effective_status: effectiveStatus(row, now),
  }));

  const counts = { all: rows.length, invited: 0, active: 0, revoked: 0, expired: 0 };
  for (const row of rows) {
    if (row.effective_status in counts) {
      counts[row.effective_status as keyof typeof counts]++;
    }
  }

  let users = rows;
  if (statusFilter && statusFilter !== 'all') {
    users = users.filter((r) => r.effective_status === statusFilter);
  }
  if (q) {
    users = users.filter((r) =>
      [r.email, r.name, r.organization, r.invited_by]
        .some((f) => f && f.toLowerCase().includes(q))
    );
  }

  return json({ users, counts, capped: rows.length === LIST_CAP });
}

async function createUsers(request: Request, env: Env): Promise<Response> {
  const body = await safeJson(request);
  if (body == null) return json({ error: 'Invalid JSON body' }, 400);
  const items = Array.isArray(body) ? body : [body];
  if (items.length === 0) return json({ error: 'Empty invite list' }, 400);
  if (items.length > 200) return json({ error: 'Max 200 invites per request' }, 400);

  // ?email=0 adds people without notifying them — for backfilling a list, or
  // when someone is being told out of band.
  const notify = new URL(request.url).searchParams.get('email') !== '0';

  const inserted: InvitedUserRow[] = [];
  const skipped: Array<{ email: string; reason: string }> = [];
  const rejected: Array<{ email: string | null; reason: string }> = [];

  for (const item of items) {
    const parsed = parseInvite(item);
    if (!parsed.ok) {
      const rawEmail = typeof (item as Record<string, unknown>)?.email === 'string'
        ? ((item as Record<string, unknown>).email as string)
        : null;
      rejected.push({ email: rawEmail, reason: parsed.reason });
      continue;
    }
    const invite = parsed.value;
    const invitedBy = typeof (item as Record<string, unknown>).invited_by === 'string'
      ? ((item as Record<string, unknown>).invited_by as string).trim().slice(0, 120) || null
      : null;

    const existing = await env.DB.prepare(
      'SELECT id FROM invited_users WHERE email = ?'
    ).bind(invite.email).first();
    if (existing) {
      skipped.push({ email: invite.email, reason: 'Already invited' });
      continue;
    }

    const res = await env.DB.prepare(`
      INSERT INTO invited_users (email, name, organization, role, expires_at, notes, invited_by)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(
      invite.email, invite.name, invite.organization, invite.role,
      invite.expires_at, invite.notes, invitedBy
    ).run();

    const row = await env.DB.prepare(
      'SELECT * FROM invited_users WHERE id = ?'
    ).bind(res.meta.last_row_id).first<InvitedUserRow>();
    if (row) inserted.push(row);
  }

  const emailed = notify
    ? await mailInvites(request, env, inserted)
    : { sent: 0, failed: [] as EmailFailure[], skipped: true };

  return json({ inserted, skipped, rejected, emailed }, inserted.length > 0 ? 201 : 200);
}

// ─── Invitation email ─────────────────────────────────────────────────────────

interface EmailFailure { email: string; error: string }

interface EmailReport {
  sent: number;
  failed: EmailFailure[];
  /** True when sending was deliberately bypassed (?email=0). */
  skipped?: boolean;
}

/**
 * Email every freshly-inserted invite, in small concurrent groups, and record
 * the outcome on each row. Never throws and never affects the invites already
 * written — the report is informational for the dashboard.
 */
async function mailInvites(
  request: Request,
  env: Env,
  rows: InvitedUserRow[],
): Promise<EmailReport> {
  const appUrl = resolveAppUrl(request, env);
  const report: EmailReport = { sent: 0, failed: [] };

  for (let i = 0; i < rows.length; i += EMAIL_CONCURRENCY) {
    const group = rows.slice(i, i + EMAIL_CONCURRENCY);
    const outcomes = await Promise.all(
      group.map((row) => deliverInvite(env, row, appUrl)),
    );
    for (let j = 0; j < group.length; j++) {
      const outcome = outcomes[j];
      if (outcome.sent) report.sent++;
      else report.failed.push({ email: group[j].email, error: outcome.error });
    }
  }

  return report;
}

/** Send one invite and persist the outcome against its row. */
async function deliverInvite(
  env: Env,
  row: InvitedUserRow,
  appUrl: string,
): Promise<SendOutcome> {
  const outcome = await sendInviteEmail(env, {
    email: row.email,
    name: row.name,
    organization: row.organization,
    role: row.role,
    expiresAt: row.expires_at,
    invitedBy: row.invited_by,
    appUrl,
  });

  // Recording the outcome must not turn a mail problem into a 500, so a D1
  // failure here is swallowed — the send already happened either way.
  try {
    if (outcome.sent) {
      await env.DB.prepare(`
        UPDATE invited_users
        SET invite_sent_at = datetime('now'), invite_send_error = NULL
        WHERE id = ?
      `).bind(row.id).run();
    } else {
      await env.DB.prepare(
        'UPDATE invited_users SET invite_send_error = ? WHERE id = ?'
      ).bind(outcome.error, row.id).run();
    }
  } catch (err) {
    console.error('invite_email_status_write_failed', {
      id: row.id,
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  return outcome;
}

/**
 * POST /api/admin/users/:id/resend — send the invitation again.
 *
 * Needed for every row created before invitation mail existed (they have
 * invite_sent_at NULL and would otherwise never be told), and for anything that
 * failed the first time. Revoked rows are refused: mailing "your access is
 * ready" to someone whose access was deliberately taken away is worse than a
 * missing email. Expired rows are refused for the same reason.
 */
async function resendInvite(request: Request, env: Env, id: string): Promise<Response> {
  const row = await env.DB.prepare(
    'SELECT * FROM invited_users WHERE id = ?'
  ).bind(id).first<InvitedUserRow>();
  if (!row) return json({ error: 'User not found' }, 404);

  const status = effectiveStatus(row, Date.now());
  if (status === 'revoked') {
    return json({ error: 'Cannot email a revoked invite. Reinstate it first.' }, 409);
  }
  if (status === 'expired') {
    return json({ error: 'Cannot email an expired invite. Extend the expiry first.' }, 409);
  }

  const outcome = await deliverInvite(env, row, resolveAppUrl(request, env));
  if (!outcome.sent) return json({ error: outcome.error }, 502);

  const updated = await env.DB.prepare(
    'SELECT * FROM invited_users WHERE id = ?'
  ).bind(id).first<InvitedUserRow>();
  return json({
    sent: true,
    user: updated ? { ...updated, effective_status: effectiveStatus(updated, Date.now()) } : null,
  });
}

async function updateUser(request: Request, env: Env, id: string): Promise<Response> {
  const body = await safeJson(request);
  if (body == null || typeof body !== 'object' || Array.isArray(body)) {
    return json({ error: 'Invalid JSON body' }, 400);
  }
  const patch = body as Record<string, unknown>;

  const fields: string[] = [];
  const values: (string | null)[] = [];

  const setText = (key: 'name' | 'organization' | 'notes' | 'invited_by', maxLen: number) => {
    if (!(key in patch)) return;
    const raw = patch[key];
    const val = typeof raw === 'string' ? raw.trim().slice(0, maxLen) || null : null;
    fields.push(`${key} = ?`);
    values.push(val);
  };
  setText('name', 300);
  setText('organization', 300);
  setText('notes', 1000);
  setText('invited_by', 120);

  if ('role' in patch) {
    const role = typeof patch.role === 'string' ? patch.role.trim().toLowerCase() : '';
    if (!(INVITE_ROLES as readonly string[]).includes(role)) {
      return json({ error: `Invalid role (expected ${INVITE_ROLES.join(' | ')})` }, 400);
    }
    fields.push('role = ?');
    values.push(role);
  }

  if ('status' in patch) {
    const status = typeof patch.status === 'string' ? patch.status.trim().toLowerCase() : '';
    if (!(INVITE_STATUSES as readonly string[]).includes(status)) {
      return json({ error: `Invalid status (expected ${INVITE_STATUSES.join(' | ')})` }, 400);
    }
    fields.push('status = ?');
    values.push(status);
  }

  if ('expires_at' in patch) {
    const expiry = normalizeExpiry(patch.expires_at);
    if (!expiry.ok) {
      return json({ error: 'Invalid expires_at (use YYYY-MM-DD or ISO timestamp)' }, 400);
    }
    fields.push('expires_at = ?');
    values.push(expiry.value);
  }

  if (fields.length === 0) return json({ error: 'No valid fields to update' }, 400);
  fields.push(`updated_at = datetime('now')`);

  const res = await env.DB.prepare(
    `UPDATE invited_users SET ${fields.join(', ')} WHERE id = ?`
  ).bind(...values, id).run();
  if (res.meta.changes === 0) return json({ error: 'User not found' }, 404);

  const row = await env.DB.prepare(
    'SELECT * FROM invited_users WHERE id = ?'
  ).bind(id).first<InvitedUserRow>();
  return json({
    user: row ? { ...row, effective_status: effectiveStatus(row, Date.now()) } : null,
  });
}

async function deleteUser(env: Env, id: string): Promise<Response> {
  const res = await env.DB.prepare(
    'DELETE FROM invited_users WHERE id = ?'
  ).bind(id).run();
  if (res.meta.changes === 0) return json({ error: 'User not found' }, 404);
  return json({ deleted: true });
}

// ─── Utilities ────────────────────────────────────────────────────────────────

async function safeJson(request: Request): Promise<unknown | null> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
