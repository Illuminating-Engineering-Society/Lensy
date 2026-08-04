/**
 * Lensy transactional email. Two messages, one sender:
 *
 *   1. The invitation sent when staff add someone to the access allowlist
 *      (/admin/users → POST /api/admin/users).
 *   2. A shared Saved Search Collection (client DO37) — POST /api/projects/:id/email.
 *
 * Uses the native Cloudflare Email Service binding `env.SEND_EMAIL.send({...})`
 * — no third-party provider, no API key.
 *
 * Sender: noreply@lensy.ies.org, a SUBDOMAIN on purpose. The ies.org apex is
 * Microsoft 365 with a strict `-all` SPF record; onboarding the apex onto Email
 * Sending would add a second SPF record and break mail for the whole
 * organization. AuthIES sends from noreply@auth.ies.org for the same reason.
 *
 * The invitation carries NO token or credential — just a link to the app. Lensy
 * has no password of its own: access is decided from the ies_auth cookie minted
 * by auth.ies.org (lib/sso.ts), so there is nothing secret to leak here and an
 * intercepted invitation grants nothing on its own.
 *
 * Fails soft, always. An invite that could not be emailed is still a valid
 * allowlist entry — the person can be sent the link by hand. Callers get the
 * failure reason to store (invited_users.invite_send_error) and show, rather
 * than the whole invite being rolled back over a mail problem.
 *
 * Template building is pure and unit-tested (email.test.js); only
 * sendInviteEmail touches the binding.
 */

const FROM_ADDRESS = 'noreply@lensy.ies.org';
const FROM_NAME = 'IES Lensy';

// IES brand tokens, matching the app shell (src/frontend/*.html).
const BRAND_SECONDARY = '#3A5068';
const BRAND_PRIMARY = '#D95D2B';

/** Longest error string stored in invited_users.invite_send_error. */
const MAX_ERROR_LEN = 300;

export interface InviteEmailContext {
  email: string;
  name: string | null;
  organization: string | null;
  /** invited_users.role — 'guest' | 'staff' | 'admin'. */
  role: string;
  /** ISO timestamp, or null for open-ended access. */
  expiresAt: string | null;
  /** Staff member who created the invite, if they filled it in. */
  invitedBy: string | null;
  /** Absolute base URL of this deployment, e.g. https://lensy.ies.org */
  appUrl: string;
}

export interface InviteEmailContent {
  subject: string;
  html: string;
  text: string;
}

export type SendOutcome =
  | { sent: true }
  | { sent: false; error: string };

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 'YYYY-MM-DD' or an ISO timestamp → "12 August 2026"; falls back to the raw value. */
export function formatExpiry(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  return new Date(ms).toLocaleDateString('en-GB', {
    day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
  });
}

/** First name if we have one, else nothing — never "Hi null". */
function greeting(name: string | null): string {
  const first = (name ?? '').trim().split(/\s+/)[0];
  return first ? `Hello ${first},` : 'Hello,';
}

function paragraph(text: string): string {
  return `<p style="margin:0 0 16px;color:#444;font-size:15px;line-height:1.55">${escapeHtml(text)}</p>`;
}

/**
 * The message body, as both HTML and plain text (some clients only render text,
 * and a text part measurably helps spam scoring).
 *
 * The "you may be asked to set a password" paragraph is not optional politeness:
 * every pre-existing IES account starts `pending` at the new IdP and must set a
 * password from a SEPARATE email before it can sign in at all. Without that
 * sentence the detour looks like a broken invitation.
 */
