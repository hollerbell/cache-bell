// The log of compactions: one entry for every compaction of the conversation the plugin ran or saw, kept in
// the plugin's store on this machine. Pure: the shell reads and writes the store.

import { grouped } from './view'

// Who decided: the person (an answer, or /compact), the timer (a question nobody answered), the plugin (its
// settings told it to, with no question), or Claude Code itself (the context was full).
export type By = 'person' | 'timer' | 'plugin' | 'claude-code'

export type Cause = { why: string; by: By }

export type LogEntry = Cause & {
  at: number
  session: string
  // The size of the context in tokens; null when it is not known.
  before: number | null
  after: number | null
  // What the session said when it asked for the compaction.
  note: string
}

// What a compaction of the plugin's own is put down to until a question or a request says otherwise.
export const OWN_CAUSE: Cause = { why: 'cache', by: 'plugin' }

export const LOG_PREFIX = 'log:'
export const LOG_KEEP = 200
export const LOG_SHOWN = 10
const NOTE_MAX = 200
const SESSION_SHOWN = 8

// One key for each entry, so sessions that write at the same time do not overwrite each other. The keys
// sort by time.
export const logKey = (entry: LogEntry): string => `${LOG_PREFIX}${new Date(entry.at).toISOString()}:${entry.session}`

export const isLogKey = (key: string): boolean => key.startsWith(LOG_PREFIX)

// The keys of the entries that go, the oldest first, once more than LOG_KEEP are kept.
export const outdated = (keys: readonly string[]): string[] => {
  const kept = keys.filter(isLogKey).sort()
  return kept.slice(0, Math.max(0, kept.length - LOG_KEEP))
}

export const logEntry = (cause: Cause, at: number, session: string, before: number | null, after: number | null, note: string): LogEntry => ({
  ...cause,
  at,
  session: session.slice(0, SESSION_SHOWN),
  before,
  after,
  note: note.replace(/\s+/g, ' ').trim().slice(0, NOTE_MAX),
})

const isSize = (value: unknown): value is number | null => value === null || typeof value === 'number'

export const isLogEntry = (value: unknown): value is LogEntry => {
  if (typeof value !== 'object' || value === null) return false
  const entry = value as Record<string, unknown>
  return (
    typeof entry.at === 'number' &&
    typeof entry.session === 'string' &&
    typeof entry.why === 'string' &&
    typeof entry.by === 'string' &&
    typeof entry.note === 'string' &&
    isSize(entry.before) &&
    isSize(entry.after)
  )
}

const two = (value: number): string => String(value).padStart(2, '0')

// The time on this machine's clock.
export const timeText = (at: number): string => {
  const date = new Date(at)
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`
}

const sizeText = (tokens: number | null): string => (tokens === null ? '?' : grouped(tokens))

const WHY: Readonly<Record<string, string>> = {
  cache: 'the cache was about to expire',
  session: 'the session asked',
  manual: '/compact',
  auto: 'the context was full',
}

const BY: Readonly<Record<string, string>> = {
  person: 'you chose',
  timer: 'no answer',
  plugin: 'not asked',
  'claude-code': 'Claude Code on its own',
}

export const causeText = (cause: Cause): string => {
  const why = WHY[cause.why] ?? cause.why
  // The person typed /compact: there is nothing to add.
  if (cause.why === 'manual') return why
  return `${why}, ${BY[cause.by] ?? cause.by}`
}

export const logLine = (entry: LogEntry): string => {
  const note = entry.note === '' ? '' : ` · "${entry.note}"`
  return `${timeText(entry.at)}  ${sizeText(entry.before)} → ${sizeText(entry.after)} tokens · ${causeText(entry)} · session ${entry.session}${note}`
}

// The last `count` entries, the newest last.
export const logReport = (entries: readonly LogEntry[], count: number): string => {
  if (entries.length === 0) return 'No compaction has been logged yet.'
  const shown = count >= 1 ? Math.min(Math.floor(count), LOG_KEEP) : LOG_SHOWN
  const last = [...entries].sort((a, b) => a.at - b.at).slice(-shown)
  return [`Compactions, the last ${last.length} of ${entries.length} kept:`, ...last.map(logLine)].join('\n')
}
