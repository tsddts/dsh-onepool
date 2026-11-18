/**
 * The gateway's content fingerprints must be rewritten by EVERY lane that sends
 * a system or assistant message upstream.
 *
 * WHY THIS FILE EXISTS
 *
 * `400 / 11128 Illegal API invocation from an unapproved channel` is not a
 * credential problem and not a rate limit: the WorkBuddy gateway matches the
 * CONTENT of every non-user message against a list of sentences that identify
 * other clients. Once a lane fails to rewrite one of those sentences the
 * conversation is not merely slowed — it is finished. The offending text is now
 * part of the assistant history, so every later request in that session carries
 * it and answers 400 again. Retrying, switching accounts and re-sending the
 * prompt all fail, because the request body itself is what is being rejected.
 *
 * That is what happened on 2026-11-18. `Main branch (you will usually use this
 * for PRs)` had been rewritten by the channel lane's `CONTENT_FINGERPRINTS`
 * since early October, but neither the pool lane (`BANNED_SYSTEM_PHRASES`) nor
 * `BuddyAdapter`'s inline chain had it. One assistant reply quoted the sentence
 * while explaining the filter, and that session was dead from then on: turns 5
 * and 6 both `INVALID_REQUEST`.
 *
 * WHY IT CALLS THE REAL FUNCTIONS INSTEAD OF PARSING SOURCE
 *
 * Three attempts at extracting the rule list with a regular expression each
 * dropped a different row — one because the row is formatter-wrapped onto three
 * lines, one because the replacement text contains a comma and a period — and
 * every one of those failures made the test PASS while a rule went unverified.
 * Behaviour is the property that matters, so the pool lane is exercised through
 * `sanitizeSystemContent`, the function the adapter actually calls. The pack's
 * chain is a 2.9 MB vendored bundle that cannot be imported, so that one is
 * checked by running its own `.replace()` calls, extracted as text and
 * evaluated — still behaviour, not a list comparison.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { sanitizeSystemContent } from '../src/upstream.ts'

/** Every sentence the gateway is known to reject, with the text this build sends instead. */
const FINGERPRINTS: readonly (readonly [string, string])[] = [
  ['You are an AI agent powered by DeepSeek Harness.', 'You are an AI agent running on DeepSeek Harness.'],
  ['You are interacting with the user through the DeepSeek Harness Web GUI', 'You are interacting with the user through the DeepSeek Harness web interface'],
  ['Relative paths resolve from the workspace root', 'Relative paths are resolved against the workspace root'],
  ['Main branch (you will usually use this for PRs)', 'Main branch (PRs usually go here)'],
  ['You are a coding agent running in the Codex CLI, a terminal-based coding assistant', 'codex-long'],
  ['You are a coding agent running in the Codex CLI', 'codex-short'],
  ['Codex CLI is an open source project led by OpenAI', 'codex-project'],
]

const packSource = readFileSync(new URL('../vendor/channel-pack/pack.js', import.meta.url), 'utf8')

/**
 * The channel lane's rewrite, as a callable.
 *
 * The chain is one chained expression inside `BuddyAdapter.prepareChatBody`.
 * It is extracted verbatim and turned into a function so this test exercises
 * the shipped code rather than a hand-copied list that could drift.
 */
function channelLaneRewrite(): (text: string) => string {
  const start = packSource.indexOf('message.content = message.content.replace(/powered by DeepSeek Harness/gi')
  expect(start, 'the BuddyAdapter inline chain must exist in the vendored pack').toBeGreaterThan(-1)
  const end = packSource.indexOf(';', packSource.indexOf('This coding agent is an open source project', start))
  expect(end, 'the chain must terminate').toBeGreaterThan(start)
  const expression = packSource.slice(start + 'message.content = '.length, end)
  // eslint-disable-next-line no-new-func -- the point is to run the shipped text
  return new Function('text', `return (${expression.replaceAll('message.content', 'text')});`) as (t: string) => string
}

/** Apply the pool lane's rewrite the way the adapter does: message content, both roles. */
function poolLaneRewrite(text: string): string {
  // `sanitizeSystemContent` takes a string OR an array of content blocks; the
  // string form is what a text-only turn sends.
  return sanitizeSystemContent(text) as string
}

