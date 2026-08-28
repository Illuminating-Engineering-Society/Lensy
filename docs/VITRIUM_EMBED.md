# Embedding Lensy in the Vitrium portal header (client DO076)

> "Vitrium: is it possible to generate an html embed code for Lensy that we can
> place in the Vitrium Portal Header (Portal Settings | Vitrium Security)?
> Clicking 'search' would open lensy.ies.org in a new tab and populate that
> query. **Goal:** more intuitive way to access 'Lensy' search from within the
> Vitrium platform."

Yes. Paste the snippet below into **Portal Settings → Portal Header** in Vitrium
Security. A live preview, and a copy button, are at **<https://lensy.ies.org/embed.html>**.

## The snippet

```html
<!-- Lensy — IES Standards Assistant. Opens lensy.ies.org in a new tab. -->
<form action="https://lensy.ies.org/" method="get" target="_blank" rel="noopener"
      style="display:flex;gap:8px;align-items:center;max-width:520px;margin:0 auto;font-family:inherit;">
  <input type="text" name="q" placeholder="Type a topic or ask a question"
         aria-label="Search the IES Lighting Library with Lensy"
         style="flex:1 1 auto;min-width:0;padding:10px 14px;border:1px solid #D1D5DB;border-radius:10px;font-size:14px;color:#2C2C2C;background:#fff;">
  <button type="submit"
          style="flex:none;display:inline-flex;align-items:center;gap:6px;padding:10px 18px;border:0;border-radius:10px;background:#D8930F;color:#fff;font-size:14px;font-weight:700;cursor:pointer;">
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true">
      <path stroke-linecap="round" stroke-linejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/>
    </svg>
    Search
  </button>
</form>
```

## How it works

The form is a plain `GET` to `https://lensy.ies.org/`, so submitting it opens

```
https://lensy.ies.org/?q=how+bright+should+a+skating+rink+be
```

in a new tab. Lensy already reads `?q=` on load and runs that search — the same
deep link the **List Standards** page uses for its "Search in Lensy" buttons
(`runQueryFromUrl` in `src/frontend/index.html`). Nothing new was needed on the
Lensy side.

## Why it is built this way

**No JavaScript.** Enter and the button both submit natively, so the widget keeps
working in a header field that strips `<script>` tags or `on*` attributes — which
portal CMSes commonly do. Styles are inline for the same reason.

**No iframe.** Lensy serves `Content-Security-Policy: frame-ancestors 'none'`
(`src/frontend/_headers`), so the search UI cannot be embedded inside the portal
page, by design — it is what stops the app being wrapped by a third party. A
link-out is therefore the whole feature, not a compromise: the reader stays
signed in to one Lensy session in one tab.

**Sign-in survives the hand-off.** If the reader has no Lensy session yet, the
gate sends them to `auth.ies.org` and returns them to
`location.pathname + location.search` (`src/frontend/utils/auth-gate.js`) — so the
`?q=` query is still there afterwards and they land on their results rather than
on an empty search box.

## Variations

| Want | Change |
|---|---|
| Point at staging | `action="https://lensy-staging.ies.org/"` |
| Open in the same tab | remove `target="_blank" rel="noopener"` |
| A specific starting search | add `<input type="hidden" name="q" value="...">` and drop the text input |
| Match a different header height | the two `padding` values in the inline styles |

## What it does NOT do

- It does not pass the reader's Vitrium session or identity to Lensy. Lensy
  authenticates independently against `auth.ies.org`; the widget only carries the
  query text.
- It does not pre-filter the search. The URL carries `q` only; content types, the
  AI Guide toggle and the sort all start at Lensy's own defaults.
