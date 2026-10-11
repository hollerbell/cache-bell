// plugin.json's userConfig → the configuration the core works with. Claude Code checks the type of a value
// and, where the manifest lists the words an option takes, the word; the same words and the bounds of a
// number are kept here too. A value that still makes no sense falls back to its default instead of failing
// the load.

import { MINUTE_MS, parseTtl } from './timing'
import type { Config, Profile } from './types'

// What the session is told before a compaction the plugin starts on its own: only that it is coming. What
// to keep is the summary's own business.
export const DEFAULT_PREPARE_PROMPT =
  'This conversation will be compacted right after this turn. Nothing is needed from you: a one-line reply is enough.'

export const DEFAULT_PING_PROMPT = 'This request only keeps the prompt cache warm. Answer with the single word: ok'

// Empty: the compaction runs as a plain /compact would. {time} and {idle} are filled in when the person
// sets instructions of their own.
export const DEFAULT_COMPACT_INSTRUCTIONS = ''

export const DEFAULT_PROFILE: Profile = 'bellcompact'

type Options = Readonly<Record<string, unknown>>

// Every option with the default plugin.json gives it. A test holds this table to what the configuration
// resolves to with no options set. `mode` is 0.2.x's and has no default: only a value somebody set comes in.
export type OptionValue = boolean | string | number
export const OPTION_DEFAULTS: Readonly<Record<string, OptionValue>> = {
  enabled: true,
  profile: DEFAULT_PROFILE,
  compactLevelK: 200,
  compactContextNotices: true,
  compactOnRequest: 'confirm',
  compactCountdown: 30,
  compactInstructions: DEFAULT_COMPACT_INSTRUCTIONS,
  idleMinContextK: 80,
  idleAsk: 'first',
  idleAskAheadMinutes: 0,
  idleRenewals: 2,
  idleRenewPrompt: DEFAULT_PING_PROMPT,
  idleCompact: 'auto',
  idleAnnounce: true,
  idleAnnouncePrompt: DEFAULT_PREPARE_PROMPT,
  cacheTtl: 'auto',
  cacheRequestHour: 'ask',
  display: 'status',
  displayBelowMinutes: 15,
}

// The most renewals of one idle period, in every profile: each renewal reads the whole context on the
// person's plan, and a session left open for a week must not do that for a week. Fixed here, not an option.
export const RENEWALS_CAP = 3

// The options that take one of a few words, with those words. The manifest of the main build lists the same
// words, so /config offers them to pick from; the directory's build has no lists, and a word that is none of
// them gets the default here.
export const WORDS = {
  profile: ['off', 'watch', 'bellcompact'],
  compactOnRequest: ['confirm', 'wait', 'auto', 'off'],
  idleAsk: ['first', 'every', 'never'],
  idleCompact: ['auto', 'on', 'off'],
  cacheTtl: ['auto', 'settings', '5m', '1h'],
  cacheRequestHour: ['ask', 'on', 'off'],
  display: ['band', 'status', 'both', 'off'],
} as const

const oneOf = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
  allowed.includes(value as T) ? (value as T) : fallback

// What /bell status says of each such option that is set to something else: the default is used instead.
// An option that is not set at all is not a mistake.
export const unknownWords = (options: Options): string[] =>
  Object.entries(WORDS)
    .filter(([name, allowed]) => options[name] !== undefined && !(allowed as readonly unknown[]).includes(options[name]))
    .map(([name, allowed]) => `${name} is set to ${JSON.stringify(options[name])}, which is not one of ${allowed.join(', ')}; the default, ${String(OPTION_DEFAULTS[name] ?? 'none')}, is used`)

// What 0.2.x's mode stands for now, for an option the person set before profiles came. A value of the new
// options set by the person wins over it. Its custom mode stands for nothing: the options it read are gone.
type Legacy = { profile: Profile; compactLevelK?: number; idleAsk?: 'never'; idleCompact?: 'on' | 'off'; idleRenewals?: number; idleAnnounce?: boolean }
const FROM_MODE: Record<'notify' | 'keep' | 'prepare-compact' | 'compact-only', Legacy> = {
  notify: { profile: 'watch' },
  keep: { profile: 'bellcompact', compactLevelK: 0, idleAsk: 'never', idleCompact: 'off', idleRenewals: RENEWALS_CAP },
  'prepare-compact': { profile: 'bellcompact' },
  'compact-only': { profile: 'bellcompact', idleAsk: 'never', idleCompact: 'on', idleRenewals: 0, idleAnnounce: false },
}
const legacyOf = (mode: unknown): Partial<Legacy> =>
  typeof mode === 'string' && Object.hasOwn(FROM_MODE, mode) ? FROM_MODE[mode as keyof typeof FROM_MODE] : {}

