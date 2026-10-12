// What the person sees, as plain values: the band's line, the status line's entry and the /bell status
// report. The shell only draws them.

import { RENEWALS_CAP } from './config'
import { canRenew, defaultChoice, isGuessed, levelOf, lifeOf, planOf } from './decide'
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

// The band while the TTL is only a guess: what is not known, why, and what follows from it.
export const UNREAD = 'prompt cache: lifetime not known yet, the transcript could not be read · nothing is renewed or compacted until it is'
export const UNSEEN = 'prompt cache: lifetime not known yet · nothing is renewed or compacted until a response shows it or you set the cacheTtl option'
export const UNNAMED = 'prompt cache: lifetime not known, reading the transcript is off · nothing is renewed or compacted until you set the cacheTtl option'
const guessText = (state: State, config: Config): string => (state.isTtlUnread ? UNREAD : config.readTranscript ? UNSEEN : UNNAMED)

// What the band adds to a countdown behind a guess (only while a compaction waits), after the word and the lifetime.
export const ASSUMED = 'assumed, not yet seen in the data'

const line = (state: State, now: number, config: Config): Band | null => {
  if (state.phase === 'WARM' && state.anchorAt !== null) {
    // Worth a line at any time: the plugin is not doing what it is there for.
    if (state.held === null && isGuessed(state)) return { text: guessText(state, config), tone: 'calm' }
    if (!isShown(state, now, config)) return null
    // The warning colour says that the cache is about to run out, whether or not the plugin will do anything
    // about it: a countdown alone is worth having.
    const isLate = now >= deadlines(state.anchorAt, lifeOf(state), config.askLeadMs).tAsk
    const after = state.held !== null ? ` · compaction waits for ${WAITS_FOR[state.held.by]}` : state.isDeclined ? ' · nothing will be done' : ''
    // No response showed the lifetime, the countdown runs on the hour a guess is given: said with it, or it
    // reads as a fact.
    const assumed = isGuessed(state) ? ` · lifetime ${formatTtl(lifeOf(state))} ${ASSUMED}` : ''
    return { text: `prompt cache expires in ${formatLeft(leftMs(state, now))}${assumed}${after}`, tone: isLate ? 'warn' : 'calm' }
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
  // Behind a guess the countdown runs on the hour, and the cache may well be gone in five minutes: no
  // countdown read as a fact, unless a compaction waits and the band says what it is counted on.
  if (state.phase === 'WARM' && state.held === null && isGuessed(state)) return 'cache lifetime unknown'
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
  'model-switch': 'asked for at the model switch, not yet confirmed by a response',
  requested: 'asked for by Cache Bell (cacheRequestHour), not yet confirmed by a response',
  settings: 'from the Claude Code settings, not yet confirmed by a response',
  default: 'assumed, not yet seen in the data',
} as const

// Where the hour-long cache stands, as the shell finds the environment: the plugin's own hour is set ('asked'),
// it is wanted (cacheRequestHour, or the person's answer) but a TTL of the person's own is set ('own-ttl'), cacheTtl is 5m ('cache-ttl'), or the cache was not yet cold anyway
// ('waiting'), or it is no longer wanted and the plugin's hour is still set ('taking-back'). null: nothing to say.
export type HourState = 'asked' | 'own-ttl' | 'cache-ttl' | 'waiting' | 'taking-back' | null

// version: the plugin's own, as its manifest states it; left out when it could not be read
// `unknown` are the rows about options set to a word they do not take (core/config.ts).
export type Extra = { contextTokens: number | undefined; version?: string | undefined; unknown?: readonly string[]; hour?: HourState }

// The row of /bell status about the hour-long cache; null when there is nothing to say. Whether the hour was
// granted only a response shows: the transcript's TTL after the plugin asked.
export const hourRow = (state: State, hour: HourState): string | null => {
  const head = 'Hour-long cache:'
  if (hour === 'own-ttl') return `${head} on, but a TTL of your own is set; nothing is asked for`
  if (hour === 'cache-ttl') return `${head} on, but not asked for, because ${PLUGIN}.cacheTtl is 5m`
  if (hour === 'waiting') return `${head} on, asked for at the next moment the cache is cold anyway`
  if (hour === 'taking-back') return `${head} off, the hour asked for earlier goes with the next request`
  if (hour !== 'asked') return null
  if (state.ttlSource !== 'transcript') return `${head} asked for, not yet confirmed by a response`
  return state.ttlMs === TTL_1H ? `${head} asked for and granted` : `⚠ ${head} ${HOUR_NOT_GRANTED_ROW}`
}

export const HOUR_NOT_GRANTED_ROW = 'asked for, but the API granted only 5 minutes; the plugin times the cache on 5 minutes'

// The version a manifest states, from the manifest's text; undefined when it states none or cannot be read.
export const versionOf = (manifest: string): string | undefined => {
  try {
    const version = (JSON.parse(manifest) as { version?: unknown }).version
    return typeof version === 'string' && version !== '' ? version : undefined
  } catch {
    return undefined
  }
}

// The profile as /bell shows it at the top: bellcompact with the level the session compacts from, and
// whether /bell set gave this session its own.
export const profileText = (state: State, config: Config): string => {
  if (config.profile !== 'bellcompact') return config.profile
  const level = levelOf(state, config)
  const own = (state.levelTokens ?? null) === null ? '' : ', this session'
  return `bellcompact[${level > 0 ? `${level / 1000}K` : 'off'}${own}]`
}

// What the options make the plugin do, in one sentence under the top row of /bell.
export const whatHappens = (state: State, config: Config): string => {
  if (!config.enabled || config.profile === 'off') return 'Cache Bell does nothing in this session.'
  if (config.profile === 'watch') return 'Cache Bell only shows how long the cache lasts; it sends nothing and tells Claude nothing.'
  const level = levelOf(state, config)
  const parts: string[] = []
  if (level > 0 && config.sessionCompact !== 'off') parts.push(`past ${level / 1000}K Claude is asked to compact at a good moment`)
  const isActing = config.maxRenewals > 0 || config.compact
  const idle = [
    config.ask === 'never' ? '' : isActing ? 'asks first' : 'asks what to do before the cache expires',
    config.maxRenewals > 0 ? `renews the cache up to ${count(config.maxRenewals, 'time')}` : '',
    config.compact ? `then compacts before it expires${config.compactHourOnly ? ' (only with the hour-long cache)' : ''}` : '',
  ].filter(part => part !== '')
  if (idle.length > 0) parts.push(`when idle above ${config.minContextTokens / 1000}K, Cache Bell ${idle.join(', ').replace(/^then /, '')}`)
  const sentence = parts.join('; ')
  return sentence === '' ? 'Cache Bell shows how long the cache lasts and sends nothing on its own.' : `${sentence[0]?.toUpperCase()}${sentence.slice(1)}.`
}

export const statusReport = (state: State, now: number, config: Config, extra: Extra, extension: Extension = NONE): string => {
  const rows: string[] = []
  // Claude Code prints the plugin's name in front of a command's answer itself.
  // The version comes first: a report of a problem needs it.
  rows.push(`${extra.version === undefined ? '' : `version ${extra.version} · `}${config.enabled ? 'on' : 'off'}, ${profileText(state, config)}`)
  rows.push(whatHappens(state, config))
  rows.push(`State: ${PHASE_TEXT[state.phase]}${state.phase === 'COLD' && state.coldReason ? `, ${GONE[state.coldReason].short}` : ''}`)
  const isUnsure = isGuessed(state)
  // A guess names what was asked for; a compaction that waits behind it waits for the hour, which may be more.
  const counted = isUnsure && state.held !== null && lifeOf(state) !== state.ttlMs ? `, a waiting compaction counts on ${formatTtl(lifeOf(state))} until the TTL is known` : ''
  rows.push(`Cache TTL: ${formatTtl(state.ttlMs)} (${isUnsure && state.isTtlUnread ? 'assumed: the transcript could not be read, it is tried again' : TTL_SOURCE_TEXT[state.ttlSource]})${counted}`)
  const hour = hourRow(state, extra.hour ?? null)
  if (hour !== null) rows.push(hour)
  if (state.anchorAt === null) {
    rows.push('Last request to the API: none seen')
  } else {
    const { tAsk, tAct, tMax } = deadlines(state.anchorAt, lifeOf(state), config.askLeadMs)
    rows.push(`Last request to the API: ${formatLeft(now - state.anchorAt)} ago`)
    if (state.phase === 'WARM' && isUnsure && state.held === null) {
      rows.push(`Next: nothing is asked, renewed or compacted ${state.isTtlUnread ? 'until the TTL is read' : config.readTranscript ? 'until a response shows the TTL' : 'until you set the cacheTtl option'}`)
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
    rows.push(`idleRenewals is set to ${config.maxRenewalsAsked}, outside 0 to ${RENEWALS_CAP}: ${config.maxRenewals} is used`)
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
// `question`: the notice asks something, answered by one of `choices` in place of OK; `isSecond`: it is the
// second chance to answer it (secondChanceOf), not the first-run notice.
export type IntroChoice = { key: string; label: string; answer: HourAnswer; rhythm?: Rhythm }
export type Intro = { head: string; rows: string[]; once: string; hint: string; question?: string; choices?: readonly IntroChoice[]; isSecond?: boolean }

// The key the plugin's store keeps "the notice was seen" under, and the value it keeps: a notice that says
// something new gets a new number and is shown again. 1 was the notice before it asked about the hour.
export const INTRO_KEY = 'intro'
export const INTRO_SEEN = 2
export const INTRO_SEEN_BEFORE_HOUR = 1

// The person's answer about the hour-long cache, on this machine: 'yes' or 'no'; and whether the second
// chance to answer was given.
export const HOUR_KEY = 'hour'
export const HOUR_SECOND_KEY = 'hourSecond'
export type HourAnswer = 'yes' | 'no'
export const isHourAnswer = (value: unknown): value is HourAnswer => value === 'yes' || value === 'no'

// What the person does after Claude's reply, as they answered it: the cache counts from the last request,
// so this is the pause it has to outlast. Only a return within the hour is helped by the hour-long cache:
// a shorter pause the five minutes cover, a longer one outlasts the hour too. Kept for later versions.
export const RHYTHM_KEY = 'rhythm'
export type Rhythm = 'soon' | 'within-hour' | 'hours'

const HOUR_QUESTION = 'When Claude finishes a reply, what do you usually do next?'
const RHYTHM_CHOICES: readonly IntroChoice[] = [
  { key: 'intro-soon', label: 'Reply within a few minutes', answer: 'no', rhythm: 'soon' },
  { key: 'intro-hour', label: 'Step away, and come back within the hour', answer: 'yes', rhythm: 'within-hour' },
  { key: 'intro-hours', label: 'Leave it for hours, or for another day', answer: 'no', rhythm: 'hours' },
]
const HOUR_HINT = '/bell hour on|off changes it later'
// What the hour costs, stated wherever the plugin asks about it.
export const HOUR_PRICE = 'on the API, writing to an hour-long cache costs twice the base input price, against 1.25 times for a five-minute one; reading costs the same for both. How this counts toward Pro, Max or Team limits is not published'

// What the row of a call of the compact tool draws: the reason alone, on one line. The terminal sets a call's
// input behind the opening bracket and wraps a long value there into a tall, narrow column, and resumeWith may
// run to 2000 characters. The model got the whole input; this is only what the row shows.
export const COMPACT_TOOL = `mcp__${PLUGIN}__compact`
const ROW_HEAD = `● ${PLUGIN} - compact (MCP)(reason: "")`
export const compactRowInput = (input: unknown, columns: number): Record<string, unknown> => {
  const given = (input ?? {}) as { reason?: unknown; cancel?: unknown }
  if (given.cancel === true) return { cancel: true }
  if (typeof given.reason !== 'string') return {}
  const room = Math.max(12, columns - ROW_HEAD.length - 1)
  const chars = Array.from(given.reason.replace(/\s+/g, ' ').trim())
  return { reason: chars.length <= room ? chars.join('') : `${chars.slice(0, room - 1).join('')}…` }
}

// Whether Claude is told to compact past the level of the options, which 0.2.x never did by default.
export const compactsAtLevel = (config: Config): boolean => config.compactAtTokens > 0 && config.sessionCompact !== 'off'

// asksHour: the notice also asks about the rhythm of work (nobody answered it on this machine yet, and the
// hour is not set otherwise). isUpgrade: the machine ran 0.2.x (or 0.3.0, 0.3.1), whose default never had
// Claude compact at a size: the notice says that this is new and how to keep what there was.
export const introOf = (config: Config, asksHour = false, isUpgrade = false): Intro | null => {
  if (!config.enabled) return null
  const renews = config.maxRenewals !== 0
  const steps: string[] = []
  if (renews) steps.push(`renews the prompt cache up to ${count(config.maxRenewals, 'time')}`)
  if (config.compact) steps.push(config.compactHourOnly ? 'compacts the conversation (with the hour-long cache only)' : 'compacts the conversation')
  const rows: string[] = []
  if (steps.length > 0) rows.push(`before the prompt cache expires it ${steps.join(', then ')}`)
  if (compactsAtLevel(config)) {
    const level = config.compactAtTokens / 1000
    const countdown = config.sessionCompact === 'confirm' ? ', with a countdown to cancel' : ''
    rows.push(isUpgrade
      ? `new in 0.3.4: by default, Claude now compacts by itself once the context passes ${level}K, after a finished piece of work${countdown}. For warnings only, set ${PLUGIN}.profile to watch; the CHANGELOG has the details`
      : `past ${level}K Claude compacts the conversation itself at a good moment (/bell set changes it for this session)`)
  }
  if (config.sessionCompact === 'confirm') rows.push(`Claude may ask for a compaction too: you get ${Math.round(config.compactCountdownMs / 1000)} s to cancel, or the time Claude names`)
  if (config.sessionCompact === 'auto') rows.push('Claude may ask for a compaction too, and gets it at once')
  // Nothing happens without the person and nothing to ask: nothing to tell.
  if (rows.length === 0 && !asksHour) return null
  const hint = `change it in /config: ${PLUGIN}.profile, ${PLUGIN}.compactOnRequest, ${PLUGIN}.enabled`
  const head = steps.length > 0 ? ' while you are away this plugin acts on its own, on your plan' : rows.length > 0 ? ' this plugin can compact the conversation without you' : ' one question about how you work'
  if (!asksHour) return { head, rows, once: 'this notice is shown once: OK or your next message puts it away for good', hint }
  return {
    head,
    rows: [...rows, HOUR_PRICE],
    once: 'this notice is shown once: an answer or your next message puts it away for good; only "within the hour" asks for the hour-long prompt cache',
    hint: `${hint} · ${HOUR_HINT}`,
    question: HOUR_QUESTION,
    choices: RHYTHM_CHOICES,
  }
}

// The second chance, once on a machine: the person came back `minutes` after a compaction of the plugin's
// own, within the hour, which the hour-long cache would have spared.
export const secondChanceOf = (minutes: number): Intro => ({
  head: ` you came back ${count(minutes, 'minute')} after a compaction`,
  rows: ['with the hour-long prompt cache the conversation would still have been warm, with nothing to compact', HOUR_PRICE],
  once: 'asked once: an answer or your next message puts it away',
  hint: HOUR_HINT,
  question: 'Switch to the hour-long cache?',
  choices: [
    { key: 'intro-yes', label: 'Yes', answer: 'yes' },
    { key: 'intro-no', label: 'No', answer: 'no' },
  ],
  isSecond: true,
})
