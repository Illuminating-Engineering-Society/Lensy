# Lensy: IES AI-Powered Standards Assistant

**Status:** Design Phase  
**Target Launch:** Q3 2026  
**Tech Stack:** Cloudflare Workers, Vectorize, D1, Pages + Cloudflare Workers AI

---

## What is Lensy?

Lensy transforms the IES Illuminance Selector from a static lookup tool into an intelligent, conversational assistant. Named after the Latin word for "light," Lensy helps lighting professionals explore, understand, and apply IES standards through natural language search, contextual explanations, and project-based workflows.

**Key Innovation:** Search "spa lighting requirements" instead of navigating: Healthcare → Hospitals → Ambulatory Care → Spas

---

## Documentation Map

Read these documents in order, or jump to what you need:

### 📊 For Stakeholders & Leadership

**[LUCIUS_SCOPE.md § Executive Summary](LUCIUS_SCOPE.md#executive-summary)** - Executive Overview (5 min read)
- What we're building and why
- Key architectural decisions
- Business impact and success metrics
- Next steps

**Start here if:** You need to present Lensy to IES leadership or secure buy-in.

---

### 📋 For Product & Project Managers

**[LUCIUS_SCOPE.md](LUCIUS_SCOPE.md)** - Comprehensive Requirements (30 min read)
- Complete feature list (Priority 1/2/3)
- Technical architecture (AI layer, Vitrium, External API)
- Integration points (SharePoint, Wicket, Webstore)
- Constraints, risks, and open questions

**Start here if:** You're planning the project, managing timelines, or coordinating with vendors.

---

### 🎨 For Developers & Designers

**[LUCIUS_MVP_FEATURES.md](LUCIUS_MVP_FEATURES.md)** - MVP Feature Specification (45 min read)
- Detailed UI wireframes for every feature
- User workflows with examples
- Database schemas
- API endpoint definitions
- Success criteria and what's out of scope

**Start here if:** You're building features, designing UI, or writing acceptance tests.

---

### 🔧 For Implementation (Claude Code)

**[Claude.md](Claude.md)** - Technical Implementation Guide (60 min read)
- Cloudflare infrastructure setup (Workers, Vectorize, R2, D1)
- PDF ingestion pipeline
- Vector search implementation
- Code examples for all major components
- Deployment instructions

**Start here if:** You're ready to build. This is your step-by-step development guide.


---

## Quick Start

### For Non-Technical Readers
1. Read **SUMMARY.md** (5 min) to understand the vision
2. Skim **MVP_FEATURES.md** Section 1 (Search & Discovery) to see what users will experience

### For Technical Readers
1. Read **SUMMARY.md** (5 min) for context
2. Jump to **Claude.md** Section "Step 1: Set Up Cloudflare Infrastructure"
3. Reference **MVP_FEATURES.md** for specific feature requirements as you build

### For Project Managers
1. Read **SUMMARY.md** (5 min) for vision
2. Read **SCOPE.md** (30 min) for complete requirements
3. Use **MVP_FEATURES.md** to create user stories and acceptance criteria

---

## Key Decisions Made

### Architecture
- **IES owns the AI search layer** - Direct PDF indexing, independent of Vitrium
- **Vitrium = delivery infrastructure only** - SSO, DRM, deep linking
- **External API within IES infrastructure** - Never exposes Vitrium/Wicket internals
- **Deprecated standards internal-only** - Available for version comparison, excluded from external API

### Technology
- **Cloudflare-native** - Workers, Vectorize, R2, D1, Pages (serverless, edge-deployed)
- **Workers AI for embeddings** - @cf/baai/bge-base-en-v1.5 model
- **Workers AI for summaries** - Llama 3.3 with strict copyright guardrails
- **PDF.js for parsing** - Client-side and server-side PDF processing

### Scope
- **MVP: 12 weeks** - Search, projects, exports, AI summaries
- **Phase 2: Collaboration** - Team projects, sharing, version comparison
- **Phase 3: External API** - Third-party partner access (LightStanza, etc.)

---

## MVP Feature Highlights

### 1. Natural Language Search
```
"spa lighting requirements"
  → Healthcare: Spas (75 lux / 50 lux)
  → Hospitality: Hotel Spas (100 lux / 75 lux)
  → Residential: Home Spas (50 lux / 30 lux)
```

### 2. Multi-Application Queries
```
"office lobby, hallway, conference room, break room, restroom"
  → Returns all 5 applications
  → [Select All] → [Add to Project]
```

### 3. Project Management
- Create projects (name, location, client, type)
- Add applications from search (single or bulk)
- Customize per project (quantity, room names, notes)
- Override IES values if needed (with documented reasoning)

### 4. Professional Exports
- **PDF:** Lighting schedule with logo, signatures, formatted for clients
- **Excel:** Full 68-column data for calculations and modeling
- **Print-optimized:** Clean B&W views

### 5. Standard Context
- Excerpts from actual IES PDFs explaining "why these values?"
- Deep links to Vitrium for full standard access

### 6. Optional AI Summaries
- Plain-language explanations
- Copyright-compliant (<15 words per quote, 1 quote per source)
- Watermarked, requires disclaimer acknowledgment

---

## Database Overview

### Current System (Imported)
**134 applications × 68 columns**
- Hierarchical taxonomy (App → App_s1 → App_s2 ... App_s6)
- Complete illuminance data (Horizontal, Vertical, Task)
- Outdoor lighting guidance (BUG ratings, CCT, LZ)
- Standard references and mappings

### New for Lensy
**Projects Table**
- User projects with metadata (name, location, client, type)
- Status tracking (Active, Archived, Completed)

**Project Applications Table**
- Links applications to projects
- Snapshot of 68-column data (in case standard updates)
- User customizations (quantity, room names, notes, overrides)

**Vector Search Index (Cloudflare Vectorize)**
- 768-dimensional embeddings for each application
- Semantic search ("wellness center" → "spa")
- Sub-500ms query response time

---

## Success Criteria (First 90 Days)

### User Adoption
- 500+ searches
- 100+ projects created
- 50+ exports (PDF/Excel)

### Search Quality
- 90%+ relevant results (manual audit)
- Average 3+ applications per project

### Technical Performance
- <500ms search response time
- <2s PDF generation
- 99.9% uptime

### Business Impact
- 20% increase in Vitrium document views
- 10% increase in IES memberships
- >4.0/5.0 user satisfaction rating

---

## Development Timeline

**Weeks 1-2:** Data & Infrastructure  
**Weeks 3-4:** Search & Results  
**Weeks 5-6:** Projects Core  
**Weeks 7-8:** Export & Deliverables  
**Weeks 9-10:** AI & Polish  
**Weeks 11-12:** Testing & Launch  

---

## Out of Scope for MVP

- Mobile app (web-responsive only)
- Offline mode
- Integration with lighting design software (AGi32, Dialux)
- BIM/Revit plugins
- Multi-language support (English only)
- Conversational AI chatbot (search only)
- Energy modeling calculations

These may come in future phases based on user feedback.

---

## Getting Started

### To Review the Design
1. Read **SUMMARY.md** for overview
2. Read **MVP_FEATURES.md** Section 1-4 for core features
3. Provide feedback on feature priorities or UI wireframes

### To Start Building
1. Review **Claude.md** infrastructure setup
2. Set up Cloudflare account with Workers, Vectorize, R2, D1
3. Import 68-column database from Excel export
4. Follow step-by-step implementation guide

### To Test Current System
1. Visit idt.ies.org
2. Navigate: Healthcare → Hospitals → Spas
3. Note the current workflow (category browsing, filters, results)
4. Compare to proposed Lensy workflow in MVP_FEATURES.md

---

## Launch Operations Checklist

Run through this before every production deploy (added July 2026 with the
search/UX overhaul):

1. **Apply D1 migrations** — `npm run db:migrate:remote`
   (0006 adds `applications.Footnote_Marks` + per-standard index-coverage stats;
   0008 adds the invitation-email status columns. Invites and their emails still
   work without 0008 — the status write is caught and logged — but the dashboard
   then shows every row as "not sent", so apply it.
   0009 adds `standards.reference_markers_json` and the `definitions` table.
   Without it, Reference chips keep linking to the References page instead of
   the citing page (DO31.4) and the Definitions filter returns nothing (DO33).
   0010 turns Projects into Saved Search Collections (DO37) and adds the Table of
   Contents metadata columns (DO35).
   0011 adds `standards.sections_json`, the section-number → section-title map a
   body excerpt needs to print "3.3.4 Design Guide › … › Circulation Areas"
   (DO40). Unlike 0010 this one is safe to apply late: the column is read only
   for the standards in a result set, and an excerpt without it prints its
   section number alone, exactly as before. It is written by the ingest, so
   applying the migration is necessary but not sufficient — re-ingest too.

   **0010 must be applied BEFORE the Worker that expects it is deployed, not
   after.** `GET /api/standards` (the list route) selects `collection`,
   `thumbnail_url`, `buy_url` and `elearning_json` in one statement, so on a
   database without them D1 raises `no such column: collection` and the endpoint
   answers **500** — not a degraded list, no list at all. That takes the whole
   Table of Contents page down and blanks every standards picker, while search
   keeps working, which makes it look like an unrelated fault. Observed in
   production on 2026-08-04: Worker current, migration behind, `/api/standards`
   returning 500. `npm run verify:feedback` reports this state explicitly.)
2. **Set the API secret** — `wrangler secret put LUCIUS_API_SECRET`.
   This is the **machine** credential: scripts and cron authenticate to
   `/api/ingest*` and `/api/admin/*` with it, and a bearer presented in
   production while it is unset **fails closed**. Give the same value to the
   ingestion machine via the `LUCIUS_API_SECRET` env var so `npm run ingest`
   can authenticate. Humans never type it — staff reach `/admin/*` through IES
   sign-in with the `administrator` role (docs/SSO_INTEGRATION.md).
3. **Create Vectorize metadata indexes** (once, before ingesting):
   ```
   wrangler vectorize create-metadata-index ies-standards-vectors --property-name=standard_code --type=string
   wrangler vectorize create-metadata-index ies-standards-vectors --property-name=chunk_type --type=string
   ```
   Filters only apply to vectors inserted *after* the index exists — re-ingest
   if these were created late.
4. **Re-ingest the corpus** — `npm run ingest`. This now records per-standard
   coverage stats, tags References-section entries (`chunk_type=reference`,
   powering the References search mode), captures footnote placement
   (`Footnote_Marks`), and deletes stale tail vectors on shrinking re-ingests.
   Watch for `⚠ LOW COVERAGE` warnings in the output.

   **A re-ingest is REQUIRED for the 260729 feedback round** — four of those
   fixes are ingest-side and do nothing to already-indexed data:
   - **DO20** Lighting Zone: the extractor now keeps a zone printed as a
     hierarchy label ("Lz3 (and Lz4 curfew)") even when it sits deeper than the
     established indent grid. Verified on RP-2-20+E1: 218 of 343 rows now carry
     `Lighting_Zone`, where the currently-indexed rows carry none — which is why
     five otherwise-identical "Ramps, Stairs, and Steps · Low activity" cards
     were indistinguishable.
   - **DO23** less aggressive chunking: `targetWords` 350 → 200, `overlapWords`
     40 → 60, in **both** `src/lib/chunker.js` (the defaults) and
     `scripts/ingest-pdfs.js` `CONFIG` (which passes them explicitly — editing
     only the library leaves the pipeline on the old sizing). Measured on
     LP-3-20+E1: 484 → 586 chunks, average 164 → 135 words, so each chunk sits
     closer to a single idea. Budget ~20–25% more vectors per standard.
   - **DO30** footnotes: the "Application Task/Area Notes" heading detector now
     tolerates the truncated first word PDF extraction produces
     ("plication Task/Area Notes", RP-11-26 p. 106), and notes resolve per TABLE
     rather than per document, so Table A-2 rows stop inheriting Table A-1's
     notes.
   - **DO31.4** in-body reference markers: superscripted reference numerals are
     captured per standard and stored on the standards row.

   **The 260805 round adds two more ingest-side fixes:**
   - **DO48** document titles: the title and the full designation are now read
     off each standard's COVER PAGE (`src/lib/cover-title.js`), because the PDF
     `/Title` metadata is empty across the corpus — which is why RP-1-24 was
     showing a wrong title from the curated fallback list. The same pass reads
     "Prepared by the … Committee" and seeds the authoring credit (DO29), which
     until now waited on a Vitrium column. 62 of 66 standards yield a title and
     64 a committee; the ingest prints both per document and warns when a cover
     cannot be read (a scanned image). Until a standard is re-ingested it keeps
     its old title.
   - **DO40** section titles: `extractSectionTitles()` records every heading's
     number and printed title, and the ingest stores the map in
     `standards.sections_json` (migration 0011). Until a standard is re-ingested
     its body excerpts print the section NUMBER with no title and no parent
     chain. The ingest prints a `Section titles: N` line per document and warns
     when a document yields none. `npm run verify:ingest` reports the same thing
     across the corpus (DO40).

   Then re-index the definitions (see step 4b) and re-embed the application rows
   (`npm run ingest:apps`) so the new hierarchy reaches Vectorize.

   **What the re-ingest cleans up on its own:**
   - *Stale application rows.* The upsert is keyed on `code` = `<STDID>_<rowIndex>`,
     so an extractor change that shifts row numbering used to leave the tail of
     the previous parse live in D1 (`Active = 1`) — and `ingest:apps` faithfully
     re-embedded it, so old parse data kept showing up in search as ordinary
     illuminance rows. Every ingest now ends by declaring the complete set of
     codes it produced (`POST /api/ingest/applications/prune`); anything else on
     that standard is deleted from D1 *and* Vectorize, and the count is printed.
     The endpoint refuses an empty keep-list, so a parse that breaks cannot
     delete a standard's data. `--no-prune` opts out.
   - *Stale chunk vectors.* Ids are `<STDID>-chunk-<n>`, so a growing chunk count
     (which is what the DO23 change produces) overwrites every previous vector.
     Shrinking re-ingests delete the tail, including for rows predating
     migration 0006 (`chunk_count IS NULL` → probe mode).
   - *Stale reference markers.* A document re-ingest now REPLACES
     `reference_markers_json` rather than coalescing, so a new edition under the
     same id cannot keep the previous edition's marker pages. Applications-only
     batches still leave it untouched.
   - *Retired definitions.* `ingest:definitions` prunes slugs the IES glossary no
     longer publishes (same empty-list guard).
   - *Stale R2 objects.* Two cases. A standard whose status flipped left a copy
     under the old prefix (`standards/X.pdf` **and** `deprecated/X.pdf`); each
     ingest now deletes the counterpart key. A standard renamed or dropped from
     `pdfs/` can only be found by listing the bucket, so a **whole-directory**
     run ends with a sweep against D1 (`POST /api/ingest/r2-sweep`) — the only
     moment the full set of standards that should exist is known. It **reports
     and deletes nothing** by default; add `--sweep-r2` after reading the report,
     since a raw PDF removed from R2 is not recoverable from Lensy. The sweep
     also refuses when *every* object looks orphaned (that means the standards
     table is empty or unreadable, not that the bucket is garbage) and is skipped
     when any file in the batch failed.
   - *Cached responses.* Every ingest bumps the corpus data-version, and
     `SEARCH_CACHE_SCHEMA` moved to `v8`, so no pre-existing search result or AI
     summary can be served.

   **Saved projects are protected from the above.** Application codes carry the
   source table's row number, so a re-ingest can re-point a code at a different
   application, and the prune can delete one outright. `GET /api/projects/:id` now
   reads the display fields from `project_applications.snapshot_data` — written at
   save time and, until now, never read back — so a saved schedule always shows
   the values the user saved, and returns `reindexed` / `removedFromCorpus` so the
   UI can flag an item worth re-checking. Before this, a re-numbering silently
   rewrote saved rows to a different application's values.

   **What it does NOT clean up — check these by hand:**
   - *Standards whose PDF was removed or renamed.* Their `standards` row,
     `applications` rows and chunk vectors all survive, because nothing in the
     run mentions them (the R2 sweep above covers only the PDF object).
     `node scripts/cleanup-orphan-vectors.js --scan` finds orphan chunk vectors
     whose `standard_id` is gone from D1, but not the reverse. Compare
     `GET /api/standards?status=all` against `pdfs/` and delete what no longer
     belongs.
   - *The deprecated index.* `npm run ingest` only walks `pdfs/`, so
     `VECTORIZE_DEPRECATED` keeps its existing 350-word chunks. For consistent
     version comparisons the prior editions should be re-chunked at the same
     sizing as the current ones — run `npm run ingest:deprecated` with the
     deprecated PDFs in place.

4a. **Sync the Vitrium/webstore metadata** — `npm run sync-metadata -- --csv <export.csv>`
   Populates the Vitrium doc IDs and viewer URLs, and — when the export carries
   them — the Table of Contents fields (client DO35): `Collection`, `Author`
   (the authoring committee, which also credits every search result per DO34),
   `Description`, `Thumbnail`, `Buy URL` and `eLearning`. Those six columns are
   OPTIONAL: a stock "Web Viewer URLs" export syncs exactly as before and the
   Table of Contents falls back to grouping by series, saying so on the page.
   The script prints which of them it found. Each is written only when supplied,
   so re-syncing a stock export never blanks out a richer one — and never wipes
   the hand-curated eLearning list. `--dry-run` shows what would change.

   The eLearning cell is staff-maintained ("Staff manually selects educational
   recording products"), formatted as `Title|URL` entries separated by `;` or a
   newline.

4b. **Index the ANSI/IES LS-1 definitions** — `node scripts/ingest-definitions.js`
   (client DO33). Reads the ~1,300 published definitions from the IES glossary
   REST collection, sanitizes the rich text, and indexes them as
   `chunk_type=definition` + rows in the `definitions` table. Re-run whenever IES
   publishes revised terminology; the upsert is keyed on the definition slug.
   `--dry-run` fetches and normalizes without writing. Note the client's
   expectation that this source becomes a Vitrium PDF around late 2027, at which
   point the normal ingest path replaces this script.
5. **Verify full indexing** — `GET /api/admin/index-status` (Bearer secret).
   Confirms, per standard: chunk counts, page-coverage %, chunk-type mix,
   application-row counts, and a live Vectorize spot-check that first/middle/
   last vectors exist. Ship only when the warnings list is empty (or every
   warning is understood).
5a. **Verify the client feedback round is actually live** — two scripts, and they
   answer different questions. Both are read-only and both need
   `LUCIUS_API_URL` + `LUCIUS_API_SECRET`.

   - `npm run verify:ingest` — *did the DATA get rewritten?* Six binary probes
     for the ingest-side fixes (DO20, DO23, DO30, DO31.4, DO33, DO40). A deploy
     alone cannot satisfy these: they change what gets WRITTEN, so an ingest run
     against an older deployment completes with no error and leaves the old data
     in place, and the UI then still shows the old behaviour.
   - `npm run verify:feedback` — *does a real search show the fix?* One check per
     feedback item (DO20 → DO56), each issuing live requests and asserting
     on the response the browser would receive. Every item resolves to **PASS**,
     **FAIL**, or **BLOCKED** — the last meaning the check could not be answered
     because an input it depends on is absent (a Vitrium CSV column, a probe
     standard, an unapplied migration), which the script names. The exit code is
     non-zero only on FAIL, so BLOCKED items do not gate a deploy.

     `--write` additionally exercises Saved Search Collections end to end
     (DO37): it creates two collections under throwaway user ids 990001/990002,
     saves one item of each of the four result kinds, confirms the no-contents
     rule strips smuggled excerpt text, shares, claims into the second account,
     exports the CSV, and deletes both collections in a `finally` block. Without
     it, DO37 is limited to a schema probe. `--only DO32,DO39` runs a subset;
     `--json` emits machine-readable output; `--verbose` shows the evidence for
     passes too.

     Both scripts send `debug: true` on every search so the KV response cache is
     bypassed — otherwise a check can pass on a payload cached before the fix
     shipped, which is the exact failure they exist to catch.

6. **Rate limiting** — `/api/search` is capped at 60 req/min/IP via the
   `SEARCH_RATE_LIMITER` binding in wrangler.toml (fails open if removed).
7. **Caching** — searches, embeddings, and AI Guide summaries are KV-cached;
   every ingest bumps the corpus data-version, invalidating cached responses.
   After out-of-band D1 edits, call `POST /api/admin/flush-cache`.
8. **Onboard the sender** — `lensy.ies.org` must be added to
   Cloudflare Email Service → Email Sending, or the two messages Lensy sends are
   never delivered (`E_SENDER_NOT_VERIFIED`): the access **invitation** (shown
   per row in the users dashboard) and a shared **Saved Search Collection**
   (client DO37 — `POST /api/projects/:id/email`, template in `src/lib/email.ts`).
   Subdomain only: never onboard the `ies.org` apex — it is Microsoft 365 with
   SPF `-all` and a second SPF record would break mail org-wide. See
   docs/SSO_INTEGRATION.md "Invitation email".

   The share email carries the citations, each item's Library link, a **Save
   Search to My Lensy** button (the recipient gets their own COPY — claiming
   never touches the sender's collection) and the subscribe/purchase prompts.
   It reprints **no excerpt text**, which is structural rather than a rule
   applied in the template: a saved item physically holds none (`normalizeSavedItem`
   strips it at save time), and a reference entry is the client's one explicit
   exception. Sending also shares — the claim button needs a token, so one is
   minted if the collection has none. A delivery failure returns
   `{ sent: false, error }` with HTTP 200 and the share link, and the UI offers
   the sender's own mail client as the fallback rather than losing the message.
   Verify with `node scripts/verify-feedback.js --write --email you@example.com`.
9. **Known gap — Projects auth**: the `/api/projects*` routes are anonymous
   (`user_id` is a client-supplied placeholder until Phase 3 SSO). Do not
   store confidential client information in Projects until member login
   ships; anyone who can reach the API can read/modify project records.
10. **LensyLite** (client DO53) — ships **off** (`LENSY_LITE = "off"` in
    wrangler.toml). Turning it on gives IES members WITHOUT a Lighting Library
    subscription the limited tier: the Lighting Science collection only, with
    Illuminance Tables, the AI Guide and Document Comparison locked.

    **Do not switch it on until the IdP publishes the subscription entitlement.**
    The `ies_auth` cookie carries `isMember`, `memberTier` and role slugs — none
    of which says "subscribes to the Lighting Library" today, so every member,
    the client's reviewers included, would resolve to `lite`. When the slug
    exists, set both:
    ```
    LENSY_LITE = "on"
    LENSY_SUBSCRIBER_ROLES = "<the-slug>"
    ```
    The rule lives in `src/lib/tiers.ts`; the Worker enforces it in
    `handleSearch` (content types, AI Guide, comparison, corpus scope) and the
    tier is part of the search-cache key, so a Lite answer can never be served
    to a subscriber. `npm run verify:feedback --only DO53` reports which tier a
    given credential resolves to.
11. **A shared collection is readable without an account** (client DO52) —
    `GET /api/projects/shared/:token` is deliberately outside the session gate so
    a non-subscriber can open a link that was sent to them; claiming it into an
    account is not. The token is 16 random bytes and a saved item holds citations
    and links, never excerpt text or illuminance values. If IES ever decides
    otherwise, the single guard is `isPublicSharedRead` in `src/workers/api.ts`.

---

## Questions or Feedback?

**Project Lead:** Shane Skwarek, S-FX (shane@s-fx.com)  
**IES Contacts:** Dan (Lighting Library), Colleen Harper, Olga Loukina  
**Technical Stack:** Cloudflare + Cloudflare Workers AI  

For feedback on features, priorities, or technical approach, update the relevant document and notify the project lead.

---

## Document Changelog

**v1.0 (April 3, 2026)** - Initial documentation suite
- SUMMARY: Executive overview
- SCOPE: Comprehensive requirements (Priority 1/2/3)
- MVP_FEATURES: Detailed feature specifications for first release
- ADDENDUM: Analysis of current idt.ies.org system
- Claude.md: Technical implementation guide for Cloudflare

**Next Update:** After stakeholder review and priority confirmation
