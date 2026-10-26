// Hand-maintained companion to the generated worker-configuration.d.ts.
//
// Secrets are set via `wrangler secret put` and are NOT declared in
// wrangler.toml, so `wrangler types` cannot emit them. They are
// declaration-merged onto the ambient `Env` here — interfaces merge
// additively, so re-running `wrangler types` never clobbers this file.
//
// All optional: the code already treats a missing secret as a real state
// (auth.ts fails closed in production when LUCIUS_API_SECRET is absent).
export {};

declare global {
  interface Env {
    LUCIUS_API_SECRET?: string;
    VITRIUM_API_KEY?: string;
    SHAREPOINT_TOKEN?: string;
    // SSO cookie verification — SAME values as the AuthIES Worker (lib/sso.ts).
    SESSION_ENCRYPTION_KEY?: string;
    COOKIE_SIGNING_SECRET?: string;
    // Optional pair for the staging IdP (auth-staging.ies.org), used only for
    // requests arriving via lensy-staging.ies.org. Unset → the shared pair
    // above is used for both hostnames (lib/sso.ts resolveSsoSecrets).
    SESSION_ENCRYPTION_KEY_STAGING?: string;
    COOKIE_SIGNING_SECRET_STAGING?: string;
    // ── LensyLite (client DO53) ──────────────────────────────────────────────
    // "on" turns the tiering on: IES members without a Lighting Library
    // subscription get LensyLite. Anything else (including unset) → every
    // authorized visitor keeps full access, which is today's behaviour.
    LENSY_LITE?: string;
    // Comma-separated IdP role slugs that mean "subscribes to the Lighting
    // Library". Unset → the defaults in src/lib/tiers.ts. This exists because
    // the entitlement is not in the cookie yet; when it is, set it here rather
    // than editing code.
    LENSY_SUBSCRIBER_ROLES?: string;
    // ── 1-concurrent-session cap (client, 2026-09-04) ───────────────────────
    // "off" disables it; anything else (including unset) enforces one Lensy
    // seat per account, newest sign-in wins (src/lib/session-cap.ts).
    LENSY_SESSION_CAP?: string;
    // Idle minutes before an unused seat frees itself. Unset → 30.
    LENSY_SESSION_CAP_IDLE_MINUTES?: string;
    // ── Staff-only lockdown (2026-10-08) ────────────────────────────────────
    // "staff_only" | "open". The DEFAULT door when the /admin Users-tab switch
    // has never been used on this host; the switch (KV) overrides it.
    LENSY_ACCESS_MODE?: string;
    // ── Daily search cap for non-subscribers (client, 2026-09-08) ───────────
    // Searches per rolling 24h window for tiers below `full`. Unset → 20 (the
    // client's number); "off" or "0" disables metering; any positive integer
    // overrides (src/lib/search-cap.ts). Subscribers and the staff bearer are
    // never metered.
    LENSY_DAILY_SEARCH_CAP?: string;
    // ── Canonical hostname (client 9/25/26 DO#1) ────────────────────────────
    // "lens.ies.org" once the new custom domain and the IdP allowlist are live:
    // every other production hostname 301s to it (src/workers/api.ts). Unset →
    // every hostname on the Worker serves the app.
    LENSY_CANONICAL_HOST?: string;
    // ── Library links through the AuthIES Vitrium hop (client 10/09/26 #2) ──
    // "off" makes lighting.ies.org links open directly again; anything else
    // (including unset) routes them through <IdP>/sp/vitrium/sso so the first
    // click lands on the linked page (src/workers/session.ts libraryHopUrl).
    LENSY_LIBRARY_SSO_HOP?: string;
    // The static-assets binding ([assets] in wrangler.toml). The Worker runs
    // first and hands every non-API path to it.
    ASSETS?: Fetcher;
    // The Lighting Library WebViewer link for the Lighting Handbook 10th edition
    // (client 9/30/26 DO#1). Unset → the Handbook notice links the portal home.
    HANDBOOK_URL?: string;
    // ── Lighting Library error page (2026-09-04) ────────────────────────────
    // Staff inbox for device-limit reset requests submitted from
    // library-error.html. Unset → requests are still stored in
    // device_reset_requests (and exportable via /api/admin/device-resets.csv);
    // only the per-request notification email is skipped. IES has not named
    // the inbox yet — set it in wrangler.toml [vars] once they do.
    DEVICE_RESET_NOTIFY_EMAIL?: string;
    // Bearer for AuthIES's /api/comp-grants (client 10/16/26 #6) — the SAME
    // value as AuthIES's COMP_GRANTS_API_SECRET. Unset: comp grants are only
    // recorded here, and staff apply the Vitrium half by hand (pre-10/16).
    COMP_GRANTS_API_SECRET?: string;
    // ── SureCart purchases → Lighting Library access (2026-10-26) ──────────
    // The webhook endpoint's signing secret (SureCart → Developer → Webhooks).
    // Unset: POST /api/webhooks/surecart answers 503 and records nothing.
    SURECART_WEBHOOK_SECRET?: string;
    // A SureCart API token that can READ purchases, customers, products and
    // subscriptions. Unset: a webhook is acknowledged but cannot be read back,
    // so nothing is granted (the row is not even written); Import is refused.
    SURECART_API_KEY?: string;
    // Lease term in days, inclusive of the purchase day. Unset → 1096 (three
    // years incl. a leap day; the webstore prototype's "3-year lease").
    SURECART_LEASE_DAYS?: string;
    // Subscription term when SureCart reports no billing period (a one-time
    // subscription product). Unset → 365.
    SURECART_SUBSCRIPTION_DAYS?: string;
    // Comma-separated SureCart PRODUCT ids that sell a Lighting Library
    // subscription. A purchase of one is a subscription even if its slug or
    // SKU happens to match a standard. Unset/empty: only a purchase carrying a
    // SureCart subscription object (a recurring price) is a subscription.
    SURECART_SUBSCRIPTION_PRODUCTS?: string;
    // Comma-separated SureCart PRICE ids that sell a lease. Unset/empty: any
    // price of a product that maps to a standard is a lease. Set it when the
    // same product also carries a PDF or print price — only the listed prices
    // then grant access; the rest are recorded as unmapped/not_a_lease.
    SURECART_LEASE_PRICES?: string;
    // YYYY-MM-DD. Purchases made before this day are recorded but grant
    // nothing (they bought a PDF). Unset → 2026-11-02, the client's cutover.
    SURECART_PURCHASES_SINCE?: string;
    // "on" lets a test-mode (live_mode = false) purchase grant access — for
    // staging only. Anything else records the purchase as ignored/test_mode.
    SURECART_ACCEPT_TEST_MODE?: string;
    // "off" stops the buyer notification email; anything else sends it once,
    // on the first successful grant.
    SURECART_NOTIFY?: string;
  }
}
