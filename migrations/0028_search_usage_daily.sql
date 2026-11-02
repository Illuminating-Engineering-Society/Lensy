-- Migration 0028 (client Teams note, Dan, 2026-11-02)
--
-- search_usage_daily — how many searches each account ran per day, and
-- NOTHING about what was searched. Dan: "a data export on Lens Admin that
-- counts search usage per user without any search content. 'Total searches
-- per day' per user is likely the safest."
--
-- PRIVACY: personal by necessity, like device_reset_requests (0016) and
-- comp_access_grants (0020), and deliberately the opposite of search_log
-- (0005) / search_events (0013), which carry query text and no identity. The
-- two must never be joined: this table holds no query, no result, no time of
-- day — only a UTC date, so a row cannot be matched to a search_log row.
--
-- One row per (UTC day, account). person_uuid is the AuthIES/Wicket id, kept
-- so a later export can add the account's company (sustaining organization)
-- from AuthIES without re-keying. tier is the tier of the account's most
-- recent search that day (an admin previewing a lower tier is counted under
-- the previewed tier, as the daily cap already does).
CREATE TABLE IF NOT EXISTS search_usage_daily (
  day TEXT NOT NULL,             -- YYYY-MM-DD, UTC
  email TEXT NOT NULL,
  person_uuid TEXT,
  tier TEXT,
  searches INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (day, email)
);

CREATE INDEX IF NOT EXISTS idx_search_usage_daily_email ON search_usage_daily(email);
