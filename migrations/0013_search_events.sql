-- Migration: 0013_search_events
--
-- ── DO078: the data a learning ranker would need ─────────────────────────────
--
-- "Is it possible to continually 'train' the agent based on which cards people
--  click on first to 'open in library', and perhaps which filters are engaged
--  post-search for various search types? Goal: continually improve search
--  experience over time and use."
--
-- It is, and this table is the prerequisite: nothing can be learned from
-- behaviour that was never recorded. Until it has weeks of rows, no ranking
-- decision reads from it — search.ts does NOT consult this table. What it gives
-- IES today is the measurement (which card of which search a reader actually
-- opened, and what they narrowed to afterwards), exportable as CSV alongside
-- the query log, and what it gives the next iteration is a click-through prior
-- per (query shape, standard) to break ties with.
--
-- PRIVACY: deliberately the same contract as search_log (migration 0005) — no
-- user id, no email, no IP, no session token. A row says "on a search for X,
-- someone opened RP-8-25 at page 389 from position 3". It cannot be attributed
-- to a person, which is also why it needs no retention policy beyond the
-- staff's own.
--
-- `event` values in use:
--   'open_in_library'  a result card's Library link was followed
--                      (extra: {"first":true} on the first click of a search —
--                       the "which cards people click on first" signal)
--   'filter_applied'   the Sort/Filter panel re-ran the search with new
--                      content kinds
--   'guidance'         a zero-result search's guided alternative was taken
--                      (extra: {"action":"enable_content_type","value":"body"})

CREATE TABLE IF NOT EXISTS search_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  event TEXT NOT NULL,
  -- The search this happened on, so a click can be joined to what was asked.
  query TEXT,
  standard_id TEXT,
  result_type TEXT,
  -- 1-based rank of the card in the list the reader was looking at.
  position INTEGER,
  section TEXT,
  page_number INTEGER,
  -- JSON array: the content kinds the search ran with.
  content_types TEXT,
  -- Small JSON blob for anything event-specific.
  extra TEXT
);

CREATE INDEX IF NOT EXISTS idx_search_events_created ON search_events(created_at);
CREATE INDEX IF NOT EXISTS idx_search_events_event ON search_events(event);
CREATE INDEX IF NOT EXISTS idx_search_events_standard ON search_events(standard_id);
