#!/usr/bin/env node
/**
 * Verify that a re-ingest actually applied the ingest-side fixes.
 *
 * Deploying the Worker is not enough for four of the 260729 feedback items: they
 * change what gets WRITTEN, so they only take effect for standards re-ingested
 * afterwards. An ingest run against an older deployment, or one that predates a
 * script change, completes with no error and leaves the old data in place — the
 * UI then still shows the old behaviour and it looks like the fix did not work.
 *
 * Each check below is a binary, falsifiable signal that the data in production
 * came from the current pipeline:
 *
 *   DO20  Lighting Zone     applications.Lighting_Zone is populated for RP-2
 *   DO23  Chunk sizing      standards.chunk_count reflects 200-word chunks
 *   DO30  Footnotes         RP-11-26's "Desk" row carries note 18's TEXT
 *   DO31  Reference markers standards.reference_markers_json is populated
 *   DO33  Definitions       the definitions table is populated
 *   DO40  Section titles    standards.sections_json is populated
 *
 * Usage:
 *   LUCIUS_API_URL=https://lensy.ies.org LUCIUS_API_SECRET=… node scripts/verify-ingest.js
 *
 * Read-only: it issues GETs and never writes.
 */

const CONFIG = {
  apiUrl: process.argv.includes('--local')
    ? 'http://localhost:8787'
    : (process.env.LUCIUS_API_URL || 'http://localhost:8787'),
  apiSecret: process.env.LUCIUS_API_SECRET || null,
};

// Standards used as probes, chosen because each was measured directly against
// its PDF while the fix was written.
const PROBES = {
  zones: { id: 'RP-2-20+E1', minZoneShare: 0.3 },
  // LP-3-20+E1 parses to 484 chunks at the old 350-word sizing and 586 at the
  // new 200-word sizing, so anything near the old figure means stale chunks.
  chunking: { id: 'LP-3-20+E1', oldCount: 484, newCount: 586 },
  footnotes: { id: 'RP-11-26', app: 'Desk', notePrefix: '18.' },
};

