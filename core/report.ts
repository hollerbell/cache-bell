// What /bell report prints: the facts a report of a problem needs, for the person to paste into an issue.
// Numbers, yes and no, and names the plugin or Claude Code chose: nothing the person wrote, no path, no
// address, no key. What comes from outside the plugin (an error's text, a model's name) is shown only in a
// form that cannot carry any of those.

import { DEFAULT_COMPACT_INSTRUCTIONS, DEFAULT_PING_PROMPT, DEFAULT_PREPARE_PROMPT } from './config'
import { MINUTE_MS } from './timing'
import type { Config, State } from './types'
import { formatLeft, formatTtl, grouped } from './view'

type Json = Record<string, unknown>

const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value)

// A model's name as a provider writes it (a dated name, `@` and `:` versions, a `[1m]` suffix), a version
// in digits and dots, a TTL in a few letters and digits. An ARN, anything with an account's twelve digits,
// and anything else is not shown.
const MODEL = /^(?!arn:)[\w.@:[\]-]{1,80}$/
const ACCOUNT = /\d{12}/
const VERSION = /^[\d.]{1,20}$/
const WORD = /^[0-9A-Za-z]{1,8}$/
const HIDDEN = '(not shown)'
const shown = (value: unknown, form: RegExp): string | undefined => {
  if (typeof value !== 'string' || value === '') return undefined
  return form.test(value) && !ACCOUNT.test(value) ? value : HIDDEN
}

// A usage object as numbers under their keys; of anything that is not a number only the key. A key that is
// not a plain word is left out: with a gateway of one's own the keys are the gateway's.
const KEY = /^\w{1,40}$/
const KEYS_MOST = 40
const numbers = (usage: Json, depth = 0): string =>
  Object.entries(usage)
    .filter(([key]) => KEY.test(key))
    .slice(0, KEYS_MOST)
    .map(([key, value]) => {
      if (typeof value === 'number') return `${key}=${value}`
      if (isObject(value) && depth === 0) return `${key}{${numbers(value, 1)}}`
      return key
    })
    .join(' ')

export type Digest = {
  // how many responses of the main thread the text holds
  responses: number
  // the last one's usage, and the model and the Claude Code version its row names
  usage: string | null
  model: string | undefined
  version: string | undefined
}

// The end of a transcript, as far as a report needs it. A line that does not parse is skipped.
export const digestOf = (text: string): Digest => {
  const digest: Digest = { responses: 0, usage: null, model: undefined, version: undefined }
  for (const line of text.split('\n')) {
    let row: unknown
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    if (!isObject(row) || row.type !== 'assistant' || row.isSidechain === true || !isObject(row.message)) continue
    digest.responses += 1
    digest.usage = isObject(row.message.usage) ? numbers(row.message.usage) : null
    digest.model = shown(row.message.model, MODEL)
    digest.version = shown(row.version, VERSION)
  }
  return digest
}

// A notice of the plugin's own, or an error, as far as a report may show it. A notice is the plugin's words,
// a colon, and what went wrong as Claude Code or another plugin said it; that part may name a file, an
// address, a request, or quote a message. Only the plugin's words are kept, and of the rest a code of the
// system's or an error's name, if it holds one.
const CODE = /\b(E[A-Z][A-Z0-9_]{2,20}|[A-Z][A-Za-z]{2,30}Error|exited with \d{1,5})\b/
const HEAD_MOST = 100
export const errorCode = (text: string): string => CODE.exec(text)?.[1] ?? 'an error'
export const noticeHead = (text: string): string => {
  const at = text.indexOf(':')
  if (at < 0) return text.slice(0, HEAD_MOST)
  const code = CODE.exec(text.slice(at + 1))?.[1]
  return `${text.slice(0, Math.min(at, HEAD_MOST))}${code === undefined ? '' : ` (${code})`}`
}

const yesNo = (value: boolean): string => (value ? 'yes' : 'no')
const isSet = (value: string | undefined): boolean => value !== undefined && value !== ''
const isOn = (value: string | undefined): boolean => isSet(value) && !['0', 'false', 'no', 'off'].includes((value ?? '').toLowerCase())
const ago = (now: number, at: number | null): string => (at === null ? 'never' : `${formatLeft(now - at)} ago`)

export type ReportFacts = {
  version: string | undefined
  isWindows: boolean
  surface: string | undefined
  // the model of the last request this instance of the plugin saw
  model: string | undefined
  // environment variables, as read: undefined = not set
  env: { bedrock?: string; vertex?: string; foundry?: string; baseUrl?: string; noCaching?: string; force5m?: string; ttl?: string }
  // what the settings and the environment ask for, in milliseconds; null = nothing
  askedTtlMs: number | null
  contextTokens: number | undefined
  transcript: { isKnown: boolean; exists: boolean | null; size: number | null; readAt: number | null; failed: number; rereadAt: number | null }
  // the end of the transcript, or why it was not read (the plugin's own words); null = there was nothing
  // to read
  tail: Digest | string | null
  // the plugin's last notices, already cut to what a report may show (noticeHead)
  notices: readonly string[]
}

