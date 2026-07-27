-- Migration: 0008_invite_email
-- Record the outcome of the invitation email for each allowlist row.
--
-- Why store it: an invite that silently failed to send is indistinguishable
-- from one nobody has acted on yet — both sit at status='invited'. Staff need
-- to see "added but never emailed" to know whether to resend, and the failure
-- reason (a suppressed address, a sender domain that is not onboarded) is the
-- only way to tell a delivery problem apart from an invitee ignoring it.
--
-- Rows created before this migration have invite_sent_at NULL, which reads
-- correctly as "never emailed" — they predate the email being sent at all.

ALTER TABLE invited_users ADD COLUMN invite_sent_at TEXT;

-- Last send failure, cleared on a successful send. Free text from the Email
-- Service error (an E_* code plus message), truncated by the writer.
ALTER TABLE invited_users ADD COLUMN invite_send_error TEXT;
