---
name: cloudflare
description: Cloudflare platform skill trimmed for Lensy — covers Workers, static assets, D1, KV, R2, Vectorize, and Workers AI, the exact set of Cloudflare products Lensy's wrangler.toml binds. Use for any task touching src/workers/, migrations/, or wrangler.toml. Biases towards retrieval from Cloudflare docs over pre-trained knowledge.
references:
  - workers
  - d1
  - kv
  - r2
  - vectorize
  - workers-ai
---

# Cloudflare Platform Skill (Lensy subset)

This is a trimmed copy of Cloudflare's `cloudflare` mega-skill, scoped down to only
the products Lensy actually uses. The full upstream skill covers ~60 Cloudflare
products (Zero Trust, media, IaC, real-time, etc.) — none of that applies here, so
it was cut to keep this skill small enough to stay useful in context. See
`.claude/skills/README.md` for what was left out and why.

Your knowledge of Cloudflare APIs, types, limits, and pricing may be outdated.
**Prefer retrieval over pre-training** — the references in this skill are starting
points, not source of truth.

## Retrieval Sources

Fetch the **latest** information before citing specific numbers, API signatures, or
configuration options. Do not rely on baked-in knowledge or these reference files alone.

| Source | How to retrieve | Use for |
|--------|----------------|---------|
| Cloudflare docs | `cloudflare-docs` search tool or `https://developers.cloudflare.com/` | Limits, pricing, API reference, compatibility dates/flags |
| Workers types | `node_modules/@cloudflare/workers-types` (already a devDependency) | Type signatures, binding shapes, handler types |
| Wrangler config schema | `node_modules/wrangler/config-schema.json` | Config fields, binding shapes, allowed values |
| Product changelogs | `https://developers.cloudflare.com/changelog/` | Recent changes to limits, features, deprecations |

When a reference file and the docs disagree, **trust the docs**. This is especially
important for: numeric limits, pricing tiers, type signatures, and configuration options.

## What Lensy binds (wrangler.toml) → where to look

| Binding | Product | Reference |
|---|---|---|
| (Worker entry) | Workers | `references/workers/` |
| `[assets]` (frontend) | Static Assets | `references/static-assets/` |
| `DB` | D1 (`ies-metadata`) | `references/d1/` |
| `SESSIONS` | KV (`ies-sessions`) | `references/kv/` |
| `PDFS` | R2 (`ies-standards-pdfs`) | `references/r2/` |
| `VECTORIZE` / `VECTORIZE_DEPRECATED` | Vectorize | `references/vectorize/` |
| `[ai]` | Workers AI | `references/workers-ai/` |
| `SEARCH_RATE_LIMITER` | Workers Rate Limiting API | not covered upstream — check `https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/` directly |
| general CLI usage | Wrangler | see the top-level `wrangler` skill, or `references/wrangler/` here |

See also `references/lensy-ops-checklist.md` in this folder for the operational
sharp edges specific to Lensy's ingest/cache/deploy flow (Vectorize metadata
indexes, D1 migrations + cache versioning, rate-limiter fail-open behavior).

## Product Index

| Product | Reference |
|---------|-----------|
| Workers | `references/workers/` |
| Static Assets | `references/static-assets/` |
| D1 | `references/d1/` |
| KV | `references/kv/` |
| R2 | `references/r2/` |
| Vectorize | `references/vectorize/` |
| Workers AI | `references/workers-ai/` |
| Bindings (general) | `references/bindings/` |
| Wrangler | `references/wrangler/` |
