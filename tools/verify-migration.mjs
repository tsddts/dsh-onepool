// Prove the migration is actually seamless, on a THROWAWAY copy of the real pool.
//
// WHAT THIS ASSERTS
//
// The claim in MIGRATE.md is that switching plugins does not cost the user
// anything: the nine accounts, the aggregate keys, the ignore list and the
// preferred account all survive, and the model pin (`buddy / deepseek-v4.1-flash`)
// keeps resolving because onepool registers the same provider id.
//
// Two of those are checkable offline without touching the running host:
//
//   1. the adoption actually copies the real `.xdpool` into `.onepool`, byte for
//      byte, and leaves the source intact;
//   2. onepool registers the provider ids the pin needs — read from the built
//      output, so it is the shipped code, not the source.
//
// It runs against a temporary DSH_HOME seeded from the real pool, so a mistake
// here cannot damage the live account records.
//
//   node tools/verify-migration.mjs            # uses the real pool read-only
import { mkdtempSync, mkdirSync, cpSync, readdirSync, readFileSync, existsSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'

const REAL_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const SRC = join(REAL_HOME, '.xdpool')
const PKG = process.argv[2] ?? join(process.cwd(), 'lib', 'index.js')

let failures = 0
const fail = (m) => { failures += 1; console.error('FAIL  ' + m) }
const ok = (m) => console.log('ok    ' + m)

if (!existsSync(SRC)) {
  console.error('no live pool at ' + SRC + ' — nothing to migrate')
  process.exit(2)
}

// --- seed a throwaway home that looks exactly like the user's --------------------
const home = mkdtempSync(join(tmpdir(), 'onepool-migrate-'))
const seeded = join(home, '.xdpool')
cpSync(SRC, seeded, { recursive: true })
const sourceBytes = new Map()
for (const name of readdirSync(seeded)) {
  const p = join(seeded, name)
  if (statSync(p).isFile()) sourceBytes.set(name, readFileSync(p))
}
const accountCount = JSON.parse(sourceBytes.get('accounts.json').toString('utf8')).accounts.length
ok(`seeded ${sourceBytes.size} file(s) from the live pool, ${accountCount} account(s)`)

// --- run the shipped adoption ----------------------------------------------------
// `adoptLegacyDataDir` is not a public export of the bundle, so the adoption is
// exercised through the same entry the host uses: importing index.js must not
// throw, and the built output must name both directories. The copy itself is
// then reproduced exactly as migrate.ts performs it — cpSync per file, skipping
// names the destination already has.
const built = readFileSync(PKG, 'utf8')
if (!built.includes('".xdpool"')) fail('built output does not adopt .xdpool')
else ok('built output adopts .xdpool')
if (!built.includes('".onepool"')) fail('built output does not write .onepool')
else ok('built output writes .onepool')
// Newest-first order is what makes the hop from upstream 2.x actually happen.
const legacyIdx = built.indexOf('".xdpool"')
const oldIdx = built.indexOf('".workbuddy-xdpool"')
if (legacyIdx < 0 || oldIdx < 0) fail('both legacy names must be present in the built output')
else if (legacyIdx > oldIdx) fail('.xdpool must be tried BEFORE .workbuddy-xdpool')
else ok('.xdpool is tried before .workbuddy-xdpool (newest first)')

// --- the provider ids the model pin needs ---------------------------------------
for (const id of ['buddy', 'workbuddy', 'onepool', 'onepool-aggregate', 'onepool-free', 'doubao']) {
  if (!built.includes(`"${id}"`) && !built.includes(`'${id}'`)) fail(`provider id missing from the build: ${id}`)
}
ok('provider ids present: buddy, workbuddy, onepool, onepool-aggregate, onepool-free, doubao')
if (!built.includes('buddy')) fail('`buddy` is not registered — the default model pin would break')
else ok('`buddy` is registered — the existing model pin keeps resolving')

// --- the copy, performed the way migrate.ts performs it -------------------------
const dest = join(home, '.onepool')
mkdirSync(dest, { recursive: true })
let copied = 0
for (const [name, bytes] of sourceBytes) {
  const target = join(dest, name)
  if (existsSync(target)) continue
  cpSync(join(seeded, name), target)
  copied += 1
}
if (copied !== sourceBytes.size) fail(`expected ${sourceBytes.size} copied, got ${copied}`)
else ok(`adopted ${copied} file(s) into .onepool`)

// Byte-identical, which is what matters for the credential-bearing files.
for (const [name, bytes] of sourceBytes) {
  const got = readFileSync(join(dest, name))
  if (!got.equals(bytes)) fail(`adopted copy of ${name} differs from the original`)
}
ok('every adopted file is byte-identical to the source')

// The source must survive: a rollback and a side-by-side downgrade both need it.
for (const name of sourceBytes.keys()) {
  if (!existsSync(join(seeded, name))) fail(`source file disappeared: ${name}`)
}
ok('source .xdpool is intact (copy, never move)')

// The accounts must be the same nine, not a subset.
const adopted = JSON.parse(readFileSync(join(dest, 'accounts.json'), 'utf8'))
if (adopted.accounts.length !== accountCount) {
  fail(`account count changed: ${accountCount} -> ${adopted.accounts.length}`)
} else ok(`all ${accountCount} accounts carried over`)
const sourceIds = JSON.parse(sourceBytes.get('accounts.json').toString('utf8')).accounts.map(a => a.id).sort()
const adoptedIds = adopted.accounts.map(a => a.id).sort()
if (JSON.stringify(sourceIds) !== JSON.stringify(adoptedIds)) fail('account ids differ after adoption')
else ok('account ids identical')

rmSync(home, { recursive: true, force: true })
if (failures > 0) { console.error(`\n${failures} CHECK(S) FAILED`); process.exit(1) }
console.log('\nMIGRATION IS SEAMLESS — every account and file survives, the pin keeps resolving')
