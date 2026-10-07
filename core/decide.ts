// The state machine. One pure step: what was known, what time it is, what was just observed → what is known
// now and what the shell should do. It tracks the cache (UNKNOWN, BUSY, WARM, COLD, DORMANT) and, on a warm
// cache that is about to run out, asks (ASKING), renews it (RENEWING), tells the session that a compaction
// is coming (PREPARING) and compacts (COMPACTING).

import type { Choice } from './ask'
import { NONE } from './extension'
import type { Extension } from './extension'
import { RENEWALS_CAP } from './config'
import { MINUTE_MS, SLEEP_GAP_MS, TTL_1H, TTL_5M, deadlines } from './timing'
import type { Action, ColdReason, Config, Decision, Hold, Observation, RestPhase, State, TtlSource } from './types'

// How long past its deadline a question may stay unanswered before the core answers it itself: the shell
// normally does, with what the person had selected.
export const ASK_GRACE_MS = 3000
// How long past the cache's last safe moment a step of the plugin's own may stay unfinished before it is
// given up: a reload in the middle of one leaves nobody to report its end.
export const WORK_GRACE_MS = 10 * MINUTE_MS

const FRESH = { renewals: 0, renewalsSent: 0, isAsked: false, isDeclined: false, retryAt: null } as const
// No question is open.
const UNASKED = { askReason: null, askDeadline: null } as const
// No compaction waits and none was ordered by the person.
const UNHELD = { held: null, isOrdered: false } as const

export const initialState = (config: Config): State => ({
  phase: 'UNKNOWN',
  anchorAt: null,
  ttlMs: config.ttlMs ?? TTL_5M,
  ttlSource: config.ttlMs === null ? 'default' : 'config',
  isTtlUnread: false,
  coldReason: null,
  resumeTo: null,
  ...FRESH,
  contextTokens: null,
  ...UNASKED,
  ...UNHELD,
  ext: {},
  isRequested: false,
  requestMs: null,
  priorAnchorAt: null,
  workedAt: null,
  lastCompaction: null,
})

// The state outlives a reload, the configuration and the plugin's version may not: a TTL set by hand always
// wins, one that was set by hand and no longer is falls back to the default until the data say otherwise,
// and a state written by an older version gets the fields it lacks.
const withConfig = (stored: State, config: Config): State => {
  const old = stored as Partial<State>
  const known: State =
    old.renewals === undefined || old.ext === undefined || old.isRequested === undefined || old.retryAt === undefined || old.priorAnchorAt === undefined
      ? {
          ...stored,
          ...FRESH,
          contextTokens: old.contextTokens ?? null,
          ...UNASKED,
          ext: {},
          isRequested: false,
          priorAnchorAt: null,
          phase: stored.phase === 'ASKING' ? 'WARM' : stored.phase,
        }
      : stored
  // Newer fields are added alone: what the person decided before the update stays decided.
  const held: State = old.held === undefined || old.isOrdered === undefined ? { ...known, ...UNHELD } : known
  const asked: State = old.requestMs === undefined ? { ...held, requestMs: null } : held
  // What was renewed before the requests were counted was sent, at the least.
  const counted: State = old.renewalsSent === undefined ? { ...asked, renewalsSent: asked.renewals } : asked
  const worked: State = old.workedAt === undefined || old.lastCompaction === undefined ? { ...counted, workedAt: null, lastCompaction: null } : counted
  const state: State = old.isTtlUnread === undefined ? { ...worked, isTtlUnread: false } : worked
  if (config.ttlMs !== null) {
    // The same object when nothing changes: the shell writes the state only when it is a new one.
    if (state.ttlMs === config.ttlMs && state.ttlSource === 'config') return state
    return { ...state, ttlMs: config.ttlMs, ttlSource: 'config' }
  }
  if (state.ttlSource === 'config') return { ...state, ttlMs: TTL_5M, ttlSource: 'default' }
  return state
}

// The settings are only what was asked for; they never override what the API was seen to grant.
const acceptsTtl = (current: TtlSource, incoming: TtlSource): boolean => {
  if (current === 'config') return false
  if (incoming === 'settings') return current === 'default' || current === 'settings'
  return true
}

// The TTL is the default's guess, and the transcript that would say could not be read: a guess is nothing
// to renew or compact on. The session's own request is still asked about; that is not the timer's doing.
export const isGuessed = (state: State): boolean => state.isTtlUnread && state.ttlSource === 'default'

