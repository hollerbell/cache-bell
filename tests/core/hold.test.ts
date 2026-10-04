import { expect, test } from 'claude-code/testing'

import { resolveConfig } from '../../core/config'
import { ASK_GRACE_MS, decide, initialState, needsHold } from '../../core/decide'
import { TYPING_MS, holdOf } from '../../core/guards'
import type { Action, Hold, Observation, State } from '../../core/types'
import { band, statusReport } from '../../core/view'

const S = 1000
// A Monday morning: 2026-01-12 09:00 UTC.
const T0 = Date.UTC(2026, 0, 12, 9)
// On a five-minute cache: act at 4:00, too late at 4:35.
const ACT = T0 + 240 * S
const MAX = T0 + 275 * S

const base = resolveConfig({})
const HOLDS: Hold[] = ['typing', 'agent']

const state = (over: Partial<State> = {}): State => ({ ...initialState(base), phase: 'WARM', anchorAt: T0, contextTokens: 150000, ...over })
// The renewals are used up: what comes next on the cache's course is the compaction.
const due = (over: Partial<State> = {}): State => state({ renewals: 2, isAsked: true, ...over })
const tick = (hold: Hold | null = null): Observation => ({ kind: 'tick', gapMs: S, hold })
const kinds = (actions: Action[]): string[] => actions.map(action => action.kind)

test('what stands in the way of a compaction is a person who is typing, or a subagent that still runs', () => {
  const table: [number | null, string[], Hold | null][] = [
    // how long since the prompt box last changed, each subagent as its status or type:status, what holds
    [null, [], null],
    [0, [], 'typing'],
    [TYPING_MS - 1, [], 'typing'],
    // text that only lies in the box holds nothing, however long
    [TYPING_MS, [], null],
    [3600 * S, [], null],
    // a clock that was set back says nothing about the person
    [-5 * S, [], null],
    [null, ['running'], 'agent'],
    [null, ['pending'], 'agent'],
    [null, ['completed', 'failed', 'killed'], null],
    [TYPING_MS, ['completed', 'running'], 'agent'],
    // the person comes first: it is what they can do something about
    [10 * S, ['running'], 'typing'],
    // a teammate runs for as long as the session does
    [null, ['teammate:running'], null],
    [null, ['teammate:running', 'Explore:running'], 'agent'],
  ]
  const agent = (said: string) => {
    const [type, status] = said.includes(':') ? said.split(':') : ['general-purpose', said]
    return { type: type ?? '', status: status ?? '' }
  }
  expect(TYPING_MS).toBe(60 * S)
  for (const [since, statuses, hold] of table) {
    expect({ since, statuses, hold: holdOf(since, statuses.map(agent)) }).toEqual({ since, statuses, hold })
  }
})

