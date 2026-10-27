/**
 * SureCart setup for the purchase → Lighting Library integration
 * (docs/SURECART_PURCHASES.md). Everything the SureCart side needs, driven by
 * the one thing a human must still fetch from the SureCart dashboard: an API
 * token (Settings → Developer → API Tokens, read + write on webhook endpoints).
 *
 *   SURECART_API_KEY=sk_… node scripts/surecart-setup.js products
 *       Lists every store product with its prices, matches each to a Lens
 *       standard the way the Worker does (lease link slug first, SKU second),
 *       and prints the wrangler.toml lines to review:
 *       SURECART_SUBSCRIPTION_PRODUCTS (recurring "Lighting Library" products),
 *       SURECART_LENS_PRODUCTS (those that say "IES Lens") and SURECART_LEASE_PRICES (only when a standard
 *       product carries more than one price — then staff must pick the lease).
 *
 *   SURECART_API_KEY=sk_… node scripts/surecart-setup.js webhook [--url URL]
 *       Creates (or updates — SureCart upserts on URL) the webhook endpoint
 *       with exactly the events the Worker handles, and prints the signing
 *       secret with the `wrangler secret put` commands. Default URL:
 *       https://lens.ies.org/api/webhooks/surecart.
 *
 *   SURECART_API_KEY=sk_… node scripts/surecart-setup.js endpoints
 *       Lists the account's webhook endpoints (url, enabled, events, errors).
 *
 * Options: --lens https://lens.ies.org (where /api/standards is read from),
 * --json (machine-readable output). Read-only except for `webhook`.
 */

import { normalizeStandardIdInput, STANDARD_ID_RE } from '../src/lib/standard-id.js';

const SURECART_API = 'https://api.surecart.com/v1';
const DEFAULT_WEBHOOK_URL = 'https://lens.ies.org/api/webhooks/surecart';
const DEFAULT_LENS = 'https://lens.ies.org';

/** The events workers/surecart.ts acts on — keep in step with PURCHASE_EVENTS + SUBSCRIPTION_EVENTS. */
export const WEBHOOK_EVENTS = [
  'purchase.created', 'purchase.updated', 'purchase.invoked', 'purchase.revoked',
  'subscription.renewed', 'subscription.updated', 'subscription.made_active',
  'subscription.canceled', 'subscription.completed',
];

// ── pure helpers (tested in scripts/surecart-setup.test.js) ─────────────────

/** `https://store.ies.org/product/<slug>/` → `<slug>`. */
export function slugFromStoreUrl(url) {
  if (!url) return null;
  try {
    const m = /^\/product\/([^/]+)\/?$/.exec(new URL(url).pathname);
    return m ? decodeURIComponent(m[1]).toLowerCase() : null;
  } catch {
    return null;
  }
}

/** The store SKU ("ANSI/IES LM-49-20(R2023)") → a standard id, or null. Mirrors lib/purchases.ts. */
export function skuToStandardId(sku) {
  const raw = String(sku || '').trim();
  if (!raw) return null;
  const stripped = raw
    .replace(/\s*-\s*(?:non-?\s*member|member|lighting\s+only)\s*$/i, '')   // "…-MEMBER", "…-Lighting Only"
    .replace(/\s*\(\s*R\s*\d{2,4}\s*\)\s*$/i, '')                            // "(R2023)", "(R25)"
    .replace(/^(?:ANSI\s*\/\s*)?IES(?:\s*\/\s*[A-Z]{2,8})*\s+/i, '')          // "ANSI/IES ", "ANSI/IES/IUVA "
    .trim();
  const id = normalizeStandardIdInput(stripped);
  if (!STANDARD_ID_RE.test(id)) return null;
  return /^[A-Z]{1,6}(?:-[A-Z]{1,6}){0,2}-\d+(?:\.\d+)?-\d{2,4}(?:\+E\d+)?$/i.test(id) ? id : null;
}

