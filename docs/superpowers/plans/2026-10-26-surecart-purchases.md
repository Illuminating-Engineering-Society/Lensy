# SureCart purchases → Lighting Library access — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A lease or subscription paid in SureCart grants (and a revocation withdraws) Lighting Library access through AuthIES, with no staff step, visible and repairable from `/admin`.

**Architecture:** Lens receives the signed SureCart webhook, re-reads the purchase from the SureCart API, maps the product to a standard via the catalogue, records a `purchases` row, and pushes a `source: "surecart"` grant to AuthIES's existing `/api/comp-grants` (kind `documents` for a lease, `subscriber` for a subscription). AuthIES only learns to accept that source and a 3-year window. Lens's tier check also reads `purchases` for subscriptions.

**Tech Stack:** Cloudflare Workers (TypeScript), D1, vitest (Lens, plain Node), tsx hand-rolled checks (AuthIES), Web Crypto HMAC.

**Spec:** `docs/superpowers/specs/2026-10-26-surecart-purchases-design.md` (Lens repo). Task 1 is in the AuthIES repo (`C:\Users\alexi\OneDrive\Escritorio\S-FX Projects\AuthIES`); every other task is in Lens.

## Global Constraints

- Signature: `x-webhook-signature` is lowercase hex HMAC-SHA256 with the endpoint signing secret over `${x-webhook-timestamp}.${rawBody}`; reject if |now − timestamp| > 300 s.
- Lens dates are `YYYY-MM-DD`, inclusive at both ends; AuthIES reads a date-only `expires_at` as "through that day".
- Defaults: `SURECART_LEASE_DAYS` 1096, `SURECART_SUBSCRIPTION_DAYS` 365, `SURECART_ACCEPT_TEST_MODE` "off", `SURECART_NOTIFY` "on". AuthIES `MAX_PURCHASE_DAYS` 1200.
- `source_ref` for a purchase is `surecart-<surecart_purchase_id>`; `source` is `surecart`; `granted_by` is `surecart`.
- Never throw out of a push/email/tier read: fail-soft, stamp the error on the row.
- Test-mode purchases never grant unless `SURECART_ACCEPT_TEST_MODE = "on"`.
- Every new admin endpoint goes through `requireAdminAccess`; the webhook route is public and sits BEFORE the session-gated routes in `api.ts`.
- Copy rule: user-facing strings say "IES Lens" and "Lighting Library"; never "Lensy".

## Review Focus

1. A `purchase.created` event delivered twice (SureCart retries after a slow 200) must produce one row and one AuthIES grant — pinned in Task 8 (`syncPurchaseById` idempotence test).
2. A subscription renewal must EXTEND the AuthIES window, not stack a second grant — pinned in Task 8 (same `source_ref`, new `expires_at`).
3. A standard that exists but has no `vitrium_doc_id` must record the row with an error and grant nothing, not push an empty `documents` list — pinned in Task 8.
4. A webhook with a valid signature but a timestamp 10 minutes old must be refused — pinned in Task 3.
5. A lease purchase by an email that differs only in case from the IES account must still match — pinned in Task 6 (lowercasing on write) and Task 5 (lowercasing on read).

---

### Task 1: AuthIES accepts `source: "surecart"` and a 3-year window

**Files:**
- Modify: `src/lib/comp-grants-shape.ts:65` (constants), `:140-218` (`parseCompGrantInput`)
- Modify: `src/routes/comp-grants.ts:30` (`SOURCE`), `:58-125` (route body)
- Modify: `src/types.ts:375-397` (`AuthEventType`)
- Test: `tests/comp-grants.test.ts`

**Interfaces:**
- Produces: `parseCompGrantInput(body, now)` now returns `value.source: "lens" | "surecart"`; `MAX_PURCHASE_DAYS = 1200`; `COMP_SOURCES = ["lens","surecart"] as const`; `POST /api/comp-grants` and `POST /api/comp-grants/revoke` and `GET /api/comp-grants` take an optional `source` (body or query), default `lens`.

- [ ] **Step 1: Write the failing tests** (append to the PARSE block of `tests/comp-grants.test.ts`, using its `check` helper and `NOW`):

