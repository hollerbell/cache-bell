import { expect, test } from 'claude-code/testing'

import { HOUR_NOT_GRANTED, cacheBefore, decide, holdsBuiltinIdle, initialState, isBackWithinHour, isBuiltinIdle, isGuessed } from '../../core/decide'
import { TTL_1H, TTL_5M } from '../../core/timing'
import type { Action, Config, Observation, State } from '../../core/types'
import { configOf } from './options'

const S = 1000
// A Monday morning: 2026-01-12 09:00 UTC.
const T0 = Date.UTC(2026, 0, 12, 9)

// A configuration that only watches: it never asks, renews or compacts. Acting has tests of its own.
const config = configOf({ idleAsk: 'never', idleRenewals: 0, idleCompact: 'off' })
const tick: Observation = { kind: 'tick', gapMs: S }

const state = (over: Partial<State> = {}): State => ({ ...initialState(config), ...over })
const warm = (over: Partial<State> = {}): State => state({ phase: 'WARM', anchorAt: T0, ttlSource: 'transcript', ...over })

const kinds = (actions: Action[]): string[] => actions.map(action => action.kind)

// Feeds a list of [time, observation] and answers the state after the last one.
const run = (from: State, steps: [number, Observation][], cfg: Config = config): State =>
  steps.reduce((current, [now, observation]) => decide(current, now, observation, cfg).state, from)

test('the initial state knows nothing and assumes five minutes', () => {
  expect(initialState(config)).toEqual({ phase: 'UNKNOWN', anchorAt: null, ttlMs: TTL_5M, ttlSource: 'default', isTtlUnread: false, coldReason: null, resumeTo: null, renewals: 0, renewalsSent: 0, isAsked: false, isDeclined: false, isLetExpire: false, retryAt: null, contextTokens: null, askReason: null, askDeadline: null, ext: {}, isRequested: false, priorAnchorAt: null, held: null, isOrdered: false, requestMs: null, workedAt: null, lastCompaction: null })
  expect(initialState(configOf({ cacheTtl: '1h' }))).toMatchObject({ ttlMs: TTL_1H, ttlSource: 'config' })
})

test('on a TTL that is only a guess nothing is asked, renewed or compacted', () => {
  const acting = configOf({})
  // The default, the Claude Code settings and a model switch only say what was asked for, read or not.
  const guesses: Partial<State>[] = [
    { ttlSource: 'default', isTtlUnread: true },
    { ttlSource: 'default' },
    { ttlSource: 'settings', ttlMs: TTL_1H },
    { ttlSource: 'settings', ttlMs: TTL_5M },
    { ttlSource: 'model-switch', ttlMs: TTL_5M },
  ]
  for (const over of guesses) {
    const guessed = warm({ contextTokens: 150000, ...over })
    // Past every moment five minutes would name: the state stays the object it was.
    for (const seconds of [200, 240, 280, 600, 3000]) {
      const { state: after, actions } = decide(guessed, T0 + seconds * S, tick, acting)
      expect(after).toBe(guessed)
      expect(actions).toEqual([])
    }
    // Whatever the TTL was, an hour after the last request the cache is gone, and the notice names the hour.
    const gone = decide(guessed, T0 + 3600 * S, tick, acting)
    expect(gone.state).toMatchObject({ phase: 'COLD', coldReason: 'expired' })
    expect(gone.actions[0]).toEqual({ kind: 'notify', text: 'Prompt cache expired after 60 min without a request. The next message re-sends the whole context uncached.' })
  }
  // The same idle session with a TTL that was read is asked at its time.
  expect(kinds(decide(warm({ contextTokens: 150000 }), T0 + 215 * S, tick, acting).actions)).toContain('ask')
  // A TTL the person set in the options is no guess, with no transcript read.
  const byHand = configOf({ cacheTtl: '5m' })
  expect(kinds(decide(warm({ contextTokens: 150000, ttlSource: 'config', isTtlUnread: true }), T0 + 215 * S, tick, byHand).actions)).toContain('ask')
})

test('behind a guess a compaction that waits is neither asked about nor renewed for, and goes ahead when the way is clear', () => {
  const acting = configOf({})
  const waiting = warm({ contextTokens: 150000, ttlSource: 'default', isTtlUnread: true, held: { by: 'agent', isTold: true } })
  const held: Observation = { kind: 'tick', gapMs: S, hold: 'agent' }
  // Past the time the five assumed minutes would ask, renew and give the cache up at.
  for (const seconds of [215, 245, 280, 900]) {
    const { state: after, actions } = decide(waiting, T0 + seconds * S, held, acting)
    expect(after).toBe(waiting)
    expect(kinds(actions)).toEqual(['redraw'])
  }
  const clear = decide(waiting, T0 + 900 * S, tick, acting)
  expect(clear.state.phase).toBe('COMPACTING')
  expect(kinds(clear.actions)).toContain('compact')
})

