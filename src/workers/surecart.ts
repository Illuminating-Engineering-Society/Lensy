/**
 * SureCart purchases → Lighting Library access (Teams, 2026-10-26: "the
 * purchase in SureCart just triggers the update in Vitrium"). The
 * orchestration: a webhook names a purchase, Lens re-reads it from the
 * SureCart API, maps the product to a standard, records a `purchases` row,
 * and pushes (or revokes) the matching grant in AuthIES — which is what
 * Vitrium asks on every document open, and what the Lens tier reads.
 *
 * Everything funnels through `syncPurchaseById`, which is idempotent: the
 * same event twice, a renewal, a staff "Resync" and the backfill all land on
 * the same row and the same AuthIES source_ref. Design and the rules each
 * step follows: docs/superpowers/specs/2026-10-26-surecart-purchases-design.md.
 */

import { planPurchase, readSurecartConfig, type SurecartConfig } from '../lib/surecart';
import { fetchPurchase, surecartConfigured } from '../lib/surecart-api';
import {
  findPurchaseBySurecartId, listPurchasesBySubscription, resolveStandardForProduct, stampAuthies, stampNotify,
  upsertPurchase, type PurchaseRow, type ResolvedStandard,
} from '../lib/purchases';
import { pushPurchaseGrant, revokePurchaseGrant } from '../lib/comp-grants';
import { sendPurchaseEmail } from '../lib/email';

export type SyncAction = 'granted' | 'revoked' | 'unchanged' | 'skipped';

export type SyncResult =
  | { ok: true; row: PurchaseRow; action: SyncAction }
  | { ok: false; error: string; retryable: boolean };

export interface SyncOptions {
  /** The webhook event that triggered this sync, recorded on the row. */
  eventType?: string | null;
  /** Re-push to AuthIES even when nothing changed (staff Retry / Resync). */
  force?: boolean;
}

// ── the reconcile ───────────────────────────────────────────────────────────

/**
 * Read the purchase from SureCart, plan it, record it, and bring AuthIES in
 * line when the plan changed (or on `force`). A SureCart failure writes
 * nothing: `retryable` tells the webhook whether to ask SureCart to retry.
 */
export async function syncPurchaseById(
  env: Env, requestUrl: string, surecartPurchaseId: string, opts: SyncOptions = {},
): Promise<SyncResult> {
  if (!surecartConfigured(env)) {
    return { ok: false, error: 'SURECART_API_KEY is not set — the purchase cannot be read back from SureCart.', retryable: false };
  }
  const fetched = await fetchPurchase(env, surecartPurchaseId);
  if (!fetched.ok) {
    const retryable = fetched.status === undefined || fetched.status === 429 || fetched.status >= 500;
    return { ok: false, error: fetched.error, retryable };
  }
  const purchase = fetched.purchase;
  const cfg = readSurecartConfig(env);

  const standard = await resolveStandardForProduct(env.DB, purchase.product);
  const plan = planPurchase(purchase, standard, cfg, new Date());

  let previous: PurchaseRow | null;
  let row: PurchaseRow;
  try {
    previous = await findPurchaseBySurecartId(env.DB, surecartPurchaseId);
    row = await upsertPurchase(env.DB, purchase, plan, opts.eventType ?? null);
  } catch (err) {
    // Most likely migration 0024 not applied: SureCart should retry later.
    return { ok: false, error: `purchases unavailable: ${err instanceof Error ? err.message : String(err)}`, retryable: true };
  }

  const changed = !previous
    || previous.kind !== row.kind
    || previous.status !== row.status
    || previous.standard_id !== row.standard_id
    || previous.start_date !== row.start_date
    || previous.end_date !== row.end_date
    || previous.email !== row.email;
  const wantsGrant = row.status === 'active' && row.kind !== 'unmapped';
  // A grant that never landed (AuthIES down, missing Vitrium id since fixed)
  // is retried by any later event, not only by staff.
  const pendingGrant = wantsGrant && !row.authies_applied_at;
  if (!opts.force && !changed && !pendingGrant) return { ok: true, row, action: 'unchanged' };

  return applyPurchase(env, requestUrl, row, standard, cfg);
}

