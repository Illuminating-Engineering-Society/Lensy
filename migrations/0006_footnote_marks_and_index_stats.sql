-- Migration: 0006_footnote_marks_and_index_stats
--
-- 1. applications.Footnote_Marks — WHERE each footnote marker attaches in the
--    printed table (client feedback: footnote 1 on "Emergency department entry"
--    is a HEADER-level note; it must not print independently on the Day/Night
--    sub-rows). JSON:
--      { "levels": { "App_s1": [1] }, "row": [3] }
--    "levels" keys are hierarchy column names (Sub_Category, App, App_s1..App_s6)
--    whose printed label carries the superscript; "row" holds markers printed on
--    the data row itself. The resolved note TEXT still lives in Footnotes.
--
-- 2. standards.* index-coverage stats — written on every ingest so staff can
--    verify each standard is fully indexed (see GET /api/admin/index-status):
--      chunk_count    total vectors upserted for the standard
--      page_count     pages in the source PDF
--      coverage_json  { "pagesWithChunks": n, "byType": {"text": n, "table": n,
--                       "general_notes": n, "reference": n} }
--
-- D1/SQLite: ALTER TABLE ADD COLUMN cannot use IF NOT EXISTS. Re-running this
-- migration errors if the columns already exist; that is expected.

ALTER TABLE applications ADD COLUMN Footnote_Marks TEXT;

ALTER TABLE standards ADD COLUMN chunk_count INTEGER;
ALTER TABLE standards ADD COLUMN page_count INTEGER;
ALTER TABLE standards ADD COLUMN coverage_json TEXT;
