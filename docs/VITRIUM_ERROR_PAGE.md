# Lighting Library Custom Error Page

*Client note, 2026-09-04: "We'd like to leverage the Custom Error Page option to
guide users directly to the purchase page for the document and/or subscription
if they don't have permission to view it. It also seems like an opportunity to
provide IES-specific guidance (account not found, expired subscription, etc.).
We will need instruction for users who exceed device limit (ideally, they submit
a form which goes to staff for approval to reset device limit)."*

## How Vitrium's mechanism works

When the WebViewer refuses a reader, Vitrium redirects the browser to ONE page
you host, passing everything it knows in the query string:

```
/library-error.html?username=<vitrium username>&userid=<guid>
  &url=https%3A%2F%2Fview.protectedpdf.com%2FForbidden%2F<shortcode>
  &message=You+have+exceeded+your+device+limit+(vc3).&lang=en
```

The DRM error code arrives inside `message`, in trailing parentheses. The `url`
is the refused document's own viewer URL with a `/Forbidden` segment injected —
the short code in it is the same one `standards.vitrium_web_url` stores, which
is what lets the page name the document and link its purchase page.

Sources: Vitrium's *Custom Error Page Configuration Manual* (April 2023), its
sample project (`https://www.vitrium.com/hubfs/api-samples/CustomErrorPage.zip`),
and its *Error Code Reference Guide*
(`https://www.vitrium.com/hubfs/support-pdfs/vitrium-error-code-reference-guide-1.pdf`).

> Vitrium's sample assigns query-string values with `innerHTML` — an XSS. Our
> page renders every untrusted value with `textContent` only. Never regress this.

## What we built

| Piece | Where |
|---|---|
| The error page (public — no auth gate) | `src/frontend/library-error.html` → `https://lensy.ies.org/library-error.html` |
| Document lookup (short code → designation, title, buy link, successor) | `GET /api/library/document?code=…` (public; `src/workers/library-support.ts`) |
| Device-limit reset request | `POST /api/library/device-reset` (public, narrow; same file) |
| Request queue | `device_reset_requests` (migration 0016) |
| Staff notification email | `buildDeviceResetEmail` in `src/lib/email.ts`, sent when `DEVICE_RESET_NOTIFY_EMAIL` is set |
| Staff queue export / bookkeeping | `GET /api/admin/device-resets.csv`, `POST /api/admin/device-resets {id, status}` (admin gate) |
| Shared parsers | `src/lib/vitrium-support.js` (the page carries its own copy — it must survive re-hosting) |

## What the page shows, per error code

| Codes | View |
|---|---|
| `w29`, `n4p`, `4k3` (no permission) | **Purchase funnel**: "Buy this document" (that document's `buy_url`, once the lookup resolves), "Subscribe to the Lighting Library", store link, plus "check you signed in with the email the purchase is under". |
| `qe2`, `rqe2` (expired) | **Renewal**: renew/subscribe + buy-this-document. |
| `vc3`, `dvc3`, `dovc3`, `dpvc3`, `vp3`, `ipvc3` (usage limits) | **Reset request form** — the whole family Vitrium documents as fixed by admin → Users → "Clear Use". Email prefilled from `username`; honeypot; submits to the endpoint. |
| `3yq`, `g45` (account not found) | Activation guidance (same-email check, confirmation link) + support. |
| `m47` (inactive), `7ud` (locked), `bw5` (bad credentials), `7rp` (forced reset) | Account-state guidance, sign-in / password-reset pointers. |
| `qs2` (start date in future) | "Your access hasn't started yet." |
| `2p3` (deactivated document) | "No longer available" — and when D1 knows `superseded_by`, a notice naming and linking the current edition. |
| `rc7`, `rc8` (region) | Region restriction notice. |
| `rc9`, `gf4`, `gf5` (technical) | Try again / contact support. |
| Anything else | Generic view carrying Vitrium's own message verbatim. |

Every view keeps a "Technical details" disclosure (message, code, username,
user id, URL) so a support email carries what staff need.

## The device-reset flow

1. Reader hits a usage limit → form on the error page (name optional, email,
   note). Only the Clear-Use codes are accepted server-side.
2. `POST /api/library/device-reset` stores the row; repeats collapse into the
   open request (`alreadyPending`) instead of re-notifying staff. A row that
   cannot be stored answers 500 — never a false "received".
3. If `DEVICE_RESET_NOTIFY_EMAIL` is set, staff get one email per request with
   who / which document / which limit / the requester's words, the Vitrium
   action ("Users tab → Clear Use"), and Vitrium's own fraud caveat. Send
   outcome is recorded on the row (`notify_sent` / `notify_error`).
4. Staff clear usage in the Vitrium admin app, then mark the row:
   `POST /api/admin/device-resets {"id": N, "status": "done"}`. The queue
   exports at `GET /api/admin/device-resets.csv?status=new`.

Abuse posture: honeypot field, per-IP rate limit (the search limiter, keyed
`device-reset:<ip>`, fail-open), length caps on every field, and the
document/title enrichment comes from OUR D1 lookup, not from what the caller
typed.

## Setup checklist

1. `npx wrangler d1 migrations apply ies-metadata --remote` — applies 0016.
   (Per the account quirk, `--remote --file` 401s but migrations/`--command`
   work.)
2. `npm run deploy` — ships the Worker, the page, and the endpoints together.
3. Vitrium admin app → **Settings → Web Viewer Settings → "Custom URL for Error
   Page"** → `https://lensy.ies.org/library-error.html`. (Client/IES staff —
   we have no Vitrium admin credentials.)
4. When IES names the staff inbox: uncomment `DEVICE_RESET_NOTIFY_EMAIL` in
   `wrangler.toml` and redeploy. Until then requests queue silently in D1.
5. When IES confirms the reader-facing support address: update `SUPPORT_EMAIL`
   in `library-error.html` (currently Standards@ies.org, the only address used
   product-wide).

## Testing without Vitrium

The page renders purely from its query string, so every state can be previewed
directly (Vitrium's manual documents the same technique):

```
/library-error.html?username=reader%40firm.com&userid=x&url=https%3A%2F%2Fview.protectedpdf.com%2FForbidden%2F2H4QTw&message=You+have+exceeded+your+device+limit+(vc3).&lang=en
/library-error.html?message=No+permission+(w29)&url=https%3A%2F%2Fview.protectedpdf.com%2FForbidden%2F<real code>
/library-error.html?message=Access+expired+(qe2).
/library-error.html?message=This+content+has+been+deactivated+in+the+system+(2p3).
```

Use a real short code from `standards.vitrium_web_url` to see the document
banner and the "Buy this document" button. Unit coverage:
`src/lib/vitrium-support.test.js`, `src/workers/library-support.test.js`,
`src/frontend/library-error.test.js`, plus the email builder cases in
`src/lib/email.test.js`.

## Known limits / open items

- **`buy_url` coverage decides how often "Buy this document" appears.** Where
  the column is empty the page falls back to the store + subscription links.
  Worth a look at the next `sync-metadata.js` run.
- **Staff inbox and support address unconfirmed** — the two asks sent back to
  the client (see the DM). Also outstanding: whether they want per-code copy
  tweaks; the current copy is our draft matching ies.org tone.
- **`lang` is ignored**: IES publishes in English; Vitrium only offers
  en/fr/zh anyway.
- The approval itself lives in Vitrium ("Clear Use"); our queue records who
  asked and what happened. If volume justifies it later, a dashboard page over
  the CSV endpoint is the natural next step.