/** "RP-8-25+E2" → "RP-8-25", "LS-4-20+R2023+E1" → "LS-4-20". Mirrors lib/purchases.ts. */
function baseEdition(id) {
  return String(id).replace(/(?:\+R\d{2,4}|\(R\d{2,4}\))?(?:\+E\d+)?$/i, '');
}

/** The product slug, plus the slug without the store's "-member"/"-non-member" tail. */
function slugCandidates(slug) {
  const s = slug ? String(slug).trim().toLowerCase() : '';
  if (!s) return [];
  const bare = s.replace(/-(?:non-?member|member)$/, '');
  return bare !== s ? [s, bare] : [s];
}

/**
 * Which standard a SureCart product sells, read off the public catalogue
 * (`/api/standards` rows carry `id`, `buy_url`, `status`). Same order as the
 * Worker: lease-link slug, exact SKU, newest Active printing of the SKU's edition.
 */
export function matchProductToStandard(product, standards) {
  for (const slug of slugCandidates(product.slug)) {
    const bySlug = standards.find(s => slugFromStoreUrl(s.buy_url) === slug);
    if (bySlug) return { id: bySlug.id, via: 'lease link' };
  }
  const skuId = skuToStandardId(product.sku);
  if (!skuId) return null;
  const exact = standards.find(s => s.id.toLowerCase() === skuId.toLowerCase());
  if (exact) return { id: exact.id, via: 'sku' };
  const base = baseEdition(skuId).toLowerCase();
  const printings = standards
    .filter(s => baseEdition(s.id).toLowerCase() === base && String(s.status || 'Active') === 'Active')
    .sort((a, b) => errata(b.id) - errata(a.id));
  return printings[0] ? { id: printings[0].id, via: 'sku edition' } : null;
}
function errata(id) { const m = /\+E(\d+)$/i.exec(id); return m ? Number(m[1]) : 0; }

/**
 * Looks like the Library subscription: a recurring product whose NAME says
 * so. IES memberships (Bronze, Student, Fellow…) are recurring too and are
 * not Library subscriptions; RP-4-26 "Lighting Library Spaces" is a standard.
 */
export function looksLikeSubscriptionProduct(product) {
  return product.recurring === true && /lighting\s*library|subscription|full\s*access/i.test(String(product.name || ''));
}

/** The subscription product that also includes IES Lens ("… with IES Lens"). */
export function includesLens(product) {
  return /\bIES\s+Lens\b|\bLens\b/i.test(String(product.name || ''));
}

/**
 * The config this catalogue implies. `products` carry `prices` (expanded):
 * `{ id, amount, recurring, archived, name }`.
 */
export function suggestConfig(products, standards) {
  const leases = [];
  const subscriptions = [];
  const otherRecurring = [];
  const unmapped = [];
  for (const p of products) {
    if (p.archived) continue;
    const prices = (p.prices || []).filter(pr => !pr.archived);
    const standard = p.recurring ? null : matchProductToStandard(p, standards);
    if (standard) leases.push({ product: p, standard, prices });
    else if (looksLikeSubscriptionProduct(p)) subscriptions.push({ product: p, prices });
    else if (p.recurring) otherRecurring.push({ product: p, prices });
    else unmapped.push({ product: p, prices });
  }
  const multiPrice = leases.filter(l => l.prices.length > 1);
  return {
    leases, subscriptions, otherRecurring, unmapped, multiPrice,
    subscriptionProducts: subscriptions.map(s => s.product.id),
    lensProducts: subscriptions.filter(s => includesLens(s.product)).map(s => s.product.id),
    // Only meaningful when some standard product has several prices; then
    // every lease price must be listed, including the single-price ones.
    leasePrices: multiPrice.length > 0 ? leases.flatMap(l => l.prices.map(pr => pr.id)) : [],
  };
}

// ── SureCart API ────────────────────────────────────────────────────────────