export const REPORT_HEAD = 'Report for an issue. It holds no message text, no file path, no address and no key. Read it before you post it.'

export const problemReport = (state: State, now: number, config: Config, facts: ReportFacts): string => {
  const tail = typeof facts.tail === 'object' ? facts.tail : null
  const rows: string[] = [REPORT_HEAD]
  const where = [`Cache Bell ${facts.version ?? 'version unknown'}`, `Claude Code ${tail?.version ?? 'version not seen'}`, facts.isWindows ? 'Windows' : 'not Windows', facts.surface ?? 'surface unknown']
  rows.push(where.join(' · '))
  const { env } = facts
  // The request's model first; one that may not be shown gives way to the transcript's.
  const asked = shown(facts.model, MODEL)
  const model = asked !== undefined && asked !== HIDDEN ? asked : (tail?.model ?? asked ?? 'not seen')
  rows.push(
    `Model: ${model} · Bedrock ${yesNo(isOn(env.bedrock))} · Vertex ${yesNo(isOn(env.vertex))} · Foundry ${yesNo(isOn(env.foundry))} · own API address ${yesNo(isSet(env.baseUrl))}`,
  )
  rows.push(
    `Cache settings: DISABLE_PROMPT_CACHING ${yesNo(isOn(env.noCaching))} · FORCE_PROMPT_CACHING_5M ${yesNo(isOn(env.force5m))} · CLAUDE_CODE_PROMPT_CACHE_TTL ${shown(env.ttl, WORD) ?? 'not set'} · TTL asked for ${facts.askedTtlMs === null ? 'none' : formatTtl(facts.askedTtlMs)}`,
  )
  const changed = [
    config.preparePrompt === DEFAULT_PREPARE_PROMPT ? '' : 'preparePrompt',
    config.pingPrompt === DEFAULT_PING_PROMPT ? '' : 'pingPrompt',
    config.compactInstructions === DEFAULT_COMPACT_INSTRUCTIONS ? '' : 'compactInstructions',
  ].filter(name => name !== '')
  rows.push(
    [
      `Options: enabled ${config.enabled}`,
      `mode ${config.mode}`,
      `ask ${config.ask}`,
      `maxRenewals ${config.maxRenewals}`,
      `renewMethod ${config.renewMethod}`,
      `prepareBeforeCompact ${config.prepareBeforeCompact}`,
      `compact ${config.compact}`,
      `ttl ${config.ttlMs === null ? 'auto' : formatTtl(config.ttlMs)}`,
      `minContextTokens ${config.minContextTokens}`,
      `compactCountdown ${config.compactCountdownMs / 1000}`,
      `askLeadMinutes ${config.askLeadMs / MINUTE_MS}`,
      `sessionCompact ${config.sessionCompact}`,
      `display ${config.display}`,
      `showBelowMinutes ${config.showBelowMs / MINUTE_MS}`,
      `readTranscript ${config.readTranscript}`,
      `texts changed: ${changed.length === 0 ? 'none' : changed.join(', ')}`,
    ].join(' · '),
  )
  rows.push(
    [
      `State: ${state.phase}`,
      `TTL ${formatTtl(state.ttlMs)} from ${state.ttlSource}`,
      `TTL unread ${yesNo(state.isTtlUnread)}`,
      `last request ${ago(now, state.anchorAt)}`,
      `context ${facts.contextTokens === undefined ? 'unknown' : `${grouped(facts.contextTokens)} tokens`}`,
      `renewals ${state.renewals}`,
    ].join(' · '),
  )
  const { transcript } = facts
  rows.push(
    [
      `Transcript: path known ${yesNo(transcript.isKnown)}`,
      `exists ${transcript.exists === null ? 'not asked' : yesNo(transcript.exists)}`,
      `size ${transcript.size === null ? 'unknown' : `${grouped(transcript.size)} bytes`}`,
      `read for the TTL ${ago(now, transcript.readAt)}`,
      `failed reads ${transcript.failed}`,
      `next try ${transcript.rereadAt === null ? 'none' : `in ${formatLeft(transcript.rereadAt - now)}`}`,
    ].join(' · '),
  )
  if (facts.tail === null) rows.push('End of the transcript: nothing to read')
  else if (typeof facts.tail === 'string') rows.push(`End of the transcript: not read: ${facts.tail}`)
  else rows.push(`End of the transcript: responses of the main thread ${facts.tail.responses} · usage of the last: ${facts.tail.usage ?? 'none'}`)
  rows.push(`The plugin's last notices: ${facts.notices.length === 0 ? 'none' : ''}`)
  for (const notice of facts.notices) rows.push(`  ${notice}`)
  return rows.join('\n')
}
