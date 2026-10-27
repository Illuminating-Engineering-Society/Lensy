/**
 * SureCart purchases → Lighting Library access (Teams, 2026-10-26: "the
 * purchase in SureCart just triggers the update in Vitrium"). The PURE half:
 * the webhook signature rule, the configuration, the shape of an expanded
 * purchase, and the one decision — what a purchase grants. The fetching half
 * is lib/surecart-api.ts; the D1 half lib/purchases.ts; the orchestration
 * workers/surecart.ts. Design: docs/superpowers/specs/2026-10-26-surecart-purchases-design.md.
 *
 * Why a purchase is PLANNED from the API object rather than the webhook body:
 * the body of `purchase.created` carries ids only (no customer email, no
 * product SKU), and treating it as truth would make a forged event a grant.
 * The webhook is the trigger; the SureCart API, read with the account's key,
 * is the source — which is also what makes a staff "Resync" possible.
 */

// ── signature ───────────────────────────────────────────────────────────────

/** SureCart retries with a fresh timestamp; a delivery older than this is a replay. */
export const WEBHOOK_TOLERANCE_SECONDS = 300;

export type SignatureVerdict = 'ok' | 'missing' | 'stale' | 'mismatch';

/**
 * SureCart signs `${x-webhook-timestamp}.${rawBody}` with the endpoint's
 * signing secret (HMAC-SHA256) and sends the hex digest as
 * `x-webhook-signature`. The timestamp is inside the signed payload, so a
 * replayed body cannot be re-dated; what the receiver adds is the age check.
 */
