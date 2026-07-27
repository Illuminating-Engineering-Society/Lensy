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
 * Endpoints:
 *   GET    /api/admin/users            List + status counts (?q= text filter,
 *                                      ?status=invited|active|revoked|expired)
 *   POST   /api/admin/users            Invite one ({email,...}) or bulk ([{...}])
 *   PATCH  /api/admin/users/:id        Update name/org/role/status/expiry/notes
 *   DELETE /api/admin/users/:id        Remove the row entirely
 */

import { requireAdminAccess } from './session';
import {
  parseInvite,
  normalizeExpiry,
  effectiveStatus,
  INVITE_ROLES,
  INVITE_STATUSES,
} from '../lib/invites';
import type { InvitedUserRow } from '../types';

// The list endpoint loads everything and filters in JS so the status counts
// (including the computed 'expired' bucket) stay consistent with the rows
// shown. Fine for an invite list; revisit if it ever nears this cap.
const LIST_CAP = 1000;

export async function handleAdminUsers(request: Request, env: Env, url: URL): Promise<Response> {
  const denied = await requireAdminAccess(request, env);
  if (denied) return denied;

  const parts = url.pathname.split('/').filter(Boolean); // ['api','admin','users',':id']
  const id = parts[3];

  switch (request.method) {
    case 'GET':
      if (id) return json({ error: 'Not found' }, 404);
      return listUsers(env, url);
    case 'POST':
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

  return json({ inserted, skipped, rejected }, inserted.length > 0 ? 201 : 200);
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
