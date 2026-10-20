-- Migration: 0022_search_log_tier
-- "Searches per day" broken out into Subscribers vs Non-Subscribers (client
-- 10/16/26 #5). The tier that answered the search — 'full' (subscriber),
-- 'lite' (IES member), 'guest' (free account) — not who asked: the log stays
-- anonymous (no user id, no IP, no session), as 0005 promised. Rows written
-- before this migration have NULL and are reported as "Unknown".

ALTER TABLE search_log ADD COLUMN tier TEXT;
