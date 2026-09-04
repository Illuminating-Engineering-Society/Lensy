-- Migration: 0016_device_reset_requests
--
-- ── Vitrium custom error page (client note, 2026-09-04) ──────────────────────
--
-- "We will need instruction for users who exceed device limit (ideally, they
--  submit a form which goes to staff for approval to reset device limit)."
--
-- The form lives on the custom error page Vitrium redirects to when the
-- WebViewer refuses a reader (src/frontend/library-error.html); this table is
-- where a submission lands. The APPROVAL itself happens in the Vitrium admin
-- app (Users tab → "Clear Use" beside the user — Vitrium's own documented fix
-- for the whole vc3 family), so a row here is a queue entry and an audit line,
-- never the reset. Staff are notified by email per row when
-- DEVICE_RESET_NOTIFY_EMAIL is configured; the queue is exportable at
-- GET /api/admin/device-resets.csv either way.
--
-- Unlike search_events, rows here are PERSONAL by necessity: staff cannot clear
-- a device limit without knowing whose. The email is the Vitrium username the
-- error page received; nothing else identifying is collected.

CREATE TABLE IF NOT EXISTS device_reset_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  -- Who is asking: the Vitrium username (an email for IES readers), prefilled
  -- from the error page's `username` parameter but editable by the requester.
  email TEXT NOT NULL,
  name TEXT,
  -- What they were trying to open. The short code is parsed from the viewer URL
  -- the error page received; id/title are filled when the code matched a
  -- standards row, so the staff email can name the document properly.
  document_code TEXT,
  document_id TEXT,
  document_title TEXT,
  -- WHICH limit was hit — one of Vitrium's "Clear Use" family (vc3 device
  -- limit, dvc3 content limit, dovc3 open limit, dpvc3/vp3 print limits,
  -- ipvc3 IP limit). The endpoint refuses anything else.
  error_code TEXT NOT NULL,
  -- The Vitrium message verbatim, in case the code and the message disagree.
  raw_message TEXT,
  -- The requester's own words ("I replaced my laptop last week").
  user_note TEXT,
  -- new → done (staff cleared usage in Vitrium) | dismissed (refused/duplicate).
  status TEXT NOT NULL DEFAULT 'new',
  -- Whether the per-row staff notification went out, and why not if it didn't —
  -- the same fail-soft contract as invited_users.invite_send_error.
  notify_sent INTEGER NOT NULL DEFAULT 0,
  notify_error TEXT,
  resolved_at TEXT,
  resolved_by TEXT
);

CREATE INDEX IF NOT EXISTS idx_device_reset_created ON device_reset_requests(created_at);
CREATE INDEX IF NOT EXISTS idx_device_reset_status ON device_reset_requests(status);
CREATE INDEX IF NOT EXISTS idx_device_reset_email ON device_reset_requests(email);
