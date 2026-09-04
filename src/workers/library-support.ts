/**
 * Lighting Library error-page backend (client note, 2026-09-04).
 *
 * Vitrium's WebViewer redirects a refused reader to our custom error page
 * (src/frontend/library-error.html — configured in Vitrium admin → Settings →
 * Web Viewer Settings → "Custom URL for Error Page"). The page is static; these
 * two endpoints are what make it more than a nicer message:
 *
 *   GET  /api/library/document?code=<shortcode>
 *        Resolves the viewer short code from the refused URL to the standard it
 *        serves, so "no permission" can link to THAT document's purchase page
 *        rather than a generic store link — the client's stated goal. Public by
 *        design: it discloses only what the store and the Table of Contents
 *        already publish (designation, title, buy link), and the reader hitting
 *        the error page has no Lensy session to present.
 *
 *   POST /api/library/device-reset
 *        The device-limit flow: "they submit a form which goes to staff for
 *        approval to reset device limit." Stores the request
 *        (device_reset_requests, migration 0016) and emails staff when
 *        DEVICE_RESET_NOTIFY_EMAIL is set. Also public — the requester is by
 *        definition someone the viewer just refused — so it is deliberately
 *        narrow: only the Clear-Use error family is accepted, every field is
 *        length-capped, a honeypot field silently discards bots, repeats
 *        collapse into the existing open request, and the search rate limiter
 *        caps the rest.
 *
 * Staff read the queue at GET /api/admin/device-resets.csv and mark rows
 * handled with POST /api/admin/device-resets {id, status} (workers/admin.ts
 * gate). The reset itself is a Vitrium admin action ("Clear Use"); this queue
 * records who asked and what happened.
 */

import {
  CLEAR_USE_CODES, CLEAR_USE_LABELS, isShortCode, shortCodeFromViewerUrl,
} from '../lib/vitrium-support.js';
import { toLibraryUrlOrNull } from '../lib/library-url.js';
import { isEmailAddress, sendDeviceResetEmail } from '../lib/email';

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function errMsg(err: unknown): string { return err instanceof Error ? err.message : String(err); }

const text = (v: unknown, max: number): string | null => {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s ? s.slice(0, max) : null;
};

/** A standards row, shaped for the error page. */
interface DocumentInfo {
  id: string;
  designation: string;
  title: string | null;
  status: string;
  buyUrl: string | null;
  libraryUrl: string | null;
}

function shapeDocument(row: Record<string, unknown>): DocumentInfo {
  const id = String(row.id);
  const title = typeof row.title === 'string' && row.title !== id ? row.title : null;
  return {
    id,
    designation: typeof row.full_designation === 'string' && row.full_designation
      ? row.full_designation : `ANSI/IES ${id}`,
    title,
    status: String(row.status || 'Active'),
    buyUrl: typeof row.buy_url === 'string' && /^https?:\/\//i.test(row.buy_url) ? row.buy_url : null,
    libraryUrl: toLibraryUrlOrNull(row.vitrium_web_url),
  };
}

const DOCUMENT_COLUMNS =
  'id, full_designation, title, status, buy_url, vitrium_web_url, superseded_by';

/**
 * GET /api/library/document?code=XXXXXX
 *
 * The join is a suffix match on standards.vitrium_web_url — the stored value is
 * the export's `https://view.protectedpdf.com/<code>` and the code is validated
 * alphanumeric first, so no LIKE wildcard can be smuggled in. A deprecated
 * edition additionally resolves its superseding row (2p3 on a withdrawn PDF is
 * exactly the reader who should be pointed at the current edition).
 */
export async function handleLibraryDocumentLookup(request: Request, env: Env, url: URL): Promise<Response> {
  const code = (url.searchParams.get('code') || '').trim();
  if (!isShortCode(code)) {
    return json({ error: 'A viewer short code is required.' }, 400);
  }

  let row: Record<string, unknown> | null = null;
  try {
    row = await env.DB.prepare(
      `SELECT ${DOCUMENT_COLUMNS} FROM standards WHERE vitrium_web_url LIKE ?`
    ).bind(`%/${code}`).first<Record<string, unknown>>();
  } catch (err) {
    console.error('library document lookup failed (non-fatal):', errMsg(err));
  }

  if (!row) {
    // Cacheable: an unknown code stays unknown until the next metadata sync.
    return json({ document: null }, 200, { 'Cache-Control': 'public, max-age=300' });
  }

  const document = shapeDocument(row);

  // A withdrawn edition points at what replaced it, when D1 knows.
  let supersededBy: DocumentInfo | null = null;
  const successor = typeof row.superseded_by === 'string' ? row.superseded_by.trim() : '';
  if (document.status !== 'Active' && successor) {
    try {
      const s = await env.DB.prepare(
        `SELECT ${DOCUMENT_COLUMNS} FROM standards WHERE id = ?`
      ).bind(successor).first<Record<string, unknown>>();
      if (s) supersededBy = shapeDocument(s);
    } catch (err) {
      console.error('superseding edition lookup failed (non-fatal):', errMsg(err));
    }
  }

  return json({ document, supersededBy }, 200, { 'Cache-Control': 'public, max-age=3600' });
}

