/**
 * Lease-expiry reminders (client, 2026-10-27: "3-year lease: no auto-renewal.
 * However, if possible, it would be good to automate emails to the user 1 month
 * from end of lease that it is about to expire and they can subscribe to the
 * entire Lighting Library for continued access").
 *
 * Run by the daily cron (api.ts `scheduled`). A lease qualifies when it was
 * actually granted (authies_applied_at), is still active, and ends within the
 * next REMINDER_DAYS days; `expiry_reminder_sent_at` (migration 0025) keeps it
 * to one email per lease. A failed send records the reason and is retried by
 * the next day's run, while the lease is still in the window.
 *
 * SURECART_NOTIFY = "off" silences these too — it is the one switch for every
 * purchase email. First leases are sold from 2026-11-02, so the first reminder
 * goes out around 2029-10-02.
 */

import { readSurecartConfig } from '../lib/surecart';
import { resolveStandardById } from '../lib/purchases';
import { sendLeaseExpiryEmail } from '../lib/email';

export const REMINDER_DAYS = 30;
/** Per run; a backlog drains over successive days rather than in one burst. */
const BATCH = 100;

interface DueLease {
  id: number;
  email: string;
  name: string | null;
  standard_id: string | null;
  end_date: string;
}

export async function sendLeaseExpiryReminders(env: Env): Promise<{ due: number; sent: number; failed: number }> {
  const outcome = { due: 0, sent: 0, failed: 0 };
  if (!readSurecartConfig(env).notify) return outcome;

  let due: DueLease[] = [];
  try {
    const rows = await env.DB.prepare(`
      SELECT id, email, name, standard_id, end_date FROM purchases
      WHERE kind = 'lease' AND status = 'active' AND authies_applied_at IS NOT NULL
        AND expiry_reminder_sent_at IS NULL
        AND date(end_date) >= date('now') AND date(end_date) <= date('now', ?)
      ORDER BY end_date LIMIT ?
    `).bind(`+${REMINDER_DAYS} days`, BATCH).all<DueLease>();
    due = rows.results || [];
  } catch (err) {
    // Before migration 0025 the stamp column does not exist.
    console.error('lease reminders: query failed:', err instanceof Error ? err.message : String(err));
    return outcome;
  }
  outcome.due = due.length;

  for (const lease of due) {
    const standard = lease.standard_id ? await resolveStandardById(env.DB, lease.standard_id) : null;
    const sent = standard
      ? await sendLeaseExpiryEmail(env, {
        to: lease.email,
        name: lease.name,
        document: { id: standard.id, designation: standard.designation, title: standard.title, libraryUrl: standard.libraryUrl },
        endDate: lease.end_date,
      })
      : { sent: false as const, error: `standard ${lease.standard_id ?? '(none)'} not in the catalogue` };
    if (sent.sent) {
      outcome.sent++;
      await env.DB.prepare(`UPDATE purchases SET expiry_reminder_sent_at = datetime('now'), expiry_reminder_error = NULL, updated_at = datetime('now') WHERE id = ?`)
        .bind(lease.id).run();
    } else {
      outcome.failed++;
      await env.DB.prepare(`UPDATE purchases SET expiry_reminder_error = ?, updated_at = datetime('now') WHERE id = ?`)
        .bind(String(sent.error).slice(0, 300), lease.id).run();
    }
  }
  return outcome;
}
