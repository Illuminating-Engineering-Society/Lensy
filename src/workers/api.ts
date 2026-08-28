/**
 * Lensy API — Main Router
 * Cloudflare Worker entry point. Routes all /api/* requests.
 *
 * Endpoints:
 *   POST /api/search
 *   POST /api/events
 *   GET  /api/preferences
 *   PUT  /api/preferences
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
 *   POST   /api/projects/saved-status
 *
 *   GET    /api/projects/:id/export
 */

import { handleSearch } from './search';
import { handleIngest } from './ingest';
import { handleAdminScanOrphans, handleAdminEnumerateIds, handleAdminDeleteOrphans, handleAdminFlushCache, handleAdminSearchLog, handleAdminSearchEvents, handleAdminR2Multipart, handleAdminIndexStatus } from './admin';
import { handleEvent } from './events';
import { handlePreferences } from './preferences';
import { handleAdminUsers } from './users';
import { handleAuthMe, handleDevLogin, requireReadAccess, requireCorpusAccess } from './session';
import { buildLoginUrl, buildLogoutUrl } from '../lib/sso';
import {
  normalizeSavedItem, savedItemCodes, newShareToken, CSV_COLUMNS, csvCell, csvRowFor,
} from '../lib/collections.js';
import { resolveCommittee } from '../lib/committees.js';
import { outlineFromSectionMap } from '../lib/section-titles.js';
import type { OutlineEntry } from '../types';
import { toLibraryUrlOrNull } from '../lib/library-url.js';
import { sendCollectionShareEmail, isEmailAddress, resolveAppUrl } from '../lib/email';

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

      // ── Search (an SSO session or the staff bearer, AND a tier above
      //    'none' — the door itself no longer turns anyone away) ────────────
      if (path === '/api/search' && request.method === 'POST') {
        const denied = await requireCorpusAccess(request, env);
        if (denied) return withCors(denied);
        return withCors(await handleSearch(request, env, ctx));
      }

      // ── Per-account UI preferences (client DO080) ─────────────────────────
      // The AI Guide toggle is saved to the account, not the browser. Same
      // session gate as search; fails soft when there is no session.
      if (path === '/api/preferences' && (request.method === 'GET' || request.method === 'PUT')) {
        const denied = await requireReadAccess(request, env);
        if (denied) return withCors(denied);
        return withCors(await handlePreferences(request, env));
      }

      // ── Anonymous interaction log (client DO078) ──────────────────────────
      // Which card a reader opened first, and what they narrowed to afterwards.
      // Carries no user identity by design — see migrations/0013.
      if (path === '/api/events' && request.method === 'POST') {
        return withCors(await handleEvent(request, env));
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
      if (path === '/api/admin/search-events.csv' && request.method === 'GET') {
        return withCors(await handleAdminSearchEvents(request, env));
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

      // ── Reading ONE shared collection needs no session (client DO52) ──────
      // "If a 'saved search' link is shared and opened by a non-subscriber, can
      //  we allow anyone to … view the saved search?"
      //
      // Deliberately narrow: this exact route, GET only. The token is 16 random
      // bytes, and a collection holds citations, links and the reader's own
      // notes — never excerpt text or illuminance values (src/lib/collections.js
      // enforces that at save time), so the link discloses references, which is
      // the point of sharing it. Claiming it into an account still needs a
      // session, and so does everything else under /api/projects.
      const isPublicSharedRead =
        request.method === 'GET' && /^\/api\/projects\/shared\/[^/]+$/.test(path);

      // ── Applications / Standards / Projects (same session gate as search) ─
      if (
        !isPublicSharedRead && (
          path.startsWith('/api/applications') ||
          path.startsWith('/api/standards') ||
          path.startsWith('/api/projects')
        )
      ) {
        const denied = await requireReadAccess(request, env);
        if (denied) return withCors(denied);
      }

      if (path.startsWith('/api/applications')) {
        // The raw illuminance dataset — this IS the Illuminance Tables content,
        // which LensyLite excludes and a 'none' visitor has no claim to. No
        // page in src/frontend calls it, so gating it to 'full' costs the UI
        // nothing; without this it was a way around the tables block.
        const denied = await requireCorpusAccess(request, env, 'full');
        if (denied) return withCors(denied);
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

// ─── Collection helpers (client DO37) ─────────────────────────────────────────

// Imported at the bottom of the import list to keep the diff readable; see
// src/lib/collections.js for the no-contents rule these enforce.

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

/** standards.elearning_json → [{ title, url }], tolerating a malformed value. */
function parseElearning(raw: unknown): Array<{ title: string; url: string }> {
  if (typeof raw !== 'string' || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((e): e is { title?: string; url?: string } => !!e && typeof e === 'object')
      .filter(e => typeof e.url === 'string' && /^https?:\/\//i.test(e.url))
      .map(e => ({ title: String(e.title || e.url), url: String(e.url) }));
  } catch {
    return [];
  }
}

/** standards.outline_json → the table of contents, or [] (client DO082). */
function parseOutline(raw: string | null | undefined): OutlineEntry[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((e): e is OutlineEntry => !!e && typeof e === 'object'
        && typeof e.number === 'string' && typeof e.title === 'string')
      .map(e => ({
        number: e.number,
        title: e.title,
        page: typeof e.page === 'number' ? e.page : null,
      }));
  } catch {
    return [];
  }
}

/** A JSON column that should hold an object, or {}. */
function parseJsonObject(raw: string | null | undefined): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
  } catch {
    return {};
  }
}

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
    // The extra columns feed the Table of Contents (client DO35): collection
    // grouping, cover thumbnail, description, authoring committee, Read/Buy and
    // the staff-curated eLearning links. All optional — they arrive from the
    // Vitrium/webstore export and are simply null until it carries them.
    const result = await env.DB.prepare(
      'SELECT id, title, full_designation, year, status, vitrium_web_url, page_count,' +
      ' description, author, collection, thumbnail_url, buy_url, elearning_json' +
      ` FROM standards${where} ORDER BY id`
    ).all<Record<string, any>>();

    // Resolve the committee here rather than in the browser, so the ToC and the
    // result cards credit and link it identically (DO34).
    const standards = (result.results || []).map(s => ({
      ...s,
      // The "Read" link opens the branded Library host, not Vitrium's own —
      // see src/lib/library-url.js.
      vitrium_web_url: toLibraryUrlOrNull(s.vitrium_web_url),
      committee: resolveCommittee(s.author),
      elearning: parseElearning(s.elearning_json),
    }));
    return json({ standards });
  }

  // GET /api/standards/:id
  const standard = await env.DB.prepare(
    'SELECT * FROM standards WHERE id = ?'
  ).bind(id).first<Record<string, any>>();

  if (!standard) return json({ error: 'Standard not found' }, 404);

  // ── GET /api/standards/:id/outline — the table of contents (client DO082) ──
  // "Provide easy access to TOC for each document … even if the user is on
  //  LensyLite (non-subscriber)." So it is gated on a SESSION (requireReadAccess,
  //  applied by the router) but not on a corpus tier: a table of contents is
  //  metadata about a document, not the document.
  //
  // Two sources, in order: the indexed outline, which carries page numbers and
  // therefore links; and — for a standard ingested before migration 0015 — the
  // section-title map, which gives the same headings without pages. Saying WHICH
  // is what lets the page explain why the links are missing.
  if (decodePathSegment(parts[3]) === 'outline') {
    const indexed = parseOutline(standard.outline_json);
    const outline = indexed.length > 0
      ? indexed
      : outlineFromSectionMap(parseJsonObject(standard.sections_json));
    const libraryUrl = toLibraryUrlOrNull(standard.vitrium_web_url);
    return json({
      standard: {
        id: standard.id,
        designation: standard.full_designation || `ANSI/IES ${standard.id}`,
        title: standard.title && standard.title !== standard.id ? standard.title : null,
        page_count: standard.page_count ?? null,
        library_url: libraryUrl,
      },
      source: indexed.length > 0 ? 'index' : (outline.length > 0 ? 'sections' : 'none'),
      outline: outline.map(e => ({
        ...e,
        // A page-targeted link, so a TOC entry opens where it points.
        url: (libraryUrl && e.page != null) ? `${libraryUrl}#page=${e.page}` : null,
      })),
    });
  }
  return json({
    standard: { ...standard, vitrium_web_url: toLibraryUrlOrNull(standard.vitrium_web_url) },
  });
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
  // Which results are already saved (client DO61). Matched before the CRUD
  // switch below, which would otherwise read "saved-status" as a collection id.
  if (projectId === 'saved-status') {
    if (request.method === 'POST') return savedStatus(request, env);
    return json({ error: 'Method not allowed' }, 405);
  }
  // Saved Search Collections (client DO37)
  if (projectId && subResource === 'csv' && request.method === 'GET') {
    return exportCollectionCsv(env, projectId);
  }
  if (projectId && subResource === 'share' && request.method === 'POST') {
    return shareCollection(env, projectId);
  }
  if (projectId && subResource === 'email' && request.method === 'POST') {
    return emailCollection(request, env, projectId);
  }
  // /api/projects/shared/:token  and  /api/projects/shared/:token/claim
  if (projectId === 'shared' && subResource) {
    const token = subResource;
    if (appId === 'claim' && request.method === 'POST') return claimSharedCollection(request, env, token);
    if (!appId && request.method === 'GET') return getSharedCollection(env, token);
    return json({ error: 'Not found' }, 404);
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
  const applications = (rows.results || []).map(rawRow => {
    // Saved links open the branded Library host whenever they were filed
    // (src/lib/library-url.js).
    const row: Record<string, any> = { ...rawRow, library_url: toLibraryUrlOrNull(rawRow.library_url) };
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
    project_type, collection_type, designer_name, designer_company, target_codes, notes
  } = body;

  if (!name) return json({ error: 'Project name is required' }, 400);

  const result = await env.DB.prepare(`
    INSERT INTO projects
      (user_id, name, location, client_name, client_company, project_type,
       collection_type, designer_name, designer_company, target_codes, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    user_id, name, location || null, client_name || null, client_company || null,
    // project_type is CHECK-constrained to four construction categories;
    // collection_type is the free-text field that supports the user-definable
    // "Other" (client DO37) and is what the UI reads back.
    project_type || null, collection_type || project_type || null,
    designer_name || null, designer_company || null,
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

// ─── Saved Search Collections: share, claim, CSV (client DO37) ───────────────

/** The saved items of one collection, in display order. */
async function collectionItems(env: Env, projectId: string) {
  const rows = await env.DB.prepare(`
    SELECT id, application_code, result_type, standard_id, resource_title, page_number,
           library_url, application_name, reference_text, custom_notes, added_at
    FROM project_applications
    WHERE project_id = ?
    ORDER BY sort_order, added_at
  `).bind(projectId).all<Record<string, any>>();
  // Rows saved before the branded-host rewrite still hold a view.protectedpdf.com
  // link; correcting on read fixes them everywhere a saved item is shown — the
  // collection view, the CSV export, the share email and a claimed copy — with
  // no data migration.
  return (rows.results || []).map((r): Record<string, any> =>
    ({ ...r, library_url: toLibraryUrlOrNull(r.library_url) }));
}

/**
 * Mint (or reuse) the share token for a collection.
 *
 * The link COPIES the collection into the recipient's account rather than giving
 * access to this one — so the token is a claim ticket, not a capability on the
 * owner's data, and re-sharing the same collection reuses the token so previously
 * sent links keep working.
 */
async function shareCollection(env: Env, projectId: string): Promise<Response> {
  const project = await env.DB.prepare('SELECT id, share_token FROM projects WHERE id = ?')
    .bind(projectId).first<{ id: number; share_token: string | null }>();
  if (!project) return json({ error: 'Collection not found' }, 404);

  let token = project.share_token;
  if (!token) {
    token = newShareToken();
    await env.DB.prepare('UPDATE projects SET share_token = ? WHERE id = ?').bind(token, projectId).run();
  }
  return json({ share_token: token, path: `/collection.html?share=${token}` });
}

/**
 * Email a Saved Search Collection from Lensy itself (client DO37).
 *
 * The mail carries the citations, the per-item Library links, a "Save Search to
 * My Lensy" button and the subscribe/purchase prompts — the template is in
 * src/lib/email.ts and reprints no excerpt text, which is structural rather than
 * enforced here: a saved item holds none (see normalizeSavedItem).
 *
 * Sharing is implied by emailing: the claim button needs a token, so one is
 * minted if the collection has none — exactly what POST .../share does, reused
 * rather than requiring the caller to make two round-trips in the right order.
 *
 * Fails soft in the same shape as the invitation path: a send failure returns
 * `{ sent: false, error }` with HTTP 200 and the share link, so the UI can offer
 * the link (or the user's own mail client) instead of showing a dead end. The
 * `E_*` code is passed through — it is the difference between "onboard the
 * domain", "this address bounced before" and "retry later".
 */
async function emailCollection(request: Request, env: Env, projectId: string): Promise<Response> {
  const body: any = await request.json().catch(() => ({}));
  const to = typeof body?.to === 'string' ? body.to.trim() : '';
  if (!isEmailAddress(to)) {
    return json({ error: 'A valid recipient email address is required.' }, 400);
  }

  const collection = await env.DB.prepare('SELECT * FROM projects WHERE id = ?')
    .bind(projectId).first<Record<string, any>>();
  if (!collection) return json({ error: 'Collection not found' }, 404);

  let token = collection.share_token as string | null;
  if (!token) {
    token = newShareToken();
    await env.DB.prepare('UPDATE projects SET share_token = ? WHERE id = ?').bind(token, projectId).run();
  }

  const appUrl = resolveAppUrl(request, env);
  const outcome = await sendCollectionShareEmail(env, {
    to,
    senderName: typeof body?.sender_name === 'string' ? body.sender_name.trim() || null : null,
    message: typeof body?.message === 'string' ? body.message.trim() || null : null,
    collection,
    items: await collectionItems(env, projectId),
    claimUrl: `${appUrl}/projects.html?share=${token}`,
    appUrl,
  });

  return json({ ...outcome, to, share_token: token, path: `/projects.html?share=${token}` });
}

/** Read a shared collection by token — the recipient's preview before claiming. */
async function getSharedCollection(env: Env, token: string): Promise<Response> {
  const project = await env.DB.prepare('SELECT * FROM projects WHERE share_token = ?')
    .bind(token).first<Record<string, any>>();
  if (!project) return json({ error: 'This share link is not valid.' }, 404);
  if (project.share_expires_at && new Date(project.share_expires_at) < new Date()) {
    return json({ error: 'This share link has expired.' }, 410);
  }
  return json({ collection: project, applications: await collectionItems(env, String(project.id)), shared: true });
}

/**
 * Copy a shared collection into the caller's own account (client DO37: "load
 * their saved search collection into their account").
 *
 * A copy, not a grant: the recipient owns the result outright and neither side
 * can edit the other's. The source is left untouched, and the copy gets no share
 * token of its own until the new owner shares it.
 */
async function claimSharedCollection(request: Request, env: Env, token: string): Promise<Response> {
  const body: any = await request.json().catch(() => ({}));
  const userId = body?.user_id ?? 1;

  const source = await env.DB.prepare('SELECT * FROM projects WHERE share_token = ?')
    .bind(token).first<Record<string, any>>();
  if (!source) return json({ error: 'This share link is not valid.' }, 404);

  const created = await env.DB.prepare(`
    INSERT INTO projects (user_id, name, location, client_name, client_company,
                          collection_type, designer_name, designer_company, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    userId, source.name, source.location, source.client_name, source.client_company,
    source.collection_type || source.project_type, source.designer_name,
    source.designer_company, source.notes,
  ).run();
  const newId = created.meta.last_row_id;

  const items = await collectionItems(env, String(source.id));
  for (const it of items) {
    await env.DB.prepare(`
      INSERT INTO project_applications
        (project_id, application_code, custom_notes, result_type, standard_id,
         resource_title, page_number, library_url, application_name, reference_text)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      newId, it.application_code, it.custom_notes, it.result_type, it.standard_id,
      it.resource_title, it.page_number, it.library_url, it.application_name, it.reference_text,
    ).run();
  }

  return json({ collection_id: newId, items: items.length }, 201);
}

/** CSV export in the column order the client specified (DO37). */
async function exportCollectionCsv(env: Env, projectId: string): Promise<Response> {
  const collection = await env.DB.prepare('SELECT * FROM projects WHERE id = ?')
    .bind(projectId).first<Record<string, any>>();
  if (!collection) return json({ error: 'Collection not found' }, 404);

  const items = await collectionItems(env, projectId);
  const header = CSV_COLUMNS.map(([, label]) => csvCell(label)).join(',');
  const rows = items.map(it => csvRowFor(it, collection).join(','));
  const csv = [header, ...rows].join('\r\n');

  // A filename derived from the topic, reduced to characters safe in a
  // Content-Disposition header on every OS.
  const slug = String(collection.name || 'collection').replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 60);
  return new Response(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${slug}-saved-searches.csv"`,
    },
  });
}

// ─── Saved Search items (client DO37) ────────────────────────────────────────

/**
 * Save one search result of ANY kind into a collection.
 *
 * The reference data is normalized (and the no-contents rule enforced) in
 * src/lib/collections.js: a saved item carries the citation, the page and the
 * Library link, plus the application name for illuminance rows and the entry text
 * for references — nothing else from the card.
 */
async function saveSearchItem(env: Env, projectId: string, raw: any): Promise<{
  inserted?: number; skipped?: { reason: string; code: string; id?: unknown }; rejected?: { reason: string; code: string | null };
}> {
  const parsed = normalizeSavedItem(raw);
  if (!parsed.ok) {
    return { rejected: { reason: parsed.reason, code: raw?.application_code || null } };
  }
  const item = parsed.item;

  // One row per (collection, item) — saving the same passage twice is a no-op.
  const existing = await env.DB.prepare(
    'SELECT id FROM project_applications WHERE project_id = ? AND application_code = ?'
  ).bind(projectId, item.application_code).first<{ id: number }>();
  if (existing) {
    return { skipped: { reason: 'Already saved to this collection', code: item.application_code, id: existing.id } };
  }

  // Illuminance-table items keep their 68-column snapshot: it is what makes a
  // saved row survive a re-ingest that renumbers application codes (see
  // getProject). The other kinds have no application row to snapshot.
  let snapshot: string | null = null;
  if (item.result_type === 'tables' && !item.application_code.startsWith('excerpt:')) {
    const app = await env.DB.prepare('SELECT * FROM applications WHERE code = ?')
      .bind(item.application_code).first();
    if (app) snapshot = JSON.stringify(app);
  }

  const result = await env.DB.prepare(`
    INSERT INTO project_applications
      (project_id, application_code, snapshot_data, custom_notes,
       result_type, standard_id, resource_title, page_number, library_url,
       application_name, reference_text)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    projectId, item.application_code, snapshot, item.custom_notes,
    item.result_type, item.standard_id, item.resource_title, item.page_number,
    item.library_url, item.application_name, item.reference_text,
  ).run();

  return { inserted: result.meta.last_row_id as number };
}

/**
 * POST /api/projects/saved-status — which of these results is already in one of
 * the user's collections (client DO61).
 *
 * "If that exact passage has already been saved to a search collection, change
 *  button text to '+ Save Again' … Goal: help users remember whether they have
 *  already 'saved' a particular search."
 *
 * "That exact passage" is decided by the SAME function that de-duplicates a save
 * (normalizeSavedItem → syntheticItemCode), so the button can never disagree with
 * what the save endpoint would do. Answers across every collection the user owns,
 * archived ones included: the question is whether they have filed this before,
 * not where.
 *
 * Read-only, and it returns one boolean per item and nothing else — no titles, no
 * collection names, no ids.
 */
async function savedStatus(request: Request, env: Env): Promise<Response> {
  let body: any;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const rawItems = Array.isArray(body?.items) ? body.items : [];
  // One search page is 50 results (POOL_SIZE); the cap keeps this inside D1's
  // bound-parameter budget with room to spare rather than trusting the caller.
  const MAX_ITEMS = 90;
  if (rawItems.length === 0) return json({ saved: [] });
  if (rawItems.length > MAX_ITEMS) {
    return json({ error: `At most ${MAX_ITEMS} items per request` }, 400);
  }

  // Phase 1 user identity, as everywhere else under /api/projects.
  const userId = body?.user_id != null ? String(body.user_id) : '1';

  // null for an item that is not saveable at all — it can never be saved, so it
  // can never be already-saved.
  const codes: (string | null)[] = savedItemCodes(rawItems);

  const lookup = [...new Set(codes.filter((c): c is string => !!c))];
  if (lookup.length === 0) return json({ saved: codes.map(() => false) });

  const placeholders = lookup.map(() => '?').join(',');
  const rows = await env.DB.prepare(`
    SELECT DISTINCT pa.application_code
    FROM project_applications pa
    JOIN projects p ON p.id = pa.project_id
    WHERE p.user_id = ? AND pa.application_code IN (${placeholders})
  `).bind(userId, ...lookup).all<{ application_code: string }>();

  const saved = new Set((rows.results || []).map(r => r.application_code));
  return json({ saved: codes.map(code => !!code && saved.has(code)) });
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
    // A collection now holds all four result kinds (client DO37), not just
    // illuminance-table rows. An item carrying result_type takes the saved-search
    // path; a bare { application_code } keeps the original behaviour so anything
    // already calling this endpoint is unaffected.
    if (item?.result_type) {
      const outcome = await saveSearchItem(env, projectId, item);
      if (outcome.inserted != null) inserted.push(outcome.inserted);
      else if (outcome.skipped) skipped.push(outcome.skipped);
      else rejected.push(outcome.rejected);
      continue;
    }

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
