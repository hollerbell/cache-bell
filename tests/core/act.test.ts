import { expect, test } from 'claude-code/testing'

import { resolveConfig } from '../../core/config'
import { ASK_GRACE_MS, CALLED_OFF, LATE_MARGIN_MS, RENEW_FAILED, RETRY_AFTER_MS, TOO_SOON, WORK_GRACE_MS, canRenew, decide, defaultChoice, initialState, planOf } from '../../core/decide'
import { countdownOf, fillInstructions, isCacheHit } from '../../core/guards'
import { TTL_1H } from '../../core/timing'
import type { Action, Config, Observation, State } from '../../core/types'

const S = 1000
// A Monday morning: 2026-01-12 09:00 UTC.
const T0 = Date.UTC(2026, 0, 12, 9)
// On a five-minute cache: ask at 3:30, act at 4:00, too late at 4:35.
const ASK = T0 + 210 * S
const ACT = T0 + 240 * S
const MAX = T0 + 275 * S

const tick: Observation = { kind: 'tick', gapMs: S }
const base = resolveConfig({})

const state = (over: Partial<State> = {}): State => ({ ...initialState(base), ...over })
const warm = (over: Partial<State> = {}): State => state({ phase: 'WARM', anchorAt: T0, contextTokens: 100000, ...over })
const kinds = (actions: Action[]): string[] => actions.map(action => action.kind)

const run = (from: State, steps: [number, Observation][], config: Config = base): State =>
  steps.reduce((current, [now, observation]) => decide(current, now, observation, config).state, from)

test('what is done without an answer follows the mode and the renewals already used', () => {
  const table: [Record<string, unknown>, number, boolean, string][] = [
    // options, renewals so far, may renew, default choice
    [{}, 0, true, 'renew'],
    [{}, 1, true, 'renew'],
    [{}, 2, false, 'compact'],
    [{ mode: 'notify' }, 0, false, 'cancel'],
    // keep renews up to the cap and then lets the cache expire: it never compacts
    [{ mode: 'keep' }, 2, true, 'renew'],
    [{ mode: 'keep' }, 3, false, 'cancel'],
    // the cap holds whatever a custom setting asks for
    [{ mode: 'custom', maxRenewals: 1000 }, 2, true, 'renew'],
    [{ mode: 'custom', maxRenewals: 1000 }, 3, false, 'compact'],
    // what used to mean no limit now means the cap
    [{ mode: 'custom', maxRenewals: -1 }, 2, true, 'renew'],
    [{ mode: 'custom', maxRenewals: -1 }, 3, false, 'compact'],
    [{ mode: 'custom', maxRenewals: 3, compact: false }, 3, false, 'cancel'],
    [{ mode: 'compact-only' }, 0, false, 'compact'],
    [{ mode: 'custom', maxRenewals: 0, compact: false }, 0, false, 'cancel'],
    [{ mode: 'custom', maxRenewals: 1 }, 0, true, 'renew'],
    [{ mode: 'custom', maxRenewals: 1 }, 1, false, 'compact'],
    [{ mode: 'custom', maxRenewals: 5, renewMethod: 'none' }, 0, false, 'compact'],
  ]
  for (const [options, renewals, may, choice] of table) {
    const config = resolveConfig(options)
    const at = warm({ renewals })
    expect({ options, renewals, may: canRenew(at, config), choice: defaultChoice(at, config) }).toEqual({ options, renewals, may, choice })
  }
})

test('a warm cache is asked about at the time to ask, once', () => {
  expect(decide(warm(), ASK - 1, tick, base)).toMatchObject({ state: { phase: 'WARM', isAsked: false } })
  const asked = decide(warm(), ASK, tick, base)
  expect(asked.state).toMatchObject({ phase: 'ASKING', isAsked: true, askReason: 'cache', askDeadline: ACT })
  expect(asked.actions).toEqual([{ kind: 'ask', reason: 'cache', deadline: ACT, selected: 'renew' }, { kind: 'redraw' }])

  // While asking nothing more is asked, and nothing happens until the grace after the deadline is over.
  expect(kinds(decide(asked.state, ACT - 1, tick, base).actions)).toEqual([])
  expect(kinds(decide(asked.state, ACT + ASK_GRACE_MS - 1, tick, base).actions)).toEqual([])
})

test('each answer does what it says', () => {
  const asking = warm({ phase: 'ASKING', isAsked: true, askReason: 'cache', askDeadline: ACT })
  const table: [string, Record<string, unknown>, string, Partial<State>, string[]][] = [
    ['renew', {}, 'renew', { phase: 'RENEWING', askReason: null, askDeadline: null }, ['close-question', 'renew', 'redraw']],
    ['compact after an announcement', {}, 'compact', { phase: 'PREPARING' }, ['close-question', 'prepare', 'redraw']],
    ['compact without one', { mode: 'compact-only' }, 'compact', { phase: 'COMPACTING' }, ['close-question', 'compact', 'redraw']],
    ['compact with an empty announcement', { preparePrompt: '' }, 'compact', { phase: 'COMPACTING' }, ['close-question', 'compact', 'redraw']],
    ['let it expire', {}, 'cancel', { phase: 'WARM', isDeclined: true }, ['close-question', 'redraw']],
    ['renew is done even when the mode would not renew by itself', { mode: 'notify' }, 'renew', { phase: 'RENEWING' }, ['close-question', 'renew', 'redraw']],
  ]
  for (const [name, options, choice, fields, actions] of table) {
    const result = decide(asking, ASK + S, { kind: 'answer', choice } as Observation, resolveConfig(options))
    const got = Object.fromEntries(Object.keys(fields).map(key => [key, result.state[key as keyof State]]))
    expect({ name, state: got, actions: kinds(result.actions) }).toEqual({ name, state: fields, actions })
  }
  // An answer nobody asked for changes nothing.
  expect(decide(warm(), ASK - S, { kind: 'answer', choice: 'compact' }, base)).toEqual({ state: warm(), actions: [] })
})

