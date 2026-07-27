# Lensy operational sharp edges

Lensy-specific gotchas around its Vectorize/D1/KV/rate-limiter bindings, distilled
from the "Launch Operations Checklist" in `README.md` and inline comments in
`src/workers/`. Read this before touching `scripts/ingest-pdfs.js`,
`src/lib/cache.ts`, `src/workers/admin.ts`, `src/workers/ingest.ts`, or
`wrangler.toml`. The README is the source of truth for the full pre-deploy
checklist — this file exists so the same facts surface for an agent working on
the code, not just a human reading docs before a deploy.

## Vectorize metadata indexes must exist before ingest

`ies-standards-vectors` has metadata indexes on `standard_code` and `chunk_type`
(see `references/vectorize/configuration.md` for the general mechanic). Cloudflare
Vectorize metadata filters **only apply to vectors inserted after the index was
created** — creating the index late does not retroactively make older vectors
filterable. If you ever see filtered search results silently missing
already-ingested content, check whether the metadata index predates that ingest;
if not, the fix is `wrangler vectorize create-metadata-index ...` followed by a
full re-ingest, not a code change.

## Ingest bumps a KV cache-version; stale caches don't self-heal on their own

`src/lib/cache.ts` keys cached search/embedding/AI-summary responses off a corpus
data-version stored in KV (`SESSIONS` binding). `npm run ingest` bumps that
version, which invalidates old cache entries going forward — but any out-of-band
D1 edit (e.g. a manual SQL fix against `ies-metadata` that doesn't go through
`scripts/ingest-pdfs.js`) does **not** bump the version and will leave stale
cached responses in place until they naturally expire. Call
`POST /api/admin/flush-cache` after any D1 edit that didn't go through ingest.

## The rate limiter fails open

`SEARCH_RATE_LIMITER` (Workers Rate Limiting API, unsafe binding) caps
`/api/search` at 60 req/min/IP. If the binding is missing or errors, Lensy's code
deliberately **fails open** (allows the request) rather than blocking search —
this is intentional so a rate-limiter misconfiguration can't take down the
public search feature, but it means a broken binding degrades silently. Don't
"fix" this by making it fail closed without discussing the tradeoff — that would
turn a rate-limiter bug into a search outage.

## Ingest/admin auth: two doors, both fail closed

`/api/ingest*` and `/api/admin/*` go through `requireAdminAccess()`
(`src/workers/session.ts`): an SSO session carrying admin rights (IdP
`administrator` role, or `invited_users.role = 'admin'`), or the
`LUCIUS_API_SECRET` bearer for scripts and cron.

The bearer is only consulted when the request actually sends an `Authorization`
header — so an unset secret never blocks a cookie-authenticated admin, but a
bearer presented in production while the secret is unset fails **closed**. That
is correct and shouldn't be changed. Locally, `wrangler dev` with no secret
accepts any bearer; use `POST /api/auth/dev-login` with
`roles: ["administrator"]` to exercise the cookie path instead.

Cookie-authenticated writes additionally require a same-origin `Origin` header
(403 `bad_origin`). Curl against these endpoints therefore needs either the
bearer or an explicit `-H "Origin: <base>"`.

## No Durable Objects yet

Lensy coordinates ingest state and caches sessions entirely through D1 + KV.
There's no Durable Objects usage today. If a future change needs strongly
consistent per-entity state (e.g. deduping concurrent ingest runs, or moving
`SESSIONS` off KV), see the `durable-objects` skill before reaching for another
KV workaround — DOs exist specifically for the coordination problems KV eventually
strains under.
