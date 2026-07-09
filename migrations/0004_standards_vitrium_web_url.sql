-- Migration: 0004_standards_vitrium_web_url
-- Vitrium's web viewer uses opaque short-code URLs (https://view.protectedpdf.com/XXXXXX)
-- rather than a constructable /document/{id} pattern, so the viewer URL must be
-- stored per standard. Populated by scripts/sync-metadata.js --csv from the
-- "Web Viewer URL" column of Vitrium's document export.

ALTER TABLE standards ADD COLUMN vitrium_web_url TEXT;
