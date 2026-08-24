#!/usr/bin/env node
/**
 * Vitrium Metadata Sync Script
 * Populates Vitrium doc IDs and web viewer URLs in the D1 database so search
 * results can render "View in Vitrium" links.
 *
 * Three modes:
 *
 *  1. CSV mode (primary) — parses Vitrium's "Web Viewer URLs" document export:
 *       node scripts/sync-metadata.js --csv scripts/data/vitrium-webviewer-urls.csv
 *
 *     Expected columns: "Folder Path", "Title", "Doc ID", "Web Viewer URL".
 *     Standard IDs are extracted from titles ("RP-8-25 + E2" → RP-8-25+E2,
 *     "TM-25-20R25" → TM-25-20). When the same standard appears both in a
 *     current folder and the deprecated archive, the current entry wins.
 *
 *  2. File mode — reads a local JSON mapping:
 *       node scripts/sync-metadata.js --file vitrium-mapping.json
 *
 *     Format: { "RP-9-23": "doc-guid", ... } or an array of
 *     { standardId, docId, webUrl } objects.
 *
 *  3. API mode — fetches document metadata from the Vitrium API:
 *       VITRIUM_API_KEY=xxx node scripts/sync-metadata.js
 *
 * Flags: --dry-run (preview, no writes), --local (write to local D1 + KV),
 *        --portal <PortalDocuments.json> (see below).
 *
 * ── --portal: cover images, descriptions and committees ──────────────────────
 * Vitrium's export carries none of those. The Lighting Library portal's own
 * document list does, so it is joined onto the CSV by Doc Code (274/274 rows
 * match) and fills:
 *
 *   LatestVersionId → the cover URL   https://lighting.ies.org/api/portal/ies/
 *                                     Thumbnail?externalKey=<LatestVersionId>
 *   Description     → standards.description
 *   Authors         → standards.author (the authoring committee)
 *
 * NOTE the trap: the portal's `externalKey` is the LatestVersionId, NOT the
 * "External Key" column in Vitrium's export. Those are different identifiers
 * that share a name — every Vitrium External Key answers 404 on the thumbnail
 * endpoint (verified 2026-08-24 across the whole export).
 *
 * After a live sync the script bumps the search-cache data version (KV) so
 * cached responses with stale/missing Vitrium links are invalidated.
 *
 * Phase 3: Will also sync Wicket member data.
 */

import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const VITRIUM_API_URL = process.env.VITRIUM_API_URL || 'https://api.vitrium.com';
const VITRIUM_API_KEY = process.env.VITRIUM_API_KEY;
const DRY_RUN = process.argv.includes('--dry-run');
const IS_LOCAL = process.argv.includes('--local');
const D1_TARGET = IS_LOCAL ? '--local' : '--remote';

const CSV_FILE = argValue('--csv');
const MAPPING_FILE = argValue('--file');
// The Lighting Library portal's own document list (its PortalDocuments JSON).
// Enriches the CSV export with the three things Vitrium's export does not
// carry: the cover image, the content description and the authoring committee.
const PORTAL_FILE = argValue('--portal');

function argValue(flag) {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return null;
  const val = process.argv[idx + 1];
  if (!val || val.startsWith('--')) {
    console.error(`Error: ${flag} requires a path argument.`);
    process.exit(1);
  }
  return val;
}

if (!CSV_FILE && !MAPPING_FILE && !VITRIUM_API_KEY) {
  console.error('Error: provide --csv <export.csv>, --file <mapping.json>, or set VITRIUM_API_KEY for API mode.');
  process.exit(1);
}

