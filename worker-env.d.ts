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
  }
}
