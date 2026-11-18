/**
 * Installing a newer build of this plugin.
 *
 * HOW THE HOST UPDATES A PLUGIN
 *
 * There is no install API to call. A profile's `package.json` names each plugin by a spec, and
 * the host resolves that spec when it starts — so "update" means "change the spec, then restart".
 * That is the whole mechanism, and it is what every plugin that self-updates is really doing.
 *
 * WHAT THIS DOES
 *
 * A newer version is downloaded from the npm registry to a local file, and the profile's
 * dependency is pointed at it with a `file:` spec. On the next start the host installs from that
 * file. Nothing is written outside the profile's own directory, and nothing is changed if the
 * download fails — a half-applied update is worse than an unapplied one.
 *
 * THE LOCKFILE IS PART OF THE UPDATE
 *
 * DSH installs profile dependencies with `pnpm install --frozen-lockfile` whenever the profile
 * has a `pnpm-lock.yaml` (see the host's dsh-plugin-manager: `hadLockfile ? '--frozen-lockfile'`).
 * Changing only `package.json` leaves the lockfile naming the OLD spec, so on restart pnpm aborts
 * with ERR_PNPM_OUTDATED_LOCKFILE and the host restores the previous package — the update appears
 * to install, the panel even says "restart to apply", and the running version never changes.
 * So after writing `package.json` we refresh the lockfile with `pnpm install --lockfile-only`.
 * A failed refresh is reported as a failed install rather than a false success: a lockfile that
 * still names the old build is the same as no update at all.
 *
 * WHY `file:` AND NOT THE PUBLISHED VERSION
 *
 * Naming the version (`"dsh-onepool": "2.7.5"`) makes the host fetch from the registry on every
 * start, which fails on a machine whose registry is proxied or slow — and the failure mode is a
 * plugin that does not load. Pinning the tarball that was just verified to download keeps the
 * update as local as the install it replaces.
 *
 * A RESTART IS REQUIRED, AND SAYS SO
 *
 * Modules already loaded cannot be swapped in place. The panel reports `restartRequired` and the
 * user restarts when convenient — claiming the update took effect immediately would be a lie the
 * user discovers on the next crash.
 *
 * @module dsh-onepool/update-install
 */
import { spawnSync } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { checkForUpdate } from './update-check.ts'

/** The package this plugin publishes under. */
const PACKAGE = 'dsh-onepool'

/**
 * The lockfile refresh, as a synchronous spawn so the result is known before we answer the route.
 *
 * A transport-shaped interface rather than a direct `spawnSync` call so tests can assert the exact
 * argv and simulate a failure without touching a real profile. Production passes `pnpm` from PATH
 * — the same command DSH's plugin manager uses, so the lockfile is written by the same pnpm that
 * will later consume it with `--frozen-lockfile`.
 */
export type LockfileRefresher = (options: {
  cwd: string
  args: readonly string[]
}) => { status: number | null; stdout?: string; stderr?: string; error?: string }

const defaultRefresher: LockfileRefresher = ({ cwd, args }) => {
  const command = process.env['DSH_PNPM'] ?? 'pnpm'
  const result = spawnSync(command, [...args], {
    cwd,
    env: process.env,
    encoding: 'utf8',
    // The lockfile refresh is local (the tarball is already on disk) and bounded; this keeps a
    // hung pnpm from pinning the install route forever.
    timeout: 120_000,
  })
  return {
    status: result.status,
    ...typeof result.stdout === 'string' ? { stdout: result.stdout } : {},
    ...typeof result.stderr === 'string' ? { stderr: result.stderr } : {},
    ...result.error === undefined ? {} : { error: result.error.message },
  }
}

/** Args that make pnpm rewrite ONLY the lockfile, running no lifecycle scripts. */
const LOCKFILE_ARGS = ['install', '--lockfile-only', '--ignore-scripts'] as const

/**
 * Refresh a profile's `pnpm-lock.yaml` after its `package.json` spec changed.
 *
 * Returned `error` is a human sentence ready for the card; `undefined` means the lockfile is in
 * sync (or there was no lockfile to sync). Kept as its own exported unit so the behaviour that
 * decides "did the update land" is testable without downloading a real tarball.
 */
export function refreshProfileLockfile(
  profile: string,
  refresh: LockfileRefresher = defaultRefresher,
): string | undefined {
  // A profile DSH created without a lockfile is installed with --config.lockfile=false, so there
  // is nothing to refresh and pnpm must not be asked to create one here.
  if (!existsSync(join(profile, 'pnpm-lock.yaml'))) return undefined
  let result: ReturnType<LockfileRefresher>
  try {
    result = refresh({ cwd: profile, args: [...LOCKFILE_ARGS] })
  } catch (error: unknown) {
    return `刷新依赖锁文件失败：${error instanceof Error ? error.message : String(error)}`
  }
  const detail = (result.stderr || result.stdout || result.error || '').trim().slice(0, 400)
  if (result.status !== 0) {
    return `刷新依赖锁文件失败（${String(result.status)}）：${detail}`
  }
  return undefined
}