```ts
check("PARSE source defaults to lens",
  parseCompGrantInput({ email: "a@b.co", kind: "subscriber", days: 7 }, NOW).ok &&
  (parseCompGrantInput({ email: "a@b.co", kind: "subscriber", days: 7 }, NOW) as any).value.source, "lens");
check("PARSE unknown source refused",
  parseCompGrantInput({ email: "a@b.co", kind: "subscriber", days: 7, source: "shopify" }, NOW), { ok: false, error: "invalid_source" });
check("PARSE surecart may run 1096 days",
  parseCompGrantInput({ email: "a@b.co", kind: "documents", documents: ["doc-1"], days: 1096, source: "surecart" }, NOW).ok, true);
check("PARSE surecart capped at 1200 days",
  parseCompGrantInput({ email: "a@b.co", kind: "documents", documents: ["doc-1"], days: 1201, source: "surecart" }, NOW), { ok: false, error: "window_too_long" });
check("PARSE lens still capped at 730",
  parseCompGrantInput({ email: "a@b.co", kind: "subscriber", days: 800, source: "lens" }, NOW), { ok: false, error: "window_too_long" });
```

- [ ] **Step 2: Run** `npm run test:unit` in the AuthIES repo. Expected: the five new checks print ✗ (`source` undefined / `ok: true` for 1201).

- [ ] **Step 3: Implement** in `comp-grants-shape.ts`: `export const COMP_SOURCES = ["lens", "surecart"] as const; export type CompSource = typeof COMP_SOURCES[number]; export const MAX_PURCHASE_DAYS = 1200;` add `source: CompSource` to `CompGrantInput`; in `parseCompGrantInput` read `b.source` (undefined → `"lens"`, otherwise must be in `COMP_SOURCES` else `{ok:false, error:"invalid_source"}`), and compare the window against `source === "surecart" ? MAX_PURCHASE_DAYS : MAX_COMP_DAYS`. Update the doc comment's body shape with `source?`.

- [ ] **Step 4: Route** (`routes/comp-grants.ts`): delete the `SOURCE` const; add `function sourceOf(raw: unknown): CompSource | null` (undefined/null → `"lens"`, a listed string → it, else null). GET: `source = sourceOf(url.searchParams.get("source") ?? undefined)`, 400 `invalid_source` on null. POST create: `createCompGrants(env, parsed.value.source, parsed.value)`; audit `eventType: parsed.value.source === "surecart" ? "purchase_granted" : "comp_granted"` with `source` added to details. Revoke: `source = sourceOf(body.source)`, 400 on null, used in both target shapes; audit `purchase_revoked` / `comp_revoked`. Add `"purchase_granted" | "purchase_revoked"` to `AuthEventType` with a one-line comment.

- [ ] **Step 5: Run** `npm run test:unit && npm run typecheck`. Expected: all ✓, tsc clean.

- [ ] **Step 6: Commit** (AuthIES repo):

```bash
git add src/lib/comp-grants-shape.ts src/routes/comp-grants.ts src/types.ts tests/comp-grants.test.ts
git commit -m "feat(comp-grants): accept source=surecart with a 3-year window for webstore purchases"
```

---

### Task 2: Lens schema and configuration

**Files:**
- Create: `migrations/0024_purchases.sql`
- Modify: `worker-env.d.ts` (after `COMP_GRANTS_API_SECRET`), `wrangler.toml` `[vars]` (after `LENSY_LIBRARY_SSO_HOP`)

**Interfaces:**
- Produces: table `purchases` exactly as the spec's Data section lists (columns, types, defaults, three indexes); env keys `SURECART_WEBHOOK_SECRET?`, `SURECART_API_KEY?`, `SURECART_LEASE_DAYS?`, `SURECART_SUBSCRIPTION_DAYS?`, `SURECART_SUBSCRIPTION_PRODUCTS?`, `SURECART_ACCEPT_TEST_MODE?`, `SURECART_NOTIFY?`.

- [ ] **Step 1: Write the migration.** Header comment in the style of `0023`: what a row is, the idempotency key, the three statuses. DDL:

