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
const FROM_NAME = 'IES Lens';

// IES brand tokens, matching the app shell (src/frontend/*.html).
const BRAND_SECONDARY = '#3A5068';
const BRAND_PRIMARY = '#D95D2B';

// The Lighting Library logo every email opens with (client 10/06/26 #2: the
// 2026 artwork with the TM mark). The Neg variant — white lettering — because
// it sits on the BRAND_SECONDARY band. An absolute URL on the canonical host:
// a mail client has no origin to resolve a relative path against, and a
// client that blocks images still shows the alt text in the band.
const EMAIL_LOGO_URL = 'https://lens.ies.org/assets/ies-lighting-library-2026-neg.png';

/** The dark header band with the Lighting Library logo, plus an optional label. */
function emailBanner(label?: string): string {
  return `<div style="background:${BRAND_SECONDARY};color:#fff;padding:10px 20px;font-size:15px;font-weight:700">`
    + `<img src="${EMAIL_LOGO_URL}" alt="The IES Lighting Library" width="160" height="78" style="display:block;border:0;height:78px;width:160px">`
    + (label ? `<div style="padding:2px 0 6px;font-size:13px;font-weight:600;opacity:.9">${label}</div>` : '')
    + `</div>`;
}

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

/**
 * "Near bottom, add 2 buttons: 'Video Overview' and 'Tutorials'" (client,
 * 10/20/26) — on every message a reader receives. The video is the one the
 * welcome window opens (index.html WELCOME_LINKS); keep the two in step.
 * Since 2026-10-28 it is the overview's permanent tutorial page, not the Loom
 * share URL: an email already sent keeps working when the video is replaced.
 */
const CANONICAL_APP_URL = 'https://lens.ies.org';
export const VIDEO_OVERVIEW_URL = `${CANONICAL_APP_URL}/tutorials/overview`;

function tutorialsUrl(appUrl?: string): string {
  return `${(appUrl || CANONICAL_APP_URL).replace(/\/+$/, '')}/tutorials`;
}

function resourceButtonsHtml(appUrl?: string): string {
  const btn = (href: string, label: string) =>
    `<a href="${escapeHtml(href)}" style="display:inline-block;margin:0 8px 8px 0;border:1px solid ${BRAND_SECONDARY};color:${BRAND_SECONDARY};text-decoration:none;padding:9px 16px;border-radius:6px;font-weight:600;font-size:14px">${label}</a>`;
  return `<p style="margin:0 0 18px">${btn(VIDEO_OVERVIEW_URL, 'Video Overview')}${btn(tutorialsUrl(appUrl), 'Tutorials')}</p>`;
}

