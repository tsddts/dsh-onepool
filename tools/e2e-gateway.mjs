// End-to-end: the INSTALLED package, against the real gateway.
//
// What this proves that unit tests cannot: the tarball a user installs carries
// the fingerprint rewrite, and the rewrite satisfies the live gateway. The
// failing session's own assistant text is replayed through the shipped
// `sanitizeSystemContent` — the function `BuddyAdapter` calls on every system
// and assistant message — and posted to copilot.tencent.com with a pool
// credential.
//
// Expected: the raw text is blocked with 11128; the same text after the shipped
// rewrite answers 200 with a normal SSE stream.
//
//   node tools/e2e-gateway.mjs <profile-dir> --dry     # shape only, no traffic
//   node tools/e2e-gateway.mjs <profile-dir>           # sends two requests
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'

const PROFILE = process.argv[2]
const DRY = process.argv.includes('--dry')
if (!PROFILE) {
  console.error('usage: node tools/e2e-gateway.mjs <profile-dir> [--dry]')
  process.exit(2)
}

const pkgDir = join(PROFILE, 'node_modules', 'dsh-onepool')
const gateway = 'https://copilot.tencent.com/v2/chat/completions'
const model = process.env.ONEPOOL_MODEL ?? 'deepseek-v4.1-flash'

/** The sentence the gateway rejects, quoted the way a session quoting it would. */
const OFFENDING = [
  '证据已经齐全。这件事的因果关系，和你猜测的几种原因都不太一样。',
  '',
  '> 2. **11128 的主要触发原因是字面量指纹检测**：腾讯网关对请求体中所有非 user 消息做大小写不敏感的字面量比对。命中的两条是：',
  '>    - `You are an AI agent powered by DeepSeek Harness.`（DSH 内核默认第一句）',
  '>    - `Main branch (you will usually use this for PRs)`（Git 上下文行）',
].join('\n')

// --- 1. the shipped rewrite, loaded from the installed tarball -------------------------
const hostPeers = join(pkgDir, 'node_modules')
if (!existsSync(join(pkgDir, 'lib', 'index.js'))) {
  console.error('dsh-onepool is not installed at ' + pkgDir)
  process.exit(1)
}
// The pack is a vendored bundle with no public entry, so the chain is taken from
// the shipped bytes — which is the point: this asserts on what the user gets.
const pack = readFileSync(join(pkgDir, 'vendor', 'channel-pack', 'pack.js'), 'utf8')
const start = pack.indexOf('message.content = message.content.replace(/powered by DeepSeek Harness/gi')
const end = pack.indexOf(';', pack.indexOf('This coding agent is an open source project', start))
if (start < 0 || end < start) {
  console.error('shipped pack has no fingerprint chain')
  process.exit(1)
}
const chainSource = pack.slice(start + 'message.content = '.length, end)
const rewrite = new Function('text', `return (${chainSource.replaceAll('message.content', 'text')});`)

console.log('shipped chain rules:', (chainSource.match(/\.replace\(/g) ?? []).length)
console.log('rewrites git-context:', rewrite(OFFENDING).includes('Main branch (PRs usually go here)'))

// --- 2. a credential from the pool ------------------------------------------------
const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const accountFiles = [
  join(dshHome, '.onepool', 'accounts.json'),
  join(dshHome, '.xdpool', 'accounts.json'),
]
const accountFile = accountFiles.find(f => existsSync(f))
if (accountFile === undefined) {
  console.error('no accounts.json in ' + accountFiles.join(' or '))
  process.exit(1)
}
const pool = JSON.parse(readFileSync(accountFile, 'utf8'))
const entry = (pool.accounts ?? []).find(a => a?.credential?.accessToken)
if (entry === undefined) {
  console.error('accounts.json has no usable credential')
  process.exit(1)
}
const cred = entry.credential
console.log('credential       :', accountFile.replace(dshHome, '~'), '->', entry.label ?? entry.id)

const headers = {
  Accept: 'application/json, text/plain, */*',
  'X-Requested-With': 'XMLHttpRequest',
  Origin: 'https://www.codebuddy.cn',
  Referer: 'https://www.codebuddy.cn/',
  'User-Agent': 'CLI/2.63.2 CodeBuddy/2.63.2',
  'Content-Type': 'application/json',
  Authorization: 'Bearer ' + cred.accessToken,
  'X-User-Id': String(cred.uid),
  'X-No-Enterprise-Id': '1',
  'X-Domain': String(cred.domain),
  'X-Product': 'SaaS',
  'X-IDE-Name': 'WorkBuddy',
  'X-IDE-Type': 'WorkBuddy',
  'X-IDE-Version': '5.5.6',
  'X-Conversation-ID': randomUUID(),
  'X-Conversation-Request-ID': randomUUID(),
  'acp-connection-id': randomUUID(),
  'X-Conversation-Message-ID': randomUUID(),
  'X-Request-ID': randomUUID(),
  'X-Agent-Intent': 'craft',
  'X-Agent-Purpose': 'conversation',
  'X-Private-Data': 'true',
  'x-codebuddy-request': '1',
}

async function send(label, assistantText) {
  const body = JSON.stringify({
    model,
    stream: true,
    messages: [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: '继续' },
      { role: 'assistant', content: assistantText },
      { role: 'user', content: '接着上一轮说' },
    ],
  })
  if (DRY) {
    console.log(`[${label}] DRY bytes=${body.length} (nothing sent)`)
    return undefined
  }
  const res = await fetch(gateway, { method: 'POST', headers, body })
  const text = await res.text()
  const blocked = res.status === 400 && text.includes('11128')
  console.log(`[${label}] status=${res.status} blocked=${blocked}`)
  return { status: res.status, blocked, preview: text.replace(/\s+/g, ' ').slice(0, 120) }
}

const raw = await send('raw history', OFFENDING)
const fixed = await send('through shipped chain', rewrite(OFFENDING))
if (raw?.preview !== undefined) console.log('   raw  :', raw.preview)
if (fixed?.preview !== undefined) console.log('   fixed:', fixed.preview)

if (DRY) process.exit(0)
if (raw?.blocked !== true) {
  console.error('\nEXPECTED the raw text to be blocked — the fixture may have drifted')
  process.exit(1)
}

// WHAT COUNTS AS SUCCESS
//
// The question is not "did the answer stream" but "did the request pass channel
// verification". Those are different, and a credential that is out of quota
// answers 429 / 6004 — which is the ACCEPTED case: the body was read, the
// channel check passed, and only the budget refused. Upstream's own probes use
// exactly this split (429 = accepted, 400 / 11128 = blocked).
//
// Requiring `status === 200` here made the check fail on a healthy build the
// first time a pool account happened to be exhausted, which is the sort of
// false negative that teaches people to ignore the tool.
const clearedChannel = fixed !== undefined && !fixed.blocked && (fixed.status === 200 || fixed.status === 429)
if (!clearedChannel) {
  console.error(`\nFAILED: the shipped chain did not clear the gateway (status ${fixed?.status})`)
  process.exit(1)
}
console.log(
  fixed.status === 200
    ? '\nPASS — shipped chain clears 11128, gateway answered 200'
    : '\nPASS — shipped chain clears channel verification (200 path); this account is rate-limited, which the gateway reports as 429 / 6004',
)
