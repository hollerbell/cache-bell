import { expect, test } from 'claude-code/testing'

import { choiceTexts, choicesOf, whyText } from '../../core/ask'
import { resolveConfig } from '../../core/config'
import { ASK_GRACE_MS, decide, initialState } from '../../core/decide'
import { NONE } from '../../core/extension'
import type { Extension } from '../../core/extension'
import type { Action, Observation, State } from '../../core/types'
import { statusReport } from '../../core/view'

const S = 1000
// A Monday morning: 2026-01-12 09:00 UTC.
const T0 = Date.UTC(2026, 0, 12, 9)

const tick: Observation = { kind: 'tick', gapMs: S }
const base = resolveConfig({})

// An extension with one question: asked once the context has ten tokens, answered by waiting.
const toy: Extension = {
  ...NONE,
  reasons: { toy: { choices: ['compact', 'wait'], selected: 'wait', why: state => `toy at ${state.contextTokens}` } },
  // 'compact' is the core's own: an extension cannot give it other words.
  choices: { wait: { label: 'Wait' }, compact: { label: 'Squash' } },
  due: state => (state.ext.isDone !== true && (state.contextTokens ?? 0) >= 10 ? 'toy' : null),
  answer: (state, choice) => (choice === 'wait' ? { ...state.ext, waited: true } : null),
  passedOver: state => ({ ...state.ext, passed: true }),
  reset: (ext, after) => (after === 'compacted' ? { waited: ext.waited } : {}),
  status: state => [`Toy: ${JSON.stringify(state.ext)}`],
}

const state = (over: Partial<State> = {}): State => ({ ...initialState(base), ...over })
const working = (over: Partial<State> = {}): State => state({ phase: 'BUSY', anchorAt: T0, ...over })
const asking = (over: Partial<State> = {}): State =>
  state({ phase: 'ASKING', anchorAt: T0, contextTokens: 20, askReason: 'toy', askDeadline: T0 + 185 * S, ...over })
const done = (tokens: number): Observation => ({ kind: 'turn-complete', contextTokens: tokens })
const kinds = (actions: Action[]): string[] => actions.map(action => action.kind)

test('an extension asks its own question when a turn ends and the core has nothing to ask', () => {
  const asked = decide(working(), T0 + 5 * S, done(20), base, toy)
  expect(asked.state).toMatchObject({ phase: 'ASKING', askReason: 'toy', askDeadline: T0 + 185 * S })
  expect(asked.actions).toEqual([{ kind: 'ask', reason: 'toy', deadline: T0 + 185 * S, selected: 'wait' }, { kind: 'redraw' }])

  expect(decide(working(), T0 + 5 * S, done(9), base, toy).state.phase).toBe('WARM')
  expect(decide(working(), T0 + 5 * S, done(20), base).state.phase).toBe('WARM')
  expect(decide(working(), T0 + 5 * S, done(20), resolveConfig({ enabled: false }), toy).state.phase).toBe('WARM')
  // The session's own request comes first.
  expect(decide(working({ isRequested: true }), T0 + 5 * S, done(20), base, toy).state.askReason).toBe('session')
  // A reason the extension names but does not describe is not asked.
  expect(decide(working(), T0 + 5 * S, done(20), base, { ...toy, reasons: {} }).state.phase).toBe('WARM')
})

test('an answer goes to the extension unless it is the core\'s own; one nobody knows does nothing', () => {
  const table: [string, Partial<State>, string[]][] = [
    ['wait', { phase: 'WARM', ext: { waited: true } }, ['close-question', 'redraw']],
    ['compact', { phase: 'PREPARING', ext: {} }, ['close-question', 'prepare', 'redraw']],
    ['nonsense', { phase: 'WARM', ext: {} }, ['close-question', 'redraw']],
  ]
  for (const [choice, fields, actions] of table) {
    const result = decide(asking(), T0 + 20 * S, { kind: 'answer', choice }, base, toy)
    const got = Object.fromEntries(Object.keys(fields).map(key => [key, result.state[key as keyof State]]))
    expect({ choice, state: got, actions: kinds(result.actions), askReason: result.state.askReason }).toEqual({ choice, state: fields, actions, askReason: null })
  }
})

test('an unanswered question of the extension does what the extension selected', () => {
  expect(decide(asking(), T0 + 185 * S + ASK_GRACE_MS - 1, tick, base, toy)).toEqual({ state: asking(), actions: [] })
  expect(decide(asking(), T0 + 185 * S + ASK_GRACE_MS, tick, base, toy).state).toMatchObject({ phase: 'WARM', ext: { waited: true } })
  // The extension is gone (the plugin was reloaded without it): the question is dropped, nothing is done.
  const gone = decide(asking(), T0 + 185 * S + ASK_GRACE_MS, tick, base)
  expect(gone.state).toMatchObject({ phase: 'WARM', askReason: null })
  expect(kinds(gone.actions)).toEqual(['close-question', 'redraw'])
})

test('working on past the extension\'s question is the extension\'s to read; only the person\'s turn counts', () => {
  expect(decide(asking(), T0 + 20 * S, { kind: 'turn-start', by: 'person' }, base, toy).state).toMatchObject({ phase: 'BUSY', ext: { passed: true }, askReason: null })
  expect(decide(asking(), T0 + 20 * S, { kind: 'turn-start', by: 'other' }, base, toy).state.ext).toEqual({})
  const cache = asking({ askReason: 'cache' })
  expect(decide(cache, T0 + 20 * S, { kind: 'turn-start', by: 'person' }, base, toy).state.ext).toEqual({})
  const session = asking({ askReason: 'session' })
  expect(decide(session, T0 + 20 * S, { kind: 'turn-start', by: 'person' }, base, toy).state.ext).toEqual({})
})

test('the extension says what it still remembers after a compaction and after a /clear', () => {
  const before = state({ phase: 'WARM', anchorAt: T0, ext: { waited: true, passed: true } })
  expect(decide(before, T0 + S, { kind: 'compacted' }, base, toy).state.ext).toEqual({ waited: true })
  expect(decide(before, T0 + S, { kind: 'cleared' }, base, toy).state.ext).toEqual({})
  // Without an extension nothing is remembered.
  expect(decide(before, T0 + S, { kind: 'compacted' }, base).state.ext).toEqual({})
})

test('the extension\'s choices, reason and status rows stand next to the core\'s', () => {
  expect(choicesOf('toy', toy)).toEqual(['compact', 'wait'])
  expect(choicesOf('cache', toy)).toEqual(['compact', 'renew', 'cancel'])
  expect(choicesOf('gone', toy)).toEqual(['compact'])
  expect(choiceTexts(toy)).toMatchObject({ wait: { label: 'Wait' }, compact: { label: 'Compact' }, skip: { label: 'Not now' } })
  expect(whyText('toy', asking(), toy, base)).toBe('toy at 20')
  expect(whyText('gone', asking(), toy, base)).toBe('')
  const report = statusReport(asking({ ext: { waited: true } }), T0, base, { contextTokens: 20 }, toy)
  expect(report).toMatch(/\nContext: 20 tokens\nToy: \{"waited":true\}$/)
})

test('a state written before extensions gets an empty place for them', () => {
  const { ext: _, ...old } = { ...state({ phase: 'WARM', anchorAt: T0 }), anOldField: 5, anotherOldField: true }
  expect(decide(old as unknown as State, T0 + S, tick, base, toy).state.ext).toEqual({})
})
