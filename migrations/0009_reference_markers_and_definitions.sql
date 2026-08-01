-- Migration: 0009_reference_markers_and_definitions
--
-- 1. standards.reference_markers_json — in-body superscript reference markers
--    (client feedback DO31.4). A Reference result card lists the standards whose
--    References sections carry the same cited work; the client asked those links
--    to open the place in the BODY where the work is cited — the superscripted
--    numeral — rather than the bibliography page. src/lib/pdf-parser.js records
--    each line's raised small-font numerals and src/lib/reference-markers.js
--    reduces them to:
--      { "6": 18, "17": 21, "18": 21, ... }     marker number → first page printing it
--    Search joins an entry's own leading number ("6 International Commission…")
--    against this map. NULL for standards ingested before this migration, or for
--    standards that cite by author-date rather than by number — those keep the
--    old behaviour and link to the References page.
--
-- 2. definitions — the ANSI/IES LS-1 terminology glossary (client feedback DO33:
--    a new "Definitions" filter and result card that searches ONLY LS-1
--    definitions, published at https://ies.org/standards/definitions/ until the
--    source moves into Vitrium like every other standard, expected late 2027).
--    Vectorize metadata caps a chunk's stored text, but a Definition card prints
--    the definition IN FULL and may include inline math, emphasis or images, so
--    the rich text lives here and search hydrates it by slug.
--      slug          URL slug on ies.org  ("color", "absorptance-alpha")
--      term          the term as printed   ("color", "absorptance, α")
--      clause        LS-1 clause number    ("4.1") — nullable
--      html          sanitized rich text (allowlisted tags only)
--      text          plain-text rendering, used for keyword fallback + AI prompts
--      source_url    canonical ies.org URL
--      standard_id   designation the card cites (currently "LS-1-25")
--
-- D1/SQLite: ALTER TABLE ADD COLUMN cannot use IF NOT EXISTS. Re-running this
-- migration errors if the column already exists; that is expected.

ALTER TABLE standards ADD COLUMN reference_markers_json TEXT;

CREATE TABLE IF NOT EXISTS definitions (
  slug        TEXT PRIMARY KEY,
  term        TEXT NOT NULL,
  clause      TEXT,
  html        TEXT NOT NULL,
  text        TEXT NOT NULL,
  source_url  TEXT,
  standard_id TEXT NOT NULL DEFAULT 'LS-1-25',
  updated_at  TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Exact-term lookup ("Color" must return the `color` definition first) and the
-- LIKE fallback both scan on the term.
CREATE INDEX IF NOT EXISTS idx_definitions_term ON definitions(term);