for (const hold of HOLDS) {
  test(`a compaction that is due waits for ${hold}, and goes ahead once the way is clear`, () => {
    const waiting = decide(due(), ACT, tick(hold), base)
    expect(waiting.state).toMatchObject({ phase: 'WARM', held: { by: hold, isTold: false }, isDeclined: false })
    expect(kinds(waiting.actions)).toEqual(['redraw'])

    // Still in the way a second later: nothing new to write.
    const still = decide(waiting.state, ACT + S, tick(hold), base)
    expect(still.state).toBe(waiting.state)
    expect(kinds(still.actions)).toEqual(['redraw'])

    // The way is clear: the course goes on where it stopped, with the announcement.
    const clear = decide(waiting.state, ACT + 2 * S, tick(), base)
    expect(clear.state).toMatchObject({ phase: 'PREPARING', held: null })
    expect(kinds(clear.actions)).toEqual(['prepare', 'redraw'])
  })

  test(`a compaction that waited for ${hold} until the cache ran out is not done, and the person is told`, () => {
    const waiting = decide(due(), ACT, tick(hold), base).state
    expect(kinds(decide(waiting, MAX - 1, tick(hold), base).actions)).toEqual(['redraw'])
    const late = decide(waiting, MAX, tick(hold), base)
    expect(late.state).toMatchObject({ phase: 'COLD', coldReason: 'postponed', held: null })
    expect(late.actions).toEqual([
      { kind: 'notify', text: 'The compaction waited for your typing or a running subagent until the prompt cache ran out: nothing was compacted. The next message re-sends the whole context uncached.' },
      { kind: 'redraw' },
    ])
    // The way clears too late: nothing is compacted on a cold cache.
    expect(decide(late.state, MAX + S, tick(), base)).toEqual({ state: late.state, actions: [] })
  })

  test(`a renewal does not wait for ${hold}`, () => {
    const renewing = decide(state(), ACT, tick(hold), resolveConfig({ ask: 'never', mode: 'custom' }))
    expect(renewing.state).toMatchObject({ phase: 'RENEWING', held: null })
    expect(kinds(renewing.actions)).toEqual(['renew', 'redraw'])
  })

  test(`the timer's answer to a question waits for ${hold}, the person's own does not`, () => {
    const asking = due({ phase: 'ASKING', askReason: 'cache', askDeadline: ACT })
    const timed = decide(asking, ACT, { kind: 'answer', choice: 'compact', isTimers: true, hold }, base)
    expect(timed.state).toMatchObject({ phase: 'WARM', held: { by: hold, isTold: false }, askReason: null, isOrdered: false })
    expect(kinds(timed.actions)).toEqual(['close-question', 'redraw'])
    // The timer with nothing in the way goes ahead, and still takes no for an answer later.
    expect(decide(asking, ACT, { kind: 'answer', choice: 'compact', isTimers: true, hold: null }, base).state).toMatchObject({ phase: 'PREPARING', isOrdered: false })

    // The person's word stands to the end: through the announcement and the shell's last look.
    const own = decide(asking, ACT, { kind: 'answer', choice: 'compact', hold }, base)
    expect(own.state).toMatchObject({ phase: 'PREPARING', held: null, isOrdered: true })
    const told = decide(own.state, ACT + 5 * S, { kind: 'turn-complete', hold }, base)
    expect(told.state).toMatchObject({ phase: 'COMPACTING', held: null, isOrdered: true })
    expect(kinds(told.actions)).toEqual(['compact', 'redraw'])
    expect(decide(told.state, ACT + 6 * S, { kind: 'held', hold }, base)).toEqual({ state: told.state, actions: [] })
    // It is theirs for that compaction only: work in the session ends it.
    expect(decide(told.state, ACT + 6 * S, { kind: 'turn-start', by: 'other' }, base).state).toMatchObject({ phase: 'BUSY', isOrdered: false })

    // The shell did not answer in time: the core does, and it waits the same way.
    const late = decide(asking, ACT + ASK_GRACE_MS, tick(hold), base)
    expect(late.state).toMatchObject({ phase: 'WARM', held: { by: hold, isTold: false } })
    // Any other answer has nothing to wait for.
    expect(decide(asking, ACT, { kind: 'answer', choice: 'cancel', isTimers: true, hold }, base).state).toMatchObject({ isDeclined: true, held: null })
  })

  test(`what the session asked for waits for ${hold} and then needs no announcement`, () => {
    const auto = resolveConfig({ sessionCompact: 'auto' })
    const busy = state({ phase: 'BUSY', isRequested: true })
    const waiting = decide(busy, T0 + S, { kind: 'turn-complete', hold }, auto)
    expect(waiting.state).toMatchObject({ phase: 'WARM', held: { by: hold, isTold: true } })
    expect(kinds(waiting.actions)).toEqual(['redraw'])
    const clear = decide(waiting.state, T0 + 2 * S, tick(), auto)
    expect(clear.state).toMatchObject({ phase: 'COMPACTING', held: null })
    expect(kinds(clear.actions)).toEqual(['compact', 'redraw'])

    // Asked, and the time to cancel ran out with something in the way.
    const asking = state({ phase: 'ASKING', askReason: 'session', askDeadline: T0 + 180 * S })
    const timed = decide(asking, T0 + 180 * S, { kind: 'answer', choice: 'compact', isTimers: true, hold }, base)
    expect(timed.state).toMatchObject({ phase: 'WARM', held: { by: hold, isTold: true } })
    expect(kinds(decide(timed.state, T0 + 181 * S, tick(), base).actions)).toEqual(['compact', 'redraw'])
  })

  test(`${hold} that turns up during the announcement or right before the compaction holds it back`, () => {
    // The announcement's turn ends and the person has begun to type.
    const announced = decide(due({ phase: 'PREPARING' }), ACT + 5 * S, { kind: 'turn-complete', hold }, base)
    expect(announced.state).toMatchObject({ phase: 'WARM', held: { by: hold, isTold: true } })
    expect(kinds(announced.actions)).toEqual(['redraw'])
    // The session was told once: the compaction follows without a second announcement.
    expect(kinds(decide(announced.state, ACT + 6 * S, tick(), base).actions)).toEqual(['compact', 'redraw'])

    // Found by the shell in its last look.
    const table: [State['phase'], Partial<State>, string[]][] = [
      ['COMPACTING', { phase: 'WARM', held: { by: hold, isTold: true } }, ['redraw']],
      ['PREPARING', { phase: 'PREPARING', held: null }, []],
      ['WARM', { phase: 'WARM', held: null }, []],
      ['BUSY', { phase: 'BUSY', held: null }, []],
    ]
    for (const [phase, expected, actions] of table) {
      const next = decide(due({ phase }), ACT + S, { kind: 'held', hold }, base)
      expect({ phase, state: next.state, actions: kinds(next.actions) }).toMatchObject({ phase, state: expected, actions })
    }
  })

  test(`the band and the status report say that the compaction waits for ${hold}`, () => {
    const waiting = decide(due(), ACT, tick(hold), base).state
    const what = { typing: 'you to finish typing', agent: 'a running subagent' }[hold]
    expect(band(waiting, ACT, base)).toEqual({ text: `h⣿ Cache Bell: prompt cache expires in 0:35 · compaction waits for ${what}`, tone: 'warn' })
    expect(statusReport(waiting, ACT, base, { contextTokens: 150000 })).toContain(`\nCompaction waits for ${what}\n`)
    const gone = decide(waiting, MAX, tick(hold), base).state
    expect(band(gone, MAX, base)?.text).toBe('h⣿ Cache Bell: prompt cache expired, the compaction was postponed · the next message re-sends 150k tokens uncached')
    expect(statusReport(gone, MAX, base, { contextTokens: 150000 })).toContain('State: cold, compaction postponed')
    // On an hour-long cache the line shows while the compaction waits, however much time is left.
    const long = state({ ttlMs: 3600 * S, held: { by: hold, isTold: true } })
    expect(band(state({ ttlMs: 3600 * S }), T0 + S, base)).toBeNull()
    expect(band(long, T0 + S, base)?.text).toBe(`h⣿ Cache Bell: prompt cache expires in 54 min · compaction waits for ${what}`)
  })
}

