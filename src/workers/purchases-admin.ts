/**
 * The staff view of SureCart purchases (2026-10-26) — the backend of
 * /admin#purchases. Same contract as the comp-access queue: every endpoint
 * sits behind the admin gate, the list fails soft when migration 0024 has
 * not been applied, and every action that touches access goes through the
 * one reconcile (workers/surecart.ts) so a staff click and a webhook can
 * never disagree about what AuthIES holds.
 *
 *   GET   /api/admin/purchases            list  ?status= &q= &pending=1 &limit=
 *   GET   /api/admin/purchases.csv        export
 *   POST  /api/admin/purchases/sync       { purchase_id }      forced resync of ONE SureCart purchase
 *   POST  /api/admin/purchases/import     { page, limit? }     one SureCart page, each purchase synced (never forced)
 *   PATCH /api/admin/purchases/:id        { status: 'revoked', by? } | { status: 'active' } | { retry: true }
 */

import { requireAdminAccess } from './session';
import { csvCell } from '../lib/collections.js';
import { listPurchases, findPurchaseById, setPurchaseStatus, stampAuthies, type PurchaseRow } from '../lib/purchases';
import { revokePurchaseGrant } from '../lib/comp-grants';
import { listPurchases as listSurecartPurchases, surecartConfigured } from '../lib/surecart-api';
import { syncPurchaseById, type SyncResult } from './surecart';
import { toLibraryUrlOrNull } from '../lib/library-url.js';

const LIST_LIMIT_DEFAULT = 500;
const LIST_LIMIT_MAX = 2000;
const IMPORT_PAGE_DEFAULT = 100;

export type EffectivePurchaseStatus = 'active' | 'revoked' | 'ignored' | 'expired';

/** `expired` is derived at read time, like comp grants; the row stays 'active'. */
export function effectivePurchaseStatus(
  row: { status: string; end_date: string },
  today: string,
): EffectivePurchaseStatus {
  if (row.status === 'revoked') return 'revoked';
  if (row.status === 'ignored') return 'ignored';
  return row.end_date && row.end_date < today ? 'expired' : 'active';
}

export async function handleAdminPurchases(request: Request, env: Env, url: URL): Promise<Response> {
  const denied = await requireAdminAccess(request, env);
  if (denied) return denied;

  const parts = url.pathname.split('/').filter(Boolean); // ['api','admin','purchases',':id'|'sync'|'import']
  const tail = parts[3];

  try {
    if (request.method === 'GET' && !tail) return await listView(env, url);
    if (request.method === 'POST' && tail === 'sync') return await syncOne(request, env);
    if (request.method === 'POST' && tail === 'import') return await importPage(request, env);
    if (request.method === 'PATCH' && tail) return await patchOne(request, env, tail);
  } catch (err) {
    return json({ error: `purchases unavailable: ${errMsg(err)}` }, 500);
  }
  return json({ error: 'Not found' }, 404);
}

// ── list ────────────────────────────────────────────────────────────────────

interface CatalogEntry { id: string; designation: string; title: string | null; libraryUrl: string | null }

async function loadCatalog(db: D1Database): Promise<Map<string, CatalogEntry>> {
  const res = await db.prepare('SELECT id, full_designation, title, vitrium_web_url FROM standards').all<Record<string, unknown>>();
  const map = new Map<string, CatalogEntry>();
  for (const row of res.results || []) {
    const id = String(row.id);
    map.set(id.toLowerCase(), {
      id,
      designation: typeof row.full_designation === 'string' && row.full_designation ? row.full_designation : `ANSI/IES ${id}`,
      title: typeof row.title === 'string' && row.title && row.title !== id ? row.title : null,
      libraryUrl: toLibraryUrlOrNull(row.vitrium_web_url),
    });
  }
  return map;
}

function shape(row: PurchaseRow, catalog: Map<string, CatalogEntry>, today: string) {
  const standard = row.standard_id ? catalog.get(row.standard_id.toLowerCase()) ?? null : null;
  return {
    ...row,
    standard: standard
      ? { id: standard.id, designation: standard.designation, title: standard.title, libraryUrl: standard.libraryUrl }
      : null,
    effective_status: effectivePurchaseStatus(row, today),
  };
}