// How long the cache is taken to live. Behind a guess it may be the hour: everything that waits for the
// cache's end waits that long, and only what the timer would start on its own is left undone.
export const lifeOf = (state: State): number => (isGuessed(state) ? TTL_1H : state.ttlMs)

const COLD_WHY: Record<ColdReason, (minutes: number) => string> = {
  expired: minutes => `Prompt cache expired after ${minutes} min without a request.`,
  sleep: () => 'Prompt cache expired while this machine slept.',
  'model-switch': () => 'The model changed, its prompt cache does not carry over.',
  'renew-missed': () => 'Renewing the prompt cache came too late: it had already expired.',
  'compact-failed': () => 'The compaction did not go through and the prompt cache has run out.',
  postponed: () => 'The compaction waited for your typing or a running subagent until the prompt cache ran out: nothing was compacted.',
}

export const RENEW_FAILED = 'Renewing the prompt cache got no answer: nothing more is sent, the cache is left to expire.'

export const CALLED_OFF = 'The compaction was called off: its announcement did not finish.'

const coldText = (reason: ColdReason, ttlMs: number): string =>
  `${COLD_WHY[reason](Math.round(ttlMs / MINUTE_MS))} The next message re-sends the whole context uncached.`

// A clock that was set back makes the last request look like it lies in the future: then nothing is known
// of the cache, and acting on it could send the whole context uncached.
const CLOCK_SKEW_MS = MINUTE_MS

const isPastMax = (state: State, now: number): boolean =>
  state.anchorAt === null || now >= deadlines(state.anchorAt, lifeOf(state)).tMax || now < state.anchorAt - CLOCK_SKEW_MS

// A question that is not about the cache still has to be over while the cache is warm: its countdown ends
// this long before the last safe moment at the latest. With less than that left to decide in, it is not
// asked at all.
export const LATE_MARGIN_MS = 10 * 1000

// When the countdown of such a question ends; null when the cache runs out too soon to ask.
const askUntil = (state: State, now: number, countdownMs: number): number | null => {
  if (state.anchorAt === null) return null
  const last = deadlines(state.anchorAt, lifeOf(state)).tMax - LATE_MARGIN_MS
  return last - now < LATE_MARGIN_MS ? null : Math.min(now + countdownMs, last)
}

// How long an extension's question waits for an answer. Its own time, not the option's: the option is for
// what a session asks for, and an extension's question may compact when nobody answers.
export const EXTENSION_COUNTDOWN_MS = 3 * MINUTE_MS

// A question that waits for the person's own answer stays up until the cache's own course takes over: at
// its time to ask where it asks, else at its time to act. null when that is too soon to ask.
const waitUntil = (state: State, now: number, config: Config): number | null => {
  if (state.anchorAt === null) return null
  const { tAsk, tAct } = deadlines(state.anchorAt, lifeOf(state), config.askLeadMs)
  const until = planOf(state, config).asks ? tAsk : tAct
  return until - now < LATE_MARGIN_MS ? null : until
}

export const TOO_SOON = 'The session asked for a compaction, but the prompt cache runs out too soon to ask you: nothing was compacted.'

// A question about the session's request that something else interrupted comes back with the time it had
// left, and with this much at the least: enough to read it again and say no.
export const RESUMED_MIN_MS = 10 * 1000

// A renewal that got no answer is tried once more, this much later: a network that was away for a moment
// should not cost the cache, and an API that keeps refusing should not be asked every second.
export const RETRY_AFTER_MS = 15 * 1000

// What the plugin will do about a warm cache that is left alone: whether it asks, and whether it acts when
// nobody answers. Switched off, after the person declined, for a context too small to matter, or in a mode
// that neither renews nor compacts, it does nothing.
export const planOf = (state: State, config: Config): { asks: boolean; acts: boolean } => {
  const isSmall = state.contextTokens !== null && state.contextTokens < config.minContextTokens
  if (!config.enabled || state.isDeclined || isSmall) return { asks: false, acts: false }
  const choice = defaultChoice(state, config)
  // Asking once covers the renewals. A compaction cannot be undone: a mode that asks at all asks before it
  // too, with Compact selected, so whoever is at the machine can still say no.
  const asksAgain = config.ask === 'first' && (!state.isAsked || choice === 'compact')
  return { asks: config.ask === 'every' || asksAgain, acts: choice !== 'cancel' }
}

