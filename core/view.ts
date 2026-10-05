// What the person sees, as plain values: the band's line, the status line's entry and the /bell status
// report. The shell only draws them.

import { RENEWALS_CAP } from './config'
import { canRenew, defaultChoice, isGuessed, lifeOf, planOf } from './decide'
import { NONE } from './extension'
import type { Extension } from './extension'
import { MINUTE_MS, TTL_1H, deadlines } from './timing'
import type { ColdReason, Config, State } from './types'

// The plugin's mark and name. The mark is the letter h and a full braille cell.
export const MARK = 'h⣿'
export const NAME = 'Cache Bell'
// The plugin's technical name, as plugin.json has it. Three more places must spell it as a literal, because
// Claude Code reads them from the source: the state's reference and the tool's matcher in hooks/register.tsx
// and the state's contract in types/index.d.ts.
export const PLUGIN = 'cache-bell'
// How every line of the plugin opens: the mark and the product's name.
export const BAND_PREFIX = `${MARK} ${NAME}:`

// The colours, for a dark and for a light background. `letter` and `tile` are the mark's two inks: a teal
// and a lighter signal blue on dark, their dark counterparts on light. Amber is not among them: it means
// that something waits for the person. `warn` and `cold` colour the band's message at the time to act and
// after the cache ran out.
export type Look = 'dark' | 'light'
export const PALETTE: Record<Look, { letter: string; tile: string; warn: string; cold: string }> = {
  dark: { letter: '#3aa3b3', tile: '#7ad8f8', warn: 'yellow', cold: 'cyan' },
  light: { letter: '#073a44', tile: '#00697a', warn: '#8a5a00', cold: '#005f73' },
}

// `theme` is Claude Code's own setting: its light themes all start with "light".
export const lookOf = (theme: unknown): Look => (typeof theme === 'string' && theme.startsWith('light') ? 'light' : 'dark')
export type Tone = 'calm' | 'warn' | 'cold'
export type Band = { text: string; tone: Tone }

