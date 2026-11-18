// Credential-leak check for anything that would ship in the package.
//
// WHY A DEDICATED SCRIPT AND NOT A GREP
//
// The codebase legitimately contains the *names* of credential fields
// (`refresh_token`, `accessToken`), protocol constants, and a vendored WASM
// binary that embeds an RSA **public** key. A pattern that flags those reports
// 200 false positives and trains the reader to ignore the output. What must never
// appear is an actual VALUE: a bearer token, a private key, a long opaque blob
// assigned to a credential field, or the pool's account records.
import { readFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const files = execFileSync('git', ['ls-files'], { encoding: 'utf8' })
  .split('\n')
  .filter(Boolean)
  .filter(f => existsSync(f))
  // Binary assets cannot carry a readable secret and reading them as text only
  // produces noise; the WASM's embedded PUBLIC key is a known, intended fixture.
  .filter(f => !/\.(wasm|png|jpg|jpeg|gif|ico|woff2?|ttf|zip|tgz)$/iu.test(f))

const CHECKS = [
  {
    name: 'bearer token value',
    // "Bearer " followed by something that looks like a JWT or a long opaque key.
    re: /Bearer\s+(?!<|\$|\{|eyJ\.\.\.)[A-Za-z0-9._~+/-]{30,}/gu,
  },
  {
    name: 'private key block',
    re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/gu,
  },
  {
    name: 'JWT value',
    re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/gu,
  },
  {
    name: 'uuid-shaped access token',
    // The pool stores gateways' tokens as 3-4 dash-separated UUID-ish chunks and
    // they are ~1480-1570 chars. Anything over 200 chars assigned to a token
    // field is a real credential, not a fixture.
    re: /"?(?:access_?token|accessToken|refresh_?token|refreshToken)"?\s*[:=]\s*["'][A-Za-z0-9._-]{200,}["']/gu,
  },
  {
    name: 'pool account file',
    re: /"accounts"\s*:\s*\[\s*\{\s*"id"\s*:\s*"(?:buddy|[0-9a-f]{16})/gu,
  },
  {
    name: 'cookies header with a session value',
    re: /Cookie:\s*[A-Za-z0-9_-]+=[A-Za-z0-9%._-]{40,}/gu,
  },
]

let total = 0
for (const check of CHECKS) {
  const hits = []
  for (const file of files) {
    let text
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    for (const m of text.matchAll(check.re)) {
      const line = text.slice(0, m.index).split('\n').length
      hits.push(`${file}:${line}  ${m[0].slice(0, 60).replace(/\s+/g, ' ')}…`)
    }
  }
  if (hits.length > 0) {
    total += hits.length
    console.log(`FAIL  ${check.name} — ${hits.length} hit(s)`)
    for (const h of hits.slice(0, 5)) console.log(`        ${h}`)
  } else {
    console.log(`ok    ${check.name}`)
  }
}

// The pool's own state files must never be tracked, whatever they contain.
const forbidden = /^(?:\.xdpool|\.onepool|accounts\.json|ignored\.json|preferred\.json|startup\.log)/u
const tracked = execFileSync('git', ['ls-files'], { encoding: 'utf8' }).split('\n').filter(Boolean)
const stateFiles = tracked.filter(f => forbidden.test(f))
if (stateFiles.length > 0) {
  total += stateFiles.length
  console.log(`FAIL  pool state files tracked — ${stateFiles.join(', ')}`)
} else {
  console.log('ok    no pool state files tracked')
}

console.log(total === 0 ? '\nCLEAN' : `\n${total} FINDING(S)`)
process.exitCode = total === 0 ? 0 : 1
