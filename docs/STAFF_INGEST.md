# Staff Dashboard: Standards Upload & Indexing

*(client request, 2026-09-10)*

> "Build out a staff dashboard that allows staff to: select an existing Standard
> (from Vitrium); upload a new version of the PDF, that will replace the
> Standard in Lensy; maintain a progress tracker with the AI reading and
> indexing the standard; give the staff an option of what to do with the old
> standard. Longer term … when a new PDF is uploaded to Lensy to be indexed, it
> should also upload it to Vitrium as a new version."

The dashboard lives at **`/admin/standards`** (`src/frontend/admin/standards.html`),
gated like `/admin/users` — the auth-gate overlay client-side, `requireAdminAccess`
(SSO `administrator` role or the `LUCIUS_API_SECRET` bearer) on every endpoint
server-side.

---

## Why the browser parses the PDF

The ingest pipeline has always been split in two:

| Half | Where it ran | Why |
|---|---|---|
| PDF → pages (pdfjs) | Node script (`scripts/ingest-pdfs.js`) | pdfjs cannot run in workerd |
| pages → chunks/tables/applications → embeddings → Vectorize → D1 | the Worker (`POST /api/ingest`) | the bindings live there |

A dashboard cannot run the Node half, but pdfjs is a **browser library first** —
so the staff member's browser takes the Node script's seat. Crucially, the
browser ships only **raw pdfjs text items** (`{str, transform, fontName, width}`
per page); every judgement — line building, column detection, superscript
markers, chunking, section titles, application extraction — runs **in the
Worker**, in the same `src/lib/` modules the Node script imports. The shared
line-building half of the old `pdf-parser.js` was extracted to
**`src/lib/pdf-pages.js`** for exactly this: the two ingest paths cannot drift,
because they are the same code.

pdfjs is vendored at `src/frontend/vendor/pdfjs/` (CSP allows `'self'` scripts
only — a CDN copy would be blocked).

## The flow

```
staff browser                              Worker (src/workers/staff-ingest.ts)
─────────────                              ────────────────────────────────────
POST /api/admin/ingest-jobs      ───────►  job row (D1 ingest_jobs, migration 0017)
POST …/:id/pdf  (raw bytes)      ───────►  R2 ingest-jobs/<id>/source.pdf
  (files >90 MB: r2-multipart, then
   POST …/:id/pdf {multipartComplete})
parse with vendored pdfjs
POST …/:id/pages  (12 pages/batch) ─────►  pages rebuilt via src/lib/pdf-pages.js,
                                           stored ingest-jobs/<id>/pages-#####.json
                                           (batch 1 establishes header/footer set)
POST …/:id/process               ───────►  cover title → structure → tables →
                                           applications → chunks → outline →
                                           captions → runDocumentIngest()
                                           (embed → Vectorize → D1) → prune
      ▲ GET …/:id every 1.5 s — the job row carries step + embed progress
POST …/:id/finalize              ───────►  old-edition disposition + staging cleanup
```

`runDocumentIngest` is the exported in-process form of `POST /api/ingest`
(`src/workers/ingest.ts`) with an `onProgress` hook, so the tracker can show
"Embedding passages (300 / 586)" instead of one opaque request. Every rule that
endpoint enforces (deprecated-over-Active refusal, applications-on-deprecated
refusal, stale-vector cleanup, the curated-field COALESCEs) applies unchanged.

## Job lifecycle

