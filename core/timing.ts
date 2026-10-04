// When to ask, when to act and when it is too late, all derived from the cache TTL and measured from the
// anchor: the moment the last main-thread request was sent to the API.

export const MINUTE_MS = 60 * 1000

export const TTL_5M = 5 * MINUTE_MS
export const TTL_1H = 60 * MINUTE_MS

// A gap between two ticks longer than this means the machine slept or the process was suspended.
export const SLEEP_GAP_MS = 30 * 1000

export type Offsets = { askMs: number; actMs: number; maxMs: number }
export type Deadlines = { tAsk: number; tAct: number; tMax: number; expiresAt: number }

export const clamp = (value: number, low: number, high: number): number => Math.min(Math.max(value, low), high)

const SECOND = 1000

// How long before the time to act the question appears when the person set nothing: on a long cache a
// quarter of an hour, since the question does not get in the way of working; on a short one half a minute.
export const autoLead = (ttlMs: number): number => (ttlMs >= 30 * 60 * SECOND ? 15 * 60 * SECOND : clamp(ttlMs / 12, 30 * SECOND, 300 * SECOND))

// Offsets from the anchor. 5 min → 3:30 / 4:00 / 4:35, 1 h → 35:00 / 50:00 / 55:00. A lead the person set
// replaces the automatic one, but the question never comes in the first half of the time to act.
export const offsets = (ttlMs: number, askLeadMs = 0): Offsets => {
  const actMs = ttlMs - clamp(ttlMs / 6, 60 * SECOND, 600 * SECOND)
  const askMs = actMs - Math.min(askLeadMs > 0 ? askLeadMs : autoLead(ttlMs), actMs / 2)
  const maxMs = ttlMs - clamp(ttlMs / 12, 20 * SECOND, 300 * SECOND)
  return { askMs, actMs, maxMs }
}

export const deadlines = (anchorAt: number, ttlMs: number, askLeadMs = 0): Deadlines => {
  const { askMs, actMs, maxMs } = offsets(ttlMs, askLeadMs)
  return { tAsk: anchorAt + askMs, tAct: anchorAt + actMs, tMax: anchorAt + maxMs, expiresAt: anchorAt + ttlMs }
}

export const parseTtl = (value: unknown): number | null => {
  if (value === '5m') return TTL_5M
  if (value === '1h') return TTL_1H
  return null
}

export type TtlSettings = {
  // FORCE_PROMPT_CACHING_5M from the environment
  force5m: string | undefined
  // CLAUDE_CODE_PROMPT_CACHE_TTL from the environment
  envTtl: string | undefined
  // promptCacheTtl from settings.json
  settingTtl: unknown
}

const isOn = (value: string | undefined): boolean =>
  value !== undefined && value !== '' && value !== '0' && value.toLowerCase() !== 'false'

// What the person asked Claude Code for, in the order Claude Code itself reads it. Only a hint: the
// transcript says what the API really granted.
export const ttlFromSettings = (settings: TtlSettings): number | null => {
  if (isOn(settings.force5m)) return TTL_5M
  return parseTtl(settings.envTtl) ?? parseTtl(settings.settingTtl)
}
