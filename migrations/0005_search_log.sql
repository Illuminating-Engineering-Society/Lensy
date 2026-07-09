-- Migration: 0005_search_log
-- Anonymous search-query log for staff analytics (client request: capture a
-- log of all search queries, CSV-downloadable by staff, for reference during
-- future development).
--
-- PRIVACY: deliberately contains NO user-identifying data — no user id, no
-- IP address, no session token. One row per /api/search request, including
-- responses served from the KV cache.

CREATE TABLE IF NOT EXISTS search_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  query TEXT NOT NULL,
  result_count INTEGER,
  standards_referenced TEXT, -- JSON array of standard ids in the response
  no_strong_match INTEGER,   -- 1 when the low-confidence banner was shown
  cached INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_search_log_created ON search_log(created_at);