// The phase an interrupted turn goes back to: the plugin's own steps all happen on a warm cache.
const restOf = (state: State): RestPhase =>
  state.phase === 'UNKNOWN' || state.phase === 'COLD' || state.phase === 'DORMANT' ? state.phase : 'WARM'

export const canRenew = (state: State, config: Config): boolean =>
  config.renewMethod !== 'none' && state.renewals < config.maxRenewals && state.renewalsSent < RENEWALS_CAP

// What is done when nobody answers: renew while renewals are left, then compact, if the mode compacts.
export const defaultChoice = (state: State, config: Config): Choice => {
  if (canRenew(state, config)) return 'renew'
  return config.compact ? 'compact' : 'cancel'
}

const cold = (state: State, coldReason: ColdReason, before: Action[] = []): Decision => ({
  state: { ...state, ...UNASKED, ...UNHELD, phase: 'COLD', coldReason },
  actions: [...before, { kind: 'notify', text: coldText(coldReason, lifeOf(state)) }, { kind: 'redraw' }],
})

// Who decided: the timer (the cache's course, a question nobody answered), which waits for `hold`, or the
// person, whose word nothing holds back.
type Say = { hold: Hold | null } | 'person'

// Carries out a choice. A compaction the timer decided waits while something stands in its way, and goes
// ahead at the first tick that finds the way clear. The cache does not wait with it.
const act = (asked: State, choice: Choice, config: Config, extension: Extension, say: Say): Decision => {
  const close: Action[] = asked.phase === 'ASKING' ? [{ kind: 'close-question' }] : []
  const state = { ...asked, ...UNASKED, ...UNHELD }
  const idle = (change: Partial<State>): Decision => ({ state: { ...state, phase: 'WARM', ...change }, actions: [...close, { kind: 'redraw' }] })
  if (choice === 'cancel') return idle({ isDeclined: true })
  if (choice === 'skip') return idle({})
  // A compaction that waits goes on waiting through a renewal: the cache is kept warm for it.
  if (choice === 'renew') return { state: { ...state, held: asked.held, renewalsSent: asked.renewalsSent + 1, phase: 'RENEWING' }, actions: [...close, { kind: 'renew' }, { kind: 'redraw' }] }
  // An answer the core does not know is the extension's; one nobody knows does nothing.
  if (choice !== 'compact') {
    const ext = extension.answer(state, choice)
    return idle(ext === null ? {} : { ext })
  }
  // A session that asked for the compaction, or was told before it had to wait, knows it is coming:
  // nothing to announce.
  const isTold = asked.askReason === 'session' || asked.held?.isTold === true
  if (say !== 'person' && say.hold !== null) {
    // Still waiting for the same thing: the state stays the object it was, so nothing is written.
    const isWaiting = asked.phase === 'WARM' && asked.held?.by === say.hold
    return isWaiting ? { state: asked, actions: [{ kind: 'redraw' }] } : idle({ held: { by: say.hold, isTold } })
  }
  const isOrdered = say === 'person'
  const isPrepared = !isTold && config.prepareBeforeCompact && config.preparePrompt !== ''
  return isPrepared
    ? { state: { ...state, isOrdered, phase: 'PREPARING' }, actions: [...close, { kind: 'prepare' }, { kind: 'redraw' }] }
    : { state: { ...state, isOrdered, phase: 'COMPACTING' }, actions: [...close, { kind: 'compact' }, { kind: 'redraw' }] }
}

// What is done when a question runs out unanswered.
export const fallbackOf = (state: State, config: Config, extension: Extension): Choice => {
  if (state.askReason === 'cache' || state.askReason === null) return defaultChoice(state, config)
  // Set to wait, a request nobody answered is dropped: only the person's word compacts.
  if (state.askReason === 'session') return config.sessionCompact === 'wait' ? 'skip' : 'compact'
  // A question whose extension is gone (the plugin was reloaded without it) is dropped, never acted on.
  return extension.reasons[state.askReason]?.selected ?? 'skip'
}

// Whether the next tick has to know what stands in the way of a compaction: only when one could start with
// it, so the shell does not ask Claude Code about its subagents every second of an idle hour.
export const needsHold = (state: State, now: number, config: Config): boolean => {
  if (state.anchorAt === null) return false
  if (state.phase === 'ASKING') return now >= (state.askDeadline ?? 0)
  if (state.held === null && isGuessed(state)) return false
  return state.phase === 'WARM' && (state.held !== null || now >= deadlines(state.anchorAt, lifeOf(state), config.askLeadMs).tAct)
}