async function listView(env: Env, url: URL): Promise<Response> {
  const statusFilter = (url.searchParams.get('status') || '').trim().toLowerCase();
  const pendingOnly = url.searchParams.get('pending') === '1';
  const q = (url.searchParams.get('q') || '').trim().toLowerCase();
  const limit = Math.min(LIST_LIMIT_MAX, Math.max(1, parseInt(url.searchParams.get('limit') || '', 10) || LIST_LIMIT_DEFAULT));

  let rows: PurchaseRow[] = [];
  let catalog = new Map<string, CatalogEntry>();
  let note: string | undefined;
  try {
    [rows, catalog] = await Promise.all([listPurchases(env.DB, limit), loadCatalog(env.DB)]);
  } catch (err) {
    note = `purchases unavailable (migration 0024 applied?): ${errMsg(err)}`;
  }

  const today = todayUtc();
  const purchases = rows.map(r => shape(r, catalog, today));
  const counts = { all: purchases.length, active: 0, revoked: 0, ignored: 0, expired: 0, unmapped: 0, pendingAuthies: 0 };
  for (const p of purchases) {
    counts[p.effective_status]++;
    if (p.kind === 'unmapped') counts.unmapped++;
    if (p.effective_status === 'active' && !p.authies_applied_at) counts.pendingAuthies++;
  }

  let visible = purchases;
  if (statusFilter && statusFilter !== 'all') {
    visible = statusFilter === 'unmapped'
      ? visible.filter(p => p.kind === 'unmapped')
      : visible.filter(p => p.effective_status === statusFilter);
  }
  if (pendingOnly) visible = visible.filter(p => p.effective_status === 'active' && !p.authies_applied_at);
  if (q) {
    visible = visible.filter(p =>
      [p.email, p.name, p.product_name, p.product_sku, p.standard_id, p.surecart_purchase_id, p.surecart_order_number, p.authies_error]
        .some(f => f && String(f).toLowerCase().includes(q)));
  }
  return json(note ? { purchases: visible, counts, note } : { purchases: visible, counts });
}

// ── actions ─────────────────────────────────────────────────────────────────