function apiKey() {
  const key = (process.env.SURECART_API_KEY || '').trim();
  if (!key) {
    console.error('SURECART_API_KEY is not set (SureCart → Settings → Developer → API Tokens).');
    process.exit(2);
  }
  return key;
}

async function sc(method, path, { params = [], body } = {}) {
  const url = new URL(`${SURECART_API}${path}`);
  for (const [k, v] of params) url.searchParams.append(k, v);
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${apiKey()}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  if (!res.ok) throw new Error(`SureCart ${method} ${path} → ${res.status}: ${(json && (json.message || json.error)) || text.slice(0, 200)}`);
  return json;
}

async function listAll(path, params = []) {
  const out = [];
  for (let page = 1; page < 200; page++) {
    const r = await sc('GET', path, { params: [...params, ['page', String(page)], ['limit', '100']] });
    const data = Array.isArray(r?.data) ? r.data : [];
    out.push(...data);
    if (data.length < 100) break;
  }
  return out;
}

async function fetchStandards(lensBase) {
  const res = await fetch(`${lensBase.replace(/\/+$/, '')}/api/standards?status=all`);
  if (!res.ok) throw new Error(`${lensBase}/api/standards → ${res.status}`);
  const json = await res.json();
  const rows = Array.isArray(json) ? json : (json.standards || json.results || json.data || []);
  return rows.map(r => ({ id: r.id, buy_url: r.buy_url ?? r.buyUrl ?? null, status: r.status || 'Active' }));
}

function normalizeProduct(p) {
  const prices = Array.isArray(p.prices?.data) ? p.prices.data : Array.isArray(p.prices) ? p.prices : [];
  return {
    id: p.id, name: p.name || '', sku: p.sku || null, slug: p.slug || null,
    recurring: p.recurring === true, archived: p.archived === true, status: p.status || null,
    prices: prices.map(pr => ({
      id: pr.id, name: pr.name || null, amount: typeof pr.amount === 'number' ? pr.amount : null,
      recurring: pr.recurring === true, archived: pr.archived === true, interval: pr.recurring_interval || null,
    })),
  };
}

// ── commands ────────────────────────────────────────────────────────────────

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const wantJson = process.argv.includes('--json');
const money = pr => (pr.amount == null ? '?' : `$${(pr.amount / 100).toFixed(2)}`) + (pr.recurring ? `/${pr.interval || 'period'}` : '');

async function cmdProducts() {
  const lens = arg('--lens', DEFAULT_LENS);
  const [rawProducts, standards] = await Promise.all([listAll('/products', [['expand[]', 'prices']]), fetchStandards(lens)]);
  const products = rawProducts.map(normalizeProduct);
  const s = suggestConfig(products, standards);
  if (wantJson) { console.log(JSON.stringify(s, null, 2)); return; }

  console.log(`\n${products.length} products in SureCart, ${standards.length} standards in Lens (${lens})\n`);
  const tag = p => (p.status && p.status !== 'published' ? `  (${p.status})` : '');
  console.log(`── ${s.leases.length} products map to a standard (a purchase = 3-year lease) ──`);
  for (const l of s.leases) {
    console.log(`  ${l.standard.id.padEnd(16)} ← ${l.product.name}  [${l.product.sku || 'no SKU'}] via ${l.standard.via}${tag(l.product)}`);
    for (const pr of l.prices) console.log(`      price ${pr.id}  ${money(pr)}${pr.name ? `  "${pr.name}"` : ''}`);
  }
  console.log(`\n── ${s.subscriptions.length} products look like the Library subscription ──`);
  for (const x of s.subscriptions) {
    console.log(`  ${x.product.id}  ${x.product.name}${includesLens(x.product) ? '  [includes IES Lens]' : ''}${tag(x.product)}`);
    for (const pr of x.prices) console.log(`      price ${pr.id}  ${money(pr)}`);
  }
  console.log(`\n── ${s.otherRecurring.length} other recurring products (memberships etc. — not Library subscriptions, grant nothing) ──`);
  for (const x of s.otherRecurring) console.log(`  ${x.product.id}  ${x.product.name}${tag(x.product)}`);
  console.log(`\n── ${s.unmapped.length} products map to nothing (recorded as unmapped, never granted) ──`);
  for (const x of s.unmapped) console.log(`  ${x.product.name}  [${x.product.sku || 'no SKU'}]${tag(x.product)}`);

  console.log('\n── wrangler.toml [vars] to review ──');
  console.log(`SURECART_SUBSCRIPTION_PRODUCTS = "${s.subscriptionProducts.join(',')}"`);
  console.log(`SURECART_LENS_PRODUCTS = "${s.lensProducts.join(',')}"   # the subscription product(s) that include IES Lens; empty = all of them`);
  if (s.multiPrice.length > 0) {
    console.log(`# ${s.multiPrice.length} standard product(s) carry more than one price — ONLY the lease price may grant.`);
    console.log('# Remove the PDF/print price ids from this list before setting it:');
    console.log(`SURECART_LEASE_PRICES = "${s.leasePrices.join(',')}"`);
    for (const l of s.multiPrice) console.log(`#   ${l.standard.id}: ${l.prices.map(pr => `${pr.id} ${money(pr)}`).join(' | ')}`);
  } else {
    console.log('SURECART_LEASE_PRICES = ""   # every standard product has one price: any purchase of it is a lease');
  }
  console.log('');
}

