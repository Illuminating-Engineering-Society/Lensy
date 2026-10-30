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

import {
  parseWebhookEvent, planPurchase, readSurecartConfig, verifyWebhookSignature, type SurecartConfig,
} from '../lib/surecart';
import { fetchPurchase, surecartConfigured } from '../lib/surecart-api';
import {
  findPurchaseBySurecartId, listPurchasesBySubscription, resolveStandardById, resolveStandardForProduct, stampAuthies,
  stampNotify, upsertPurchase, type PurchaseRow, type ResolvedStandard,
} from '../lib/purchases';
import { pushPurchaseGrant, revokePurchaseGrant } from '../lib/comp-grants';
import { sendPurchaseEmail } from '../lib/email';

/**
 * granted / revoked — AuthIES took the call; unchanged — nothing to do;
 * skipped — nothing to push and nothing to retry (unmapped, test mode, no
 * Vitrium id until the catalogue is fixed); failed — AuthIES refused or was
 * unreachable: the row keeps the error and the NEXT event (or SureCart's
 * retry of this one) tries again.
 */
export type SyncAction = 'granted' | 'revoked' | 'unchanged' | 'skipped' | 'failed';

export type SyncResult =
  | { ok: true; row: PurchaseRow; action: SyncAction }
  | { ok: false; error: string; retryable: boolean };

export interface SyncOptions {
  /** The webhook event that triggered this sync, recorded on the row. */
  eventType?: string | null;
  /** Re-push to AuthIES even when nothing changed (staff Retry / Resync). */
  force?: boolean;
  /** Lift a revoke made in /admin (staff Reinstate). Nothing else may. */
  reinstate?: boolean;
}

/** Events whose `data.object` is a purchase. */
const PURCHASE_EVENTS = new Set(['purchase.created', 'purchase.updated', 'purchase.invoked', 'purchase.revoked']);
/** Events whose `data.object` is a subscription and that can move a period or end one. */
const SUBSCRIPTION_EVENTS = new Set([
  'subscription.renewed', 'subscription.updated', 'subscription.made_active', 'subscription.canceled', 'subscription.completed',
]);

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

  let previous: PurchaseRow | null;
  let standard: ResolvedStandard | null;
  let row: PurchaseRow;
  try {
    previous = await findPurchaseBySurecartId(env.DB, surecartPurchaseId);
    standard = await resolveStandardForProduct(env.DB, purchase.product);
    // The mapping is STICKY once a lease was recorded: a product renamed in
    // the store or a lease link edited in the catalogue must not turn a
    // paying customer's lease into "unmapped" and revoke it.
    if (!standard && previous?.kind === 'lease' && previous.standard_id && !opts.force) {
      standard = await resolveStandardById(env.DB, previous.standard_id);
    }
    const plan = planPurchase(purchase, standard, cfg, new Date());
    // A revoke made in /admin is a decision SureCart knows nothing about: no
    // SureCart event — and no plain Retry — may undo it. Only Reinstate can.
    if (!opts.reinstate && previous?.status === 'revoked' && previous.revoked_reason === 'staff') {
      plan.status = 'revoked';
      plan.revokedReason = 'staff';
    }
    row = await upsertPurchase(env.DB, purchase, plan, opts.eventType ?? null);
  } catch (err) {
    // A D1 failure (or migration 0024 not applied): SureCart should retry.
    return { ok: false, error: `purchases unavailable: ${err instanceof Error ? err.message : String(err)}`, retryable: true };
  }

  const changed = !previous
    || previous.kind !== row.kind
    || previous.status !== row.status
    || previous.standard_id !== row.standard_id
    || previous.start_date !== row.start_date
    || previous.end_date !== row.end_date
    || previous.email !== row.email;
  // Decided from what AuthIES HOLDS (the stamps), not only from what changed:
  // a push or revoke that failed leaves authies_error set, and every later
  // event retries it until AuthIES answers.
  const wantsGrant = row.status === 'active' && row.kind !== 'unmapped';
  const pending = !!row.authies_error || (wantsGrant && !row.authies_applied_at);
  if (!opts.force && !changed && !pending) return { ok: true, row, action: 'unchanged' };

  // The customer email moved: AuthIES keys grants on the email, so the old
  // address's grant must be withdrawn before the new one is written.
  if (previous && previous.email !== row.email && (previous.authies_applied_at || previous.authies_error)) {
    const withdrawn = await revokePurchaseGrant(env, requestUrl, row.surecart_purchase_id);
    if (!withdrawn.ok) {
      await stampAuthies(env.DB, row.id, withdrawn);
      return { ok: true, row: await reread(env, row), action: 'failed' };
    }
  }

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
    // Nothing was ever pushed (and nothing failed) → nothing to withdraw.
    if (!row.authies_applied_at && !row.authies_error) return { ok: true, row, action: 'skipped' };
    const outcome = await revokePurchaseGrant(env, requestUrl, row.surecart_purchase_id);
    await stampAuthies(env.DB, row.id, outcome);
    return { ok: true, row: await reread(env, row), action: outcome.ok ? 'revoked' : 'failed' };
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
  const lease = leaseDocuments(row, standard);
  const outcome = await pushPurchaseGrant(env, requestUrl, {
    surecartPurchaseId: row.surecart_purchase_id,
    email: row.email,
    kind: row.kind === 'lease' ? 'documents' : 'subscriber',
    documents: lease.documents,
    labels: lease.labels,
    startDate: row.start_date,
    endDate: row.end_date,
    note,
  });
  await stampAuthies(env.DB, row.id, outcome);
  if (!outcome.ok) return { ok: true, row: await reread(env, row), action: 'failed' };

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

