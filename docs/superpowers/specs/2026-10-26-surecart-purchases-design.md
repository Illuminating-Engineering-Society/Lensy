# SureCart purchases → Lighting Library access — design

Date: 2026-10-26. Author's calls throughout; nothing here was agreed with the
client beyond the Teams thread quoted below.

## Intent

Teams, 2026-10-26 (Dan, via Manuel): "11/2: PDF sales no longer an option …
the only acquisition options for standards after 11/2 will be 'lease' or
'subscription', both of which grant access via Vitrium only." Shane: "What
should have already been built is that the purchase in SureCart just triggers
the update in Vitrium." Nothing of the kind exists: every Lease/Purchase
button in IES Lens links to a `store.ies.org` product page, and what happens
after checkout has never reached AuthIES or Vitrium.

Vitrium runs in External Services mode: it has no groups, and on every
document open it asks AuthIES whether THIS person may open THIS document.
"Update Vitrium" therefore means "make AuthIES know about the purchase".
Today AuthIES learns of Lighting Library subscriptions only from Wicket
(membership entries with `membership_category = subscription`), and of
nothing per document except complimentary grants (`comp_grants`, built
2026-10-20).

## Goals

1. A paid lease of one standard in SureCart opens that standard in the
   Lighting Library for its term (3 years) under the buyer's IES account,
   with no staff step.
2. A paid Lighting Library subscription in SureCart gives subscriber-level
   access to the Library AND the `full` tier in IES Lens for the current
   billing period, renewed automatically on each SureCart renewal.
3. A revoked purchase (refund, cancelled subscription reaching the end of
   its period, staff revoke in SureCart) withdraws the access.
4. Staff can see every purchase IES Lens has processed, what it mapped to,
   whether AuthIES took it, and can retry, revoke, reinstate or re-sync any
   row from `/admin`; purchases made before the webhook existed can be
   imported.
5. Idempotent and replay-safe: the same SureCart event delivered twice, or
   a purchase re-synced by hand, converges on the same state.

## Non-goals (this phase)

