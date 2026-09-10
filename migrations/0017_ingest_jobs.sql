-- Migration: 0017_ingest_jobs
--
-- ── Staff dashboard: standards upload + indexing tracker (client, 2026-09-10) ─
--
-- "Build out a staff dashboard that allows staff to: select an existing
--  Standard (from Vitrium); upload a new version of the PDF, that will replace
--  the Standard in Lensy; maintain a progress tracker with the AI reading and
--  indexing the standard; give the staff an option of what to do with the old
--  standard."
--
-- One row per upload-and-index run, driven from /admin/standards
-- (src/frontend/admin/standards.html) against /api/admin/ingest-jobs
-- (src/workers/staff-ingest.ts). The row is BOTH the progress tracker the page
-- polls while a run is live and the audit line afterwards — like
-- device_reset_requests, a queue entry never does the work itself; the work
-- happens in the request that updates it.
--
-- Rows are staff-facing and carry the staff member's email (created_by) for
-- attribution — the same personal-by-necessity posture as
-- device_reset_requests, and nothing about readers.

CREATE TABLE IF NOT EXISTS ingest_jobs (
  -- crypto.randomUUID(); TEXT because the id travels in URLs and R2 keys
  -- (ingest-jobs/<id>/…), never arithmetic.
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  -- Staff member's email from the SSO session, or 'staff-bearer' for scripts.
  created_by TEXT,
  -- The uploaded file's original name (what the id was derived from).
  filename TEXT NOT NULL,
  -- The id this document will be indexed under (src/lib/standard-id.js
  -- deriveStandardId, staff-overridable at creation).
  standard_id TEXT NOT NULL,
  -- 'current' → main Vectorize index; 'deprecated' → the comparison-only index
  -- (same vocabulary as POST /api/ingest).
  ingest_status TEXT NOT NULL DEFAULT 'current',
  -- The old edition this upload replaces (nullable — a brand-new standard, or a
  -- same-id re-ingest, replaces nothing).
  replaces_id TEXT,
  -- What happens to replaces_id at finalize:
  --   'deprecate' — status → Deprecated, superseded_by → standard_id, PDF moved
  --                 to the deprecated/ R2 prefix (the RP-27/RP-8 demotion shape)
  --   'delete'    — vectors + applications + standards row + PDF removed
  --   'none'      — nothing (no old standard, or same-id in-place replace)
  disposition TEXT NOT NULL DEFAULT 'none',
  -- 1 → finalize also creates a follow-up job that indexes the OLD edition into
  -- the deprecated index, so version comparison keeps working across the swap.
  index_old_for_comparison INTEGER NOT NULL DEFAULT 0,
  -- created → uploaded → parsing → parsed → processing → indexed → complete,
  -- with 'failed' and 'cancelled' possible from any live state. The dashboard
  -- resumes a job from whatever state it stalled in.
  status TEXT NOT NULL DEFAULT 'created',
  -- Finer-grained step while status='processing' (extract | embed | vectorize |
  -- cleanup | metadata | applications | prune | done) — what the tracker prints.
  step TEXT,
  -- Working state the steps share: header/footer strings from the first pages
  -- batch, cleaned PDF metadata, received-batch bookkeeping, embed progress.
  progress_json TEXT,
  page_count INTEGER,
  pages_received INTEGER NOT NULL DEFAULT 0,
  -- Where the uploaded bytes live while the job runs (ingest-jobs/<id>/source.pdf;
  -- a comparison follow-up job points at the already-moved deprecated/<id>.pdf).
  pdf_key TEXT,
  pdf_size INTEGER,
  -- The ingest outcome (chunk counts, coverage, warnings) once status reaches
  -- 'indexed', for the job history list.
  result_json TEXT,
  error TEXT
);

CREATE INDEX IF NOT EXISTS idx_ingest_jobs_created ON ingest_jobs(created_at);
CREATE INDEX IF NOT EXISTS idx_ingest_jobs_status ON ingest_jobs(status);
