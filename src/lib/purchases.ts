/**
 * SureCart purchases, the D1 half (2026-10-26): which standard a webstore
 * product is, and the `purchases` table (migration 0024) as the sync
 * (workers/surecart.ts) and the dashboard (workers/purchases-admin.ts) read
 * and write it. The decision of what a purchase grants is lib/surecart.ts.
 */

import { normalizeStandardIdInput, STANDARD_ID_RE } from './standard-id.js';
import { toLibraryUrlOrNull } from './library-url.js';
import { slugFromStoreUrl, type PurchasePlan, type PurchaseStatus, type RevokedReason, type SurecartPurchase } from './surecart';
import type { PushOutcome } from './comp-grants';

// ── product → standard ──────────────────────────────────────────────────────

export interface ResolvedStandard {
  id: string;
  designation: string;
  title: string | null;
  vitriumDocId: string | null;
  libraryUrl: string | null;
}

interface CatalogRow {
  id: string;
  full_designation: string | null;
  title: string | null;
  status: string | null;
  buy_url: string | null;
  vitrium_doc_id: string | null;
  vitrium_web_url: string | null;
}

/**
 * The store's SKU is the printed designation ("ANSI/IES RP-8-25+E2",
 * "ANSI/IES LM-49-20(R2023)", "ANSI/ASHRAE/IES 90.1-2025"). Strip the
 * approval/series preamble and a reaffirmation marker, then let the
 * dashboard's own normalizer read a joint designation. Null for a SKU that
 * is not a designation at all ("IES-2017-ACP").
 */
export function skuToStandardId(sku: string | null | undefined): string | null {
  const raw = String(sku || '').trim();
  if (!raw) return null;
  const stripped = raw
    .replace(/\s*\(\s*R\s*\d{4}\s*\)\s*$/i, '')     // "(R2023)"
    .replace(/^(?:ANSI\s*\/\s*)?IES\s+/i, '')         // "ANSI/IES " / "IES "
    .trim();
  const id = normalizeStandardIdInput(stripped);
  if (!STANDARD_ID_RE.test(id)) return null;
  // A designation carries an edition year; "IES-2017-ACP" passes the id
  // regex ("IES" + "-2017-ACP") but names no standard family.
  return /^[A-Z]{1,6}(?:-[A-Z]{1,6}){0,2}-\d+(?:\.\d+)?-\d{2,4}(?:\+E\d+)?$/i.test(id) ? id : null;
}

/** "RP-8-25+E2" → "RP-8-25": the edition without its errata printing. */
function baseEdition(id: string): string {
  return id.replace(/\+E\d+$/i, '');
}

/**
 * Which standard a SureCart product sells. Three readings, first hit wins:
 *   1. the store permalink slug against `standards.buy_url` — hand-curated on
 *      2026-10-21, so it already absorbs the store's SKU typos (LM-79, LP-42);
 *   2. the SKU as a designation, exactly;
 *   3. the SKU's edition against the newest Active printing of that edition
 *      ("RP-8-25" sold, "RP-8-25+E2" indexed).
 * Deprecated editions still resolve on 1 and 2: a lease of RP-8-22 is a lease
 * of RP-8-22. Null for an unknown product. A D1 failure THROWS: "no match"
 * and "could not look" must stay distinct, or a D1 blip would turn a paying
 * customer's lease into an unmapped purchase and revoke it.
 */
export async function resolveStandardForProduct(
  db: D1Database,
  product: { slug: string | null; sku: string | null },
): Promise<ResolvedStandard | null> {
  const rows = await loadCatalogRows(db);

  const slug = product.slug ? product.slug.trim().toLowerCase() : null;
  const bySlug = slug ? rows.find(r => slugFromStoreUrl(r.buy_url) === slug) : undefined;
  if (bySlug) return shape(bySlug);

  const skuId = skuToStandardId(product.sku);
  if (!skuId) return null;
  const exact = rows.find(r => r.id.toLowerCase() === skuId.toLowerCase());
  if (exact) return shape(exact);

  const base = baseEdition(skuId).toLowerCase();
  const printings = rows
    .filter(r => baseEdition(r.id).toLowerCase() === base && String(r.status || 'Active') === 'Active')
    .sort((a, b) => errataNumber(b.id) - errataNumber(a.id));
  return printings[0] ? shape(printings[0]) : null;
}

