import { expect, test } from 'claude-code/testing'

import { resolveConfig } from '../../core/config'
import { decide, initialState } from '../../core/decide'
import { TTL_1H, TTL_5M } from '../../core/timing'
import type { Action, Config, Observation, State } from '../../core/types'

const S = 1000
// A Monday morning: 2026-01-12 09:00 UTC.
const T0 = Date.UTC(2026, 0, 12, 9)

// A configuration that only watches: it never asks, renews or compacts. Acting has tests of its own.
const config = resolveConfig({ mode: 'custom', ask: 'never', renewMethod: 'none', compact: false })
const tick: Observation = { kind: 'tick', gapMs: S }

const state = (over: Partial<State> = {}): State => ({ ...initialState(config), ...over })
const warm = (over: Partial<State> = {}): State => state({ phase: 'WARM', anchorAt: T0, ...over })

const kinds = (actions: Action[]): string[] => actions.map(action => action.kind)

// Feeds a list of [time, observation] and answers the state after the last one.
const run = (from: State, steps: [number, Observation][], cfg: Config = config): State =>
  steps.reduce((current, [now, observation]) => decide(current, now, observation, cfg).state, from)

test('the initial state knows nothing and assumes five minutes', () => {
  expect(initialState(config)).toEqual({ phase: 'UNKNOWN', anchorAt: null, ttlMs: TTL_5M, ttlSource: 'default', isTtlUnread: false, coldReason: null, resumeTo: null, renewals: 0, renewalsSent: 0, isAsked: false, isDeclined: false, retryAt: null, contextTokens: null, askReason: null, askDeadline: null, ext: {}, isRequested: false, priorAnchorAt: null, held: null, isOrdered: false, requestMs: null, workedAt: null, lastCompaction: null })
  expect(initialState(resolveConfig({ ttl: '1h' }))).toMatchObject({ ttlMs: TTL_1H, ttlSource: 'config' })
})

test('on a TTL that is only a guess nothing is asked, renewed or compacted', () => {
  const acting = resolveConfig({ mode: 'prepare-compact' })
  const guessed = warm({ contextTokens: 150000, isTtlUnread: true })
  // Past every moment the five assumed minutes would name: the state stays the object it was.
  for (const seconds of [200, 240, 280, 600, 3000]) {
    const { state: after, actions } = decide(guessed, T0 + seconds * S, tick, acting)
    expect(after).toBe(guessed)
    expect(actions).toEqual([])
  }
  // Whatever the TTL was, an hour after the last request the cache is gone, and the notice names the hour.
  const gone = decide(guessed, T0 + 3600 * S, tick, acting)
  expect(gone.state).toMatchObject({ phase: 'COLD', coldReason: 'expired' })
  expect(gone.actions[0]).toEqual({ kind: 'notify', text: 'Prompt cache expired after 60 min without a request. The next message re-sends the whole context uncached.' })
  // The same idle session with a TTL that was read is asked at its time.
  expect(kinds(decide(warm({ contextTokens: 150000 }), T0 + 215 * S, tick, acting).actions)).toContain('ask')
  // A TTL some source did name is not a guess, read or not.
  expect(kinds(decide(warm({ contextTokens: 150000, isTtlUnread: true, ttlSource: 'settings' }), T0 + 215 * S, tick, acting).actions)).toContain('ask')
})

