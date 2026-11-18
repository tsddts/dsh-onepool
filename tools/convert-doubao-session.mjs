// Convert the v2 multi-account Doubao session file into the v1 shape the
// current code actually reads, then validate it without printing any cookies.
//
// The v2 file was written by an older multi-account experiment but no released
// build (including upstream 2.7.5 and this fork) contains a v2 reader: every
// `readStoredSession` checks `parsed.cookies` at the TOP level and returns
// undefined otherwise. The cookies themselves are intact, so a format conversion
// is enough — no new login should be needed.
//
// Safety: non-destructive. The caller has already made a timestamped backup;
// this script also refuses to overwrite anything unless `--apply` is passed.
//
//   node tools/convert-doubao-session.mjs <file>           # inspect/dry-run
//   node tools/convert-doubao-session.mjs <file> --apply   # write v1
import { readFileSync, writeFileSync, existsSync } from 'node:fs'

const FILE = process.argv[2]
const APPLY = process.argv.includes('--apply')
if (!FILE) { console.error('usage: node convert-doubao-session.mjs <doubao-session.json> [--apply]'); process.exit(2) }
if (!existsSync(FILE)) { console.error('file not found: ' + FILE); process.exit(1) }

const raw = readFileSync(FILE, 'utf8')
let parsed
try { parsed = JSON.parse(raw) } catch (e) { console.error('invalid JSON: ' + e.message); process.exit(1) }

// Already v1?
if (parsed.cookies && typeof parsed.cookies === 'object') {
  console.log('file is already v1; nothing to convert')
  console.log('sessionid present:', typeof parsed.cookies.sessionid === 'string' && parsed.cookies.sessionid.length > 0)
  process.exit(0)
}

if (parsed.version !== 2 || !Array.isArray(parsed.accounts) || parsed.accounts.length === 0) {
  console.error('not a recognised v2 session (expected version=2 with accounts[])')
  process.exit(1)
}

// Pick the newest usable account. The file has one, but sorting by savedAt
// makes this robust if later builds append more.
const usable = parsed.accounts
  .filter(a => a?.session?.cookies && typeof a.session.cookies.sessionid === 'string' && a.session.cookies.sessionid !== '')
  .sort((a, b) => (Date.parse(b.session.savedAt ?? '') || 0) - (Date.parse(a.session.savedAt ?? '') || 0))

if (usable.length === 0) {
  console.error('v2 file has no account with a sessionid cookie — conversion cannot help')
  process.exit(1)
}

const chosen = usable[0]
const cookies = chosen.session.cookies

// The current reader requires a UA and a savedAt; it supplies defaults when
// absent. Preserve what is there rather than inventing values.
const v1 = {
  cookies,
  userAgent: typeof chosen.session.userAgent === 'string' ? chosen.session.userAgent
    : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36 SamanthaDoubao/2.31.4',
  savedAt: typeof chosen.session.savedAt === 'string' ? chosen.session.savedAt : new Date(0).toISOString(),
}

// Report the shape without leaking values.
console.log('source      : v2, accounts=' + parsed.accounts.length + ', usable=' + usable.length)
console.log('selected    : id=' + (chosen.id ?? '(none)') + ' name=' + (chosen.name ?? '(none)') + ' savedAt=' + v1.savedAt)
console.log('cookie count: ' + Object.keys(cookies).length)
for (const name of ['sessionid', 'sessionid_ss', 'sid_tt', 'uid_tt']) {
  const value = cookies[name]
  console.log(`  ${name.padEnd(14)} ${typeof value === 'string' ? `present (${value.length} chars)` : 'MISSING'}`)
}
// The reader's exact gate.
const ok = typeof cookies.sessionid === 'string' && cookies.sessionid !== ''
console.log('reader gate : ' + (ok ? 'PASS — the current plugin will recognise this session' : 'FAIL'))
if (!ok) process.exit(1)

if (!APPLY) {
  console.log('\nDRY RUN — nothing written. Re-run with --apply.')
  process.exit(0)
}

writeFileSync(FILE, JSON.stringify(v1, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
console.log('\nconverted to v1: ' + FILE)

// Re-read through the same shape the plugin uses, to close the loop.
const check = JSON.parse(readFileSync(FILE, 'utf8'))
const gate = typeof check.cookies?.sessionid === 'string' && check.cookies.sessionid !== ''
console.log('post-write gate: ' + (gate ? 'PASS' : 'FAIL'))
process.exit(gate ? 0 : 1)
