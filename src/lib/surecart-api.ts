/**
 * The SureCart API, read-only (2026-10-26). Two calls: one purchase by id,
 * and a page of purchases (the backfill / "Import from SureCart"). Both ask
 * for the same expansions, because lib/surecart.ts plans a grant from the
 * customer's email, the product's slug/SKU and the subscription's period —
 * none of which the webhook body carries.
 *
 * Never throws: a missing key, a non-2xx, a network failure and an
 * unexpandable body are all `{ ok: false, error }`, so the webhook handler
 * can decide whether SureCart should retry (5xx) or stop (2xx + recorded).
 */

import { normalizePurchase, type SurecartPurchase } from './surecart';

export const SURECART_API = 'https://api.surecart.com/v1';

/** What a grant needs; the bare-id form of any of these is useless to us. */
const EXPAND = ['customer', 'product', 'price', 'subscription', 'initial_order'];

const FETCH_TIMEOUT_MS = 8000;

export type FetchPurchaseResult =
  | { ok: true; purchase: SurecartPurchase }
  | { ok: false; error: string; status?: number };

export type ListPurchasesResult =
  | { ok: true; purchases: SurecartPurchase[]; hasMore: boolean; skipped: number }
  | { ok: false; error: string; status?: number };

export function surecartConfigured(env: Partial<Env>): boolean {
  return !!(env.SURECART_API_KEY || '').trim();
}

function apiKey(env: Partial<Env>): string | null {
  const key = (env.SURECART_API_KEY || '').trim();
  return key || null;
}

async function get(env: Partial<Env>, path: string, params: [string, string][]): Promise<
  { ok: true; body: unknown } | { ok: false; error: string; status?: number }
> {
  const key = apiKey(env);
  if (!key) return { ok: false, error: 'SURECART_API_KEY is not set' };
  const url = new URL(`${SURECART_API}${path}`);
  for (const [k, v] of params) url.searchParams.append(k, v);
  try {
    const res = await fetch(url.toString(), {
      method: 'GET',
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      let detail = '';
      try { detail = String(((await res.json()) as { message?: unknown; error?: unknown }).message ?? '') ; } catch { /* not JSON */ }
      return { ok: false, error: `SureCart answered ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`, status: res.status };
    }
    return { ok: true, body: await res.json() };
  } catch (err) {
    return { ok: false, error: `SureCart unreachable: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** GET /v1/purchases/:id with every relation a grant is built from expanded. */
export async function fetchPurchase(env: Partial<Env>, id: string): Promise<FetchPurchaseResult> {
  const r = await get(env, `/purchases/${encodeURIComponent(id)}`, EXPAND.map(e => ['expand[]', e]));
  if (!r.ok) return r;
  const purchase = normalizePurchase(r.body);
  if (!purchase) {
    return { ok: false, error: 'SureCart purchase could not be read: no expanded customer email on the object' };
  }
  return { ok: true, purchase };
}

/**
 * GET /v1/purchases?page=N&limit=M, newest first as SureCart lists them.
 * `hasMore` is inferred from a full page (the list response carries no total
 * we can trust across accounts); rows with no expanded customer are counted
 * in `skipped` rather than failing the page.
 */
export async function listPurchases(env: Partial<Env>, page: number, limit = 100): Promise<ListPurchasesResult> {
  const r = await get(env, '/purchases', [
    ['page', String(Math.max(1, Math.floor(page)))],
    ['limit', String(Math.min(100, Math.max(1, Math.floor(limit))))],
    ...EXPAND.map((e): [string, string] => ['expand[]', e]),
  ]);
  if (!r.ok) return r;
  const data = (r.body as { data?: unknown })?.data;
  const rows = Array.isArray(data) ? data : [];
  const purchases: SurecartPurchase[] = [];
  let skipped = 0;
  for (const row of rows) {
    const p = normalizePurchase(row);
    if (p) purchases.push(p); else skipped++;
  }
  return { ok: true, purchases, hasMore: rows.length >= limit, skipped };
}
