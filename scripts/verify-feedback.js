#!/usr/bin/env node
/**
 * Lensy — Acceptance check for the 260729 and 260805 client feedback items.
 *
 * `verify-ingest.js` answers "did the DATA get rewritten?". This script answers
 * the question the client actually asks: "run a search and show me the fix is
 * there." Every check below issues real requests against a running Worker and
 * asserts on the response the browser would receive — no fixtures, no mocks.
 *
 * Each item resolves to one of three states, and the distinction matters:
 *
 *   PASS    the behaviour is present in the live system. Sign it off.
 *   FAIL    the behaviour is absent and the code is supposed to provide it.
 *           Something is wrong — a stale deploy, a missing migration, or a bug.
 *   BLOCKED the check could not be answered because an input the fix depends on
 *           is missing (a CSV column, the deprecated PDFs, an unindexed probe
 *           standard). NOT a failure — but not a pass either, and the script
 *           names exactly what is missing so it can be supplied.
 *
 * The exit code is 0 only when nothing FAILED; BLOCKED items are reported and
 * counted separately so this can gate a deploy without the client's pending
 * data blocking it.
 *
 * Usage:
 *   LUCIUS_API_URL=https://lensy.ies.org LUCIUS_API_SECRET=… \
 *     node scripts/verify-feedback.js
 *
 *   node scripts/verify-feedback.js --local           # http://localhost:8787
 *   node scripts/verify-feedback.js --write           # include DO37 (writes, then cleans up)
 *   node scripts/verify-feedback.js --write --email me@example.com   # + send one share email
 *   node scripts/verify-feedback.js --only DO32,DO39  # a subset
 *   node scripts/verify-feedback.js --json            # machine-readable
 *   node scripts/verify-feedback.js --verbose         # show evidence for passes too
 *
 * Read-only unless --write is passed. The write path creates two collections
 * under throwaway user ids and deletes them again in a finally block.
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { CSV_COLUMNS, csvCell } from '../src/lib/collections.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const argOf = (name, def = null) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};

const CONFIG = {
  apiUrl: (flag('--local')
    ? 'http://localhost:8787'
    : (argOf('--url') || process.env.LUCIUS_API_URL || 'http://localhost:8787')
  ).replace(/\/+$/, ''),
  apiSecret: process.env.LUCIUS_API_SECRET || null,
  write: flag('--write'),
  // Recipient for the DO37 share email. Omitted → the send is skipped and the
  // check says so, because there is no way to verify delivery without a mailbox
  // and silently mailing someone is not an acceptable default.
  email: argOf('--email'),
  json: flag('--json'),
  verbose: flag('--verbose'),
  only: (argOf('--only') || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean),
  // Throwaway owners for the DO37 write path. Far outside the real id space so a
  // half-finished run can never collide with a member's collections.
  ownerA: 990001,
  ownerB: 990002,
};

// Probe standards. Each was measured against its own PDF while the corresponding
// fix was written, so a probe that is not indexed makes the check BLOCKED (the
// corpus can't answer it) rather than FAILED.
const PROBES = {
  zone: { standard: 'RP-2-20+E1', query: 'ramps stairs and steps high activity' },
  footnote: { standard: 'RP-11-26', app: 'Desk', note: 18 },
  comparison: { query: "what's new in RP-8?", family: 'RP-8' },
  definition: { term: 'color' },
  references: { query: 'list of IES references about roadway lighting' },
  body: { query: 'how should uniformity be evaluated across a lit area' },
  neutral: { query: 'office lighting levels' },
  definitionPhrase: { query: 'define mesopic vision' },
  // The client's own sample search for DO40 — a broad conceptual query whose
  // answers are body excerpts, which is where the section heading has to appear.
  section: { query: 'transition and circulation space' },
};

// The per-type match floors declared in src/workers/search.ts (DO39). Duplicated
// as literals on purpose: the point of the check is to confirm the DEPLOYED
// Worker enforces them, so importing the constant would make it self-fulfilling.
const TYPE_FLOORS = { excerpt: 0.25, definition: 0.40, reference: 0.25, application: 0.50 };

const TYPE_FOR_CONTENT = {
  tables: 'application', body: 'excerpt', references: 'reference', definitions: 'definition',
};

// ─── HTTP ─────────────────────────────────────────────────────────────────────

const authHeaders = () => (CONFIG.apiSecret ? { Authorization: `Bearer ${CONFIG.apiSecret}` } : {});

async function request(method, path, body) {
  const res = await fetch(`${CONFIG.apiUrl}${path}`, {
    method,
    headers: {
      ...authHeaders(),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON — csv, html, or an error page */ }
  return { status: res.status, ok: res.ok, json, text, headers: res.headers };
}

const get = (path) => request('GET', path);
const post = (path, body) => request('POST', path, body ?? {});
const del = (path) => request('DELETE', path);

/**
 * One search, cache-bypassed.
 *
 * `debug: true` skips the KV response cache — without it a check could pass on a
 * payload cached before the fix was deployed, which is precisely the failure this
 * script exists to catch. It also returns the deprecated-probe diagnostics the
 * comparison checks read.
 *
 * The Worker rate-limits search to 60/min per IP; one retry covers the case
 * where a previous run left the window nearly full.
 */
async function search(query, { contentTypes = null, ai = false, limit = 20, standard = null } = {}) {
  const filters = {};
  if (contentTypes) filters.content_types = contentTypes;
  if (standard) filters.standard = standard;

  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await post('/api/search', { query, includeAISummary: ai, filters, limit, debug: true });
    if (res.status === 429 && attempt === 0) {
      await sleep(12_000);
      continue;
    }
    if (!res.ok) {
      const err = new Error(`search "${query}" → HTTP ${res.status}: ${res.json?.error || res.text.slice(0, 160)}`);
      err.status = res.status;
      throw err;
    }
    return res.json;
  }
  throw new Error(`search "${query}" kept hitting the rate limit`);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * The one comparison search, shared by DO27 and DO28.
 *
 * Both examine the same response from different angles, and each of these runs a
 * 70B summary that is billed to the account — running it twice would double the
 * cost to check two properties of one answer.
 */
let comparisonSearchPromise = null;
function comparisonSearch() {
  if (!comparisonSearchPromise) {
    comparisonSearchPromise = search(PROBES.comparison.query, { ai: true, limit: 20 });
  }
  return comparisonSearchPromise;
}

// ─── Outcomes ─────────────────────────────────────────────────────────────────

const PASS = 'PASS', FAIL = 'FAIL', BLOCKED = 'BLOCKED';
const pass = (evidence) => ({ state: PASS, evidence });
const fail = (evidence, fix = null) => ({ state: FAIL, evidence, fix });
const blocked = (evidence, needs) => ({ state: BLOCKED, evidence, needs });

// ─── Shared context (fetched once, reused across checks) ──────────────────────

const ctx = {
  standards: null,      // /api/standards?status=all
  active: null,
  standardsError: null, // why the list is unavailable, if it is
  totals: null,         // /api/admin/index-status
  indexHtml: null,      // the served search page, for the frontend-only items
  tocHtml: null,        // the served Table of Contents page (DO46)
  projectsHtml: null,   // the served collections page (DO49/DO50/DO55/DO56)
  migration0010: null,  // boolean | null
  existsCache: new Map(),
};

/**
 * The standards list — or the reason it is unavailable.
 *
 * Deliberately non-fatal. The list endpoint selects the Table-of-Contents columns
 * migration 0010 adds, so on a database where the Worker is current but the
 * migration is not, this whole endpoint answers 500 while search works perfectly.
 * That must show up as two BLOCKED metadata checks with the real cause named, not
 * as an aborted run.
 */
async function loadStandards() {
  if (ctx.standards || ctx.standardsError) return ctx.standards || [];
  const res = await get('/api/standards?status=all');
  if (!res.ok) {
    ctx.standardsError =
      `/api/standards answers HTTP ${res.status}` +
      (res.status === 500 ? ' — the deployed Worker selects columns this database does not have' : '');
    ctx.standards = null;
    ctx.active = null;
    return [];
  }
  ctx.standards = res.json.standards || [];
  ctx.active = ctx.standards.filter(s => s.status === 'Active');
  return ctx.standards;
}

/** Corpus counts straight from the admin endpoint — no 0010 columns involved. */
async function loadTotals() {
  if (ctx.totals) return ctx.totals;
  const res = await get('/api/admin/index-status');
  ctx.totals = res.ok ? (res.json.totals || null) : null;
  return ctx.totals;
}

/**
 * Is one standard indexed? Uses the per-id route, which selects `*` and therefore
 * survives a missing migration — unlike the list route.
 */
async function standardIsIndexed(id) {
  if (ctx.existsCache.has(id)) return ctx.existsCache.get(id);
  const res = await get(`/api/standards/${encodeURIComponent(id)}`);
  const found = res.status === 200;
  ctx.existsCache.set(id, found);
  return found;
}

/**
 * The served search page.
 *
 * DO36 and DO38 live entirely in the browser, so the only honest way to verify
 * them against a deployment is to read the asset the deployment serves — not the
 * file in the working tree, which may be ahead of what is live. Falls back to the
 * local file only when the URL is unreachable, and says so.
 */
async function loadIndexHtml() {
  if (ctx.indexHtml) return ctx.indexHtml;
  try {
    const res = await fetch(`${CONFIG.apiUrl}/`, { headers: authHeaders() });
    const text = await res.text();
    if (res.ok && /RESULT_TYPE_STYLES/.test(text)) {
      ctx.indexHtml = { source: 'served', text };
      return ctx.indexHtml;
    }
  } catch { /* fall through to the local copy */ }
  ctx.indexHtml = {
    source: 'local file (the deployment did not serve the page)',
    text: readFileSync(resolve(ROOT, 'src/frontend/index.html'), 'utf8'),
  };
  return ctx.indexHtml;
}

