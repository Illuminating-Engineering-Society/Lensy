/**
 * Which standards one reader can open in the Lighting Library today
 * (2026-10-29) — the backend of the "My Standards" view on ies.org (IES HQ,
 * module frontend.standards). Server-to-server only:
 *
 *   GET /api/entitlements?email=<address>
 *   Authorization: Bearer ENTITLEMENTS_API_SECRET
 *
 * Lens is the one place where the purchase (purchases, migration 0024), the
 * staff comp (comp_access_grants scope 'documents', migrations 0020/0023) and
 * the catalogue (standards: designation, title, viewer link) meet, so the
 * answer is built here instead of WordPress re-deriving the SureCart product →
 * standard mapping. The access itself still lives in AuthIES; this endpoint
 * only reads Lens's own record of what was granted.
 *
 * READ-ONLY and its own secret on purpose: COMP_GRANTS_API_SECRET can create
 * and revoke grants, LUCIUS_API_SECRET is the whole admin surface, and neither
 * belongs on a WordPress host. Unset secret → 404, like AuthIES's comp-grants
 * API, so the route does not exist until it is configured.
 *
 * A row is listed when it is active and its window covers today (dates are
 * inclusive, compared as 'YYYY-MM-DD' strings like the session gate does).
 * Subscriptions are not listed: they open every standard, and the view is a
 * list of the individual documents a reader holds.
 */

import { bearerMatches } from '../lib/auth';
import { toLibraryUrlOrNull } from '../lib/library-url.js';

const MAX_EMAIL_LENGTH = 254;

export interface EntitledStandard {
  id: string;
  designation: string;
  title: string | null;
  source: 'purchase' | 'comp';
  startsAt: string;
  expiresAt: string;
  viewerUrl: string | null;
  thumbnailUrl: string | null;
}

interface GrantRow {
  standard_id: string;
  start_date: string;
  end_date: string;
  source: 'purchase' | 'comp';
}

export async function handleEntitlements(request: Request, env: Env, url: URL): Promise<Response> {
  if (!String(env.ENTITLEMENTS_API_SECRET || '').trim()) return json({ error: 'Not found' }, 404);
  if (!(await bearerMatches(request, env.ENTITLEMENTS_API_SECRET))) return json({ error: 'Unauthorized' }, 401);

  const email = String(url.searchParams.get('email') || '').trim().toLowerCase();
  if (!email || email.length > MAX_EMAIL_LENGTH || !/^[^\s@]+@[^\s@]+$/.test(email)) {
    return json({ error: 'invalid_email' }, 400);
  }

  try {
    const standards = await standardsForEmail(env.DB, email);
    return json({ email, standards }, 200);
  } catch (err) {
    return json({ error: `entitlements unavailable: ${err instanceof Error ? err.message : String(err)}` }, 500);
  }
}

export async function standardsForEmail(db: D1Database, email: string): Promise<EntitledStandard[]> {
  const leases = await db.prepare(`
    SELECT standard_id, start_date, end_date FROM purchases
    WHERE email = ? AND kind = 'lease' AND status = 'active' AND standard_id IS NOT NULL
      AND start_date <= date('now') AND end_date >= date('now')
  `).bind(email).all<{ standard_id: string; start_date: string; end_date: string }>();

  const comps = await db.prepare(`
    SELECT standard_ids, start_date, end_date FROM comp_access_grants
    WHERE email = ? AND scope = 'documents' AND status = 'active'
      AND start_date <= date('now') AND end_date >= date('now')
  `).bind(email).all<{ standard_ids: string; start_date: string; end_date: string }>();

  const grants: GrantRow[] = [];
  for (const row of leases.results || []) {
    grants.push({ standard_id: row.standard_id, start_date: row.start_date, end_date: row.end_date, source: 'purchase' });
  }
  for (const row of comps.results || []) {
    for (const id of parseIds(row.standard_ids)) {
      grants.push({ standard_id: id, start_date: row.start_date, end_date: row.end_date, source: 'comp' });
    }
  }
  if (grants.length === 0) return [];

  // The same standard can be held twice (a comp, then a purchase): keep the
  // grant that runs longest, which is the one the reader cares about.
  const best = new Map<string, GrantRow>();
  for (const g of grants) {
    const key = g.standard_id.toLowerCase();
    const prev = best.get(key);
    if (!prev || g.end_date > prev.end_date) best.set(key, g);
  }

  const ids = [...best.values()].map(g => g.standard_id);
  const catalog = await db.prepare(`
    SELECT id, full_designation, title, vitrium_web_url, thumbnail_url FROM standards
    WHERE id COLLATE NOCASE IN (${ids.map(() => '?').join(', ')})
  `).bind(...ids).all<Record<string, unknown>>();
  const byId = new Map<string, Record<string, unknown>>();
  for (const row of catalog.results || []) byId.set(String(row.id).toLowerCase(), row);

  const out: EntitledStandard[] = [];
  for (const [key, g] of best) {
    const row = byId.get(key);
    const id = row ? String(row.id) : g.standard_id;
    const designation = row && typeof row.full_designation === 'string' && row.full_designation ? row.full_designation : `ANSI/IES ${id}`;
    const title = row && typeof row.title === 'string' && row.title && row.title !== id ? row.title : null;
    out.push({
      id,
      designation,
      title,
      source: g.source,
      startsAt: g.start_date,
      expiresAt: g.end_date,
      viewerUrl: row ? toLibraryUrlOrNull(row.vitrium_web_url) : null,
      thumbnailUrl: row && typeof row.thumbnail_url === 'string' && row.thumbnail_url ? row.thumbnail_url : null,
    });
  }
  out.sort((a, b) => a.designation.localeCompare(b.designation));
  return out;
}

function parseIds(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string' && v.trim() !== '').map(v => v.trim()) : [];
  } catch {
    return [];
  }
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
