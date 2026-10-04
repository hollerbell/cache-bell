// Small pure checks around the plugin's own requests.

import { MINUTE_MS } from './timing'
import type { Hold } from './types'

type Usage = { cache_read_input_tokens?: number; cache_creation_input_tokens?: number } | null | undefined

// A hit may write a little: the tail of the conversation that was not cached yet.
const WRITTEN_SHARE = 0.1
const WRITTEN_TOKENS = 2000

// A renewal worked when its request read the cache and wrote next to nothing: a request that came too late
// reads nothing and pays for the whole prefix again. Whether the model replied does not matter.
export const isCacheHit = (usage: Usage): boolean => {
  const read = usage?.cache_read_input_tokens ?? 0
  const written = usage?.cache_creation_input_tokens ?? 0
  return read > 0 && written < Math.max(WRITTEN_SHARE * read, WRITTEN_TOKENS)
}

// How long after the last change of the prompt box the person counts as typing. A minute without a key is
// a person who went away or is done; less would compact under someone who stopped to think of a word. On a
// five-minute cache no more fits anyway: 35 seconds lie between the time to act and the last safe moment.
export const TYPING_MS = MINUTE_MS

const ACTIVE = ['running', 'pending']

// What stands in the way of a compaction: the person is typing, or a subagent still runs. Text that only
// lies in the prompt box does not: it would hold every compaction of a session left with a half-written
// line. Nor does a background shell command: a server left running would never let one through.
// A teammate is listed with the subagents and runs for as long as the session does: it holds nothing.
export const holdOf = (sinceEditMs: number | null, agents: readonly { status: string; type: string }[]): Hold | null => {
  if (sinceEditMs !== null && sinceEditMs >= 0 && sinceEditMs < TYPING_MS) return 'typing'
  return agents.some(agent => agent.type !== 'teammate' && ACTIVE.includes(agent.status)) ? 'agent' : null
}

// The countdown a session may ask for with its request: long enough for a person to read the question and
// say no, short enough that the request is not forgotten on the screen.
export const COUNTDOWN_MIN_S = 10
export const COUNTDOWN_MAX_S = 600

// The countdown of a compaction the user themselves asked the session for: they have decided already, so
// the question is up just long enough to be seen, and to be stopped should the session have got it wrong.
export const USER_ASKED_MS = 3 * 1000

// What the session passed as `countdown`, in ms within those bounds; null when it passed none, or no number.
// A request the user asked for takes the short countdown, whatever else was passed.
export const countdownOf = (value: unknown, isUserAsked: unknown = false): number | null => {
  if (isUserAsked === true) return USER_ASKED_MS
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return Math.min(Math.max(Math.round(value), COUNTDOWN_MIN_S), COUNTDOWN_MAX_S) * 1000
}

// {time} and {idle} in the compaction instructions: when it runs and how many minutes the session was idle.
export const fillInstructions = (template: string, now: number, anchorAt: number | null): string => {
  const time = `${new Date(now).toISOString().slice(0, 16).replace('T', ' ')} UTC`
  const idle = anchorAt === null ? '?' : String(Math.max(0, Math.round((now - anchorAt) / MINUTE_MS)))
  return template.replaceAll('{time}', time).replaceAll('{idle}', idle)
}
