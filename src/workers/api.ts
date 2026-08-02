/**
 * Lensy API — Main Router
 * Cloudflare Worker entry point. Routes all /api/* requests.
 *
 * Endpoints:
 *   POST /api/search
 *   GET  /api/applications/:code
 *   GET  /api/standards
 *
 *   POST   /api/projects
 *   GET    /api/projects
 *   GET    /api/projects/:id
 *   PATCH  /api/projects/:id
 *   DELETE /api/projects/:id
 *
 *   POST   /api/projects/:id/applications
 *   PATCH  /api/projects/:id/applications/:appId
 *   DELETE /api/projects/:id/applications/:appId
 *
 *   GET    /api/projects/:id/export
 */

import { handleSearch } from './search';
import { handleIngest } from './ingest';
import { handleAdminScanOrphans, handleAdminEnumerateIds, handleAdminDeleteOrphans, handleAdminFlushCache, handleAdminSearchLog, handleAdminR2Multipart, handleAdminIndexStatus } from './admin';
import { handleAdminUsers } from './users';
import { handleAuthMe, handleDevLogin, requireReadAccess } from './session';
import { buildLoginUrl, buildLogoutUrl } from '../lib/sso';

// CORS: `*` with no Allow-Credentials, so a cross-origin page can never make a
// cookie-authenticated call — every session-gated route is effectively
// same-origin only, and cross-origin callers must present the bearer secret.
// KNOWN GAP (Phase 1 by design): the
// /api/projects* routes are anonymous — user_id is a client-supplied
// placeholder until Phase 3 SSO lands, so project data must be treated as
// non-confidential until then. Tracked in README "Launch Operations".
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  // Defense in depth: JSON responses must never be sniffed into HTML.
  'X-Content-Type-Options': 'nosniff',
};

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // ── Auth (SSO against auth.ies.org — lib/sso.ts) ─────────────────────
      if (path === '/api/auth/me' && request.method === 'GET') {
        return withCors(await handleAuthMe(request, env));
      }
      if (path === '/api/auth/dev-login' && request.method === 'POST') {
        return withCors(await handleDevLogin(request, env));
      }
      if (path === '/login' && request.method === 'GET') {
        return Response.redirect(buildLoginUrl(env, request.url), 302);
      }
      if (path === '/logout' && request.method === 'GET') {
        return Response.redirect(buildLogoutUrl(env, request.url), 302);
      }

      // ── Search (requires an SSO session or the staff bearer secret) ──────
      if (path === '/api/search' && request.method === 'POST') {
        const denied = await requireReadAccess(request, env);
        if (denied) return withCors(denied);
        return withCors(await handleSearch(request, env, ctx));
      }

      // ── Ingest (internal/admin only) ─────────────────────────────────────
      if (path.startsWith('/api/ingest') && request.method === 'POST') {
        return withCors(await handleIngest(request, env));
      }

      // ── Admin (SSO `administrator` role, or the staff bearer for scripts;
      //    each handler calls requireAdminAccess — see workers/session.ts) ──
      if (path === '/api/admin/scan-orphans' && request.method === 'POST') {
        return withCors(await handleAdminScanOrphans(request, env));
      }
      if (path === '/api/admin/enumerate-ids' && request.method === 'POST') {
        return withCors(await handleAdminEnumerateIds(request, env));
      }
      if (path === '/api/admin/delete-orphans' && request.method === 'POST') {
        return withCors(await handleAdminDeleteOrphans(request, env));
      }
      if (path === '/api/admin/flush-cache' && request.method === 'POST') {
        return withCors(await handleAdminFlushCache(request, env));
      }
      if (path === '/api/admin/search-log.csv' && request.method === 'GET') {
        return withCors(await handleAdminSearchLog(request, env));
      }
      if (path === '/api/admin/index-status' && request.method === 'GET') {
        return withCors(await handleAdminIndexStatus(request, env));
      }
      if (path === '/api/admin/r2-multipart' && request.method === 'POST') {
        return withCors(await handleAdminR2Multipart(request, env));
      }

      // ── Admin: invited-users dashboard backend ───────────────────────────
      if (path === '/api/admin/users' || path.startsWith('/api/admin/users/')) {
        return withCors(await handleAdminUsers(request, env, url));
      }

      // ── Applications / Standards / Projects (same session gate as search) ─
      if (
        path.startsWith('/api/applications') ||
        path.startsWith('/api/standards') ||
        path.startsWith('/api/projects')
      ) {
        const denied = await requireReadAccess(request, env);
        if (denied) return withCors(denied);
      }

      if (path.startsWith('/api/applications')) {
        return withCors(await handleApplications(request, env, url));
      }

      if (path.startsWith('/api/standards')) {
        return withCors(await handleStandards(request, env, url));
      }

      if (path.startsWith('/api/projects')) {
        return withCors(await handleProjects(request, env, url));
      }

      return withCors(json({ error: 'Not found' }, 404));
    } catch (err) {
      console.error('API error:', err);
      // Never leak stack/internal details to production clients; the full
      // error is in the Worker logs (`wrangler tail`).
      const detail = env.ENVIRONMENT === 'production' ? undefined : (err instanceof Error ? err.message : String(err));
      return withCors(json({ error: 'Internal server error', ...(detail ? { detail } : {}) }, 500));
    }
  },
};

