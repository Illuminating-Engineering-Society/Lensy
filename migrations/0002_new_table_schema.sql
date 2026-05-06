-- Lucius D1 Schema — Migration 0002
-- Adds columns required by the new IES table structure (260420+).
-- Reference: pdfs/Others/IlluminanceTables_Reference_260421.pdf
--
-- New columns split into three groups:
--   1. Hierarchy:    Sub_Category (level 1 banner: INTERIORS / EXTERIORS / ...)
--   2. Per-row meta: Veiling_Risk, Class_of_Play
--   3. Per-plane:    Hor_CV, Hor_Ratio_Basis, Ver_CV, Ver_Ratio_Basis
--
-- D1/SQLite limitations: ALTER TABLE ADD COLUMN cannot use IF NOT EXISTS.
-- Re-running this migration will error if columns already exist; that is expected.

-- ─── 1. Hierarchy banner column ────────────────────────────────────────────
ALTER TABLE applications ADD COLUMN Sub_Category TEXT;

-- ─── 2. Per-row metadata columns ───────────────────────────────────────────
ALTER TABLE applications ADD COLUMN Veiling_Risk TEXT;   -- L | M | H
ALTER TABLE applications ADD COLUMN Class_of_Play TEXT;  -- I | II | III | IV (RP-6)

-- ─── 3. Horizontal-plane additions ─────────────────────────────────────────
ALTER TABLE applications ADD COLUMN Hor_CV REAL;
ALTER TABLE applications ADD COLUMN Hor_Ratio_Basis TEXT;  -- Max:Avg:Min | Max:Avg | Max:Min | Avg:Min

-- ─── 4. Vertical-plane additions ───────────────────────────────────────────
ALTER TABLE applications ADD COLUMN Ver_CV REAL;
ALTER TABLE applications ADD COLUMN Ver_Ratio_Basis TEXT;

-- ─── 5. Helpful indexes for the new fields ─────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_applications_sub_category ON applications(Sub_Category);
CREATE INDEX IF NOT EXISTS idx_applications_lighting_zone ON applications(Lighting_Zone);