async function main() {
  console.log(`\nLensy — Vitrium Metadata Sync`);
  console.log(`Source: ${CSV_FILE ? `CSV (${CSV_FILE})` : MAPPING_FILE ? `file (${MAPPING_FILE})` : `API (${VITRIUM_API_URL})`}`);
  console.log(`Mode: ${DRY_RUN ? 'Dry Run (no writes)' : 'Live'} — D1 target: ${D1_TARGET}\n`);

  // The portal's document list, when supplied, fills the cover image,
  // description and committee that Vitrium's export does not carry.
  const portalByCode = PORTAL_FILE ? loadPortalDocuments(PORTAL_FILE) : null;
  if (PORTAL_FILE && !CSV_FILE) {
    console.error('Error: --portal enriches a CSV export; pass --csv as well.');
    process.exit(1);
  }

  // Resolve the list of { standardId, docId, webUrl } entries to write
  const entries = CSV_FILE ? loadCsvExport(CSV_FILE, portalByCode)
    : MAPPING_FILE ? loadMappingFile(MAPPING_FILE)
    : await fetchFromApi();
  console.log(`Resolved ${entries.length} standard → Vitrium mappings.\n`);

  if (entries.length === 0) {
    console.log('Nothing to sync.');
    return;
  }

  // Build one batched SQL file — a single wrangler invocation instead of
  // one process per standard.
  // Every Table of Contents column is written ONLY when this export supplied it
  // (`col` keeps the existing value otherwise), so re-syncing a stock Vitrium
  // export can never blank out metadata a richer export had filled in — and in
  // particular never wipes the hand-curated eLearning list.
  const statements = entries.map((e) => {
    const { standardId, docId, webUrl } = e;
    const col = (name, value) => `${name} = ${value != null ? `'${sqlEsc(value)}'` : name}`;
    // Fill-only-if-empty. The authoring committee is read off each PDF's cover
    // during ingest ("Prepared by the … Committee", client DO29/DO46) for 110 of
    // 113 standards, and that is a transcription of the document itself. The
    // portal's Authors field is good metadata but it is not better than the
    // cover, so it FILLS the gaps and never overwrites what ingest established.
    const fillCol = (name, value) =>
      `${name} = ${value != null ? `COALESCE(${name}, '${sqlEsc(value)}')` : name}`;
    return `
UPDATE standards
SET vitrium_doc_id = '${sqlEsc(docId)}',
    ${col('vitrium_web_url', webUrl)},
    ${col('collection', e.collection)},
    ${fillCol('author', e.author)},
    ${col('description', e.description)},
    ${col('thumbnail_url', e.thumbnailUrl)},
    ${col('buy_url', e.buyUrl)},
    ${col('elearning_json', e.elearning ? JSON.stringify(e.elearning) : null)},
    updated_at = CURRENT_TIMESTAMP
WHERE id = '${sqlEsc(standardId)}';

UPDATE applications
SET Vitrium_Doc_ID = '${sqlEsc(docId)}'
WHERE Standard = '${sqlEsc(standardId)}';
`;
  }).join('\n');

  if (DRY_RUN) {
    for (const e of entries) {
      const extras = [
        e.collection && `collection="${e.collection}"`,
        e.author && `author="${e.author}"`,
        e.description && 'description',
        e.thumbnailUrl && 'thumbnail',
        e.buyUrl && 'buy',
        e.elearning && `${e.elearning.length} eLearning link(s)`,
      ].filter(Boolean);
      console.log(`  [DRY RUN] ${e.standardId} → ${e.docId}${e.webUrl ? `  (${e.webUrl})` : ''}` +
        (extras.length ? `\n              + ${extras.join(', ')}` : ''));
    }
    console.log(`\nDone (dry run, ${entries.length} entries, no writes).\n`);
    return;
  }

  const tmpFile = path.join(os.tmpdir(), `lucius_vitrium_sync_${process.pid}.sql`);
  fs.writeFileSync(tmpFile, statements);
  try {
    execSync(`wrangler d1 execute ies-metadata ${D1_TARGET} --file="${tmpFile}"`, { stdio: 'inherit' });
    console.log(`\n✓ Synced ${entries.length} standards.`);
  } finally {
    fs.unlinkSync(tmpFile);
  }

  // Direct D1 writes bypass the ingest endpoints, so bump the search-cache
  // data version ourselves — otherwise cached searches keep serving results
  // without Vitrium links until their TTL expires.
  try {
    execSync(
      `wrangler kv key put cache:data-version ${Date.now()} --binding SESSIONS ${IS_LOCAL ? '--local' : '--remote'}`,
      { stdio: 'pipe' }
    );
    console.log('✓ Search cache invalidated (data version bumped).\n');
  } catch (err) {
    console.warn(`⚠ Could not bump cache data version (${err.message.slice(0, 80)}).`);
    console.warn('  Run manually: wrangler kv key put cache:data-version <timestamp> --binding SESSIONS --remote\n');
  }
}

// ─── CSV mode (Vitrium "Web Viewer URLs" export) ──────────────────────────────

/**
 * The Lighting Library's public cover-image endpoint, for one document's PORTAL
 * key. Verified 2026-08-24: 200 image/png, no credential required.
 *
 *   https://lighting.ies.org/api/portal/ies/Thumbnail?externalKey=<portal guid>
 *
 * The key belongs to the portal, not to Vitrium — see loadCsvExport(). Returns
 * null for a missing key, so a row without one leaves thumbnail_url untouched
 * rather than storing a URL that will 404.
 */
