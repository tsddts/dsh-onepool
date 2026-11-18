// Load the INSTALLED package the way the host does, in an isolated profile.
//
// This is the check that matters before publishing: a tarball can be built,
// packed and installed and still fail at the only moment that counts — when the
// host imports its entry module and calls `apply`. Everything below mirrors what
// the loader does: resolve the package by name from the profile, import the
// module it declares as `main`, and confirm the exports the manifest promises.
//
// The host itself is not started: starting one would mount a second `buddy`
// provider alongside the profile that is already running, and the two would
// fight over the same account records. Import + export shape is the part that
// packaging can break, so that is what is tested here.
const PROFILE = process.argv[2]
if (!PROFILE) {
  console.error('usage: node verify-installed.mjs <profile-dir>')
  process.exit(2)
}

const { readFileSync, existsSync } = await import('node:fs')
const { join } = await import('node:path')
const { pathToFileURL } = await import('node:url')

const pkgDir = join(PROFILE, 'node_modules', 'dsh-onepool')
let failures = 0
const fail = (msg) => { failures += 1; console.error('FAIL  ' + msg) }
const ok = (msg) => console.log('ok    ' + msg)

if (!existsSync(pkgDir)) { fail('package not installed at ' + pkgDir); process.exit(1) }
ok('package present: ' + pkgDir)

const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))
ok(`manifest name=${pkg.name} version=${pkg.version}`)
if (pkg.name !== 'dsh-onepool') fail('manifest name is not dsh-onepool')
if (pkg.version !== '1.0.0') fail('manifest version is not 1.0.0')
if (pkg.displayName !== 'DSH OnePool · 一泓') fail('displayName is not the fork brand: ' + pkg.displayName)

// 1. The entry module the host imports.
const mainPath = join(pkgDir, pkg.main ?? 'lib/index.js')
if (!existsSync(mainPath)) { fail('entry module missing: ' + mainPath); process.exit(1) }
const mod = await import(pathToFileURL(mainPath).href)
ok('entry module imported')

// 2. What a cordis plugin must expose. `apply` is the lifecycle hook; `name`
//    identifies the fiber in the loader tree.
if (typeof mod.apply !== 'function') fail('no `apply` export — the host cannot mount this plugin')
else ok('exports apply()')
if (typeof mod.name !== 'string' || mod.name === '') fail('no `name` export — the fiber would be anonymous')
else ok(`exports name="${mod.name}"`)
if (typeof mod.Config !== 'function' && typeof mod.Config !== 'object') {
  console.log('note  no Config export (allowed; the profile supplies plain config)')
}

// 3. The client half. The host serves this file to the settings dialog; a
//    missing one means the card renders nothing.
const clientPath = join(pkgDir, 'lib', 'client.js')
if (!existsSync(clientPath)) fail('lib/client.js missing — the settings card would be blank')
else {
  const client = readFileSync(clientPath, 'utf8')
  ok(`lib/client.js present (${(client.length / 1024).toFixed(0)} kB)`)
  if (!client.includes('OnePool')) fail('client bundle does not mention the brand')
  // The removed upstream community UI must not survive in the shipped bundle.
  if (client.includes('COMMUNITY_QR')) fail('client bundle still carries the community QR code')
  else ok('community QR code absent from the bundle')
}

// 4. The cordis patch the host merges for bundle installs.
const patchPath = join(pkgDir, 'cordis.patch.yml')
if (!existsSync(patchPath)) fail('cordis.patch.yml missing — bundle install would not register the lane')
else {
  const patch = readFileSync(patchPath, 'utf8')
  ok('cordis.patch.yml present')
  if (!patch.includes('dsh-onepool')) fail('patch does not name dsh-onepool')
  if (/dsh-xdpool/u.test(patch)) fail('patch still names dsh-xdpool')
}

// 5. The vendored pack, which carries the fingerprint rules.
const packPath = join(pkgDir, 'vendor', 'channel-pack', 'pack.js')
if (!existsSync(packPath)) fail('vendored channel pack missing')
else {
  const pack = readFileSync(packPath, 'utf8')
  ok(`vendored pack present (${(pack.length / 1024 / 1024).toFixed(1)} MB)`)
  const start = pack.indexOf('message.content = message.content.replace(/powered by DeepSeek Harness/gi')
  const end = pack.indexOf(';', pack.indexOf('This coding agent is an open source project', start))
  const chain = start >= 0 && end > start ? pack.slice(start, end) : ''
  if (!chain.includes('Main branch')) fail('SHIPPED PACK LACKS THE GIT-CONTEXT FINGERPRINT')
  else ok('shipped pack rewrites the git-context fingerprint')
}

// 6. The data directory this build will read, and the legacy names it adopts.
const migratePath = join(pkgDir, 'lib', 'index.js')
if (existsSync(migratePath)) {
  const built = readFileSync(migratePath, 'utf8')
  if (!built.includes('".xdpool"')) fail('built output does not adopt .xdpool — existing pools would be lost')
  else ok('built output adopts .xdpool')
  if (!built.includes('".onepool"')) fail('built output does not write .onepool')
  else ok('built output writes .onepool')
}

if (failures > 0) {
  console.error(`\n${failures} CHECK(S) FAILED`)
  process.exit(1)
}
console.log('\nALL CHECKS PASSED')