- Writing anything to Wicket. Access does not need it (AuthIES is the
  authority Vitrium consults), and AuthIES's Wicket client is read-only by
  policy with one approved exception (registration). Mirroring purchases into
  Wicket `person_memberships` (so IES's CRM counts them) is Phase 2 and needs
  IES's approval plus the Full Access tier's UUID. The design leaves the seam:
  `purchases` rows carry everything a mirror would send.
- Configuring SureCart itself (webhook endpoint, signing secret, API token):
  that is done in the SureCart dashboard by whoever holds it; the runbook
  says exactly what to enter.
- Multi-seat / organizational licensing, downloads of previously purchased
  PDFs, the "tie them into the user profile as a downloadable" Shane
  mentioned: webstore-side.

## Anti-goals

- A test-mode SureCart checkout must never grant real access
  (`live_mode: false` is recorded and ignored unless
  `SURECART_ACCEPT_TEST_MODE = "on"`).
- A purchase of a product IES Lens cannot map to a standard must never grant
  everything "to be safe": it is recorded as `unmapped`, visible in `/admin`,
  and grants nothing until a human maps it.
- A forged or replayed webhook must never create a grant: HMAC signature
  (`x-webhook-signature` = hex HMAC-SHA256 over `${timestamp}.${rawBody}`
  with the endpoint's signing secret), timestamp within 5 minutes, and the
  purchase is then RE-READ from the SureCart API with the account's API key —
  the webhook body is a trigger, never the source of truth.
- Lens must never reach into AuthIES's D1; the only channel is the existing
  bearer-authenticated `/api/comp-grants` API.

## Where each piece lives

| Piece | Repo | Why there |
|---|---|---|
| Webhook endpoint, signature check, SureCart API client, product → standard mapping, `purchases` table, buyer email, `/admin` → Purchases tab, backfill | **Lens** | Lens holds the catalogue (`standards.buy_url` = the store permalink, `standards.vitrium_doc_id`), the AuthIES push client (`src/lib/comp-grants.ts`), the email builders and the staff dashboard. |
| The entitlement itself | **AuthIES** | `comp_grants` is already read at login, on the hop refresh and on every Vitrium webhook call. Lens pushes a row with `source = "surecart"`; AuthIES needs only to accept that source and a 3-year window. |
| Lens tier for a purchased subscription | **Lens** | `decideFor` (workers/session.ts) already lifts the tier to `full` for a live Lens comp; it now also asks the `purchases` table. |

A purchase-derived role slug in AuthIES `users.roles_json` was considered and
rejected: the Wicket membership sync replaces subscription slugs wholesale
for observed people and sweeps them for unobserved ones, and in Wicket
credential mode `roles_json` does not feed the session at all. Grants are
the one mechanism that survives the sync.

## Data

### Lens: `purchases` (migration 0024)

One row per SureCart **purchase** (SureCart's unit of entitlement: one line
of one order, carrying `product`, `price`, `customer`, optional
`subscription`, `revoked`).

| column | meaning |
|---|---|
| `id` | autoincrement |
| `surecart_purchase_id` | UNIQUE — the idempotency key |
| `surecart_order_id`, `surecart_customer_id`, `surecart_product_id`, `surecart_price_id`, `surecart_subscription_id` | as SureCart reports them (nullable where SureCart allows null) |
| `live_mode` | 0/1 |
| `email`, `name` | the SureCart customer, lowercased email |
| `product_name`, `product_sku`, `product_slug` | what SureCart printed, for staff and for mapping audits |
| `kind` | `lease` / `subscription` / `unmapped` |
| `standard_id` | `standards.id` for a lease, NULL otherwise |
| `start_date`, `end_date` | YYYY-MM-DD, inclusive (Lens's comp convention) |
| `status` | `active` / `revoked` / `ignored` |
| `revoked_reason` | `surecart` (SureCart revoked it), `staff` (revoked in /admin), `test_mode`, `unmapped` |
| `authies_applied_at`, `authies_error` | the push outcome, same contract as comp_access_grants |
| `notify_sent_at`, `notify_error` | buyer email outcome |
| `last_event_type`, `last_event_at`, `synced_at` | provenance |
| `created_at`, `updated_at` | |

Indexes: `(email, kind, status)` for the tier check; `(status)`;
`(surecart_subscription_id)` for subscription events.

### AuthIES: no migration

`comp_grants` already has `source` (default `'lens'`) inside its UNIQUE key.
Lens sends `source: "surecart"`, `source_ref: "surecart-<purchase id>"`.

## Behaviour

### Mapping a purchase (`planPurchase`, pure)

Inputs: the expanded SureCart purchase (customer, product, price,
subscription), the catalogue row matched for the product (or null), and the
config (lease days, subscription fallback days, subscription product ids,
accept-test-mode).

1. `live_mode === false` and test mode not accepted → `kind` as mapped,
   `status = ignored`, `revoked_reason = test_mode`, no grant.
2. Subscription if the product id is listed in `SURECART_SUBSCRIPTION_PRODUCTS`
   OR the purchase carries a `subscription` object whose product does not
   map to a standard. Window: start = purchase `created_at` day; end =
   `subscription.current_period_end_at` day when present, else start +
   `SURECART_SUBSCRIPTION_DAYS` (default 365).
3. Lease if the product maps to a standard. Window: start = `created_at`
   day; end = start + `SURECART_LEASE_DAYS` (default 1096 — three years
   including a leap day) minus one day, so "through that day" prints as the
   buyer's anniversary.
4. Otherwise `unmapped`: recorded, no grant, surfaced in /admin.
5. `revoked === true` (or a subscription whose `status` is `canceled` /
   `completed` with the period already ended) → `status = revoked`,
   `revoked_reason = surecart`.

Product → standard (`resolveStandardForProduct`): first by the store
permalink slug — `standards.buy_url` ends in `/product/<slug>/` and SureCart's
product has `slug`; second by SKU — SureCart `sku` normalized through the
same `normalizeStandardIdInput` the dashboard uses ("ANSI/IES RP-8-25+E2" →
`RP-8-25+E2`, "ANSI/IES LM-49-20(R2023)" → `LM-49-20`-family match on the
base edition). The slug match comes first because `buy_url` was hand-curated
on 2026-10-21 and already absorbs the store's SKU typos (LM-79, LP-42).
Deprecated editions still map (a lease of RP-8-22 is a lease of RP-8-22).

### Grant mechanics (`applyPurchase`)

- lease, active → `POST /api/comp-grants` `{email, kind: "documents",
  documents: [vitrium_doc_id], labels: [standard id], starts_at, expires_at,
  source: "surecart", source_ref, granted_by: "surecart", note: order #}`.
- subscription, active → same with `kind: "subscriber"`.
- revoked / ignored / unmapped → `POST /api/comp-grants/revoke`
  `{source: "surecart", source_ref, email}` (a no-op when nothing was pushed).
- Outcome stamped on the row (`authies_applied_at` or `authies_error`).
  A standard with no `vitrium_doc_id` → `authies_error` names it; staff fix
  the catalogue and Retry.
- First successful grant of a row → buyer email (`buildPurchaseEmail`): lease
  names the standard with its Library link and end date; subscription says
  "Subscribed through …" with Open IES Lens + Open the Library; both carry
  the "sign in with this email / create a free IES account with this same
  address" paragraph from the comp email. Never re-sent on resync.

### Events (`POST /api/webhooks/surecart`)

Handled: `purchase.created`, `purchase.updated`, `purchase.invoked`,
`purchase.revoked` → `syncPurchaseById(data.object.id)`;
`subscription.renewed`, `subscription.updated`, `subscription.made_active`,
`subscription.canceled`, `subscription.completed` → every local row with that
`surecart_subscription_id` is re-synced (first-time subscriptions arrive as
`purchase.created`, which carries the subscription id). Anything else →
`202 {ignored: type}`.

`syncPurchaseById`: fetch `/v1/purchases/<id>?expand[]=customer&expand[]=product&expand[]=price&expand[]=subscription&expand[]=initial_order`
→ `planPurchase` → upsert the row by `surecart_purchase_id` (the plan
overwrites kind/window/status; `authies_*` and `notify_*` are preserved
unless the grant changed) → `applyPurchase` when the desired grant state
differs from the stamped one, or on explicit retry.

Responses: 200 on success; 400 bad signature / stale timestamp / bad JSON
(SureCart will not usefully retry those); 500 when the SureCart API or D1
failed (SureCart retries); 503 when the webhook secret is not configured.
Processing is synchronous — SureCart waits ~10 s and the path is two
fetches plus a few D1 statements.

### Lens tier

`hasActivePurchasedSubscription(env, email)`: `SELECT 1 FROM purchases WHERE
kind='subscription' AND status='active' AND email=? AND start_date <=
date('now') AND end_date >= date('now')`, fail-closed to false. `decideFor`
lifts `decision.tier` to `full` on it exactly as for a Lens comp. Lens does
not read AuthIES's `lighting-library-comp` cookie role, same as today.

### `/admin` → Purchases

List with chips (all / active / revoked / unmapped / pending AuthIES),
search, columns Buyer · Product · Kind · Standard · Window · AuthIES · Email
· Status · Actions (Resync from SureCart, Retry push, Revoke, Reinstate);
CSV export; an "Import from SureCart" control that walks
`GET /v1/purchases?page=N&limit=100` one page per click (backfill); the
webhook URL and the mapping rules printed in the explainer so staff can
configure SureCart from the page.

Endpoints (all `requireAdminAccess`): `GET /api/admin/purchases`,
`GET /api/admin/purchases.csv`, `POST /api/admin/purchases/sync {purchase_id}`,
`POST /api/admin/purchases/import {page}`, `PATCH /api/admin/purchases/:id
{status: revoked|active} | {retry: true}`.

## Configuration

Lens secrets: `SURECART_WEBHOOK_SECRET` (the endpoint's signing secret),
`SURECART_API_KEY` (a SureCart API token with read access to purchases,
customers, products, subscriptions). Existing: `COMP_GRANTS_API_SECRET`.

Lens vars (wrangler.toml, with defaults in code): `SURECART_LEASE_DAYS`
(1096), `SURECART_SUBSCRIPTION_DAYS` (365), `SURECART_SUBSCRIPTION_PRODUCTS`
(comma-separated SureCart product ids; empty), `SURECART_ACCEPT_TEST_MODE`
("off"), `SURECART_NOTIFY` ("on").

AuthIES: `parseCompGrantInput` accepts `source` ∈ {`lens`, `surecart`}
(default `lens`) and a per-source maximum window — 730 days for `lens`,
`MAX_PURCHASE_DAYS = 1200` for `surecart`; the route uses the parsed source
for create/list/revoke; audit events `purchase_granted` / `purchase_revoked`
for the surecart source.

## What must be confirmed with Manuel / Shane / Dan (not blocking the build)

1. Which SureCart account sells the Library subscription (ies.org vs
   store.ies.org) and its product id(s) → `SURECART_SUBSCRIPTION_PRODUCTS`.
2. Whether the lease term is exactly three years (the webstore prototype says
   "3-year lease").
3. That the SureCart customer email is the buyer's IES account email (the
   store is an SP of the IdP, so it should be).
4. Whether IES wants purchases mirrored into Wicket (Phase 2).

## Known limits

- One `documentsExpiresAt` per person on the AuthIES side: Vitrium's offline
  cap for a reader with several leases is the LATEST lease's end, not the
  opened document's. Access itself is per document and exact.
- Whether Vitrium's `DocumentId` equals the export's Doc ID held in
  `standards.vitrium_doc_id` is still unverified for comps as well; the first
  real lease shows it in AuthIES's log (`documentId` on every grant).
- A buyer who checks out under a different email than their IES account gets
  a grant nobody can use until staff fix the email in /admin (edit is a
  Phase 2 nicety; today: revoke + a comp under the right address).
