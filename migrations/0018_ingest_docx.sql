-- Migration: 0018_ingest_docx
--
-- ── Dual-upload ingest: optional Word manuscript beside the PDF ──────────────
--
-- (client, 2026-09-11: "The Word doc should be responsible for feeding and
--  training the AI system on the content. The PDF should be responsible for
--  directing the page in which the content exists in that standard.")
--
-- Design: docs/DOCX_INGEST.md. The manuscript is OPTIONAL per job — the PDF
-- remains required and sufficient (deprecated editions and most of the corpus
-- have no retrievable final manuscript). When present, its structure becomes
-- the indexed text and src/lib/page-align.js stamps every chunk with the page
-- of the published PDF, which stays the citation authority.

-- Where the uploaded manuscript bytes live while the job runs
-- (ingest-jobs/<id>/source.docx — staging, swept with the rest of the job).
ALTER TABLE ingest_jobs ADD COLUMN docx_key TEXT;
ALTER TABLE ingest_jobs ADD COLUMN docx_size INTEGER;

-- The full alignment report from the last /process run (chunk located/
-- inherited counts, drift fraction, unmatched samples, uncovered PDF pages) —
-- the "not losing content" evidence, whether or not the manuscript was
-- accepted for indexing.
ALTER TABLE ingest_jobs ADD COLUMN alignment_json TEXT;