/**
 * Decode one percent-encoded path segment.
 *
 * `url.pathname` is always encoded, so an id has to be decoded before it can be
 * compared against D1. Malformed encoding (a stray '%') throws in
 * decodeURIComponent — fall back to the raw segment so a bad URL 404s on lookup
 * rather than 500s on parse.
 */
function decodePathSegment(segment: string | undefined): string | undefined {
  if (segment == null) return undefined;
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

// ─── Applications Handlers ────────────────────────────────────────────────────

async function handleApplications(request: Request, env: Env, url: URL): Promise<Response> {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', 'applications', ':code']
  const code = decodePathSegment(parts[2]);

  if (!code) {
    // GET /api/applications — list all (with optional filters)
    const standard = url.searchParams.get('standard');
    const app = url.searchParams.get('app');
    const indoorOutdoor = url.searchParams.get('indoor_outdoor');
    const activeOnly = url.searchParams.get('active') !== '0';

    let query = 'SELECT * FROM applications WHERE 1=1';
    const bindings = [];

    if (activeOnly) { query += ' AND Active = 1'; }
    if (standard) { query += ' AND Standard = ?'; bindings.push(standard); }
    if (app) { query += ' AND App = ?'; bindings.push(app); }
    if (indoorOutdoor) { query += ' AND Indoor_Outdoor = ?'; bindings.push(indoorOutdoor); }

    query += ' ORDER BY App, App_s1, App_s2 LIMIT 200';

    const result = await env.DB.prepare(query).bind(...bindings).all();
    return json({ applications: result.results });
  }

  // GET /api/applications/:code
  const app = await env.DB.prepare(
    'SELECT * FROM applications WHERE code = ?'
  ).bind(code).first();

  if (!app) return json({ error: 'Application not found' }, 404);
  return json({ application: app });
}

// ─── Standards Handlers ───────────────────────────────────────────────────────

async function handleStandards(request: Request, env: Env, url: URL): Promise<Response> {
  const parts = url.pathname.split('/').filter(Boolean);
  // url.pathname is percent-ENCODED. Standard ids carry errata suffixes with a
  // '+' ("RP-2-20+E1", "RP-8-25+E2", "LP-3-20+E1"), which encodes to %2B, so
  // matching the raw segment against `id` missed every errata edition in the
  // library — a large slice of it — with a 404.
  const id = decodePathSegment(parts[2]);

  if (!id) {
    // GET /api/standards — list all. Includes the Lighting Library viewer URL so
    // the Table of Contents page (client DO32) can link each standard, and
    // page/chunk counts so staff can see coverage at a glance. Deprecated
    // editions are excluded by default — the Table of Contents lists the current
    // library — but reachable with ?status=all for the comparison tooling.
    const status = url.searchParams.get('status');
    const where = status === 'all' ? '' : " WHERE status = 'Active'";
    const result = await env.DB.prepare(
      'SELECT id, title, full_designation, year, status, vitrium_web_url, page_count' +
      ` FROM standards${where} ORDER BY id`
    ).all();
    return json({ standards: result.results });
  }

  // GET /api/standards/:id
  const standard = await env.DB.prepare(
    'SELECT * FROM standards WHERE id = ?'
  ).bind(id).first();

  if (!standard) return json({ error: 'Standard not found' }, 404);
  return json({ standard });
}

// ─── Projects Handlers ────────────────────────────────────────────────────────

async function handleProjects(request: Request, env: Env, url: URL): Promise<Response> {
  const parts = url.pathname.split('/').filter(Boolean);
  // ['api', 'projects'] or ['api', 'projects', :id] or ['api', 'projects', :id, 'applications', :appId]
  const projectId = parts[2];
  const subResource = parts[3]; // 'applications' | 'export' | undefined
  const appId = parts[4];

  // Route to sub-resource handlers
  if (projectId && subResource === 'applications') {
    return handleProjectApplications(request, env, url, projectId, appId);
  }
  if (projectId && subResource === 'export') {
    return handleProjectExport(request, env, projectId, url);
  }

  // Project CRUD
  switch (request.method) {
    case 'GET':
      if (projectId) return getProject(env, projectId);
      return listProjects(request, env, url);

    case 'POST':
      return createProject(request, env);

    case 'PATCH':
      if (!projectId) return json({ error: 'Project ID required' }, 400);
      return updateProject(request, env, projectId);

    case 'DELETE':
      if (!projectId) return json({ error: 'Project ID required' }, 400);
      return deleteProject(env, projectId);

    default:
      return json({ error: 'Method not allowed' }, 405);
  }
}

async function listProjects(request: Request, env: Env, url: URL): Promise<Response> {
  // Phase 1: simple user_id from query param (Phase 3 will use auth middleware)
  const userId = url.searchParams.get('user_id') || '1';
  const status = url.searchParams.get('status') || 'Active';

  const result = await env.DB.prepare(`
    SELECT p.*,
      (SELECT COUNT(*) FROM project_applications pa WHERE pa.project_id = p.id) AS application_count
    FROM projects p
    WHERE p.user_id = ? AND p.status = ?
    ORDER BY p.modified_at DESC
  `).bind(userId, status).all();

  return json({ projects: result.results });
}

async function getProject(env: Env, projectId: string): Promise<Response> {
  const project = await env.DB.prepare(
    'SELECT * FROM projects WHERE id = ?'
  ).bind(projectId).first();

  if (!project) return json({ error: 'Project not found' }, 404);

  const rows = await env.DB.prepare(`
    SELECT pa.*, a.code AS live_code, a.App, a.App_s1, a.App_s2, a.Standard, a.Standard_Full,
           a.Hor_Lux, a.Hor_Fc, a.Ver_Lux, a.Ver_Fc, a.Indoor_Outdoor
    FROM project_applications pa
    LEFT JOIN applications a ON pa.application_code = a.code
    WHERE pa.project_id = ?
    ORDER BY pa.sort_order, pa.added_at
  `).bind(projectId).all<Record<string, any>>();

  // A saved project item must not change meaning when the corpus is re-ingested.
  //
  // Application codes are `<STDID>_<rowIndex>`, so any extractor change that
  // shifts row numbering re-points a code at a DIFFERENT row — and the ingest
  // prune deletes codes a new parse no longer produces. Either way the live join
  // is no longer authoritative for something the user deliberately saved. That is
  // exactly why `snapshot_data` is written at save time; this is where it is
  // finally read.
  //
  // The snapshot wins for every displayed field; the join is used only to say
  // whether the row still exists in the current corpus, so the UI can flag an
  // item worth re-checking against the standard.
  const applications = (rows.results || []).map(row => {
    const snapshot = parseSnapshot(row.snapshot_data);
    if (!snapshot) return { ...row, snapshotMissing: row.live_code == null };

    const fromSnapshot = {
      App: snapshot.App, App_s1: snapshot.App_s1, App_s2: snapshot.App_s2,
      Standard: snapshot.Standard, Standard_Full: snapshot.Standard_Full,
      Hor_Lux: snapshot.Hor_Lux, Hor_Fc: snapshot.Hor_Fc,
      Ver_Lux: snapshot.Ver_Lux, Ver_Fc: snapshot.Ver_Fc,
      Indoor_Outdoor: snapshot.Indoor_Outdoor,
    };
    // "Moved" = the code still resolves, but to a different application than the
    // one saved. "Removed" = the code is gone from the corpus entirely.
    const removed = row.live_code == null;
    const moved = !removed && row.Standard != null &&
      (row.App !== snapshot.App || row.App_s1 !== snapshot.App_s1 || row.Standard !== snapshot.Standard);

    return { ...row, ...fromSnapshot, removedFromCorpus: removed, reindexed: moved };
  });

  return json({ project, applications });
}

/** project_applications.snapshot_data → the 68-column row saved at add time. */
function parseSnapshot(raw: unknown): Record<string, any> | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : null;
  } catch {
    return null;
  }
}

