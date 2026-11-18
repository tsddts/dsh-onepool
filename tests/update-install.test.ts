import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { installVersion, refreshProfileLockfile, type LockfileRefresher } from '../src/update-install.ts'

/**
 * The bug this guards: an update wrote the new `file:` spec to package.json but left
 * pnpm-lock.yaml on the old version. DSH then reinstalled from the stale lockfile with
 * --frozen-lockfile, the host restored package.json, and the running version never changed.
 * The fix is that every spec change is followed by a lockfile refresh, and a failed refresh is
 * reported instead of being presented as a successful update.
 */
const dirs: string[] = []
function profile(withLockfile: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), 'onepool-lock-test-'))
  dirs.push(dir)
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { 'dsh-onepool': '1.0.0' } }))
  if (withLockfile) writeFileSync(join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n')
  return dir
}
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true })
})

describe('refreshProfileLockfile', () => {
  it('refreshes the lockfile with lockfile-only and no scripts', () => {
    const dir = profile(true)
    const refresh = vi.fn<LockfileRefresher>(() => ({ status: 0 }))
    expect(refreshProfileLockfile(dir, refresh)).toBeUndefined()
    expect(refresh).toHaveBeenCalledOnce()
    expect(refresh.mock.calls[0]![0].cwd).toBe(dir)
    expect(refresh.mock.calls[0]![0].args).toEqual(['install', '--lockfile-only', '--ignore-scripts'])
  })

  it('reports a failed refresh instead of claiming the update landed', () => {
    const dir = profile(true)
    const refresh: LockfileRefresher = () => ({ status: 1, stderr: 'ERR_PNPM_OUTDATED_LOCKFILE' })
    expect(refreshProfileLockfile(dir, refresh)).toContain('刷新依赖锁文件失败')
    expect(refreshProfileLockfile(dir, refresh)).toContain('ERR_PNPM_OUTDATED_LOCKFILE')
  })

  it('reports a thrown refresh as a failure', () => {
    const dir = profile(true)
    const refresh: LockfileRefresher = () => { throw new Error('spawn ENOENT') }
    expect(refreshProfileLockfile(dir, refresh)).toContain('spawn ENOENT')
  })

  it('does nothing when the profile has no lockfile', () => {
    const dir = profile(false)
    const refresh = vi.fn<LockfileRefresher>(() => ({ status: 0 }))
    expect(refreshProfileLockfile(dir, refresh)).toBeUndefined()
    expect(refresh).not.toHaveBeenCalled()
  })
})

describe('installVersion rollback', () => {
  it('restores package.json when the lockfile refresh fails', async () => {
    const dir = profile(true)
    const original = readFileSync(join(dir, 'package.json'), 'utf8')
    const previousProfile = process.env['DSH_PROFILE_DIR']
    process.env['DSH_PROFILE_DIR'] = dir
    // A valid gzip member header is all the download path checks before it accepts the tarball.
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([0x1f, 0x8b, 0, 0]))))
    try {
      const refresh: LockfileRefresher = () => ({ status: 1, stderr: 'lockfile refused' })
      const result = await installVersion('9.9.9', refresh)
      expect(result.ok).toBe(false)
      expect(result.error).toContain('刷新依赖锁文件失败')
      // No half-applied state: a new spec with an old lockfile is what breaks the next start.
      expect(readFileSync(join(dir, 'package.json'), 'utf8')).toBe(original)
    } finally {
      if (previousProfile === undefined) delete process.env['DSH_PROFILE_DIR']
      else process.env['DSH_PROFILE_DIR'] = previousProfile
      vi.unstubAllGlobals()
    }
  })
})
