-- Migration 0026 (client, 2026-10-29)
--
-- tutorial_overrides — staff edits to a tutorial, made in /admin → Maintenance
-- → Tutorials. Dan: "does it simplify workflow to add fields to modify: Loom
-- Link (in case we record a complete replacement video); How-To Guides (copy/
-- paste rich text with images into a field to update as necessary)".
--
-- The tutorial LIST (slugs, sections, order) stays in
-- src/frontend/utils/tutorials-catalogue.js; a row here overrides one entry's
-- fields. A NULL column means "use the catalogue's value". guide_html is
-- sanitized server-side before it is stored, and every image it names has been
-- copied into R2 (tutorials/guides/<slug>/…) so a guide never depends on a
-- Loom CDN link that may expire.
CREATE TABLE IF NOT EXISTS tutorial_overrides (
  slug        TEXT PRIMARY KEY,
  loom_url    TEXT,
  title       TEXT,
  summary     TEXT,
  guide_html  TEXT,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by  TEXT
);
