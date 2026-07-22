# Brand fonts (self-hosted)

The frontend references two brand typefaces via `@font-face` in `index.html`
and `projects.html`, served from this folder at `/fonts/`:

| Family | Role | Expected file | License |
|---|---|---|---|
| **Nohemi** | Display / headings / wordmark | `Nohemi-Variable.woff2` | **Commercial** — Pangram Pangram Foundry. Must be licensed by IES; not redistributable. |
| **Inter** | Body text | `Inter-Variable.woff2` | Free — SIL Open Font License 1.1. Download from rsms.me/inter or the GitHub releases. |

## Status

Until the `.woff2` files are committed here, both faces fall back gracefully to
the system UI stack (declared in the `@font-face` fallback and the Tailwind
`fontFamily` tokens), so the site renders correctly — just not in the final
brand type.

## Adding the files

1. Obtain the licensed **Nohemi** variable `.woff2` from IES brand assets, and
   the free **Inter** variable `.woff2`.
2. Name them exactly `Nohemi-Variable.woff2` and `Inter-Variable.woff2` (or
   update the `@font-face src` URLs in both HTML files to match).
3. Commit them here. The CSP already allows `font-src 'self'`, so no header
   change is needed — they load immediately on next deploy.

If you have static-weight files instead of variable fonts, add one `@font-face`
block per weight (drop the `font-weight` range) and adjust the `src` filenames.