function thumbnailUrlFor(portalKey) {
  const key = String(portalKey || '').trim();
  if (!key) return null;
  return `https://lighting.ies.org/api/portal/ies/Thumbnail?externalKey=${encodeURIComponent(key)}`;
}

/**
 * The portal's document list, indexed by Doc Code — the one field it shares
 * with Vitrium's export, and which matched every row when this was written.
 *
 * Returns a Map: docCode → { thumbnailUrl, description, author }.
 */
function loadPortalDocuments(filePath) {
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const docs = Array.isArray(raw) ? raw : (raw.PortalDocuments || raw.documents || []);
  if (!Array.isArray(docs) || docs.length === 0) {
    console.error(`Error: ${filePath} holds no PortalDocuments array.`);
    process.exit(1);
  }

  const byCode = new Map();
  let covers = 0, descriptions = 0, authors = 0;
  for (const d of docs) {
    const code = String(d.DocCode || '').trim();
    if (!code) continue;
    // The cover key is the LATEST VERSION id: a reaffirmed printing gets a new
    // version and a new cover, and the version id is what the portal itself
    // asks the thumbnail endpoint for.
    const thumbnailUrl = thumbnailUrlFor(d.LatestVersionId);
    const description = String(d.Description || '').trim() || null;
    const author = String(d.Authors || '').trim() || null;
    if (thumbnailUrl) covers++;
    if (description) descriptions++;
    if (author) authors++;
    byCode.set(code, { thumbnailUrl, description, author });
  }

  console.log(`  Portal documents: ${byCode.size} — ${covers} cover image(s), `
    + `${descriptions} description(s), ${authors} committee credit(s).`);
  return byCode;
}