test('a guess that ends past the time to ask leaves the cache alone in a mode that asks', () => {
  const acting = configOf({})
  const guessed = warm({ contextTokens: 150000, ttlSource: 'default', isTtlUnread: true })
  // Read at 4:10 and it is five minutes after all: too late for the question, so nothing is sent.
  const late = decide(guessed, T0 + 250 * S, { kind: 'ttl', ttlMs: TTL_5M, source: 'transcript' }, acting).state
  expect(late).toMatchObject({ isTtlUnread: false, ttlSource: 'transcript', isDeclined: true })
  expect(kinds(decide(late, T0 + 251 * S, tick, acting).actions)).toEqual(['redraw'])
  // A read that finds no TTL ends no guess: the default is still only that, and the timer still does nothing.
  const unnamed = decide(guessed, T0 + 250 * S, { kind: 'ttl-unread', isUnread: false }, acting).state
  expect(unnamed).toMatchObject({ isTtlUnread: false, ttlSource: 'default', isDeclined: false })
  expect(decide(unnamed, T0 + 251 * S, tick, acting).actions).toEqual([])
  // In time for the question, the course goes on as usual; and an hour leaves all the time there is.
  expect(decide(guessed, T0 + 100 * S, { kind: 'ttl', ttlMs: TTL_5M, source: 'transcript' }, acting).state.isDeclined).toBe(false)
  expect(decide(guessed, T0 + 250 * S, { kind: 'ttl', ttlMs: TTL_1H, source: 'transcript' }, acting).state.isDeclined).toBe(false)
  // Read at 3:40, past the time to ask but before the time to act: the next tick asks, up to 4:00.
  const between = decide(guessed, T0 + 220 * S, { kind: 'ttl', ttlMs: TTL_5M, source: 'transcript' }, acting).state
  expect(between.isDeclined).toBe(false)
  const asked = decide(between, T0 + 221 * S, tick, acting)
  expect(asked.state).toMatchObject({ phase: 'ASKING', askDeadline: T0 + 240 * S })
  expect(kinds(asked.actions)).toContain('ask')
  // Within the last ten seconds before it there is no time for a question.
  expect(decide(guessed, T0 + 231 * S, { kind: 'ttl', ttlMs: TTL_5M, source: 'transcript' }, acting).state.isDeclined).toBe(true)
  // A mode that never asks owes no question: it acts as it would have.
  const silent = configOf({ idleAsk: 'never', idleCompact: 'off' })
  expect(decide(guessed, T0 + 250 * S, { kind: 'ttl', ttlMs: TTL_5M, source: 'transcript' }, silent).state.isDeclined).toBe(false)
})

test('an hour named by the settings is a guess until a response confirms it; then the transcript counts', () => {
  const acting = configOf({})
  const hinted = warm({ contextTokens: 150000, ttlSource: 'settings', ttlMs: TTL_1H })
  // 35 minutes in, where the hour asks: nothing while it is only what was asked for.
  expect(decide(hinted, T0 + 2100 * S, tick, acting).actions).toEqual([])
  const confirmed = decide(hinted, T0 + 60 * S, { kind: 'ttl', ttlMs: TTL_1H, source: 'transcript' }, acting).state
  expect(confirmed).toMatchObject({ ttlMs: TTL_1H, ttlSource: 'transcript', isDeclined: false })
  expect(kinds(decide(confirmed, T0 + 2100 * S, tick, acting).actions)).toContain('ask')
  // Asked for the hour, granted five minutes: the transcript wins, and its course has the question at 3:30.
  const granted = decide(hinted, T0 + 60 * S, { kind: 'ttl', ttlMs: TTL_5M, source: 'transcript' }, acting).state
  expect(granted).toMatchObject({ ttlMs: TTL_5M, ttlSource: 'transcript' })
  expect(kinds(decide(granted, T0 + 210 * S, tick, acting).actions)).toContain('ask')
  // Later settings do not undo what the transcript showed.
  expect(decide(granted, T0 + 61 * S, { kind: 'ttl', ttlMs: TTL_1H, source: 'settings' }, acting).state).toBe(granted)
})

test('behind a guess the question about what the session asked for has the hour to be answered in', () => {
  const acting = configOf({})
  const asked = warm({ contextTokens: 150000, ttlSource: 'default', isTtlUnread: true, phase: 'ASKING', askReason: 'session', askDeadline: T0 + 330 * S })
  // 5:20 after the last request: with five minutes taken for a fact the cache would be called cold here.
  const { state: after, actions } = decide(asked, T0 + 320 * S, tick, acting)
  expect(after).toBe(asked)
  expect(actions).toEqual([])
})

test('a transcript that is read again is no longer unread, whatever it says', () => {
  const guessed = warm({ ttlSource: 'default', isTtlUnread: true })
  expect(decide(warm(), T0, { kind: 'ttl-unread', isUnread: true }, config)).toMatchObject({ state: { isTtlUnread: true }, actions: [{ kind: 'redraw' }] })
  expect(decide(guessed, T0, { kind: 'ttl-unread', isUnread: true }, config)).toEqual({ state: guessed, actions: [] })
  // Read, and it names no TTL: the default is all there is, still a guess.
  expect(decide(guessed, T0, { kind: 'ttl-unread', isUnread: false }, config)).toMatchObject({ state: { isTtlUnread: false, ttlSource: 'default' }, actions: [{ kind: 'redraw' }] })
  expect(decide(guessed, T0, { kind: 'ttl', ttlMs: TTL_1H, source: 'transcript' }, config).state).toMatchObject({ isTtlUnread: false, ttlMs: TTL_1H, ttlSource: 'transcript' })
  // The settings say what was asked for, not that the transcript was read.
  expect(decide(guessed, T0, { kind: 'ttl', ttlMs: TTL_1H, source: 'settings' }, config).state).toMatchObject({ isTtlUnread: true, ttlSource: 'settings' })
  // The same TTL as before, after a read that had failed: recorded as read.
  const confirmed = warm({ isTtlUnread: true, ttlMs: TTL_1H, ttlSource: 'transcript' })
  expect(decide(confirmed, T0, { kind: 'ttl', ttlMs: TTL_1H, source: 'transcript' }, config)).toMatchObject({ state: { isTtlUnread: false }, actions: [{ kind: 'redraw' }] })
})

test('a state written before the transcript\'s reading was tracked counts as read', () => {
  const { isTtlUnread: _, ...old } = warm()
  expect(decide(old as State, T0 + S, tick, config).state.isTtlUnread).toBe(false)
})

