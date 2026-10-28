-- Migration 0025 (client, 2026-10-27/28)
--
-- search_log.ai_guide — the reader's AI Guide toggle as the search was sent
-- (1 on, 0 off; NULL for searches logged before this migration). Search
-- analytics reports the share of searches run with the Guide on. Anonymous,
-- like every other search_log column.
ALTER TABLE search_log ADD COLUMN ai_guide INTEGER;

-- purchases.expiry_reminder_* — the "your 3-year lease ends in a month" email
-- (client: "3-year lease: no auto-renewal … automate emails to the user 1 month
-- from end of lease"). Sent once per lease by the daily cron; the stamp is what
-- keeps it once. A failed send records the error and is retried the next day.
ALTER TABLE purchases ADD COLUMN expiry_reminder_sent_at TEXT;
ALTER TABLE purchases ADD COLUMN expiry_reminder_error TEXT;