```sql
CREATE TABLE IF NOT EXISTS purchases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  surecart_purchase_id TEXT NOT NULL UNIQUE,
  surecart_order_id TEXT, surecart_customer_id TEXT, surecart_product_id TEXT,
  surecart_price_id TEXT, surecart_subscription_id TEXT,
  live_mode INTEGER NOT NULL DEFAULT 1,
  email TEXT NOT NULL, name TEXT,
  product_name TEXT, product_sku TEXT, product_slug TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('lease','subscription','unmapped')),
  standard_id TEXT,
  start_date TEXT NOT NULL, end_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked','ignored')),
  revoked_reason TEXT,
  authies_applied_at TEXT, authies_error TEXT,
  notify_sent_at TEXT, notify_error TEXT,
  last_event_type TEXT, last_event_at TEXT, synced_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_purchases_email_kind_status ON purchases(email, kind, status);
CREATE INDEX IF NOT EXISTS idx_purchases_status ON purchases(status);
CREATE INDEX IF NOT EXISTS idx_purchases_subscription ON purchases(surecart_subscription_id);
```

- [ ] **Step 2: Apply locally** `npm run db:migrate:local`. Expected: `0024_purchases.sql` listed as applied.

- [ ] **Step 3: Declare env keys** in `worker-env.d.ts` with a `// ── SureCart purchases (2026-10-26) ──` block (one comment line per key saying what unset means); add to `wrangler.toml [vars]`: `SURECART_LEASE_DAYS = "1096"`, `SURECART_SUBSCRIPTION_DAYS = "365"`, `SURECART_SUBSCRIPTION_PRODUCTS = ""`, `SURECART_ACCEPT_TEST_MODE = "off"`, `SURECART_NOTIFY = "on"`, with a comment naming the two secrets (`wrangler secret put SURECART_WEBHOOK_SECRET` / `SURECART_API_KEY`).

- [ ] **Step 4: Commit**

```bash
git add migrations/0024_purchases.sql worker-env.d.ts wrangler.toml
git commit -m "feat(purchases): purchases table and SureCart configuration"
```

---

### Task 3: Pure SureCart module — signature, event parsing, purchase planning

**Files:**
- Create: `src/lib/surecart.ts`
- Test: `src/lib/surecart.test.js`

**Interfaces:**
- Produces:
  - `readSurecartConfig(env: Env): SurecartConfig` → `{ leaseDays: number; subscriptionDays: number; subscriptionProducts: Set<string>; acceptTestMode: boolean; notify: boolean }` (defaults per Global Constraints; non-numeric → default).
  - `verifyWebhookSignature(secret: string, timestamp: string | null, rawBody: string, signature: string | null, nowSeconds: number): Promise<'ok' | 'missing' | 'stale' | 'mismatch'>` — Web Crypto HMAC, hex, constant-time compare, tolerance 300 s.
  - `parseWebhookEvent(json: unknown): { type: string; objectId: string; objectType: string; liveMode: boolean } | null`.
  - `SurecartPurchase` type (expanded: `id, live_mode, revoked, revoked_at, created_at, customer: {id,email,name|null}|string, product: {id,name,sku,slug,recurring}|string, price: {id}|string, subscription: {id,status,current_period_end_at, cancel_at_period_end}|string|null, initial_order: {id, number}|string|null`) and `normalizePurchase(raw: unknown): SurecartPurchase | null` (null unless `object === 'purchase'` with string id and an expanded customer email).
  - `slugFromStoreUrl(url: string | null | undefined): string | null` — `https://store.ies.org/product/<slug>/` → `<slug>`.
  - `PurchasePlan` = `{ kind: 'lease'|'subscription'|'unmapped'; standardId: string|null; startDate: string; endDate: string; status: 'active'|'revoked'|'ignored'; revokedReason: 'surecart'|'test_mode'|'unmapped'|null }`.
  - `planPurchase(p: SurecartPurchase, standard: { id: string } | null, cfg: SurecartConfig, now: Date): PurchasePlan`.
  - `dayUtc(unixSeconds: number): string`, `addDays(day: string, n: number): string` (exported for tests and the sync).

- [ ] **Step 1: Write the failing tests** `src/lib/surecart.test.js` (vitest):

