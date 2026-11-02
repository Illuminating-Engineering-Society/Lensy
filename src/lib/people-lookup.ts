/**
 * IES account numbers for the search-usage export (Dan, 2026-11-02: "IES ID
 * (account number) would help long-term analytics").
 *
 * The ies_auth cookie carries no member number, so the export asks AuthIES
 * (POST /api/people/lookup, bearer PEOPLE_LOOKUP_API_SECRET) for the
 * person_uuids it holds, in batches. Fail-soft: an unset secret, an error or a
 * partial answer leaves those ids out of the map — the export still downloads,
 * with the column blank. Organization (Sustaining Member) is the planned
 * second field once AuthIES stores it.
 */

import { resolveIdpBaseUrl } from './sso';

const BATCH = 500;

/** person_uuid (lowercase) → member number, for whatever AuthIES could answer. */
export async function lookupMemberNumbers(
  env: Env,
  requestUrl: string,
  personUuids: Array<string | null | undefined>,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const secret = (env.PEOPLE_LOOKUP_API_SECRET || '').trim();
  const ids = [...new Set(personUuids.filter((v): v is string => !!v).map(v => v.toLowerCase()))];
  if (!secret || ids.length === 0) return out;

  for (let i = 0; i < ids.length; i += BATCH) {
    try {
      const res = await fetch(`${resolveIdpBaseUrl(env, requestUrl)}/api/people/lookup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
        body: JSON.stringify({ person_uuids: ids.slice(i, i + BATCH) }),
      });
      if (!res.ok) {
        console.error('people lookup failed (non-fatal):', res.status);
        continue;
      }
      const data = (await res.json()) as { people?: Record<string, { member_number?: unknown }> };
      for (const [uuid, p] of Object.entries(data.people ?? {})) {
        if (typeof p?.member_number === 'string' && p.member_number) out.set(uuid.toLowerCase(), p.member_number);
      }
    } catch (err) {
      console.error('people lookup failed (non-fatal):', err instanceof Error ? err.message : String(err));
    }
  }
  return out;
}
