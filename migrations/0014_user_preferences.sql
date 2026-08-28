-- Migration: 0014_user_preferences
--
-- ── DO080: the AI Guide toggle is a property of the ACCOUNT ──────────────────
--
-- "Disable/Enable AI Guide tool: 'save' the state to the user's account. Every
--  time the user returns to the tool, it should be in the same state it was
--  last set."
--
-- So it cannot live in localStorage: that is per browser, and the client asked
-- for per account — the same person on a laptop and a phone must find the tool
-- as they left it. (The page still mirrors the value into localStorage so the
-- first paint does not flash the wrong state before this table answers; the
-- mirror is a cache, this is the record.)
--
-- One row per person, one JSON blob of preferences rather than a column per
-- setting: the next preference the client asks for should not need a migration.
-- The Worker validates the keys it knows and ignores the rest, so an older
-- Worker reading a newer row degrades to its own defaults.
--
-- PRIVACY: this table is deliberately the one place in Lensy that stores a
-- per-person setting, so it holds the email as the key. That is the same
-- identifier `invited_users` already holds, and nothing else: no search history,
-- no results, no behaviour. The click log (0013) stays anonymous.

CREATE TABLE IF NOT EXISTS user_preferences (
  -- The email from the ies_auth cookie, lowercased. Chosen over person_uuid
  -- because every other table keyed to a person in this schema uses the email,
  -- and a user whose IdP uuid is reissued should keep their settings.
  email TEXT PRIMARY KEY,
  -- The IdP's person uuid when the cookie carried one — informational, so staff
  -- can reconcile a row against Wicket.
  person_uuid TEXT,
  -- JSON object. Known keys:
  --   ai_guide  boolean  the Disable/Enable AI Guide state (DO080)
  preferences_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