export async function verifyWebhookSignature(
  secret: string,
  timestamp: string | null,
  rawBody: string,
  signature: string | null,
  nowSeconds: number,
): Promise<SignatureVerdict> {
  if (!timestamp || !signature) return 'missing';
  const ts = Number.parseInt(timestamp, 10);
  if (!Number.isFinite(ts) || Math.abs(nowSeconds - ts) > WEBHOOK_TOLERANCE_SECONDS) return 'stale';
  const expected = await hmacHex(secret, `${timestamp}.${rawBody}`);
  return timingSafeEqualHex(expected, signature.trim().toLowerCase()) ? 'ok' : 'mismatch';
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Constant-time over two hex strings of equal length; unequal lengths differ. */
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ── configuration ───────────────────────────────────────────────────────────

export interface SurecartConfig {
  /** Lease term in days, inclusive of the purchase day. */
  leaseDays: number;
  /** Subscription term when SureCart reports no billing period. */
  subscriptionDays: number;
  /** SureCart product ids that sell a Library subscription. */
  subscriptionProducts: Set<string>;
  /**
   * SureCart PRICE ids that sell a lease. Empty = any price of a mapped
   * product is a lease. Set it when the same product carries other prices
   * (a PDF, a print copy): only the listed ones grant access.
   */
  leasePrices: Set<string>;
  /**
   * YYYY-MM-DD. A purchase made before this day is recorded but grants
   * nothing: before the 11/2/2026 cutover the same products sold PDFs, and a
   * backfill must not turn every past PDF buyer into a lease holder.
   */
  purchasesSince: string;
  /** Let a live_mode=false purchase grant access (staging only). */
  acceptTestMode: boolean;
  /** Email the buyer on the first successful grant. */
  notify: boolean;
}

const DEFAULT_LEASE_DAYS = 1096;
const DEFAULT_SUBSCRIPTION_DAYS = 365;
/** Dan, Teams 2026-10-26: "11/2: PDF sales no longer an option." */
const DEFAULT_PURCHASES_SINCE = '2026-11-02';

function idSet(raw: string | undefined): Set<string> {
  return new Set(String(raw || '').split(',').map(s => s.trim()).filter(Boolean));
}

export function readSurecartConfig(env: Partial<Env>): SurecartConfig {
  return {
    leaseDays: positiveInt(env.SURECART_LEASE_DAYS, DEFAULT_LEASE_DAYS),
    subscriptionDays: positiveInt(env.SURECART_SUBSCRIPTION_DAYS, DEFAULT_SUBSCRIPTION_DAYS),
    subscriptionProducts: idSet(env.SURECART_SUBSCRIPTION_PRODUCTS),
    leasePrices: idSet(env.SURECART_LEASE_PRICES),
    purchasesSince: /^\d{4}-\d{2}-\d{2}$/.test(String(env.SURECART_PURCHASES_SINCE || '').trim())
      ? String(env.SURECART_PURCHASES_SINCE).trim()
      : DEFAULT_PURCHASES_SINCE,
    acceptTestMode: String(env.SURECART_ACCEPT_TEST_MODE || '').trim().toLowerCase() === 'on',
    notify: String(env.SURECART_NOTIFY || '').trim().toLowerCase() !== 'off',
  };
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number.parseInt(String(raw ?? '').trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// ── the webhook envelope ────────────────────────────────────────────────────

export interface WebhookEvent {
  type: string;
  objectId: string;
  objectType: string;
  liveMode: boolean;
}

/** `{ id, object: 'event', type, data: { object: {...} } }` → the three things the handler needs. */
export function parseWebhookEvent(json: unknown): WebhookEvent | null {
  const root = asRecord(json);
  if (!root || typeof root.type !== 'string') return null;
  const obj = asRecord(asRecord(root.data)?.object);
  if (!obj || typeof obj.id !== 'string' || !obj.id) return null;
  return {
    type: root.type,
    objectId: obj.id,
    objectType: typeof obj.object === 'string' ? obj.object : '',
    liveMode: obj.live_mode !== false,
  };
}

// ── an expanded purchase ────────────────────────────────────────────────────

export interface SurecartPurchase {
  id: string;
  liveMode: boolean;
  revoked: boolean;
  /** UNIX seconds. */
  createdAt: number;
  customerId: string | null;
  /** Lowercased. */
  email: string;
  name: string | null;
  product: { id: string; name: string | null; sku: string | null; slug: string | null; recurring: boolean | null };
  priceId: string | null;
  subscription: {
    id: string;
    status: string | null;
    currentPeriodStartAt: number | null;
    currentPeriodEndAt: number | null;
    cancelAtPeriodEnd: boolean | null;
  } | null;
  orderId: string | null;
  orderNumber: string | null;
}

/**
 * The API's purchase with customer, product, price, subscription and
 * initial_order expanded. An unexpanded relation arrives as a bare id string
 * and is kept as such; the CUSTOMER must be expanded — without an email there
 * is nobody to grant to, and the caller treats null as "cannot process".
 */
export function normalizePurchase(raw: unknown): SurecartPurchase | null {
  const p = asRecord(raw);
  if (!p || p.object !== 'purchase' || typeof p.id !== 'string' || !p.id) return null;
  const customer = asRecord(p.customer);
  const email = typeof customer?.email === 'string' ? customer.email.trim().toLowerCase() : '';
  if (!email) return null;
  // The purchase day anchors every window; a guess would move it on each sync.
  if (typeof p.created_at !== 'number' || !Number.isFinite(p.created_at)) return null;

  const product = asRecord(p.product);
  const productId = product ? str(product.id) : str(p.product);
  const subscription = asRecord(p.subscription);
  const subscriptionId = subscription ? str(subscription.id) : str(p.subscription);
  const order = asRecord(p.initial_order);

  return {
    id: p.id,
    liveMode: p.live_mode !== false,
    revoked: p.revoked === true,
    createdAt: p.created_at,
    customerId: str(customer?.id),
    email,
    name: str(customer?.name),
    product: {
      id: productId ?? '',
      name: str(product?.name),
      sku: str(product?.sku),
      slug: str(product?.slug),
      recurring: typeof product?.recurring === 'boolean' ? product.recurring : null,
    },
    priceId: asRecord(p.price) ? str(asRecord(p.price)?.id) : str(p.price),
    subscription: subscriptionId
      ? {
          id: subscriptionId,
          status: str(subscription?.status),
          currentPeriodStartAt: typeof subscription?.current_period_start_at === 'number' ? subscription.current_period_start_at : null,
          currentPeriodEndAt: typeof subscription?.current_period_end_at === 'number' ? subscription.current_period_end_at : null,
          cancelAtPeriodEnd: typeof subscription?.cancel_at_period_end === 'boolean' ? subscription.cancel_at_period_end : null,
        }
      : null,
    orderId: order ? str(order.id) : str(p.initial_order),
    orderNumber: str(order?.number),
  };
}

// ── the decision ────────────────────────────────────────────────────────────

export type PurchaseKind = 'lease' | 'subscription' | 'unmapped';
export type PurchaseStatus = 'active' | 'revoked' | 'ignored';
export type RevokedReason = 'surecart' | 'staff' | 'test_mode' | 'unmapped' | 'before_cutover' | 'not_a_lease';

export interface PurchasePlan {
  kind: PurchaseKind;
  standardId: string | null;
  /** YYYY-MM-DD, inclusive at both ends (Lens's comp convention). */
  startDate: string;
  endDate: string;
  status: PurchaseStatus;
  revokedReason: RevokedReason | null;
}

/** Subscription statuses SureCart uses once the period is over. */
const ENDED_SUBSCRIPTION = new Set(['canceled', 'completed']);

/**
 * What a purchase grants.
 *
 *   subscription  the product is listed as a subscription product, or the
 *                 purchase carries a SureCart subscription and maps to no
 *                 standard (that fallback ONLY while the list is empty) —
 *                 window = the billing period (extended on each renewal
 *                 event), else `subscriptionDays`
 *   lease         the product mapped to a standard (and, when
 *                 `leasePrices` is set, a listed price) — `leaseDays` from
 *                 the purchase day, inclusive
 *   unmapped      nothing to grant; recorded for staff (`not_a_lease` when
 *                 the product is a standard but the price is not a lease)
 *
 * A subscription's window is its CURRENT billing period, so a renewal moves
 * both ends and the grant never grows past AuthIES's window cap.
 *
 * Then the status: a purchase from before `purchasesSince` is ignored (it
 * bought a PDF); a test-mode purchase is ignored unless accepted; a purchase
 * SureCart revoked (refund, period end) is revoked; a CANCELED subscription
 * stays active until its period ends — SureCart revokes the purchase then.
 */
export function planPurchase(
  p: SurecartPurchase,
  standard: { id: string } | null,
  cfg: SurecartConfig,
  now: Date,
): PurchasePlan {
  const purchaseDay = dayUtc(p.createdAt);
  let startDate = purchaseDay;
  let kind: PurchaseKind;
  let standardId: string | null = null;
  let endDate: string;
  let unmappedReason: RevokedReason = 'unmapped';

  // Which products are the Library subscription is CONFIGURED. The "any
  // recurring product that is no standard" reading applies only while the
  // list is empty: the live store also sells IES memberships and the
  // Illuminance Selector as recurring products (2026-10-27), and none of them
  // buys the Lighting Library.
  const isSubscription = cfg.subscriptionProducts.size > 0
    ? cfg.subscriptionProducts.has(p.product.id)
    : Boolean(p.subscription && !standard);
  if (isSubscription) {
    kind = 'subscription';
    if (p.subscription?.currentPeriodStartAt) startDate = dayUtc(p.subscription.currentPeriodStartAt);
    endDate = p.subscription?.currentPeriodEndAt
      ? dayUtc(p.subscription.currentPeriodEndAt)
      : addDays(startDate, cfg.subscriptionDays - 1);
  } else if (standard && cfg.leasePrices.size > 0 && !(p.priceId && cfg.leasePrices.has(p.priceId))) {
    kind = 'unmapped';
    unmappedReason = 'not_a_lease';
    endDate = startDate;
  } else if (standard) {
    kind = 'lease';
    standardId = standard.id;
    endDate = addDays(startDate, cfg.leaseDays - 1);
  } else {
    kind = 'unmapped';
    endDate = startDate;
  }

  let status: PurchaseStatus = 'active';
  let revokedReason: RevokedReason | null = null;
  const periodOver = p.subscription?.currentPeriodEndAt != null
    && p.subscription.currentPeriodEndAt * 1000 < now.getTime();
  if (kind === 'unmapped') {
    status = 'ignored';
    revokedReason = unmappedReason;
  } else if (purchaseDay < cfg.purchasesSince) {
    status = 'ignored';
    revokedReason = 'before_cutover';
  } else if (!p.liveMode && !cfg.acceptTestMode) {
    status = 'ignored';
    revokedReason = 'test_mode';
  } else if (p.revoked || (p.subscription?.status && ENDED_SUBSCRIPTION.has(p.subscription.status) && periodOver)) {
    status = 'revoked';
    revokedReason = 'surecart';
  }

  return { kind, standardId, startDate, endDate, status, revokedReason };
}

// ── small helpers ───────────────────────────────────────────────────────────

/** UNIX seconds → the UTC calendar day, YYYY-MM-DD. */
export function dayUtc(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
}

/** YYYY-MM-DD plus n calendar days, in UTC. */
export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** `https://store.ies.org/product/<slug>/` → `<slug>`; anything else → null. */
export function slugFromStoreUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const m = /^\/product\/([^/]+)\/?$/.exec(new URL(url).pathname);
    return m ? decodeURIComponent(m[1]).toLowerCase() : null;
  } catch {
    return null;
  }
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}
