# Cloudflare skills (curated for Lensy)

This directory is a curated, trimmed copy of content from
[`cloudflare/skills`](https://github.com/cloudflare/skills) (via
`sfxdotcom/CloudflareSkills`, a mirror of the upstream repo) — a library of Agent
Skills that teach a coding agent (Claude Code, Cursor, etc.) how to correctly
build on the Cloudflare developer platform. See `LICENSE` for the original
Apache 2.0 license; per that license, this note records what was changed.

It's checked into git (unlike the rest of `.claude/`, which stays local/ignored —
see the `!/.claude/skills/` exception in `.gitignore`) so every contributor working
on Lensy gets the same Cloudflare-aware guardrails, instead of relying on one
developer's local skill setup or the model's static training knowledge.

## What's included, and why

Only the parts relevant to what Lensy actually builds on — Lensy is a single
Cloudflare Worker binding D1, KV, R2, Vectorize, and Workers AI, with a static
frontend served via `[assets]` (see `wrangler.toml`). Nothing here needed
Zero Trust, CAPTCHA, transactional email, sandboxed code execution, the Agents
SDK class model, or a performance-audit workflow, so those upstream skills
(`cloudflare-one`, `cloudflare-one-migrations`, `turnstile-spin`,
`cloudflare-email-service`, `sandbox-sdk`, `agents-sdk`, `web-perf`) were left out.

| Skill | Included as-is? | Why |
|---|---|---|
| `wrangler/` | Yes, unmodified | CLI reference + secret-handling guidance — directly applicable since Lensy manages `LUCIUS_API_SECRET`, `VITRIUM_API_KEY`, `SHAREPOINT_TOKEN` via `wrangler secret`. |
| `workers-best-practices/` | Yes, unmodified | Anti-pattern checklist (floating promises, `ctx.waitUntil()`, global state, secrets, timing-safe comparisons) — a direct code-review reference for `src/workers/*`. |
| `durable-objects/` | Yes, unmodified | Lensy uses none today, but its KV-based session cache and ingest coordination are exactly the kind of state DOs are built for — kept as reference for that discussion, not because it's in use. |
| `cloudflare/` | **Trimmed** — see below | The upstream mega-skill indexes ~60 products; `SKILL.md` here was rewritten to a Lensy-specific decision table pointing only at the six references Lensy needs. |

`cloudflare/references/` was cut down to exactly what `wrangler.toml` binds:
`workers`, `static-assets`, `d1`, `kv`, `r2`, `vectorize`, `workers-ai`, plus
`bindings` (general) and `wrangler` (product-specific reference, distinct from
the top-level `wrangler/` skill). All of those reference files are unmodified
copies of the upstream content.

`cloudflare/references/lensy-ops-checklist.md` is new, written for this repo —
it's not from upstream. It distills the operational sharp edges already called
out informally in `README.md`'s "Launch Operations Checklist" (Vectorize
metadata-index-before-ingest, KV cache-version bumps, rate-limiter fail-open
behavior) into a reference an agent will actually load while working on
ingest/cache/deploy code, not just a checklist a human reads before deploying.

## Keeping this current

If Lensy starts using a Cloudflare product not listed above (Queues, Durable
Objects, Hyperdrive, etc.), pull the matching `references/<product>/` folder
from upstream `cloudflare/skills` and add it to the table in
`cloudflare/SKILL.md`. If Lensy drops a binding, remove the corresponding
reference folder so this stays a reflection of the real `wrangler.toml`, not a
stale wishlist.
