/**
 * Lucius API — Main Router
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

import { handleSearch } from './search.js';
import { handleIngest } from './ingest.js';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export default {
  async fetch(request, env, ctx) {
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // ── Search ──────────────────────────────────────────────────────────────
      if (path === '/api/search' && request.method === 'POST') {
        return withCors(await handleSearch(request, env));
      }

      // ── Ingest (internal/admin only) ─────────────────────────────────────
      if (path.startsWith('/api/ingest') && request.method === 'POST') {
        return withCors(await handleIngest(request, env));
      }

      // ── Applications ─────────────────────────────────────────────────────
      if (path.startsWith('/api/applications')) {
        return withCors(await handleApplications(request, env, url));
      }

      // ── Standards ────────────────────────────────────────────────────────
      if (path.startsWith('/api/standards')) {
        return withCors(await handleStandards(request, env, url));
      }

      // ── Projects ─────────────────────────────────────────────────────────
      if (path.startsWith('/api/projects')) {
        return withCors(await handleProjects(request, env, url));
      }

      return withCors(json({ error: 'Not found' }, 404));
    } catch (err) {
      console.error('API error:', err);
      return withCors(json({ error: 'Internal server error', detail: err.message }, 500));
    }
  },
};

// ─── Applications Handlers ────────────────────────────────────────────────────

async function handleApplications(request, env, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', 'applications', ':code']
  const code = parts[2];

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

async function handleStandards(request, env, url) {
  const parts = url.pathname.split('/').filter(Boolean);
  const id = parts[2];

  if (!id) {
    // GET /api/standards — list all
    const result = await env.DB.prepare(
      "SELECT id, title, full_designation, year, status FROM standards ORDER BY id"
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

async function handleProjects(request, env, url) {
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

async function listProjects(request, env, url) {
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

async function getProject(env, projectId) {
  const project = await env.DB.prepare(
    'SELECT * FROM projects WHERE id = ?'
  ).bind(projectId).first();

  if (!project) return json({ error: 'Project not found' }, 404);

  const applications = await env.DB.prepare(`
    SELECT pa.*, a.App, a.App_s1, a.App_s2, a.Standard, a.Standard_Full,
           a.Hor_Lux, a.Hor_Fc, a.Ver_Lux, a.Ver_Fc, a.Indoor_Outdoor
    FROM project_applications pa
    LEFT JOIN applications a ON pa.application_code = a.code
    WHERE pa.project_id = ?
    ORDER BY pa.sort_order, pa.added_at
  `).bind(projectId).all();

  return json({ project, applications: applications.results });
}

async function createProject(request, env) {
  const body = await request.json();
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

async function updateProject(request, env, projectId) {
  const body = await request.json();
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

async function deleteProject(env, projectId) {
  const project = await env.DB.prepare(
    'SELECT id FROM projects WHERE id = ?'
  ).bind(projectId).first();

  if (!project) return json({ error: 'Project not found' }, 404);

  // ON DELETE CASCADE handles project_applications
  await env.DB.prepare('DELETE FROM projects WHERE id = ?').bind(projectId).run();
  return json({ deleted: true });
}

// ─── Project Applications Sub-resource ───────────────────────────────────────

async function handleProjectApplications(request, env, url, projectId, appId) {
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

async function addApplicationToProject(request, env, projectId) {
  const body = await request.json();
  // Accepts single object or array for bulk add
  const items = Array.isArray(body) ? body : [body];

  const inserted = [];
  for (const item of items) {
    const { application_code, quantity = 1, room_names, custom_notes } = item;
    if (!application_code) continue;

    // Snapshot current application data
    const app = await env.DB.prepare(
      'SELECT * FROM applications WHERE code = ?'
    ).bind(application_code).first();

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

  return json({ inserted_ids: inserted }, 201);
}

async function updateApplicationInProject(request, env, appId) {
  const body = await request.json();
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

async function removeApplicationFromProject(env, appId, projectId) {
  await env.DB.prepare(
    'DELETE FROM project_applications WHERE id = ? AND project_id = ?'
  ).bind(appId, projectId).run();
  return json({ deleted: true });
}

// ─── Export Handler ───────────────────────────────────────────────────────────

async function handleProjectExport(request, env, projectId, url) {
  const format = url.searchParams.get('format') || 'json';

  const projectResponse = await getProject(env, projectId);
  const projectData = await projectResponse.json();

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

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function withCors(response) {
  const newHeaders = new Headers(response.headers);
  for (const [k, v] of Object.entries(CORS_HEADERS)) {
    newHeaders.set(k, v);
  }
  return new Response(response.body, {
    status: response.status,
    headers: newHeaders,
  });
}