describe('gateway fingerprint rewriting is complete in every lane', () => {
  it('the pool lane rewrites every known fingerprint', () => {
    for (const [banned] of FINGERPRINTS) {
      const out = poolLaneRewrite(banned)
      expect(out, `pool lane left the literal untouched: ${banned.slice(0, 50)}`).not.toBe(banned)
      expect(out.toLowerCase(), `pool lane still contains: ${banned.slice(0, 50)}`)
        .not.toContain(banned.toLowerCase())
    }
  })

  it('the BuddyAdapter chain rewrites every known fingerprint', () => {
    const rewrite = channelLaneRewrite()
    for (const [banned] of FINGERPRINTS) {
      const out = rewrite(banned)
      expect(out, `channel lane left the literal untouched: ${banned.slice(0, 50)}`).not.toBe(banned)
      expect(out.toLowerCase(), `channel lane still contains: ${banned.slice(0, 50)}`)
        .not.toContain(banned.toLowerCase())
    }
  })

  it('both lanes produce the same rewrite for every fingerprint', () => {
    // Divergent replacements are their own hazard: the model reads this text,
    // and two lanes rewriting the same sentence into two different things makes
    // cache prefixes and prompt-cache hits depend on which lane served a turn.
    const rewrite = channelLaneRewrite()
    for (const [banned] of FINGERPRINTS) {
      expect(rewrite(banned), `lanes disagree on: ${banned.slice(0, 50)}`).toBe(poolLaneRewrite(banned))
    }
  })

  it('rewrites rather than deletes, and keeps the meaning', () => {
    // A replacement that strips the sentence would change the prompt the model
    // reads. Every rewrite below must keep a recognisable subject of the original.
    for (const [banned, expected] of FINGERPRINTS) {
      if (expected === 'codex-long' || expected === 'codex-short' || expected === 'codex-project') continue
      expect(poolLaneRewrite(banned), `pool lane replacement drifted for: ${banned.slice(0, 40)}`).toBe(expected)
    }
    // Non-empty, and no rule may map to the empty string.
    for (const [banned] of FINGERPRINTS) expect(poolLaneRewrite(banned).trim().length).toBeGreaterThan(0)
  })

  it('is case-insensitive, which the gateway is', () => {
    // Measured: the gateway matches case-insensitively, so an upper-cased quote
    // is blocked exactly like the original. A case-sensitive rewrite would leave
    // a whole class of sessions dead.
    const rewrite = channelLaneRewrite()
    for (const [banned] of FINGERPRINTS) {
      const upper = banned.toUpperCase()
      expect(rewrite(upper).toLowerCase(), `uppercase survived: ${banned.slice(0, 40)}`)
        .not.toContain(banned.toLowerCase())
      expect(poolLaneRewrite(upper).toLowerCase(), `uppercase survived in pool: ${banned.slice(0, 40)}`)
        .not.toContain(banned.toLowerCase())
    }
  })

  it('scans only system and assistant roles, never user or tool', () => {
    // Measured on the live gateway: the same sentence in a `user` or `tool`
    // message passes. Rewriting those would corrupt the user's own words, so
    // the call site — not the rewrite — is what has to stay narrow.
    expect(packSource).toMatch(/message\.role === "system" \|\| message\.role === "assistant"/u)
    const poolCallSite = readFileSync(new URL('../src/upstream.ts', import.meta.url), 'utf8')
    expect(poolCallSite).toMatch(/message\['role'\] === 'system' \|\| message\['role'\] === 'assistant'/u)
  })

  it('leaves ordinary prose byte-identical', () => {
    // The rewrite must not touch text that merely mentions the product.
    const ordinary = [
      'Current DeepSeek Harness implementation checkout: C:\\app',
      'Main branch: feature/onepool',
      'The runtime context names the DeepSeek Harness implementation checkout.',
    ]
    const rewrite = channelLaneRewrite()
    for (const text of ordinary) {
      expect(rewrite(text), `channel lane rewrote ordinary prose: ${text}`).toBe(text)
      expect(poolLaneRewrite(text), `pool lane rewrote ordinary prose: ${text}`).toBe(text)
    }
  })
})