async function cmdWebhook() {
  const url = arg('--url', DEFAULT_WEBHOOK_URL);
  const created = await sc('POST', '/webhook_endpoints', {
    body: { webhook_endpoint: { url, enabled: true, description: 'IES Lens — purchases → Lighting Library access', webhook_events: WEBHOOK_EVENTS } },
  });
  if (wantJson) { console.log(JSON.stringify(created, null, 2)); return; }
  console.log(`\nWebhook endpoint ${created.id}\n  url      ${created.url}\n  enabled  ${created.enabled}\n  events   ${(created.webhook_events || []).map(e => (typeof e === 'string' ? e : e?.event || e?.name || JSON.stringify(e))).join(', ') || '(none reported — check the dashboard)'}`);
  console.log('\nNow set the two Worker secrets (the signing secret below is shown ONCE here; it is also in the SureCart dashboard):');
  console.log(`  printf '%s' '${created.signing_secret}' | npx wrangler secret put SURECART_WEBHOOK_SECRET`);
  console.log(`  printf '%s' "$SURECART_API_KEY" | npx wrangler secret put SURECART_API_KEY\n`);
}

async function cmdEndpoints() {
  const rows = await listAll('/webhook_endpoints');
  if (wantJson) { console.log(JSON.stringify(rows, null, 2)); return; }
  if (rows.length === 0) { console.log('No webhook endpoints on this SureCart account.'); return; }
  for (const e of rows) {
    const events = (e.webhook_events || []).map(x => (typeof x === 'string' ? x : x?.event || x?.name)).filter(Boolean);
    console.log(`${e.id}  ${e.enabled ? 'enabled ' : 'DISABLED'}  ${e.url}\n   events: ${events.join(', ') || '(none)'}${e.erroring_grace_period_started_at ? `\n   ERRORING since ${new Date(e.erroring_grace_period_started_at * 1000).toISOString()}` : ''}`);
  }
}

const isMain = process.argv[1] && import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, '/')}`).href;
if (isMain) {
  const cmd = process.argv[2];
  const run = { products: cmdProducts, webhook: cmdWebhook, endpoints: cmdEndpoints }[cmd];
  if (!run) {
    console.error('usage: node scripts/surecart-setup.js products|webhook [--url URL]|endpoints [--lens URL] [--json]');
    process.exit(2);
  }
  run().catch(err => { console.error(err.message || err); process.exit(1); });
}