async function get(path) {
  const res = await fetch(`${CONFIG.apiUrl}${path}`, {
    headers: CONFIG.apiSecret ? { Authorization: `Bearer ${CONFIG.apiSecret}` } : {},
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 200) }; }
  if (!res.ok) {
    const err = new Error(`${path} → HTTP ${res.status}: ${json.error || text.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  return json;
}

const results = [];
function record(id, label, ok, detail) {
  results.push({ id, label, ok, detail });
  const mark = ok === true ? '✓' : ok === false ? '✗' : '?';
  console.log(`  ${mark} ${id.padEnd(6)} ${label.padEnd(22)} ${detail}`);
}

async function main() {
  console.log(`\nVerifying the ingested corpus at ${CONFIG.apiUrl}\n`);

  let standards;
  try {
    standards = (await get('/api/standards?status=all')).standards || [];
  } catch (err) {
    if (err.status === 401 || err.status === 403) {
      console.error(`\n✗ ${CONFIG.apiUrl} rejected the credential.` +
        '\n  LUCIUS_API_SECRET must match the value set with `wrangler secret put LUCIUS_API_SECRET`.\n');
    } else {
      console.error(`\n✗ ${err.message}\n`);
    }
    process.exit(1);
  }
  console.log(`  ${standards.length} standard(s) indexed\n`);

  // ── DO31: in-body reference markers ────────────────────────────────────────
  // The single clearest "was this ingested by the current pipeline?" signal:
  // the column only gets written by the new script talking to the new Worker.
  const sample = standards.slice(0, 12);
  if (sample.length === 0) {
    // Nothing to sample is not a failing check — it is an unanswerable one.
    record('DO31', 'reference markers', null, 'no standards indexed — cannot check');
  } else {
    let withMarkers = 0;
    for (const s of sample) {
      try {
        const row = (await get(`/api/standards/${encodeURIComponent(s.id)}`)).standard || {};
        if (row.reference_markers_json) withMarkers++;
      } catch { /* keep going — one unreadable row is not the answer */ }
    }
    record('DO31', 'reference markers',
      withMarkers > 0,
      `${withMarkers}/${sample.length} sampled standards carry reference_markers_json` +
        (withMarkers === 0 ? '  → this corpus predates the marker capture; re-run npm run ingest' : ''));
  }

  // ── DO23: chunk sizing ─────────────────────────────────────────────────────
  const probe = standards.find(s => s.id === PROBES.chunking.id);
  if (!probe) {
    record('DO23', 'chunk sizing', null, `${PROBES.chunking.id} is not indexed — cannot check`);
  } else {
    try {
      // The list response already carries page_count but not chunk_count, so the
      // per-id lookup is needed. Its id may contain '+' (errata suffix).
      const row = (await get(`/api/standards/${encodeURIComponent(probe.id)}`)).standard || {};
      const n = row.chunk_count;
      const { oldCount, newCount } = PROBES.chunking;
      // Halfway between the two measured figures is the decision boundary.
      const ok = n != null && n > (oldCount + newCount) / 2;
      record('DO23', 'chunk sizing', n == null ? null : ok,
        n == null ? 'chunk_count not recorded'
          : `${probe.id} has ${n} chunks (old sizing ≈ ${oldCount}, new ≈ ${newCount})` +
            (ok ? '' : '  → still the 350-word chunking; re-run npm run ingest'));
    } catch (err) {
      record('DO23', 'chunk sizing', null, `could not read ${probe.id}: ${err.message}`);
    }
  }

  // ── DO20: lighting zones ───────────────────────────────────────────────────
  try {
    const apps = (await get(`/api/applications?standard=${encodeURIComponent(PROBES.zones.id)}`)).applications || [];
    if (apps.length === 0) {
      record('DO20', 'lighting zones', null, `${PROBES.zones.id} has no application rows — cannot check`);
    } else {
      const zoned = apps.filter(a => a.Lighting_Zone).length;
      const share = zoned / apps.length;
      record('DO20', 'lighting zones', share >= PROBES.zones.minZoneShare,
        `${zoned}/${apps.length} ${PROBES.zones.id} rows carry a Lighting_Zone (API caps at 200)` +
          (share >= PROBES.zones.minZoneShare ? '' : '  → zones were not extracted; re-run npm run ingest'));
    }
  } catch (err) {
    record('DO20', 'lighting zones', null, `could not read applications: ${err.message}`);
  }

  // ── DO30: footnote text, not the placeholder ───────────────────────────────
  try {
    const apps = (await get(`/api/applications?standard=${encodeURIComponent(PROBES.footnotes.id)}`)).applications || [];
    const desk = apps.find(a => a.App_s1 === PROBES.footnotes.app || a.App === PROBES.footnotes.app);
    if (!desk) {
      record('DO30', 'footnote text', null, `no "${PROBES.footnotes.app}" row in ${PROBES.footnotes.id} — cannot check`);
    } else {
      const notes = String(desk.Footnotes || '');
      const resolved = notes.startsWith(PROBES.footnotes.notePrefix);
      record('DO30', 'footnote text', resolved,
        resolved ? `"${PROBES.footnotes.app}" carries note 18's text: "${notes.slice(3, 60).trim()}…"`
          : `"${PROBES.footnotes.app}" still shows a placeholder: "${notes.slice(0, 60)}"  → re-run npm run ingest`);
    }
  } catch (err) {
    record('DO30', 'footnote text', null, `could not read applications: ${err.message}`);
  }

  // ── DO40: section titles ───────────────────────────────────────────────────
  // Another pure "was this ingested by the current pipeline?" signal: the column
  // is only written by an ingest that ran extractSectionTitles(). Without it a
  // body excerpt can only print its section NUMBER.
  if (sample.length === 0) {
    record('DO40', 'section titles', null, 'no standards indexed — cannot check');
  } else {
    let withSections = 0;
    let example = null;
    for (const s of sample) {
      try {
        const row = (await get(`/api/standards/${encodeURIComponent(s.id)}`)).standard || {};
        if (!row.sections_json) continue;
        withSections++;
        if (!example) {
          const parsed = JSON.parse(row.sections_json);
          const [number, title] = Object.entries(parsed)[0] || [];
          if (number) example = `${s.id} §${number} "${title}"`;
        }
      } catch { /* one unreadable row is not the answer */ }
    }
    record('DO40', 'section titles',
      withSections > 0,
      `${withSections}/${sample.length} sampled standards carry sections_json` +
        (example ? ` (e.g. ${example})` : '') +
        (withSections === 0
          ? '  → this corpus predates section-title capture; apply migration 0011 and re-run npm run ingest'
          : ''));
  }

  // ── DO33: definitions ──────────────────────────────────────────────────────
  try {
    const res = await fetch(`${CONFIG.apiUrl}/api/search`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(CONFIG.apiSecret ? { Authorization: `Bearer ${CONFIG.apiSecret}` } : {}),
      },
      body: JSON.stringify({ query: 'color', filters: { content_types: ['definitions'] }, limit: 5 }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      // A search that ERRORS says nothing about whether definitions were
      // indexed — don't send the operator off to re-run the ingest for it.
      // (`wrangler dev` always lands here: Vectorize has no local binding.)
      record('DO33', 'definitions search', null,
        `the search endpoint returned HTTP ${res.status}: ${data.error || 'unknown'}` +
        (CONFIG.apiUrl.includes('localhost') ? '  (expected locally — Vectorize has no local binding)' : ''));
    } else {
      const defs = (data.results || []).filter(r => r.resultType === 'definition');
      const exact = defs.find(d => d.definition?.term === 'color');
      record('DO33', 'definitions search', defs.length > 0 && !!exact,
        defs.length === 0
          ? 'a Definitions search returned nothing  → run npm run ingest:definitions'
          : `"color" returns ${defs.length} definition(s)` +
            (exact ? `, exact term first (§${exact.definition.clause})` : ', but NOT the exact term — check the D1 term match'));
    }
  } catch (err) {
    record('DO33', 'definitions search', null, `search failed: ${err.message}`);
  }

  const failed = results.filter(r => r.ok === false);
  const unknown = results.filter(r => r.ok === null);
  console.log('');
  if (failed.length === 0 && unknown.length === 0) {
    console.log('✓ Every ingest-side fix is present in the live corpus.\n');
    return;
  }
  if (failed.length > 0) {
    console.log(`✗ ${failed.length} check(s) failed: ${failed.map(f => f.id).join(', ')}`);
    console.log('  The Worker can be up to date while the DATA is not — these fixes only');
    console.log('  apply to standards re-ingested after the change.\n');
    process.exitCode = 1;
  }
  if (unknown.length > 0) {
    console.log(`? ${unknown.length} check(s) inconclusive: ${unknown.map(f => f.id).join(', ')}\n`);
  }
}

main().catch(err => {
  console.error(`\n✗ ${err.message}\n`);
  process.exit(1);
});
