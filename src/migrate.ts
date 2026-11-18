/**
 * One-time adoption of state written by the builds this fork continues from.
 *
 * WHAT CHANGED
 *
 * The lineage is now three names deep, and this module exists to walk a user
 * forward across the last step of it:
 *
 *   dsh-workbuddy-xdpool   ->  dsh-xdpool  ->  dsh-onepool   (this fork)
 *   ~/.dsh/.workbuddy-xdpool -> ~/.dsh/.xdpool -> ~/.dsh/.onepool
 *
 * Upstream did the first hop in its own 2.1.0 and kept `.workbuddy-xdpool` as
 * its LEGACY constant. This fork adds the second hop, so the directory a real
 * user actually has on disk TODAY is `.xdpool` — the upstream one, holding every
 * account the desktop app ever signed in. `.workbuddy-xdpool` is two renames
 * stale and, on any machine that has run a recent version, does not exist.
 *
 * WHY THE ORDER MATTERS
 *
 * Adoption copies from ONE source directory and never merges two. If `.onepool`
 * already exists it is authoritative and nothing is copied at all. So the chain
 * has to be walked newest-first: `.xdpool` (what 2.x wrote) before
 * `.workbuddy-xdpool` (what 1.x wrote). Getting this backwards would make the
 * fork look like a fresh install to every user who upgraded past 2.1.0 —
 * silently losing:
 *
 *   - the API keys typed into the aggregate page,
 *   - the account ignore list,
 *   - the preferred account,
 *   - the startup trace.
 *
 * NONE OF THAT IS RECONSTRUCTIBLE. The keys are the user's own credentials for
 * third-party vendors; nothing upstream can hand them back. So the old
 * directory is COPIED, never moved and never deleted — a downgrade, or a user
 * who keeps both builds side by side, must still find the original intact.
 *
 * WHY COPY AND NOT RENAME
 *
 * A rename would be atomic and cheaper, and it is the wrong choice: if the
 * upgrade is later rolled back, or if both builds run on one machine, the older
 * build would find its directory gone. Copying costs a few kilobytes and leaves
 * both halves working.
 *
 * WHAT THIS DELIBERATELY DOES NOT TOUCH
 *
 * Two other things carry an old name, and neither can be migrated from inside
 * the plugin:
 *
 *   1. `settings.yaml`'s `agent-default-model.provider` and the profile's
 *      `cordis.patch.yml`, which pin the user's default model to a provider id.
 *      Those files belong to the host profile, not to this plugin, and writing
 *      them from here would be the plugin editing its own loader config. The
 *      plugin logs the exact rename instead — see `describeProviderIdRename`.
 *   2. The old settings namespace's saved values. The host resolves those by
 *      namespace, and the plugin only ever sees the new one.
 *
 * @module dsh-onepool/migrate
 */