const CATALOG_SQL = 'SELECT id, full_designation, title, status, buy_url, vitrium_doc_id, vitrium_web_url FROM standards';

async function loadCatalogRows(db: D1Database): Promise<CatalogRow[]> {
  const res = await db.prepare(CATALOG_SQL).all<CatalogRow>();
  return res.results || [];
}

/** One standard by id — the sticky mapping a recorded lease keeps (throws on D1 failure). */
export async function resolveStandardById(db: D1Database, id: string): Promise<ResolvedStandard | null> {
  const rows = await loadCatalogRows(db);
  const row = rows.find(r => r.id.toLowerCase() === id.toLowerCase());
  return row ? shape(row) : null;
}

function errataNumber(id: string): number {
  const m = /\+E(\d+)$/i.exec(id);
  return m ? Number(m[1]) : 0;
}

function shape(row: CatalogRow): ResolvedStandard {
  return {
    id: row.id,
    designation: row.full_designation && row.full_designation.trim() ? row.full_designation.trim() : `ANSI/IES ${row.id}`,
    // The ingest writes title = id when a cover could not be read.
    title: row.title && row.title.trim() && row.title !== row.id ? row.title.trim() : null,
    vitriumDocId: row.vitrium_doc_id && row.vitrium_doc_id.trim() ? row.vitrium_doc_id.trim() : null,
    libraryUrl: toLibraryUrlOrNull(row.vitrium_web_url),
  };
}

// ── the purchases table ─────────────────────────────────────────────────────

