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

// What PowerShell takes for a single quote: the apostrophe and its four typographic forms. Inside a quoted
// string each is doubled, or a folder named with one would end the string.
const POWERSHELL_QUOTES = /['\u2018\u2019\u201A\u201B]/g

// The command that prints the last lines of a file too large to read whole. On Windows the path goes into
// the command text itself, quoted: PowerShell's -Command hands no further arguments to the command.
export const tailCommand = (path: string, lines: number, isWindows: boolean): string[] =>
  isWindows
    ? ['powershell', '-NoProfile', '-NonInteractive', '-Command', `Get-Content -LiteralPath '${path.replace(POWERSHELL_QUOTES, quote => quote + quote)}' -Tail ${lines} -Encoding UTF8`]
    : ['tail', '-n', String(lines), path]