test('one observation moves the phase as the table says', () => {
  const late = T0 + 275 * S
  const table: [string, State, number, Observation, Partial<State>, string[]][] = [
    // name, from, now, observation, expected fields, expected actions
    ['a turn starts from nothing', state(), T0, { kind: 'turn-start', by: 'person' }, { phase: 'BUSY' }, ['redraw']],
    ['a turn starts on a warm cache', warm(), T0 + 9 * S, { kind: 'turn-start', by: 'person' }, { phase: 'BUSY', anchorAt: T0 }, ['redraw']],
    ['a turn wakes a cold session and remembers where it was', warm({ phase: 'COLD', coldReason: 'sleep' }), late, { kind: 'turn-start', by: 'person' }, { phase: 'BUSY', coldReason: 'sleep', resumeTo: 'COLD' }, ['redraw']],
    ['a turn wakes a dormant session', state({ phase: 'DORMANT' }), T0, { kind: 'turn-start', by: 'person' }, { phase: 'BUSY', resumeTo: 'DORMANT' }, ['redraw']],
    ['a turn on a warm cache remembers it', warm(), T0 + S, { kind: 'turn-start', by: 'person' }, { phase: 'BUSY', resumeTo: 'WARM' }, ['redraw']],
    ['a second turn start inside a turn keeps what was remembered', state({ phase: 'BUSY', resumeTo: 'DORMANT' }), T0, { kind: 'turn-start', by: 'person' }, { phase: 'BUSY', resumeTo: 'DORMANT' }, ['redraw']],
    ['a request sets the anchor to when it was sent', state({ phase: 'BUSY' }), T0 + 5 * S, { kind: 'request', sentAt: T0 + 4 * S }, { phase: 'BUSY', anchorAt: T0 + 4 * S }, ['redraw']],
    ['a request ends the memory of the phase before', state({ phase: 'BUSY', resumeTo: 'COLD', coldReason: 'sleep' }), T0, { kind: 'request', sentAt: T0 }, { phase: 'BUSY', resumeTo: null, coldReason: null }, ['redraw']],
    ['a turn interrupted before its request stays dormant', state({ phase: 'BUSY', resumeTo: 'DORMANT' }), T0, { kind: 'turn-complete' }, { phase: 'DORMANT', resumeTo: null }, ['redraw']],
    ['a turn interrupted before its request stays cold for the same reason', warm({ phase: 'BUSY', resumeTo: 'COLD', coldReason: 'sleep' }), late, { kind: 'turn-complete' }, { phase: 'COLD', coldReason: 'sleep', resumeTo: null }, ['redraw']],
    ['a turn interrupted before its request stays unknown', state({ phase: 'BUSY', resumeTo: 'UNKNOWN' }), T0, { kind: 'turn-complete' }, { phase: 'UNKNOWN', resumeTo: null }, ['redraw']],
    ['a turn interrupted before its request leaves a warm cache warm', warm({ phase: 'BUSY', resumeTo: 'WARM' }), T0 + 9 * S, { kind: 'turn-complete' }, { phase: 'WARM', anchorAt: T0, resumeTo: null }, ['redraw']],
    ['a warm cache that ran out during such a turn is cold', warm({ phase: 'BUSY', resumeTo: 'WARM' }), late, { kind: 'turn-complete' }, { phase: 'COLD', coldReason: 'expired', resumeTo: null }, ['redraw']],
    ['a turn that only compacted ends dormant', state({ phase: 'BUSY', anchorAt: T0 }), T0 + 60 * S, { kind: 'compacted' }, { phase: 'BUSY', anchorAt: null, resumeTo: 'DORMANT' }, ['redraw']],
    ['a later request moves the anchor', state({ phase: 'BUSY', anchorAt: T0 }), T0 + 60 * S, { kind: 'request', sentAt: T0 + 60 * S }, { anchorAt: T0 + 60 * S }, ['redraw']],
    ['a finished turn leaves the cache warm', state({ phase: 'BUSY', anchorAt: T0 }), T0 + 20 * S, { kind: 'turn-complete' }, { phase: 'WARM', anchorAt: T0 }, ['redraw']],
    ['a turn that ended before any request says nothing', state({ phase: 'BUSY' }), T0, { kind: 'turn-complete' }, { phase: 'UNKNOWN' }, ['redraw']],
    ['a turn whose last request is too old ends cold', state({ phase: 'BUSY', anchorAt: T0, ttlSource: 'transcript' }), late, { kind: 'turn-complete' }, { phase: 'COLD', coldReason: 'expired' }, ['redraw']],
    ['a turn end outside a turn changes nothing', warm(), T0 + S, { kind: 'turn-complete' }, { phase: 'WARM' }, []],
    ['a tick on a warm cache redraws the countdown', warm(), late - 1, tick, { phase: 'WARM' }, ['redraw']],
    ['a tick at the upper bound turns it cold', warm(), late, tick, { phase: 'COLD', coldReason: 'expired' }, ['notify', 'redraw']],
    ['a tick after a long gap blames the sleep', warm(), T0 + 3600 * S, { kind: 'tick', gapMs: 30 * S + 1 }, { phase: 'COLD', coldReason: 'sleep' }, ['notify', 'redraw']],
    ['a gap of exactly the limit is not a sleep', warm(), late, { kind: 'tick', gapMs: 30 * S }, { phase: 'COLD', coldReason: 'expired' }, ['notify', 'redraw']],
    ['a long gap that leaves the cache warm is harmless', warm({ ttlMs: TTL_1H }), T0 + 600 * S, { kind: 'tick', gapMs: 500 * S }, { phase: 'WARM' }, ['redraw']],
    ['a tick while busy does nothing', state({ phase: 'BUSY', anchorAt: T0 }), late, tick, { phase: 'BUSY' }, []],
    ['a tick while cold does nothing', warm({ phase: 'COLD', coldReason: 'expired' }), late + S, tick, { phase: 'COLD' }, []],
    ['a tick while dormant does nothing', state({ phase: 'DORMANT' }), late, tick, { phase: 'DORMANT' }, []],
    ['a tick while unknown does nothing', state(), late, tick, { phase: 'UNKNOWN' }, []],
    ['a compaction puts an idle session to sleep', warm(), T0 + 60 * S, { kind: 'compacted' }, { phase: 'DORMANT', anchorAt: null }, ['redraw']],
    ['a compaction of a cold session clears the reason', warm({ phase: 'COLD', coldReason: 'expired' }), late, { kind: 'compacted' }, { phase: 'DORMANT', anchorAt: null, coldReason: null }, ['redraw']],
    ['a compaction inside a turn leaves the turn running', state({ phase: 'BUSY', anchorAt: T0 }), T0 + 60 * S, { kind: 'compacted' }, { phase: 'BUSY', anchorAt: null }, ['redraw']],
    ['a /clear forgets everything', warm(), T0 + S, { kind: 'cleared' }, { phase: 'UNKNOWN', anchorAt: null }, ['redraw']],
    ['a /clear of a cold session clears the reason', warm({ phase: 'COLD', coldReason: 'sleep' }), late, { kind: 'cleared' }, { phase: 'UNKNOWN', anchorAt: null, coldReason: null }, ['redraw']],
    ['another model reads nothing from a warm cache', warm(), T0 + S, { kind: 'model-switch', ttlMs: TTL_1H }, { phase: 'COLD', coldReason: 'model-switch', ttlMs: TTL_1H, ttlSource: 'model-switch' }, ['redraw']],
    ['a model switch without a TTL keeps the TTL', warm({ ttlMs: TTL_1H, ttlSource: 'transcript' }), T0 + S, { kind: 'model-switch', ttlMs: null }, { phase: 'COLD', ttlMs: TTL_1H, ttlSource: 'transcript' }, ['redraw']],
    ['a model switch inside a turn drops the anchor', state({ phase: 'BUSY', anchorAt: T0 }), T0 + S, { kind: 'model-switch', ttlMs: null }, { phase: 'BUSY', anchorAt: null }, ['redraw']],
    ['a model switch before any turn stays unknown', state(), T0, { kind: 'model-switch', ttlMs: TTL_1H }, { phase: 'UNKNOWN', ttlMs: TTL_1H }, ['redraw']],
    ['a model switch leaves a dormant session dormant', state({ phase: 'DORMANT' }), T0, { kind: 'model-switch', ttlMs: null }, { phase: 'DORMANT' }, ['redraw']],
  ]
  for (const [name, from, now, observation, fields, actions] of table) {
    const result = decide(from, now, observation, config)
    const got = Object.fromEntries(Object.keys(fields).map(key => [key, result.state[key as keyof State]]))
    expect({ name, state: got, actions: kinds(result.actions) }).toEqual({ name, state: fields, actions })
  }
})