test('a question the shell never answered gets the default answer', () => {
  const asking = warm({ phase: 'ASKING', isAsked: true })
  expect(decide(asking, ACT + ASK_GRACE_MS, tick, base)).toMatchObject({ state: { phase: 'RENEWING' } })
  expect(decide(warm({ phase: 'ASKING', isAsked: true, renewals: 2 }), ACT + ASK_GRACE_MS, tick, base)).toMatchObject({ state: { phase: 'PREPARING' } })
})

test('a question still open when the cache runs out is closed and the cache is cold', () => {
  const result = decide(warm({ phase: 'ASKING', isAsked: true }), MAX, tick, base)
  expect(result.state).toMatchObject({ phase: 'COLD', coldReason: 'expired' })
  expect(kinds(result.actions)).toEqual(['close-question', 'notify', 'redraw'])
})

test('a renewal that read the cache starts a new period; one that came too late leaves the cache cold', () => {
  const renewing = warm({ phase: 'RENEWING', isAsked: true })
  const hit = decide(renewing, ACT + 2 * S, { kind: 'renewed', isHit: true, sentAt: ACT }, base)
  expect(hit.state).toMatchObject({ phase: 'WARM', anchorAt: ACT, renewals: 1, isAsked: true })
  expect(kinds(hit.actions)).toEqual(['redraw'])

  const miss = decide(renewing, ACT + 2 * S, { kind: 'renewed', isHit: false, sentAt: ACT }, base)
  expect(miss.state).toMatchObject({ phase: 'COLD', coldReason: 'renew-missed', renewals: 0 })
  expect(miss.actions[0]).toEqual({ kind: 'notify', text: 'Renewing the prompt cache came too late: it had already expired. The next message re-sends the whole context uncached.' })

  // A result nobody waits for is dropped.
  expect(decide(warm(), ACT, { kind: 'renewed', isHit: true, sentAt: ACT }, base).state).toEqual(warm())
})

test('with ask set to first, the second period is acted on without a question', () => {
  const second = warm({ anchorAt: ACT, renewals: 1, isAsked: true })
  expect(decide(second, ACT + 210 * S, tick, base)).toMatchObject({ state: { phase: 'WARM' }, actions: [{ kind: 'redraw' }] })
  const acted = decide(second, ACT + 240 * S, tick, base)
  expect(acted.state.phase).toBe('RENEWING')
  expect(kinds(acted.actions)).toEqual(['renew', 'redraw'])

  // With ask set to every, it is asked again.
  const every = resolveConfig({ mode: 'custom', ask: 'every' })
  expect(decide(second, ACT + 210 * S, tick, every).state.phase).toBe('ASKING')
})

test('the whole prepare-compact course: ask, two renewals, announcement, compaction, sleep', () => {
  const steps: [number, Observation, string, string[]][] = [
    [ASK, tick, 'ASKING', ['ask', 'redraw']],
    [ACT, { kind: 'answer', choice: 'renew' }, 'RENEWING', ['close-question', 'renew', 'redraw']],
    [ACT + 2 * S, { kind: 'renewed', isHit: true, sentAt: ACT }, 'WARM', ['redraw']],
    [ACT + 240 * S, tick, 'RENEWING', ['renew', 'redraw']],
    [ACT + 242 * S, { kind: 'renewed', isHit: true, sentAt: ACT + 240 * S }, 'WARM', ['redraw']],
    // The renewals are used up: at the next time to act the session is told that a compaction is coming.
    [ACT + 480 * S, tick, 'PREPARING', ['prepare', 'redraw']],
    [ACT + 481 * S, { kind: 'turn-start', by: 'self' }, 'PREPARING', []],
    [ACT + 481 * S, { kind: 'request', sentAt: ACT + 481 * S }, 'PREPARING', []],
    [ACT + 486 * S, { kind: 'turn-complete', contextTokens: 101000 }, 'COMPACTING', ['compact', 'redraw']],
    [ACT + 500 * S, { kind: 'compacted' }, 'DORMANT', ['redraw']],
    [ACT + 5000 * S, tick, 'DORMANT', []],
  ]
  let current = warm()
  for (const [now, observation, phase, actions] of steps) {
    const result = decide(current, now, observation, base)
    expect({ at: now - T0, kind: observation.kind, phase: result.state.phase, actions: kinds(result.actions) }).toEqual({ at: now - T0, kind: observation.kind, phase, actions })
    current = result.state
  }
  expect(current).toMatchObject({ renewals: 0, renewalsSent: 0, isAsked: false, anchorAt: null, contextTokens: null })
})

test('the request of the announcement moves the anchor, so the compaction runs on a warm cache', () => {
  const noted = run(warm({ phase: 'PREPARING' }), [[ACT, { kind: 'turn-start', by: 'self' }], [ACT + S, { kind: 'request', sentAt: ACT + S }]])
  expect(noted).toMatchObject({ phase: 'PREPARING', anchorAt: ACT + S })
})

test('work by the person starts a new idle period; a background task does not', () => {
  const used = warm({ renewals: 2, isAsked: true, isDeclined: true })
  expect(decide(used, ACT, { kind: 'turn-start', by: 'person' }, base).state).toMatchObject({ phase: 'BUSY', renewals: 0, renewalsSent: 0, isAsked: false, isDeclined: false })
  expect(decide(used, ACT, { kind: 'turn-start', by: 'other' }, base).state).toMatchObject({ phase: 'BUSY', renewals: 2, isAsked: true, isDeclined: true })
  // A turn of the plugin's own outside the announcement is treated as any other.
  expect(decide(used, ACT, { kind: 'turn-start', by: 'self' }, base).state).toMatchObject({ phase: 'BUSY', renewals: 2 })
})