const isExtensions = (state: State): boolean =>
  state.phase === 'ASKING' && state.askReason !== null && state.askReason !== 'cache' && state.askReason !== 'session'

const tick = (state: State, now: number, gapMs: number, hold: Hold | null, config: Config, extension: Extension): Decision => {
  const redraw: Action[] = [{ kind: 'redraw' }]
  if (state.phase === 'RENEWING' || state.phase === 'PREPARING' || state.phase === 'COMPACTING') {
    const isGivenUp = state.anchorAt === null || now >= deadlines(state.anchorAt, lifeOf(state)).tMax + WORK_GRACE_MS
    if (!isGivenUp) return { state, actions: [] }
    return cold(state, state.phase === 'COMPACTING' ? 'compact-failed' : state.phase === 'RENEWING' ? 'renew-missed' : 'expired')
  }
  if (state.phase !== 'WARM' && state.phase !== 'ASKING') return { state, actions: [] }

  // A tick earlier than the one before it: the clock was set back, and with it everything counted from it.
  if (isPastMax(state, now) || gapMs < -CLOCK_SKEW_MS) {
    const close: Action[] = state.phase === 'ASKING' ? [{ kind: 'close-question' }] : []
    // A compaction that waited to the end, with the clock running as it should.
    const isPostponed = state.phase === 'WARM' && state.held !== null && gapMs >= 0
    return cold(state, gapMs > SLEEP_GAP_MS ? 'sleep' : isPostponed ? 'postponed' : 'expired', close)
  }
  const { tAsk, tAct } = deadlines(state.anchorAt ?? now, lifeOf(state), config.askLeadMs)

  // Switched off with a question open or a compaction waiting: the question is gone with the reload, and
  // nothing is done about either.
  if (!config.enabled && (state.phase === 'ASKING' || state.held !== null)) {
    return { state: { ...state, ...UNASKED, ...UNHELD, phase: 'WARM' }, actions: redraw }
  }

  if (state.phase === 'ASKING') {
    // A question that waits for the person gives way to the cache's course, also when the cache turned out
    // to live shorter than it did when the question was put up.
    const isWaited = state.askReason === 'session' && config.sessionCompact === 'wait'
    if (isWaited && now >= tAct) return act(state, 'skip', config, extension, { hold })
    // The shell answers a question when its time is up. Should it not, the default is done.
    const isOver = now >= (state.askDeadline ?? tAct) + ASK_GRACE_MS
    return isOver ? act(state, fallbackOf(state, config, extension), config, extension, { hold }) : { state, actions: [] }
  }

  // The compaction that waited: the way is clear.
  if (state.held !== null && hold === null) return act(state, 'compact', config, extension, { hold })

  // Only a guess of the TTL: the timer asks, renews and compacts nothing on the strength of it. A question
  // already up and a compaction that waits are not the timer's doing, and went their way above.
  if (isGuessed(state)) return { state, actions: state.held === null ? [] : redraw }

  // The one retry of a renewal that got no answer waits for its time.
  if (state.retryAt !== null && now < state.retryAt) return { state, actions: redraw }

  const { asks, acts } = planOf(state, config)
  const choice = defaultChoice(state, config)
  // A mode that neither renews nor compacts has nothing to do here: the cache simply runs out.
  if (now >= tAct) return acts ? act(state, choice, config, extension, { hold }) : { state, actions: redraw }
  if (asks && now >= tAsk) {
    return {
      state: { ...state, phase: 'ASKING', isAsked: true, askReason: 'cache', askDeadline: tAct },
      actions: [{ kind: 'ask', reason: 'cache', deadline: tAct, selected: choice }, ...redraw],
    }
  }
  return { state, actions: redraw }
}

// The guess ended: the TTL is known now. If that is past the time to ask, a mode that owes the question does
// nothing more in this idle period, rather than renew or compact without having asked.
const known = (before: State, after: State, now: number, config: Config): State => {
  if (!isGuessed(before) || isGuessed(after) || after.phase !== 'WARM' || after.anchorAt === null || after.held !== null) return after
  const isLate = now >= deadlines(after.anchorAt, after.ttlMs, config.askLeadMs).tAsk
  return isLate && planOf(after, config).asks ? { ...after, isDeclined: true } : after
}