/** Every local purchase of one SureCart subscription, re-read and re-applied. */
export async function syncSubscription(
  env: Env, requestUrl: string, surecartSubscriptionId: string, eventType: string | null,
): Promise<SyncResult[]> {
  let rows: PurchaseRow[];
  try {
    rows = await listPurchasesBySubscription(env.DB, surecartSubscriptionId);
  } catch {
    return [];
  }
  const results: SyncResult[] = [];
  for (const r of rows) results.push(await syncPurchaseById(env, requestUrl, r.surecart_purchase_id, { eventType }));
  return results;
}

/**
 * Bring AuthIES in line with one row: push the grant an active lease or
 * subscription wants; revoke whatever a revoked/ignored row had pushed. The
 * buyer is emailed once, on the first grant that landed.
 */
export async function applyPurchase(
  env: Env, requestUrl: string, row: PurchaseRow, standard: ResolvedStandard | null, cfg: SurecartConfig,
): Promise<SyncResult> {
  const wantsGrant = row.status === 'active' && row.kind !== 'unmapped';

  if (!wantsGrant) {
    // Nothing was ever pushed → nothing to withdraw.
    if (!row.authies_applied_at) return { ok: true, row, action: 'skipped' };
    const outcome = await revokePurchaseGrant(env, requestUrl, row.surecart_purchase_id, row.email);
    await stampAuthies(env.DB, row.id, outcome);
    return { ok: true, row: await reread(env, row), action: outcome.ok ? 'revoked' : 'skipped' };
  }

  if (row.kind === 'lease' && !standard?.vitriumDocId) {
    const which = standard?.id ?? row.standard_id ?? row.product_sku ?? 'this standard';
    await stampAuthies(env.DB, row.id, {
      ok: false,
      error: `No Vitrium document id synced for ${which} — set it in Admin → Standards (or run sync-metadata) and Retry.`,
    });
    return { ok: true, row: await reread(env, row), action: 'skipped' };
  }

  const note = row.surecart_order_number ? `SureCart order #${row.surecart_order_number}` : null;
  const outcome = await pushPurchaseGrant(env, requestUrl, {
    surecartPurchaseId: row.surecart_purchase_id,
    email: row.email,
    kind: row.kind === 'lease' ? 'documents' : 'subscriber',
    documents: row.kind === 'lease' && standard?.vitriumDocId ? [standard.vitriumDocId] : [],
    labels: row.kind === 'lease' && standard ? [standard.id] : [],
    startDate: row.start_date,
    endDate: row.end_date,
    note,
  });
  await stampAuthies(env.DB, row.id, outcome);
  if (!outcome.ok) return { ok: true, row: await reread(env, row), action: 'skipped' };

  if (cfg.notify && !row.notify_sent_at) {
    const sent = await sendPurchaseEmail(env, {
      to: row.email,
      name: row.name,
      kind: row.kind === 'lease' ? 'lease' : 'subscription',
      document: standard ? { id: standard.id, designation: standard.designation, title: standard.title, libraryUrl: standard.libraryUrl } : null,
      startDate: row.start_date,
      endDate: row.end_date,
      orderNumber: row.surecart_order_number,
    });
    await stampNotify(env.DB, row.id, sent);
  }
  return { ok: true, row: await reread(env, row), action: 'granted' };
}

// ── helpers ─────────────────────────────────────────────────────────────────

async function reread(env: Env, row: PurchaseRow): Promise<PurchaseRow> {
  try {
    return (await findPurchaseBySurecartId(env.DB, row.surecart_purchase_id)) ?? row;
  } catch {
    return row;
  }
}