test('behind a guess a compaction that waits is neither asked about nor renewed for, and goes ahead when the way is clear', () => {
  const acting = resolveConfig({ mode: 'prepare-compact' })
  const waiting = warm({ contextTokens: 150000, isTtlUnread: true, held: { by: 'agent', isTold: true } })
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
  const acting = resolveConfig({ mode: 'prepare-compact' })
  const guessed = warm({ contextTokens: 150000, isTtlUnread: true })
  // Read at 4:10 and it is five minutes after all: too late for the question, so nothing is sent.
  const late = decide(guessed, T0 + 250 * S, { kind: 'ttl', ttlMs: TTL_5M, source: 'transcript' }, acting).state
  expect(late).toMatchObject({ isTtlUnread: false, ttlSource: 'transcript', isDeclined: true })
  expect(kinds(decide(late, T0 + 251 * S, tick, acting).actions)).toEqual(['redraw'])
  // The same when the read finds no TTL and the default is all there is.
  expect(decide(guessed, T0 + 250 * S, { kind: 'ttl-unread', isUnread: false }, acting).state.isDeclined).toBe(true)
  // In time for the question, the course goes on as usual; and an hour leaves all the time there is.
  expect(decide(guessed, T0 + 100 * S, { kind: 'ttl', ttlMs: TTL_5M, source: 'transcript' }, acting).state.isDeclined).toBe(false)
  expect(decide(guessed, T0 + 250 * S, { kind: 'ttl', ttlMs: TTL_1H, source: 'transcript' }, acting).state.isDeclined).toBe(false)
  // A mode that never asks owes no question: it acts as it would have.
  const silent = resolveConfig({ mode: 'custom', ask: 'never', renewMethod: 'fork', compact: false })
  expect(decide(guessed, T0 + 250 * S, { kind: 'ttl', ttlMs: TTL_5M, source: 'transcript' }, silent).state.isDeclined).toBe(false)
})

test('behind a guess the question about what the session asked for has the hour to be answered in', () => {
  const acting = resolveConfig({ mode: 'prepare-compact' })
  const asked = warm({ contextTokens: 150000, isTtlUnread: true, phase: 'ASKING', askReason: 'session', askDeadline: T0 + 330 * S })
  // 5:20 after the last request: with five minutes taken for a fact the cache would be called cold here.
  const { state: after, actions } = decide(asked, T0 + 320 * S, tick, acting)
  expect(after).toBe(asked)
  expect(actions).toEqual([])
})

test('a transcript that is read again ends the guess, whatever it says', () => {
  const guessed = warm({ isTtlUnread: true })
  expect(decide(warm(), T0, { kind: 'ttl-unread', isUnread: true }, config)).toMatchObject({ state: { isTtlUnread: true }, actions: [{ kind: 'redraw' }] })
  expect(decide(guessed, T0, { kind: 'ttl-unread', isUnread: true }, config)).toEqual({ state: guessed, actions: [] })
  // Read, and it names no TTL: the default is all there is, and the plugin works with it.
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
    ['a turn whose last request is too old ends cold', state({ phase: 'BUSY', anchorAt: T0 }), late, { kind: 'turn-complete' }, { phase: 'COLD', coldReason: 'expired' }, ['redraw']],
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
  ]
  for (const [name, from, observation, fields, actions] of table) {
    const result = decide(state(from), T0, observation, config)
    const got = { ttlMs: result.state.ttlMs, ttlSource: result.state.ttlSource }
    expect({ name, state: got, actions: kinds(result.actions) }).toEqual({ name, state: fields, actions })
  }
})

test('a TTL set by hand beats everything, and stops doing so once it is unset', () => {
  const byHand = resolveConfig({ ttl: '1h' })
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
  const idle = run(state(), [
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
  const off = resolveConfig({ enabled: false })
  const result = decide(warm(), T0 + 275 * S, tick, off)
  expect(result.state.phase).toBe('COLD')
  expect(result.actions).toEqual([])
})

test('a state that did not change is the same object', () => {
  const idle = warm()
  expect(decide(idle, T0 + S, tick, config).state === idle).toBe(true)
  expect(decide(idle, T0 + S, { kind: 'turn-complete' }, config).state === idle).toBe(true)

  // Also with a TTL set by hand: otherwise the shell would write the state at every tick.
  const byHand = resolveConfig({ ttl: '1h' })
  const forced = decide(state(), T0, tick, byHand).state
  expect(forced).toMatchObject({ ttlMs: TTL_1H, ttlSource: 'config' })
  expect(decide(forced, T0 + S, tick, byHand).state === forced).toBe(true)
})
