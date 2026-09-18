-- Migration: 0020_comp_access
--
-- ── 90-day complimentary document access (client DO110) ─────────────────────
--
-- "Establish a simple method for IES staff to assign 90-day complimentary
--  access to any single document, for a single user OR an uploaded csv of
--  users … without providing access to the 'full' Lensy toolset."
--
-- The GRANT itself happens outside Lensy, by hand, and a row here is a RECORD
-- and a queue entry — never the permission. Same contract as
-- device_reset_requests (migration 0016), where the "Clear Use" click is also
-- Vitrium's. Two things block automating it, and they need different people:
-- the Vitrium API answers 403 "insufficient privileges" to support@ies.org
-- (grant pending with Vitrium's rep), and the client's proposed "90-day
-- document comp" GROUP does not exist in Vitrium External Services mode, where
-- access is decided per document by AuthIES's authorization response.
-- `vitrium_applied_at` / `vitrium_applied_by` are how staff mark that the
-- manual step happened, and the seam an automated grant would stamp instead.
--
-- What Lensy DOES do without Vitrium: it validates the documents against the
-- indexed corpus, computes and stores the window, and emails each recipient a
-- list of what they were given with a deep link per standard.
--
-- Rows are PERSONAL by necessity, like 0016 and unlike search_log: a grant is
-- meaningless without the person it was granted to. Email plus an optional
-- name is all that is collected.

CREATE TABLE IF NOT EXISTS comp_access_grants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  -- Who the access is for. One row per recipient even when a CSV of a hundred
  -- classroom addresses was uploaded in one go: staff revoke, re-send and mark
  -- applied per person, and Vitrium's group membership is per person too.
  email TEXT NOT NULL,
  name TEXT,
  -- Which documents, as a JSON array of standards.id ("[\"RP-8-25+E2\"]").
  -- Validated against the standards table at creation; deprecated editions are
  -- allowed, because the client explicitly asked for "current or deprecated".
  -- JSON rather than a join table: a grant's document set is written once and
  -- read whole, and nothing queries "who has RP-8?" across grants.
  standard_ids TEXT NOT NULL,
  -- The window. `days` is kept alongside the two dates because staff may
  -- override end_date, and the email says "you have N days" — after an
  -- override, N is what the dates actually span, not the default 90.
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  days INTEGER NOT NULL,
  -- The staff member's email off the SSO cookie ('staff-bearer' for scripts).
  created_by TEXT,
  notes TEXT,
  -- active → revoked (staff withdrew it) | expired (end_date has passed).
  -- 'expired' is DERIVED at read time from end_date, the way effectiveStatus
  -- derives it for invited_users, so a lapsed window needs no cron to close it;
  -- the stored value only ever holds 'active' or 'revoked'.
  status TEXT NOT NULL DEFAULT 'active',
  -- Whether the recipient was told, and why not if they weren't — same
  -- fail-soft contract as invited_users.invite_send_error: a grant that could
  -- not be emailed is still a valid grant and can be re-sent.
  notify_sent INTEGER NOT NULL DEFAULT 0,
  notify_sent_at TEXT,
  notify_error TEXT,
  -- The manual half. NULL means the permission does not exist in Vitrium yet,
  -- whatever this row says — the dashboard leads with that distinction.
  vitrium_applied_at TEXT,
  vitrium_applied_by TEXT,
  revoked_at TEXT,
  revoked_by TEXT
);

-- The queue view is "newest first", filtered by status; the email index backs
-- "what does this person already have?" when a second grant is being cut.
CREATE INDEX IF NOT EXISTS idx_comp_access_created ON comp_access_grants(created_at);
CREATE INDEX IF NOT EXISTS idx_comp_access_status ON comp_access_grants(status);
CREATE INDEX IF NOT EXISTS idx_comp_access_email ON comp_access_grants(email);
-- "Which grants are still waiting on the Vitrium step" is the dashboard's
-- default view and the one question staff ask every day.
CREATE INDEX IF NOT EXISTS idx_comp_access_pending ON comp_access_grants(vitrium_applied_at);