// A number with its noun: 1 renewal, 3 renewals.
const count = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? '' : 's'}`

const TEN_MINUTES = 10 * MINUTE_MS

// Seconds matter only near the end: above ten minutes the text changes once a minute, so a session on an
// hour-long cache is not redrawn every second.
export const formatLeft = (ms: number): string => {
  const left = Math.max(0, ms)
  if (left >= TEN_MINUTES) return `${Math.floor(left / MINUTE_MS)} min`
  const seconds = Math.floor(left / 1000)
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

export const formatTtl = (ttlMs: number): string => (ttlMs >= TTL_1H ? '1h' : `${Math.round(ttlMs / MINUTE_MS)}m`)

// A cache that is gone, by why: `short` in the status report, `band` in the band.
const GONE: Record<ColdReason, { short: string; band: string }> = {
  expired: { short: 'expired', band: 'prompt cache expired' },
  sleep: { short: 'expired while the machine slept', band: 'prompt cache expired while the machine slept' },
  'model-switch': { short: 'model changed', band: 'prompt cache lost, the model changed' },
  'renew-missed': { short: 'renewed too late', band: 'prompt cache expired, the renewal came too late' },
  'compact-failed': { short: 'compaction failed', band: 'prompt cache expired, the compaction failed' },
  postponed: { short: 'compaction postponed', band: 'prompt cache expired, the compaction was postponed' },
}

// How long the session was idle, in the unit that reads best: 12 min, 2 h, 2.5 h.
export const formatIdle = (ms: number): string => {
  const minutes = Math.max(0, Math.round(ms / MINUTE_MS))
  if (minutes < 60) return `${minutes} min`
  const halves = Math.round(minutes / 30)
  return `${halves % 2 === 0 ? halves / 2 : (halves / 2).toFixed(1)} h`
}

// What the plugin's own compaction did, for whoever comes back to the session.
export const compactedText = (done: NonNullable<State['lastCompaction']>): string => {
  const sizes = done.before !== null && done.after !== null ? ` ${formatCount(done.before)} → ${formatCount(done.after)} tokens` : ''
  const idle = done.idleMs === null ? '' : ` after ${formatIdle(done.idleMs)} idle`
  return `compacted${sizes}${idle} · /bell log`
}

// A whole number with its thousands apart: 143 985.
export const grouped = (n: number): string => String(n).replace(/\B(?=(\d{3})+$)/g, ' ')

// A size in tokens as short as it reads: 950, 144k, 1.2M.
export const formatCount = (tokens: number): string => {
  if (tokens < 1000) return String(tokens)
  return tokens < 999500 ? `${Math.round(tokens / 1000)}k` : `${(tokens / 1000000).toFixed(1)}M`
}

// What a cold cache costs: the context the next message sends again, by its size when that is known.
export const resent = (contextTokens: number | null): string =>
  contextTokens === null ? 'the next message re-sends the whole context' : `the next message re-sends ${formatCount(contextTokens)} tokens uncached`

// What the band says while the plugin itself is at work.
const WORKING = { RENEWING: 'renewing the prompt cache', PREPARING: 'announcing the compaction', COMPACTING: 'compacting' } as const

// What a compaction that is due waits for.
export const WAITS_FOR = { typing: 'you to finish typing', agent: 'a running subagent' } as const

// The countdown runs to tMax, the last moment a request is still sure to hit the cache, not to the TTL
// itself: the last seconds before the TTL are not safe to rely on.
const leftMs = (state: State, now: number): number =>
  state.anchorAt === null ? 0 : deadlines(state.anchorAt, lifeOf(state)).tMax - now

// A warm cache with plenty of time left is not worth a line: it shows once the time left is down to what
// the person set, or at any time while a compaction waits.
const isShown = (state: State, now: number, config: Config): boolean =>
  config.showBelowMs === 0 || state.held !== null || leftMs(state, now) <= config.showBelowMs

// The band while the TTL is only a guess: what is not known, and what follows from it.
export const UNREAD = 'prompt cache: lifetime not known yet, the transcript could not be read · nothing is renewed or compacted until it is'

const line = (state: State, now: number, config: Config): Band | null => {
  if (state.phase === 'WARM' && state.anchorAt !== null) {
    // Worth a line at any time: the plugin is not doing what it is there for.
    if (state.held === null && isGuessed(state)) return { text: UNREAD, tone: 'calm' }
    if (!isShown(state, now, config)) return null
    // The warning colour says that the cache is about to run out, whether or not the plugin will do anything
    // about it: a countdown alone is worth having.
    const isLate = now >= deadlines(state.anchorAt, lifeOf(state), config.askLeadMs).tAsk
    const after = state.held !== null ? ` · compaction waits for ${WAITS_FOR[state.held.by]}` : state.isDeclined ? ' · nothing will be done' : ''
    return { text: `prompt cache expires in ${formatLeft(leftMs(state, now))}${after}`, tone: isLate ? 'warn' : 'calm' }
  }
  if (state.phase === 'RENEWING' || state.phase === 'PREPARING' || state.phase === 'COMPACTING') {
    return { text: `${WORKING[state.phase]}…`, tone: 'warn' }
  }
  if (state.phase === 'DORMANT' && state.lastCompaction !== null) return { text: compactedText(state.lastCompaction), tone: 'calm' }
  if (state.phase === 'COLD') {
    // The cache ran out with every renewal used up: say how many there were.
    const isSpent = state.coldReason === 'expired' && state.renewals > 0 && !canRenew(state, config)
    const gone = isSpent ? `prompt cache expired after ${count(state.renewals, 'renewal')}` : GONE[state.coldReason ?? 'expired'].band
    return { text: `${gone} · ${resent(state.contextTokens)}`, tone: 'cold' }
  }
  return null
}

export const band = (state: State, now: number, config: Config): Band | null => {
  if (!config.enabled || (config.display !== 'band' && config.display !== 'both')) return null
  const drawn = line(state, now, config)
  return drawn === null ? null : { ...drawn, text: `${BAND_PREFIX} ${drawn.text}` }
}

export const statusEntry = (state: State, now: number, config: Config): string | undefined => {
  if (!config.enabled || (config.display !== 'status' && config.display !== 'both')) return undefined
  if (state.phase === 'WARM') return isShown(state, now, config) ? `cache ${formatLeft(leftMs(state, now))}` : undefined
  if (state.phase === 'COLD') return 'cache cold'
  return undefined
}

const PHASE_TEXT = {
  UNKNOWN: 'unknown (no finished turn yet)',
  BUSY: 'busy (a turn is running)',
  WARM: 'warm',
  ASKING: 'warm, asking what to do',
  RENEWING: 'warm, renewing the cache',
  PREPARING: 'warm, announcing the compaction',
  COMPACTING: 'warm, compacting',
  COLD: 'cold',
  DORMANT: 'dormant (compacted, waiting for new work)',
} as const

const TTL_SOURCE_TEXT = {
  config: 'set in the plugin options',
  transcript: 'read from the transcript',
  'model-switch': 'reported at the model switch',
  settings: 'from the Claude Code settings, not yet confirmed by a response',
  default: 'assumed, not yet seen in the data',
} as const

// version: the plugin's own, as its manifest states it; left out when it could not be read
// `unknown` are the rows about options set to a word they do not take (core/config.ts).
export type Extra = { contextTokens: number | undefined; version?: string | undefined; unknown?: readonly string[] }

// The version a manifest states, from the manifest's text; undefined when it states none or cannot be read.
export const versionOf = (manifest: string): string | undefined => {
  try {
    const version = (JSON.parse(manifest) as { version?: unknown }).version
    return typeof version === 'string' && version !== '' ? version : undefined
  } catch {
    return undefined
  }
}

export const statusReport = (state: State, now: number, config: Config, extra: Extra, extension: Extension = NONE): string => {
  const rows: string[] = []
  // Claude Code prints the plugin's name in front of a command's answer itself.
  // The version comes first: a report of a problem needs it.
  rows.push(`${extra.version === undefined ? '' : `version ${extra.version} · `}${config.enabled ? 'on' : 'off'}, mode ${config.mode}`)
  rows.push(`State: ${PHASE_TEXT[state.phase]}${state.phase === 'COLD' && state.coldReason ? `, ${GONE[state.coldReason].short}` : ''}`)
  const isUnsure = isGuessed(state)
  rows.push(`Cache TTL: ${formatTtl(state.ttlMs)} (${isUnsure ? 'assumed: the transcript could not be read, it is tried again' : TTL_SOURCE_TEXT[state.ttlSource]})`)
  if (state.anchorAt === null) {
    rows.push('Last request to the API: none seen')
  } else {
    const { tAsk, tAct, tMax } = deadlines(state.anchorAt, state.ttlMs, config.askLeadMs)
    rows.push(`Last request to the API: ${formatLeft(now - state.anchorAt)} ago`)
    if (state.phase === 'WARM' && isUnsure && state.held === null) {
      rows.push('Next: nothing is asked, renewed or compacted until the TTL is read')
    } else if (state.phase === 'WARM') {
      // Only what will really happen, by its name: a mode that does not ask has no time to ask, and so on.
      const { asks, acts } = planOf(state, config)
      const does = defaultChoice(state, config) === 'renew' ? 'renews' : 'compacts'
      const coming = [asks ? `asks in ${formatLeft(tAsk - now)}` : '', acts ? `${does} in ${formatLeft(tAct - now)}` : '', `cache lost in ${formatLeft(tMax - now)}`]
      const isSmall = state.contextTokens !== null && state.contextTokens < config.minContextTokens
      const why = isSmall && config.enabled && !state.isDeclined ? ` (context below ${grouped(config.minContextTokens)} tokens)` : ''
      rows.push(`Next: ${asks || acts ? '' : 'nothing, '}${coming.filter(part => part !== '').join(', ')}${why}`)
    }
  }
  rows.push(`Context: ${extra.contextTokens === undefined ? 'not known yet' : `${grouped(extra.contextTokens)} tokens`}`)
  if (state.held !== null) rows.push(`Compaction waits for ${WAITS_FOR[state.held.by]}`)
  rows.push(...extension.status(state))
  if (state.renewals > 0 || state.isDeclined) {
    const sent = state.renewalsSent > state.renewals ? ` (${count(state.renewalsSent, 'request')} sent, ${RENEWALS_CAP} at most)` : ''
    rows.push(`Renewed ${count(state.renewals, 'time')} of ${config.maxRenewals}${sent}${state.isDeclined ? ', the cache will be left to expire' : ''}`)
  }
  if (config.maxRenewalsAsked !== null) {
    rows.push(`maxRenewals is set to ${config.maxRenewalsAsked}, outside 0 to ${RENEWALS_CAP}: ${config.maxRenewals} is used`)
  }
  rows.push(...(extra.unknown ?? []))
  return rows.join('\n')
}

// The band in each of its looks, for a screenshot: at rest, at the time to act, after the cache ran out.
export const sampleBand = (look: string): Band | null => {
  const prefix = BAND_PREFIX
  if (look === 'calm') return { text: `${prefix} prompt cache expires in 42 min`, tone: 'calm' }
  if (look === 'act') return { text: `${prefix} prompt cache expires in 4:10`, tone: 'warn' }
  if (look === 'cold') return { text: `${prefix} ${GONE.expired.band} · ${resent(144000)}`, tone: 'cold' }
  return null
}

// What the person is told once, the first time the plugin runs on the machine: what it does without them
// and where to change that. `head` follows the mark and the name; `rows` and `hint` stand under it.
export type Intro = { head: string; rows: string[]; once: string; hint: string }

// The key the plugin's store keeps "the notice was seen" under, and the value it keeps: a notice that says
// something new gets a new number and is shown again.
export const INTRO_KEY = 'intro'
export const INTRO_SEEN = 1

export const introOf = (config: Config): Intro | null => {
  if (!config.enabled) return null
  const renews = config.renewMethod !== 'none' && config.maxRenewals !== 0
  const steps: string[] = []
  if (renews) steps.push(`renews the prompt cache up to ${count(config.maxRenewals, 'time')}`)
  if (config.compact) steps.push('compacts the conversation')
  const rows: string[] = []
  if (steps.length > 0) rows.push(`before the prompt cache expires it ${steps.join(', then ')}`)
  if (config.sessionCompact === 'confirm') rows.push(`Claude may ask for a compaction too: you get ${Math.round(config.compactCountdownMs / 1000)} s to cancel, or the time Claude names`)
  if (config.sessionCompact === 'auto') rows.push('Claude may ask for a compaction too, and gets it at once')
  // Nothing happens without the person: nothing to tell.
  if (rows.length === 0) return null
  return {
    head: steps.length > 0 ? ' while you are away this plugin acts on its own, on your plan' : ' this plugin can compact the conversation without you',
    rows,
    once: 'this notice is shown once: OK or your next message puts it away for good',
    hint: `change it in /config: ${PLUGIN}.mode, ${PLUGIN}.sessionCompact, ${PLUGIN}.enabled`,
  }
}
