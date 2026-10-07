// The cache TTL the API really granted is only in the transcript: each main-thread response's usage splits
// its cache writes into ephemeral_5m_input_tokens and ephemeral_1h_input_tokens. A mod sees neither in
// turn.step, so the TTL is read from the transcript's tail.

import { TTL_1H, TTL_5M } from './timing'

type Json = Record<string, unknown>

const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value)

const tokens = (value: unknown): number => (typeof value === 'number' && value > 0 ? value : 0)

// One transcript line → the TTL its cache write names, or null when the line says nothing about it:
// not a main-thread assistant response, or a response that only read the cache.
export const ttlOfLine = (line: string): number | null => {
  let row: unknown
  try {
    row = JSON.parse(line)
  } catch {
    return null
  }
  if (!isObject(row) || row.type !== 'assistant' || row.isSidechain === true) return null
  const message = row.message
  if (!isObject(message) || !isObject(message.usage)) return null
  const written = message.usage.cache_creation
  if (!isObject(written)) return null
  const short = tokens(written.ephemeral_5m_input_tokens)
  const long = tokens(written.ephemeral_1h_input_tokens)
  // Both at once: the shorter one decides when the prefix starts to fall out.
  if (short > 0) return TTL_5M
  if (long > 0) return TTL_1H
  return null
}

// The newest line that names a TTL wins. `text` may be the tail of a file cut mid-line: a line that does
// not parse is skipped.
export const ttlFromTranscript = (text: string): number | null => {
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = (lines[i] ?? '').trim()
    if (line === '') continue
    const ttl = ttlOfLine(line)
    if (ttl !== null) return ttl
  }
  return null
}

// A response the API really gave: its usage counts tokens. The row Claude Code writes for a request that
// failed (an API error, a refusal of the limit) looks like a response and is none.
const isAnswer = (row: Json): boolean => {
  const message = row.message
  if (row.type !== 'assistant' || row.isApiErrorMessage === true || !isObject(message) || message.model === '<synthetic>' || !isObject(message.usage)) return false
  const usage = message.usage
  return tokens(usage.input_tokens) + tokens(usage.output_tokens) + tokens(usage.cache_read_input_tokens) + tokens(usage.cache_creation_input_tokens) > 0
}

// A row of the person's side that started no request: a command and its output, a row Claude Code adds
// for itself.
const isAside = (row: Json): boolean => {
  if (row.isMeta === true) return true
  const content = isObject(row.message) ? row.message.content : undefined
  return typeof content === 'string' && content.trimStart().startsWith('<')
}

// When the last request of the main thread went out, from the transcript's tail: the time of the row the
// last response answers (the person's message or a tool's result), which is written right before the
// request is sent. Early rather than late: the cache's time is then not overstated. 'compacted' when the
// conversation was compacted after that response: the cache holds the old conversation, as after any
// compaction. null when the text holds no response of the main thread, or no dated row before it.
export const lastRequestOf = (text: string): number | 'compacted' | null => {
  const lines = text.split('\n')
  let isAnswered = false
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    let row: unknown
    try {
      row = JSON.parse(lines[i] ?? '')
    } catch {
      continue
    }
    if (!isObject(row) || row.isSidechain === true) continue
    if (row.isCompactSummary === true || (row.type === 'system' && row.subtype === 'compact_boundary')) return isAnswered ? null : 'compacted'
    if (isAnswer(row)) {
      isAnswered = true
      continue
    }
    if (!isAnswered || row.type !== 'user' || isAside(row) || typeof row.timestamp !== 'string') continue
    const at = Date.parse(row.timestamp)
    return Number.isNaN(at) ? null : at
  }
  return null
}

// What PowerShell takes for a single quote: the apostrophe and its four typographic forms. Inside a quoted
// string each is doubled, or a folder named with one would end the string.
const POWERSHELL_QUOTES = /['\u2018\u2019\u201A\u201B]/g

// Where Claude Code keeps a session's transcript: under its own directory, in a folder named after the
// directory the session runs in (every character but a letter or a digit as `-`), in a file named after
// the session's id. The directory's name is taken in its composed form (NFC): macOS hands it out decomposed,
// and a letter with an accent would give two dashes for one. Only the file's name is documented, so whoever
// takes this path asks whether the file is there. Null for an id that is not a plain word: it goes into a path.
const SESSION_ID = /^[\w-]{1,80}$/
const ENDING_SLASHES = /[\\/]+$/
export const transcriptPathOf = (configDir: string, sessionDir: string, sessionId: string): string | null =>
  SESSION_ID.test(sessionId) && configDir !== '' && sessionDir !== ''
    ? `${configDir.replace(ENDING_SLASHES, '')}/projects/${sessionDir.normalize('NFC').replace(ENDING_SLASHES, '').replace(/[^a-zA-Z0-9]/g, '-')}/${sessionId}.jsonl`
    : null

// Whether two spellings name one file: an event's path and the one put together here differ in their
// slashes, and on Windows may differ in case.
const spelled = (path: string): string => path.replace(/\\/g, '/').toLowerCase()
export const isSamePath = (one: string, other: string): boolean => spelled(one) === spelled(other)

// The command that prints the last `bytes` of a file too large to read whole. It jumps to the place and
// reads only that much, so its cost does not grow with the file. The piece may start in the middle of a
// line, or of a character: that line does not parse and is skipped. On Windows the path goes into the
// command text itself, quoted: PowerShell's -Command hands no further arguments to the command. The file is
// opened shared, so Claude Code can go on writing to it.
export const tailCommand = (path: string, bytes: number, isWindows: boolean): string[] =>
  isWindows
    ? [
        'powershell',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        [
          `$f=[IO.File]::Open('${path.replace(POWERSHELL_QUOTES, quote => quote + quote)}','Open','Read','ReadWrite')`,
          `try{$n=[int][Math]::Min($f.Length,${bytes});[void]$f.Seek(-$n,'End');$b=New-Object byte[] $n;$r=0`,
          'while($r -lt $n){$k=$f.Read($b,$r,$n-$r);if($k -le 0){break};$r+=$k}}finally{$f.Close()}',
          '[Console]::OutputEncoding=[Text.Encoding]::UTF8;[Console]::Out.Write([Text.Encoding]::UTF8.GetString($b,0,$r))',
        ].join(';'),
      ]
    : ['tail', '-c', String(bytes), path]