export function buildInviteEmail(ctx: InviteEmailContext): InviteEmailContent {
  const appUrl = ctx.appUrl.replace(/\/+$/, '');
  const invitedBy = (ctx.invitedBy ?? '').trim();
  const isStaffRole = ctx.role === 'staff' || ctx.role === 'admin';

  const subject = 'You have access to Lensy — the IES Standards Assistant';

  const lines: string[] = [];
  lines.push(
    invitedBy
      ? `${invitedBy} has given you access to Lensy, the Illuminating Engineering Society's assistant for searching the IES Lighting Library.`
      : `You have been given access to Lensy, the Illuminating Engineering Society's assistant for searching the IES Lighting Library.`,
  );
  lines.push(
    'Ask a question in plain language — "how bright should a skating rink be?" — and Lensy answers with the relevant passages, illuminance tables and citations from current IES standards.',
  );
  lines.push(
    'Sign in with your IES account. The first time you sign in since the IES sign-in upgrade you will be asked to set a new password; look for a separate email from IES after you enter your address.',
  );
  if (ctx.expiresAt) {
    lines.push(`Your access runs through ${formatExpiry(ctx.expiresAt)}.`);
  }
  if (isStaffRole) {
    lines.push('Your account also has staff access to the Lensy admin tools.');
  }

  const html = `<!doctype html><html><body style="margin:0;background:#f4f6f8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
  <div style="max-width:560px;margin:24px auto;background:#fff;border:1px solid #e2e6ea;border-radius:8px;overflow:hidden">
    <div style="background:${BRAND_SECONDARY};color:#fff;padding:16px 20px;font-size:15px;font-weight:700">Illuminating Engineering Society</div>
    <div style="padding:24px 20px">
      <h1 style="margin:0 0 14px;font-size:19px;color:${BRAND_SECONDARY}">Your access to Lensy is ready</h1>
      ${paragraph(greeting(ctx.name))}
      ${lines.map(paragraph).join('\n      ')}
      <p style="margin:0 0 20px"><a href="${escapeHtml(appUrl)}/" style="display:inline-block;background:${BRAND_PRIMARY};color:#fff;text-decoration:none;padding:12px 22px;border-radius:6px;font-weight:600;font-size:15px">Open Lensy</a></p>
      <p style="margin:0 0 20px;font-size:13px;color:#666">If the button doesn't work, copy this address into your browser:<br><span style="color:${BRAND_SECONDARY};word-break:break-all">${escapeHtml(appUrl)}/</span></p>
      <p style="margin:0;font-size:13px;color:#666">Questions about IES standards? Contact <a href="mailto:Standards@ies.org" style="color:${BRAND_SECONDARY}">Standards@ies.org</a>.</p>
    </div>
    <div style="padding:14px 20px;background:#f4f6f8;color:#888;font-size:12px">Sent by lensy.ies.org because you were added to Lensy's access list${invitedBy ? ` by ${escapeHtml(invitedBy)}` : ''} — please do not reply to this message.</div>
  </div>
</body></html>`;

  const text = [
    'Your access to Lensy is ready',
    '',
    greeting(ctx.name),
    '',
    ...lines.flatMap((l) => [l, '']),
    `Open Lensy: ${appUrl}/`,
    '',
    'Questions about IES standards? Contact Standards@ies.org.',
    '',
    `Sent by lensy.ies.org because you were added to Lensy's access list${invitedBy ? ` by ${invitedBy}` : ''} — please do not reply.`,
  ].join('\n');

  return { subject, html, text };
}

/**
 * Send one invitation. Never throws: every failure path returns
 * `{ sent: false, error }` so the caller can record it against the row.
 *
 * The binding is checked before use because a deployment can legitimately be
 * missing it (a Worker version predating the wrangler.toml change), and
 * `undefined.send()` would turn a mail problem into a 500 on the invite API.
 */
export async function sendInviteEmail(
  env: Env,
  ctx: InviteEmailContext,
): Promise<SendOutcome> {
  const binding = env.SEND_EMAIL;
  if (!binding) {
    return {
      sent: false,
      error: 'SEND_EMAIL binding is not configured on this deployment.',
    };
  }

  const { subject, html, text } = buildInviteEmail(ctx);

  try {
    await binding.send({
      to: ctx.email,
      from: { email: FROM_ADDRESS, name: FROM_NAME },
      subject,
      html,
      text,
    });
    return { sent: true };
  } catch (err) {
    const error = describeSendError(err);
    // Logged as well as returned: a domain-wide failure (E_SENDER_NOT_VERIFIED)
    // shows up once per invite in `wrangler tail` and is the fastest signal that
    // lensy.ies.org fell out of Email Sending.
    console.error('invite_email_failed', { to: ctx.email, error });
    return { sent: false, error };
  }
}

/**
 * Email Service throws Errors carrying an `E_*` code. Keep the code — it is the
 * difference between "onboard the domain" (E_SENDER_NOT_VERIFIED), "this address
 * bounced before" (E_RECIPIENT_SUPPRESSED) and "retry later"
 * (E_RATE_LIMIT_EXCEEDED) — and cap the length for the D1 column.
 */
