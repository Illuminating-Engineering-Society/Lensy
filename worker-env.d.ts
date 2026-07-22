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
  }
}