/** The served Saved Search Collections page (DO49/DO50/DO55/DO56). */
async function loadProjectsHtml() {
  if (ctx.projectsHtml) return ctx.projectsHtml;
  try {
    const res = await fetch(`${CONFIG.apiUrl}/projects.html`, { headers: authHeaders() });
    const text = await res.text();
    if (res.ok && /renderApplicationRow/.test(text)) {
      ctx.projectsHtml = { source: 'served', text };
      return ctx.projectsHtml;
    }
  } catch { /* fall through to the local copy */ }
  ctx.projectsHtml = {
    source: 'local file (the deployment did not serve the page)',
    text: readFileSync(resolve(ROOT, 'src/frontend/projects.html'), 'utf8'),
  };
  return ctx.projectsHtml;
}

/** The served Table of Contents page (DO46), with the same local fallback. */
async function loadTocHtml() {
  if (ctx.tocHtml) return ctx.tocHtml;
  for (const path of ['/contents', '/contents.html']) {
    try {
      const res = await fetch(`${CONFIG.apiUrl}${path}`, { headers: authHeaders() });
      const text = await res.text();
      if (res.ok && /toc-groups/.test(text)) {
        ctx.tocHtml = { source: `served (${path})`, text };
        return ctx.tocHtml;
      }
    } catch { /* try the next path, then the local copy */ }
  }
  ctx.tocHtml = {
    source: 'local file (the deployment did not serve the page)',
    text: readFileSync(resolve(ROOT, 'src/frontend/contents.html'), 'utf8'),
  };
  return ctx.tocHtml;
}

/**
 * Is migration 0010 applied?  true | false | null (undetermined)
 *
 * Probed read-only through the standards LIST, because that is the one endpoint
 * whose query names a column 0010 adds (`collection`): it answers 200 when the
 * migration is in place and 500 "no such column" when it is not.
 *
 * An earlier version of this probe asked the shared-collection route instead, on
 * the assumption that `share_token` came from 0010. It does not — 0001 added it —
 * so that probe reported "applied" against a database that was missing every
 * column 0010 actually adds. Any probe here must name a column 0010 introduces.
 */
async function migration0010Applied() {
  if (ctx.migration0010 !== null) return ctx.migration0010;
  await loadStandards();
  if (ctx.standards) ctx.migration0010 = true;
  else if (/HTTP 500/.test(ctx.standardsError || '')) ctx.migration0010 = false;
  else ctx.migration0010 = null;
  return ctx.migration0010;
}

// ─── Helpers over a search payload ────────────────────────────────────────────

const byType = (results, type) => (results || []).filter(r => r.resultType === type);
const typeMix = (results) => {
  const counts = {};
  for (const r of results || []) counts[r.resultType] = (counts[r.resultType] || 0) + 1;
  return Object.entries(counts).map(([t, n]) => `${n} ${t}`).join(', ') || 'nothing';
};
/** Every excerpt text in a payload, as one lowercased haystack. */
const excerptHaystack = (results) => (results || [])
  .flatMap(r => [r.excerpt, ...(r.excerpts || [])])
  .filter(Boolean)
  .map(e => String(e.text || ''))
  .join('\n')
  .replace(/\s+/g, ' ')
  .toLowerCase();

// ─── Checks ───────────────────────────────────────────────────────────────────
//
// One entry per feedback item, in the client's numbering. `run` returns a
// pass/fail/blocked outcome; a thrown error is reported as a FAIL with the
// message, so a broken endpoint never reads as a silent pass.

