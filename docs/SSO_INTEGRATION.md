# Lensy ↔ auth.ies.org SSO Integration

Status: **Phase 1 implemented, aligned to AuthIES native auth.** Lensy is a
COOKIE Service Provider of the IES Auth IDP (AuthIES repo). The whole app
(UI + read API) is behind SSO login; access is decided against the
staff-managed `invited_users` allowlist.

## How it works

Lensy never talks OAuth. `lensy.ies.org` sits under `.ies.org`, so after any
IdP login the shared encrypted+signed `ies_auth` cookie is already on the
browser. Lensy verifies and decrypts it locally:

```
Browser → lensy.ies.org (no/invalid ies_auth)
        → gate shows "Sign in with IES" → /login
        → 302 auth.ies.org/login?sp=lensy&redirect_uri=https://lensy.ies.org/<path>
        → IdP's own login form (email + password, Turnstile + CSRF)
          · credentials checked against the IdP's D1 directory (PBKDF2)
          · account never activated → IdP emails a set-password link that
            carries sp/redirect_uri, so the user still lands back here
        → IdP sets ies_auth on .ies.org
        → 302 back → Lensy decrypts cookie → access decision → app revealed
```

### What AuthIES's native-auth switch changed for Lensy

The cookie contract is unchanged (AuthIES plan §10, "Impact on Service
Providers: none") — the crypto in `src/lib/sso.ts` still mirrors AuthIES
`src/lib/crypto.ts` byte for byte. Three things did change:

| Change | Effect on Lensy |
|---|---|
| Login is a first-party form at `auth.ies.org`; the Wicket CAS leg is **deleted** (no `AUTH_MODE`, no `/oauth/callback`, no `ies-login.wicketcloud.com` in any code path) | Flow docs/comments only — Lensy's redirect is identical |
| Payload gained `roles` (lowercase IdP role slugs) | Modelled on `SsoUser`, normalized to `[]` for older cookies, returned as `user.idpRoles`. One slug is acted on: `administrator` grants Lensy admin (below) |
| Every pre-existing IES account starts `pending` and must set a password from an emailed link | Such users have no cookie at all → they reach Lensy as anonymous, so the sign-in screen explains the one-time password reset rather than erroring |

`sub` is the IdP's `users.person_uuid`: the Wicket UUID for imported accounts, a
generated UUID for IdP-local ones. Stable per account either way, so it stays
safe to persist as `invited_users.person_uuid`.

`isMember` now comes from the IdP's D1 directory (refreshed by its read-only
Wicket membership sync) instead of a per-login Wicket call. A lapsed membership
therefore stops granting the `ALLOW_MEMBERS_WITHOUT_INVITE` bypass only once
that sync lands. Guest access is unaffected — `invited_users` carries its own
expiry.

## Access decision (src/lib/sso.ts `decideAccess`)

1. Row in `invited_users` for the email → the row decides:
   revoked/expired deny (even for IES members and administrators); otherwise
   allow with the row's role. First login flips the row to `active` and stores
   `person_uuid`.
2. No row → IdP administrators get in, then IES members (`isMember`) while
   `ALLOW_MEMBERS_WITHOUT_INVITE` ≠ `"false"` (default on); everyone else is
   denied with a "request an invitation" screen.

## Admin rights (`/admin/*`, `/api/admin/*`, `/api/ingest*`)

The decision also returns an `admin` flag, surfaced as `user.isAdmin` on
`/api/auth/me`. It is true when **either**:

- the cookie's `roles` contains the IdP slug **`administrator`** — the primary
  path, since IES staff already carry it in the auth.ies.org directory and
  should not need a second grant here; or
- the email's `invited_users.role` is `admin` — the local escape hatch for an
  admin who has no IdP role.

A **revoked or expired invite row still denies**, administrator included: revoke
has to remain the way to lock an account out of Lensy without editing the IdP
directory.

