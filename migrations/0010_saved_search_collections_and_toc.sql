-- Migration: 0010_saved_search_collections_and_toc
--
-- ── DO37: Projects become shareable "Saved Search Collections" ───────────────
--
-- "Repurpose 'saved reports' to a shareable 'Saved Search' feature. Provide
--  linked references to search results, but do not reprint the excerpts in the
--  report."
--
-- The existing project_applications table can only describe an ILLUMINANCE TABLE
-- row: it is keyed on an application code and carries a 68-column snapshot. A
-- collection now has to hold all four result kinds — Documents & Annexes,
-- Illuminance Tables, References, Definitions — so each row gains the reference
-- data needed to reprint a CITATION without reprinting the content:
--
--   result_type       'body' | 'tables' | 'references' | 'definitions'
--   standard_id       the standard the item came from
--   resource_title    full designation + title, as printed on the card
--   page_number       page referenced, for the "Open in Library" deep link
--   library_url       that deep link, resolved when the item was saved
--   application_name  full hierarchy path — ONLY for illuminance-table items
--   reference_text     the bibliography entry IN FULL — ONLY for reference items
--                     (the client's single explicit exception to "do not save
--                      the contents of search results")
--
-- application_code stays NOT NULL: non-application items get a synthetic,
-- deterministic code ("reference:<hash>", "definition:<slug>", "excerpt:<std>-p<n>")
-- so the existing per-collection duplicate guard keeps working unchanged.
--
-- custom_notes is the per-item rich-text user note; projects.notes is the
-- collection-level one. Both already existed and needed no new column.
--
-- collection_type replaces project_type. project_type carries a CHECK constraint
-- limiting it to four construction categories, and the client asked for a
-- user-definable "Other" — SQLite cannot alter a CHECK, and rebuilding the table
-- risks live rows, so a free-text column supersedes it. Existing values are
-- copied across so nothing is lost.
--
-- share_token / share_expires_at already exist (added in 0001 for read-only
-- links). DO37 uses share_token for the "Save Search to My Lensy" flow, which
-- COPIES the collection into the recipient's account rather than granting access
-- to the original.

ALTER TABLE project_applications ADD COLUMN result_type TEXT DEFAULT 'tables';
ALTER TABLE project_applications ADD COLUMN standard_id TEXT;
ALTER TABLE project_applications ADD COLUMN resource_title TEXT;
ALTER TABLE project_applications ADD COLUMN page_number INTEGER;
ALTER TABLE project_applications ADD COLUMN library_url TEXT;
ALTER TABLE project_applications ADD COLUMN application_name TEXT;
ALTER TABLE project_applications ADD COLUMN reference_text TEXT;

ALTER TABLE projects ADD COLUMN collection_type TEXT;
UPDATE projects SET collection_type = project_type WHERE project_type IS NOT NULL;

-- Shared collections are looked up by token on every claim.
CREATE INDEX IF NOT EXISTS idx_projects_share_token ON projects(share_token);
CREATE INDEX IF NOT EXISTS idx_project_apps_result_type ON project_applications(result_type);

-- ── DO35: Table of Contents metadata ────────────────────────────────────────
--
-- "Generate an auto-updating Table of Contents for current standards using
--  metadata from Vitrium and/or webstore … add customizable field for each
--  standard for staff to list recommended products from the eLearning Portal."
--
-- Everything except the eLearning column comes from the Vitrium/webstore export,
-- so these are populated by scripts/sync-metadata.js from optional CSV columns
-- and are simply absent until that export carries them — the page degrades to
-- what it has rather than breaking.
--
--   collection     webstore grouping the ToC sorts and headings by
--                  ("Part 1: Lighting Science, Metrics, and Calculations")
--   thumbnail_url  cover image (Vitrium Thumbnail API)
--   buy_url        webstore product page behind the "Buy" button
--   elearning_json staff-curated list of eLearning products paired with this
--                  standard: [{"title": "...", "url": "..."}]
--                  Hand-maintained (the client: "Staff manually selects
--                  educational recording products"), so it is never overwritten
--                  by a metadata sync.
--
-- `description` already exists on standards and carries the description metadata.

ALTER TABLE standards ADD COLUMN collection TEXT;
ALTER TABLE standards ADD COLUMN thumbnail_url TEXT;
ALTER TABLE standards ADD COLUMN buy_url TEXT;
ALTER TABLE standards ADD COLUMN elearning_json TEXT;