import { cpSync, existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
/**
 * Directories earlier builds wrote, newest first.
 *
 * `.xdpool` is the immediate predecessor (upstream 2.x) and is what nearly
 * every existing install has. `.workbuddy-xdpool` is the one before it
 * (upstream 1.x) and is kept so a user two upgrades behind is not stranded.
 */
export const LEGACY_DATA_DIR_NAMES = ['.xdpool', '.workbuddy-xdpool'] as const
/**
 * The directory an install from four years of history is most likely to have.
 *
 * Kept as a single constant because tests and log lines want to name "the"
 * legacy directory; the plural is what adoption walks.
 */
export const LEGACY_DATA_DIR_NAME = LEGACY_DATA_DIR_NAMES[0]
/** Directory it writes now. */
export const CURRENT_DATA_DIR_NAME = '.onepool'
/** Provider ids before this fork, and what each became. */
export const PROVIDER_ID_RENAMES: Readonly<Record<string, string>> = Object.freeze({
  'workbuddy-xdpool': 'onepool',
  'workbuddy-xdpool-global': 'onepool-global',
  'workbuddy-xdpool-aggregate': 'onepool-aggregate',
  'workbuddy-xdpool-free': 'onepool-free',
  'xdpool': 'onepool',
  'xdpool-global': 'onepool-global',
  'xdpool-aggregate': 'onepool-aggregate',
  'xdpool-free': 'onepool-free',
})
/** Result of an adoption attempt, for the caller to log. */
export interface MigrationResult {
  /** True when files were actually copied this run. */
  adopted: boolean
  /** Absolute path the state was copied from, when it existed. */
  from?: string
  /** Absolute path it was copied to. */
  to: string
  /** File names copied, sorted. Empty when nothing was adopted. */
  files: string[]
  /** Why adoption did not happen, when it did not. */
  skipped?: 'no-legacy-dir' | 'already-migrated' | 'legacy-empty' | 'failed'
}
/** The DSH home, honouring the same override the rest of the plugin uses. */
function dshHome(env: NodeJS.ProcessEnv): string {
  const fromEnv = env['DSH_HOME']
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  return join(homedir(), '.dsh')
}
/**
 * Copy the pre-rename data directory into the current one, once.
 *
 * Idempotent and safe to call on every startup:
 *
 *   - no legacy directory  -> nothing to do,
 *   - current directory already exists -> do not touch it, because it may hold
 *     newer state than the legacy one and merging the two would resurrect
 *     values the user has since changed,
 *   - legacy directory empty -> nothing worth copying.
 *
 * Individual files are copied only when the destination does not already have
 * that name, so a partially-populated new directory still gains whatever it is
 * missing without any file being overwritten.
 *
 * Never throws: a failed adoption must not stop the plugin from starting. The
 * caller logs the returned reason.
 */
export function adoptLegacyDataDir(env: NodeJS.ProcessEnv = process.env): MigrationResult {
  const home = dshHome(env)
  const to = join(home, CURRENT_DATA_DIR_NAME)
  // Newest legacy name that actually exists. `.xdpool` is the immediate
  // predecessor; `.workbuddy-xdpool` is only reached on a machine that never
  // ran a 2.x build.
  const source = LEGACY_DATA_DIR_NAMES
    .map(name => join(home, name))
    .find(dir => existsSync(dir))
  if (source === undefined) return { adopted: false, to, files: [], skipped: 'no-legacy-dir' }
  const from = source
  let legacyNames: string[]
  try {
    legacyNames = readdirSync(from).filter(name => {
      try {
        return statSync(join(from, name)).isFile()
      } catch {
        return false
      }
    })
  } catch {
    return { adopted: false, to, files: [], skipped: 'failed' }
  }
  if (legacyNames.length === 0) return { adopted: false, from, to, files: [], skipped: 'legacy-empty' }
  const copied: string[] = []
  try {
    for (const name of legacyNames) {
      const target = join(to, name)
      // Already there: the new directory is authoritative for that name.
      if (existsSync(target)) continue
      cpSync(join(from, name), target)
      copied.push(name)
    }
  } catch {
    // A copy that fails halfway still leaves the files that did land, and the
    // legacy directory is untouched either way. Report what actually happened.
    return {
      adopted: copied.length > 0,
      from,
      to,
      files: copied.sort(),
      ...(copied.length === 0 ? { skipped: 'failed' as const } : {}),
    }
  }
  if (copied.length === 0) return { adopted: false, from, to, files: [], skipped: 'already-migrated' }
  return { adopted: true, from, to, files: copied.sort() }
}
/**
 * The one-line instruction for a user whose default model is still pinned to a
 * pre-rename provider id.
 *
 * This is deliberately a message and not an edit. The pin lives in the host
 * profile's own `settings.yaml` / `cordis.patch.yml`; rewriting those from
 * inside the plugin would mean the plugin editing the loader config that mounts
 * it, which is exactly the kind of self-modifying setup that turns a rename into
 * an unbootable install. Naming the file and the replacement is the honest
 * middle ground: the plugin cannot silently fix it, and the user can in one
 * edit.
 */
export function describeProviderIdRename(): string {
  const pairs = Object.entries(PROVIDER_ID_RENAMES)
    .map(([before, after]) => `${before} -> ${after}`)
    .join(', ')
  return 'provider ids renamed (' + pairs + '); if your default model was pinned to an old id, '
    + 'update "agent-default-model.provider" in the profile settings.yaml and any matching row in cordis.patch.yml'
}