test('what waits changes with what is in the way, and the person at work ends the wait', () => {
  const waiting = decide(due(), ACT, tick('agent'), base).state
  const other = decide(waiting, ACT + S, tick('typing'), base)
  expect(other.state).toMatchObject({ phase: 'WARM', held: { by: 'typing', isTold: false } })
  expect(decide(waiting, ACT + S, { kind: 'turn-start', by: 'person' }, base).state).toMatchObject({ phase: 'BUSY', held: null })
})

test('a compaction that waits for a subagent outlasts the turn that brings its result', () => {
  const waiting = decide(state({ phase: 'BUSY', isRequested: true }), T0 + S, { kind: 'turn-complete', hold: 'agent' }, resolveConfig({ sessionCompact: 'auto' })).state
  const steps: [number, Observation][] = [
    [T0 + 100 * S, { kind: 'turn-start', by: 'other' }],
    [T0 + 101 * S, { kind: 'request', sentAt: T0 + 101 * S }],
    [T0 + 110 * S, { kind: 'turn-complete', hold: null }],
  ]
  const after = steps.reduce((current, [now, observation]) => decide(current, now, observation, base).state, waiting)
  expect(after).toMatchObject({ phase: 'WARM', anchorAt: T0 + 101 * S, held: { by: 'agent', isTold: true } })
  expect(kinds(decide(after, T0 + 111 * S, tick(), base).actions)).toEqual(['compact', 'redraw'])
})