function resourceLinesText(appUrl?: string): string[] {
  return [`Video Overview: ${VIDEO_OVERVIEW_URL}`, `Tutorials: ${tutorialsUrl(appUrl)}`];
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

  const subject = 'You have access to IES Lens — the IES Standards Assistant';

  const lines: string[] = [];
  lines.push(
    invitedBy
      ? `${invitedBy} has given you access to IES Lens, the Illuminating Engineering Society's AI-assisted guide for navigating IES resources.`
      : `You have been given access to IES Lens, the Illuminating Engineering Society's AI-assisted guide for navigating IES resources.`,
  );
  lines.push(
    'IES Lens can interpret your question, surface relevant excerpts, definitions, references, and illuminance recommendations, and link you directly to the source within the Lighting Library.',
  );
  lines.push(
    'Sign in with your IES account. The first time you sign in you may be asked to set a new password; look for a separate email from IES after you enter your address.',
  );
  if (ctx.expiresAt) {
    lines.push(`Your access runs through ${formatExpiry(ctx.expiresAt)}.`);
  }
  if (isStaffRole) {
    lines.push('Your account also has staff access to the IES Lens admin tools.');
  }

  const html = `<!doctype html><html><body style="margin:0;background:#f4f6f8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
  <div style="max-width:560px;margin:24px auto;background:#fff;border:1px solid #e2e6ea;border-radius:8px;overflow:hidden">
    ${emailBanner()}
    <div style="padding:24px 20px">
      <h1 style="margin:0 0 14px;font-size:19px;color:${BRAND_SECONDARY}">Your access to IES Lens is ready</h1>
      ${paragraph(greeting(ctx.name))}
      ${lines.map(paragraph).join('\n      ')}
      <p style="margin:0 0 20px"><a href="${escapeHtml(appUrl)}/" style="display:inline-block;background:${BRAND_PRIMARY};color:#fff;text-decoration:none;padding:12px 22px;border-radius:6px;font-weight:600;font-size:15px">Open IES Lens</a></p>
      <p style="margin:0 0 20px;font-size:13px;color:#666">If the button doesn't work, copy this address into your browser:<br><span style="color:${BRAND_SECONDARY};word-break:break-all">${escapeHtml(appUrl)}/</span></p>
      ${resourceButtonsHtml(appUrl)}
      <p style="margin:0;font-size:13px;color:#666">Technical support: <a href="https://ies.org/contact-us/" style="color:${BRAND_SECONDARY}">ies.org/contact-us</a>.</p>
    </div>
    <div style="padding:14px 20px;background:#f4f6f8;color:#888;font-size:12px">Sent by IES Lens because you were added to IES Lens's access list${invitedBy ? ` by ${escapeHtml(invitedBy)}` : ''} — please do not reply to this message.</div>
  </div>
</body></html>`;

  const text = [
    'Your access to IES Lens is ready',
    '',
    greeting(ctx.name),
    '',
    ...lines.flatMap((l) => [l, '']),
    `Open IES Lens: ${appUrl}/`,
    '',
    ...resourceLinesText(appUrl),
    '',
    'Technical support: https://ies.org/contact-us/',
    '',
    `Sent by IES Lens because you were added to IES Lens's access list${invitedBy ? ` by ${invitedBy}` : ''} — please do not reply.`,
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
const SUBSCRIBE_URL = 'https://ies.org/products/lighting-library/';

/** The client's description of the Library (10/20/26). */
const LIBRARY_PITCH = 'The Lighting Library is the complete library of IES standards and guidelines. '
  + 'Read lighting standards from IES committees or explore with IES Lens for guided access to definitions, documents, references, and more.';

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
  /** Absolute "Save to My Bookmarks" URL, or null when no token exists. */
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
        <p style="margin:0 0 10px;font-size:13px;color:#555;line-height:1.55">${escapeHtml(LIBRARY_PITCH)} Every reference above links to the exact page.</p>
        <p style="margin:0;font-size:13px">
          <a href="${SUBSCRIBE_URL}" style="color:${BRAND_PRIMARY};text-decoration:none;font-weight:600">Subscribe to the Lighting Library</a>
          <span style="color:#b7c0c8"> &nbsp;·&nbsp; </span>
          <a href="${STORE_URL}" style="color:${BRAND_PRIMARY};text-decoration:none;font-weight:600">Lease individual standards</a>
        </p>
      </div>`;

  const claimHtml = ctx.claimUrl
    ? `<p style="margin:0 0 8px"><a href="${escapeHtml(ctx.claimUrl)}" style="display:inline-block;background:${BRAND_PRIMARY};color:#fff;text-decoration:none;padding:12px 22px;border-radius:6px;font-weight:600;font-size:15px">Save to My Bookmarks</a></p>
      <p style="margin:0 0 20px;font-size:13px;color:#666">This copies the collection into your own IES Lens account, where you can add to it and keep your own notes. It does not change ${sender ? escapeHtml(sender) + "'s" : 'the sender&#39;s'} copy.</p>`
    : '';

  const meta = [
    ctx.collection?.collection_type ? ['Type', String(ctx.collection.collection_type)] : null,
    ctx.collection?.client_name ? ['Client', String(ctx.collection.client_name)] : null,
    ctx.collection?.location ? ['Location', String(ctx.collection.location)] : null,
  ].filter(Boolean) as Array<[string, string]>;

  const html = `<!doctype html><html><body style="margin:0;background:#f4f6f8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
  <div style="max-width:600px;margin:24px auto;background:#fff;border:1px solid #e2e6ea;border-radius:8px;overflow:hidden">
    ${emailBanner()}
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
      <div style="margin:22px 0 0">${resourceButtonsHtml(appUrl)}</div>
      <p style="margin:4px 0 0;font-size:13px;color:#666">Technical support: <a href="https://ies.org/contact-us/" style="color:${BRAND_SECONDARY}">ies.org/contact-us</a>.</p>
    </div>
    <div style="padding:14px 20px;background:#f4f6f8;color:#888;font-size:12px">Sent by IES Lens because ${sender ? escapeHtml(sender) : 'an IES Lens user'} shared these search results with you — please do not reply to this message. Excerpt text is not reproduced; each reference links to the standard in the IES Lighting Library.</div>
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
    ...(ctx.claimUrl ? ['', `Save to My Bookmarks: ${ctx.claimUrl}`,
      'This copies the collection into your own IES Lens account; the sender keeps theirs.'] : []),
    '',
    "Don't have access to these standards?",
    `Subscribe to the Lighting Library: ${SUBSCRIBE_URL}`,
    LIBRARY_PITCH,
    `Lease individual standards: ${STORE_URL}`,
    '',
    ...resourceLinesText(appUrl),
    '',
    'Technical support: https://ies.org/contact-us/',
    '',
    `Sent by IES Lens because ${sender || 'an IES Lens user'} shared these search results with you — please do not reply.`,
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

// ─── Device-limit reset request → staff (Vitrium error page, 2026-09-04) ──────

export interface DeviceResetEmailContext {
  /** Staff inbox — env.DEVICE_RESET_NOTIFY_EMAIL. */
  to: string;
  requestId: number | null;
  email: string;
  name: string | null;
  documentTitle: string | null;
  documentCode: string | null;
  /** vc3 | dvc3 | dovc3 | dpvc3 | vp3 | ipvc3 */
  errorCode: string;
  /** Human meaning of the code (CLEAR_USE_LABELS). */
  errorLabel: string;
  userNote: string | null;
  rawMessage: string | null;
}

/**
 * The staff notification for one device/usage-limit reset request.
 *
 * The reset itself happens in the Vitrium admin app — Users tab → "Clear Use"
 * beside the user, which is Vitrium's documented fix for this whole error
 * family — so the mail's job is to hand staff everything that action needs:
 * who, which document, which limit, and the requester's own words. Vitrium's
 * guide also says to clear usage only when fraud or unauthorized sharing is NOT
 * suspected; the mail repeats that so the judgement stays with staff.
 */
export function buildDeviceResetEmail(ctx: DeviceResetEmailContext): InviteEmailContent {
  const subject = `Device limit reset request: ${ctx.email}${ctx.documentTitle ? ` — ${ctx.documentTitle}` : ''}`;

  const rows: Array<[string, string]> = [
    ['Requested by', ctx.name ? `${ctx.name} <${ctx.email}>` : ctx.email],
    ['Document', ctx.documentTitle || ctx.documentCode || 'Not identified'],
    ...(ctx.documentTitle && ctx.documentCode ? [['Viewer code', ctx.documentCode] as [string, string]] : []),
    ['Limit hit', `${ctx.errorLabel} (${ctx.errorCode})`],
    ...(ctx.rawMessage ? [['Viewer message', ctx.rawMessage] as [string, string]] : []),
    ...(ctx.requestId != null ? [['Request #', String(ctx.requestId)] as [string, string]] : []),
  ];

  const html = `<!doctype html><html><body style="margin:0;background:#f4f6f8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
  <div style="max-width:560px;margin:24px auto;background:#fff;border:1px solid #e2e6ea;border-radius:8px;overflow:hidden">
    ${emailBanner('Staff notification')}
    <div style="padding:24px 20px">
      <h1 style="margin:0 0 14px;font-size:19px;color:${BRAND_SECONDARY}">Device limit reset requested</h1>
      ${paragraph('A reader hit a usage limit in the Lighting Library viewer and asked for it to be reset. Details below.')}
      <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;margin:0 0 16px">
        ${rows.map(([k, v]) => `<tr>
          <td style="padding:6px 12px 6px 0;font-size:13px;color:#7a8794;white-space:nowrap;vertical-align:top">${escapeHtml(k)}</td>
          <td style="padding:6px 0;font-size:14px;color:#333">${escapeHtml(v)}</td>
        </tr>`).join('\n        ')}
      </table>
      ${ctx.userNote ? `<div style="margin:0 0 16px;padding:12px 14px;background:#f8fafb;border-left:3px solid ${BRAND_PRIMARY};font-size:14px;color:#444;line-height:1.55">${escapeHtml(ctx.userNote)}</div>` : ''}
      ${paragraph('To approve: sign in to the Vitrium admin app, open the Users tab, find this user, and click "Clear Use" beside their row. Per Vitrium’s guidance, clear usage only if you do not suspect fraud or unauthorized sharing.')}
      <p style="margin:0;font-size:13px;color:#666">Reply to the requester: <a href="mailto:${escapeHtml(ctx.email)}" style="color:${BRAND_SECONDARY}">${escapeHtml(ctx.email)}</a></p>
    </div>
    <div style="padding:14px 20px;background:#f4f6f8;color:#888;font-size:12px">Sent by IES Lens from the Lighting Library error page. The full request queue is available to administrators at /api/admin/device-resets.csv.</div>
  </div>
</body></html>`;

  const text = [
    'Device limit reset requested',
    '',
    'A reader hit a usage limit in the Lighting Library viewer and asked for it to be reset.',
    '',
    ...rows.map(([k, v]) => `${k}: ${v}`),
    ...(ctx.userNote ? ['', `Requester's note: ${ctx.userNote}`] : []),
    '',
    'To approve: Vitrium admin app → Users tab → find this user → "Clear Use".',
    'Per Vitrium’s guidance, clear usage only if you do not suspect fraud or unauthorized sharing.',
    '',
    `Reply to the requester: ${ctx.email}`,
  ].join('\n');

  return { subject, html, text };
}

/** Send one staff notification. Never throws — same contract as sendInviteEmail. */
export async function sendDeviceResetEmail(
  env: Env,
  ctx: DeviceResetEmailContext,
): Promise<SendOutcome> {
  const binding = env.SEND_EMAIL;
  if (!binding) {
    return { sent: false, error: 'SEND_EMAIL binding is not configured on this deployment.' };
  }
  const { subject, html, text } = buildDeviceResetEmail(ctx);
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
    console.error('device_reset_email_failed', { to: ctx.to, error });
    return { sent: false, error };
  }
}

// ─── The reader's answer to a device-limit reset request (client 10/20/26) ────

export interface DeviceResetDecisionContext {
  to: string;
  name: string | null;
  approved: boolean;
  /** Designation + title of the document the reader was refused, if known. */
  documentTitle: string | null;
}

/**
 * "If staff approves: send email to user … If staff rejects: notify user via
 * email" — the sentences are the client's own.
 */
export function buildDeviceResetDecisionEmail(ctx: DeviceResetDecisionContext): InviteEmailContent {
  const tutorials = tutorialsUrl();
  const subject = ctx.approved
    ? 'Your Lighting Library device limit reset was approved'
    : 'Your Lighting Library device limit reset request';
  const [before, after] = ctx.approved
    ? ['Staff has authorized a one-time device limit reset. To maintain your access, limit your use to two browsers (e.g. one on a laptop and one on a mobile device) and avoid clearing your browser cache. Visit the ',
       ' page to learn more.']
    : ['Per the terms of service, staff was unable to approve your request for a device limit reset. Please continue to access your Lighting Library subscription from the two registered personal devices. Visit the ',
       ' page to learn more.'];
  const docLine = ctx.documentTitle ? `Your request concerned ${ctx.documentTitle}.` : '';

  const html = `<!doctype html><html><body style="margin:0;background:#f4f6f8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
  <div style="max-width:560px;margin:24px auto;background:#fff;border:1px solid #e2e6ea;border-radius:8px;overflow:hidden">
    ${emailBanner()}
    <div style="padding:24px 20px">
      <h1 style="margin:0 0 14px;font-size:19px;color:${BRAND_SECONDARY}">${ctx.approved ? 'Device limit reset approved' : 'Device limit reset not approved'}</h1>
      ${paragraph(greeting(ctx.name))}
      <p style="margin:0 0 16px;color:#444;font-size:15px;line-height:1.55">${escapeHtml(before)}<a href="${escapeHtml(tutorials)}" style="color:${BRAND_PRIMARY};font-weight:700;text-decoration:none">Tutorials</a>${escapeHtml(after)}</p>
      ${docLine ? paragraph(docLine) : ''}
      <p style="margin:0 0 20px"><a href="${LIBRARY_URL}" style="display:inline-block;background:${BRAND_PRIMARY};color:#fff;text-decoration:none;padding:12px 22px;border-radius:6px;font-weight:600;font-size:15px">Open the IES Lighting Library</a></p>
      ${resourceButtonsHtml()}
      <p style="margin:0;font-size:13px;color:#666">Technical support: <a href="https://ies.org/contact-us/" style="color:${BRAND_SECONDARY}">ies.org/contact-us</a>.</p>
    </div>
    <div style="padding:14px 20px;background:#f4f6f8;color:#888;font-size:12px">Sent by IES Lens in answer to your device limit reset request — please do not reply to this message.</div>
  </div>
</body></html>`;

  const text = [
    ctx.approved ? 'Device limit reset approved' : 'Device limit reset not approved',
    '',
    greeting(ctx.name),
    '',
    `${before}Tutorials${after} ${tutorials}`,
    ...(docLine ? ['', docLine] : []),
    '',
    `Open the IES Lighting Library: ${LIBRARY_URL}`,
    '',
    ...resourceLinesText(),
    '',
    'Technical support: https://ies.org/contact-us/',
    '',
    'Sent by IES Lens in answer to your device limit reset request — please do not reply.',
  ].join('\n');
  return { subject, html, text };
}

export async function sendDeviceResetDecisionEmail(env: Env, ctx: DeviceResetDecisionContext): Promise<SendOutcome> {
  const binding = env.SEND_EMAIL;
  if (!binding) return { sent: false, error: 'SEND_EMAIL binding is not configured on this deployment.' };
  const { subject, html, text } = buildDeviceResetDecisionEmail(ctx);
  try {
    await binding.send({ to: ctx.to, from: { email: FROM_ADDRESS, name: FROM_NAME }, subject, html, text });
    return { sent: true };
  } catch (err) {
    const error = describeSendError(err);
    console.error('device_reset_decision_email_failed', { to: ctx.to, error });
    return { sent: false, error };
  }
}

// ─── Complimentary document access (client DO110) ─────────────────────────────

/** One granted standard, already resolved against D1 by the caller. */
export interface CompAccessDocument {
  /** standards.id — 'RP-8-25+E2'. */
  id: string;
  /** standards.full_designation, or a constructed 'ANSI/IES <id>'. */
  designation: string;
  title: string | null;
  /**
   * The BRANDED Lighting Library link (lib/library-url.js), or null when the
   * standard has no viewer URL synced. Never Vitrium's own viewer host: a
   * reader following that lands on a Vitrium auth error.
   */
  libraryUrl: string | null;
}

export interface CompAccessEmailContext {
  to: string;
  name: string | null;
  /** 'lens' = full IES Lens + the whole Lighting Library (client 10/16/26 #6). */
  scope?: 'documents' | 'lens';
  /** The Lighting Library half is already live (AuthIES took the grant). */
  applied?: boolean;
  documents: CompAccessDocument[];
  days: number;
  /** YYYY-MM-DD. */
  startDate: string;
  endDate: string;
  /** Staff member who cut the grant, if they filled it in. */
  grantedBy: string | null;
}

/** The library the granted documents live in — where the reader signs in. */
const LIBRARY_URL = 'https://lighting.ies.org/';
const LENS_URL = 'https://lens.ies.org/';

/**
 * The recipient's notification for one complimentary access grant.
 *
 * Deliberately says "access will be available in the IES Lighting Library"
 * rather than "is available now": the permission is added by hand in the
 * Vitrium admin app (see migration 0020), so this mail can go out minutes
 * before the access does. Naming that gap is better than a reader concluding
 * the link is broken.
 *
 * The client asked for "full designations and titles of documents" and a
 * hyperlink per standard, which is exactly what the list below prints.
 */
export function buildCompAccessEmail(ctx: CompAccessEmailContext): InviteEmailContent {
  const lens = ctx.scope === 'lens';
  const docs = lens ? [] : (ctx.documents || []);
  const count = docs.length;
  const subject = lens
    ? `Complimentary ${ctx.days}-day access to IES Lens and the IES Lighting Library`
    : count === 1
      ? `Complimentary ${ctx.days}-day access: ${docs[0].designation}`
      : `Complimentary ${ctx.days}-day access to ${count} IES standards`;

  // Client 10/20/26: "granted"; a document grant says what it does NOT include;
  // a Lens comp is a Subscription for the window. "Give it a few hours" went:
  // the grant is applied automatically (AuthIES), so the honest advice is a
  // browser refresh, with support as the fallback for the rare manual case.
  const by = ctx.grantedBy ? `${ctx.grantedBy} at the Illuminating Engineering Society` : 'The Illuminating Engineering Society';
  const lines: string[] = [];
  lines.push(lens
    ? `${by} has granted you complimentary ${ctx.days}-day access to the full Lighting Library and IES Lens.`
    : `${by} has granted you complimentary ${ctx.days}-day access to the ${count === 1 ? 'standard' : 'standards'} listed below.`);
  lines.push(lens
    ? `Your access runs from ${formatExpiry(ctx.startDate)} through ${formatExpiry(ctx.endDate)}.`
    : `Your access runs from ${formatExpiry(ctx.startDate)} through ${formatExpiry(ctx.endDate)}. It covers only these documents — it is not a Lighting Library subscription and does not include full access to IES Lens.`);
  // "What steps if any does a user have to take if they do not already have an
  // existing IES account with us under that email?" (client 10/16/26 #6) —
  // AuthIES matches the grant by email at sign-in, so the answer is in the mail.
  lines.push(
    `${lens ? 'Sign in to the Lighting Library with your IES account to get started' : 'Sign in to the Lighting Library with your IES account to read them'}, using this email address (${ctx.to}). If you do not have an IES account yet, create a free one at ies.org with this same address — your access applies the first time you sign in.`,
  );
  lines.push(ctx.applied
    ? 'If your access does not appear right away, refresh your browser page.'
    : 'If your access does not appear right away, refresh your browser page; if it is still missing after a few hours, contact us at ies.org/contact-us.');
  const heading = `Your complimentary ${ctx.days}-day ${lens ? 'Subscription' : 'Document'} access`;
  // Only a document grant is told what a subscription adds.
  const subscribeHtml = lens ? '' : `<p style="margin:0 0 16px;color:#444;font-size:15px;line-height:1.55"><a href="${SUBSCRIBE_URL}" style="color:${BRAND_PRIMARY};font-weight:700;text-decoration:none">Subscribe</a> for full access.</p>`;
  const subscribeText = lens ? [] : [`Subscribe for full access: ${SUBSCRIBE_URL}`, ''];

  const docHtml = docs.map(d => {
    const label = d.title ? `${d.designation} ${d.title}` : d.designation;
    return `<tr><td style="padding:10px 0;border-bottom:1px solid #eef1f4">
        <div style="font-size:14px;color:${BRAND_SECONDARY};font-weight:600;line-height:1.45">${escapeHtml(label)}</div>
        ${d.libraryUrl ? `<div style="padding-top:5px"><a href="${escapeHtml(d.libraryUrl)}" style="color:${BRAND_PRIMARY};font-size:13px;text-decoration:none">Open in the IES Lighting Library →</a></div>` : ''}
      </td></tr>`;
  }).join('\n      ');

  const docText = docs.map(d => {
    const label = d.title ? `${d.designation} ${d.title}` : d.designation;
    return d.libraryUrl ? `${label}\n    ${d.libraryUrl}` : label;
  }).join('\n\n');

  const html = `<!doctype html><html><body style="margin:0;background:#f4f6f8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
  <div style="max-width:600px;margin:24px auto;background:#fff;border:1px solid #e2e6ea;border-radius:8px;overflow:hidden">
    ${emailBanner()}
    <div style="padding:24px 20px">
      <h1 style="margin:0 0 14px;font-size:19px;color:${BRAND_SECONDARY}">${escapeHtml(heading)}</h1>
      ${paragraph(greeting(ctx.name))}
      ${lines.slice(0, 2).map(paragraph).join('\n      ')}
      ${subscribeHtml}
      ${lines.slice(2).map(paragraph).join('\n      ')}
      ${lens ? '' : `<p style="margin:0 0 4px;font-size:13px;color:#7a8794;letter-spacing:.03em;text-transform:uppercase">${count === 1 ? '1 standard' : `${count} standards`}</p>
      <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;margin:0 0 22px">
      ${docHtml}
      </table>`}
      ${lens ? `<p style="margin:0 0 12px"><a href="${LENS_URL}" style="display:inline-block;background:${BRAND_PRIMARY};color:#fff;text-decoration:none;padding:12px 22px;border-radius:6px;font-weight:600;font-size:15px">Open IES Lens</a></p>` : ''}
      <p style="margin:0 0 20px"><a href="${LIBRARY_URL}" style="display:inline-block;background:${BRAND_PRIMARY};color:#fff;text-decoration:none;padding:12px 22px;border-radius:6px;font-weight:600;font-size:15px">Open the IES Lighting Library</a></p>
      ${resourceButtonsHtml()}
      <p style="margin:0;font-size:13px;color:#666">Technical support: <a href="https://ies.org/contact-us/" style="color:${BRAND_SECONDARY}">ies.org/contact-us</a>.</p>
    </div>
    <div style="padding:14px 20px;background:#f4f6f8;color:#888;font-size:12px">Sent by IES Lens because IES granted you complimentary access${lens ? '' : ' to these standards'}${ctx.grantedBy ? ` (${escapeHtml(ctx.grantedBy)})` : ''} — please do not reply to this message.</div>
  </div>
</body></html>`;

  const text = [
    heading,
    '',
    greeting(ctx.name),
    '',
    ...lines.slice(0, 2).flatMap(l => [l, '']),
    ...subscribeText,
    ...lines.slice(2).flatMap(l => [l, '']),
    ...(lens ? [`Open IES Lens: ${LENS_URL}`] : [count === 1 ? '1 standard' : `${count} standards`, '', docText]),
    '',
    `Open the IES Lighting Library: ${LIBRARY_URL}`,
    '',
    ...resourceLinesText(),
    '',
    'Technical support: https://ies.org/contact-us/',
    '',
    `Sent by IES Lens because IES granted you complimentary access${lens ? '' : ' to these standards'}${ctx.grantedBy ? ` (${ctx.grantedBy})` : ''} — please do not reply.`,
  ].join('\n');

  return { subject, html, text };
}

/** Send one grant notification. Never throws — same contract as sendInviteEmail. */
export async function sendCompAccessEmail(
  env: Env,
  ctx: CompAccessEmailContext,
): Promise<SendOutcome> {
  const binding = env.SEND_EMAIL;
  if (!binding) {
    return { sent: false, error: 'SEND_EMAIL binding is not configured on this deployment.' };
  }
  const { subject, html, text } = buildCompAccessEmail(ctx);
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
    console.error('comp_access_email_failed', { to: ctx.to, error });
    return { sent: false, error };
  }
}

