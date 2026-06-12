-- Lensy D1 Schema — Migration 0003
-- Adds Page_Number to applications so that the search layer can attach
-- a page-relevant PDF excerpt to each application result, instead of
-- attaching a single global top-scored chunk per standard.
--
-- Without this, every application from the same standard receives the
-- same excerpt — typically a chunk from a high-scoring section that has
-- nothing to do with the specific application's table row.

ALTER TABLE applications ADD COLUMN Page_Number INTEGER;

CREATE INDEX IF NOT EXISTS idx_applications_page ON applications(Standard, Page_Number);
