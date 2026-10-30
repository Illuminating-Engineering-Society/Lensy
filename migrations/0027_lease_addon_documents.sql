-- Migration 0027 (client Teams note, 2026-10-30)
--
-- standards.lease_addon_doc_ids — extra Vitrium documents a 3-year LEASE of
-- this standard also unlocks. Dan: "Several standards, if acquired by '3-year
-- lease,' will need to have an additional Vitrium file provided with
-- purchase. This 'extra' file provides copy/paste access to the user for
-- select excerpts … the webstore must unlock the existing Vitrium file plus
-- this additional file."
--
-- A JSON array of Vitrium Doc IDs (GUIDs, lowercase); NULL = none. Read by the
-- SureCart sync (src/lib/purchases.ts) and pushed to AuthIES beside the
-- standard's own vitrium_doc_id. Editable in Admin → Standards → Edit.
-- Subscriptions and comps are unaffected: the add-on rides on leases only.
ALTER TABLE standards ADD COLUMN lease_addon_doc_ids TEXT;

-- Dan's table, matched to the indexed ids: "TM-27-20(R25)" is TM-27-20+E1,
-- "LM-63-19(R25)" is LM-63-19, and "TM-41-23" is TM-41-24 (the only TM-41
-- edition in the catalogue — flagged back to the client).
UPDATE standards SET lease_addon_doc_ids = '["e0b1527a-77c3-424e-85be-fefcaecaeccf"]' WHERE id = 'TM-41-24';
UPDATE standards SET lease_addon_doc_ids = '["2ce6f8d3-7363-44d1-86e7-c01795bb5911"]' WHERE id = 'TM-33-23';
UPDATE standards SET lease_addon_doc_ids = '["a4ad0d4c-dd4f-4050-9b1f-6dff7f0452a0"]' WHERE id = 'TM-27-20+E1';
UPDATE standards SET lease_addon_doc_ids = '["a15f12ee-25cb-4b47-8de8-70b098b6b360"]' WHERE id = 'RP-43-25';
UPDATE standards SET lease_addon_doc_ids = '["b51aa0c6-05a2-4348-8f34-176a93f9c038"]' WHERE id = 'LP-10-26';
UPDATE standards SET lease_addon_doc_ids = '["eef9df3b-072f-453d-9714-2b4ce088ade1"]' WHERE id = 'LM-91-22';
UPDATE standards SET lease_addon_doc_ids = '["520518d5-8f6b-46f6-b524-90d0df27a727"]' WHERE id = 'LM-90-20';
UPDATE standards SET lease_addon_doc_ids = '["5ab4fe5b-23ba-4609-93e5-1d97b6fe5870"]' WHERE id = 'LM-63-19';
