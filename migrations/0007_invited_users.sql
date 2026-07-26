-- Migration: 0007_invited_users
-- Guest-access allowlist for Lensy, managed by staff from the dashboard at
-- /admin/users.html (API: /api/admin/users, LUCIUS_API_SECRET protected).
--
-- SSO groundwork: when Lensy is registered as a Service Provider of the IES
-- Auth IDP (auth.ies.org), the post-login step will match the authenticated
-- email against this table to decide access, then fill person_uuid (Wicket
-- person UUID) and last_login_at. Until then the table is purely a managed
-- invite list — no login flow reads it yet.

CREATE TABLE IF NOT EXISTS invited_users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,               -- stored lowercased; SSO match key
  name TEXT,
  organization TEXT,
  role TEXT NOT NULL DEFAULT 'guest',       -- 'guest' | 'staff' | 'admin'
  status TEXT NOT NULL DEFAULT 'invited',   -- 'invited' | 'active' | 'revoked'
  person_uuid TEXT,                         -- Wicket person UUID, set on first SSO login
  expires_at TEXT,                          -- optional ISO date; time-limited/event access
  invited_by TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_login_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_invited_users_status ON invited_users(status);