test('the TTL is taken from the strongest source', () => {
  const table: [string, Partial<State>, Observation, Partial<State>, string[]][] = [
    ['the transcript replaces the default', {}, { kind: 'ttl', ttlMs: TTL_1H, source: 'transcript' }, { ttlMs: TTL_1H, ttlSource: 'transcript' }, ['redraw']],
    ['the settings replace the default', {}, { kind: 'ttl', ttlMs: TTL_1H, source: 'settings' }, { ttlMs: TTL_1H, ttlSource: 'settings' }, ['redraw']],
    ['the settings replace older settings', { ttlMs: TTL_1H, ttlSource: 'settings' }, { kind: 'ttl', ttlMs: TTL_5M, source: 'settings' }, { ttlMs: TTL_5M, ttlSource: 'settings' }, ['redraw']],
    ['the settings never replace the transcript', { ttlMs: TTL_5M, ttlSource: 'transcript' }, { kind: 'ttl', ttlMs: TTL_1H, source: 'settings' }, { ttlMs: TTL_5M, ttlSource: 'transcript' }, []],
    ['the settings never replace a model switch', { ttlMs: TTL_5M, ttlSource: 'model-switch' }, { kind: 'ttl', ttlMs: TTL_1H, source: 'settings' }, { ttlMs: TTL_5M, ttlSource: 'model-switch' }, []],
    ['a newer transcript replaces a model switch', { ttlMs: TTL_5M, ttlSource: 'model-switch' }, { kind: 'ttl', ttlMs: TTL_1H, source: 'transcript' }, { ttlMs: TTL_1H, ttlSource: 'transcript' }, ['redraw']],
    ['a model switch replaces an older transcript', { ttlMs: TTL_5M, ttlSource: 'transcript' }, { kind: 'model-switch', ttlMs: TTL_1H }, { ttlMs: TTL_1H, ttlSource: 'model-switch' }, ['redraw']],
    ['the same TTL from the same source is no news', { ttlMs: TTL_1H, ttlSource: 'transcript' }, { kind: 'ttl', ttlMs: TTL_1H, source: 'transcript' }, { ttlMs: TTL_1H, ttlSource: 'transcript' }, []],
    ['the same TTL from a stronger source is recorded', { ttlMs: TTL_1H, ttlSource: 'settings' }, { kind: 'ttl', ttlMs: TTL_1H, source: 'transcript' }, { ttlMs: TTL_1H, ttlSource: 'transcript' }, ['redraw']],
    ['the plugin\'s own request replaces an older transcript', { ttlMs: TTL_5M, ttlSource: 'transcript' }, { kind: 'ttl', ttlMs: TTL_1H, source: 'requested' }, { ttlMs: TTL_1H, ttlSource: 'requested' }, ['redraw']],
    ['the transcript corrects the plugin\'s own request', { ttlMs: TTL_1H, ttlSource: 'requested' }, { kind: 'ttl', ttlMs: TTL_5M, source: 'transcript' }, { ttlMs: TTL_5M, ttlSource: 'transcript' }, ['notify', 'redraw']],
    ['the settings replace a request the plugin took back', { ttlMs: TTL_1H, ttlSource: 'requested' }, { kind: 'ttl', ttlMs: TTL_5M, source: 'settings' }, { ttlMs: TTL_5M, ttlSource: 'settings' }, ['redraw']],
    ['with nothing set, a request taken back leaves the default', { ttlMs: TTL_1H, ttlSource: 'requested' }, { kind: 'ttl', ttlMs: TTL_5M, source: 'default' }, { ttlMs: TTL_5M, ttlSource: 'default' }, ['redraw']],
    // The hour given back: the cache written with it lives on, until a response shows the new TTL.
    ['the default never replaces the transcript', { ttlMs: TTL_1H, ttlSource: 'transcript' }, { kind: 'ttl', ttlMs: TTL_5M, source: 'default' }, { ttlMs: TTL_1H, ttlSource: 'transcript' }, []],
    // A model switch was only asked for, on a cold cache: given back, the hour goes.
    ['the default replaces a model switch', { ttlMs: TTL_1H, ttlSource: 'model-switch' }, { kind: 'ttl', ttlMs: TTL_5M, source: 'default' }, { ttlMs: TTL_5M, ttlSource: 'default' }, ['redraw']],
  ]
  for (const [name, from, observation, fields, actions] of table) {
    const result = decide(state(from), T0, observation, config)
    const got = { ttlMs: result.state.ttlMs, ttlSource: result.state.ttlSource }
    expect({ name, state: got, actions: kinds(result.actions) }).toEqual({ name, state: fields, actions })
  }
})