function loadCsvExport(filePath, portalByCode = null) {
  const rows = parseCsv(fs.readFileSync(filePath, 'utf8'));
  if (rows.length < 2) return [];

  const header = rows[0].map(h => h.trim().toLowerCase());
  const col = (name) => header.indexOf(name);
  const iFolder = col('folder path');
  const iTitle = col('title');
  const iDocId = col('doc id');
  // The join key to the portal's document list (--portal).
  const iDocCode = col('doc code');
  const iUrl = col('web viewer url');
  if (iTitle === -1 || iDocId === -1 || iUrl === -1) {
    console.error('Error: CSV must have "Title", "Doc ID" and "Web Viewer URL" columns.');
    process.exit(1);
  }

  // ── Table of Contents metadata (client DO35) ────────────────────────────────
  // The ToC page groups by Collection, shows a cover thumbnail, a description and
  // the authoring committee, and offers Read / Buy. All of it is optional: these
  // columns do not exist in the stock Vitrium "Web Viewer URLs" export yet, so a
  // CSV without them syncs exactly as before and the ToC simply shows less.
  // Several header spellings are accepted because the export is produced by hand.
  const firstCol = (...names) => {
    for (const n of names) {
      const i = col(n);
      if (i !== -1) return i;
    }
    return -1;
  };
  const iCollection  = firstCol('collection', 'collections', 'part');
  const iAuthor      = firstCol('author', 'committee', 'authoring committee');
  const iDescription = firstCol('description', 'abstract', 'summary');
  const iThumbnail   = firstCol('thumbnail', 'thumbnail url', 'cover', 'cover url');
  const iBuy         = firstCol('buy url', 'buy', 'store url', 'webstore url', 'product url');
  const iElearning   = firstCol('elearning', 'e-learning', 'elearning products');
  // ── Cover images (measured 2026-08-24) ─────────────────────────────────────
  // The Lighting Library portal serves covers publicly — 200 image/png, no
  // credential, so a URL can go straight into an <img> with no proxy:
  //
  //   https://lighting.ies.org/api/portal/ies/Thumbnail?externalKey=<guid>
  //
  // CRITICAL: that `externalKey` is the PORTAL's identifier and is NOT Vitrium's
  // "External Key" column, however much the names invite the assumption. Tested
  // against the 2026-08-24 export, in which 108 of 113 current standards carry a
  // Vitrium External Key: every one of those keys answers 404, while a known
  // portal key still answers 200. Vitrium's Doc ID, Folder ID, Doc Code and the
  // viewer short code all 404 as well, and the endpoint ignores every parameter
  // name except `externalKey`.
  //
  // So the mapping has to come from the portal itself, and this script accepts
  // it as either a ready-made URL or a portal key — never from Vitrium's column,
  // which would fill the library with 108 dead image links.
  const iPortalKey = firstCol('portal key', 'portalkey', 'thumbnail key', 'cover key');
  // Read only to WARN about the trap above, never to build a URL.
  const iVitriumExternalKey = firstCol('external key', 'externalkey', 'external id');

  const tocCols = [
    iCollection !== -1 && 'Collection', iAuthor !== -1 && 'Author',
    iDescription !== -1 && 'Description', iThumbnail !== -1 && 'Thumbnail',
    iPortalKey !== -1 && 'Portal Key (→ cover image)',
    iBuy !== -1 && 'Buy URL', iElearning !== -1 && 'eLearning',
  ].filter(Boolean);

  // Covers come from a Thumbnail URL column or a Portal Key column. If neither
  // is here, say what is actually needed — and say it precisely, because a
  // populated Vitrium "External Key" column looks like the answer and is not.
  if (iThumbnail === -1 && iPortalKey === -1 && !portalByCode) {
    const vitriumKeys = iVitriumExternalKey !== -1
      ? rows.slice(1).filter(r => (r[iVitriumExternalKey] || '').trim()).length
      : 0;
    console.log('  No cover images in this export: it carries neither a "Thumbnail" URL column '
      + 'nor a "Portal Key" column.');
    if (vitriumKeys > 0) {
      console.log(`  NOTE: the Vitrium "External Key" column IS populated (${vitriumKeys} rows), but it is a `
        + 'DIFFERENT identifier from the portal\'s externalKey and answers 404 on the thumbnail '
        + 'endpoint. Verified 2026-08-24 — do not build cover URLs from it.');
    }
  }
  console.log(tocCols.length > 0
    ? `  Table of Contents columns found: ${tocCols.join(', ')}`
    : '  No Table of Contents columns in this export (Collection, Author, Description, Thumbnail, Buy URL, eLearning) — those fields stay as they are.');

  // standardId → { entry, deprecated }
  const byStandard = new Map();
  let skipped = 0;

  for (const row of rows.slice(1)) {
    const title = row[iTitle];
    const docId = row[iDocId];
    const webUrl = row[iUrl];
    if (!title || !docId) continue;

    const standardId = extractStandardIdFromTitle(title);
    if (!standardId) {
      console.log(`  SKIP: cannot map title "${title}" to a standard ID`);
      skipped++;
      continue;
    }

    const deprecated = iFolder !== -1 && /z_deprecated/i.test(row[iFolder] || '');
    const existing = byStandard.get(standardId);

    const cell = (i) => (i !== -1 && row[i] ? String(row[i]).trim() || null : null);
    // What the portal knows about this document, joined by Doc Code. A column
    // in the CSV still wins — it is hand-curated — but the CSV carries none of
    // these three today, so in practice the portal supplies them.
    const portal = (portalByCode && iDocCode !== -1)
      ? (portalByCode.get(String(row[iDocCode] || '').trim()) || null)
      : null;
    const entry = {
      standardId, docId, webUrl,
      collection: cell(iCollection),
      author: cell(iAuthor) || (portal ? portal.author : null),
      description: cell(iDescription) || (portal ? portal.description : null),
      // An explicit Thumbnail/Cover URL wins; otherwise the portal URL is built
      // from a PORTAL key. Never from Vitrium's "External Key" — see the note
      // above the column lookups. Both columns may be absent, in which case the
      // field stays null and the stored cover is left untouched.
      thumbnailUrl: cell(iThumbnail) || thumbnailUrlFor(cell(iPortalKey))
        || (portal ? portal.thumbnailUrl : null),
      buyUrl: cell(iBuy),
      // Accepts "Title|URL" pairs separated by ; or a newline, which is what a
      // spreadsheet cell can realistically hold:
      //   "IES Learning: TM-30 for Fine Art|https://…; Using the IES Spectral…|https://…"
      elearning: parseElearningCell(cell(iElearning)),
    };

    if (!existing) {
      byStandard.set(standardId, { entry, deprecated });
    } else if (existing.deprecated && !deprecated) {
      // Current edition beats the archived copy of the same designation
      byStandard.set(standardId, { entry, deprecated });
    } else if (existing.deprecated === deprecated) {
      console.log(`  DUP: ${standardId} appears twice (${deprecated ? 'deprecated' : 'current'}); keeping first ("${title}" ignored)`);
    }
  }

  if (skipped > 0) console.log(`  (${skipped} rows skipped)\n`);
  return [...byStandard.values()].map(v => v.entry);
}