export function describeSendError(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as Error & { code?: string }).code;
    const detail = err.message || 'unknown error';
    return (code ? `${code}: ${detail}` : detail).slice(0, MAX_ERROR_LEN);
  }
  return String(err).slice(0, MAX_ERROR_LEN);
}

// ─── Shared Saved Search Collection (client DO37) ─────────────────────────────

/** Store pages the email points at for access. */
const STORE_URL = 'https://store.ies.org/';
const SUBSCRIBE_URL = 'https://store.ies.org/ies/subscriptions/';

/** Card labels, matching the result cards and the CSV export exactly. */
const ITEM_LABELS: Record<string, string> = {
  tables: 'Illuminance Table',
  body: 'Document',
  references: 'Reference',
  definitions: 'Definition',
};

/** One saved item, as `collectionItems()` returns it. */
export interface ShareEmailItem {
  result_type?: string | null;
  resource_title?: string | null;
  page_number?: number | null;
  library_url?: string | null;
  application_name?: string | null;
  reference_text?: string | null;
  custom_notes?: string | null;
}

export interface CollectionShareEmailContext {
  to: string;
  /** Who is sharing, as they typed it. Null → the mail speaks impersonally. */
  senderName: string | null;
  /** Optional personal note from the share dialog. */
  message: string | null;
  collection: {
    name?: string | null;
    notes?: string | null;
    collection_type?: string | null;
    client_name?: string | null;
    location?: string | null;
  };
  items: ShareEmailItem[];
  /** Absolute "Save Search to My Lensy" URL, or null when no token exists. */
  claimUrl: string | null;
  appUrl: string;
}