```js
it('verifies the documented signature', async () => {
  const body = '{"id":"evt"}'; const ts = '1641873601';
  const sig = await hmacHex('whsec', `${ts}.${body}`); // test helper with Web Crypto
  expect(await verifyWebhookSignature('whsec', ts, body, sig, 1641873601 + 60)).toBe('ok');
  expect(await verifyWebhookSignature('whsec', ts, body, sig, 1641873601 + 600)).toBe('stale');
  expect(await verifyWebhookSignature('whsec', ts, body + ' ', sig, 1641873601)).toBe('mismatch');
  expect(await verifyWebhookSignature('whsec', null, body, sig, 1641873601)).toBe('missing');
});
it('reads defaults and overrides', () => {
  expect(readSurecartConfig({})).toEqual({ leaseDays: 1096, subscriptionDays: 365, subscriptionProducts: new Set(), acceptTestMode: false, notify: true });
  expect(readSurecartConfig({ SURECART_LEASE_DAYS: '30', SURECART_SUBSCRIPTION_PRODUCTS: 'p1, p2', SURECART_ACCEPT_TEST_MODE: 'on', SURECART_NOTIFY: 'off' }).leaseDays).toBe(30);
});
it('a lease runs 1096 days inclusive from the purchase day', () => {
  const plan = planPurchase(purchase({ created_at: Date.UTC(2026,10,2)/1000 }), { id: 'RP-8-25+E2' }, CFG, NOW);
  expect(plan).toEqual({ kind: 'lease', standardId: 'RP-8-25+E2', startDate: '2026-11-02', endDate: '2029-11-01', status: 'active', revokedReason: null });
});
it('a subscription ends on the SureCart period end', () => {
  const plan = planPurchase(purchase({ subscription: { id: 's1', status: 'active', current_period_end_at: Date.UTC(2027,10,2)/1000 } }), null, CFG, NOW);
  expect(plan.kind).toBe('subscription'); expect(plan.endDate).toBe('2027-11-02');
});
it('a listed subscription product is a subscription even when it maps to a standard', () => { /* subscriptionProducts has the product id → kind subscription */ });
it('a revoked purchase plans as revoked by surecart', () => { /* revoked:true → status revoked, revokedReason surecart */ });
it('a test-mode purchase is ignored unless accepted', () => { /* live_mode:false → status ignored, revokedReason test_mode; acceptTestMode → active */ });
it('an unmapped product grants nothing', () => { /* standard null, no subscription → kind unmapped, status ignored, revokedReason unmapped */ });
it('slugFromStoreUrl reads the permalink', () => {
  expect(slugFromStoreUrl('https://store.ies.org/product/recommended-practice-lighting-roadway-and-parking-facilities/')).toBe('recommended-practice-lighting-roadway-and-parking-facilities');
  expect(slugFromStoreUrl('https://store.ies.org/?s=RP-8')).toBeNull();
});
```

- [ ] **Step 2: Run** `npx vitest run src/lib/surecart.test.js`. Expected: FAIL, module not found.

- [ ] **Step 3: Implement `src/lib/surecart.ts`** with the signatures above. `planPurchase` order: test-mode check → subscription (listed product OR expanded subscription object present and no standard) → lease (standard present) → unmapped; then revoked overrides status when `p.revoked`, or when the subscription `status` is `canceled`/`completed` AND `current_period_end_at` is before `now`. Lease end = `addDays(start, leaseDays - 1)`; subscription end = `dayUtc(current_period_end_at)` or `addDays(start, subscriptionDays - 1)`. A canceled subscription still inside its period stays active (SureCart sends `purchase.revoked` at period end).

- [ ] **Step 4: Run** the test file. Expected: PASS.

- [ ] **Step 5: Commit** `git add src/lib/surecart.ts src/lib/surecart.test.js && git commit -m "feat(purchases): SureCart signature check and purchase planning"`

---

### Task 4: SureCart API client

**Files:**
- Create: `src/lib/surecart-api.ts`
- Test: `src/lib/surecart-api.test.js`

**Interfaces:**
- Consumes: `normalizePurchase`, `SurecartPurchase` from Task 3.
- Produces: `const SURECART_API = 'https://api.surecart.com/v1'`; `fetchPurchase(env: Env, id: string): Promise<{ok:true; purchase: SurecartPurchase} | {ok:false; error: string; status?: number}>` (GET `/purchases/<id>` with `expand[]=customer&expand[]=product&expand[]=price&expand[]=subscription&expand[]=initial_order`, `Authorization: Bearer <SURECART_API_KEY>`); `listPurchases(env, page: number, limit = 100): Promise<{ok:true; purchases: SurecartPurchase[]; hasMore: boolean} | {ok:false; error}>` (`hasMore` = `data.length === limit`); `surecartConfigured(env): boolean`. Missing key → `{ok:false, error:'SURECART_API_KEY is not set'}`. Never throws.

