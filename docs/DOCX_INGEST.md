# Dual-upload ingest: Word manuscript + published PDF

**Status: Phase A BUILT, 2026-09-11** (client direction, same day: "The Word
doc should be responsible for feeding and training the AI system on the
content. The PDF should be responsible for directing the page in which the
content exists in that standard (for the Vitrium pass-over).")

As built: `src/lib/docx-extract.js` (ZIP + XML + OMML, Worker-side),
`src/lib/page-align.js` (the alignment step below), the `docx`/`align` steps
in `src/workers/staff-ingest.ts` (POST/DELETE `/api/admin/ingest-jobs/:id/docx`,
the drift gates, the PDF-only downgrade), migration **0018** (`docx_key`,
`docx_size`, `alignment_json` on `ingest_jobs`), and the dashboard's optional
manuscript input + tracker/result lines. Tests: `docx-extract.test.js`,
`page-align.test.js`, and the dual-upload cases in `staff-ingest.test.js`.
**Still open:** validation against real IES manuscripts (open question 1 —
nothing real has flowed through yet), and Phase B (applications from Word
tables) is not started. To take effect in production: migration 0018 + deploy.

One terminology correction that matters for the design: nothing is *trained*.
The Word doc would feed **extraction and embedding** — the text that becomes
chunks, vectors, outline entries and excerpt cards. The benefit the client is
after (cleaner content, nothing lost) is exactly what that buys; the mechanism
is indexing, not training.

---

## Why a DOCX source pays

Every one of these shipped fixes exists to fight PDF *layout*. A DOCX is
structured XML and simply does not have the failure:

| PDF failure we engineered around | Where | DOCX equivalent |
|---|---|---|
| Subsetted fonts eat periods → "13 4" headings, chunks stamped with the previous section (DO071) | `section-titles.js` heuristics | Headings are `Heading N` **styles**; number + title + level are explicit |
| Formulas arrive as underscore runs + scrambled fractions, so we detect-and-suppress (DO072) | `formula.js`, `guardFormula` | Math is **OMML** — detectable with certainty, and convertible to readable linear text instead of omitted |
| Sub/superscripts flatten (R_f → "Rf"), restored at render from a fixed vocabulary (DO070) | `sciNotate` in index.html | `w:vertAlign` marks every sub/superscript at source — no vocabulary needed |
| Cover glyphs land on C0 control codes, decoded per-document (DO48) | `cover-title.js` | Document title/designation from real text and `docProps/core.xml` |
| Two-column pages split captions mid-word; the join refuses ~2 in 3 figure captions (DO086 limit 3) | `document-assets.js` | A caption is one paragraph; columns are a section property, not interleaved text |
| **Raster tables yield NO text at all** — RP-1-24's Table 2-1 and 4-1 are invisible to retrieval (DO086 limit 2) | multimodal boundary | A Word table is `w:tbl` — every cell is text, always |
| RP-43 column-note headers reconstructed from spacing ("a comma binds within a column") (DO092) | `applications-extractor.js` | Table cells carry their own note markers; no positional inference |
| Running headers/footers stripped by Y-position sampling | `detectHeadersFootersFromRaw` | Headers/footers live in separate `header*.xml` parts — never in the body stream |
| Reference entries bleed the citing document's running title (DO110) | `cleanReferenceEntryText` | Same — body text is only body text |
| Excerpt truncation orphaned a surrogate pair and Vectorize rejected the whole batch (TM-31) | `excerptText()` | Still applies (any text source), but astral math glyphs mostly disappear with OMML handling |

The chunker also gets *better boundaries*: paragraphs and list items are
explicit, so chunks never split mid-sentence because a page broke, and
References sections are identifiable by style + numbering rather than by
`REFERENCES_HEADING_RE`.

## The one hard problem: a DOCX has no pages

Pagination is a **rendering artifact** — a .docx file contains no page
numbers, and reflowing it (different fonts, printer metrics) produces
different ones. Meanwhile every citation surface in Lensy is keyed on the
published PDF's page index: `#page=N` Library deep links, excerpt citations,
outline pages, asset chips, `assets_json`, `outline_json`. The client's own
framing acknowledges this: the PDF's job is "directing the page."

So the design's centerpiece is an **alignment step**: stamp each DOCX-derived
chunk with the PDF page where its text begins.

### `alignChunksToPdfPages(docxChunks, pdfPages)`

Tractable because both files are the same document:

1. Build one normalized character stream from the PDF pages we already
   extract (headers/footers already stripped), keeping a page-offset table.
   Normalization on BOTH sides: lowercase, collapse to alphanumeric runs
   (the DO110 trick — it erases hyphenation-at-line-break, ligatures,
   subsetted-font punctuation, and whitespace differences in one move).
2. For each chunk **in document order**, take its opening 72 normalized
   characters (~12 words) and search forward from just past the previous
   chunk's match position (monotonic constraint → near-linear, and immune to
   a phrase that repeats later in the document; "just past" so a continuation
   chunk's overlap carry still matches inside its predecessor).
3. Exact miss → shorter anchors (40, then 24 characters), then one
   full-strength search from the top for out-of-order content ('relocated').
4. Still missing → inherit the nearest located neighbor's page, marked
   `pageConfidence: 'inherited'` and counted — the body-inherited fraction is
   the drift gate.

### The alignment report IS the "not losing content" guarantee

The client's motivation — "ensure we're not losing content" — falls out of
step 4 for free, in both directions:

- **DOCX text with no PDF match** = manuscript drift (a pre-copyedit Word
  file, an errata applied only to the PDF). The full report lives on the job
  row (`alignment_json`), and above the threshold (>5 % of PROSE chunks
  unaligned — `DOCX_BODY_DRIFT_LIMIT`; tables are excluded, since a DOCX
  table serializes cells in an order the PDF's layout stream need not share)
  the manuscript is **discarded** and the run downgrades to the PDF-only path
  with a warning, rather than silently indexing draft text under a published
  standard's name. The ingest itself never fails over the manuscript.
- **PDF pages no chunk landed on** = content present in the published
  document that the DOCX never mentioned (an annex added at layout, a
  scanned insert). Reported as `uncoveredPages` (front matter before the
  first match excluded) so staff can check.

## Where it slots in the staff-ingest pipeline

The seam is clean because `runDocumentIngest` already takes
`chunks: [{text, pageNumber, section, type}]` and does not care where they
came from.

```
create job ──► PDF → R2 ingest-jobs/<id>/source.pdf      (unchanged, REQUIRED)
           └─► DOCX → R2 ingest-jobs/<id>/source.docx    (new, OPTIONAL)
raw pages ──► browser pdfjs → /pages batches             (unchanged — pages
                                                          are still needed for
                                                          alignment + fallback)
/process ──► extract:
               with DOCX:  parseDocx() → chunks/outline/assets from STRUCTURE
                           alignChunksToPdfPages(chunks, pages)
                           PDF still supplies: page_count, cover fallback,
                           applications extraction (phase 2, below)
               without:    today's path, byte for byte
           ──► runDocumentIngest(...)                    (unchanged)
```

- **DOCX parsing runs in the Worker, not the browser.** Unlike PDF (pdfjs
  needs a DOM-ish environment), a .docx is ZIP + XML — as built: a minimal
  ZIP reader over the platform `DecompressionStream('deflate-raw')` (no
  library at all) plus a non-validating XML walk over `word/document.xml`
  and `styles.xml`. Auto-numbered headings are approximated with multilevel
  counters ONLY when `w:numPr` is present (a heading Word does not number
  gets no invented locator — the DO071 rule); `footnotes.xml` is deliberately
  not walked (footnote text is outside the body flow and could not be
  page-aligned honestly). No vendored library, no CSP concern, and the
  existing `[limits] cpu_ms = 300000` covers it.
- **New module `src/lib/docx-extract.js`** produces the same downstream
  shapes (`chunks` sans pageNumber, `outline`, `assets`, section map), plus
  `src/lib/page-align.js` for the alignment. `chunker.js`,
  `section-titles.js` etc. stay untouched — they remain the PDF-only path.
- **Job schema:** `docx_key` column (nullable) on `ingest_jobs`, an
  `alignment_json` report on the row, and the dashboard's tracker gains an
  "align" step between extract and index.

## Phasing

**Phase A — prose (chunks, outline, sections, assets).** The 80 % win at
maybe 20 % of the effort: body/reference/definition-adjacent text, exact
section numbers and titles, whole captions, findable formulas. Applications
(illuminance tables → D1 rows) still come from the PDF extractor.

**Phase B — applications from Word tables.** `w:tbl` → application rows
would retire the positional table heuristics entirely and make the raster-
table blindspot moot, but it is a new extractor with its own validation
against the 2,498-row corpus. Do it only after Phase A has run on real
manuscripts and we know what IES's Word tables actually look like.

## Rules

1. **PDF required, DOCX optional — per document.** "Require two uploads"
   cannot hold across the corpus: deprecated editions and most of the 113
   already-published standards have no retrievable final manuscript. The
   dashboard should *encourage* the DOCX on new editions (a visible
   "manuscript attached — high-fidelity extraction" state), never block an
   ingest on it.
2. **Reject tracked changes.** A DOCX containing unaccepted revisions
   (`w:ins`/`w:del`) is refused at upload with a message to accept-all and
   re-save. Silently taking either side of a revision is indexing text
   nobody approved.
3. **The PDF remains the citation authority.** Excerpt text may come from
   the DOCX (cleaner), but every page number, deep link and page_count comes
   from the PDF via alignment — a DOCX-sourced page number does not exist.
4. **Fail toward today's pipeline.** Any DOCX parse or alignment failure
   downgrades the job to PDF-only extraction with a warning, never to a
   failed ingest — the PDF path is the proven one.
5. **Same-document check.** Before aligning, compare designation/title read
   from both files; a mismatch (staff attached the wrong manuscript) fails
   the job at creation, like the existing family-mismatch warning.

## Open questions for IES (blockers before building)

1. **Do final Word manuscripts exist?** Standards production often finishes
   in InDesign; the Word file may be the pre-layout draft. Ask for 2–3 real
   (standard PDF + its Word file) pairs — RP-27-26 would be ideal since its
   PDF is pending anyway — and measure alignment rate before committing.
   If drift is routinely high, the feature's value inverts.
2. **Are illuminance tables real Word tables** in the manuscripts, or
   pasted images/Excel embeds? Decides whether Phase B is possible.
3. Who owns keeping DOCX and PDF in sync when an errata (+E1) reprints?