export interface PurchaseRow {
  id: number;
  surecart_purchase_id: string;
  surecart_order_id: string | null;
  surecart_order_number: string | null;
  surecart_customer_id: string | null;
  surecart_product_id: string | null;
  surecart_price_id: string | null;
  surecart_subscription_id: string | null;
  live_mode: number;
  email: string;
  name: string | null;
  product_name: string | null;
  product_sku: string | null;
  product_slug: string | null;
  kind: 'lease' | 'subscription' | 'unmapped';
  standard_id: string | null;
  start_date: string;
  end_date: string;
  status: PurchaseStatus;
  revoked_reason: RevokedReason | null;
  authies_applied_at: string | null;
  authies_error: string | null;
  notify_sent_at: string | null;
  notify_error: string | null;
  last_event_type: string | null;
  last_event_at: string | null;
  synced_at: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * One row per SureCart purchase. A second delivery of the same purchase — a
 * webhook retry, a renewal, a staff resync — UPDATES what SureCart and the
 * plan say and leaves the push and notify stamps alone: those record what
 * Lens did, and only Lens rewrites them.
 */
export async function upsertPurchase(
  db: D1Database,
  p: SurecartPurchase,
  plan: PurchasePlan,
  eventType: string | null,
): Promise<PurchaseRow> {
  const row = await db.prepare(`
    INSERT INTO purchases (
      surecart_purchase_id, surecart_order_id, surecart_order_number, surecart_customer_id, surecart_product_id,
      surecart_price_id, surecart_subscription_id, live_mode,
      email, name, product_name, product_sku, product_slug,
      kind, standard_id, start_date, end_date, status, revoked_reason, last_event_type,
      last_event_at, synced_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    ON CONFLICT (surecart_purchase_id) DO UPDATE SET
      surecart_order_id = excluded.surecart_order_id,
      surecart_order_number = excluded.surecart_order_number,
      surecart_customer_id = excluded.surecart_customer_id,
      surecart_product_id = excluded.surecart_product_id,
      surecart_price_id = excluded.surecart_price_id,
      surecart_subscription_id = excluded.surecart_subscription_id,
      live_mode = excluded.live_mode,
      email = excluded.email,
      name = excluded.name,
      product_name = excluded.product_name,
      product_sku = excluded.product_sku,
      product_slug = excluded.product_slug,
      kind = excluded.kind,
      standard_id = excluded.standard_id,
      start_date = excluded.start_date,
      end_date = excluded.end_date,
      status = excluded.status,
      revoked_reason = excluded.revoked_reason,
      last_event_type = COALESCE(excluded.last_event_type, purchases.last_event_type),
      last_event_at = datetime('now'),
      synced_at = datetime('now'),
      updated_at = datetime('now')
    RETURNING *
  `).bind(
    p.id, p.orderId, p.orderNumber, p.customerId, p.product.id || null,
    p.priceId, p.subscription?.id ?? null, p.liveMode ? 1 : 0,
    p.email, p.name, p.product.name, p.product.sku, p.product.slug,
    plan.kind, plan.standardId, plan.startDate, plan.endDate, plan.status, plan.revokedReason, eventType,
  ).first<PurchaseRow>();
  if (!row) throw new Error('purchases upsert returned no row');
  return row;
}

export function findPurchaseBySurecartId(db: D1Database, surecartPurchaseId: string): Promise<PurchaseRow | null> {
  return db.prepare('SELECT * FROM purchases WHERE surecart_purchase_id = ?').bind(surecartPurchaseId).first<PurchaseRow>();
}

export function findPurchaseById(db: D1Database, id: number): Promise<PurchaseRow | null> {
  return db.prepare('SELECT * FROM purchases WHERE id = ?').bind(id).first<PurchaseRow>();
}

export async function listPurchasesBySubscription(db: D1Database, surecartSubscriptionId: string): Promise<PurchaseRow[]> {
  const res = await db.prepare('SELECT * FROM purchases WHERE surecart_subscription_id = ? ORDER BY id')
    .bind(surecartSubscriptionId).all<PurchaseRow>();
  return res.results || [];
}

export async function listPurchases(db: D1Database, limit: number): Promise<PurchaseRow[]> {
  const res = await db.prepare('SELECT * FROM purchases ORDER BY created_at DESC, id DESC LIMIT ?')
    .bind(limit).all<PurchaseRow>();
  return res.results || [];
}

/** The AuthIES push outcome. A failed push keeps the previous applied stamp: the old grant is still what AuthIES holds. */
export async function stampAuthies(db: D1Database, id: number, outcome: PushOutcome): Promise<void> {
  if (outcome.ok) {
    await db.prepare(`UPDATE purchases SET authies_applied_at = datetime('now'), authies_error = NULL, updated_at = datetime('now') WHERE id = ?`)
      .bind(id).run();
  } else {
    await db.prepare(`UPDATE purchases SET authies_error = ?, updated_at = datetime('now') WHERE id = ?`)
      .bind(outcome.error.slice(0, 300), id).run();
  }
}

export async function stampNotify(db: D1Database, id: number, outcome: { sent: boolean; error?: string }): Promise<void> {
  if (outcome.sent) {
    await db.prepare(`UPDATE purchases SET notify_sent_at = datetime('now'), notify_error = NULL, updated_at = datetime('now') WHERE id = ?`)
      .bind(id).run();
  } else {
    await db.prepare(`UPDATE purchases SET notify_error = ?, updated_at = datetime('now') WHERE id = ?`)
      .bind(String(outcome.error || 'unknown').slice(0, 300), id).run();
  }
}

export async function setPurchaseStatus(
  db: D1Database, id: number, status: PurchaseStatus, reason: RevokedReason | null,
): Promise<void> {
  await db.prepare(`UPDATE purchases SET status = ?, revoked_reason = ?, updated_at = datetime('now') WHERE id = ?`)
    .bind(status, reason, id).run();
}
