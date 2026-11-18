// Swap dsh-xdpool for dsh-onepool in the profile manifest with a MINIMAL diff.
//
// `ConvertTo-Json` rewrote the whole file (different indent, different spacing),
// which would make the rollback diff unreadable and, worse, made it impossible to
// eyeball what actually changed in the file that decides which plugins load. Two
// targeted string replacements keep the diff to two lines.
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const PROFILE = join(homedir(), '.dsh', 'profiles', 'desktop')
const FILE = join(PROFILE, 'package.json')
const STAMP = process.argv[2]

if (!STAMP) { console.error('usage: node swap-profile.mjs <stamp>'); process.exit(2) }

const before = readFileSync(FILE, 'utf8')
if (before.includes('"dsh-onepool"')) {
  console.log('already switched; nothing to do')
  process.exit(0)
}

// Keep a pristine copy keyed to the same stamp as the other backups.
copyFileSync(FILE, join(PROFILE, `package.json.${STAMP}.pre-textswap.bak`))

// The dependency line: replace the whole entry, preserving the file's indentation.
const depRe = /( *)"dsh-xdpool": "[^"]*"/u
if (!depRe.test(before)) {
  console.error('dependency line not found — refusing to guess')
  process.exit(1)
}
// NOTE: the field is written as a `file:` spec inside the profile, exactly like
// the xdpool spec it replaces, so the host resolves it without a registry.
let after = before.replace(depRe, '$1"dsh-onepool": "file:./dsh-onepool-1.0.0.tgz"')

// The bundle row: same indentation, same position, only the name changes.
const bundleRe = /( *)"dsh-xdpool"(,?\r?\n)/u
if (!bundleRe.test(after)) {
  console.error('bundle row not found — refusing to guess')
  process.exit(1)
}
after = after.replace(bundleRe, '$1"dsh-onepool"$2')

writeFileSync(FILE, after)
console.log('profile switched')

// Show the diff so the changed lines are auditable.
const a = before.split('\n')
const b = after.split('\n')
for (let i = 0; i < Math.max(a.length, b.length); i++) {
  if (a[i] !== b[i]) {
    if (a[i] !== undefined) console.log(`- ${a[i].trim()}`)
    if (b[i] !== undefined) console.log(`+ ${b[i].trim()}`)
  }
}