async function createProject(request: Request, env: Env): Promise<Response> {
  const body: any = await request.json();
  const {
    user_id = 1, name, location, client_name, client_company,
    project_type, designer_name, designer_company, target_codes, notes
  } = body;

  if (!name) return json({ error: 'Project name is required' }, 400);

  const result = await env.DB.prepare(`
    INSERT INTO projects
      (user_id, name, location, client_name, client_company, project_type,
       designer_name, designer_company, target_codes, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    user_id, name, location || null, client_name || null, client_company || null,
    project_type || null, designer_name || null, designer_company || null,
    target_codes || null, notes || null
  ).run();

  const project = await env.DB.prepare(
    'SELECT * FROM projects WHERE id = ?'
  ).bind(result.meta.last_row_id).first();

  return json({ project }, 201);
}

async function updateProject(request: Request, env: Env, projectId: string): Promise<Response> {
  const body: any = await request.json();
  const allowed = ['name', 'location', 'client_name', 'client_company',
                   'project_type', 'designer_name', 'designer_company',
                   'target_codes', 'status', 'notes'];

  const fields = Object.keys(body).filter(k => allowed.includes(k));
  if (fields.length === 0) return json({ error: 'No valid fields to update' }, 400);

  const setClauses = fields.map(f => `${f} = ?`).join(', ');
  const values = fields.map(f => body[f]);

  await env.DB.prepare(
    `UPDATE projects SET ${setClauses} WHERE id = ?`
  ).bind(...values, projectId).run();

  return getProject(env, projectId);
}

async function deleteProject(env: Env, projectId: string): Promise<Response> {
  const project = await env.DB.prepare(
    'SELECT id FROM projects WHERE id = ?'
  ).bind(projectId).first();

  if (!project) return json({ error: 'Project not found' }, 404);

  // ON DELETE CASCADE handles project_applications
  await env.DB.prepare('DELETE FROM projects WHERE id = ?').bind(projectId).run();
  return json({ deleted: true });
}

// ─── Project Applications Sub-resource ───────────────────────────────────────

async function handleProjectApplications(request: Request, env: Env, url: URL, projectId: string, appId?: string): Promise<Response> {
  switch (request.method) {
    case 'POST':
      return addApplicationToProject(request, env, projectId);

    case 'PATCH':
      if (!appId) return json({ error: 'Application record ID required' }, 400);
      return updateApplicationInProject(request, env, appId);

    case 'DELETE':
      if (!appId) return json({ error: 'Application record ID required' }, 400);
      return removeApplicationFromProject(env, appId, projectId);

    default:
      return json({ error: 'Method not allowed' }, 405);
  }
}

async function addApplicationToProject(request: Request, env: Env, projectId: string): Promise<Response> {
  const body: any = await request.json();
  // Accepts single object or array for bulk add
  const items = Array.isArray(body) ? body : [body];

  const project = await env.DB.prepare(
    'SELECT id FROM projects WHERE id = ?'
  ).bind(projectId).first();

  if (!project) {
    return json({ error: 'Project not found' }, 404);
  }

  const inserted = [];
  const skipped = [];
  const rejected = [];
  for (const item of items) {
    const { application_code, quantity = 1, room_names, custom_notes } = item;
    if (!application_code) {
      rejected.push({ application_code: null, reason: 'Missing application_code' });
      continue;
    }

    // Snapshot current application data
    const app = await env.DB.prepare(
      'SELECT * FROM applications WHERE code = ?'
    ).bind(application_code).first();

    if (!app) {
      rejected.push({ application_code, reason: 'Application not found' });
      continue;
    }

    // Prevent duplicate rows for the same project/application pair
    const existing = await env.DB.prepare(
      'SELECT id FROM project_applications WHERE project_id = ? AND application_code = ?'
    ).bind(projectId, application_code).first();

    if (existing) {
      skipped.push({ application_code, reason: 'Already added to project', id: existing.id });
      continue;
    }

    const result = await env.DB.prepare(`
      INSERT INTO project_applications
        (project_id, application_code, snapshot_data, quantity, room_names, custom_notes)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(
      projectId,
      application_code,
      app ? JSON.stringify(app) : null,
      quantity,
      room_names || null,
      custom_notes || null
    ).run();

    inserted.push(result.meta.last_row_id);
  }

  const hasInserts = inserted.length > 0;
  return json({
    inserted_ids: inserted,
    skipped,
    rejected,
  }, hasInserts ? 201 : 200);
}