test('a compaction that waits is still there after the cache was renewed', () => {
  const waiting = state({ held: { by: 'agent', isTold: true } })
  const never = resolveConfig({ mode: 'custom', ask: 'never' })
  const renewing = decide(waiting, ACT, tick('agent'), never)
  expect(renewing.state).toMatchObject({ phase: 'RENEWING', held: { by: 'agent', isTold: true } })
  const renewed = decide(renewing.state, ACT + 2 * S, { kind: 'renewed', isHit: true, sentAt: ACT }, never)
  expect(renewed.state).toMatchObject({ phase: 'WARM', renewals: 1, held: { by: 'agent', isTold: true } })
  expect(kinds(decide(renewed.state, ACT + 3 * S, tick(), never).actions)).toEqual(['compact', 'redraw'])

  // The question about the cache comes and goes over it the same way.
  const asked = decide(waiting, T0 + 210 * S, tick('agent'), base)
  expect(asked.state).toMatchObject({ phase: 'ASKING', held: { by: 'agent', isTold: true } })
  const answered = decide(asked.state, ACT, { kind: 'answer', choice: 'renew', isTimers: true, hold: 'agent' }, base)
  expect(answered.state).toMatchObject({ phase: 'RENEWING', held: { by: 'agent', isTold: true } })
  // The person who says no to the cache says no to what waits, too.
  expect(decide(asked.state, ACT, { kind: 'answer', choice: 'cancel' }, base).state).toMatchObject({ phase: 'WARM', isDeclined: true, held: null })
})

test('switched off while a compaction waited, the plugin forgets it', () => {
  const waiting = decide(due(), ACT, tick('agent'), base).state
  const off = decide(waiting, ACT + S, tick(), resolveConfig({ enabled: false }))
  expect(off).toMatchObject({ state: { phase: 'WARM', held: null }, actions: [] })
  expect(statusReport(off.state, ACT + S, resolveConfig({ enabled: false }), { contextTokens: 150000 })).not.toContain('waits')
})

test('a cache that ran out for another reason is not said to have waited', () => {
  const waiting = decide(due(), ACT, tick('agent'), base).state
  // The clock was set back, or the machine slept.
  expect(decide(waiting, ACT + S, { kind: 'tick', gapMs: -3600 * S, hold: 'agent' }, base).state).toMatchObject({ phase: 'COLD', coldReason: 'expired' })
  expect(decide(waiting, MAX + 3600 * S, { kind: 'tick', gapMs: 3600 * S, hold: 'agent' }, base).state).toMatchObject({ phase: 'COLD', coldReason: 'sleep' })
  // A question ran out with the machine asleep past the cache.
  const asking = state({ phase: 'ASKING', askReason: 'cache', askDeadline: ACT, held: { by: 'agent', isTold: true } })
  expect(decide(asking, MAX, tick('agent'), base).state).toMatchObject({ phase: 'COLD', coldReason: 'expired' })
})

test('what stands in the way is looked for only when a compaction could start', () => {
  const asking = state({ phase: 'ASKING', askReason: 'cache', askDeadline: ACT })
  const table: [string, State, number, boolean][] = [
    ['a warm cache with time left', state(), ACT - 1, false],
    ['a warm cache at the time to act', state(), ACT, true],
    ['a compaction that waits', state({ held: { by: 'agent', isTold: false } }), T0 + S, true],
    ['a question with time left', asking, ACT - 1, false],
    ['a question whose time is up', asking, ACT, true],
    ['a turn that runs', state({ phase: 'BUSY' }), ACT, false],
    ['a cold cache', state({ phase: 'COLD' }), ACT, false],
    ['no request seen yet', state({ anchorAt: null }), ACT, false],
  ]
  for (const [name, from, now, needs] of table) expect({ name, needs: needsHold(from, now, base) }).toEqual({ name, needs })
})

test('a state kept by a version that knew no waiting gets the fields and keeps what the person decided', () => {
  const { held: _, isOrdered: __, ...old } = state({ isDeclined: true, renewals: 1, isAsked: true })
  expect(decide(old as State, T0 + S, tick(), base).state).toMatchObject({ phase: 'WARM', held: null, isOrdered: false, isDeclined: true, renewals: 1, isAsked: true })
})