- [ ] **Step 1: Write the failing tests** with a `globalThis.fetch` stub recording URL + headers: the expand query is exactly the five `expand[]` params; a 404 returns `{ok:false, status:404}`; a body without `customer.email` returns `{ok:false, error:/customer/}`; `listPurchases` page 2 sends `page=2&limit=100` and reports `hasMore` false for a short page.

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.

- [ ] **Step 5: Commit** `git commit -m "feat(purchases): SureCart API client (purchases, expanded)"`

---

### Task 5: AuthIES push with a source, and the Lens tier read

**Files:**
- Modify: `src/lib/comp-grants.ts` (`callAuthies`, add two functions and one read)
- Modify: `src/workers/session.ts:65-78` (`decideFor`)
- Test: `src/lib/comp-grants.test.js` (append)

**Interfaces:**
- Produces: `purchaseSourceRef(surecartPurchaseId: string): string` → `surecart-<id>`; `pushPurchaseGrant(env, requestUrl, g: { surecartPurchaseId: string; email: string; kind: 'subscriber'|'documents'; documents: string[]; labels: string[]; startDate: string; endDate: string; note: string|null }): Promise<PushOutcome>` (body adds `source: 'surecart'`, `granted_by: 'surecart'`); `revokePurchaseGrant(env, requestUrl, surecartPurchaseId, email): Promise<PushOutcome>` (body `{source:'surecart', source_ref, email, revoked_by:'surecart'}`); `hasActivePurchasedSubscription(env, email): Promise<boolean>` (SQL per spec, lowercased email, fail-closed).

- [ ] **Step 1: Write the failing tests** (fetch stub as in `comp-access.test.js`): `pushPurchaseGrant` posts to `/api/comp-grants` with `source: 'surecart'`, `source_ref: 'surecart-p1'`, `granted_by: 'surecart'`, `expires_at: '2029-11-01'`; `revokePurchaseGrant` posts `/api/comp-grants/revoke` with `source: 'surecart'`; `hasActivePurchasedSubscription` returns true when the D1 stub returns a row for `'Buyer@X.org'` bound as `'buyer@x.org'`, false when the stub throws.

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement**; in `decideFor` add `hasActivePurchasedSubscription(env, user.email)` to the `Promise.all` and `if ((lensComp || purchasedSub) && decision.authorized) decision.tier = 'full';` with a two-line comment. **Step 4: Run** `npx vitest run src/lib/comp-grants.test.js src/workers` → PASS.

- [ ] **Step 5: Commit** `git commit -m "feat(purchases): push purchase grants to AuthIES; purchased subscription lifts the Lens tier"`

---

### Task 6: Purchases store and product → standard resolution

**Files:**
- Create: `src/lib/purchases.ts`
- Test: `src/lib/purchases.test.js`