// ─── Webstore purchases (SureCart, 2026-10-26) ────────────────────────────────

export interface PurchaseEmailContext {
  to: string;
  name: string | null;
  kind: 'lease' | 'subscription';
  /** The leased standard; null for a subscription. */
  document: CompAccessDocument | null;
  /** YYYY-MM-DD, inclusive. */
  startDate: string;
  endDate: string;
  orderNumber: string | null;
}

/**
 * The buyer's notification once AuthIES holds the grant. SureCart already
 * sent the receipt; this mail is the one that says WHERE to read — the
 * Library link for a lease, IES Lens + the Library for a subscription — and,
 * as with comps, that the access is matched to the email they bought under.
 */
export function buildPurchaseEmail(ctx: PurchaseEmailContext): InviteEmailContent {
  const lease = ctx.kind === 'lease';
  const doc = lease ? ctx.document : null;
  const label = doc ? (doc.title ? `${doc.designation} ${doc.title}` : doc.designation) : '';
  const subject = lease
    ? `Your 3-year lease is ready: ${doc?.designation ?? 'IES standard'}`
    : 'Your Lighting Library subscription is active';
  const heading = lease ? 'Your 3-year lease is ready' : 'Your Lighting Library subscription is active';
  const order = ctx.orderNumber ? ` (order #${ctx.orderNumber})` : '';

  const lines: string[] = [];
  lines.push(lease
    ? `Thank you for your purchase at the IES webstore${order}. Your 3-year lease of ${label} is ready to read in the IES Lighting Library.`
    : `Thank you for your purchase at the IES webstore${order}. Your Lighting Library subscription is active: read every current IES standard in the Lighting Library and explore them with IES Lens.`);
  lines.push(lease
    ? `Your access runs from ${formatExpiry(ctx.startDate)} through ${formatExpiry(ctx.endDate)}. It covers this document only — it is not a Lighting Library subscription and does not include full access to IES Lens.`
    : `Your access runs from ${formatExpiry(ctx.startDate)} through ${formatExpiry(ctx.endDate)} and renews with your subscription.`);
  lines.push(
    `Sign in to the Lighting Library with your IES account using this email address (${ctx.to}). If you do not have an IES account yet, create a free one at ies.org with this same address — your access applies the first time you sign in.`,
  );
  lines.push('If your access does not appear right away, refresh your browser page; if it is still missing, contact us at ies.org/contact-us.');

  const subscribeHtml = lease ? `<p style="margin:0 0 16px;color:#444;font-size:15px;line-height:1.55"><a href="${SUBSCRIBE_URL}" style="color:${BRAND_PRIMARY};font-weight:700;text-decoration:none">Subscribe</a> for full access to every standard and to IES Lens.</p>` : '';
  const subscribeText = lease ? [`Subscribe for full access: ${SUBSCRIBE_URL}`, ''] : [];
  const docHtml = doc ? `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;margin:0 0 22px">
      <tr><td style="padding:10px 0;border-bottom:1px solid #eef1f4">
        <div style="font-size:14px;color:${BRAND_SECONDARY};font-weight:600;line-height:1.45">${escapeHtml(label)}</div>
        ${doc.libraryUrl ? `<div style="padding-top:5px"><a href="${escapeHtml(doc.libraryUrl)}" style="color:${BRAND_PRIMARY};font-size:13px;text-decoration:none">Open in the IES Lighting Library →</a></div>` : ''}
      </td></tr>
      </table>` : '';
  const docText = doc ? [doc.libraryUrl ? `${label}\n    ${doc.libraryUrl}` : label, ''] : [];

  const html = `<!doctype html><html><body style="margin:0;background:#f4f6f8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
  <div style="max-width:600px;margin:24px auto;background:#fff;border:1px solid #e2e6ea;border-radius:8px;overflow:hidden">
    ${emailBanner()}
    <div style="padding:24px 20px">
      <h1 style="margin:0 0 14px;font-size:19px;color:${BRAND_SECONDARY}">${escapeHtml(heading)}</h1>
      ${paragraph(greeting(ctx.name))}
      ${lines.slice(0, 2).map(paragraph).join('\n      ')}
      ${docHtml}
      ${subscribeHtml}
      ${lines.slice(2).map(paragraph).join('\n      ')}
      ${lease ? '' : `<p style="margin:0 0 12px"><a href="${LENS_URL}" style="display:inline-block;background:${BRAND_PRIMARY};color:#fff;text-decoration:none;padding:12px 22px;border-radius:6px;font-weight:600;font-size:15px">Open IES Lens</a></p>`}
      <p style="margin:0 0 20px"><a href="${doc?.libraryUrl ?? LIBRARY_URL}" style="display:inline-block;background:${BRAND_PRIMARY};color:#fff;text-decoration:none;padding:12px 22px;border-radius:6px;font-weight:600;font-size:15px">Open the IES Lighting Library</a></p>
      ${resourceButtonsHtml()}
      <p style="margin:0;font-size:13px;color:#666">Technical support: <a href="https://ies.org/contact-us/" style="color:${BRAND_SECONDARY}">ies.org/contact-us</a>.</p>
    </div>
    <div style="padding:14px 20px;background:#f4f6f8;color:#888;font-size:12px">Sent by IES Lens because of your purchase at the IES webstore${escapeHtml(order)} — please do not reply to this message.</div>
  </div>
</body></html>`;

  const text = [
    heading,
    '',
    greeting(ctx.name),
    '',
    ...lines.slice(0, 2).flatMap(l => [l, '']),
    ...docText,
    ...subscribeText,
    ...lines.slice(2).flatMap(l => [l, '']),
    ...(lease ? [] : [`Open IES Lens: ${LENS_URL}`, '']),
    `Open the IES Lighting Library: ${doc?.libraryUrl ?? LIBRARY_URL}`,
    '',
    ...resourceLinesText(),
    '',
    'Technical support: https://ies.org/contact-us/',
    '',
    `Sent by IES Lens because of your purchase at the IES webstore${order} — please do not reply.`,
  ].join('\n');

  return { subject, html, text };
}