test('the plugin\'s own request is a guess: the timer does nothing on it until a response shows it', () => {
  const asked = warm({ ttlMs: TTL_1H, ttlSource: 'requested' })
  expect(isGuessed(asked)).toBe(true)
  expect(isGuessed({ ...asked, ttlSource: 'transcript' })).toBe(false)
})

test('a response that shows less than the hour the plugin asked for is said once', () => {
  const asked = state({ ttlMs: TTL_1H, ttlSource: 'requested' })
  const refused = decide(asked, T0, { kind: 'ttl', ttlMs: TTL_5M, source: 'transcript' }, config)
  expect(refused.actions).toEqual([{ kind: 'notify', text: HOUR_NOT_GRANTED }, { kind: 'redraw' }])
  // Read again, the same five minutes are no news.
  expect(kinds(decide(refused.state, T0, { kind: 'ttl', ttlMs: TTL_5M, source: 'transcript' }, config).actions)).toEqual([])
  // Granted, or five minutes the plugin never asked against: nothing to say.
  expect(kinds(decide(asked, T0, { kind: 'ttl', ttlMs: TTL_1H, source: 'transcript' }, config).actions)).toEqual(['redraw'])
  expect(kinds(decide(state({ ttlMs: TTL_1H, ttlSource: 'settings' }), T0, { kind: 'ttl', ttlMs: TTL_5M, source: 'transcript' }, config).actions)).toEqual(['redraw'])
})

test('the person is back within the hour only after the plugin\'s own compaction of an idle session on a short cache, one that knows its time', () => {
  const after = (at: number | undefined, isIdleShort = true) => state({ phase: 'DORMANT', lastCompaction: { before: 1, after: 1, idleMs: 1, isIdleShort, ...(at === undefined ? {} : { at }) } })
  expect(isBackWithinHour(after(T0), T0 + 59 * 60 * S)).toBe(true)
  expect(isBackWithinHour(after(T0), T0 + 60 * 60 * S)).toBe(false)
  expect(isBackWithinHour(after(T0), T0 - S)).toBe(false)
  // Kept by a version before 0.3.2, or none at all.
  expect(isBackWithinHour(after(undefined), T0)).toBe(false)
  expect(isBackWithinHour(state(), T0)).toBe(false)
  // A compaction for the size, or one Claude asked for: the hour would have spared none of them.
  expect(isBackWithinHour(after(T0, false), T0 + S)).toBe(false)
  // The plugin's own compaction is stamped with its time, and says whether the hour would have spared it.
  const compacted = decide(state({ phase: 'WARM', anchorAt: T0 }), T0 + 5 * S, { kind: 'compacted', own: { before: 2, after: 1, isIdle: true } }, config)
  expect(compacted.state.lastCompaction).toMatchObject({ at: T0 + 5 * S, isIdleShort: true })
  expect(decide(state({ phase: 'WARM', anchorAt: T0 }), T0, { kind: 'compacted', own: { before: 2, after: 1 } }, config).state.lastCompaction?.isIdleShort).toBe(false)
  expect(decide(state({ phase: 'WARM', anchorAt: T0, ttlMs: TTL_1H }), T0, { kind: 'compacted', own: { before: 2, after: 1, isIdle: true } }, config).state.lastCompaction?.isIdleShort).toBe(false)
})

