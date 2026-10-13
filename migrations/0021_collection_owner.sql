-- Bookmark collections belong to an ACCOUNT (client 10/09/26 #1E).
--
-- "Somehow my dozminkowski@ies.org bookmark collections pre-populated into the
--  test ozminkowski+nonmember@gmail.com bookmarks page. Can you confirm they are
--  isolated per account?"
--
-- They were not. `projects.user_id` was a Phase 1 placeholder that every
-- caller sent as 1, so every signed-in reader listed, edited and deleted one
-- shared pool. The owner is now the email on the ies_auth cookie — the same
-- key user_preferences uses — and src/workers/api.ts checks it on every route.
-- `user_id` stays (NOT NULL in 0001) but nothing reads it any more.
ALTER TABLE projects ADD COLUMN owner_email TEXT;
CREATE INDEX IF NOT EXISTS idx_projects_owner_email ON projects(owner_email);

-- Every collection that existed before this migration (six, ids 26–33, created
-- 2026-09-25 → 2026-10-02) was made by the client's own account, which is the
-- one that reported seeing them elsewhere. A row left NULL would be visible to
-- nobody, which is the safe failure for anything this backfill missed.
UPDATE projects SET owner_email = 'dozminkowski@ies.org' WHERE owner_email IS NULL;
