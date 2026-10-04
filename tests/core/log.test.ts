import { expect, test } from 'claude-code/testing'

import { LOG_KEEP, causeText, isLogEntry, logEntry, logKey, logLine, logReport, outdated, timeText } from '../../core/log'
import type { LogEntry } from '../../core/log'

const AT = Date.UTC(2026, 9, 4, 1, 12, 30)

const entry = (change: Partial<LogEntry> = {}): LogEntry => ({ why: 'cache', by: 'timer', at: AT, session: 'abcd1234', before: 143985, after: 21400, note: '', ...change })

test('an entry keeps a short session id and one line of what the session said', () => {
  const made = logEntry({ why: 'session', by: 'person' }, AT, 'abcd1234-ffff-0000', 143985, null, `  the work\n is done ${'x'.repeat(300)}`)
  expect(made).toMatchObject({ why: 'session', by: 'person', at: AT, session: 'abcd1234', before: 143985, after: null })
  expect(made.note.startsWith('the work is done xxx')).toBe(true)
  expect(made.note.length).toBe(200)
  expect(isLogEntry(made)).toBe(true)
  expect(isLogEntry(JSON.parse(JSON.stringify(made)))).toBe(true)
  for (const other of [null, 1, 'x', {}, { ...made, at: 'now' }, { ...made, before: '9' }]) expect(isLogEntry(other)).toBe(false)
})

test('the keys sort by time and the oldest go once too many are kept', () => {
  expect(logKey(entry())).toBe('log:2026-10-04T01:12:30.000Z:abcd1234')
  const keys = Array.from({ length: LOG_KEEP + 2 }, (_, at) => logKey(entry({ at: AT + at * 1000 })))
  expect(outdated(keys.slice(0, LOG_KEEP))).toEqual([])
  // Whatever order the store gives them in, and never a key that is not the log's.
  expect(outdated(['intro', ...[...keys].reverse()])).toEqual([keys[0], keys[1]])
})

test('each cause reads as a few words', () => {
  const table: [LogEntry, string][] = [
    [entry(), 'the cache was about to expire, no answer'],
    [entry({ by: 'person' }), 'the cache was about to expire, you chose'],
    [entry({ by: 'plugin' }), 'the cache was about to expire, not asked'],
    [entry({ why: 'session' }), 'the session asked, no answer'],
    [entry({ why: 'session', by: 'person' }), 'the session asked, you chose'],
    [entry({ why: 'manual', by: 'person' }), '/compact'],
    [entry({ why: 'auto', by: 'claude-code' }), 'the context was full, Claude Code on its own'],
    // A reason an extension added is shown by its name.
    [entry({ why: 'size', by: 'person' }), 'size, you chose'],
  ]
  for (const [cause, text] of table) expect({ cause, text: causeText(cause) }).toEqual({ cause, text })
})

test('a line says when, from what size to what size, why, and in which session', () => {
  const when = timeText(AT)
  expect(when).toMatch(/^2026-10-0\d \d\d:\d\d$/)
  expect(logLine(entry())).toBe(`${when}  143 985 → 21 400 tokens · the cache was about to expire, no answer · session abcd1234`)
  expect(logLine(entry({ why: 'session', before: null, after: 999, note: 'the task is done' }))).toBe(
    `${when}  ? → 999 tokens · the session asked, no answer · session abcd1234 · "the task is done"`,
  )
})

test('the report shows the last entries, the newest last', () => {
  expect(logReport([], 10)).toBe('No compaction has been logged yet.')
  const entries = [entry({ at: AT + 2000, before: 3 }), entry({ before: 1 }), entry({ at: AT + 1000, before: 2 })]
  const lines = logReport(entries, 2).split('\n')
  expect(lines[0]).toBe('Compactions, the last 2 of 3 kept:')
  expect(lines.slice(1).map(line => line.split('  ')[1]?.[0])).toEqual(['2', '3'])
  // A count that makes no sense gives the usual ten.
  for (const count of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) expect(logReport(entries, count).split('\n').length).toBe(4)
})