// ── the webhook ─────────────────────────────────────────────────────────────

/**
 * POST /api/webhooks/surecart — public by design; the signature is the gate.
 *
 *   503  no signing secret configured (nothing is recorded)
 *   401  missing / stale / wrong signature
 *   400  not a SureCart event envelope
 *   202  an event type this integration does not act on
 *   200  processed — including a purchase recorded without a grant
 *        (unmapped product, test mode, missing Vitrium id): SureCart must
 *        NOT retry those, a retry would change nothing
 *   500  SureCart, D1 or AuthIES could not be reached / refused: SureCart
 *        retries with a fresh signature, and the sync is idempotent when it
 *        lands
 */
export async function handleSurecartWebhook(request: Request, env: Env): Promise<Response> {
  const secret = (env.SURECART_WEBHOOK_SECRET || '').trim();
  if (!secret) return json({ error: 'webhook_not_configured' }, 503);

  const rawBody = await request.text();
  const verdict = await verifyWebhookSignature(
    secret,
    request.headers.get('x-webhook-timestamp'),
    rawBody,
    request.headers.get('x-webhook-signature'),
    Math.floor(Date.now() / 1000),
  );
  if (verdict !== 'ok') return json({ error: 'bad_signature', reason: verdict }, 401);

  let parsed: unknown;
  try { parsed = JSON.parse(rawBody); } catch { return json({ error: 'bad_json' }, 400); }
  const event = parseWebhookEvent(parsed);
  if (!event) return json({ error: 'bad_event' }, 400);

  if (PURCHASE_EVENTS.has(event.type)) {
    const r = await syncPurchaseById(env, request.url, event.objectId, { eventType: event.type });
    if (!r.ok) return json({ recorded: false, error: r.error }, r.retryable ? 500 : 200);
    // Recorded, but AuthIES did not take it: 500 so SureCart retries the
    // (idempotent) sync; the row already carries the error for staff.
    if (r.action === 'failed') return json({ recorded: true, action: r.action, purchase: event.objectId, error: r.row.authies_error }, 500);
    return json({ recorded: true, action: r.action, purchase: event.objectId, kind: r.row.kind, status: r.row.status });
  }
  if (SUBSCRIPTION_EVENTS.has(event.type)) {
    const results = await syncSubscription(env, request.url, event.objectId, event.type);
    const retry = results.some(r => (r.ok ? r.action === 'failed' : r.retryable));
    const firstError = results.map(r => (r.ok ? r.row.authies_error : r.error)).find(Boolean) ?? null;
    return json(
      { recorded: !retry, subscription: event.objectId, purchases: results.length, actions: results.map(r => (r.ok ? r.action : 'error')), error: firstError },
      retry ? 500 : 200,
    );
  }
  return json({ ignored: event.type }, 202);
}

// ── helpers ─────────────────────────────────────────────────────────────────

/**
 * What a lease unlocks in Vitrium: the standard itself, then its copy/paste
 * add-on files (client 2026-10-30: "the webstore must unlock the existing
 * Vitrium file plus this additional file"). Labels run parallel to the ids.
 * A subscription grants no documents.
 */
export function leaseDocuments(
  row: Pick<PurchaseRow, 'kind'>, standard: ResolvedStandard | null,
): { documents: string[]; labels: string[] } {
  if (row.kind !== 'lease' || !standard?.vitriumDocId) return { documents: [], labels: [] };
  const addons = standard.leaseAddonDocIds ?? [];
  return {
    documents: [standard.vitriumDocId, ...addons],
    labels: [standard.id, ...addons.map(() => `${standard.id} (copy/paste add-on)`)],
  };
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

async function reread(env: Env, row: PurchaseRow): Promise<PurchaseRow> {
  try {
    return (await findPurchaseBySurecartId(env.DB, row.surecart_purchase_id)) ?? row;
  } catch {
    return row;
  }
}