`created → uploaded → parsing → parsed → processing → indexed → complete`,
with `failed` / `cancelled` possible from any live state. The job row is both
the poll target while a run is live and the audit line afterwards
(`created_by` = the staff member's email off the SSO cookie).

**Every phase is resumable** from the job list: the PDF is in R2 from step one,
so a closed tab costs only the phase in flight — "Resume" re-downloads the
stored PDF (`GET …/:id/pdf`), re-parses, and continues. A job that failed
during `process` retries with one click (the stored page batches are still
there). Only a job that never finished its upload needs the file picked again.

## Old-edition dispositions

Chosen at job creation, applied at **finalize** — after the new edition indexed
successfully, never before:

| Disposition | What happens |
|---|---|
| **Deprecate** (default) | The RP-27/RP-8 demotion shape: old row → `status='Deprecated'`, `superseded_by` → the new id; PDF moved `standards/` → `deprecated/` in R2. The old edition's main-index vectors are **not** deleted — search filters them by live D1 status (`notDeprecated`), the same posture as the manual demotions. |
| … + *index for comparison* | Additionally creates a **follow-up job** (status `uploaded`, `pdf_key` = the moved `deprecated/<id>.pdf`) that indexes the old edition into the deprecated Vectorize index, so "what's new in …" keeps a prior edition to compare against. The dashboard offers to run it immediately. |
| **Remove entirely** | Chunk vectors (`deleteVectorRange`), application rows **and** their vectors, the standards row, and the PDF are all deleted. Confirmed twice in the UI; not recoverable from Lensy. |
| **Leave unchanged** | Nothing — staff handle it later. Also forced when the upload replaces nothing, or replaces **itself** (same id = in-place re-ingest; `runDocumentIngest` overwrites vector-id-stable). |

Same-family sanity is checked at creation (`standardFamilyOf` — dot ≠ dash, so
RP-27 ≠ RP-27.1) and surfaced as a warning, never a block.

## Endpoints

All under `requireAdminAccess`; module doc in `src/workers/staff-ingest.ts` is
the authoritative list. Summary:

```
POST /api/admin/ingest-jobs                create  { filename, standardId?, status?,
                                                     replacesId?, disposition?,
                                                     indexOldForComparison? }
GET  /api/admin/ingest-jobs[?limit=]       recent jobs
GET  /api/admin/ingest-jobs/:id            one job (the poll target)
POST /api/admin/ingest-jobs/:id/pdf        raw PDF bytes (or {multipartComplete:true})
GET  /api/admin/ingest-jobs/:id/pdf        stream the stored PDF back
POST /api/admin/ingest-jobs/:id/pages      { totalPages, pageStart, pages[], docMeta? }
POST /api/admin/ingest-jobs/:id/process    { forceStructure? }
POST /api/admin/ingest-jobs/:id/finalize
POST /api/admin/ingest-jobs/:id/cancel
```

The `standardId` is derived from the filename by the **shared**
`src/lib/standard-id.js` (`deriveStandardId` — moved out of the ingest script),
so a browser upload lands under exactly the id a CLI ingest of the same file
would have used. Staff can override it at creation.

## Limits, deliberately

- **The giant PDFs.** Raw-page JSON for a 400-page standard is fine; the
  512 MB `DG-17-05` outlier parses in the staff browser (browsers handle big
  PDFs better than a 128 MB Worker isolate ever could) and uploads via the
  multipart path automatically. If a specific file defeats the browser, the
  Node script still exists and is unchanged.
- **CPU.** `[limits] cpu_ms = 300000` in wrangler.toml gives `/process`
  headroom; billing is per CPU-ms actually used.
- **The R2 sweep never sees staging** — job objects live under `ingest-jobs/`,
  a prefix `sweepR2` does not list. Finalize/cancel delete them.
- **`/api/admin/index-status?verify=0`** is the dashboard's standards list —
  the ingest-health report (chunk counts, coverage, warnings), not the reader
  ToC.

## Deployment checklist

1. `npm run db:migrate:remote` — applies `0017_ingest_jobs.sql`.
2. `npm run deploy` — ships the Worker, the new page, and the vendored pdfjs.
3. Nothing else: no new bindings, vars or secrets.

## Longer term: pushing to Vitrium (designed, not built)

The client's end state is Lensy as the **single place** staff update a
standard: one upload here also becomes a new version of the existing Vitrium
document. The seam is ready — `standards.vitrium_doc_id` (synced from the
export) identifies the target document, and the natural place for the push is a
`vitrium` step in **finalize**, after Lensy indexing succeeded, recording the
outcome on the job row like every other step.

It is **not built**, for one hard reason: the IES Vitrium API account cannot
call the API yet. Credentials verify against docs.vitrium.com, but every API
call answers 403 "insufficient privileges" — the privilege grant for
support@ies.org is pending with Tom (Vitrium's rep), the same blocker as the
usage-reset cron. Building against an API we cannot call would be untestable
guesswork. When access lands:

1. Confirm the version-upload call in Vitrium's API docs (multipart PDF against
   the existing Doc ID — versions preserve the short code, so
   `vitrium_web_url` and every deep link survive).
2. Add the `vitrium` finalize step (fail-soft: a failed push must not undo a
   successful Lensy index; record `vitrium_error` on the job row and let staff
   retry).
3. After a successful push, refresh `thumbnail_url` (the portal's
   `LatestVersionId` changes with a new version — the cover URL must be
   re-synced, see the covers note in CLAUDE.md).

Until then the dashboard says so explicitly: update Vitrium in its admin app as
before, then `npm run sync-metadata`.
