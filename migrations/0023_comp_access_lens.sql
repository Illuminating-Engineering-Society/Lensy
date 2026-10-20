-- Migration: 0023_comp_access_lens
--
-- Complimentary FULL IES Lens access (client 10/16/26 #6): "an equivalent
-- 'Comp Access' option so we can provide temporary complimentary access to
-- full IES Lens … For Lens comps, the default period would be 7 days."
--
-- `scope` says what a row grants:
--   'documents' — the DO110 grant: the listed standards in the Lighting
--                 Library, nothing in IES Lens (every row before this one)
--   'lens'      — subscriber-level IES Lens AND subscriber-level Lighting
--                 Library for the window; standard_ids is '[]'
--
-- Since 10/16 the Vitrium half is no longer applied by hand: Lensy hands each
-- row to AuthIES (POST /api/comp-grants, source_ref "lens-comp-<id>") and
-- stamps vitrium_applied_at / vitrium_applied_by = 'authies' when it lands.
-- `authies_error` keeps the reason when it did not, so staff can retry.

ALTER TABLE comp_access_grants ADD COLUMN scope TEXT NOT NULL DEFAULT 'documents';
ALTER TABLE comp_access_grants ADD COLUMN authies_error TEXT;

-- The per-request tier check: "does this email hold a live Lens comp?"
CREATE INDEX IF NOT EXISTS idx_comp_access_scope_email ON comp_access_grants(scope, email);