/** The profile directory whose `package.json` names this plugin. */
function profileDir(): string | undefined {
  // The host sets this for plugins it loaded from a profile; the environment is the only way a
  // plugin can learn where its own spec lives.
  const candidates = [
    process.env['DSH_PROFILE_DIR'],
    process.env['DSH_HOME'] === undefined ? undefined : join(process.env['DSH_HOME'], 'profiles', 'desktop'),
    join(homedir(), '.dsh', 'profiles', 'desktop'),
  ]
  for (const candidate of candidates) {
    if (candidate === undefined) continue
    if (existsSync(join(candidate, 'package.json'))) return candidate
  }
  return undefined
}

/** What an install attempt produced. */
export interface InstallResult {
  ok: boolean
  /** The version written into the profile, when it landed. */
  version?: string
  /** Where the tarball was saved. */
  path?: string
  /** Whether a restart is needed for it to take effect. */
  restartRequired: boolean
  /** Why it did not land. */
  error?: string
}

/**
 * Download a version and point the profile at it.
 *
 * The order matters: download first, verify it is a gzip tarball, and only then touch
 * `package.json`. A failed download must leave a working install alone.
 */
export async function installVersion(version: string, refreshLockfile: LockfileRefresher = defaultRefresher): Promise<InstallResult> {
  const profile = profileDir()
  if (profile === undefined) {
    return {
      ok: false,
      restartRequired: false,
      error: '找不到插件所在的 profile 目录，无法自动更新；请在 DSH 的插件设置里更新',
    }
  }
  const target = join(tmpdir(), `${PACKAGE}-${version}.tgz`)
  try {
    const response = await fetch(`https://registry.npmjs.org/${PACKAGE}/-/${PACKAGE}-${version}.tgz`, {
      signal: AbortSignal.timeout(120_000),
    })
    if (!response.ok || response.body === null) {
      return { ok: false, restartRequired: false, error: `下载失败：HTTP ${String(response.status)}` }
    }
    mkdirSync(dirname(target), { recursive: true })
    const partial = `${target}.part`
    const sink = createWriteStream(partial)
    // Streamed rather than buffered: the package is a few megabytes and there is no reason to
    // hold all of it to write it back out.
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      sink.write(chunk)
    }
    await new Promise<void>((resolve, reject) => {
      sink.end(() => { resolve() })
      sink.on('error', reject)
    })
    // A gzip member starts with 1f 8b. Checking here is what keeps a proxy's HTML error page
    // from being installed as a plugin.
    const head = readFileSync(partial).subarray(0, 2)
    if (head[0] !== 0x1f || head[1] !== 0x8b) {
      rmSync(partial, { force: true })
      return { ok: false, restartRequired: false, error: '下载到的不是压缩包（可能被代理拦截）' }
    }
    renameSync(partial, target)
  } catch (error: unknown) {
    return {
      ok: false,
      restartRequired: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }

  try {
    const pkgPath = join(profile, 'package.json')
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as Record<string, unknown>
    let changed = false
    for (const key of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      const block = pkg[key]
      if (block === null || typeof block !== 'object') continue
      const record = block as Record<string, unknown>
      if (!Object.hasOwn(record, PACKAGE)) continue
      record[PACKAGE] = `file:${target.replaceAll('\\', '/')}`
      changed = true
    }
    if (!changed) {
      return {
        ok: false,
        restartRequired: false,
        path: target,
        error: `profile 的 package.json 里没有 ${PACKAGE}，无法自动更新`,
      }
    }
    writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8')

    // A profile with a lockfile is installed with --frozen-lockfile on the next start. If the
    // lockfile still names the old spec, that start fails and the host restores everything — so
    // the update would silently never land. Refresh it now, and refuse to claim success if it
    // fails.
    const lockError = refreshProfileLockfile(profile, refreshLockfile)
    if (lockError !== undefined) {
      return { ok: false, restartRequired: false, path: target, error: lockError }
    }
    return { ok: true, version, path: target, restartRequired: true }
  } catch (error: unknown) {
    return {
      ok: false,
      restartRequired: false,
      path: target,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * Check, then install if there is something newer.
 *
 * Kept together so the route cannot install a version the check never saw — the alternative is a
 * caller passing an arbitrary version string to an endpoint that writes `package.json`.
 */
export async function updateToLatest(refreshLockfile: LockfileRefresher = defaultRefresher): Promise<InstallResult> {
  const status = await checkForUpdate({ force: true })
  if (status.error !== undefined) return { ok: false, restartRequired: false, error: status.error }
  if (status.latest === undefined) return { ok: false, restartRequired: false, error: '没有读到最新版本号' }
  if (!status.newer) {
    return { ok: true, version: status.current, restartRequired: false }
  }
  return await installVersion(status.latest, refreshLockfile)
}