test('the TTL asked for may change only before a request on a cache that is cold anyway', () => {
  const busy = (over: Partial<State>): State => state({ phase: 'BUSY', anchorAt: T0, ttlSource: 'transcript', ...over })
  const table: [string, State, number, string][] = [
    ['a new conversation: nothing seen yet', busy({ anchorAt: null, resumeTo: 'UNKNOWN', ttlSource: 'default' }), T0, 'unknown'],
    ['the first request after a cold cache', busy({ resumeTo: 'COLD' }), T0 + 10 * 60 * S, 'cold'],
    ['the first request after a compaction', busy({ anchorAt: null, resumeTo: 'DORMANT' }), T0, 'cold'],
    ['a model switch inside the turn', busy({ anchorAt: null, resumeTo: null }), T0, 'cold'],
    ['the first request on a warm cache', busy({ resumeTo: 'WARM' }), T0 + 60 * S, 'warm'],
    ['a warm cache whose time ran out before the tick saw it', busy({ resumeTo: 'WARM', ttlMs: TTL_5M }), T0 + 6 * 60 * S, 'cold'],
    ['behind a guess the cache may live an hour', busy({ resumeTo: 'WARM', ttlMs: TTL_5M, ttlSource: 'settings' }), T0 + 6 * 60 * S, 'warm'],
    ['a later request of the same turn', busy({ resumeTo: null }), T0 + 30 * S, 'warm'],
    ['a resumed session known to be warm', state({ phase: 'WARM', anchorAt: T0, ttlSource: 'transcript' }), T0 + 60 * S, 'warm'],
    ['the plugin\'s own renewal', state({ phase: 'RENEWING', anchorAt: T0, ttlSource: 'transcript' }), T0 + 60 * S, 'warm'],
    ['a dormant session', state({ phase: 'DORMANT', anchorAt: null }), T0, 'cold'],
    ['taken for cold before its end, so the plugin acts in time: still warm', busy({ resumeTo: 'COLD', coldReason: 'expired', ttlMs: TTL_5M }), T0 + 290 * S, 'warm'],
    ['the hour in its last minutes', busy({ resumeTo: 'WARM', ttlMs: TTL_1H }), T0 + 58 * 60 * S, 'warm'],
    ['cold since another model took over', busy({ resumeTo: 'COLD', coldReason: 'model-switch' }), T0 + 30 * S, 'cold'],
    ['a clock set back says nothing of the cache', busy({ resumeTo: 'WARM' }), T0 - 10 * 60 * S, 'warm'],
  ]
  for (const [name, from, now, expected] of table) expect({ name, got: cacheBefore(from, now) }).toEqual({ name, got: expected })
})

test('a TTL set by hand beats everything, and stops doing so once it is unset', () => {
  const byHand = configOf({ cacheTtl: '1h' })
  const seen = run(state(), [[T0, { kind: 'ttl', ttlMs: TTL_5M, source: 'transcript' }]])
  expect(seen).toMatchObject({ ttlMs: TTL_5M, ttlSource: 'transcript' })

  const forced = run(seen, [[T0, tick]], byHand)
  expect(forced).toMatchObject({ ttlMs: TTL_1H, ttlSource: 'config' })
  expect(run(forced, [[T0, { kind: 'ttl', ttlMs: TTL_5M, source: 'transcript' }]], byHand)).toMatchObject({ ttlMs: TTL_1H, ttlSource: 'config' })
  expect(run(forced, [[T0, { kind: 'model-switch', ttlMs: TTL_5M }]], byHand)).toMatchObject({ ttlMs: TTL_1H, ttlSource: 'config' })

  expect(run(forced, [[T0, tick]], config)).toMatchObject({ ttlMs: TTL_5M, ttlSource: 'default' })
})

test('the timers run from the last request, not from the end of the turn', () => {
  // The request went out at T0, the turn ran tools for 100 s after it: the cache has 175 s left, not 275.
  const idle = run(state({ ttlSource: 'transcript' }), [
    [T0, { kind: 'turn-start', by: 'person' }],
    [T0, { kind: 'request', sentAt: T0 }],
    [T0 + 100 * S, { kind: 'turn-complete' }],
  ])
  expect(idle).toMatchObject({ phase: 'WARM', anchorAt: T0 })
  expect(run(idle, [[T0 + 275 * S - 1, tick]]).phase).toBe('WARM')
  expect(run(idle, [[T0 + 275 * S, tick]]).phase).toBe('COLD')
})

test('an hour-long cache stays warm for 55 minutes', () => {
  const idle = warm({ ttlMs: TTL_1H, ttlSource: 'transcript' })
  expect(run(idle, [[T0 + 3300 * S - 1, tick]]).phase).toBe('WARM')
  expect(run(idle, [[T0 + 3300 * S, tick]]).phase).toBe('COLD')
})

test('a whole session: work, idle, cold, work again, compaction, work again', () => {
  const steps: [number, Observation, string][] = [
    [T0, { kind: 'turn-start', by: 'person' }, 'BUSY'],
    [T0 + S, { kind: 'request', sentAt: T0 + S }, 'BUSY'],
    [T0 + 30 * S, { kind: 'request', sentAt: T0 + 30 * S }, 'BUSY'],
    [T0 + 40 * S, { kind: 'turn-complete' }, 'WARM'],
    [T0 + 41 * S, { kind: 'ttl', ttlMs: TTL_5M, source: 'transcript' }, 'WARM'],
    [T0 + 300 * S, tick, 'WARM'],
    [T0 + 305 * S, tick, 'COLD'],
    [T0 + 900 * S, { kind: 'turn-start', by: 'person' }, 'BUSY'],
    [T0 + 901 * S, { kind: 'request', sentAt: T0 + 901 * S }, 'BUSY'],
    [T0 + 910 * S, { kind: 'turn-complete' }, 'WARM'],
    [T0 + 950 * S, { kind: 'compacted' }, 'DORMANT'],
    [T0 + 2000 * S, tick, 'DORMANT'],
    [T0 + 3000 * S, { kind: 'turn-start', by: 'person' }, 'BUSY'],
    [T0 + 3001 * S, { kind: 'request', sentAt: T0 + 3001 * S }, 'BUSY'],
    [T0 + 3005 * S, { kind: 'turn-complete' }, 'WARM'],
  ]
  let current = state()
  for (const [now, observation, phase] of steps) {
    current = decide(current, now, observation, config).state
    expect({ at: now - T0, phase: current.phase }).toEqual({ at: now - T0, phase })
  }
})