/** Send one purchase notification. Never throws — same contract as sendCompAccessEmail. */
export async function sendPurchaseEmail(env: Env, ctx: PurchaseEmailContext): Promise<SendOutcome> {
  const binding = env.SEND_EMAIL;
  if (!binding) {
    return { sent: false, error: 'SEND_EMAIL binding is not configured on this deployment.' };
  }
  const { subject, html, text } = buildPurchaseEmail(ctx);
  try {
    await binding.send({ to: ctx.to, from: { email: FROM_ADDRESS, name: FROM_NAME }, subject, html, text });
    return { sent: true };
  } catch (err) {
    const error = describeSendError(err);
    console.error('purchase_email_failed', { to: ctx.to, error });
    return { sent: false, error };
  }
}

export interface LeaseExpiryEmailContext {
  to: string;
  name: string | null;
  document: CompAccessDocument;
  /** YYYY-MM-DD, the last day of access (inclusive). */
  endDate: string;
}

/**
 * One month before a 3-year lease ends (client, 2026-10-27: "no auto-renewal.
 * However … automate emails to the user 1 month from end of lease that it is
 * about to expire and they can subscribe to the entire Lighting Library for
 * continued access"). Sent once per lease by the daily cron
 * (workers/lease-reminders.ts).
 */
export function buildLeaseExpiryEmail(ctx: LeaseExpiryEmailContext): InviteEmailContent {
  const doc = ctx.document;
  const label = doc.title ? `${doc.designation} ${doc.title}` : doc.designation;
  const ends = formatExpiry(ctx.endDate);
  const subject = `Your 3-year lease of ${doc.designation} ends on ${ends}`;
  const heading = 'Your 3-year lease ends soon';

  const lines = [
    `Your 3-year lease of ${label} in the IES Lighting Library ends on ${ends}. Leases do not renew automatically, so your access to this document stops after that day.`,
    'For continued access, subscribe to the Lighting Library: every current IES standard, including this one, with IES Lens to search and explore them.',
  ];

  const html = `<!doctype html><html><body style="margin:0;background:#f4f6f8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
  <div style="max-width:600px;margin:24px auto;background:#fff;border:1px solid #e2e6ea;border-radius:8px;overflow:hidden">
    ${emailBanner()}
    <div style="padding:24px 20px">
      <h1 style="margin:0 0 14px;font-size:19px;color:${BRAND_SECONDARY}">${escapeHtml(heading)}</h1>
      ${paragraph(greeting(ctx.name))}
      ${lines.map(paragraph).join('\n      ')}
      <p style="margin:0 0 20px"><a href="${SUBSCRIBE_URL}" style="display:inline-block;background:${BRAND_PRIMARY};color:#fff;text-decoration:none;padding:12px 22px;border-radius:6px;font-weight:600;font-size:15px">Subscribe to the Lighting Library</a></p>
      ${doc.libraryUrl ? `<p style="margin:0 0 18px;font-size:14px"><a href="${escapeHtml(doc.libraryUrl)}" style="color:${BRAND_SECONDARY}">Open ${escapeHtml(doc.designation)} in the Lighting Library →</a></p>` : ''}
      ${resourceButtonsHtml()}
      <p style="margin:0;font-size:13px;color:#666">Technical support: <a href="https://ies.org/contact-us/" style="color:${BRAND_SECONDARY}">ies.org/contact-us</a>.</p>
    </div>
    <div style="padding:14px 20px;background:#f4f6f8;color:#888;font-size:12px">Sent by IES Lens because of your 3-year lease at the IES webstore — please do not reply to this message.</div>
  </div>
</body></html>`;

  const text = [
    heading,
    '',
    greeting(ctx.name),
    '',
    ...lines.flatMap(l => [l, '']),
    `Subscribe to the Lighting Library: ${SUBSCRIBE_URL}`,
    ...(doc.libraryUrl ? [`Open ${doc.designation}: ${doc.libraryUrl}`] : []),
    '',
    ...resourceLinesText(),
    '',
    'Technical support: https://ies.org/contact-us/',
    '',
    'Sent by IES Lens because of your 3-year lease at the IES webstore — please do not reply.',
  ].join('\n');

  return { subject, html, text };
}

/** Send one lease-expiry reminder. Never throws — same contract as sendPurchaseEmail. */
export async function sendLeaseExpiryEmail(env: Env, ctx: LeaseExpiryEmailContext): Promise<SendOutcome> {
  const binding = env.SEND_EMAIL;
  if (!binding) {
    return { sent: false, error: 'SEND_EMAIL binding is not configured on this deployment.' };
  }
  const { subject, html, text } = buildLeaseExpiryEmail(ctx);
  try {
    await binding.send({ to: ctx.to, from: { email: FROM_ADDRESS, name: FROM_NAME }, subject, html, text });
    return { sent: true };
  } catch (err) {
    const error = describeSendError(err);
    console.error('lease_expiry_email_failed', { to: ctx.to, error });
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
