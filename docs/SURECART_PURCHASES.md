# SureCart purchases → Lighting Library access

*Teams, 2026-10-26. Dan (via Manuel): "11/2: PDF sales no longer an option …
the only acquisition options for standards after 11/2 will be 'lease' or
'subscription', both of which grant access via Vitrium only." Shane: "What
should have already been built is that the purchase in SureCart just triggers
the update in Vitrium."*

Design and the reasoning behind every rule:
`docs/superpowers/specs/2026-10-26-surecart-purchases-design.md`.

## What it does

A purchase paid in the IES webstore (SureCart) becomes Lighting Library
access with no staff step:

| Product | Becomes | Where it is held |
|---|---|---|
| a standard (SKU is the designation, or the product page is the standard's lease link) | a **3-year lease** of that one standard | AuthIES `comp_grants`, `kind = documents`, `source = surecart` |
| a Lighting Library subscription (a product listed in `SURECART_SUBSCRIPTION_PRODUCTS`, or any recurring product that is not a standard) | **subscriber-level** Library access for the billing period, renewed on each SureCart renewal, plus the `full` tier in IES Lens | AuthIES `comp_grants`, `kind = subscriber`, `source = surecart`; Lens `purchases` for the tier |
| anything else (conference proceedings, a product with no mapping) | nothing — recorded as **unmapped** for staff | Lens `purchases` only |

The flow, end to end:

1. SureCart delivers a signed webhook to `POST https://lens.ies.org/api/webhooks/surecart`.
2. Lens verifies the signature (HMAC-SHA256 over `timestamp.body` with the
   endpoint's signing secret, 5-minute tolerance) and **re-reads the purchase
   from the SureCart API** with the account's API key. The webhook body is a
   trigger, never the truth.
3. The product is mapped to a standard (`standards.buy_url` slug first, SKU
   second), the row is written to `purchases` (one row per SureCart purchase
   id — the idempotency key), and the grant is pushed to AuthIES
   `POST /api/comp-grants` with `source_ref = surecart-<purchase id>`.
4. AuthIES reads that grant at login, on every hop to the Library and on
   every Vitrium authorization call; Lens reads `purchases` on every gated
   request for the subscriber tier.
5. The buyer gets one email with the Library link (lease) or the IES Lens +
   Library buttons (subscription), and the "sign in with this email / create
   a free IES account with this same address" paragraph.

Revocation follows the same road: `purchase.revoked` (refund, period end,
a revoke in SureCart) withdraws the AuthIES grant; a subscription renewal
moves the grant's end date under the same `source_ref`.

**Why AuthIES grants and not a Wicket role:** Vitrium runs in External
Services mode (no groups; AuthIES answers per person per document), and
AuthIES only ever learns roles from Wicket, whose sync replaces subscription
slugs wholesale on every pass. A purchase SureCart made is invisible to
Wicket, so it must live where AuthIES already looks: the grants table built
for comps on 2026-10-20.

## SureCart dashboard setup (whoever holds the SureCart account)

1. **API token** — SureCart → Settings → Developer → API Tokens. Read access
   to purchases, customers, products and subscriptions is enough. This is
   `SURECART_API_KEY`.
2. **Webhook endpoint** — Settings → Developer → Webhooks → Add endpoint:
   - URL: `https://lens.ies.org/api/webhooks/surecart`
   - Events: `purchase.created`, `purchase.updated`, `purchase.invoked`,
     `purchase.revoked`, `subscription.renewed`, `subscription.updated`,
     `subscription.made_active`, `subscription.canceled`,
     `subscription.completed`
   - Copy the endpoint's **signing secret**. This is `SURECART_WEBHOOK_SECRET`.
     (Each endpoint has its own; a staging endpoint gets its own secret.)
3. **Subscription product ids** — open each Lighting Library subscription
   product in SureCart and copy its id (a UUID) into
   `SURECART_SUBSCRIPTION_PRODUCTS` in `wrangler.toml` (comma-separated).
   Until this is set, only a RECURRING product that is not a standard counts
   as a subscription.
4. **Lease vs PDF** — ask Manuel whether, after 11/2, the lease is the SAME
   product (the PDF price simply disabled) or a separate price on it. If the
   product keeps a PDF or print price, list the lease price ids in
   `SURECART_LEASE_PRICES`; otherwise every purchase of a standard product
   is a lease. Either way nothing before `SURECART_PURCHASES_SINCE` grants.

SureCart expects an acknowledgement within ~10 s and retries on a non-2xx
(each retry is freshly signed). The endpoint answers 500 when SureCart, D1 or
AuthIES could not be reached or refused the grant — the row keeps the error
and the retry (or any later event for that purchase) applies it; a purchase
recorded without a grant for a reason a retry cannot change (unmapped, test
mode, before the cutover, missing Vitrium id) is answered 200 so SureCart
stops.

## Lens configuration

Secrets (`wrangler secret put …`): `SURECART_WEBHOOK_SECRET`,
`SURECART_API_KEY`. The existing `COMP_GRANTS_API_SECRET` (same value as
AuthIES) is what carries the grant across.

Vars (`wrangler.toml [vars]`, defaults in `src/lib/surecart.ts`):

| Var | Default | Meaning |
|---|---|---|
| `SURECART_LEASE_DAYS` | `1096` | lease term, inclusive of the purchase day (three years incl. a leap day) |
| `SURECART_SUBSCRIPTION_DAYS` | `365` | subscription term when SureCart reports no billing period |
| `SURECART_SUBSCRIPTION_PRODUCTS` | empty | SureCart product ids that sell a Library subscription |
| `SURECART_LEASE_PRICES` | empty | SureCart PRICE ids that sell a lease. Empty = any price of a standard product. **Set it if the lease and the PDF/print are different prices of the same product** — only listed prices then grant access; the rest are recorded as `unmapped / not_a_lease` |
| `SURECART_PURCHASES_SINCE` | `2026-11-02` | purchases made before this day are recorded but never granted (they bought a PDF); the 11/2 cutover |
| `SURECART_ACCEPT_TEST_MODE` | `off` | `on` lets `live_mode: false` checkouts grant access — staging only |
| `SURECART_NOTIFY` | `on` | `off` stops the buyer email |

AuthIES: nothing to configure. `POST /api/comp-grants` accepts
`source: "surecart"` (window cap 1200 days instead of 730) and logs
`purchase_granted` / `purchase_revoked` in `auth_log`.

## Deploy order

1. **AuthIES** (`feat/surecart-purchase-source`): deploy. No migration.
2. **Lens**: `npm run db:migrate:remote` (migration 0024 `purchases`), set the
   two secrets, fill `SURECART_SUBSCRIPTION_PRODUCTS`, deploy.
3. **SureCart**: create the webhook endpoint (step 2 above) LAST, so the
   first delivery lands on a deployed Worker.
4. **Backfill**: /admin → Purchases → "Import from SureCart", page by page,
   for purchases made after the cutover but before the endpoint existed.
   Purchases dated before `SURECART_PURCHASES_SINCE` are recorded as
   `ignored / before_cutover` and grant nothing — the same products sold
   PDFs until 11/2. Only purchases this page has not seen cost anything;
   re-running is harmless.

## First-purchase test plan

On staging (`lens-staging.ies.org`, `SURECART_ACCEPT_TEST_MODE = "on"`,
a SureCart endpoint pointing at the staging URL):

1. In SureCart **test mode**, buy one standard product with an email that
   has an IES account (or none — the grant waits for the first sign-in).
2. /admin → Purchases: the row appears within seconds — kind `3-year lease`,
   the standard chip, window = purchase day → +3 years, "IES Auth ✓", email ✓.
3. AuthIES `auth_log`: a `purchase_granted` row for that email.
4. Sign in to the Library as that email and open the standard. In AuthIES's
   log the authorization call prints `documentId`; **confirm it equals the
   `vitrium_doc_id` Lens sent** (this is the one unverified assumption, shared
   with comps). If Vitrium sends a different id, `standards.vitrium_doc_id`
   must be re-synced from that field — the matching code already accepts
   DocumentId, DocCode and ExternalKey.
5. Refund the test purchase in SureCart → the row turns `revoked · by
   SureCart` and the Library refuses the document again.
6. Repeat with a subscription product: "Full IES Lens + Library", and IES
   Lens shows the subscriber tier for that account.

## Mapping and repair

- **Unmapped** chip on /admin → Purchases lists purchases that matched no
  standard. Fix the catalogue (Admin → Standards → Edit → "3-year lease link"
  = the product's store page, or correct the SKU in SureCart) and press
  **Resync** on the row.
- **Pending IES Auth** lists purchases whose last AuthIES call failed or
  never happened; the reason is on the row (AuthIES unreachable,
  `COMP_GRANTS_API_SECRET` unset, "No Vitrium document id synced for …"). A
  failed call is retried by the next SureCart event for that purchase on its
  own; **Resync** does it now. A row that was applied once but whose later
  push or revoke failed reads *out of date*.
- **Revoke** on a row withdraws the grant and marks it `revoked · by staff`;
  later SureCart events AND Resync leave it revoked (Resync re-applies the row
  as it stands, so it re-revokes) until **Reinstate**, which lifts the staff
  revoke and re-reads SureCart's copy (a purchase SureCart itself revoked
  comes back revoked).
- **Resync one SureCart purchase id** re-reads and re-applies a single
  purchase as it stands.
- A buyer whose SureCart email changes gets the grant moved: the old
  address's grant is withdrawn and the new one written (AuthIES keys grants
  on the email).
- `GET /api/admin/purchases.csv` exports everything.

## Known limits

- The AuthIES offline cap for a reader with several leases is the LATEST
  lease's end, not the opened document's (one `documentsExpiresAt` per
  person). Access itself is per document and exact.
- A buyer who checks out under a different email than their IES account
  holds a grant nobody can use until staff revoke it and issue a comp under
  the right address (Admin → Comp access).
- A canceled subscription stays active until its period ends — SureCart
  sends `purchase.revoked` then. A `subscription.canceled` event alone
  changes nothing, by design.
- A subscription's window is its CURRENT billing period (start and end move
  on every renewal), so a long-lived subscription never outgrows AuthIES's
  1200-day window cap.

## Phase 2 (not built)

- **Wicket mirror.** Writing a SureCart subscription into Wicket as a
  `person_memberships` entry on the Full Access tier would make IES's CRM
  count it (Dan's 546-subscriber figure lives in Wicket) and would let the
  ordinary sync carry `lighting-library-full-access`. AuthIES's Wicket client
  is read-only by policy with one approved exception; this needs IES's
  approval and the tier's UUID. The `purchases` row carries everything a
  mirror would send.
- Editing a purchase's email in /admin.

## Open with Manuel / Shane / Dan

1. Which SureCart account sells the Library subscription and its product
   id(s) → `SURECART_SUBSCRIPTION_PRODUCTS`; and whether the lease is a
   separate PRICE on the standard products → `SURECART_LEASE_PRICES`.
2. The lease term is exactly three years (webstore prototype: "3-year lease").
3. The SureCart customer email is the buyer's IES account email (the store
   is an SP of the IdP, so it should be).
4. Whether IES wants purchases mirrored into Wicket.
