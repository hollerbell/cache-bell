import { expect, test } from 'claude-code/testing'

import { TTL_1H, TTL_5M } from '../../core/timing'
import { lastRequestOf, tailCommand, ttlFromTranscript, ttlOfLine } from '../../core/transcript'

// A transcript row as Claude Code 2.1.288 writes it, cut down to what matters here.
const assistant = (short: unknown, long: unknown, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({
    type: 'assistant',
    isSidechain: false,
    message: {
      role: 'assistant',
      usage: {
        input_tokens: 2,
        cache_creation_input_tokens: 1351,
        cache_read_input_tokens: 361612,
        cache_creation: { ephemeral_1h_input_tokens: long, ephemeral_5m_input_tokens: short },
      },
    },
    ...extra,
  })

const user = JSON.stringify({ type: 'user', isSidechain: false, message: { role: 'user', content: 'hi' } })

test('one line names the TTL of its cache write', () => {
  const table: [string, string, number | null][] = [
    ['a 5-minute write', assistant(1351, 0), TTL_5M],
    ['a 1-hour write', assistant(0, 1351), TTL_1H],
    ['both at once: the shorter decides', assistant(10, 1351), TTL_5M],
    ['a 5-minute write of a single token', assistant(1, 0), TTL_5M],
    ['a 1-hour write of a single token', assistant(0, 1), TTL_1H],
    ['a response that only read the cache', assistant(0, 0), null],
    ['a subagent response', assistant(0, 1351, { isSidechain: true }), null],
    ['a user row', user, null],
    ['a row of another type with usage', assistant(0, 1351, { type: 'progress' }), null],
    ['no cache_creation split', JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 1 } } }), null],
    ['no usage', JSON.stringify({ type: 'assistant', message: {} }), null],
    ['no message', JSON.stringify({ type: 'assistant' }), null],
    ['counts that are not numbers', assistant('1351', null), null],
    ['a negative count', assistant(-5, 0), null],
    ['a line cut in the middle', assistant(0, 1351).slice(40), null],
    ['not an object', '[1,2,3]', null],
    ['null', 'null', null],
    ['empty', '', null],
  ]
  for (const [name, line, ttl] of table) expect({ name, ttl: ttlOfLine(line) }).toEqual({ name, ttl })
})

test('the newest line that names a TTL wins', () => {
  const table: [string, string[], number | null][] = [
    ['empty text', [], null],
    ['only user rows', [user, user], null],
    ['the last response decides', [assistant(0, 100), user, assistant(100, 0)], TTL_5M],
    ['the last response decides, the other way', [assistant(100, 0), user, assistant(0, 100)], TTL_1H],
    ['a pure cache read is skipped for the write before it', [assistant(0, 100), user, assistant(0, 0)], TTL_1H],
    ['a subagent at the end is skipped', [assistant(0, 100), assistant(100, 0, { isSidechain: true })], TTL_1H],
    ['a tail that starts mid-line', [assistant(100, 0).slice(25), user, assistant(0, 100)], TTL_1H],
    ['a broken last line', [assistant(100, 0), '{"type":"assistant","mess'], TTL_5M],
    ['blank lines and a trailing newline', [assistant(100, 0), '', '   ', ''], TTL_5M],
  ]
  for (const [name, lines, ttl] of table) {
    expect({ name, ttl: ttlFromTranscript(lines.join('\n')) }).toEqual({ name, ttl })
  }
})

test('the end of a large file is read by its bytes, by the system the session runs on', () => {
  expect(tailCommand('/srv/work/.claude/projects/x/s.jsonl', 65536, false)).toEqual(['tail', '-c', '65536', '/srv/work/.claude/projects/x/s.jsonl'])
  const windows = tailCommand('D:\\home\\me\\s.jsonl', 65536, true)
  expect(windows.slice(0, 4)).toEqual(['powershell', '-NoProfile', '-NonInteractive', '-Command'])
  // It opens the file shared, jumps to the place and reads no more than it was told to.
  expect(windows[4]).toContain("[IO.File]::Open('D:\\home\\me\\s.jsonl','Open','Read','ReadWrite')")
  expect(windows[4]).toContain('[Math]::Min($f.Length,65536)')
  expect(windows[4]).toContain("$f.Seek(-$n,'End')")
  expect(windows[4]).not.toContain('Get-Content')
  // A path with a space and an apostrophe stays one quoted argument.
  expect(tailCommand("D:\\home\\O'Neil\\my files\\s.jsonl", 5, true)[4]).toContain("Open('D:\\home\\O''Neil\\my files\\s.jsonl','Open'")
  // PowerShell takes a typographic apostrophe for a quote as well: each of the four is doubled.
  for (const quote of ['\u2018', '\u2019', '\u201A', '\u201B']) {
    expect(tailCommand(`D:\\Tom${quote}s\\s.jsonl`, 5, true)[4]).toContain(`Open('D:\\Tom${quote}${quote}s\\s.jsonl','Open'`)
  }
})