test('work that starts while the plugin asks or acts takes over', () => {
  const table: [State['phase'], string[]][] = [
    ['ASKING', ['close-question', 'redraw']],
    ['RENEWING', ['redraw']],
    ['PREPARING', ['redraw']],
    ['COMPACTING', ['redraw']],
  ]
  for (const [phase, actions] of table) {
    const result = decide(warm({ phase, isAsked: true }), ASK + S, { kind: 'turn-start', by: 'person' }, base)
    expect({ phase, to: result.state.phase, resumeTo: result.state.resumeTo, actions: kinds(result.actions) }).toEqual({ phase, to: 'BUSY', resumeTo: 'WARM', actions })
  }
})

test('nothing is done after the person declined, for a small context, or when switched off', () => {
  expect(decide(warm({ isDeclined: true }), ACT, tick, base)).toMatchObject({ state: { phase: 'WARM' }, actions: [{ kind: 'redraw' }] })
  expect(decide(warm({ contextTokens: 99999 }), ACT, tick, base)).toMatchObject({ state: { phase: 'WARM' }, actions: [{ kind: 'redraw' }] })
  // At the threshold itself, and with the size unknown, the plugin acts.
  expect(decide(warm({ contextTokens: 100000 }), ASK, tick, base).state.phase).toBe('ASKING')
  expect(decide(warm({ contextTokens: null }), ASK, tick, base).state.phase).toBe('ASKING')
  const off = decide(warm(), ACT, tick, resolveConfig({ enabled: false }))
  expect(off).toMatchObject({ state: { phase: 'WARM', isAsked: false }, actions: [] })
})

test('modes that do not ask act at the time to act', () => {
  const table: [Record<string, unknown>, number, string, string[]][] = [
    [{ mode: 'keep' }, ASK, 'WARM', ['redraw']],
    [{ mode: 'keep' }, ACT, 'RENEWING', ['renew', 'redraw']],
    [{ mode: 'compact-only' }, ASK, 'WARM', ['redraw']],
    [{ mode: 'compact-only' }, ACT, 'COMPACTING', ['compact', 'redraw']],
  ]
  for (const [options, now, phase, actions] of table) {
    const result = decide(warm(), now, tick, resolveConfig(options))
    expect({ options, at: now - T0, phase: result.state.phase, actions: kinds(result.actions) }).toEqual({ options, at: now - T0, phase, actions })
  }
})

test('the notify mode asks, and without an answer leaves the cache to expire', () => {
  const notify = resolveConfig({ mode: 'notify' })
  const asked = decide(warm(), ASK, tick, notify)
  expect(asked.actions[0]).toEqual({ kind: 'ask', reason: 'cache', deadline: ACT, selected: 'cancel' })
  const left = decide(asked.state, ACT, { kind: 'answer', choice: 'cancel' }, notify)
  expect(left.state).toMatchObject({ phase: 'WARM', isDeclined: true })
  expect(decide(left.state, MAX, tick, notify).state).toMatchObject({ phase: 'COLD', coldReason: 'expired' })
})

test('a compaction that failed and a step that was refused end the course', () => {
  const failed = decide(warm({ phase: 'COMPACTING' }), ACT, { kind: 'compact-failed' }, base)
  expect(failed.state).toMatchObject({ phase: 'COLD', coldReason: 'compact-failed' })
  expect(decide(warm(), ACT, { kind: 'compact-failed' }, base).state.phase).toBe('WARM')

  for (const phase of ['RENEWING', 'PREPARING', 'COMPACTING'] as const) {
    const refused = decide(warm({ phase }), ACT, { kind: 'refused', reason: 'no' }, base)
    expect({ phase, state: refused.state.phase, isDeclined: refused.state.isDeclined, actions: refused.actions }).toEqual({
      phase,
      state: 'WARM',
      isDeclined: true,
      actions: [{ kind: 'notify', text: 'no' }, { kind: 'redraw' }],
    })
  }
  expect(decide(warm(), ACT, { kind: 'refused', reason: 'no' }, base)).toEqual({ state: warm(), actions: [] })
})

test('a state written by an older version gets the fields it lacks', () => {
  const old = { phase: 'WARM', anchorAt: T0, ttlMs: TTL_1H, ttlSource: 'transcript', coldReason: null, resumeTo: null } as unknown as State
  expect(decide(old, T0 + S, tick, base).state).toMatchObject({ renewals: 0, renewalsSent: 0, isAsked: false, isDeclined: false, contextTokens: null, ttlMs: TTL_1H, askReason: null, ext: {} })
  // One of the version before this one, caught while asking: the question is gone, the fields are there.
  const asking = { ...old, phase: 'ASKING', renewals: 1, isAsked: true, isDeclined: false, contextTokens: 90000 } as unknown as State
  expect(decide(asking, T0 + S, { kind: 'answer', choice: 'renew' }, base).state).toMatchObject({ phase: 'WARM', contextTokens: 90000, ext: {} })
})

