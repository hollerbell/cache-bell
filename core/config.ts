// plugin.json's userConfig → the configuration the core works with. Claude Code checks only the type of a
// value; which words an option takes, and the bounds of a number, are kept here. A value that makes no sense
// falls back to its default instead of failing the load, and /bell status says so.

import { MINUTE_MS, parseTtl } from './timing'
import type { Config, Mode } from './types'

// What the session is told before a compaction the plugin starts on its own: only that it is coming. What
// to keep is the summary's own business.
export const DEFAULT_PREPARE_PROMPT =
  'This conversation will be compacted right after this turn. Nothing is needed from you: a one-line reply is enough.'

export const DEFAULT_PING_PROMPT = 'This request only keeps the prompt cache warm. Answer with the single word: ok'

// Empty: the compaction runs as a plain /compact would. {time} and {idle} are filled in when the person
// sets instructions of their own.
export const DEFAULT_COMPACT_INSTRUCTIONS = ''

export const DEFAULT_MODE: Mode = 'prepare-compact'

type Options = Readonly<Record<string, unknown>>

// Every option with the default plugin.json gives it. A test holds this table to
// what the configuration resolves to with no options set.
export type OptionValue = boolean | string | number
export const OPTION_DEFAULTS: Readonly<Record<string, OptionValue>> = {
  enabled: true,
  mode: DEFAULT_MODE,
  ask: 'first',
  maxRenewals: 2,
  renewMethod: 'fork',
  prepareBeforeCompact: true,
  compact: true,
  preparePrompt: DEFAULT_PREPARE_PROMPT,
  pingPrompt: DEFAULT_PING_PROMPT,
  compactInstructions: DEFAULT_COMPACT_INSTRUCTIONS,
  ttl: 'auto',
  minContextTokens: 100000,
  compactCountdown: 30,
  sessionCompact: 'confirm',
  askLeadMinutes: 0,
  display: 'band',
  showBelowMinutes: 30,
  readTranscript: true,
}

type Behaviour = Pick<Config, 'ask' | 'maxRenewals' | 'maxRenewalsAsked' | 'renewMethod' | 'prepareBeforeCompact' | 'compact'>

// The most renewals of one idle period, in every mode: each renewal reads the whole context on the person's
// plan, and a session left open for a week must not do that for a week. Fixed here, not an option.
export const RENEWALS_CAP = 3
const NO_LIMIT = -1

export const PRESETS: Record<Exclude<Mode, 'custom'>, Behaviour> = {
  notify: { ask: 'first', maxRenewals: 0, maxRenewalsAsked: null, renewMethod: 'none', prepareBeforeCompact: false, compact: false },
  keep: { ask: 'never', maxRenewals: RENEWALS_CAP, maxRenewalsAsked: null, renewMethod: 'fork', prepareBeforeCompact: false, compact: false },
  'prepare-compact': { ask: 'first', maxRenewals: 2, maxRenewalsAsked: null, renewMethod: 'fork', prepareBeforeCompact: true, compact: true },
  'compact-only': { ask: 'never', maxRenewals: 0, maxRenewalsAsked: null, renewMethod: 'none', prepareBeforeCompact: false, compact: true },
}

// The options that take one of a few words, with those words. /config shows each as a row of free text.
export const WORDS = {
  mode: ['notify', 'keep', 'prepare-compact', 'compact-only', 'custom'],
  ask: ['first', 'every', 'never'],
  renewMethod: ['fork', 'none'],
  ttl: ['auto', '5m', '1h'],
  sessionCompact: ['confirm', 'wait', 'auto', 'off'],
  display: ['band', 'status', 'both', 'off'],
} as const

const oneOf = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
  allowed.includes(value as T) ? (value as T) : fallback

// The options only the custom mode reads: under a preset their value, right or wrong, decides nothing.
const CUSTOM_ONLY: readonly string[] = ['ask', 'renewMethod']

// What /bell status says of each such option that is set to something else: the default is used instead.
// An option that is not set at all is not a mistake, and neither is one the mode in use does not read.
export const unknownWords = (options: Options): string[] =>
  Object.entries(WORDS)
    .filter(([name]) => !CUSTOM_ONLY.includes(name) || oneOf<Mode>(options.mode, WORDS.mode, DEFAULT_MODE) === 'custom')
    .filter(([name, allowed]) => options[name] !== undefined && !(allowed as readonly unknown[]).includes(options[name]))
    .map(([name, allowed]) => `${name} is set to ${JSON.stringify(options[name])}, which is not one of ${allowed.join(', ')}; the default, ${String(OPTION_DEFAULTS[name])}, is used`)

const bool = (value: unknown, fallback: boolean): boolean => (typeof value === 'boolean' ? value : fallback)

const text = (value: unknown, fallback: string): string => (typeof value === 'string' ? value : fallback)

// A whole number within its bounds; anything else gets the default.
export const whole = (value: unknown, low: number, high: number, fallback: number): number =>
  typeof value === 'number' && Number.isInteger(value) && value >= low && value <= high ? value : fallback

// The number of renewals asked for, held within 0 and the cap. A number outside is taken to the nearer end
// and remembered, so the status report can say what was done with it.
const renewals = (value: unknown): Pick<Config, 'maxRenewals' | 'maxRenewalsAsked'> => {
  if (typeof value !== 'number' || !Number.isInteger(value)) return { maxRenewals: 2, maxRenewalsAsked: null }
  // -1 used to mean no limit: whoever set it wanted the most there is, not an immediate compaction.
  const held = value === NO_LIMIT ? RENEWALS_CAP : Math.min(Math.max(value, 0), RENEWALS_CAP)
  return { maxRenewals: held, maxRenewalsAsked: held === value ? null : value }
}

export const resolveConfig = (options: Options): Config => {
  const mode = oneOf<Mode>(options.mode, WORDS.mode, DEFAULT_MODE)
  const custom: Behaviour = {
    ask: oneOf(options.ask, WORDS.ask, 'first'),
    ...renewals(options.maxRenewals),
    renewMethod: oneOf(options.renewMethod, WORDS.renewMethod, 'fork'),
    prepareBeforeCompact: bool(options.prepareBeforeCompact, true),
    compact: bool(options.compact, true),
  }
  const behaviour = mode === 'custom' ? custom : PRESETS[mode]

  return {
    enabled: bool(options.enabled, true),
    mode,
    ...behaviour,
    preparePrompt: text(options.preparePrompt, DEFAULT_PREPARE_PROMPT),
    pingPrompt: text(options.pingPrompt, DEFAULT_PING_PROMPT),
    compactInstructions: text(options.compactInstructions, DEFAULT_COMPACT_INSTRUCTIONS),
    ttlMs: parseTtl(options.ttl),
    minContextTokens: whole(options.minContextTokens, 0, 10_000_000, 100000),
    compactCountdownMs: whole(options.compactCountdown, 5, 3600, 30) * 1000,
    askLeadMs: whole(options.askLeadMinutes, 0, 600, 0) * MINUTE_MS,
    sessionCompact: oneOf(options.sessionCompact, WORDS.sessionCompact, 'confirm'),
    display: oneOf(options.display, WORDS.display, 'band'),
    showBelowMs: whole(options.showBelowMinutes, 0, 600, 30) * MINUTE_MS,
    readTranscript: bool(options.readTranscript, true),
  }
}