test('the notice says why the cache went cold', () => {
  const text = (ttlMs: number, gapMs: number): string => {
    const action = decide(warm({ ttlMs }), T0 + 2 * TTL_1H, { kind: 'tick', gapMs }, config).actions[0]
    return action?.kind === 'notify' ? action.text : ''
  }
  expect(text(TTL_5M, S)).toBe('Prompt cache expired after 5 min without a request. The next message re-sends the whole context uncached.')
  expect(text(TTL_1H, S)).toMatch(/after 60 min without a request/)
  expect(text(TTL_5M, 3600 * S)).toBe('Prompt cache expired while this machine slept. The next message re-sends the whole context uncached.')
})

test('switched off, the plugin follows the session and does nothing', () => {
  const off = configOf({ enabled: false })
  const result = decide(warm(), T0 + 275 * S, tick, off)
  expect(result.state.phase).toBe('COLD')
  expect(result.actions).toEqual([])
})

test('a state that did not change is the same object', () => {
  const idle = warm()
  expect(decide(idle, T0 + S, tick, config).state === idle).toBe(true)
  expect(decide(idle, T0 + S, { kind: 'turn-complete' }, config).state === idle).toBe(true)

  // Also with a TTL set by hand: otherwise the shell would write the state at every tick.
  const byHand = configOf({ cacheTtl: '1h' })
  const forced = decide(state(), T0, tick, byHand).state
  expect(forced).toMatchObject({ ttlMs: TTL_1H, ttlSource: 'config' })
  expect(decide(forced, T0 + S, tick, byHand).state === forced).toBe(true)
})

test('a resumed session is warm from its last request, or cold without a word when the cache ran out meanwhile', () => {
  const hour = state({ ttlMs: TTL_1H, ttlSource: 'transcript' })
  const warmed = decide(hour, T0, { kind: 'resumed', lastRequestAt: T0 - 845 * S, contextTokens: 48261 }, config)
  expect(warmed.state).toMatchObject({ phase: 'WARM', anchorAt: T0 - 845 * S, workedAt: T0 - 845 * S, contextTokens: 48261, coldReason: null })
  expect(kinds(warmed.actions)).toEqual(['redraw'])

  const gone = decide(hour, T0, { kind: 'resumed', lastRequestAt: T0 - 8 * 3600 * S }, config)
  expect(gone.state).toMatchObject({ phase: 'COLD', coldReason: 'expired', anchorAt: T0 - 8 * 3600 * S, contextTokens: null })
  expect(kinds(gone.actions)).toEqual(['redraw'])

  // Five minutes read from the transcript: four minutes ago is warm, six is not.
  const short = state({ ttlSource: 'transcript' })
  expect(decide(short, T0, { kind: 'resumed', lastRequestAt: T0 - 240 * S }, config).state.phase).toBe('WARM')
  expect(decide(short, T0, { kind: 'resumed', lastRequestAt: T0 - 360 * S }, config).state.phase).toBe('COLD')
  // Behind a guess the cache may live the hour: six minutes ago is still warm, 55 is not.
  expect(decide(state(), T0, { kind: 'resumed', lastRequestAt: T0 - 360 * S }, config).state.phase).toBe('WARM')
  expect(decide(state(), T0, { kind: 'resumed', lastRequestAt: T0 - 3300 * S }, config).state.phase).toBe('COLD')
  // A time ahead of the clock is taken as now.
  expect(decide(state(), T0, { kind: 'resumed', lastRequestAt: T0 + 60 * S }, config).state).toMatchObject({ phase: 'WARM', anchorAt: T0 })
})

test('a resume does not turn a guess into a known TTL', () => {
  const acting = configOf({})
  for (const over of [{}, { ttlSource: 'settings', ttlMs: TTL_1H }, { ttlSource: 'model-switch', ttlMs: TTL_5M }] as Partial<State>[]) {
    const resumed = decide(state(over), T0, { kind: 'resumed', lastRequestAt: T0 - 60 * S, contextTokens: 150000 }, acting).state
    expect(resumed).toMatchObject({ phase: 'WARM', ttlSource: over.ttlSource ?? 'default' })
    // Past the time five minutes would ask and act at: nothing.
    for (const seconds of [150, 200, 600]) expect(decide(resumed, T0 + seconds * S, tick, acting).actions).toEqual([])
    // Only the transcript ends the guess; the course then follows what it says.
    const read = decide(resumed, T0 + 30 * S, { kind: 'ttl', ttlMs: TTL_5M, source: 'transcript' }, acting).state
    expect(read).toMatchObject({ ttlSource: 'transcript', isDeclined: false })
    expect(kinds(decide(read, T0 + 155 * S, tick, acting).actions)).toContain('ask')
  }
})

test('a resume changes nothing where the process has already seen the session at work', () => {
  for (const known of [warm(), state({ phase: 'BUSY', anchorAt: T0 }), state({ phase: 'COLD', anchorAt: T0, coldReason: 'expired' }), state({ phase: 'DORMANT' }), state({ phase: 'BUSY', resumeTo: 'UNKNOWN' })]) {
    const { state: after, actions } = decide(known, T0 + 10 * S, { kind: 'resumed', lastRequestAt: T0 - 100 * S, contextTokens: 5 }, config)
    expect(after).toBe(known)
    expect(actions).toEqual([])
  }
})

