/**
 * Help pages — the Worker half of src/lib/help-pages.ts (Dan, Teams 11/12/26 #5).
 *
 * The daily cron and Admin both rebuild the help index here: the tutorials
 * come from the catalogue the /tutorials page itself renders, with the titles
 * and summaries staff edited in Admin → Maintenance → Tutorials applied.
 *
 *   GET  /api/admin/help-pages          — the stored index's status
 *   POST /api/admin/help-pages/refresh  — rebuild it now
 */

import { requireAdminAccess } from './session';
import { readTutorialOverrides } from './tutorials';
import {
  refreshHelpIndex, loadHelpIndex, tutorialEntries, HELP_PAGES,
  type HelpIndex, type TutorialCatalogueSection,
} from '../lib/help-pages';
// A classic browser script: importing it registers globalThis.LENS_TUTORIALS.
import '../frontend/utils/tutorials-catalogue.js';

function catalogue(): TutorialCatalogueSection[] {
  const list = (globalThis as { LENS_TUTORIALS?: unknown }).LENS_TUTORIALS;
  return Array.isArray(list) ? list as TutorialCatalogueSection[] : [];
}

/** Rebuild the help index (cron + Admin). Never throws. */
export async function runHelpIndexRefresh(env: Env): Promise<HelpIndex> {
  const overrides = await readTutorialOverrides(env).catch(() => ({}));
  return refreshHelpIndex(env, tutorialEntries(catalogue(), overrides));
}

function summary(index: HelpIndex | null) {
  return {
    refreshedAt: index?.refreshedAt ?? null,
    entries: index?.entries.length ?? 0,
    pages: index?.pages ?? HELP_PAGES.map(p => ({
      page: p.key, url: p.url, ok: false, entries: 0, detail: 'Not indexed yet.',
    })),
  };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

export async function handleAdminHelpPages(request: Request, env: Env, refresh: boolean): Promise<Response> {
  const denied = await requireAdminAccess(request, env);
  if (denied) return denied;
  if (refresh) {
    if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
    return json(summary(await runHelpIndexRefresh(env)));
  }
  return json(summary(await loadHelpIndex(env)));
}