const step = (state: State, now: number, observation: Observation, config: Config, extension: Extension): Decision => {
  const redraw: Action[] = [{ kind: 'redraw' }]
  const close: Action[] = state.phase === 'ASKING' ? [{ kind: 'close-question' }] : []

  switch (observation.kind) {
    case 'tick':
      return tick(state, now, observation.gapMs, observation.hold ?? null, config, extension)

    case 'turn-start': {
      // The announcement is the plugin's own turn: it is part of the compaction, not work in the session.
      if (observation.by === 'self' && state.phase === 'PREPARING') return { state, actions: [] }
      const resumeTo = state.phase === 'BUSY' ? state.resumeTo : restOf(state)
      // Only the person's own turn starts a new idle period; a background task's or another session's
      // message renews the cache but does not reset what was asked and how often it was renewed.
      // A compaction that waits for a subagent outlasts the turn its result comes back in.
      const fresh = observation.by === 'person' ? { ...FRESH, ...UNHELD, workedAt: now } : {}
      // A turn known to be somebody else's (another session's message, a background task's result)
      // interrupts an open question without answering it. What the session asked for is kept, with the time
      // its countdown had left, and asked about again when that turn ends; a question about the cache is
      // simply not counted as asked. The person's own message drops the request, and so does a turn whose
      // origin is not known: it may be theirs.
      const isInterrupted = state.phase === 'ASKING' && observation.by === 'other'
      const kept =
        isInterrupted && state.askReason === 'session'
          ? { isRequested: true, requestMs: Math.max((state.askDeadline ?? now) - now, RESUMED_MIN_MS) }
          : { isRequested: false, requestMs: null }
      const unasked = isInterrupted && state.askReason === 'cache' ? { isAsked: false } : {}
      // Working on past an extension's question is an answer too, and the extension's to read.
      const passed = isExtensions(state) && observation.by === 'person' ? { ext: extension.passedOver(state) } : {}
      return { state: { ...state, ...fresh, ...passed, ...unasked, ...UNASKED, ...kept, isOrdered: false, lastCompaction: null, phase: 'BUSY', resumeTo }, actions: [...close, ...redraw] }
    }

    case 'request': {
      const anchored = { ...state, anchorAt: observation.sentAt, priorAnchorAt: state.anchorAt, retryAt: null }
      if (state.phase === 'PREPARING') return { state: anchored, actions: [] }
      return { state: { ...anchored, ...UNASKED, phase: 'BUSY', coldReason: null, resumeTo: null }, actions: [...close, ...redraw] }
    }

    case 'turn-complete': {
      const hold = observation.hold ?? null
      if (state.phase === 'PREPARING') {
        // The announcement was interrupted or failed: the person is back, or the session was told nothing.
        // Nothing more is done until they work again.
        if (observation.isAborted === true) {
          return { state: { ...state, phase: 'WARM', isDeclined: true }, actions: [{ kind: 'notify', text: CALLED_OFF }, ...redraw] }
        }
        // The session has been told: compact now, while the cache is warm, unless something came in the way
        // of a compaction the person did not order.
        if (hold !== null && !state.isOrdered) return { state: { ...state, phase: 'WARM', held: { by: hold, isTold: true } }, actions: redraw }
        return { state: { ...state, phase: 'COMPACTING' }, actions: [{ kind: 'compact' }, ...redraw] }
      }
      if (state.phase !== 'BUSY') return { state, actions: [] }
      // A turn whose last request ended in an error may never have reached the cache with it: what the
      // cache is known to have seen is the request before, or what it had seen before the turn.
      const hasFailedRequest = observation.isFailed === true && state.resumeTo === null
      const anchorAt = hasFailedRequest ? state.priorAnchorAt : state.anchorAt
      const ended = { ...state, anchorAt, resumeTo: null, isRequested: false, requestMs: null, contextTokens: observation.contextTokens ?? state.contextTokens }
      // A turn that ended before any request (an interrupt, an error) says nothing new about the cache:
      // the session is where it was, and only a cache that was warm may have run out meanwhile.
      if (state.resumeTo !== null && state.resumeTo !== 'WARM') return { state: { ...ended, phase: state.resumeTo }, actions: redraw }
      if (anchorAt === null) return { state: { ...ended, phase: 'UNKNOWN', coldReason: null }, actions: redraw }
      if (isPastMax(ended, now)) return { state: { ...ended, phase: 'COLD', coldReason: 'expired' }, actions: redraw }
      const rested: State = { ...ended, phase: 'WARM', coldReason: null }
      const deadline = askUntil(rested, now, EXTENSION_COUNTDOWN_MS)
      // What the session asked for in this turn comes first: compact at once, or ask the person. A turn the
      // person interrupted takes the request with it.
      const isRequested = state.isRequested && observation.isAborted !== true && config.enabled
      if (isRequested && config.sessionCompact === 'auto') {
        if (hold !== null) return { state: { ...rested, held: { by: hold, isTold: true } }, actions: redraw }
        return { state: { ...rested, held: null, phase: 'COMPACTING' }, actions: [{ kind: 'compact' }, ...redraw] }
      }
      if (isRequested && (config.sessionCompact === 'confirm' || config.sessionCompact === 'wait')) {
        const isWaiting = config.sessionCompact === 'wait'
        // The session may have asked for a countdown of its own; set to wait, there is none to run out.
        const until = isWaiting ? waitUntil(rested, now, config) : askUntil(rested, now, state.requestMs ?? config.compactCountdownMs)
        // Too little time is left to ask: compacting without the person's say is not what either means.
        if (until === null) return { state: rested, actions: [{ kind: 'notify', text: TOO_SOON }, ...redraw] }
        return {
          state: { ...rested, phase: 'ASKING', askReason: 'session', askDeadline: until },
          actions: [{ kind: 'ask', reason: 'session', deadline: until, selected: isWaiting ? 'skip' : 'compact' }, ...redraw],
        }
      }
      const reason = config.enabled ? extension.due(rested, config) : null
      const asked = reason === null ? undefined : extension.reasons[reason]
      if (reason === null || asked === undefined || deadline === null) return { state: rested, actions: redraw }
      return {
        state: { ...rested, phase: 'ASKING', askReason: reason, askDeadline: deadline },
        actions: [{ kind: 'ask', reason, deadline, selected: asked.selected }, ...redraw],
      }
    }

    case 'answer':
      if (state.phase !== 'ASKING') return { state, actions: [] }
      // An answer that comes after the cache ran out (the machine slept with the question open) is too
      // late: acting on it would send the whole context uncached.
      if (isPastMax(state, now)) return cold(state, 'expired', close)
      return act(state, observation.choice, config, extension, observation.isTimers === true ? { hold: observation.hold ?? null } : 'person')

    case 'renewed': {
      if (state.phase !== 'RENEWING') return { state, actions: [] }
      if (!observation.isHit) return cold(state, 'renew-missed')
      return { state: { ...state, phase: 'WARM', anchorAt: observation.sentAt, renewals: state.renewals + 1, retryAt: null }, actions: redraw }
    }

    // The request got no answer, so the cache is as warm as it was. It is tried once more, a little later,
    // if that stays within the cap; when that fails too, nothing more is sent and the person is told: a compaction cannot be undone, and
    // an API that does not answer is no reason to bring it forward.
    case 'renew-failed':
      if (state.phase !== 'RENEWING') return { state, actions: [] }
      // No second try after a first that failed, and none that would be a request above the cap.
      if (state.retryAt !== null || state.renewalsSent >= RENEWALS_CAP) {
        return { state: { ...state, phase: 'WARM', isDeclined: true, retryAt: null }, actions: [{ kind: 'notify', text: RENEW_FAILED }, ...redraw] }
      }
      return { state: { ...state, phase: 'WARM', retryAt: now + RETRY_AFTER_MS }, actions: redraw }

    case 'requested':
      return state.phase === 'BUSY' && !state.isRequested
        ? { state: { ...state, isRequested: true, requestMs: observation.countdownMs ?? null }, actions: [] }
        : { state, actions: [] }

    // Taken back: nothing is asked and nothing compacted on its account, a compaction that waits included.
    case 'withdrawn':
      if (!state.isRequested && state.held === null) return { state, actions: [] }
      return { state: { ...state, isRequested: false, requestMs: null, held: null }, actions: state.held === null ? [] : redraw }

    case 'compact-failed':
      return state.phase === 'COMPACTING' ? cold(state, 'compact-failed') : { state, actions: [] }

    // Found by the shell in its last look before the compaction: the announcement is behind it.
    case 'held':
      if (state.phase !== 'COMPACTING' || state.isOrdered) return { state, actions: [] }
      return { state: { ...state, phase: 'WARM', held: { by: observation.hold, isTold: true } }, actions: redraw }

    case 'refused': {
      if (state.phase !== 'RENEWING' && state.phase !== 'PREPARING' && state.phase !== 'COMPACTING') return { state, actions: [] }
      return { state: { ...state, ...UNHELD, phase: 'WARM', isDeclined: true }, actions: [{ kind: 'notify', text: observation.reason }, ...redraw] }
    }

    case 'ttl': {
      // The transcript was read: whatever it says, it is no longer unread.
      const read: State = observation.source === 'transcript' && state.isTtlUnread ? { ...state, isTtlUnread: false } : state
      const drawn = read === state ? [] : redraw
      if (!acceptsTtl(read.ttlSource, observation.source)) return { state: known(state, read, now, config), actions: drawn }
      if (read.ttlMs === observation.ttlMs && read.ttlSource === observation.source) return { state: known(state, read, now, config), actions: drawn }
      return { state: known(state, { ...read, ttlMs: observation.ttlMs, ttlSource: observation.source }, now, config), actions: redraw }
    }

    case 'ttl-unread':
      return state.isTtlUnread === observation.isUnread ? { state, actions: [] } : { state: known(state, { ...state, isTtlUnread: observation.isUnread }, now, config), actions: redraw }

    case 'model-switch': {
      const takesTtl = observation.ttlMs !== null && acceptsTtl(state.ttlSource, 'model-switch')
      const next: State = takesTtl ? { ...state, ttlMs: observation.ttlMs as number, ttlSource: 'model-switch' } : state
      // Another model reads nothing from this one's cache. A running turn keeps running; its next request
      // sets a new anchor.
      if (state.phase === 'BUSY') return { state: { ...next, anchorAt: null, resumeTo: null }, actions: redraw }
      if (state.phase === 'WARM' || state.phase === 'ASKING') {
        return { state: { ...next, ...UNASKED, ...UNHELD, phase: 'COLD', coldReason: 'model-switch' }, actions: [...close, ...redraw] }
      }
      return { state: next, actions: redraw }
    }

    case 'compacted': {
      // After a compaction the cached prefix is the old conversation: nothing here is worth keeping warm
      // until real work resumes. One that ran inside a turn leaves the turn running.
      const compacted = { ...state, ...FRESH, ...UNASKED, ...UNHELD, isRequested: false, requestMs: null, anchorAt: null, coldReason: null, contextTokens: null, ext: extension.reset(state.ext, 'compacted') }
      if (state.phase === 'BUSY') return { state: { ...compacted, resumeTo: 'DORMANT' }, actions: redraw }
      // The plugin's own compaction is said in the band until the next turn: who comes back sees what was done.
      const own = observation.own
      const lastCompaction = own === undefined ? state.lastCompaction : { ...own, idleMs: state.workedAt === null ? null : now - state.workedAt }
      return { state: { ...compacted, lastCompaction, phase: 'DORMANT', resumeTo: null }, actions: [...close, ...redraw] }
    }

    case 'resumed': {
      // Only where nothing is known yet: a process that has seen a request of its own knows better.
      if (state.phase !== 'UNKNOWN' || state.anchorAt !== null) return { state, actions: [] }
      const anchorAt = Math.min(observation.lastRequestAt, now)
      const resumed: State = { ...state, anchorAt, priorAnchorAt: null, workedAt: anchorAt, contextTokens: observation.contextTokens ?? state.contextTokens }
      // A cache that ran out while the session was closed is cold without a word: nobody was waiting.
      if (isPastMax(resumed, now)) return { state: { ...resumed, phase: 'COLD', coldReason: 'expired' }, actions: redraw }
      return { state: { ...resumed, phase: 'WARM', coldReason: null }, actions: redraw }
    }

    case 'cleared':
      return {
        state: { ...state, ...FRESH, ...UNASKED, ...UNHELD, lastCompaction: null, phase: 'UNKNOWN', anchorAt: null, coldReason: null, resumeTo: null, contextTokens: null, ext: extension.reset(state.ext, 'cleared'), isRequested: false, requestMs: null },
        actions: [...close, ...redraw],
      }
  }
}

export const decide = (state: State, now: number, observation: Observation, config: Config, extension: Extension = NONE): Decision => {
  const decision = step(withConfig(state, config), now, observation, config, extension)
  // Switched off, the plugin still follows the session, so switching it on mid-session starts from the truth.
  return config.enabled ? decision : { state: decision.state, actions: [] }
}