// ─── Device-limit reset requests ──────────────────────────────────────────────

const MAX_NOTE = 1000;
const MAX_TITLE = 200;
const MAX_MESSAGE = 300;

/**
 * POST /api/library/device-reset
 *
 * Body: { email, name?, note?, error_code, document_url?, document_title?,
 *         message?, website? }
 *
 * `website` is the honeypot: it is invisible on the page, so a value there is a
 * bot and the request is acknowledged and discarded — acknowledged, because an
 * error teaches the bot which field to skip.
 */
export async function handleDeviceResetRequest(request: Request, env: Env): Promise<Response> {
  // Same limiter as search, keyed separately per client so a script cannot fill
  // the queue. Fails open like search does — the form matters more than the cap.
  try {
    const ip = request.headers.get('cf-connecting-ip') || 'unknown';
    const { success } = await env.SEARCH_RATE_LIMITER.limit({ key: `device-reset:${ip}` });
    if (!success) {
      return json({ error: 'Too many requests. Please try again in a minute.' }, 429);
    }
  } catch { /* no limiter bound, or it errored — proceed */ }

  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    parsed = undefined;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return json({ error: 'Invalid JSON body' }, 400);
  }
  const body = parsed as Record<string, unknown>;

  if (text(body.website, 100)) {
    return json({ received: true });
  }

  const email = text(body.email, 200);
  if (!email || !isEmailAddress(email)) {
    return json({ error: 'A valid email address is required.' }, 400);
  }

  const errorCode = (text(body.error_code, 10) || '').toLowerCase();
  if (!CLEAR_USE_CODES.has(errorCode)) {
    // Only the usage-limit family is resettable by "Clear Use"; anything else
    // on this endpoint is a mistake (or probing) and staff could not act on it.
    return json({ error: 'This error type cannot be reset by staff.' }, 400);
  }

  const documentCode = shortCodeFromViewerUrl(text(body.document_url, 500));

  // Best-effort: name the document properly in the queue and the staff email.
  let documentId: string | null = null;
  let documentTitle: string | null = text(body.document_title, MAX_TITLE);
  if (documentCode) {
    try {
      const row = await env.DB.prepare(
        'SELECT id, full_designation, title FROM standards WHERE vitrium_web_url LIKE ?'
      ).bind(`%/${documentCode}`).first<Record<string, unknown>>();
      if (row) {
        documentId = String(row.id);
        const doc = shapeDocument({ ...row, status: 'Active' });
        documentTitle = doc.title ? `${doc.designation} ${doc.title}` : doc.designation;
      }
    } catch (err) {
      console.error('device reset document lookup failed (non-fatal):', errMsg(err));
    }
  }

  // One OPEN request per (email, document, code): a reader who reloads the
  // error page and submits again has not asked for anything new, and a
  // duplicate row would email staff twice about one problem.
  try {
    const existing = await env.DB.prepare(
      `SELECT id FROM device_reset_requests
       WHERE email = ? AND error_code = ? AND COALESCE(document_code, '') = ? AND status = 'new'`
    ).bind(email, errorCode, documentCode || '').first<{ id: number }>();
    if (existing) {
      return json({ received: true, alreadyPending: true });
    }
  } catch (err) {
    // Missing table (migration 0016 not applied yet) lands here; the insert
    // below will fail the same way and answer honestly.
    console.error('device reset dedupe check failed (non-fatal):', errMsg(err));
  }

  const name = text(body.name, 120);
  const userNote = text(body.note, MAX_NOTE);
  const rawMessage = text(body.message, MAX_MESSAGE);

  let requestId: number | null = null;
  try {
    const result = await env.DB.prepare(`
      INSERT INTO device_reset_requests
        (email, name, document_code, document_id, document_title, error_code, raw_message, user_note)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      email, name, documentCode, documentId, documentTitle, errorCode, rawMessage, userNote,
    ).run();
    requestId = result.meta.last_row_id as number;
  } catch (err) {
    // Unlike the telemetry endpoints this write IS the product: the reader was
    // promised staff would hear about it, so a lost row must not say "received".
    console.error('device reset request write failed:', errMsg(err));
    return json({
      error: 'Your request could not be recorded. Please email the support team directly.',
    }, 500);
  }

  // Staff notification — fail-soft, outcome recorded on the row.
  const notifyTo = (env.DEVICE_RESET_NOTIFY_EMAIL || '').trim();
  if (notifyTo && isEmailAddress(notifyTo)) {
    const outcome = await sendDeviceResetEmail(env, {
      to: notifyTo,
      requestId,
      email,
      name,
      documentTitle,
      documentCode,
      errorCode,
      errorLabel: (CLEAR_USE_LABELS as Record<string, string>)[errorCode] || errorCode,
      userNote,
      rawMessage,
    });
    try {
      await env.DB.prepare(
        'UPDATE device_reset_requests SET notify_sent = ?, notify_error = ? WHERE id = ?'
      ).bind(outcome.sent ? 1 : 0, outcome.sent ? null : outcome.error, requestId).run();
    } catch (err) {
      console.error('device reset notify bookkeeping failed (non-fatal):', errMsg(err));
    }
  }

  return json({ received: true, requestId });
}