/** Rich-text notes are authored in the app; an email line is plain text. */
function plainNote(value: unknown): string {
  if (!value) return '';
  return String(value)
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/(?:p|li|div)\s*>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * A shared collection, as both HTML and plain text.
 *
 * **This email reprints CITATIONS, never contents.** That is the whole point of
 * DO37 — "provide linked references to search results, but do not reprint the
 * excerpts in the report" — and it is structural rather than a rule applied here:
 * a saved item physically holds no excerpt text (src/lib/collections.js strips it
 * at save time), so the only body text available to print is a reference entry,
 * the client's one explicit exception. If a future change starts persisting
 * excerpt bodies, this template must NOT begin printing them.
 */
export function buildCollectionShareEmail(ctx: CollectionShareEmailContext): InviteEmailContent {
  const appUrl = ctx.appUrl.replace(/\/+$/, '');
  const sender = (ctx.senderName ?? '').trim();
  const topic = (ctx.collection?.name ?? '').trim() || 'Saved Search Collection';
  const note = plainNote(ctx.collection?.notes);
  const personal = plainNote(ctx.message);
  const items = ctx.items || [];

  const subject = `IES Lighting Library search results: ${topic}`;

  const intro = sender
    ? `${sender} shared a set of IES Lighting Library search results with you.`
    : 'Someone shared a set of IES Lighting Library search results with you.';

  // ── Items ───────────────────────────────────────────────────────────────────
  const itemHtml = items.map(it => {
    const label = ITEM_LABELS[String(it.result_type || 'tables')] || String(it.result_type || '');
    const title = String(it.resource_title || '').trim();
    const page = it.page_number != null ? `p. ${it.page_number}` : '';
    const detail = it.result_type === 'tables' ? plainNote(it.application_name)
      : it.result_type === 'references' ? plainNote(it.reference_text)
        : '';
    const itemNote = plainNote(it.custom_notes);
    const link = typeof it.library_url === 'string' && /^https?:\/\//i.test(it.library_url)
      ? it.library_url : null;

    return `<tr><td style="padding:0 0 18px;border-bottom:1px solid #eef1f4">
        <div style="font-size:11px;letter-spacing:.04em;text-transform:uppercase;color:#7a8794;padding:14px 0 4px">${escapeHtml(label)}</div>
        <div style="font-size:15px;color:${BRAND_SECONDARY};font-weight:600;line-height:1.4">${escapeHtml(title)}</div>
        ${detail ? `<div style="font-size:14px;color:#444;line-height:1.5;padding-top:4px">${escapeHtml(detail)}</div>` : ''}
        ${page ? `<div style="font-size:13px;color:#666;padding-top:4px">${escapeHtml(page)}</div>` : ''}
        ${itemNote ? `<div style="font-size:13px;color:#666;font-style:italic;padding-top:4px">Note: ${escapeHtml(itemNote)}</div>` : ''}
        ${link ? `<div style="padding-top:6px"><a href="${escapeHtml(link)}" style="color:${BRAND_PRIMARY};font-size:13px;text-decoration:none">Open in the IES Lighting Library →</a></div>` : ''}
      </td></tr>`;
  }).join('\n      ');

  const itemText = items.map(it => {
    const label = ITEM_LABELS[String(it.result_type || 'tables')] || String(it.result_type || '');
    const page = it.page_number != null ? `, p. ${it.page_number}` : '';
    const detail = it.result_type === 'tables' ? plainNote(it.application_name)
      : it.result_type === 'references' ? plainNote(it.reference_text)
        : '';
    const itemNote = plainNote(it.custom_notes);
    return [
      `[${label}] ${String(it.resource_title || '').trim()}${page}`,
      detail ? `    ${detail}` : '',
      itemNote ? `    Note: ${itemNote}` : '',
      it.library_url ? `    ${it.library_url}` : '',
    ].filter(Boolean).join('\n');
  }).join('\n\n');

  const countLine = items.length === 1 ? '1 saved result' : `${items.length} saved results`;

  // ── Access prompts ──────────────────────────────────────────────────────────
  // The client's mockup pairs the shared references with a route to the content:
  // a recipient who is not a subscriber can follow either link rather than
  // hitting a paywall with no explanation.
  const accessHtml = `
      <div style="margin:22px 0 0;padding:16px 18px;background:#f8fafb;border:1px solid #e2e6ea;border-radius:6px">
        <div style="font-size:14px;font-weight:600;color:${BRAND_SECONDARY};padding-bottom:6px">Don't have access to these standards?</div>
        <p style="margin:0 0 10px;font-size:13px;color:#555;line-height:1.55">The IES Lighting Library is the Illuminating Engineering Society's collection of ANSI-approved lighting standards. Every reference above links to the exact page.</p>
        <p style="margin:0;font-size:13px">
          <a href="${SUBSCRIBE_URL}" style="color:${BRAND_PRIMARY};text-decoration:none;font-weight:600">Subscribe to the Lighting Library</a>
          <span style="color:#b7c0c8"> &nbsp;·&nbsp; </span>
          <a href="${STORE_URL}" style="color:${BRAND_PRIMARY};text-decoration:none;font-weight:600">Buy individual standards</a>
        </p>
      </div>`;

  const claimHtml = ctx.claimUrl
    ? `<p style="margin:0 0 8px"><a href="${escapeHtml(ctx.claimUrl)}" style="display:inline-block;background:${BRAND_PRIMARY};color:#fff;text-decoration:none;padding:12px 22px;border-radius:6px;font-weight:600;font-size:15px">Save Search to My Lensy</a></p>
      <p style="margin:0 0 20px;font-size:13px;color:#666">This copies the collection into your own Lensy account, where you can add to it and keep your own notes. It does not change ${sender ? escapeHtml(sender) + "'s" : 'the sender&#39;s'} copy.</p>`
    : '';

  const meta = [
    ctx.collection?.collection_type ? ['Type', String(ctx.collection.collection_type)] : null,
    ctx.collection?.client_name ? ['Client', String(ctx.collection.client_name)] : null,
    ctx.collection?.location ? ['Location', String(ctx.collection.location)] : null,
  ].filter(Boolean) as Array<[string, string]>;

  const html = `<!doctype html><html><body style="margin:0;background:#f4f6f8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
  <div style="max-width:600px;margin:24px auto;background:#fff;border:1px solid #e2e6ea;border-radius:8px;overflow:hidden">
    <div style="background:${BRAND_SECONDARY};color:#fff;padding:16px 20px;font-size:15px;font-weight:700">Illuminating Engineering Society</div>
    <div style="padding:24px 20px">
      <h1 style="margin:0 0 14px;font-size:19px;color:${BRAND_SECONDARY}">${escapeHtml(topic)}</h1>
      ${paragraph(intro)}
      ${personal ? `<div style="margin:0 0 16px;padding:12px 14px;background:#f8fafb;border-left:3px solid ${BRAND_PRIMARY};font-size:14px;color:#444;line-height:1.55">${escapeHtml(personal)}</div>` : ''}
      ${note ? paragraph(`Collection note: ${note}`) : ''}
      ${meta.length ? `<p style="margin:0 0 16px;font-size:13px;color:#666">${meta.map(([k, v]) => `${escapeHtml(k)}: ${escapeHtml(v)}`).join(' &nbsp;·&nbsp; ')}</p>` : ''}
      <p style="margin:0 0 4px;font-size:13px;color:#7a8794;letter-spacing:.03em;text-transform:uppercase">${escapeHtml(countLine)}</p>
      <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;margin:0 0 22px">
      ${itemHtml || '<tr><td style="padding:14px 0;color:#666;font-size:14px">This collection has no saved results yet.</td></tr>'}
      </table>
      ${claimHtml}
      ${accessHtml}
      <p style="margin:22px 0 0;font-size:13px;color:#666">Questions about IES standards? Contact <a href="mailto:Standards@ies.org" style="color:${BRAND_SECONDARY}">Standards@ies.org</a>.</p>
    </div>
    <div style="padding:14px 20px;background:#f4f6f8;color:#888;font-size:12px">Sent by lensy.ies.org because ${sender ? escapeHtml(sender) : 'a Lensy user'} shared these search results with you — please do not reply to this message. Excerpt text is not reproduced; each reference links to the standard in the IES Lighting Library.</div>
  </div>
</body></html>`;

  const text = [
    topic,
    '',
    intro,
    ...(personal ? ['', personal] : []),
    ...(note ? ['', `Collection note: ${note}`] : []),
    ...(meta.length ? ['', meta.map(([k, v]) => `${k}: ${v}`).join(' · ')] : []),
    '',
    countLine,
    '',
    itemText || 'This collection has no saved results yet.',
    ...(ctx.claimUrl ? ['', `Save Search to My Lensy: ${ctx.claimUrl}`,
      'This copies the collection into your own Lensy account; the sender keeps theirs.'] : []),
    '',
    "Don't have access to these standards?",
    `Subscribe to the Lighting Library: ${SUBSCRIBE_URL}`,
    `Buy individual standards: ${STORE_URL}`,
    '',
    'Questions about IES standards? Contact Standards@ies.org.',
    '',
    `Sent by lensy.ies.org because ${sender || 'a Lensy user'} shared these search results with you — please do not reply.`,
    'Excerpt text is not reproduced; each reference links to the standard in the IES Lighting Library.',
  ].join('\n');

  return { subject, html, text };
}

/** Send one shared collection. Never throws — same contract as sendInviteEmail. */
export async function sendCollectionShareEmail(
  env: Env,
  ctx: CollectionShareEmailContext,
): Promise<SendOutcome> {
  const binding = env.SEND_EMAIL;
  if (!binding) {
    return { sent: false, error: 'SEND_EMAIL binding is not configured on this deployment.' };
  }
  const { subject, html, text } = buildCollectionShareEmail(ctx);
  try {
    await binding.send({
      to: ctx.to,
      from: { email: FROM_ADDRESS, name: FROM_NAME },
      subject,
      html,
      text,
    });
    return { sent: true };
  } catch (err) {
    const error = describeSendError(err);
    console.error('collection_share_email_failed', { to: ctx.to, error });
    return { sent: false, error };
  }
}

/** Reject a malformed recipient before the binding does, with a usable message. */
export function isEmailAddress(value: unknown): boolean {
  return typeof value === 'string' && /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/.test(value.trim());
}

/**
 * Absolute base URL for links in the mail. Derived from the request so staging
 * and localhost link to themselves instead of hard-coding production; LENSY_BASE_URL
 * overrides it when the Worker is reached through something other than its
 * public hostname.
 */
export function resolveAppUrl(request: Request, env: Env): string {
  const override = (env as Env & { LENSY_BASE_URL?: string }).LENSY_BASE_URL;
  if (override) return override.replace(/\/+$/, '');
  return new URL(request.url).origin;
}
