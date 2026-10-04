// plugin.json's userConfig → the configuration the core works with. Claude Code checks only the type of a
// value and, for a picker, that it is one of the options; bounds are kept here. A value that makes no sense
// falls back to its default instead of failing the load.

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

// Every option with the default plugin.json gives it: what /bell reset puts back. A test holds this table to
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

// What a reset did, in words: which options were put back, which Claude Code would not change.
export const resetReport = (changed: readonly string[], denied: readonly string[]): string => {
  const rows: string[] = []
  if (changed.length > 0) rows.push(`Put back to the default: ${changed.join(', ')}.`)
  if (denied.length > 0) rows.push(`Not changed, Claude Code refused: ${denied.join(', ')}.`)
  return rows.length === 0 ? 'Every option already has its default.' : rows.join('\n')
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

const oneOf = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
  allowed.includes(value as T) ? (value as T) : fallback

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
  const mode = oneOf<Mode>(options.mode, ['notify', 'keep', 'prepare-compact', 'compact-only', 'custom'], DEFAULT_MODE)
  const custom: Behaviour = {
    ask: oneOf(options.ask, ['first', 'every', 'never'], 'first'),
    ...renewals(options.maxRenewals),
    renewMethod: oneOf(options.renewMethod, ['fork', 'none'], 'fork'),
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
    sessionCompact: oneOf(options.sessionCompact, ['confirm', 'wait', 'auto', 'off'], 'confirm'),
    display: oneOf(options.display, ['band', 'status', 'both', 'off'], 'band'),
    showBelowMs: whole(options.showBelowMinutes, 0, 600, 30) * MINUTE_MS,
    readTranscript: bool(options.readTranscript, true),
  }
}