const CHECKS = [
  {
    id: 'DO20',
    title: 'Lighting Zone reaches the card',
    async run() {
      if (!await standardIsIndexed(PROBES.zone.standard)) {
        return blocked(`${PROBES.zone.standard} is not indexed`, 'ingest the RP-2 PDF');
      }
      const data = await search(PROBES.zone.query, { contentTypes: ['tables'], limit: 25 });
      const apps = byType(data.results, 'application');
      if (apps.length === 0) return blocked('the query returned no illuminance-table rows', 're-ingest');

      const zoned = apps.filter(r => r.application?.outdoor?.lightingZone);
      if (zoned.length === 0) {
        return fail(
          `${apps.length} table row(s), none carrying application.outdoor.lightingZone`,
          'the zone is extracted at ingest — run npm run ingest, then npm run verify:ingest',
        );
      }
      const sample = zoned.slice(0, 3).map(r => `${r.application.fullName} → ${r.application.outdoor.lightingZone}`);
      return pass(`${zoned.length}/${apps.length} rows carry a zone (e.g. ${sample.join('; ')})`);
    },
  },

  {
    id: 'DO23',
    title: 'Document results are not crowded out by table rows',
    async run() {
      // The complaint was that with both boxes ticked a broad conceptual query
      // came back with a single Document card. The fix reserves 40% of the pool.
      const data = await search(PROBES.body.query, { contentTypes: ['tables', 'body'], limit: 20 });
      const total = (data.results || []).length;
      if (total === 0) return blocked('the query returned nothing at all', 'ingest the corpus');
      const docs = byType(data.results, 'excerpt').length;
      const share = docs / total;
      if (docs < 2 || share < 0.3) {
        return fail(
          `only ${docs}/${total} Document cards — mix: ${typeMix(data.results)}`,
          'BODY_RESULT_MIN_SHARE is 0.4 in the code; if the deploy is current, the corpus has too few prose chunks — re-run npm run ingest',
        );
      }

      // The reservation must not have inverted the problem: on a query that IS
      // about illuminance values, table rows still have to reach the pool. A
      // 100%-Document result set on this second query would mean the fix traded
      // one imbalance for the other.
      const tabular = await search('recommended illuminance for a hospital patient room',
        { contentTypes: ['tables', 'body'], limit: 20 });
      const tabRows = byType(tabular.results, 'application').length;
      if ((tabular.results || []).length > 0 && tabRows === 0) {
        return fail(
          `Documents are no longer squeezed out (${docs}/${total} on a conceptual query), but an ` +
          `illuminance query now returns none: ${typeMix(tabular.results)}`,
          'the body reservation has inverted the mix — check BODY_RESULT_MIN_SHARE and the DO39 application floor together',
        );
      }
      return pass(
        `conceptual query → ${docs}/${total} Document cards (${Math.round(share * 100)}% of the pool); ` +
        `illuminance query → ${typeMix(tabular.results)}, so neither kind is squeezed out`,
      );
    },
  },

  {
    id: 'DO26.5',
    title: 'A references search runs the references prompt',
    async run() {
      const data = await search(PROBES.references.query, { contentTypes: ['references'], ai: true, limit: 10 });
      if (!data.aiSummary) return blocked('no AI summary came back', 'Workers AI must be reachable');
      if (data.aiSummary.degraded) return blocked('every AI model attempt failed (degraded fallback)', 'retry when Workers AI recovers');
      if (data.aiSummary.mode === 'references') return pass('aiSummary.mode = "references"');
      return fail(`aiSummary.mode = "${data.aiSummary.mode}" — expected "references"`);
    },
  },

  {
    id: 'DO27',
    title: 'Comparison prints current first, one prior edition analysed',
    async run() {
      const totals = await loadTotals();
      if (totals && totals.deprecated === 0) {
        return blocked(
          'no deprecated editions are indexed, so no comparison can be ordered',
          'put the prior-edition PDFs in pdfs/Deprecated Standards/ and run npm run ingest:deprecated',
        );
      }
      const data = await comparisonSearch();
      if (!data.isVersionComparison) return fail('the query was not recognised as a version comparison');

      const results = data.results || [];
      if (!results.some(r => r.isDeprecated) && !data.aiSummary?.comparison?.deprecated?.length) {
        return blocked(
          `the comparison retrieved no deprecated content for ${PROBES.comparison.family}`,
          `confirm a prior ${PROBES.comparison.family} edition is in the deprecated index (npm run ingest:deprecated)`,
        );
      }
      const firstDeprecated = results.findIndex(r => r.isDeprecated);
      const lastCurrent = results.reduce((last, r, i) => (r.isDeprecated ? last : i), -1);
      if (firstDeprecated !== -1 && lastCurrent > firstDeprecated) {
        return fail(`a current-edition card appears at #${lastCurrent + 1}, after a deprecated one at #${firstDeprecated + 1}`);
      }

      const cmp = data.aiSummary?.comparison;
      if (!cmp) return blocked('the AI summary carried no comparison context', 'AI Guide must be on and reachable');
      if ((cmp.deprecated || []).length !== 1) {
        return fail(
          `${(cmp.deprecated || []).length} prior editions were fed to the prompt — exactly 1 expected`,
          'buildComparisonContext must target only the most recent deprecated edition',
        );
      }
      const also = (cmp.alsoDeprecated || []).length;
      return pass(
        `analysed against ${cmp.deprecated[0].id} alone` +
        (also ? `, ${also} older edition(s) listed but excluded from the prompt` : '') +
        `; ${results.filter(r => r.isDeprecated).length} deprecated card(s) all after the current ones`,
      );
    },
  },

  {
    id: 'DO28',
    title: 'Comparison never invents a locator or a subject',
    async run() {
      const totals = await loadTotals();
      if (totals && totals.deprecated === 0) {
        return blocked(
          'no deprecated editions are indexed, so the grounding rule has nothing to violate',
          'put the prior-edition PDFs in pdfs/Deprecated Standards/ and run npm run ingest:deprecated',
        );
      }
      const data = await comparisonSearch();
      const text = data.aiSummary?.text || '';
      if (!text) return blocked('the comparison produced no text', 'AI Guide must be reachable');
      if (data.aiSummary?.degraded) return blocked('every AI model attempt failed (degraded fallback)', 'retry when Workers AI recovers');

      // (a) every locator the prose names must appear verbatim in a retrieved excerpt
      const haystack = excerptHaystack(data.results);
      const locators = [...new Set(
        (text.match(/\b(?:Section|Annex|Table|Figure|Chapter|Clause)\s+[A-Z]?-?\d+(?:\.\d+)*[a-z]?\b|\bAnnex\s+[A-Z]\b/g) || [])
          .map(s => s.replace(/\s+/g, ' ').trim()),
      )];
      const invented = locators.filter(l => !haystack.includes(l.toLowerCase()));

      // (b) the standard family it talks about must be the one that was asked about
      const family = PROBES.comparison.family;
      const otherFamilies = [...new Set(
        (text.match(/\b(?:RP|LP|DG|TM|LM|ANSI\/IES)[-\s]?\d+\b/g) || [])
          .map(s => s.replace(/^ANSI\/IES\s*/i, '').replace(/\s+/g, '-').toUpperCase())
          .filter(f => !f.startsWith(family)),
      )];

      if (invented.length === 0 && otherFamilies.length === 0) {
        // Zero locators is a pass on the rule but weak evidence FOR it: nothing
        // was there to be invented. Say which of the two happened, so a reader
        // does not mistake an empty answer for a verified one.
        return pass(
          locators.length === 0
            ? `the answer named no section/annex/table locator at all, so none could be invented, and no ` +
              `standard outside ${family} is mentioned (${text.length} chars of prose — nothing to cross-check against)`
            : `${locators.length} locator(s) named (${locators.slice(0, 4).join(', ')}${locators.length > 4 ? '…' : ''}), ` +
              `every one present verbatim in the retrieved excerpts; no standard outside ${family} mentioned`,
        );
      }
      return fail(
        [
          invented.length ? `locators absent from every excerpt: ${invented.join(', ')}` : null,
          otherFamilies.length ? `talks about ${otherFamilies.join(', ')} on a ${family} query` : null,
        ].filter(Boolean).join(' | '),
        'the grounding rules live in the comparison prompt (src/lib/ai-summary.ts) — a model can still stray; re-run before treating one violation as a regression',
      );
    },
  },

  {
    id: 'DO29',
    title: 'Passage count never overstates what is available',
    async run() {
      const data = await search(PROBES.body.query, { contentTypes: ['body'], limit: 20 });
      const withExcerpts = (data.results || []).filter(r => (r.excerpts || []).length > 0);
      if (withExcerpts.length === 0) return blocked('no result carried a passage list', 're-ingest the corpus');
      const over = withExcerpts.filter(r => r.excerpts.length > 10);
      if (over.length > 0) {
        return fail(`${over.length} card(s) carry more than 10 passages (max ${Math.max(...over.map(r => r.excerpts.length))})`);
      }
      const atCap = withExcerpts.filter(r => r.excerpts.length === 10).length;
      const html = await loadIndexHtml();
      // The API half is the cap; the honest label is the UI half — at the cap the
      // list is a ranked subset, so it must read "Top 10", not "10 passages".
      if (!/Top \$\{MAX_EXCERPTS_SHOWN\} passages/.test(html.text)) {
        return fail(`the cap holds (max ${Math.max(...withExcerpts.map(r => r.excerpts.length))}), but the page does not render the "Top N passages" label`);
      }
      return pass(
        `every card is at or under the 10-passage cap (${atCap} at the cap), and the page labels a capped list "Top 10 passages" [${html.source}]`,
      );
    },
  },

  {
    id: 'DO30',
    title: 'Footnotes carry their text, not a bare number',
    async run() {
      if (!await standardIsIndexed(PROBES.footnote.standard)) {
        return blocked(`${PROBES.footnote.standard} is not indexed`, `ingest the ${PROBES.footnote.standard} PDF`);
      }
      const res = await get(`/api/applications?standard=${encodeURIComponent(PROBES.footnote.standard)}`);
      if (!res.ok) return blocked(`/api/applications → HTTP ${res.status}`, 'the applications endpoint must answer');
      const apps = res.json.applications || [];
      const withNotes = apps.filter(a => a.Footnotes && String(a.Footnotes).trim());
      if (withNotes.length === 0) {
        return fail(`no row in ${PROBES.footnote.standard} carries any footnote text`, 'run npm run ingest');
      }
      // A resolved note reads "18. Illuminance values are…"; the old behaviour
      // left the number alone, or pointed at a page.
      const resolved = withNotes.filter(a => /^\s*\d+\.\s+\S+/.test(String(a.Footnotes)) && String(a.Footnotes).trim().length > 12);
      if (resolved.length === 0) {
        return fail(
          `footnotes are present but none resolve to text, e.g. "${String(withNotes[0].Footnotes).slice(0, 70)}"`,
          'run npm run ingest',
        );
      }
      return pass(
        `${resolved.length}/${withNotes.length} annotated rows in ${PROBES.footnote.standard} carry note text ` +
        `(e.g. "${String(resolved[0].Footnotes).replace(/\s+/g, ' ').slice(0, 64)}…")`,
      );
    },
  },

  {
    id: 'DO31.3',
    title: 'No dead DOI links on reference cards',
    async run() {
      const data = await search(PROBES.references.query, { contentTypes: ['references'], limit: 25 });
      const refs = byType(data.results, 'reference');
      if (refs.length === 0) return blocked('the query returned no reference entries', 're-ingest the corpus');
      const links = refs.map(r => r.referenceLink).filter(Boolean);
      // The failure mode was a prefix-only DOI: doi.org/10.1234 with no suffix,
      // which resolves to nothing.
      const broken = links.filter(l => l.type === 'doi' && !/doi\.org\/10\.\d{4,9}\/\S+/.test(l.url));
      if (broken.length > 0) {
        return fail(`${broken.length} prefix-only DOI link(s): ${broken.slice(0, 3).map(l => l.url).join(', ')}`);
      }
      return pass(
        `${refs.length} reference entries, ${links.length} with a link, none a prefix-only DOI` +
        (links.length ? ` (${[...new Set(links.map(l => l.type))].join('/')})` : ''),
      );
    },
  },

  {
    id: 'DO31.4',
    title: 'Reference markers point at the citing page, not the bibliography',
    async run() {
      const data = await search(PROBES.references.query, { contentTypes: ['references'], limit: 25 });
      const refs = byType(data.results, 'reference');
      if (refs.length === 0) return blocked('the query returned no reference entries', 're-ingest the corpus');
      const markers = refs.flatMap(r => r.referenceMarkers || []);
      if (markers.length === 0) {
        return blocked(
          `${refs.length} reference entries, none cross-referenced to another standard`,
          'this query may simply have no shared citations — retry with --only DO31.4 and a different query, or re-ingest',
        );
      }
      const citation = markers.filter(m => m.target === 'citation' && m.pageNumber);
      if (citation.length === 0) {
        return fail(
          `${markers.length} marker(s), all pointing at the References page (target="references")`,
          'in-body markers are captured at ingest into standards.reference_markers_json — run npm run ingest, then npm run verify:ingest',
        );
      }
      const e = citation[0];
      return pass(
        `${citation.length}/${markers.length} markers resolve to the citing body page ` +
        `(e.g. ${e.standard} cites it as [${e.referenceNumber}] on p. ${e.pageNumber})`,
      );
    },
  },

  {
    id: 'DO32',
    title: 'Content-type filters are independent, and detected from the query',
    async run() {
      const notes = [];

      // (a) the default selection is exactly Illuminance Tables + Documents
      const dflt = await search(PROBES.neutral.query, { limit: 10 });
      const set = [...(dflt.contentTypes || [])].sort();
      if (set.join(',') !== 'body,tables') {
        return fail(`the default selection is [${set.join(', ')}] — expected [body, tables]`);
      }
      notes.push('default = tables + body');

      // (b) each kind, on its own, returns only its own cards
      for (const [content, expected] of Object.entries(TYPE_FOR_CONTENT)) {
        const data = await search(
          content === 'definitions' ? PROBES.definition.term
            : content === 'references' ? PROBES.references.query
              : PROBES.neutral.query,
          { contentTypes: [content], limit: 12 },
        );
        const results = data.results || [];
        if (results.length === 0) {
          notes.push(`${content}: empty (cannot confirm)`);
          continue;
        }
        const strays = results.filter(r => r.resultType !== expected);
        if (strays.length > 0) {
          return fail(`content_types=[${content}] returned ${typeMix(results)} — only ${expected} cards expected`);
        }
        notes.push(`${content} → ${results.length} ${expected}`);
      }

      // (c) a definition-phrased query switches itself to Definitions
      const detected = await search(PROBES.definitionPhrase.query, { limit: 10 });
      if (!(detected.contentTypes || []).includes('definitions')) {
        return fail(`"${PROBES.definitionPhrase.query}" did not auto-select Definitions (got [${(detected.contentTypes || []).join(', ')}])`);
      }
      notes.push('definition phrasing auto-selects Definitions');

      // (d) the UI labels match the filters exactly
      const html = await loadIndexHtml();
      const labels = ['Illuminance Table', 'Document', 'Reference', 'Definition'];
      const missing = labels.filter(l => !html.text.includes(`label: '${l}'`));
      if (missing.length > 0) {
        return fail(`the result-card labels do not match the filter names: missing ${missing.join(', ')} [${html.source}]`);
      }
      notes.push('card labels match the pills');

      return pass(notes.join(' · '));
    },
  },

  {
    id: 'DO33',
    title: 'LS-1 definitions: exact term wins, printed in full, credited to LS-1',
    async run() {
      const data = await search(PROBES.definition.term, { contentTypes: ['definitions'], limit: 10 });
      const defs = byType(data.results, 'definition');
      if (defs.length === 0) {
        return fail(
          `a Definitions search for "${PROBES.definition.term}" returned nothing`,
          'run npm run ingest:definitions — and confirm the chunk_type metadata index existed BEFORE the vectors were inserted: npx wrangler vectorize list-metadata-index ies-standards-vectors',
        );
      }
      const first = defs[0].definition || {};
      if (String(first.term || '').toLowerCase() !== PROBES.definition.term) {
        return fail(
          `the top definition is "${first.term}", not the exact term "${PROBES.definition.term}"`,
          'the D1 term match is meant to outrank the semantic match (searchDefinitions in src/workers/search.ts)',
        );
      }
      if (!first.html || first.html.length < 20) return fail(`"${first.term}" came back with no definition body`);
      const credited = String(defs[0].application?.standardFull || '').includes('LS-1');
      if (!credited) return fail(`the card credits "${defs[0].application?.standardFull}" instead of ANSI/IES LS-1`);
      return pass(
        `"${first.term}" is first of ${defs.length}` +
        (first.clause ? ` (§${first.clause})` : '') +
        `, ${first.html.length} chars of rich text, credited to ${defs[0].application.standardFull}`,
      );
    },
  },

  {
    id: 'DO34',
    title: 'Authoring committee credited and linked',
    async run() {
      await loadStandards();
      if (ctx.standardsError) {
        return blocked(
          `the committee is resolved on the standards list, and ${ctx.standardsError}`,
          'apply migration 0010 (npm run db:migrate:remote) — the list route selects its columns',
        );
      }
      const withAuthor = ctx.standards.filter(s => s.author && String(s.author).trim());
      if (withAuthor.length === 0) {
        return blocked(
          `none of the ${ctx.standards.length} indexed standards carries an Author value`,
          'add an "Author" column to the Vitrium CSV export and run npm run sync-metadata',
        );
      }
      const resolved = withAuthor.filter(s => s.committee?.name);
      const exact = withAuthor.filter(s => s.committee?.exact);
      if (resolved.length === 0) {
        // "Authors present, none resolved" is NOT a failure by itself. The column
        // was seeded from PDF /Author metadata on older ingests, so it can hold a
        // person or a pre-press tool — resolveCommittee refuses those on purpose,
        // and refusing them is the correct behaviour, not a bug. What is missing
        // is committee data, so say that and name the source.
        const sample = withAuthor.slice(0, 4).map(s => `${s.id}: "${s.author}"`).join(', ');
        return blocked(
          `${withAuthor.length} standards carry an Author, but none names a committee — ` +
          `these are PDF file-metadata values (${sample}), which are correctly refused rather than credited`,
          'add an "Author" column holding the authoring committee to the Vitrium CSV export, then run npm run sync-metadata',
        );
      }
      // A result card must credit it too, not just the ToC.
      const data = await search(PROBES.neutral.query, { limit: 10 });
      const credited = (data.results || []).filter(r => r.committee?.name).length;
      const detail =
        `${resolved.length}/${withAuthor.length} authors resolve to a committee (${exact.length} to its own page), ` +
        `e.g. ${resolved[0].id} → ${resolved[0].committee.name}; ${credited} result card(s) credit one`;
      return credited > 0
        ? pass(detail)
        : fail(`${detail} — the ToC resolves committees but result cards do not`);
    },
  },

  {
    id: 'DO35',
    title: 'Table of Contents metadata',
    async run() {
      await loadStandards();
      if (ctx.standardsError) {
        return blocked(
          `the Table of Contents reads the standards list, and ${ctx.standardsError}`,
          'apply migration 0010 (npm run db:migrate:remote) — it adds the four ToC columns the list selects',
        );
      }
      const active = ctx.active || [];
      if (active.length === 0) return blocked('no active standards are indexed', 'ingest the corpus');
      const columns = {
        collection: s => s.collection,
        author: s => s.author,
        description: s => s.description,
        thumbnail_url: s => s.thumbnail_url,
        buy_url: s => s.buy_url,
        elearning: s => (s.elearning || []).length > 0,
      };
      const populated = Object.entries(columns)
        .map(([name, read]) => [name, active.filter(s => read(s)).length])
        .filter(([, n]) => n > 0);
      const missing = Object.keys(columns).filter(c => !populated.some(([n]) => n === c));

      if (missing.length === Object.keys(columns).length) {
        return blocked(
          `none of the six ToC columns is populated across ${active.length} standards`,
          'add Collection, Author, Description, Thumbnail, Buy URL and eLearning to the Vitrium CSV, then run npm run sync-metadata',
        );
      }
      const detail = `${populated.map(([n, c]) => `${n}: ${c}`).join(', ')} of ${active.length} standards`;
      if (missing.length > 0) {
        return blocked(
          `${detail} — still empty: ${missing.join(', ')}`,
          `add ${missing.join(', ')} to the Vitrium CSV, then run npm run sync-metadata`,
        );
      }
      return pass(`all six ToC columns populated — ${detail}`);
    },
  },

  {
    id: 'DO36',
    title: 'AI text is copy- and print-guarded',
    async run() {
      const html = await loadIndexHtml();
      const required = [
        ['copy-guard selector', /COPY_GUARD_SELECTOR\s*=\s*'\.copy-guard'/],
        ['print stylesheet', /@media\s+print\s*\{[\s\S]*?\.print-withhold\s*\{\s*display:\s*none/],
        ['guarded AI answer', /id="ai-summary-text"[^>]*class="[^"]*copy-guard[^"]*print-withhold/],
        ['copy + cut interception', /\[\s*'copy'\s*,\s*'cut'\s*\][\s\S]{0,120}addEventListener\(\s*type\s*,/],
        ['citation returned instead', /clipboardData\?\.setData\(\s*'text\/plain'/],
        ['context-menu block', /addEventListener\(\s*['"]contextmenu['"]/],
        ['carve-out so the app stays usable', /\.allow-copy/],
      ];
      const missing = required.filter(([, re]) => !re.test(html.text)).map(([name]) => name);
      if (missing.length > 0) return fail(`missing ${missing.join(', ')} [${html.source}]`);
      return pass(`all ${required.length} guards present in the served page [${html.source}]`);
    },
  },

  {
    id: 'DO37',
    title: 'Saved Search Collections: save any kind, share, claim, export',
    async run() {
      if (await migration0010Applied() === false) {
        return blocked(
          'migration 0010 is not applied to this database — project_applications has none of the ' +
          'columns a saved search needs (result_type, standard_id, resource_title, page_number, ' +
          'library_url, application_name, reference_text), and projects has no collection_type',
          'npm run db:migrate:remote  (or db:migrate:local for a local run)',
        );
      }
      if (!CONFIG.write) {
        return blocked(
          'the schema is in place, but proving save/share/claim/export end to end requires writing',
          're-run with --write (it creates two throwaway collections and deletes them again)',
        );
      }

      const created = [];
      try {
        // 1. a collection with a user-defined type and a note
        const c = await post('/api/projects', {
          user_id: CONFIG.ownerA,
          name: 'verify-feedback probe',
          collection_type: 'Feasibility study',
          notes: 'collection note from verify-feedback',
          client_name: 'Probe Client',
          location: 'Probe City',
        });
        if (c.status !== 201) return fail(`creating a collection → HTTP ${c.status}: ${c.json?.error || c.text.slice(0, 120)}`);
        const id = c.json.project.id;
        created.push([id, CONFIG.ownerA]);
        if ((c.json.project.collection_type || '') !== 'Feasibility study') {
          return fail(`a user-defined collection type was not stored (got "${c.json.project.collection_type}")`);
        }

        // 2. one item of each kind — and an attempt to smuggle contents into a
        //    Document item, which the no-contents rule must strip.
        const items = [
          { result_type: 'tables', resource_title: 'ANSI/IES RP-2-20, p. 14', standard_id: 'RP-2-20+E1', page_number: 14, application_name: 'Ramps, Stairs, and Steps', note: 'table item' },
          { result_type: 'body', resource_title: 'ANSI/IES RP-8-25, p. 61', standard_id: 'RP-8-25', page_number: 61, reference_text: 'SMUGGLED BODY TEXT', application_name: 'SMUGGLED APP NAME', note: 'document item' },
          { result_type: 'references', resource_title: 'ANSI/IES RP-8-25 References, p. 120', standard_id: 'RP-8-25', page_number: 120, reference_text: 'CIE 115:2010 Lighting of Roads for Motor and Pedestrian Traffic.' },
          { result_type: 'definitions', resource_title: 'ANSI/IES LS-1-25 — color', standard_id: 'LS-1-25', definition_slug: 'color' },
        ];
        const added = await post(`/api/projects/${id}/applications`, items);
        if (!added.ok) return fail(`saving items → HTTP ${added.status}: ${added.json?.error || ''}`);
        const insertedIds = added.json.inserted_ids || [];
        if (insertedIds.length !== 4) {
          return fail(
            `${insertedIds.length}/4 items saved` +
            ` — rejected: ${JSON.stringify(added.json.rejected || [])}` +
            `, skipped: ${JSON.stringify(added.json.skipped || [])}`,
          );
        }

        // 3. the no-contents rule
        const readBack = await get(`/api/projects/${id}`);
        const saved = readBack.json?.applications || [];
        const doc = saved.find(i => i.result_type === 'body');
        if (!doc) return fail('the Document item did not come back');
        if (doc.reference_text || doc.application_name) {
          return fail(
            `a Document item persisted contents it must not keep: reference_text=${JSON.stringify(doc.reference_text)}, application_name=${JSON.stringify(doc.application_name)}`,
          );
        }
        const tableItem = saved.find(i => i.result_type === 'tables');
        if (!tableItem?.application_name) return fail('the illuminance-table item lost its application name');

        // 4. share → read as recipient → claim into another account
        const shared = await post(`/api/projects/${id}/share`);
        const token = shared.json?.share_token || shared.json?.token || shared.json?.collection?.share_token;
        if (!token) return fail(`sharing returned no token: ${JSON.stringify(shared.json).slice(0, 160)}`);
        const reshared = await post(`/api/projects/${id}/share`);
        const token2 = reshared.json?.share_token || reshared.json?.token || reshared.json?.collection?.share_token;
        if (token2 !== token) return fail('re-sharing minted a second token instead of reusing the first');

        const viewed = await get(`/api/projects/shared/${token}`);
        if (!viewed.ok) return fail(`opening the share link → HTTP ${viewed.status}`);
        if ((viewed.json.applications || []).length !== 4) {
          return fail(`the share link shows ${(viewed.json.applications || []).length}/4 items`);
        }

        const claimed = await post(`/api/projects/shared/${token}/claim`, { user_id: CONFIG.ownerB });
        if (claimed.status !== 201) return fail(`claiming → HTTP ${claimed.status}: ${claimed.json?.error || ''}`);
        const copyId = claimed.json.collection_id;
        created.push([copyId, CONFIG.ownerB]);
        if (claimed.json.items !== 4) return fail(`the claimed copy carries ${claimed.json.items}/4 items`);
        const copy = await get(`/api/projects/${copyId}`);
        const copyRow = copy.json?.project || copy.json?.collection || {};
        if (Number(copyRow.user_id) !== CONFIG.ownerB) {
          return fail(`the copy belongs to user ${copyRow.user_id}, not the claimant ${CONFIG.ownerB}`);
        }
        if (copyRow.share_token) return fail('the claimed copy inherited the source share token');

        // 5. CSV export, in the client's column order
        const csv = await get(`/api/projects/${id}/csv`);
        if (!csv.ok) return fail(`CSV export → HTTP ${csv.status}`);
        const header = csv.text.split(/\r?\n/)[0];
        // Every cell is quoted (csvCell), so build the expectation the same way
        // rather than comparing quoted output against a bare label list.
        const expected = CSV_COLUMNS.map(([, label]) => csvCell(label)).join(',');
        if (header !== expected) {
          return fail(`the CSV header is not the specified order.\n      got:      ${header}\n      expected: ${expected}`);
        }
        const rows = csv.text.trim().split(/\r?\n/).length - 1;
        if (rows !== 4) return fail(`the CSV holds ${rows} data rows, expected 4`);
        // Lux values must never leave a saved collection.
        if (/\b\d{2,4}\s*(?:lux|lx|fc)\b/i.test(csv.text)) {
          return fail('the CSV contains illuminance values — a saved collection stores citations only');
        }

        // 6. the share email Lensy sends itself
        let emailNote;
        if (!CONFIG.email) {
          emailNote = 'email not exercised (pass --email <address> to send one and verify delivery)';
        } else {
          const sent = await post(`/api/projects/${id}/email`, {
            to: CONFIG.email,
            sender_name: 'verify-feedback',
            message: 'Automated check of the DO37 share email.',
          });
          if (!sent.ok) {
            return fail(`emailing the collection → HTTP ${sent.status}: ${sent.json?.error || sent.text.slice(0, 160)}`);
          }
          if (sent.json?.sent !== true) {
            // A delivery failure is reported, not thrown, so name the E_* code —
            // it distinguishes "onboard the domain" from "retry later".
            return fail(
              `the endpoint accepted the request but delivery failed: ${sent.json?.error || 'unknown error'}`,
              /E_SENDER_NOT_VERIFIED/.test(String(sent.json?.error))
                ? 'lensy.ies.org is not (or no longer) onboarded to Cloudflare Email Service → Email Sending'
                : null,
            );
          }
          if (!sent.json.share_token) return fail('the email was sent without minting a claim token');
          emailNote = `emailed to ${CONFIG.email} with a claim link (${sent.json.path})`;
        }

        // A malformed recipient must be refused before the binding sees it.
        const badTo = await post(`/api/projects/${id}/email`, { to: 'not-an-address' });
        if (badTo.status !== 400) {
          return fail(`a malformed recipient returned HTTP ${badTo.status}, expected 400`);
        }

        return pass(
          'created a collection with a user-defined type; saved one item of each of the four kinds; ' +
          'the Document item stored no contents; share token reused on re-share; the claim produced an ' +
          `independent copy owned by the claimant with all 4 items and no token; CSV exported with the ` +
          `${CSV_COLUMNS.length} specified columns in order and no illuminance values; ` +
          'a malformed recipient is refused with 400; ' + emailNote,
        );
      } finally {
        for (const [id] of created.reverse()) {
          await del(`/api/projects/${id}`).catch(() => {});
        }
      }
    },
  },

  {
    id: 'DO38',
    title: 'Line style carries meaning; Interior/Exterior use the printed fills',
    async run() {
      const html = await loadIndexHtml();
      const styles = {};
      const block = html.text.match(/const RESULT_TYPE_STYLES\s*=\s*\{[\s\S]*?\n\s*\};/);
      if (!block) return fail(`RESULT_TYPE_STYLES not found in the page [${html.source}]`);
      for (const m of block[0].matchAll(/(\w+):\s*\{[^}]*line:\s*'(solid|dashed)'/g)) styles[m[1]] = m[2];

      const expected = { excerpt: 'solid', application: 'dashed', reference: 'dashed', definition: 'dashed' };
      const wrong = Object.entries(expected).filter(([k, v]) => styles[k] !== v);
      if (wrong.length > 0) {
        return fail(
          `line styles are wrong: ${wrong.map(([k, v]) => `${k} should be ${v}, is ${styles[k] || 'absent'}`).join('; ')} ` +
          '(solid = the whole document, dashed = an extract from it)',
        );
      }
      const fills = html.text.match(/LOCATION_FILL\s*=\s*\{\s*Indoor:\s*'(#[0-9A-Fa-f]{6})',\s*Outdoor:\s*'(#[0-9A-Fa-f]{6})'/);
      if (!fills) return fail(`the Interior/Exterior fills were not found [${html.source}]`);
      if (fills[1].toUpperCase() !== '#2E4A62' || fills[2].toUpperCase() !== '#2E4A34') {
        return fail(`fills are ${fills[1]}/${fills[2]} — the client specified #2E4A62 (Interior) / #2E4A34 (Exterior)`);
      }
      return pass(
        `Document solid; Illuminance Table, Reference and Definition dashed; fills ${fills[1]} / ${fills[2]} [${html.source}]`,
      );
    },
  },

  {
    id: 'DO39',
    title: 'Weak table rows dropped; Documents/Definitions/References favoured',
    async run() {
      const notes = [];
      // (a) nothing below its type's floor survives — checked across several
      //     queries, because one query may simply have no weak candidates.
      let checkedResults = 0;
      for (const q of [PROBES.neutral.query, PROBES.body.query, 'skating rink brightness']) {
        const data = await search(q, { contentTypes: ['tables', 'body', 'references', 'definitions'], limit: 30 });
        const results = data.results || [];
        checkedResults += results.length;
        const under = results.filter(r => (r.relevanceScore || 0) < (TYPE_FLOORS[r.resultType] ?? 0));
        if (under.length > 0) {
          // The documented fallback: when EVERY result is below its floor the
          // best few are kept rather than showing a blank page.
          const allUnder = under.length === results.length && results.length <= 3;
          if (!allUnder) {
            const worst = under.sort((a, b) => a.relevanceScore - b.relevanceScore)[0];
            return fail(
              `"${q}" returned a ${worst.resultType} at ${(worst.relevanceScore * 100).toFixed(0)}% ` +
              `(floor ${(TYPE_FLOORS[worst.resultType] * 100).toFixed(0)}%): ${worst.citation}`,
            );
          }
          notes.push(`"${q}": all ${results.length} below floor — documented keep-at-least fallback`);
        }
      }
      if (checkedResults === 0) return blocked('none of the probe queries returned anything', 'ingest the corpus');
      notes.push(`${checkedResults} results across 3 queries, all at or above their type floor`);

      // (b) the type preference only breaks near-ties, so relevance still leads.
      const data = await search(PROBES.body.query, { contentTypes: ['tables', 'body', 'references', 'definitions'], limit: 30 });
      const scores = (data.results || []).map(r => r.relevanceScore || 0);
      const inverted = scores.findIndex((s, i) => i > 0 && s > scores[i - 1] + 0.01);
      if (inverted > 0) {
        return fail(`result #${inverted + 1} scores ${scores[inverted].toFixed(3)}, more than 0.01 above #${inverted} (${scores[inverted - 1].toFixed(3)}) — the type bonus is reordering beyond a near-tie`);
      }
      notes.push('ordering stays within the 0.01 near-tie epsilon');
      return pass(notes.join(' · '));
    },
  },

  // ─── 260805 round (DO40–DO47) ───────────────────────────────────────────────

  {
    id: 'DO40',
    title: 'Body excerpts carry their section number AND title',
    async run() {
      const data = await search(PROBES.section.query, { contentTypes: ['body'], limit: 20 });
      const excerpts = (data.results || [])
        .filter(r => r.resultType === 'excerpt')
        .flatMap(r => (r.excerpts && r.excerpts.length ? r.excerpts : (r.excerpt ? [r.excerpt] : [])));
      if (excerpts.length === 0) return blocked('the query returned no body excerpts', 'ingest the corpus');

      const sectioned = excerpts.filter(e => e && e.section);
      if (sectioned.length === 0) {
        return blocked(
          `${excerpts.length} excerpt(s), none carrying a section number at all`,
          'the section number comes from the chunker — run npm run ingest',
        );
      }
      const titled = sectioned.filter(e => e.sectionTitle);
      if (titled.length === 0) {
        return blocked(
          `${sectioned.length} excerpt(s) carry a section number but no title`,
          'apply migration 0011 (npm run db:migrate:remote), then re-ingest (npm run ingest) — ' +
          'the titles live in standards.sections_json and only an ingest writes them',
        );
      }
      const withParents = titled.filter(e => (e.sectionPath || []).length > 1);
      const html = await loadIndexHtml();
      if (!/function sectionPathHtml/.test(html.text)) {
        return fail(`the API returns section titles but the page does not render them [${html.source}]`);
      }
      const e = withParents[0] || titled[0];
      return pass(
        `${titled.length}/${sectioned.length} sectioned excerpts carry a title ` +
        `(e.g. ${e.section} ${(e.sectionPath || []).map(p => p.title).join(' › ') || e.sectionTitle})` +
        `, ${withParents.length} with a parent chain [${html.source}]`,
      );
    },
  },

  {
    id: 'DO41',
    title: 'A pasted "Sample Search:" label never reaches the search',
    async run() {
      const labelled = await search(`Sample Search: ${PROBES.comparison.query}`, { limit: 5 });
      if (/^\s*sample\s+search/i.test(labelled.query)) {
        return fail(`the Worker echoed the query with its label intact: "${labelled.query}"`);
      }
      if (!labelled.isVersionComparison) {
        return fail(
          `the label was stripped ("${labelled.query}") but the comparison intent was still lost`,
          'stripQueryLabel must run before isVersionComparisonQuery in handleSearch',
        );
      }
      const html = await loadIndexHtml();
      if (!/function stripQueryLabel/.test(html.text)) {
        return fail(`the Worker strips the label but the search box does not [${html.source}]`);
      }
      return pass(`"Sample Search: …" → "${labelled.query}", still recognised as a version comparison`);
    },
  },

  {
    id: 'DO42',
    title: 'A comparison lists the current edition first, then every prior edition',
    async run() {
      const totals = await loadTotals();
      if (totals && totals.deprecated === 0) {
        return blocked(
          'no deprecated editions are indexed, so there is nothing to list',
          'put the prior-edition PDFs in pdfs/Deprecated Standards/ and run npm run ingest:deprecated',
        );
      }
      await loadStandards();
      const family = PROBES.comparison.family;
      const inFamily = (ctx.standards || []).filter(s =>
        s.id === family || s.id.toUpperCase().startsWith(`${family}-`));
      if (inFamily.length === 0) {
        return blocked(`no ${family} edition is indexed`, `ingest the ${family} PDFs`);
      }

      const data = await comparisonSearch();
      const cards = data.results || [];
      const shown = [...new Set(cards.map(r => r.application?.standard).filter(Boolean))]
        .filter(id => id === family || id.toUpperCase().startsWith(`${family}-`));

      const current = inFamily.filter(s => s.status === 'Active').map(s => s.id);
      const missingCurrent = current.filter(id => !shown.includes(id));
      if (current.length > 0 && missingCurrent.length === current.length) {
        return fail(
          `the current edition (${current.join(', ')}) has no card — only ${shown.join(', ')} were returned`,
          'addMissingEditionCards should add one card per indexed edition of the family',
        );
      }
      const deprecated = inFamily.filter(s => s.status === 'Deprecated').map(s => s.id);
      const missingDeprecated = deprecated.filter(id => !shown.includes(id));

      // Order: the current edition's cards, then prior editions newest → oldest.
      const firstDeprecated = cards.findIndex(r => r.isDeprecated);
      const lastCurrent = cards.reduce((last, r, i) => (r.isDeprecated ? last : i), -1);
      if (firstDeprecated !== -1 && lastCurrent > firstDeprecated) {
        return fail(`a current-edition card appears at #${lastCurrent + 1}, after a deprecated one at #${firstDeprecated + 1}`);
      }

      const notice = data.aiGuideRequiredNotice;
      if (notice && !/Enable Guide/.test(notice)) {
        return fail(`the advisory does not name the "Enable Guide" filter: "${notice}"`);
      }

      const detail = `${shown.length} of ${inFamily.length} indexed ${family} edition(s) have a card ` +
        `(${shown.join(' → ')}), current first`;
      return missingDeprecated.length === 0
        ? pass(detail)
        : fail(`${detail}; missing: ${missingDeprecated.join(', ')}`);
    },
  },

  {
    id: 'DO43',
    title: 'The comparison analyses provisions, not the contributor page',
    async run() {
      const totals = await loadTotals();
      if (totals && totals.deprecated === 0) {
        return blocked('no deprecated editions are indexed', 'npm run ingest:deprecated');
      }
      const data = await comparisonSearch();
      const cmp = data.aiSummary?.comparison;
      if (!cmp) return blocked('the AI summary carried no comparison context', 'AI Guide must be on and reachable');
      if (data.aiSummary?.degraded) return blocked('every AI model attempt failed', 'retry when Workers AI recovers');

      // (a) the CURRENT edition must be the newest Active edition of the family
      await loadStandards();
      const family = PROBES.comparison.family;
      const active = (ctx.active || [])
        .filter(s => s.id === family || s.id.toUpperCase().startsWith(`${family}-`))
        .map(s => s.id)
        .sort();
      if (active.length > 0 && cmp.current && !active.includes(cmp.current.id)) {
        return fail(
          `the comparison calls ${cmp.current.id} current; the indexed Active ${family} edition(s) are ${active.join(', ')}`,
          'the current edition is resolved from D1 in handleSearch — check comparisonFamily/loadFamilyEditions',
        );
      }

      // (b) the prior edition must contribute a real provision, not a roster page
      const deprecatedExcerpts = (data.results || [])
        .filter(r => r.isDeprecated)
        .flatMap(r => (r.excerpts && r.excerpts.length ? r.excerpts : (r.excerpt ? [r.excerpt] : [])))
        .map(e => String(e?.text || ''))
        .filter(t => t.trim().length >= 60);
      if (deprecatedExcerpts.length === 0) {
        return blocked(
          'no prior-edition passage was retrieved (only edition cards)',
          'confirm the prior edition is in the deprecated index (npm run ingest:deprecated)',
        );
      }
      const rosterish = deprecatedExcerpts.filter(t =>
        /\backnowledg|contributors?\b|\bcommittee members\b/i.test(t) ||
        (t.match(/\b[A-Z]\.\s?[A-Z][a-z]{2,}\b/g) || []).length >= 5
      );
      if (rosterish.length === deprecatedExcerpts.length) {
        return fail(
          `all ${deprecatedExcerpts.length} prior-edition passage(s) are front matter (rosters/acknowledgements)`,
          'looksLikeFrontMatter should exclude these from comparison retrieval — re-check the deprecated index coverage',
        );
      }

      // (c) the answer must not present that packaging as a change
      const text = String(data.aiSummary.text || '');
      if (/\b(?:contributors?|acknowledgements?)\b[^.]{0,80}\b(?:new|added|revised|updated)\b/i.test(text)) {
        return fail('the analysis describes a contributor list as new or revised content');
      }
      return pass(
        `current edition resolved to ${cmp.current?.id || '(none)'}; ` +
        `${deprecatedExcerpts.length - rosterish.length}/${deprecatedExcerpts.length} prior-edition passages are provisions`,
      );
    },
  },

  {
    id: 'DO44',
    title: 'Reference chips say the marker is FIRST printed',
    async run() {
      const html = await loadIndexHtml();
      if (!/marker is first printed/.test(html.text)) {
        return fail(`the page still reads "the marker is printed" [${html.source}]`);
      }
      return pass(`the caption reads "the link opens the page where the marker is first printed" [${html.source}]`);
    },
  },

  {
    id: 'DO45',
    title: 'Every result card prints the full designation AND title',
    async run() {
      const seen = new Map(); // resultType → { total, titled, sample }
      for (const [content, type] of Object.entries(TYPE_FOR_CONTENT)) {
        const data = await search(
          content === 'definitions' ? PROBES.definition.term
            : content === 'references' ? PROBES.references.query
              : PROBES.neutral.query,
          { contentTypes: [content], limit: 10 },
        );
        for (const r of (data.results || []).filter(r => r.resultType === type)) {
          const name = String(r.citationName || r.citation || '');
          const stat = seen.get(type) || { total: 0, titled: 0, sample: name };
          stat.total++;
          // A full name is designation + descriptive title, so it carries words
          // beyond the designation token itself.
          if (/[A-Za-z]{4,}/.test(name.replace(/^\S+\s*\S*/, ''))) stat.titled++;
          else stat.sample = name;
          seen.set(type, stat);
        }
      }
      if (seen.size === 0) return blocked('no cards of any kind came back', 'ingest the corpus');

      const short = [...seen.entries()].filter(([, s]) => s.titled < s.total);
      const detail = [...seen.entries()]
        .map(([type, s]) => `${type}: ${s.titled}/${s.total}`).join(', ');
      if (short.length > 0) {
        return blocked(
          `${detail} — e.g. "${short[0][1].sample}" is a designation with no title`,
          'the title comes from standards.title: add a Title/Description column to the Vitrium CSV export ' +
          'and run npm run sync-metadata',
        );
      }
      return pass(`every card carries designation + title (${detail})`);
    },
  },

  {
    id: 'DO46',
    title: 'Table of Contents groups by Category, then by authoring committee',
    async run() {
      const page = await loadTocHtml();
      const required = [
        ['category order', /const CATEGORY_ORDER\s*=\s*\[/],
        ['Lighting Science first', /'Lighting Science',\s*\n\s*'Lighting Practice'/],
        ['author grouping', /function renderAuthorGroups/],
        ['committee hyperlink', /ies\.org\/committee|committee\.url/],
      ];
      const missing = required.filter(([, re]) => !re.test(page.text)).map(([name]) => name);
      if (missing.length > 0) return fail(`the Table of Contents page is missing: ${missing.join(', ')} [${page.source}]`);

      await loadStandards();
      if (ctx.standardsError) {
        return blocked(`the page reads the standards list, and ${ctx.standardsError}`, 'apply the migrations');
      }
      const active = ctx.active || [];
      const withCollection = active.filter(s => s.collection).length;
      const withAuthor = active.filter(s => s.committee?.name || s.author).length;
      if (withCollection === 0 || withAuthor === 0) {
        return blocked(
          `the grouping is implemented, but the data is not there yet: ${withCollection}/${active.length} standards ` +
          `carry a Category and ${withAuthor}/${active.length} carry an Author`,
          'add the Collection and Author columns to the Vitrium CSV export, then run npm run sync-metadata',
        );
      }
      return pass(
        `grouping implemented [${page.source}]; ${withCollection}/${active.length} standards carry a Category ` +
        `and ${withAuthor}/${active.length} an authoring committee`,
      );
    },
  },

  {
    id: 'DO47',
    title: 'Searching a designation returns that document',
    async run() {
      await loadStandards();
      if (ctx.standardsError) {
        return blocked(`the probe needs the standards list, and ${ctx.standardsError}`, 'apply the migrations');
      }
      const target = (ctx.active || []).find(s => /^[A-Z]{1,4}-\d+(?:\.\d+)?-\d{2}/.test(s.id));
      if (!target) return blocked('no active standard is indexed', 'ingest the corpus');

      // The bare edition, without any errata suffix — one of the variations the
      // client listed, and the form the Table of Contents links to.
      const bare = target.id.replace(/\+E\d+$/, '');
      const data = await search(bare, { limit: 10 });
      const first = (data.results || [])[0];
      if (!first) return fail(`a search for "${bare}" returned nothing at all`);
      if (first.resultType !== 'standard') {
        return fail(
          `a search for "${bare}" led with a ${first.resultType} card, not the document itself`,
          'findStandardLookupResults must prepend the document card',
        );
      }
      const doc = first.document || {};
      const gaps = [
        !doc.title && 'title',
        !doc.description && 'description',
        !doc.thumbnailUrl && 'thumbnail',
        !first.committee && 'authoring committee',
      ].filter(Boolean);
      const detail = `"${bare}" → ${doc.designation || doc.id} at the top of the results`;
      return gaps.length === 0
        ? pass(`${detail}, with title, description, thumbnail and committee`)
        : blocked(
            `${detail}, but the card has no ${gaps.join(', ')}`,
            'those fields come from the Vitrium export — run npm run sync-metadata',
          );
    },
  },

  // ─── 260805 round, second half (DO48–DO56) ─────────────────────────────────

  {
    id: 'DO48',
    title: 'Document titles match what the standard prints',
    async run() {
      await loadStandards();
      if (ctx.standardsError) {
        return blocked(`the titles live on the standards list, and ${ctx.standardsError}`, 'apply the migrations');
      }
      const active = ctx.active || [];
      if (active.length === 0) return blocked('no active standards are indexed', 'ingest the corpus');

      // A title equal to the id is the "no title" state that sent citations to
      // the curated fallback, where RP-1-24 was wrong.
      const untitled = active.filter(s => !s.title || s.title === s.id);
      const probe = active.find(s => s.id.toUpperCase().startsWith('RP-1-24'));
      if (untitled.length === active.length) {
        return fail(
          `not one of the ${active.length} standards carries a title — every citation is a bare designation`,
          'the title is read off the cover page at ingest — run npm run ingest',
        );
      }
      if (probe && /commercial interiors/i.test(String(probe.title))) {
        return fail(
          `${probe.id} is still titled "${probe.title}"; its cover reads "Recommended Practice: Lighting Office Spaces"`,
          're-ingest RP-1-24 (npm run ingest) so the cover-derived title replaces the curated one',
        );
      }
      const detail = `${active.length - untitled.length}/${active.length} standards carry a printed title` +
        (probe ? ` (e.g. ${probe.id}: "${probe.title}")` : '');
      return untitled.length === 0
        ? pass(detail)
        : blocked(
            `${detail}; still untitled: ${untitled.slice(0, 5).map(s => s.id).join(', ')}` +
            (untitled.length > 5 ? `, +${untitled.length - 5} more` : ''),
            'those covers could not be read (usually a scanned image) — supply a Title column in the Vitrium ' +
            'CSV export and run npm run sync-metadata',
          );
    },
  },

  {
    id: 'DO49',
    title: 'A shared collection link opens instead of erroring',
    async run() {
      const html = await loadProjectsHtml();
      // The crash was renderProjectDetail reading only `data.project` while the
      // share endpoint answers with `collection`.
      if (!/data\.project \|\| data\.collection/.test(html.text)) {
        return fail(`the page still reads only data.project [${html.source}]`);
      }
      if (!/detail-owner-actions/.test(html.text)) {
        return fail(`a shared collection still shows the owner's actions [${html.source}]`);
      }
      if (!CONFIG.write) {
        return blocked(
          'the page-side fix is present; proving the round trip needs a collection to share',
          're-run with --write (DO37 creates and deletes a throwaway collection)',
        );
      }
      // The write path (DO37) already exercises share → read → claim; this only
      // checks the SHAPE the page depends on.
      const created = await post('/api/projects', { user_id: CONFIG.ownerA, name: 'verify-feedback share probe' });
      const id = created.json?.project?.id;
      try {
        const shared = await post(`/api/projects/${id}/share`);
        const token = shared.json?.share_token;
        const viewed = await get(`/api/projects/shared/${token}`);
        if (!viewed.ok) return fail(`opening the share link → HTTP ${viewed.status}`);
        if (!viewed.json?.collection?.name) {
          return fail(`the share payload carries no collection.name: ${JSON.stringify(viewed.json).slice(0, 160)}`);
        }
        return pass(`the share payload carries collection.name ("${viewed.json.collection.name}") and the page reads it [${html.source}]`);
      } finally {
        if (id) await del(`/api/projects/${id}`).catch(() => {});
      }
    },
  },

  {
    id: 'DO50',
    title: 'The Save Search window takes a user note',
    async run() {
      const html = await loadIndexHtml();
      const required = [
        ['note field', /id="save-note"/],
        ['note travels with the payload', /function pendingWithNote/],
      ];
      const missing = required.filter(([, re]) => !re.test(html.text)).map(([n]) => n);
      return missing.length === 0
        ? pass(`the Save Search modal carries a note field, applied to every item saved [${html.source}]`)
        : fail(`missing ${missing.join(', ')} [${html.source}]`);
    },
  },

  {
    id: 'DO51',
    title: 'The AI disclaimer says the response cannot be saved',
    async run() {
      const data = await search(PROBES.neutral.query, { ai: true, limit: 5 });
      if (!data.aiSummary) return blocked('no AI summary came back', 'Workers AI must be reachable');
      const disclaimer = String(data.aiSummary.disclaimer || '');
      return /cannot be saved to your search collections/i.test(disclaimer)
        ? pass(`"${disclaimer.slice(-60)}"`)
        : fail(`the disclaimer does not mention saving: "${disclaimer}"`);
    },
  },

  {
    id: 'DO52',
    title: 'A shared link is readable without an account',
    async run() {
      const html = await loadProjectsHtml();
      if (!/data-public-when-share/.test(html.text)) {
        return fail(`the collections page still hides itself from a signed-out visitor [${html.source}]`);
      }
      if (!CONFIG.write) {
        return blocked(
          'the page-side fix is present; proving the endpoint is open needs a collection to share',
          're-run with --write',
        );
      }
      const created = await post('/api/projects', { user_id: CONFIG.ownerA, name: 'verify-feedback public probe' });
      const id = created.json?.project?.id;
      try {
        const shared = await post(`/api/projects/${id}/share`);
        const token = shared.json?.share_token;
        // No Authorization header and no cookie — exactly a non-subscriber
        // opening the link.
        const anonymous = await fetch(`${CONFIG.apiUrl}/api/projects/shared/${token}`);
        if (anonymous.status === 401 || anonymous.status === 403) {
          return fail(`an anonymous read of the share link answered HTTP ${anonymous.status}`);
        }
        if (!anonymous.ok) return fail(`an anonymous read answered HTTP ${anonymous.status}`);
        // …and nothing else under /api/projects may be.
        const listed = await fetch(`${CONFIG.apiUrl}/api/projects?user_id=1`);
        if (listed.ok) {
          return fail('anonymous access is not limited to the shared route — /api/projects also answered');
        }
        return pass(`the shared route answers anonymously (HTTP ${anonymous.status}); /api/projects still requires a session (HTTP ${listed.status})`);
      } finally {
        if (id) await del(`/api/projects/${id}`).catch(() => {});
      }
    },
  },

  {
    id: 'DO53',
    title: 'LensyLite is wired end to end (and off until IES says otherwise)',
    async run() {
      const html = await loadIndexHtml();
      const required = [
        ['tier handling', /function applyTier/],
        ['locked tools', /LITE_LOCKED_FILTERS\s*=\s*\['tables', 'guide', 'compare'\]/],
        ['LensyLite wordmark', /'LensyLite'/],
        ['upgrade banner', /lite-banner/],
      ];
      const missing = required.filter(([, re]) => !re.test(html.text)).map(([n]) => n);
      if (missing.length > 0) return fail(`the page is missing: ${missing.join(', ')} [${html.source}]`);

      // The Worker's answer says which tier served the search.
      const data = await search(PROBES.neutral.query, { limit: 5 });
      if (!data.tier) {
        return fail('the search response carries no `tier` — the Worker is not resolving access tiers');
      }
      if (data.tier === 'lite') {
        const tables = (data.results || []).filter(r => r.resultType === 'application');
        if (tables.length > 0) {
          return fail(`a LensyLite search returned ${tables.length} Illuminance Table row(s) — the tier must exclude them`);
        }
        return pass('LensyLite is ON for this credential and its exclusions hold');
      }
      return pass(
        `implemented and currently OFF (this search ran as "${data.tier}") — ` +
        'set LENSY_LITE=on with LENSY_SUBSCRIBER_ROLES once the IdP publishes the subscription role',
      );
    },
  },

  {
    id: 'DO54',
    title: 'Definition cards can be saved',
    async run() {
      const html = await loadIndexHtml();
      if (!/function saveSearchButton/.test(html.text)) {
        return fail(`the save button is still built inline in actionsCluster only [${html.source}]`);
      }
      // The definition card must call it — that is the whole item.
      if (!/saveSearchButton\(result, def\.term/.test(html.text)) {
        return fail(`renderDefinitionCard does not offer "+ Save Search" [${html.source}]`);
      }
      if (!/standard: 'body'/.test(html.text) || !/definition: 'definitions'/.test(html.text)) {
        return fail(`the saveable-type map no longer covers every card kind [${html.source}]`);
      }
      return pass(`Definition cards offer the same "+ Save Search" button as every other card [${html.source}]`);
    },
  },

  {
    id: 'DO55',
    title: 'A collection can be sorted and filtered',
    async run() {
      const html = await loadProjectsHtml();
      const required = [
        ['sort control', /id="item-sort"/],
        ['sort by date and type', /itemSort === 'oldest'/],
        ['card-type filter', /itemTypeFilter/],
        ['document chips', /Narrow to:/],
      ];
      const missing = required.filter(([, re]) => !re.test(html.text)).map(([n]) => n);
      return missing.length === 0
        ? pass(`the collection view sorts by date and card type and filters by both kind and document [${html.source}]`)
        : fail(`missing ${missing.join(', ')} [${html.source}]`);
    },
  },

  {
    id: 'DO56',
    title: 'Collection labels match the search filters',
    async run() {
      const html = await loadProjectsHtml();
      // The LABEL, not a mention of it: the comment that records the change
      // names the old wording on purpose.
      if (/(?:body:|>)\s*'?Documents (?:&|&amp;) Annexes/.test(html.text)) {
        return fail(`the collection view still labels body items "Documents & Annexes" [${html.source}]`);
      }
      if (!/body: 'Documents'/.test(html.text)) {
        return fail(`the body label is not "Documents" [${html.source}]`);
      }
      return pass(`body items are labelled "Documents", exactly as the search filter spells it [${html.source}]`);
    },
  },
];

// ─── Runner ───────────────────────────────────────────────────────────────────

async function preflight() {
  const lines = [];
  // Reachability + auth, before 20 searches fail one at a time. Probed on the
  // per-id route: it selects `*`, so unlike the list route it cannot 500 merely
  // because a migration is behind the deployed Worker.
  let res;
  try {
    res = await get('/api/standards/__preflight__');
  } catch (err) {
    console.error(`\n✗ ${CONFIG.apiUrl} is not reachable: ${err.message}`);
    console.error(CONFIG.apiUrl.includes('localhost')
      ? '  Start the Worker with `npm run dev`, or point at production with LUCIUS_API_URL.\n'
      : '  Check LUCIUS_API_URL.\n');
    process.exit(1);
  }
  if (res.status === 401 || res.status === 403) {
    console.error(`\n✗ ${CONFIG.apiUrl} rejected the credential (HTTP ${res.status}).`);
    console.error('  LUCIUS_API_SECRET must match the value set with `wrangler secret put LUCIUS_API_SECRET`.\n');
    process.exit(1);
  }
  if (res.status !== 404 && !res.ok) {
    console.error(`\n✗ /api/standards/:id → HTTP ${res.status}: ${res.json?.error || res.text.slice(0, 160)}\n`);
    process.exit(1);
  }

  const totals = await loadTotals();
  await loadStandards();
  if (totals) {
    lines.push(`corpus:      ${totals.active} active + ${totals.deprecated} deprecated standard(s), ` +
      `${totals.totalChunks} chunks, ${totals.totalApplicationRows} application rows`);
  } else if (ctx.standards) {
    lines.push(`corpus:      ${ctx.active.length} active + ${ctx.standards.length - ctx.active.length} deprecated standard(s)`);
  } else {
    lines.push('corpus:      unknown (neither the standards list nor the admin index-status answered)');
  }

  const mig = await migration0010Applied();
  lines.push(`migration:   0010 ${mig === true ? 'applied' : mig === false ? 'NOT APPLIED' : 'undetermined'}`);
  // The most consequential state this script can find: the Worker is ahead of
  // the schema, so an endpoint that worked before the deploy is now broken.
  if (ctx.standardsError) {
    lines.push(`⚠ BROKEN:    ${ctx.standardsError}.`);
    lines.push('             The standards list and the Table of Contents page are down until the');
    lines.push('             migration is applied. Everything reading it is BLOCKED below.');
  }
  lines.push(`write mode:  ${CONFIG.write ? 'on (DO37 will create and delete throwaway collections)' : 'off (DO37 limited to a schema probe)'}`);
  if (CONFIG.apiUrl.includes('localhost')) {
    lines.push('note:        local Workers have no Vectorize binding — search checks will report the 500 as BLOCKED');
  }
  return lines;
}

async function main() {
  const selected = CONFIG.only.length
    ? CHECKS.filter(c => CONFIG.only.includes(c.id.toUpperCase()))
    : CHECKS;
  if (selected.length === 0) {
    console.error(`\n✗ --only matched no checks. Available: ${CHECKS.map(c => c.id).join(', ')}\n`);
    process.exit(1);
  }

  if (!CONFIG.json) {
    console.log(`\nLensy — client feedback acceptance check`);
    console.log(`${CONFIG.apiUrl}`);
    console.log('─'.repeat(78));
  }
  const pre = await preflight();
  if (!CONFIG.json) {
    for (const l of pre) console.log(`  ${l}`);
    console.log('─'.repeat(78) + '\n');
  }

  const outcomes = [];
  for (const check of selected) {
    let outcome;
    try {
      outcome = await check.run();
    } catch (err) {
      // A search that 500s says nothing about the fix — say so instead of
      // claiming the item is broken.
      outcome = err.status === 500
        ? blocked(`the endpoint errored: ${err.message}`, 'the Worker must answer this request (locally, Vectorize has no binding)')
        : fail(err.message);
    }
    outcomes.push({ id: check.id, title: check.title, ...outcome });

    if (!CONFIG.json) {
      const mark = outcome.state === PASS ? '✓' : outcome.state === FAIL ? '✗' : '?';
      console.log(`${mark} ${check.id.padEnd(8)} ${check.title}`);
      if (outcome.state !== PASS || CONFIG.verbose) {
        console.log(`           ${outcome.evidence}`);
        if (outcome.fix) console.log(`           → ${outcome.fix}`);
        if (outcome.needs) console.log(`           needs: ${outcome.needs}`);
      }
    }
  }

  const failed = outcomes.filter(o => o.state === FAIL);
  const blockedItems = outcomes.filter(o => o.state === BLOCKED);
  const passed = outcomes.filter(o => o.state === PASS);

  if (CONFIG.json) {
    console.log(JSON.stringify({
      apiUrl: CONFIG.apiUrl,
      checked: outcomes.length,
      passed: passed.length,
      failed: failed.length,
      blocked: blockedItems.length,
      outcomes,
    }, null, 2));
  } else {
    console.log('\n' + '─'.repeat(78));
    console.log(`${passed.length} pass · ${failed.length} fail · ${blockedItems.length} blocked   (of ${outcomes.length} items checked)`);
    if (failed.length > 0) {
      console.log(`\n✗ FAILED: ${failed.map(f => f.id).join(', ')}`);
      console.log('  These are the ones to fix before signing anything off.');
    }
    if (blockedItems.length > 0) {
      console.log(`\n? BLOCKED: ${blockedItems.map(f => f.id).join(', ')}`);
      console.log('  Not failures — each needs an input that is not here yet:');
      for (const b of blockedItems) console.log(`    ${b.id.padEnd(8)} ${b.needs}`);
    }
    if (failed.length === 0 && blockedItems.length === 0) {
      console.log('\n✓ Every checked feedback item is live and behaving. Safe to sign off.');
    }
    console.log('');
  }

  process.exitCode = failed.length > 0 ? 1 : 0;
}

main().catch(err => {
  console.error(`\n✗ ${err.stack || err.message}\n`);
  process.exit(1);
});