**Interfaces:**
- Consumes: `slugFromStoreUrl`, `PurchasePlan`, `SurecartPurchase` (Task 3); `normalizeStandardIdInput` from `src/lib/standard-id.js`.
- Produces:
  - `PurchaseRow` (every column of the table).
  - `resolveStandardForProduct(db: D1Database, product: { slug: string|null; sku: string|null }): Promise<{ id: string; vitriumDocId: string|null; designation: string; title: string|null; libraryUrl: string|null } | null>` — one `SELECT id, full_designation, title, buy_url, vitrium_doc_id, vitrium_web_url FROM standards WHERE buy_url IS NOT NULL OR id = ? OR id LIKE ?`; match order: (1) `slugFromStoreUrl(buy_url) === slug`, (2) `normalizeStandardIdInput(sku without a leading 'ANSI/IES ' / 'IES ' prefix, with a trailing '(R20xx)' removed)` equals an id, (3) that normalized value's `+E#`-less base equals a row's base and the row is the newest Active printing. `libraryUrl` via `toLibraryUrlOrNull`.
  - `upsertPurchase(db, p: SurecartPurchase, plan: PurchasePlan, eventType: string|null): Promise<PurchaseRow>` — `INSERT … ON CONFLICT(surecart_purchase_id) DO UPDATE SET` every SureCart/plan column + `last_event_type`, `last_event_at`, `synced_at`, `updated_at`, preserving `authies_*` and `notify_*`; email lowercased; `RETURNING *`.
  - `findPurchaseBySurecartId(db, id)`, `findPurchaseById(db, id: number)`, `listPurchasesBySubscription(db, subscriptionId): Promise<PurchaseRow[]>`, `listPurchases(db, limit): Promise<PurchaseRow[]>`.
  - `stampAuthies(db, id: number, outcome: PushOutcome, desired: 'granted'|'revoked')` — ok: `authies_applied_at = datetime('now'), authies_error = NULL`; error: `authies_error = <msg>` (and on a revoke failure leave `authies_applied_at` untouched).
  - `stampNotify(db, id, outcome: {sent:boolean; error?:string})`, `setPurchaseStatus(db, id, status, reason)`.

- [ ] **Step 1: Write the failing tests** with the `makeDb` SQL-routed stub pattern: slug match wins over SKU; `"ANSI/IES LM-49-20(R2023)"` resolves to `LM-49-20`; `"ANSI/IES RP-8-25"` resolves to the Active `RP-8-25+E2` when no exact row; an unknown product → null; `upsertPurchase` binds the email lowercased and includes `ON CONFLICT(surecart_purchase_id)`; `stampAuthies` with `{ok:false}` writes only `authies_error`.

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.

- [ ] **Step 5: Commit** `git commit -m "feat(purchases): purchases store and product→standard resolution"`

---

### Task 7: Buyer email