async function updateApplicationInProject(request: Request, env: Env, appId: string): Promise<Response> {
  const body: any = await request.json();
  const allowed = ['quantity', 'room_names', 'custom_notes',
                   'overridden', 'override_hor_lux', 'override_ver_lux',
                   'override_reason', 'sort_order'];

  const fields = Object.keys(body).filter(k => allowed.includes(k));
  if (fields.length === 0) return json({ error: 'No valid fields to update' }, 400);

  const setClauses = fields.map(f => `${f} = ?`).join(', ');
  const values = fields.map(f => body[f]);

  await env.DB.prepare(
    `UPDATE project_applications SET ${setClauses} WHERE id = ?`
  ).bind(...values, appId).run();

  const updated = await env.DB.prepare(
    'SELECT * FROM project_applications WHERE id = ?'
  ).bind(appId).first();

  return json({ application: updated });
}

async function removeApplicationFromProject(env: Env, appId: string, projectId: string): Promise<Response> {
  await env.DB.prepare(
    'DELETE FROM project_applications WHERE id = ? AND project_id = ?'
  ).bind(appId, projectId).run();
  return json({ deleted: true });
}

// ─── Export Handler ───────────────────────────────────────────────────────────

async function handleProjectExport(request: Request, env: Env, projectId: string, url: URL): Promise<Response> {
  const format = url.searchParams.get('format') || 'json';

  const projectResponse = await getProject(env, projectId);
  const projectData = await projectResponse.json() as { project?: unknown; applications?: unknown };

  if (format === 'json') {
    return json(projectData);
  }

  // PDF and Excel generation are handled client-side for MVP
  // (server-side generation deferred to Phase 2)
  return json({
    error: 'PDF and Excel export are generated client-side.',
    hint: 'Use format=json to get the raw data for client-side rendering.',
    project: projectData.project,
    applications: projectData.applications,
  }, 200);
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function withCors(response: Response): Response {
  const newHeaders = new Headers(response.headers);
  for (const [k, v] of Object.entries(CORS_HEADERS)) {
    newHeaders.set(k, v);
  }
  return new Response(response.body, {
    status: response.status,
    headers: newHeaders,
  });
}
