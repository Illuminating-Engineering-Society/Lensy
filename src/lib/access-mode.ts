/**
 * Who may sign in to IES Lens right now (2026-10-08).
 *
 * Two modes:
 *  - `open`        the ordinary door (decideAccess in lib/sso.ts as before);
 *  - `staff_only`  only IES staff: an IdP `administrator`, or an invite row
 *                  with role 'admin' or 'staff'. Everyone else — members,
 *                  subscribers, guests, visitors — is answered `staff_only`.
 *
 * The mode is a staff switch on the /admin Users tab, stored in KV
 * (`access-mode:<prod|stg>`, so staging and production toggle apart). With no
 * KV record the `LENSY_ACCESS_MODE` var decides, and with no var the door is
 * `open`. A KV read error also falls back to the var — unlike the session cap,
 * this IS an access boundary, so a KV hiccup must not silently reopen a
 * locked-down deployment.
 *
 * The bearer secret (scripts, cron) is never affected: it does not go through
 * decideAccess at all.
 */

export type AccessMode = 'open' | 'staff_only';

export const ACCESS_MODES: readonly AccessMode[] = ['open', 'staff_only'];

/** Invite-row roles that count as staff under `staff_only`. */
export const STAFF_INVITE_ROLES: readonly string[] = ['admin', 'staff'];

export interface AccessModeRecord {
  mode: AccessMode;
  updatedBy: string | null;
  updatedAt: string | null;
}

export interface AccessModeState extends AccessModeRecord {
  /** Where the effective mode came from. */
  source: 'dashboard' | 'default';
  /** What the deployment falls back to without a dashboard choice. */
  defaultMode: AccessMode;
}

type Scope = 'prod' | 'stg';

const keyFor = (scope: Scope) => `access-mode:${scope}`;

export function parseAccessMode(value: unknown): AccessMode | null {
  const v = String(value ?? '').trim().toLowerCase().replace(/[-\s]/g, '_');
  return (ACCESS_MODES as readonly string[]).includes(v) ? (v as AccessMode) : null;
}

export function defaultAccessMode(env: Env): AccessMode {
  return parseAccessMode(env.LENSY_ACCESS_MODE) ?? 'open';
}

/**
 * The effective mode. `fresh` skips the edge cache — the dashboard reads its
 * own write back; request gates accept up to a minute of staleness, which is
 * KV's cross-edge propagation anyway.
 */
export async function readAccessMode(
  env: Env,
  scope: Scope,
  opts: { fresh?: boolean } = {},
): Promise<AccessModeState> {
  const defaultMode = defaultAccessMode(env);
  try {
    const raw = await env.SESSIONS.get(
      keyFor(scope),
      opts.fresh ? undefined : { cacheTtl: 60 },
    );
    if (raw) {
      const rec = JSON.parse(raw) as Partial<AccessModeRecord>;
      const mode = parseAccessMode(rec.mode);
      if (mode) {
        return {
          mode,
          updatedBy: rec.updatedBy ?? null,
          updatedAt: rec.updatedAt ?? null,
          source: 'dashboard',
          defaultMode,
        };
      }
    }
  } catch (err) {
    console.error('access_mode_read_failed', { error: String(err) });
  }
  return { mode: defaultMode, updatedBy: null, updatedAt: null, source: 'default', defaultMode };
}

export async function writeAccessMode(
  env: Env,
  scope: Scope,
  mode: AccessMode,
  updatedBy: string | null,
): Promise<AccessModeRecord> {
  const record: AccessModeRecord = { mode, updatedBy, updatedAt: new Date().toISOString() };
  await env.SESSIONS.put(keyFor(scope), JSON.stringify(record));
  return record;
}
