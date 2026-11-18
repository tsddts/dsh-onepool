// Validate the converted Doubao session against the real site WITHOUT printing
// any cookie. Uses the same lightweight account-info endpoint the plugin uses
// for the card's display name — it does not consume inference quota.
//
//   node tools/verify-doubao-session.mjs <doubao-session.json>
import { readFileSync, existsSync } from 'node:fs'

const FILE = process.argv[2]
if (!FILE) { console.error('usage: node verify-doubao-session.mjs <file>'); process.exit(2) }
if (!existsSync(FILE)) { console.error('file not found: ' + FILE); process.exit(1) }

const parsed = JSON.parse(readFileSync(FILE, 'utf8'))
const cookies = parsed.cookies ?? {}
if (typeof cookies.sessionid !== 'string' || cookies.sessionid === '') {
  console.error('no sessionid — conversion did not produce a readable session')
  process.exit(1)
}

// Mirrors the plugin's cookie header construction. The order/format matches
// `buildAuthHeaders` well enough for a read-only GET.
const pairs = Object.entries(cookies)
  .filter(([k, v]) => typeof v === 'string' && v !== '')
  .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
const cookieHeader = pairs.join('; ')

const url = 'https://www.doubao.com/passport/account/info/v2/'
const headers = {
  Cookie: cookieHeader,
  'User-Agent': parsed.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36 SamanthaDoubao/2.31.4',
  Accept: 'application/json, text/plain, */*',
  Referer: 'https://www.doubao.com/',
  Origin: 'https://www.doubao.com',
}

console.log('probing account-info …')
let res
try {
  res = await fetch(url, { method: 'GET', headers, signal: AbortSignal.timeout(15_000) })
} catch (e) {
  console.error('network error:', e.message)
  process.exit(1)
}

let body = ''
try { body = await res.text() } catch { /* status alone is enough */ }

console.log('HTTP status:', res.status)
let parsedBody
try { parsedBody = JSON.parse(body) } catch { /* not JSON */ }

// Never print the body: it can carry account identifiers.
const code = parsedBody?.code
const hasData = typeof parsedBody?.data === 'object' && parsedBody.data !== null
const name = typeof parsedBody?.data?.name === 'string' ? parsedBody.data.name
  : typeof parsedBody?.data?.screen_name === 'string' ? parsedBody.data.screen_name : undefined

if (res.ok && (code === 0 || code === undefined) && hasData) {
  console.log('RESULT: SESSION VALID')
  console.log('account name:', name ?? '(not returned, but data present)')
  process.exit(0)
}

console.log('RESULT: SESSION NOT VALID')
console.log('response code:', code ?? '(none)')
if (res.status === 401 || res.status === 403) console.log('the cookie has expired — one re-login is required')
else console.log('the site rejected the request for another reason; check the cookie jar')
process.exit(1)
