import { expect, test } from 'claude-code/testing'

import { SIGNAL_NONE, signalOf } from '../../core/signal'
import type { SignalOptions, SignalSeen } from '../../core/signal'

const W = 1_000_000
const status: SignalOptions = { limitTokens: 0, askFromTokens: 0, isStatusOn: true }
const off: SignalOptions = { limitTokens: 0, askFromTokens: 0, isStatusOn: false }
const limited: SignalOptions = { limitTokens: 300_000, askFromTokens: 300_000, isStatusOn: true }

// The lines sent along a run of context sizes, each given what the line before left.
const run = (sizes: readonly (number | null)[], options: SignalOptions, window: number | null = W): (string | null)[] => {
  let seen: SignalSeen = SIGNAL_NONE
  return sizes.map(tokens => {
    const next = signalOf(tokens, window, seen, options)
    seen = next.seen
    return next.line
  })
}

test('without a limit the context is told from half the window on, each 5 % of it and at 85, 90 and 95 %', () => {
  expect(run([100_000, 499_999, 500_000, 520_000, 549_999, 550_000], status)).toEqual([
    null,
    null,
    '[cache-bell] Context notice: 500k of a 1000k window (50%).',
    null,
    null,
    '[cache-bell] Context notice: 550k of a 1000k window (55%).',
  ])
  // Less than 5 % since the last line, yet across a mark: told all the same.
  expect(run([820_000, 850_000, 880_000, 900_000, 949_000, 951_000], status)).toEqual([
    '[cache-bell] Context notice: 820k of a 1000k window (82%).',
    '[cache-bell] Context notice: 850k of a 1000k window (85%).',
    null,
    '[cache-bell] Context notice: 900k of a 1000k window (90%).',
    null,
    '[cache-bell] Context notice: 951k of a 1000k window (95%).',
  ])
})

test('past the limit the user wants a compaction: said the first time and then each 5 % of the window', () => {
  expect(run([299_999, 300_000, 320_000, 350_000], limited)).toEqual([
    null,
    '[cache-bell] User preference notice: the user set a context limit of 300k; the context is now 300k of a 1000k window (30%), 0k over. The user wants a compaction at the next good point: see skill cache-bell:compact.',
    null,
    '[cache-bell] User preference notice: the user set a context limit of 300k; the context is now 350k of a 1000k window (35%), 50k over. The user wants a compaction at the next good point: see skill cache-bell:compact.',
  ])
  // The limit is said with the status switched off as well, and without a window the size alone.
  expect(run([400_000], { limitTokens: 300_000, askFromTokens: 300_000, isStatusOn: false }, null)).toEqual([
    '[cache-bell] User preference notice: the user set a context limit of 300k; the context is now 400k, 100k over. The user wants a compaction at the next good point: see skill cache-bell:compact.',
  ])
})

test('crossing the limit is said at once, even right after a line on the size', () => {
  const low: SignalOptions = { limitTokens: 520_000, askFromTokens: 520_000, isStatusOn: true }
  expect(run([500_000, 520_000, 540_000], low)).toEqual([
    '[cache-bell] Context notice: 500k of a 1000k window (50%).',
    '[cache-bell] User preference notice: the user set a context limit of 520k; the context is now 520k of a 1000k window (52%), 0k over. The user wants a compaction at the next good point: see skill cache-bell:compact.',
    null,
  ])
})

test('after Later the user wants a compaction only from where the question comes back; after Not in this session never', () => {
  const later: SignalOptions = { limitTokens: 300_000, askFromTokens: 450_000, isStatusOn: true }
  expect(run([400_000, 450_000], later)).toEqual([
    null,
    '[cache-bell] User preference notice: the user set a context limit of 300k; the context is now 450k of a 1000k window (45%), 150k over. The user wants a compaction at the next good point: see skill cache-bell:compact.',
  ])
  const never: SignalOptions = { limitTokens: 300_000, askFromTokens: 0, isStatusOn: true }
  expect(run([400_000, 600_000], never)).toEqual([null, '[cache-bell] Context notice: 600k of a 1000k window (60%).'])
  expect(run([400_000, 600_000], { ...never, isStatusOn: false })).toEqual([null, null])
})

test('with both switched off, or with nothing known, nothing is said', () => {
  expect(run([100_000, 600_000, 990_000], off)).toEqual([null, null, null])
  expect(run([null, Number.NaN, -1], limited)).toEqual([null, null, null])
  // No window: no status line, which is counted against the window.
  expect(run([990_000], status, null)).toEqual([null])
  expect(run([990_000], status, 0)).toEqual([null])
})

test('a context that shrank by more than 5 % of the window starts over; a smaller dip does not', () => {
  expect(run([600_000, 120_000, 600_000], status)).toEqual([
    '[cache-bell] Context notice: 600k of a 1000k window (60%).',
    null,
    '[cache-bell] Context notice: 600k of a 1000k window (60%).',
  ])
  expect(run([600_000, 590_000, 600_000, 649_000, 650_000], status)).toEqual([
    '[cache-bell] Context notice: 600k of a 1000k window (60%).',
    null,
    null,
    null,
    '[cache-bell] Context notice: 650k of a 1000k window (65%).',
  ])
})

test('a line holds numbers and the name of the skill, nothing else', () => {
  for (const line of [...run([600_000, 990_000], status), ...run([350_000], limited)]) {
    if (line === null) continue
    const words = line.replace(/\d+k?|\d+%/g, '#')
    expect(words).toMatch(/^\[cache-bell\] (Context notice|User preference notice): /)
    expect(/[\\/]|@/.test(words.replace('cache-bell:compact', ''))).toBe(false)
  }
})
