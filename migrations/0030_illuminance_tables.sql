-- Migration 0030 (Dan, Teams 2026-11-09 #2) — "List Illuminance Tables"
--
-- "Add a new page called 'List Illuminance Tables' … I'm proposing an admin
--  level of control for table titles & listings just in case … these are
--  extremely sensitive data sets so we'd want to make sure the indexing never
--  misses one or misrepresents one." (pdfs/Others/261109 List…mTables.pdf)
--
-- So the page lists exactly what STAFF entered in Admin → Standards → Edit,
-- never what an extractor guessed. A standard appears when it is current
-- (status 'Active') AND has_illuminance_tables = 1.
--
-- illuminance_tables_json: a JSON array, in the order staff entered it, of
--   { "title": "Table A-1. Recommended Illuminance Criteria for …",
--     "page":  69,      -- the PDF page INDEX (what #page=N needs)
--     "label": "60" }   -- the printed page staff typed; null when the PDF
--                          carries no page labels (then label = index)
-- Staff type the PRINTED page; the Worker resolves it to the index through
-- page_labels_json (migration 0029) and refuses a page the document does not print.
ALTER TABLE standards ADD COLUMN has_illuminance_tables INTEGER NOT NULL DEFAULT 0;
ALTER TABLE standards ADD COLUMN illuminance_tables_json TEXT;