test('a resumed session is watched like any other: the question comes when its time does', () => {
  const acting = configOf({})
  const resumed = decide(state({ ttlMs: TTL_1H, ttlSource: 'transcript' }), T0, { kind: 'resumed', lastRequestAt: T0 - 600 * S, contextTokens: 150000 }, acting).state
  expect(kinds(decide(resumed, T0 + S, tick, acting).actions)).not.toContain('ask')
  const later = decide(resumed, T0 + 30 * 60 * S, tick, acting)
  expect(kinds(later.actions)).toContain('ask')
})

// Claude Code's own compaction of an idle session comes at nine tenths of the hour.
const BUILTIN_AT = T0 + 54 * 60 * S

test("Claude Code's idle compaction is held where the plugin looks after the idle period", () => {
  const acting = configOf({})
  const hour = { ttlMs: TTL_1H, contextTokens: 250000 }
  const chosen = { ...hour, isAsked: true, isDeclined: true, isLetExpire: true }
  for (const looked of [warm(hour), warm({ ...hour, isAsked: true, renewals: 2 }), warm(chosen), warm({ ...hour, phase: 'ASKING' }), warm({ ...hour, phase: 'RENEWING' }), warm({ ...hour, phase: 'COMPACTING' })]) {
    expect(holdsBuiltinIdle(looked, acting)).toBe(true)
  }
  // Set never to compact an idle session: the renewals used up, the cache is left to expire, not compacted.
  expect(holdsBuiltinIdle(warm({ ...hour, isAsked: true, renewals: 2 }), configOf({ idleCompact: 'off' }))).toBe(true)
  // A turn that runs compacts for its size; a cache the plugin knows nothing of or only guessed (its timer
  // does nothing on a guess), a small context, an idle period the plugin gave up on by itself, a profile that
  // does not compact and a plugin switched off leave it to Claude Code.
  const left = [
    warm({ ...hour, phase: 'BUSY' }),
    warm({ ...hour, phase: 'PREPARING' }),
    warm({ ...hour, phase: 'UNKNOWN' }),
    warm({ ...hour, phase: 'DORMANT' }),
    warm({ ...hour, ttlSource: 'settings' }),
    warm({ ...hour, contextTokens: 50000 }),
    warm({ ...hour, isDeclined: true }),
  ]
  for (const one of left) expect(holdsBuiltinIdle(one, acting)).toBe(false)
  expect(holdsBuiltinIdle(warm(hour), configOf({ profile: 'watch' }))).toBe(false)
  expect(holdsBuiltinIdle(warm(hour), configOf({ enabled: false }))).toBe(false)
  // Acting without asking is looking after it too.
  expect(holdsBuiltinIdle(warm(hour), configOf({ idleAsk: 'never' }))).toBe(true)
})

test("only 'auto' with no instructions, of the main conversation, between turns, may be Claude Code's idle compaction", () => {
  expect(isBuiltinIdle({ trigger: 'auto' }, false, false)).toBe(true)
  expect(isBuiltinIdle({ trigger: 'auto', instructions: '' }, false, false)).toBe(true)
  // The plugin's own, whatever it comes as, is never held back.
  for (const e of [{ trigger: 'auto' }, { trigger: 'auto', instructions: '' }, { trigger: 'manual' }, {}]) expect(isBuiltinIdle(e, true, false)).toBe(false)
  // In a turn, or with a message on its way to open one: the compaction for the context's size.
  expect(isBuiltinIdle({ trigger: 'auto' }, false, true)).toBe(false)
  for (const e of [{ trigger: 'manual' }, { trigger: 'precompute' }, { trigger: 'auto', agentId: 'a1' }, { trigger: 'auto', instructions: 'Keep the paths.' }]) {
    expect(isBuiltinIdle(e, false, false)).toBe(false)
  }
})

test('held, it is asked about only where nothing was offered in this idle period', () => {
  const acting = configOf({})
  // A question an interrupted turn took down, or a timer that waited for the person's typing.
  const unasked = warm({ ttlMs: TTL_1H, contextTokens: 250000 })
  const { state: asked, actions } = decide(unasked, BUILTIN_AT, { kind: 'builtin-idle' }, acting)
  expect(asked).toMatchObject({ phase: 'ASKING', isAsked: true, askReason: 'cache' })
  const ask = actions.find(action => action.kind === 'ask')
  expect(ask).toMatchObject({ reason: 'cache', selected: 'renew' })
  // Past the time to act: the countdown of a question, within the cache's last safe moment.
  expect(asked.askDeadline).toBe(BUILTIN_AT + 30 * S)
  // Before it, the question stays up to the time to act, as the timer's own would.
  const early = decide(unasked, T0 + 40 * 60 * S, { kind: 'builtin-idle' }, acting).state
  expect(early.askDeadline).toBe(T0 + 50 * 60 * S)
  // Asked already, declined, waiting with a compaction, a question open, or set never to ask: nothing more.
  for (const done of [{ ...unasked, isAsked: true }, { ...unasked, isDeclined: true }, { ...unasked, held: { by: 'typing' as const, isTold: false } }, { ...unasked, phase: 'ASKING' as const }]) {
    const after = decide(done, BUILTIN_AT, { kind: 'builtin-idle' }, acting)
    expect(after.state).toBe(done)
    expect(after.actions).toEqual([])
  }
  expect(decide(unasked, BUILTIN_AT, { kind: 'builtin-idle' }, configOf({ idleAsk: 'never' })).actions).toEqual([])
  // Too late for a question: nothing is asked, and the timer acts at its next tick.
  const late = T0 + 54 * 60 * S + 55 * S
  expect(decide(unasked, late, { kind: 'builtin-idle' }, acting).actions).toEqual([])
  expect(kinds(decide(unasked, late, tick, acting).actions)).toContain('renew')
})