async function readBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const b = await request.json();
    return b && typeof b === 'object' && !Array.isArray(b) ? (b as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function syncResponse(r: SyncResult): Response {
  if (!r.ok) return json({ ok: false, error: r.error, retryable: r.retryable }, r.retryable ? 502 : 409);
  return json({ ok: true, action: r.action, purchase: r.row });
}

/** POST /api/admin/purchases/sync { purchase_id } — read it back from SureCart and re-apply, whatever the row says. */
async function syncOne(request: Request, env: Env): Promise<Response> {
  const body = await readBody(request);
  const id = typeof body.purchase_id === 'string' ? body.purchase_id.trim() : '';
  if (!id) return json({ error: 'purchase_id required (the SureCart purchase id)' }, 400);
  return syncResponse(await syncPurchaseById(env, request.url, id, { eventType: 'admin.sync', force: true }));
}

/**
 * POST /api/admin/purchases/import { page, limit? } — one page of SureCart's
 * purchase list, each synced the ordinary (non-forced) way, so a purchase
 * already recorded costs one SureCart read and no AuthIES call. The caller
 * walks pages while `hasMore`; purchases from before the webhook existed are
 * how this gets used.
 */
async function importPage(request: Request, env: Env): Promise<Response> {
  if (!surecartConfigured(env)) return json({ error: 'SURECART_API_KEY is not set — set it with `wrangler secret put SURECART_API_KEY`.' }, 409);
  const body = await readBody(request);
  const page = Math.max(1, Math.floor(Number(body.page) || 1));
  const limit = Math.min(100, Math.max(1, Math.floor(Number(body.limit) || IMPORT_PAGE_DEFAULT)));
  const listed = await listSurecartPurchases(env, page, limit);
  if (!listed.ok) return json({ error: listed.error }, 502);

  const errors: { purchase: string; error: string }[] = [];
  const actions: Record<string, number> = {};
  for (const p of listed.purchases) {
    const r = await syncPurchaseById(env, request.url, p.id, { eventType: 'admin.import' });
    if (r.ok) actions[r.action] = (actions[r.action] || 0) + 1;
    else errors.push({ purchase: p.id, error: r.error });
  }
  return json({ page, limit, processed: listed.purchases.length, skipped: listed.skipped, hasMore: listed.hasMore, actions, errors });
}

/**
 * PATCH /api/admin/purchases/:id
 *   { status: 'revoked', by? }  staff revoke: the row is marked revoked/staff
 *                               and the AuthIES grant withdrawn. Later SureCart
 *                               events leave it revoked (workers/surecart.ts).
 *   { status: 'active' }        reinstate: a forced resync — SureCart's copy
 *                               decides; a purchase SureCart itself revoked
 *                               comes back revoked/surecart.
 *   { retry: true }             re-apply: the same forced resync.
 */
async function patchOne(request: Request, env: Env, rawId: string): Promise<Response> {
  const id = parseInt(rawId, 10);
  if (!Number.isFinite(id) || id <= 0) return json({ error: 'Purchase id required' }, 400);
  const row = await findPurchaseById(env.DB, id);
  if (!row) return json({ error: 'Purchase not found' }, 404);
  const body = await readBody(request);

  if (body.status === 'revoked') {
    await setPurchaseStatus(env.DB, row.id, 'revoked', 'staff');
    let authies: { ok: true } | { ok: false; error: string } = { ok: true };
    if (row.authies_applied_at) {
      authies = await revokePurchaseGrant(env, request.url, row.surecart_purchase_id, row.email);
      await stampAuthies(env.DB, row.id, authies);
    }
    return json({ ok: true, action: 'revoked', authies, by: typeof body.by === 'string' ? body.by : null });
  }
  if (body.status === 'active' || body.retry === true) {
    return syncResponse(await syncPurchaseById(env, request.url, row.surecart_purchase_id, {
      eventType: body.retry === true ? 'admin.retry' : 'admin.reinstate', force: true,
    }));
  }
  return json({ error: 'Nothing to do: send {status: "revoked"|"active"} or {retry: true}' }, 400);
}

// ── CSV ─────────────────────────────────────────────────────────────────────

const CSV_COLUMNS = [
  'email', 'name', 'kind', 'standard', 'standard_id', 'start_date', 'end_date', 'effective_status', 'revoked_reason',
  'product_name', 'product_sku', 'surecart_purchase_id', 'surecart_order_number', 'surecart_subscription_id', 'live_mode',
  'authies_applied_at', 'authies_error', 'notify_sent_at', 'notify_error', 'last_event_type', 'last_event_at', 'created_at',
];

export async function handleAdminPurchasesCsv(request: Request, env: Env): Promise<Response> {
  const denied = await requireAdminAccess(request, env);
  if (denied) return denied;

  const url = new URL(request.url);
  const statusFilter = (url.searchParams.get('status') || '').trim().toLowerCase();
  const limit = Math.min(50000, Math.max(1, parseInt(url.searchParams.get('limit') || '10000', 10) || 10000));

  let rows: PurchaseRow[] = [];
  let catalog = new Map<string, CatalogEntry>();
  try {
    [rows, catalog] = await Promise.all([listPurchases(env.DB, limit), loadCatalog(env.DB)]);
  } catch (err) {
    // Migration 0024 not applied — an empty export is a truer answer than a 500.
    console.error('purchases export failed (non-fatal):', errMsg(err));
  }

  const today = todayUtc();
  const csv = [
    CSV_COLUMNS.join(','),
    ...rows
      .map(r => shape(r, catalog, today))
      .filter(p => !statusFilter || statusFilter === 'all' || p.effective_status === statusFilter)
      .map(p => {
        const cells: Record<string, unknown> = {
          ...p,
          standard: p.standard ? (p.standard.title ? `${p.standard.designation} ${p.standard.title}` : p.standard.designation) : '',
        };
        return CSV_COLUMNS.map(c => csvCell(cells[c])).join(',');
      }),
  ].join('\r\n');

  return new Response(csv, {
    status: 200,
    headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="lens-purchases.csv"' },
  });
}

// ── small helpers ───────────────────────────────────────────────────────────

function todayUtc(): string { return new Date().toISOString().slice(0, 10); }
function errMsg(err: unknown): string { return err instanceof Error ? err.message : String(err); }
function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}