**Files:**
- Modify: `src/lib/email.ts` (new section after the comp-access one)
- Test: `src/lib/email.test.js` (append; create if absent following the repo's vitest style)

**Interfaces:**
- Produces: `PurchaseEmailContext = { to: string; name: string|null; kind: 'lease'|'subscription'; document: CompAccessDocument|null; startDate: string; endDate: string; orderNumber: string|null }`; `buildPurchaseEmail(ctx): InviteEmailContent`; `sendPurchaseEmail(env, ctx): Promise<SendOutcome>` (same never-throw contract as `sendCompAccessEmail`).

- [ ] **Step 1: Write the failing tests**: lease subject is `Your 3-year lease is ready: ANSI/IES RP-8-25+E2`; body text contains the Library link, "through Nov 1, 2029", the "create a free one at ies.org with this same address" sentence and "does not include full access to IES Lens"; subscription subject is `Your Lighting Library subscription is active`; text contains "Open IES Lens" and the end date; neither contains "complimentary" or "Lensy".

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement**, reusing `emailBanner`, `paragraph`, `greeting`, `resourceButtonsHtml`, `formatExpiry`, `LIBRARY_URL`, `LENS_URL`; footer "Sent by IES Lens because of your purchase at the IES webstore (order #…) — please do not reply." **Step 4: Run** → PASS.

- [ ] **Step 5: Commit** `git commit -m "feat(purchases): buyer notification for leases and subscriptions"`

---

### Task 8: Sync and apply (the reconcile core)

**Files:**
- Create: `src/workers/surecart.ts`
- Test: `src/workers/surecart.test.js`

**Interfaces:**
- Consumes: Tasks 3–7.
- Produces:
  - `syncPurchaseById(env: Env, requestUrl: string, surecartPurchaseId: string, opts: { eventType?: string|null; force?: boolean }): Promise<SyncResult>` where `SyncResult = { ok: true; row: PurchaseRow; action: 'granted'|'revoked'|'unchanged'|'skipped' } | { ok: false; error: string; retryable: boolean }`.
  - `syncSubscription(env, requestUrl, surecartSubscriptionId, eventType): Promise<SyncResult[]>` — re-syncs every local row with that subscription id.
  - `applyPurchase(env, requestUrl, row: PurchaseRow, standard: ResolvedStandard|null, cfg): Promise<PurchaseRow>` — desired state `granted` when `status === 'active'` and kind ≠ unmapped, else `revoked`; lease with no `vitriumDocId` → stamp error `No Vitrium document id synced for <id> — set it in Admin → Standards and Retry`, no push; pushes via Task 5; on first successful grant with `cfg.notify` and `notify_sent_at` null → `sendPurchaseEmail` + `stampNotify`.
  - Decision to push: `force`, or the row's `authies_applied_at` is null, or the plan's window/kind/status changed versus the previously stored row (compare before upsert).

- [ ] **Step 1: Write the failing tests** (fetch stub routes `api.surecart.com` → fixture purchase, `auth.ies.org` → records the push; D1 stub keeps an in-memory `purchases` map keyed by `surecart_purchase_id`):
  - lease: one row, one `/api/comp-grants` POST with `kind:'documents'`, `documents:['doc-guid-rp8']`, `expires_at:'2029-11-01'`, one email sent, `action:'granted'`.
  - the same event twice → still one push, second result `action:'unchanged'`, no second email.
  - renewal: fixture subscription `current_period_end_at` moves a year → second push has the NEW `expires_at` and the same `source_ref` (`action:'granted'`).
  - `revoked:true` → one `/revoke` POST, row `status:'revoked'`, `revoked_reason:'surecart'`.
  - standard without `vitrium_doc_id` → no push, `authies_error` matches `/No Vitrium document id/`.
  - `live_mode:false` → row `status:'ignored'`, no push, no email.
  - SureCart API 500 → `{ok:false, retryable:true}`, nothing written.

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.

- [ ] **Step 5: Commit** `git commit -m "feat(purchases): reconcile a SureCart purchase into an AuthIES grant"`

---

### Task 9: Webhook endpoint and routing

**Files:**
- Modify: `src/workers/surecart.ts` (add `handleSurecartWebhook`)
- Modify: `src/workers/api.ts` (route after `/api/library/device-reset`, before `/api/covers/`)
- Test: `src/workers/surecart.test.js` (append)

**Interfaces:**
- Produces: `handleSurecartWebhook(request: Request, env: Env): Promise<Response>` — `POST /api/webhooks/surecart`. 503 `{error:'webhook_not_configured'}` when `SURECART_WEBHOOK_SECRET` unset; reads the raw body text first; 401 `{error:'bad_signature', reason}` for missing/stale/mismatch; 400 `bad_json`; `purchase.*` → `syncPurchaseById(id, {eventType: type})`; `subscription.renewed|updated|made_active|canceled|completed` → `syncSubscription`; other types → 202 `{ignored: type}`; a non-retryable sync failure → 200 with `{recorded:false, error}` (so SureCart stops retrying), a retryable one → 500.

- [ ] **Step 1: Write the failing tests**: a correctly signed `purchase.created` returns 200 and triggers one sync; a bad signature returns 401 and no fetch to SureCart; `order.paid` returns 202 ignored; unset secret returns 503.

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** + the `api.ts` route with a four-line comment (public by design; signature is the gate). **Step 4: Run** the whole suite `npm test` → PASS; `npm run typecheck` clean.

- [ ] **Step 5: Commit** `git commit -m "feat(purchases): SureCart webhook endpoint"`

---

### Task 10: Admin endpoints

**Files:**
- Create: `src/workers/purchases-admin.ts`
- Modify: `src/workers/api.ts` (routes beside comp-access)
- Test: `src/workers/purchases-admin.test.js`

**Interfaces:**
- Consumes: Task 6 store, Task 8 `syncPurchaseById`, Task 4 `listPurchases`, Task 5 push/revoke.
- Produces: `handleAdminPurchases(request, env, url)` dispatching `GET /api/admin/purchases` (`{purchases, counts:{all,active,revoked,ignored,unmapped,pendingAuthies}, note?}`, filters `status`, `q`, `limit` like comp-access, each row shaped with `standard: {id, designation, title, libraryUrl}|null`, `effective_status`), `POST /api/admin/purchases/sync {purchase_id}` → `syncPurchaseById(force:true)`, `POST /api/admin/purchases/import {page}` → `listPurchases` then sync each (never force) → `{page, processed, hasMore, errors:[…]}`, `PATCH /api/admin/purchases/:id` with `{status:'revoked'}` (staff revoke: `setPurchaseStatus(..,'revoked','staff')` + revoke push), `{status:'active'}` (reinstate: only if SureCart's copy is not revoked — re-sync with force), `{retry:true}` (re-apply). `handleAdminPurchasesCsv(request, env)` → `/api/admin/purchases.csv` with the formula-safe cell escaping comp-access uses.

- [ ] **Step 1: Write the failing tests**: no bearer → 401; list fails soft with a `note` when the table is missing; counts bucket correctly; PATCH revoke posts `/revoke` and stamps `revoked_reason:'staff'`; import page 1 syncs each listed purchase and reports `hasMore`.

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** + routes. **Step 4: Run** → PASS.

- [ ] **Step 5: Commit** `git commit -m "feat(purchases): admin endpoints — list, CSV, resync, import, revoke/reinstate/retry"`

---

### Task 11: `/admin` → Purchases tab

**Files:**
- Modify: `src/frontend/admin/index.html` (`TABS`, `activateTab` map, a new `<section id="panel-purchases">` after the comp-access section, JS block after the comp-access block)

**Interfaces:** consumes Task 10's JSON shapes.

- [ ] **Step 1: Markup**: header (Export CSV `/api/admin/purchases.csv`, Refresh); explainer box printing the webhook URL (`location.origin + '/api/webhooks/surecart'`), the events to enable, and the three mapping rules; an "Import from SureCart" row (page input, button, result line); chips (All / Active / Revoked / Ignored / Unmapped / Pending AuthIES) + search; table columns Buyer · Product · Kind · Standard · Window · AuthIES · Email · Status · Actions (Resync, Retry, Revoke/Reinstate).
- [ ] **Step 2: JS**: `loadPurchases`, `renderPurchases`, `purchaseAction(id, patch)`, `resyncPurchase(id)`, `importPurchases()` using the existing `api`, `esc`, `fmt`, `day`, toast helpers; register `['purchases','Purchases']` after `comp-access` and `purchases: loadPurchases` in the loader map.
- [ ] **Step 3: Verify** `npx wrangler dev` → open `/admin#purchases` with the local D1: the tab renders the empty state and the explainer; Import with no API key shows the "SURECART_API_KEY is not set" error inline.
- [ ] **Step 4: Commit** `git commit -m "feat(admin): Purchases tab"`

---

### Task 12: Runbook, CLAUDE.md, memory

**Files:**
- Create: `docs/SURECART_PURCHASES.md`
- Modify: `CLAUDE.md` (new dated section near the top of the Notes, like the others), `README`-style pointer not needed.

- [ ] **Step 1: Runbook** sections: What it does (one paragraph + the flow); SureCart dashboard setup (Developer → Webhooks → endpoint URL, events list verbatim, copy the signing secret; API token with read scopes); Lens secrets/vars and AuthIES's unchanged `COMP_GRANTS_API_SECRET`; deploy order (AuthIES first, then Lens migration 0024, then Lens); first-purchase test plan (SureCart test mode with `SURECART_ACCEPT_TEST_MODE=on` on staging; what to look for in AuthIES's log — `documentId`); mapping rules and how to fix an unmapped product (set `buy_url` in Admin → Standards, Resync); backfill; Phase 2 (Wicket mirror) and the open questions for Manuel/Shane/Dan.
- [ ] **Step 2: CLAUDE.md** section "SureCart purchases grant Library access (2026-10-26)" — 8–12 lines in the house style: why Lens, why grants not roles, the idempotency key, test-mode rule, what the client still owes.
- [ ] **Step 3: Commit** `git commit -m "docs: SureCart purchase runbook"`

---

## Self-review notes

- Spec coverage: goals 1–3 → Tasks 3, 5, 8, 9; goal 4 → Tasks 10, 11; goal 5 → Task 8 tests; anti-goals → Tasks 3 (test mode, signature), 8 (unmapped); configuration → Task 2; AuthIES → Task 1; docs → Task 12.
- Names used consistently: `syncPurchaseById`, `applyPurchase`, `pushPurchaseGrant`, `revokePurchaseGrant`, `hasActivePurchasedSubscription`, `resolveStandardForProduct`, `upsertPurchase`, `planPurchase`, `verifyWebhookSignature`, `readSurecartConfig`.
