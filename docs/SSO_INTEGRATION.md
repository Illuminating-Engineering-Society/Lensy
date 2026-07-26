# Lensy ↔ auth.ies.org SSO Integration Plan

Status: **Phase 0 shipped** — invited-users allowlist + staff dashboard.
The login flow itself is not wired yet; this doc records the agreed path.

## What exists today (Phase 0)

- D1 table `invited_users` (migrations/0007_invited_users.sql) — staff-managed
  guest-access allowlist, designed as the SSO access gate: `email` is the match
  key; `person_uuid` / `last_login_at` are filled by the future SSO callback.
- API `GET/POST/PATCH/DELETE /api/admin/users` (src/workers/users.ts), behind
  the existing `LUCIUS_API_SECRET` shared-secret gate.
- Staff dashboard at `/admin/users.html` (invite single/bulk, revoke,
  reinstate, expiry for time-limited event access — Phase 4 scope in CLAUDE.md).
- Access-decision logic ready for reuse: `hasAccess()` in src/lib/invites.ts
  (invited/active and not expired → in; revoked/expired → out).

## Target architecture (Phase 1)

Lensy becomes a **Service Provider of the IES Auth IDP** (`auth.ies.org`,
AuthIES repo). The IdP authenticates against Wicket CAS and dispatches to SPs
by type: `COOKIE | OAUTH2 | JWT | SAML | EXTERNAL_SERVICE`.

**Recommended SP type: `COOKIE`.** `lensy.ies.org` lives under `.ies.org`, and
the IdP already issues an encrypted + signed `ies_auth` cookie scoped to
`.ies.org` (payload: `sub` = Wicket personUuid, `email`, `firstName`,
`lastName`, `isMember`, `memberTier`, `exp`, `iat`, `sid`). Lensy only needs to
*verify and decrypt* that cookie — no OAuth round-trips, no token storage.

Login flow:

```
Browser → lensy.ies.org (no valid ies_auth cookie)
        → 302 https://auth.ies.org/login?sp=lensy&redirect_uri=https://lensy.ies.org/…
        → (Wicket CAS if no IdP session) → IdP sets ies_auth on .ies.org
        → 302 back to lensy.ies.org → Lensy decrypts cookie → access decision
```

Access decision in Lensy after decrypting the cookie:

1. Look up `invited_users` by `email` (lowercased).
2. `hasAccess(row)` → allow; on first login: `status='active'`,
   `person_uuid = sub`, `last_login_at = now`.
3. No row → deny (or, **pending product decision**: allow any `isMember=true`
   IES member to bypass the allowlist, with invited_users reserved for
   non-member guests).

The alternative is `OAUTH2` (like the Elevate SP: authorize/token/profile),
but AuthIES's OAuth handler is currently hardcoded to Elevate's client id and
redirect URIs and would need generalizing — more moving parts for no benefit
while Lensy sits on `.ies.org`.

## Work checklist for Phase 1

**AuthIES side**
- [ ] Seed SP row: `id='lensy'`, `login_system_type='COOKIE'`,
      `config_json.allowed_redirect_uris=['https://lensy.ies.org/…']`
      (scripts/seed-sps.ts or /admin/service-providers).
- [ ] Nothing else — the COOKIE dispatch path already exists.

**Lensy side**
- [ ] Share `COOKIE_SIGNING_SECRET` + `SESSION_ENCRYPTION_KEY` with the Lensy
      Worker (`wrangler secret put`, same values as AuthIES).
- [ ] `src/lib/sso.ts`: verify/decrypt `ies_auth` (Web Crypto, mirror
      AuthIES src/lib/crypto.ts + session cookie format).
- [ ] Auth middleware: gate the UI/API routes that need identity; redirect to
      `auth.ies.org/login?sp=lensy&redirect_uri=…` when absent/expired.
- [ ] SSO callback/first-request hook: run the access decision above and
      update `invited_users`.
- [ ] Replace the Projects `user_id` placeholder (api.ts KNOWN GAP) with the
      authenticated `person_uuid`.
- [ ] Logout: link to `https://auth.ies.org/logout`.

**Open decisions**
- [ ] Do IES members (isMember=true) get in without an invite, or is the
      allowlist authoritative for everyone?
- [ ] Should the staff dashboard itself move from the shared secret to SSO
      role checks (`invited_users.role IN ('staff','admin')`) once login works?