Enforcement is `requireAdminAccess()` in `src/workers/session.ts`, called by
every handler in `admin.ts`, `users.ts` and `ingest.ts`. Two ways past it:

| Caller | Credential | Notes |
|---|---|---|
| Browser (staff pages) | `ies_auth` cookie with `admin` | Writes also require a same-origin `Origin` header |
| Scripts / cron / curl | `Authorization: Bearer LUCIUS_API_SECRET` | Tried first; a header that is present but wrong is a hard 401, never downgraded to a session check |

**There is no admin key to type anywhere in the UI.** `/admin/users` is gated by
`<script src="/utils/auth-gate.js" data-require-admin>` exactly like every other
page; the bearer survives only as the machine path (ingest, cleanup, CI), and
`LUCIUS_API_SECRET` is only consulted when a request actually sends an
`Authorization` header — an unset secret never blocks a cookie-authenticated
admin.

Denial bodies name the wall that was hit so the gate can say the right thing:
`authentication_required` (401, no session), `access_denied` (403, not a Lensy
user), `admin_required` (403, a real user without staff rights),
`bad_origin` (403, cookie-authenticated cross-origin write).

CSRF: `ies_auth` is `SameSite=Lax`, so a cross-site POST never carries it; the
`Origin` check on cookie-authenticated writes is the second lock. CORS is `*`
with no `Allow-Credentials`, so no other origin can make a credentialed call at
all.

## Failure modes

`getSsoState()` separates "no session" from "we can't read the session", because
they need opposite handling:

| Cookie state | `/api/auth/me` | Gate shows |
|---|---|---|
| Valid | 200 `authorized: true` | the app |
| Absent, expired, or junk | 401 | "Sign in with IES" |
| Valid but signed/encrypted with keys this Worker doesn't hold | 503 `sso_misconfigured` | "Sign-in unavailable" + Retry |
| Worker has no SSO secrets set | 503 `sso_misconfigured` | same |

The 503 path exists because bouncing to `/login` on a secret mismatch is an
infinite loop: the IdP happily re-issues the same cookie Lensy still can't
decrypt. Rotate `SESSION_ENCRYPTION_KEY` / `COOKIE_SIGNING_SECRET` on both
Workers together. The staff bearer (`Authorization: Bearer LUCIUS_API_SECRET`)
keeps working throughout.

## Pieces

| Piece | Where |
|---|---|
| SP registration (`lensy`, COOKIE, redirect allowlist, per-env) | AuthIES `scripts/seed-sps.ts` |
| Cookie verify/decrypt + failure classification + access decision | `src/lib/sso.ts` (tests: `sso.test.js`) |
| `GET /api/auth/me`, `POST /api/auth/dev-login` (never in prod), read-API gate | `src/workers/session.ts` |
| `/login`, `/logout` redirects + gates on `/api/search`, `/api/applications`, `/api/standards`, `/api/projects` | `src/workers/api.ts` |
| Frontend gate (hides app, sign-in / no-access / not-admin / misconfigured screens, user chip + Sign out) | `src/frontend/utils/auth-gate.js` (loaded first by `index.html`, `projects.html`, `admin/users.html`) |
| Admin gate on `/api/admin/*` + `/api/ingest*` | `requireAdminAccess()` in `src/workers/session.ts` |
| Guest allowlist + staff dashboard | `migrations/0007_invited_users.sql`, `/admin/users`, `src/workers/users.ts` |

Staff scripts keep working: an explicit `Authorization: Bearer LUCIUS_API_SECRET`
bypasses the session gate on both the read API and the admin/ingest endpoints.

`/login` preserves the page the visitor was on, so a deep link survives the
round-trip (including the activation detour). AuthIES's redirect allowlist
treats a registered `/` path as a prefix, so no per-page registration is needed.

## Deploy checklist

**AuthIES**
1. `npm run db:seed:remote` (adds/updates the `lensy` SP row; idempotent).

