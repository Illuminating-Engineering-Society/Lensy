# Lensy ↔ auth.ies.org SSO Integration

Status: **Phase 1 implemented** — Lensy is a COOKIE Service Provider of the
IES Auth IDP (AuthIES repo). The whole app (UI + read API) is behind SSO
login; access is decided against the staff-managed `invited_users` allowlist.

## How it works

Lensy never talks OAuth. `lensy.ies.org` sits under `.ies.org`, so after any
IdP login the shared encrypted+signed `ies_auth` cookie is already on the
browser. Lensy verifies and decrypts it locally:

```
Browser → lensy.ies.org (no/invalid ies_auth)
        → gate shows "Sign in with IES" → /login
        → 302 auth.ies.org/login?sp=lensy&redirect_uri=https://lensy.ies.org/
        → (Wicket CAS if no IdP session) → IdP sets ies_auth on .ies.org
        → 302 back → Lensy decrypts cookie → access decision → app revealed
```

Cookie scheme (mirrored from AuthIES `src/lib/crypto.ts` — must stay in sync):
`{b64url(iv)}.{b64url(AES-256-GCM ct+tag)}.{b64url(HMAC-SHA256)}`, AES key =
SHA-256(`SESSION_ENCRYPTION_KEY`), HMAC key = `COOKIE_SIGNING_SECRET`,
encrypt-then-MAC. Payload: `sub` (Wicket personUuid), `email`, `firstName`,
`lastName`, `isMember`, `memberTier`, `iat`/`exp` (unix s), `sid`.

## Access decision (src/lib/sso.ts `decideAccess`)

1. Row in `invited_users` for the email → the row decides:
   revoked/expired deny (even for IES members); otherwise allow with the
   row's role. First login flips the row to `active` and stores `person_uuid`.
2. No row → IES members (`isMember`) get in while
   `ALLOW_MEMBERS_WITHOUT_INVITE` ≠ `"false"` (default on); everyone else is
   denied with a "request an invitation" screen.

## Pieces

| Piece | Where |
|---|---|
| SP registration (`lensy`, COOKIE, redirect allowlist) | AuthIES `scripts/seed-sps.ts` |
| Cookie verify/decrypt + access decision | `src/lib/sso.ts` (tests: `sso.test.js`) |
| `GET /api/auth/me`, `POST /api/auth/dev-login` (never in prod), read-API gate | `src/workers/session.ts` |
| `/login`, `/logout` redirects + gates on `/api/search`, `/api/applications`, `/api/standards`, `/api/projects` | `src/workers/api.ts` |
| Frontend gate (hides app, sign-in / no-access screens, user chip + Sign out) | `src/frontend/utils/auth-gate.js` (loaded first by `index.html`, `projects.html`) |
| Guest allowlist + staff dashboard | `migrations/0007_invited_users.sql`, `/admin/users`, `src/workers/users.ts` |

Staff scripts keep working: an explicit `Authorization: Bearer LUCIUS_API_SECRET`
bypasses the session gate on the read API. Admin/ingest endpoints are
unchanged (shared secret only).

## Deploy checklist

**AuthIES**
1. `npm run db:seed -- --remote` (adds the `lensy` SP row; idempotent).

**Lensy**
1. `wrangler secret put SESSION_ENCRYPTION_KEY` — SAME value as AuthIES.
2. `wrangler secret put COOKIE_SIGNING_SECRET` — SAME value as AuthIES.
3. `npm run db:migrate:remote` (if 0007 not applied yet) and `npm run deploy`.

Until both secrets are set, every visitor sees the sign-in screen and login
never completes (the cookie can't be verified) — the staff bearer still works.

## Local development

`POST /api/auth/dev-login` (only when `ENVIRONMENT` ≠ production) mints an
`ies_auth` cookie with the `.dev.vars` placeholder secrets — the gate shows a
"Dev login" button on localhost. To exercise the real redirect flow, run the
AuthIES Worker locally and set `AUTH_IDP_BASE_URL` in `.dev.vars`.

## Open decisions / next steps

- [ ] Confirm the member-bypass default (`ALLOW_MEMBERS_WITHOUT_INVITE`) with
      IES — set to `"false"` to make the allowlist authoritative for everyone.
- [ ] Replace the Projects `user_id` placeholder with the authenticated
      `person_uuid` (api.ts KNOWN GAP) and scope project queries per user.
- [ ] Optionally move the staff dashboard (`/admin/users`) from the shared
      secret to SSO role checks (`invited_users.role IN ('staff','admin')`).