// What the profile leaves of the options: watch sends nothing and tells the session nothing.
const WATCH: Partial<Config> = { ask: 'never', maxRenewals: 0, maxRenewalsAsked: null, prepareBeforeCompact: false, compact: false, compactHourOnly: false, compactAtTokens: 0, contextNotices: false, sessionCompact: 'off' }

const bool = (value: unknown, fallback: boolean): boolean => (typeof value === 'boolean' ? value : fallback)

const text = (value: unknown, fallback: string): string => (typeof value === 'string' ? value : fallback)

// A whole number within its bounds; anything else gets the default.
export const whole = (value: unknown, low: number, high: number, fallback: number): number =>
  typeof value === 'number' && Number.isInteger(value) && value >= low && value <= high ? value : fallback

// The number of renewals asked for, held within 0 and the cap. A number outside is taken to the nearer end
// and remembered, so the status report can say what was done with it.
const renewals = (value: unknown): Pick<Config, 'maxRenewals' | 'maxRenewalsAsked'> => {
  if (typeof value !== 'number' || !Number.isInteger(value)) return { maxRenewals: 2, maxRenewalsAsked: null }
  const held = Math.min(Math.max(value, 0), RENEWALS_CAP)
  return { maxRenewals: held, maxRenewalsAsked: held === value ? null : value }
}

// An option's value, or what 0.2.x's mode stands for where the option still holds its default: Claude Code
// fills in defaults, so a value the person set to the default cannot be told from one never set.
const orLegacy = <T,>(value: T, fallback: T, legacy: T | undefined): T => (value === fallback && legacy !== undefined ? legacy : value)

export const resolveConfig = (options: Options): Config => {
  const legacy = legacyOf(options.mode)
  const profile = orLegacy(oneOf<Profile>(options.profile, WORDS.profile, DEFAULT_PROFILE), DEFAULT_PROFILE, legacy.profile)
  const idleCompact = orLegacy(oneOf(options.idleCompact, WORDS.idleCompact, 'auto'), 'auto', legacy.idleCompact)
  const settings: Config = {
    // Switched off, the plugin is off whatever the profile.
    enabled: bool(options.enabled, true) && profile !== 'off',
    profile,
    ask: orLegacy(oneOf(options.idleAsk, WORDS.idleAsk, 'first'), 'first', legacy.idleAsk),
    ...renewals(orLegacy(Number.isInteger(options.idleRenewals) ? options.idleRenewals : 2, 2, legacy.idleRenewals)),
    prepareBeforeCompact: orLegacy(bool(options.idleAnnounce, true), true, legacy.idleAnnounce),
    compact: idleCompact !== 'off',
    compactHourOnly: idleCompact === 'auto',
    preparePrompt: text(options.idleAnnouncePrompt, DEFAULT_PREPARE_PROMPT),
    pingPrompt: text(options.idleRenewPrompt, DEFAULT_PING_PROMPT),
    compactInstructions: text(options.compactInstructions, DEFAULT_COMPACT_INSTRUCTIONS),
    ttlMs: parseTtl(options.cacheTtl),
    minContextTokens: whole(options.idleMinContextK, 0, 10_000, 80) * 1000,
    compactAtTokens: orLegacy(whole(options.compactLevelK, 0, 10_000, 200), 200, legacy.compactLevelK) * 1000,
    contextNotices: bool(options.compactContextNotices, true),
    compactCountdownMs: whole(options.compactCountdown, 5, 3600, 30) * 1000,
    askLeadMs: whole(options.idleAskAheadMinutes, 0, 600, 0) * MINUTE_MS,
    sessionCompact: oneOf(options.compactOnRequest, WORDS.compactOnRequest, 'confirm'),
    display: oneOf(options.display, WORDS.display, 'status'),
    showBelowMs: whole(options.displayBelowMinutes, 0, 600, 15) * MINUTE_MS,
    // settings: the transcript is never read, nor looked for
    readTranscript: options.cacheTtl !== 'settings',
    requestHour: oneOf(options.cacheRequestHour, WORDS.cacheRequestHour, 'ask'),
  }
  return profile === 'watch' ? { ...settings, ...WATCH } : settings
}