**Lensy**
1. `wrangler secret put SESSION_ENCRYPTION_KEY` — SAME value as AuthIES.
2. `wrangler secret put COOKIE_SIGNING_SECRET` — SAME value as AuthIES.
3. `npm run db:migrate:remote` (if 0007 not applied yet) and `npm run deploy`.

Until both secrets are set, every visitor sees "Sign-in unavailable" (503
`sso_misconfigured`) — not a login loop. The staff bearer still works.

## Staging

AuthIES has a staging IdP at `auth-staging.ies.org` with **its own secret pair**,
and both environments scope `ies_auth` to `.ies.org`. A given Lensy deployment
holds one pair, so it can verify exactly one IdP. To point a deployment at
staging:

1. Set `AUTH_IDP_BASE_URL = "https://auth-staging.ies.org"` and load the staging
   secret pair.
2. Deploy it to `https://lensy-staging.ies.org` and run
   `npm run db:seed:staging` in AuthIES to register that origin.

`http://localhost:8787` is registered but only validates against a
**development** IdP — AuthIES's `redirect.ts` rejects `http:` unless
`ENVIRONMENT=development`, and staging is `ENVIRONMENT=staging`.

A `[env.staging]` block in `wrangler.toml` would need its own D1/R2/KV/Vectorize
resources (wrangler does not inherit bindings into named environments); create
them before adding it.

## Local development

`POST /api/auth/dev-login` (only when `ENVIRONMENT` ≠ production) mints an
`ies_auth` cookie with the `.dev.vars` placeholder secrets — the gate shows a
"Dev login" button on localhost. It mints the same shape the IdP does, `roles`
included, so local dev exercises the production parse path. On a
`data-require-admin` page the button asks for `["member","administrator"]`, so
`/admin/users` is reachable locally; pass `roles` explicitly to test any other
combination:

```bash
curl -sc jar -X POST localhost:8787/api/auth/dev-login \
  -H 'Content-Type: application/json' \
  -d '{"email":"staffer@ies.org","roles":["user","administrator"]}'
curl -b jar localhost:8787/api/admin/users
```

To exercise the real redirect flow, run the AuthIES Worker locally
(`ENVIRONMENT=development`, `IDP_BASE_URL=http://localhost:8787`) and point
`AUTH_IDP_BASE_URL` at it. **The two repos' `.dev.vars` must carry the same
placeholder pair** or Lensy answers 503 `sso_misconfigured` on every real cookie.
They diverged once (Lensy had `dev-session-encryption-key-not-secret` while
AuthIES had 64 zeros); the shared local values are now:

```
SESSION_ENCRYPTION_KEY="0000000000000000000000000000000000000000000000000000000000000000"
COOKIE_SIGNING_SECRET="1111111111111111111111111111111111111111111111111111111111111111"
```

Verified 2026-07-26: a cookie minted by a real native login at
`auth.ies.org/login?sp=lensy` decrypts under `src/lib/sso.ts` with `sub`,
`isMember`, `memberTier` and `roles` intact.

## Open decisions / next steps

- [ ] Confirm the member-bypass default (`ALLOW_MEMBERS_WITHOUT_INVITE`) with
      IES — set to `"false"` to make the allowlist authoritative for everyone.
- [ ] Replace the Projects `user_id` placeholder with the authenticated
      `person_uuid` (api.ts KNOWN GAP) and scope project queries per user.
- [x] Move the staff dashboard (`/admin/users`) off the shared secret onto SSO
      role checks — done: IdP `administrator` or `invited_users.role = 'admin'`
      (see "Admin rights" above). `invited_users.role = 'staff'` deliberately
      does **not** confer admin; decide with IES whether it should.
- [ ] Lensy has no entitlement check: AuthIES is building `entitlement_mappings`
      for Vitrium (which tiers may read what). If Lensy access should ever be
      tier- or org-pooled rather than "any member", that table is the source.