test('a renewal counts as a hit only when it read the cache and wrote next to nothing', () => {
  const table: [string, object | null | undefined, boolean][] = [
    ['read everything, wrote nothing', { cache_read_input_tokens: 45165, cache_creation_input_tokens: 0 }, true],
    ['wrote a little', { cache_read_input_tokens: 45165, cache_creation_input_tokens: 4516 }, true],
    ['wrote a tenth of what it read', { cache_read_input_tokens: 45160, cache_creation_input_tokens: 4516 }, false],
    // A small context: the tail of the conversation may be more than a tenth of it, up to 2000 tokens.
    ['a small context, wrote its tail', { cache_read_input_tokens: 5000, cache_creation_input_tokens: 1999 }, true],
    ['a small context, wrote too much', { cache_read_input_tokens: 5000, cache_creation_input_tokens: 2000 }, false],
    ['read nothing, wrote everything', { cache_read_input_tokens: 0, cache_creation_input_tokens: 45165 }, false],
    ['read nothing at all', { cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, false],
    ['read one token', { cache_read_input_tokens: 1, cache_creation_input_tokens: 0 }, true],
    ['read, and says nothing of writing', { cache_read_input_tokens: 45165 }, true],
    ['no usage', undefined, false],
    ['null usage', null, false],
  ]
  for (const [name, usage, hit] of table) expect({ name, hit: isCacheHit(usage as never) }).toEqual({ name, hit })
})

test('the compaction instructions get the time and the idle minutes', () => {
  const now = Date.UTC(2026, 9, 3, 14, 5, 0)
  expect(fillInstructions('At {time} after {idle} minutes. {idle}!', now, now - 50 * 60 * S)).toBe('At 2026-10-03 14:05 UTC after 50 minutes. 50!')
  expect(fillInstructions('after {idle} minutes', now, null)).toBe('after ? minutes')
  // Half a minute rounds up to one.
  expect(fillInstructions('after {idle} minutes', now, now - 30 * S)).toBe('after 1 minutes')
  expect(fillInstructions('after {idle} minutes', now, now + 60 * S)).toBe('after 0 minutes')
  expect(fillInstructions('', now, now)).toBe('')
})

test('the cache question can be set to come earlier', () => {
  const early = resolveConfig({ askLeadMinutes: 2 })
  expect(decide(warm(), T0 + 120 * S - 1, tick, early).state.phase).toBe('WARM')
  expect(decide(warm(), T0 + 120 * S, tick, early).actions[0]).toEqual({ kind: 'ask', reason: 'cache', deadline: ACT, selected: 'renew' })
  // On an hour-long cache the question comes a quarter of an hour before the time to act.
  const hour = warm({ ttlMs: TTL_1H, ttlSource: 'transcript' })
  expect(decide(hour, T0 + 35 * 60 * S - 1, tick, base).state.phase).toBe('WARM')
  expect(decide(hour, T0 + 35 * 60 * S, tick, base).actions[0]).toEqual({ kind: 'ask', reason: 'cache', deadline: T0 + 50 * 60 * S, selected: 'renew' })
})

// --- the second reason to compact: the session asked for it ---

const working = (over: Partial<State> = {}): State => state({ phase: 'BUSY', anchorAt: T0, ...over })
const done = (tokens: number | undefined): Observation => ({ kind: 'turn-complete', contextTokens: tokens })

const asks: Observation = { kind: 'requested' }

test('a request is noted only while a turn runs, and taken up when that turn ends', () => {
  expect(decide(working(), T0 + S, asks, base)).toMatchObject({ state: { phase: 'BUSY', isRequested: true }, actions: [] })
  // Outside a turn, and during the plugin's own announcement, there is nothing to note.
  for (const phase of ['WARM', 'COLD', 'DORMANT', 'UNKNOWN', 'PREPARING', 'COMPACTING'] as const) {
    expect({ phase, noted: decide(warm({ phase }), T0 + S, asks, base).state.isRequested }).toEqual({ phase, noted: false })
  }

  const asked = decide(working({ isRequested: true }), T0 + 5 * S, done(60000), base)
  expect(asked.state).toMatchObject({ phase: 'ASKING', askReason: 'session', askDeadline: T0 + 35 * S, isRequested: false })
  expect(asked.actions).toEqual([{ kind: 'ask', reason: 'session', deadline: T0 + 35 * S, selected: 'compact' }, { kind: 'redraw' }])
})

test('what a request leads to follows the setting', () => {
  const table: [Record<string, unknown>, string, string[]][] = [
    [{ sessionCompact: 'confirm' }, 'ASKING', ['ask', 'redraw']],
    [{ sessionCompact: 'auto' }, 'COMPACTING', ['compact', 'redraw']],
    [{ sessionCompact: 'off' }, 'WARM', ['redraw']],
    [{ sessionCompact: 'auto', enabled: false }, 'WARM', []],
  ]
  for (const [options, phase, actions] of table) {
    const result = decide(working({ isRequested: true }), T0 + 5 * S, done(60000), resolveConfig(options))
    expect({ options, phase: result.state.phase, actions: kinds(result.actions), isRequested: result.state.isRequested }).toEqual({ options, phase, actions, isRequested: false })
  }
})

test('the answers to a session that asked: compact without an announcement, or drop it', () => {
  const asking = warm({ phase: 'ASKING', askReason: 'session', askDeadline: T0 + 35 * S })
  const compacted = decide(asking, T0 + 20 * S, { kind: 'answer', choice: 'compact' }, base)
  // The session asked itself, so there is nothing to announce: straight to the compaction.
  expect(compacted.state).toMatchObject({ phase: 'COMPACTING', askReason: null })
  expect(kinds(compacted.actions)).toEqual(['close-question', 'compact', 'redraw'])

  const dropped = decide(asking, T0 + 20 * S, { kind: 'answer', choice: 'skip' }, base)
  expect(dropped.state).toMatchObject({ phase: 'WARM', askReason: null, isDeclined: false })
  expect(kinds(dropped.actions)).toEqual(['close-question', 'redraw'])

  // No answer: compacted once the countdown and the grace are over.
  expect(decide(asking, T0 + 35 * S + ASK_GRACE_MS, tick, base).state.phase).toBe('COMPACTING')
  // The person works on instead: the request is dropped with the question.
  expect(decide(asking, T0 + 20 * S, { kind: 'turn-start', by: 'person' }, base).state).toMatchObject({ phase: 'BUSY', askReason: null, isRequested: false })
})

test('a request does not outlive its turn', () => {
  // A turn that asked and then ended before any request of its own went out (an interrupt) drops it.
  const interrupted = decide(state({ phase: 'BUSY', resumeTo: 'DORMANT', isRequested: true }), T0, done(undefined), base)
  expect(interrupted.state).toMatchObject({ phase: 'DORMANT', isRequested: false })
  expect(decide(working({ isRequested: true }), T0 + S, { kind: 'compacted' }, base).state.isRequested).toBe(false)
  expect(decide(working({ isRequested: true }), T0 + S, { kind: 'cleared' }, base).state.isRequested).toBe(false)
})

// --- what must not be sent ---

test('an answer that comes after the cache ran out is too late: nothing is sent', () => {
  // The machine slept with the question open; on waking the question's own timer answers before the tick.
  for (const choice of ['renew', 'compact', 'cancel']) {
    const asking = warm({ phase: 'ASKING', isAsked: true, askReason: 'cache', askDeadline: ACT })
    const late = decide(asking, MAX, { kind: 'answer', choice }, base)
    expect({ choice, phase: late.state.phase, coldReason: late.state.coldReason, actions: kinds(late.actions) }).toEqual({
      choice,
      phase: 'COLD',
      coldReason: 'expired',
      actions: ['close-question', 'notify', 'redraw'],
    })
  }
  // One moment earlier the answer still counts.
  const asking = warm({ phase: 'ASKING', isAsked: true, askReason: 'cache', askDeadline: ACT })
  expect(decide(asking, MAX - 1, { kind: 'answer', choice: 'renew' }, base).state.phase).toBe('RENEWING')
  // The session's own question is no different.
  const session = warm({ phase: 'ASKING', askReason: 'session', askDeadline: MAX + 60 * S })
  expect(kinds(decide(session, MAX, { kind: 'answer', choice: 'compact' }, base).actions)).toEqual(['close-question', 'notify', 'redraw'])
})

test('an announcement that was interrupted or failed is not followed by a compaction', () => {
  const preparing = warm({ phase: 'PREPARING', isAsked: true, renewals: 2 })
  const aborted = decide(preparing, ACT + 5 * S, { kind: 'turn-complete', contextTokens: 100000, isAborted: true }, base)
  expect(aborted.state).toMatchObject({ phase: 'WARM', isDeclined: true })
  expect(aborted.actions).toEqual([{ kind: 'notify', text: CALLED_OFF }, { kind: 'redraw' }])
  // Declined: the cache is left to run out, nothing more is tried.
  expect(kinds(decide(aborted.state, ACT + 20 * S, tick, base).actions)).toEqual(['redraw'])

  const finished = decide(preparing, ACT + 5 * S, { kind: 'turn-complete', contextTokens: 100000, isAborted: false }, base)
  expect(finished.state.phase).toBe('COMPACTING')
  expect(kinds(finished.actions)).toEqual(['compact', 'redraw'])

  // The shell could not send the announcement at all.
  const unsent = decide(preparing, ACT + S, { kind: 'refused', reason: 'not announced' }, base)
  expect(unsent.state).toMatchObject({ phase: 'WARM', isDeclined: true })
  expect(unsent.actions).toEqual([{ kind: 'notify', text: 'not announced' }, { kind: 'redraw' }])
})

test('a step of the plugin that never reports back is given up, without another request', () => {
  const table: [State['phase'], string][] = [
    ['RENEWING', 'renew-missed'],
    ['PREPARING', 'expired'],
    ['COMPACTING', 'compact-failed'],
  ]
  for (const [phase, coldReason] of table) {
    const stuck = warm({ phase })
    expect({ phase, waits: decide(stuck, MAX + WORK_GRACE_MS - 1, tick, base) }).toEqual({ phase, waits: { state: stuck, actions: [] } })
    const given = decide(stuck, MAX + WORK_GRACE_MS, tick, base)
    expect({ phase, to: given.state.phase, coldReason: given.state.coldReason, actions: kinds(given.actions) }).toEqual({ phase, to: 'COLD', coldReason, actions: ['notify', 'redraw'] })
  }
  expect(WORK_GRACE_MS).toBe(600000)
})

// A turn of the main conversation: its request goes out at `sentAt`, the turn ends at `endsAt`.
const turn = (from: State, sentAt: number, endsAt: number, end: Partial<Extract<Observation, { kind: 'turn-complete' }>> = {}, config: Config = base, asks = false) => {
  const requests: [number, Observation][] = asks ? [[sentAt, { kind: 'requested' }]] : []
  const busy = run(from, [[sentAt, { kind: 'turn-start', by: 'person' }], [sentAt, { kind: 'request', sentAt }], ...requests], config)
  return decide(busy, endsAt, { kind: 'turn-complete', contextTokens: 100000, ...end }, config)
}

test('the countdown of a question the session asked for ends while the cache is still warm', () => {
  const table: [string, Record<string, unknown>, number, number][] = [
    // name, options, when the turn ends, when the countdown ends
    ['a short turn: the whole countdown', {}, T0 + 10 * S, T0 + 40 * S],
    ['a long turn: cut to the last safe moment', { compactCountdown: 180 }, T0 + 120 * S, MAX - LATE_MARGIN_MS],
    ['a countdown longer than the cache lives', { compactCountdown: 600 }, T0 + 10 * S, MAX - LATE_MARGIN_MS],
    ['an hour-long cache leaves the countdown whole', { ttl: '1h', compactCountdown: 180 }, T0 + 120 * S, T0 + 300 * S],
  ]
  for (const [name, options, endsAt, deadline] of table) {
    const config = resolveConfig(options)
    const asked = turn(state({ ttlMs: config.ttlMs ?? base.ttlMs ?? 300 * S }), T0, endsAt, {}, config, true)
    expect({ name, phase: asked.state.phase, deadline: asked.state.askDeadline }).toEqual({ name, phase: 'ASKING', deadline })
    expect(asked.actions[0]).toEqual({ kind: 'ask', reason: 'session', deadline, selected: 'compact' })
    // Nobody answers: the compaction runs, it is not dropped because the cache ran out first.
    expect(decide(asked.state, deadline + ASK_GRACE_MS, tick, config).state.phase).toBe('COMPACTING')
  }
  // With too little time left to decide in, the person is not asked and nothing is compacted behind their back.
  for (const endsAt of [MAX - 2 * LATE_MARGIN_MS + S, MAX - S]) {
    const late = turn(state(), T0, endsAt, {}, base, true)
    expect({ endsAt, phase: late.state.phase, actions: late.actions }).toEqual({ endsAt, phase: 'WARM', actions: [{ kind: 'notify', text: TOO_SOON }, { kind: 'redraw' }] })
  }
  // A session that may compact without asking still does: the cache is warm.
  expect(turn(state(), T0, MAX - S, {}, resolveConfig({ sessionCompact: 'auto' }), true).state.phase).toBe('COMPACTING')
})

test('a turn the person interrupted takes the request for a compaction with it', () => {
  for (const sessionCompact of ['auto', 'confirm']) {
    const config = resolveConfig({ sessionCompact })
    const ended = turn(state(), T0, T0 + 10 * S, { isAborted: true }, config, true)
    expect({ sessionCompact, phase: ended.state.phase, actions: kinds(ended.actions) }).toEqual({ sessionCompact, phase: 'WARM', actions: ['redraw'] })
  }
  // A turn that ended with its answer keeps it.
  expect(turn(state(), T0, T0 + 10 * S, {}, resolveConfig({ sessionCompact: 'auto' }), true).state.phase).toBe('COMPACTING')
})

test('a turn whose last request ended in an error falls back to what the cache is known to have seen', () => {
  // The person comes back after an hour, the cache is long gone, and the API answers with an error: the
  // time of that request says nothing, the cache is as cold as it was.
  const cold = state({ phase: 'COLD', coldReason: 'expired', anchorAt: T0 - 3600 * S })
  const failed = turn(cold, T0, T0 + 5 * S, { isAborted: true, isFailed: true })
  expect(failed.state).toMatchObject({ phase: 'COLD', anchorAt: T0 - 3600 * S })
  expect(run(failed.state, [[ASK, tick], [ACT, tick], [MAX, tick]]).phase).toBe('COLD')
  // In a session that never got a request through, nothing is known.
  expect(turn(state(), T0, T0 + 5 * S, { isAborted: true, isFailed: true }).state).toMatchObject({ phase: 'UNKNOWN', anchorAt: null })
  // Two requests, the second fails: the first one reached the cache, and that is what counts.
  const two = run(state(), [[T0, { kind: 'turn-start', by: 'person' }], [T0, { kind: 'request', sentAt: T0 }], [T0 + 30 * S, { kind: 'request', sentAt: T0 + 30 * S }]])
  expect(decide(two, T0 + 35 * S, { kind: 'turn-complete', isAborted: true, isFailed: true }, base).state).toMatchObject({ phase: 'WARM', anchorAt: T0 })
  // An interrupt alone is no error: the request reached the cache.
  expect(turn(cold, T0, T0 + 5 * S, { isAborted: true }).state).toMatchObject({ phase: 'WARM', anchorAt: T0 })
  // A turn that failed before any request leaves a warm cache as it was.
  const before = run(warm(), [[T0 + 60 * S, { kind: 'turn-start', by: 'person' }]])
  expect(decide(before, T0 + 61 * S, { kind: 'turn-complete', isAborted: true, isFailed: true }, base).state).toMatchObject({ phase: 'WARM', anchorAt: T0 })
})

test('a renewal that got no answer is tried once more, a little later, and then left alone', () => {
  const renewing = warm({ phase: 'RENEWING', isAsked: true })
  const failedAt = ACT + 2 * S
  const failed = decide(renewing, failedAt, { kind: 'renew-failed' }, base)
  // The cache is as warm as it was, and no renewal was used.
  expect(failed.state).toMatchObject({ phase: 'WARM', anchorAt: T0, renewals: 0, retryAt: failedAt + RETRY_AFTER_MS })
  expect(kinds(failed.actions)).toEqual(['redraw'])
  // Nothing is sent until the retry is due: not one request a tick.
  for (const at of [failedAt + S, failedAt + RETRY_AFTER_MS - 1]) expect(decide(failed.state, at, tick, base).state.phase).toBe('WARM')
  const retried = decide(failed.state, failedAt + RETRY_AFTER_MS, tick, base)
  expect(retried.state.phase).toBe('RENEWING')
  expect(kinds(retried.actions)).toEqual(['renew', 'redraw'])
  // The retry goes through: the course goes on as if nothing had happened.
  const sentAt = failedAt + RETRY_AFTER_MS
  expect(decide(retried.state, sentAt + S, { kind: 'renewed', isHit: true, sentAt }, base).state).toMatchObject({ phase: 'WARM', anchorAt: sentAt, renewals: 1, retryAt: null })
  // It fails too: nothing more is sent, the compaction is not brought forward, and the person is told.
  const twice = decide(retried.state, sentAt + S, { kind: 'renew-failed' }, base)
  expect(twice.state).toMatchObject({ phase: 'WARM', isDeclined: true, retryAt: null })
  expect(twice.actions).toEqual([{ kind: 'notify', text: RENEW_FAILED }, { kind: 'redraw' }])
  expect(run(twice.state, [[sentAt + 2 * S, tick], [MAX - S, tick]]).phase).toBe('WARM')
  // The same in every mode, whatever the number of renewals.
  for (const options of [{ mode: 'keep' }, { mode: 'custom', maxRenewals: 1000 }, { mode: 'custom', ask: 'every' }]) {
    const config = resolveConfig(options)
    const once = decide(renewing, failedAt, { kind: 'renew-failed' }, config)
    expect({ options, retryAt: once.state.retryAt }).toEqual({ options, retryAt: failedAt + RETRY_AFTER_MS })
    expect(decide(once.state, failedAt + S, tick, config).state.phase).toBe('WARM')
  }
  // Outside a renewal it changes nothing.
  expect(decide(warm(), ACT, { kind: 'renew-failed' }, base).state).toEqual(warm())
})

test('a clock that was set back is not taken for a warm cache', () => {
  // The last request looks an hour ahead: nothing is known, nothing is sent.
  const ahead = warm({ anchorAt: T0 + 3600 * S })
  const seen = decide(ahead, T0, tick, base)
  expect(seen.state).toMatchObject({ phase: 'COLD' })
  expect(kinds(seen.actions)).toEqual(['notify', 'redraw'])
  // A few seconds of skew between two clocks are not a clock set back.
  expect(decide(warm({ anchorAt: T0 + 5 * S }), T0, tick, base).state.phase).toBe('WARM')
  // Set back by less than the cache has lived, the anchor still lies in the past: the tick that comes from
  // before the last one gives it away.
  const back: Observation = { kind: 'tick', gapMs: -1800 * S }
  expect(decide(warm({ ttlMs: TTL_1H }), T0 + 1200 * S, back, base).state.phase).toBe('COLD')
  expect(decide(warm({ ttlMs: TTL_1H }), T0 + 1200 * S, { kind: 'tick', gapMs: -S }, base).state.phase).toBe('WARM')
})

test('switched off with a question open, the question is dropped and nothing is done', () => {
  const asking = warm({ phase: 'ASKING', isAsked: true, askReason: 'cache', askDeadline: ACT })
  const off = resolveConfig({ enabled: false })
  const after = decide(asking, ACT + ASK_GRACE_MS, tick, off)
  expect(after.state).toMatchObject({ phase: 'WARM', askReason: null, askDeadline: null })
  expect(after.actions).toEqual([])
  // Switched on again it starts from the truth: a warm cache with its real time left.
  expect(decide(after.state, ACT + 10 * S, tick, base).state.phase).toBe('RENEWING')
})

test('the plan says whether the plugin will ask and whether it will act', () => {
  const table: [string, Record<string, unknown>, Partial<State>, boolean, boolean][] = [
    // name, options, state, asks, acts
    ['the default', {}, {}, true, true],
    ['asked once already, a renewal comes next', {}, { isAsked: true, renewals: 1 }, false, true],
    // a compaction is asked about again, however often the question was up before
    ['asked once already, the compaction comes next', {}, { isAsked: true, renewals: 2 }, true, true],
    ['a mode that never asks does not ask before its compaction either', { mode: 'compact-only' }, {}, false, true],
    ['keep, its renewals used up', { mode: 'keep' }, { renewals: 3 }, false, false],
    ['asking every time', { mode: 'custom', ask: 'every' }, { isAsked: true }, true, true],
    ['keep never asks', { mode: 'keep' }, {}, false, true],
    ['notify only asks', { mode: 'notify' }, {}, true, false],
    ['notify, asked already', { mode: 'notify' }, { isAsked: true }, false, false],
    ['the person declined', {}, { isDeclined: true }, false, false],
    ['a small context', {}, { contextTokens: 99999 }, false, false],
    ['a context of unknown size', {}, { contextTokens: null }, true, true],
    ['switched off', { enabled: false }, {}, false, false],
  ]
  for (const [name, options, over, asks, acts] of table) {
    expect({ name, ...planOf(warm(over), resolveConfig(options)) }).toEqual({ name, asks, acts })
  }
})

test('no mode renews more than three times in one idle period, and only the person at work starts the count over', () => {
  const table: [Record<string, unknown>, number][] = [
    // options, renewals in twenty idle periods on end
    [{}, 2],
    [{ mode: 'keep' }, 3],
    [{ mode: 'custom', maxRenewals: 3, ask: 'never' }, 3],
    [{ mode: 'custom', maxRenewals: 99, ask: 'never' }, 3],
    [{ mode: 'custom', maxRenewals: -1, ask: 'never' }, 3],
    [{ mode: 'compact-only' }, 0],
  ]
  for (const [options, most] of table) {
    const config = resolveConfig(options)
    let current = warm()
    let renewed = 0
    // Each tick at the time to act, each renewal answered with a hit.
    for (let period = 0; period < 20 && current.phase === 'WARM'; period += 1) {
      const at = (current.anchorAt ?? T0) + 240 * S
      const acted = decide(current, at, tick, config)
      if (acted.state.phase !== 'RENEWING') break
      renewed += 1
      current = decide(acted.state, at + S, { kind: 'renewed', isHit: true, sentAt: at }, config).state
    }
    expect({ options, renewed }).toEqual({ options, renewed: most })
  }

  const used = warm({ renewals: 3 })
  // A background task's turn or another session's message leaves the count; the person's own turn ends it.
  expect(decide(used, T0 + S, { kind: 'turn-start', by: 'other' }, base).state.renewals).toBe(3)
  expect(decide(used, T0 + S, { kind: 'turn-start', by: 'self' }, base).state.renewals).toBe(3)
  expect(decide(used, T0 + S, { kind: 'turn-start', by: 'person' }, base).state.renewals).toBe(0)
})

test('a session may name the countdown of its request, within bounds', () => {
  const table: [unknown, number | null][] = [
    // what the session passed, the countdown in ms
    [undefined, null],
    ['60', null],
    [Number.NaN, null],
    [60, 60 * S],
    [10, 10 * S],
    [9, 10 * S],
    [0, 10 * S],
    [-5, 10 * S],
    [600, 600 * S],
    [601, 600 * S],
    [45.4, 45 * S],
  ]
  for (const [passed, ms] of table) expect({ passed, ms: countdownOf(passed) }).toEqual({ passed, ms })

  // The session's own countdown is used for its question; without one, the option's 20 seconds.
  const own = decide(working(), T0 + S, { kind: 'requested', countdownMs: 60 * S }, base).state
  expect(own).toMatchObject({ isRequested: true, requestMs: 60 * S })
  expect(decide(own, T0 + 5 * S, done(60000), base).state).toMatchObject({ phase: 'ASKING', askReason: 'session', askDeadline: T0 + 65 * S })
  const plain = decide(working(), T0 + S, asks, base).state
  expect(plain).toMatchObject({ isRequested: true, requestMs: null })
  expect(decide(plain, T0 + 5 * S, done(60000), base).state).toMatchObject({ phase: 'ASKING', askDeadline: T0 + 35 * S })
  // A countdown asked for in one turn does not carry over to the next request.
  const next = decide({ ...working(), requestMs: 60 * S }, T0 + S, asks, base).state
  expect(next.requestMs).toBeNull()
  // It still ends while the cache is warm.
  expect(decide(own, T0 + 120 * S, done(60000), base).state.askDeadline).toBe(T0 + 180 * S)
  expect(decide({ ...own, requestMs: 600 * S }, T0 + 120 * S, done(60000), base).state.askDeadline).toBe(MAX - LATE_MARGIN_MS)
})

test('set to wait, a request is asked about and only the person compacts', () => {
  const wait = resolveConfig({ sessionCompact: 'wait' })
  const requested = decide(working(), T0 + S, { kind: 'requested', countdownMs: 60 * S }, wait).state
  const asked = decide(requested, T0 + 5 * S, done(150000), wait)
  // No countdown of the request's own: the question stays until the cache's course takes over, here with
  // its own question at 3:30.
  expect(asked.state).toMatchObject({ phase: 'ASKING', askReason: 'session', askDeadline: ASK })
  expect(asked.actions).toEqual([{ kind: 'ask', reason: 'session', deadline: ASK, selected: 'skip' }, { kind: 'redraw' }])

  // Nobody answers: the request is dropped, also when the shell does not answer in time, and the cache's
  // question follows.
  const timed = decide(asked.state, ASK, { kind: 'answer', choice: 'skip', isTimers: true }, wait)
  expect(timed.state).toMatchObject({ phase: 'WARM', isDeclined: false })
  expect(kinds(timed.actions)).toEqual(['close-question', 'redraw'])
  expect(decide(timed.state, ASK + S, tick, wait).state).toMatchObject({ phase: 'ASKING', askReason: 'cache' })
  expect(decide(asked.state, ASK + ASK_GRACE_MS, tick, wait).state.phase).toBe('WARM')

  // A mode whose next step is the compaction: the waiting question does not push the cache's question out,
  // so nothing is compacted without having been asked about.
  const straight = resolveConfig({ mode: 'custom', ask: 'first', maxRenewals: 0, renewMethod: 'none', sessionCompact: 'wait' })
  const open = decide(requested, T0 + 5 * S, done(150000), straight).state
  expect(open.askDeadline).toBe(ASK)
  const dropped = decide(open, ASK, { kind: 'answer', choice: 'skip', isTimers: true }, straight).state
  expect(decide(dropped, ASK + S, tick, straight)).toMatchObject({ state: { phase: 'ASKING', askReason: 'cache' }, actions: [{ kind: 'ask', selected: 'compact' }, { kind: 'redraw' }] })
  // A mode that never asks: the waiting question stays until the time to act.
  const silent = resolveConfig({ mode: 'keep', sessionCompact: 'wait' })
  expect(decide(requested, T0 + 5 * S, done(150000), silent).state.askDeadline).toBe(ACT)

  // The cache turned out to live five minutes, not an hour: the question gives way at the new time to act.
  const hour = decide({ ...requested, ttlMs: TTL_1H }, T0 + 5 * S, done(150000), silent).state
  expect(hour.askDeadline).toBe(T0 + 3000 * S)
  const short = decide(hour, T0 + 6 * S, { kind: 'ttl', ttlMs: 300 * S, source: 'transcript' }, silent).state
  expect(decide(short, ACT - S, tick, silent).state.phase).toBe('ASKING')
  const gave = decide(short, ACT, tick, silent)
  expect(gave.state.phase).toBe('WARM')
  expect(kinds(gave.actions)).toEqual(['close-question', 'redraw'])
  expect(decide(gave.state, ACT + S, tick, silent).state.phase).toBe('RENEWING')
  // The person says Compact: it is done, with no announcement to a session that asked.
  const said = decide(asked.state, T0 + 30 * S, { kind: 'answer', choice: 'compact' }, wait)
  expect(said.state).toMatchObject({ phase: 'COMPACTING', isOrdered: true })
  // Too close to the cache's own question, nothing is asked.
  const late = decide(requested, ASK - 5 * S, done(150000), wait)
  expect(late.state.phase).toBe('WARM')
  expect(late.actions[0]).toEqual({ kind: 'notify', text: TOO_SOON })
})

test('no more than three renewal requests go out in one idle period, answered or not', () => {
  const keep = resolveConfig({ mode: 'keep' })
  // Each step: the time to act comes, a renewal goes out, and it is answered with a hit or not at all.
  const period = (from: State, isAnswered: boolean): State => {
    const at = (from.retryAt ?? (from.anchorAt ?? T0) + 240 * S) + S
    const sent = decide(from, at, tick, keep)
    if (sent.state.phase !== 'RENEWING') return sent.state
    return decide(sent.state, at + S, isAnswered ? { kind: 'renewed', isHit: true, sentAt: at } : { kind: 'renew-failed' }, keep).state
  }
  const table: [string, boolean[], number, number, boolean][] = [
    // name, each request answered or not, renewals, requests sent, given up
    ['three that are answered', [true, true, true, true], 3, 3, false],
    ['one that fails is tried again within the three', [false, true, true, true], 2, 3, false],
    ['a failure after two renewals is the third request: no retry', [true, true, false, true], 2, 3, true],
    ['two failures on end are the end', [false, false, true], 0, 2, true],
  ]
  for (const [name, answers, renewals, renewalsSent, isDeclined] of table) {
    const end = answers.reduce(period, warm())
    expect({ name, renewals: end.renewals, renewalsSent: end.renewalsSent, isDeclined: end.isDeclined }).toEqual({ name, renewals, renewalsSent, isDeclined })
    // Whatever happened, nothing more goes out however long the session stays idle.
    expect({ name, phase: period(period(end, true), true).phase }).not.toEqual({ name, phase: 'RENEWING' })
  }
  // The failure that used up the last request is said.
  const spent = warm({ phase: 'RENEWING', renewals: 2, renewalsSent: 3 })
  expect(decide(spent, ACT, { kind: 'renew-failed' }, keep).actions[0]).toEqual({ kind: 'notify', text: RENEW_FAILED })
  // A state kept by a version that did not count requests: what was renewed was sent.
  const { renewalsSent: _, ...old } = warm({ renewals: 2 })
  expect(decide(old as State, T0 + S, tick, keep).state.renewalsSent).toBe(2)
})
