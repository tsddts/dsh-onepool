/**
 * Whether a newer build of this plugin exists.
 *
 * WHY IT LIVES IN THE PLUGIN
 *
 * Updating meant watching the repository by hand or asking an agent to check — neither is
 * something a user should have to do to stay current. A version read on demand answers the only
 * question worth asking ("is there something newer than what I run?") without a background task
 * that phones home on its own schedule.
 *
 * WHERE THE ANSWER COMES FROM
 *
 * This fork publishes on GitHub Releases, NOT on npm: the package name `dsh-onepool` does not
 * exist in the npm registry (the upstream `dsh-xdpool` does). Reading npm here used to return 404
 * for every check, which the old code reported as "offline / proxy blocked" — a false error on a
 * perfectly connected machine. So the GitHub releases API is the canonical source; npm is kept as
 * a fallback for builds that ARE published there.
 *
 * A FAILURE IS AN ORDINARY ANSWER
 *
 * A machine behind a proxy, offline, or with no network access still has a working plugin. The
 * result carries `error` and the card says "could not check" rather than hiding the control or
 * claiming there is nothing new — telling a user they are current when the check did not run is
 * the one wrong answer here. The error text distinguishes the two causes people actually hit:
 * a transport failure ("offline / proxy") versus a source that answered but has no release yet.
 *
 * @module dsh-onepool/update-check
 */
import { POOL_VERSION } from './version.ts'

/** The npm package name, when a build is published there. */
const PACKAGE = 'dsh-onepool'

/** The GitHub repo this fork actually publishes releases from. */
const RELEASE_API = 'https://api.github.com/repos/tsddts/dsh-onepool/releases/latest'
/** The human page the card sends the user to when an update exists. */
const RELEASE_PAGE = 'https://github.com/tsddts/dsh-onepool/releases/latest'

/** npm endpoints, kept as a fallback for builds published under a registry name. */
const REGISTRIES = [
  `https://registry.npmjs.org/${PACKAGE}/latest`,
  `https://registry.npmjs.org/${PACKAGE}`,
]

/** How long an answer is reused. */
const TTL_MS = 10 * 60 * 1000

/** What the card shows. */
export interface UpdateStatus {
  /** The version this process is running. */
  current: string
  /** The newest published version, when a source answered. */
  latest?: string
  /** Whether `latest` is newer than `current`. */
  newer: boolean
  /** When the newest version was published, ISO, when known. */
  publishedAt?: string
  /** Where the user can download the update, when one exists. */
  releaseUrl?: string
  /** Why the check did not produce a version. */
  error?: string
  /** When this answer was produced. */
  checkedAt: string
}

let cached: { at: number; status: UpdateStatus } | undefined

/**
 * Compare two dotted versions.
 *
 * Numeric segments compare as numbers and everything else as text, which is the ordering npm
 * itself uses for the plain `x.y.z` releases this package publishes. A prerelease tag is older
 * than its release (`2.7.3-rc.1 < 2.7.3`), which is what the `-` check below states.
 */
export function compareVersions(left: string, right: string): number {
  const parse = (value: string): { parts: number[]; pre: string } => {
    const [core, ...rest] = value.trim().replace(/^v/u, '').split('-')
    const parts = (core ?? '').split('.').map(segment => {
      const number = Number.parseInt(segment, 10)
      return Number.isFinite(number) ? number : 0
    })
    return { parts, pre: rest.join('-') }
  }
  const a = parse(left)
  const b = parse(right)
  const length = Math.max(a.parts.length, b.parts.length)
  for (let i = 0; i < length; i += 1) {
    const left1 = a.parts[i] ?? 0
    const right1 = b.parts[i] ?? 0
    if (left1 !== right1) return left1 < right1 ? -1 : 1
  }
  // Same numbers: a prerelease is older than the release it precedes.
  if (a.pre === '' && b.pre !== '') return 1
  if (a.pre !== '' && b.pre === '') return -1
  return a.pre === b.pre ? 0 : (a.pre < b.pre ? -1 : 1)
}

/**
 * Turn a release tag into a bare version.
 *
 * release-please with `package-name` emits `dsh-onepool-v1.1.1`; a hand tag is `v1.1.1`. The
 * comparison logic wants `1.1.1`, so both prefixes are stripped here rather than taught to the
 * comparator (which would then also accept them from an npm version field, where they never
 * appear).
 */
export function versionFromTag(tag: string): string | undefined {
  const bare = tag.trim().replace(/^dsh-onepool-v/u, '').replace(/^v/u, '')
  return /^\d+(?:\.\d+)*/.test(bare) ? bare : undefined
}