/**
 * Parse the eLearning cell into [{ title, url }] (client DO35).
 *
 * "Staff manually selects educational recording products to pair with standards",
 * so this is a hand-typed cell rather than an API feed. Entries are separated by
 * a semicolon or a newline, and each is "Title|URL" — or a bare URL, which is
 * kept with the URL as its own label rather than dropped.
 *
 * @returns {Array<{title: string, url: string}>|null} null when the cell is empty,
 *   so a sync of a CSV WITHOUT the column leaves the stored list untouched.
 */
function parseElearningCell(raw) {
  if (!raw) return null;
  const out = [];
  for (const part of String(raw).split(/[;\n]+/)) {
    const piece = part.trim();
    if (!piece) continue;
    const [a, b] = piece.split('|').map(s => (s || '').trim());
    const url = /^https?:\/\//i.test(b || '') ? b : (/^https?:\/\//i.test(a) ? a : null);
    if (!url) continue; // a label with no link is not actionable
    out.push({ title: (b && url === b ? a : null) || url, url });
  }
  return out.length > 0 ? out : null;
}

/**
 * Extract a standard designation from a Vitrium document title.
 *
 *   "RP-8-25 + E2"                          → RP-8-25+E2
 *   "RP-10-20+E2 Prototype_260420-NEW_TABLE" → RP-10-20+E2
 *   "TM-25-20R25"                           → TM-25-20
 *   "LS-4-20 (R2023) +E1_"                  → LS-4-20   (errata after (R...) not part of D1 IDs)
 *   "RP-27.1-22"                            → RP-27.1-22
 */
function extractStandardIdFromTitle(title) {
  const m = String(title).match(/([A-Z]{1,4}-\d+(?:\.\d+)?-\d{2})(\s*\+\s*E\d+)?/i);
  if (!m) return null;
  let id = m[1].toUpperCase();
  if (m[2]) id += `+${m[2].replace(/[\s+]/g, '').toUpperCase()}`;
  return id;
}

/** Minimal CSV parser handling quoted fields with embedded commas/quotes. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else {
      field += c;
    }
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

// ─── File mode ────────────────────────────────────────────────────────────────

function loadMappingFile(filePath) {
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));

  const rows = Array.isArray(raw)
    ? raw.map(r => ({
        standardId: r.standardId || r.standard,
        docId: r.docId || r.vitriumDocId,
        webUrl: r.webUrl || r.deepLink || null,
      }))
    : Object.entries(raw)
        .filter(([key]) => !key.startsWith('_'))
        .map(([standardId, docId]) => ({ standardId, docId, webUrl: null }));

  const valid = [];
  for (const row of rows) {
    if (!row.standardId || !row.docId) {
      console.log(`  SKIP: incomplete entry ${JSON.stringify(row)}`);
      continue;
    }
    valid.push({ ...row, standardId: normalizeStandardId(row.standardId) });
  }
  return valid;
}

// ─── API mode ─────────────────────────────────────────────────────────────────

async function fetchFromApi() {
  const documents = await fetchVitriumDocuments();
  console.log(`Found ${documents.length} documents in Vitrium.`);

  const entries = [];
  for (const doc of documents) {
    const standardId = extractStandardIdFromTitle(doc.title || doc.name || '');
    if (!standardId) {
      console.log(`  SKIP: Cannot map "${doc.title || doc.name}" to a standard ID`);
      continue;
    }
    entries.push({ standardId, docId: doc.id, webUrl: doc.webViewerUrl || null });
  }
  return entries;
}

async function fetchVitriumDocuments() {
  // Vitrium API: GET /api/v2/documents
  const response = await fetch(`${VITRIUM_API_URL}/api/v2/documents`, {
    headers: {
      'Authorization': `Bearer ${VITRIUM_API_KEY}`,
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Vitrium API error: ${response.status} ${body.slice(0, 100)}`);
  }

  const data = await response.json();
  return data.documents || data.items || data || [];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function normalizeStandardId(id) {
  // "ANSI/IES RP-9-23" → "RP-9-23"; preserve +E suffixes; leave bare IDs untouched
  const m = String(id).match(/([A-Z]+-\d+(?:\.\d+)?(?:-\d+)?(?:\+E\d+)?)\s*$/i);
  return m ? m[1].toUpperCase() : String(id).trim();
}

function sqlEsc(str) {
  return String(str || '').replace(/'/g, "''");
}

main().catch(err => {
  console.error('\n✗ Fatal error:', err.message);
  process.exit(1);
});
