// The in-session signal: a line for the model after a tool result of the main thread, saying how full the
// context is. Where the person set a limit and the context is past it, the line also says that they want a
// compaction at the next good point. The line holds numbers and the name of the plugin's skill, nothing else.
//
// When a line is due:
//   - past the person's limit: at once on crossing it, then each time the context grew by STEP of the window;
//   - without a limit, or below it: from FROM of the window on, then each STEP of the window, and always on
//     crossing one of MARKS.
// A context that shrank by more than STEP of the window (a compaction, a /clear) starts over.

export const SIGNAL_FROM = 0.5
export const SIGNAL_STEP = 0.05
export const SIGNAL_MARKS: readonly number[] = [0.85, 0.9, 0.95]

export const SIGNAL_SKILL = 'cache-bell:compact'

export type SignalOptions = {
  // the person's limit in tokens, as the line names it; 0 = none
  limitTokens: number
  // the size from which the line says the person wants a compaction; 0 = it never does: where Claude may
  // not ask for a compaction, or no level is set
  askFromTokens: number
  // whether the plain lines on how full the context is are sent
  isStatusOn: boolean
}

export type SignalSeen = {
  // the context size the last line was sent at; null = none sent since the context last shrank
  lastAt: number | null
  // whether a line already said that the person wants a compaction, since the context last went past the limit
  isOverSaid: boolean
}

export const SIGNAL_NONE: SignalSeen = { lastAt: null, isOverSaid: false }

const k = (tokens: number): string => `${Math.round(tokens / 1000)}k`

const percentOf = (tokens: number, window: number): number => Math.round((tokens / window) * 100)

// The line due at this size, and what is remembered after it; null line = nothing to send.
export const signalOf = (
  tokens: number | null,
  window: number | null,
  seen: SignalSeen,
  options: SignalOptions,
): { line: string | null; seen: SignalSeen } => {
  if (tokens === null || !Number.isFinite(tokens) || tokens < 0) return { line: null, seen }
  const known = window !== null && Number.isFinite(window) && window > 0 ? window : null
  // Only a real shrink starts over: a context that wobbles by a few tokens does not repeat the line.
  const isShrunk = seen.lastAt !== null && seen.lastAt - tokens > (known ?? seen.lastAt) * SIGNAL_STEP
  const lastAt = isShrunk ? null : seen.lastAt
  const isOverLimit = options.limitTokens > 0 && options.askFromTokens > 0 && tokens >= Math.max(options.limitTokens, options.askFromTokens)
  const kept: SignalSeen = { lastAt, isOverSaid: isOverLimit && !isShrunk && seen.isOverSaid }
  const isStatus = options.isStatusOn && known !== null && tokens >= known * SIGNAL_FROM
  if (!isOverLimit && !isStatus) return { line: null, seen: kept }

  const isFirstOver = isOverLimit && !kept.isOverSaid
  const grown = lastAt === null || (known !== null ? tokens - lastAt >= known * SIGNAL_STEP : false)
  const crossed = known !== null && lastAt !== null && SIGNAL_MARKS.some(mark => lastAt < known * mark && tokens >= known * mark)
  if (!isFirstOver && !grown && !crossed) return { line: null, seen: kept }

  const size = known === null ? `${k(tokens)}` : `${k(tokens)} of a ${k(known)} window (${percentOf(tokens, known)}%)`
  const line = isOverLimit
    ? `[cache-bell] User preference notice: the user set a context limit of ${k(options.limitTokens)}; the context is now ${size}, ${k(tokens - options.limitTokens)} over. The user wants a compaction at the next good point: see skill ${SIGNAL_SKILL}.`
    : `[cache-bell] Context notice: ${size}.`
  return { line, seen: { lastAt: tokens, isOverSaid: kept.isOverSaid || isOverLimit } }
}