/** A small fetch wrapper: a non-2xx is a distinct outcome from a transport failure. */
type FetchOutcome = { ok: true; body: unknown } | { ok: false; status: number } | { ok: false; transport: true }

async function readJson(url: string, headers: Record<string, string>): Promise<FetchOutcome> {
  try {
    const response = await fetch(url, {
      headers,
      // Bounded: this runs from a panel render path and must not hold it open.
      signal: AbortSignal.timeout(8_000),
    })
    if (!response.ok) return { ok: false, status: response.status }
    return { ok: true, body: await response.json() }
  } catch {
    return { ok: false, transport: true }
  }
}

/** Read a version + publish time from a GitHub releases-latest document. */
function parseRelease(body: unknown): { latest?: string; publishedAt?: string } {
  if (body === null || typeof body !== 'object') return {}
  const record = body as Record<string, unknown>
  const tag = record['tag_name']
  if (typeof tag !== 'string') return {}
  const latest = versionFromTag(tag)
  if (latest === undefined) return {}
  const published = record['published_at']
  return {
    latest,
    ...(typeof published === 'string' ? { publishedAt: published } : {}),
  }
}

/** Read `dist-tags.latest` and its publish time from an npm registry document. */
function parseRegistry(body: unknown): { latest?: string; publishedAt?: string } {
  if (body === null || typeof body !== 'object') return {}
  const record = body as Record<string, unknown>
  // `/latest` answers the version document; the full document nests it under dist-tags.
  const direct = record['version']
  if (typeof direct === 'string' && direct !== '') return { latest: direct }
  const tags = record['dist-tags']
  if (tags !== null && typeof tags === 'object') {
    const latest = (tags as Record<string, unknown>)['latest']
    if (typeof latest === 'string' && latest !== '') {
      const times = record['time']
      const when = times !== null && typeof times === 'object'
        ? (times as Record<string, unknown>)[latest]
        : undefined
      return { latest, ...(typeof when === 'string' ? { publishedAt: when } : {}) }
    }
  }
  return {}
}

function statusFor(parsed: { latest?: string; publishedAt?: string }, checkedAt: string): UpdateStatus | undefined {
  if (parsed.latest === undefined) return undefined
  return {
    current: POOL_VERSION,
    latest: parsed.latest,
    newer: compareVersions(parsed.latest, POOL_VERSION) > 0,
    ...(parsed.publishedAt === undefined ? {} : { publishedAt: parsed.publishedAt }),
    releaseUrl: RELEASE_PAGE,
    checkedAt,
  }
}

/**
 * Ask the sources, or answer from the cache.
 *
 * `force` skips the cache — that is what the card's button does, and a button that silently
 * returns a ten-minute-old answer is indistinguishable from one that did nothing.
 */
export async function checkForUpdate(options: { force?: boolean; now?: number } = {}): Promise<UpdateStatus> {
  const now = options.now ?? Date.now()
  if (options.force !== true && cached !== undefined && now - cached.at < TTL_MS) return cached.status

  const checkedAt = new Date().toISOString()
  // Whether any source was REACHED (even with a 404). If none was, it is a transport problem;
  // if one answered but carried no version, the sources are fine and there is simply nothing
  // published to compare. Keeping these apart fixes the original false "offline" report.
  let reached = false

  // Primary: GitHub releases. This fork's real publication channel.
  const release = await readJson(RELEASE_API, { accept: 'application/vnd.github+json' })
  if (release.ok || 'status' in release) reached = true
  if (release.ok) {
    const status = statusFor(parseRelease(release.body), checkedAt)
    if (status !== undefined) {
      cached = { at: now, status }
      return status
    }
  }

  // Fallback: npm, for builds that are published under a registry name.
  for (const url of REGISTRIES) {
    const outcome = await readJson(url, { accept: 'application/vnd.npm.install-v1+json, application/json' })
    if (outcome.ok || 'status' in outcome) reached = true
    if (!outcome.ok) continue
    const status = statusFor(parseRegistry(outcome.body), checkedAt)
    if (status !== undefined) {
      cached = { at: now, status }
      return status
    }
  }

  const status: UpdateStatus = {
    current: POOL_VERSION,
    newer: false,
    error: reached
      ? '发布源可达，但没有找到可比较的版本'
      : '无法连接更新源（离线或代理未放行）',
    checkedAt,
  }
  // A failure is cached for the shorter of the two intervals, so a transient outage does not
  // pin "could not check" for ten minutes.
  cached = { at: now - TTL_MS + 60_000, status }
  return status
}

/** Drop the cache, for a test. */
export function resetUpdateCache(): void {
  cached = undefined
}