test('Windows line endings are read too', () => {
  expect(ttlFromTranscript([assistant(0, 100), user, ''].join('\r\n'))).toBe(TTL_1H)
})

// Rows with a time, as the transcript dates them. A response counts tokens; a prompt is text, a tool's
// result is blocks.
const at = (time: string, type: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type, isSidechain: false, timestamp: `2026-01-12T${time}.000Z`, message: type === 'assistant' ? { model: 'claude-test', usage: { input_tokens: 2, output_tokens: 9 } } : { content: 'hi' }, ...extra })
const clock = (hours: number, minutes = 0, seconds = 0) => Date.UTC(2026, 0, 12, hours, minutes, seconds)

test('the last request is dated by the row the last response answers', () => {
  const rows = [
    at('08:00:00', 'user'),
    at('08:00:05', 'assistant'),
    at('08:10:00', 'user', { message: { content: [{ type: 'tool_result', content: 'done' }] } }),
    at('08:10:02', 'user', { isSidechain: true }),
    at('08:10:04', 'assistant'),
    at('08:10:09', 'assistant'),
    at('08:10:10', 'system'),
    // The person's message after the last response started no request that was answered.
    at('08:30:00', 'user'),
    'half a li',
  ]
  expect(lastRequestOf(rows.join('\n'))).toBe(clock(8, 10))
  expect(lastRequestOf(rows.slice(0, 2).join('\r\n'))).toBe(clock(8))
  // No response, no dated row before it, a date that is none: nothing is known.
  expect(lastRequestOf(rows[0] ?? '')).toBeNull()
  expect(lastRequestOf(rows.slice(4, 6).join('\n'))).toBeNull()
  expect(lastRequestOf([JSON.stringify({ type: 'user', timestamp: 'yesterday', message: { content: 'hi' } }), at('08:00:05', 'assistant')].join('\n'))).toBeNull()
  expect(lastRequestOf('')).toBeNull()
})

test('a request that failed is no request the cache has seen', () => {
  const failed = [
    at('05:00:00', 'user'),
    at('05:00:05', 'assistant'),
    // Three hours later: a message, and the row Claude Code writes for the API's error.
    at('08:00:00', 'user'),
    at('08:00:03', 'assistant', { isApiErrorMessage: true, message: { model: '<synthetic>', usage: { input_tokens: 0, output_tokens: 0 } } }),
  ]
  expect(lastRequestOf(failed.join('\n'))).toBe(clock(5))
  // Each sign alone is enough: the mark, the model's name, a usage of nothing, no usage at all.
  for (const row of [
    at('08:00:03', 'assistant', { isApiErrorMessage: true }),
    at('08:00:03', 'assistant', { message: { model: '<synthetic>', usage: { input_tokens: 5 } } }),
    at('08:00:03', 'assistant', { message: { model: 'claude-test', usage: { input_tokens: 0, output_tokens: 0 } } }),
    at('08:00:03', 'assistant', { message: { model: 'claude-test' } }),
  ]) {
    expect(lastRequestOf([...failed.slice(0, 3), row].join('\n'))).toBe(clock(5))
  }
})

test('a command typed while the response came, and a row Claude Code adds for itself, start no request', () => {
  const rows = [
    at('08:00:00', 'user'),
    at('08:00:20', 'user', { message: { content: '<command-name>/reload-plugins</command-name>' } }),
    at('08:00:21', 'user', { message: { content: '  <local-command-stdout>Reloaded</local-command-stdout>' } }),
    at('08:00:25', 'user', { isMeta: true }),
    at('08:00:40', 'assistant'),
  ]
  expect(lastRequestOf(rows.join('\n'))).toBe(clock(8))
})

test('a conversation compacted after its last response has no request worth dating', () => {
  const summary = at('08:20:00', 'user', { isCompactSummary: true })
  const boundary = at('08:20:00', 'system', { subtype: 'compact_boundary' })
  const before = [at('08:00:00', 'user'), at('08:00:05', 'assistant')]
  expect(lastRequestOf([...before, boundary, summary].join('\n'))).toBe('compacted')
  expect(lastRequestOf([...before, summary].join('\n'))).toBe('compacted')
  // Work after the compaction is dated as ever.
  expect(lastRequestOf([...before, boundary, summary, at('08:30:00', 'user'), at('08:30:05', 'assistant')].join('\n'))).toBe(clock(8, 30))
  // The tail begins with the summary's answer: what it answered is not in it.
  expect(lastRequestOf([boundary, summary, at('08:30:05', 'assistant')].join('\n'))).toBeNull()
})
