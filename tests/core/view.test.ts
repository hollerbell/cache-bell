import { expect, test } from 'claude-code/testing'

import { resolveConfig } from '../../core/config'
import { decide, initialState } from '../../core/decide'
import { TTL_1H } from '../../core/timing'
import type { State } from '../../core/types'
import { PALETTE, UNREAD, band, compactedText, formatIdle, introOf, formatLeft, formatCount, formatTtl, lookOf, resent, statusEntry, statusReport, versionOf } from '../../core/view'

const S = 1000
// A Monday morning: 2026-01-12 09:00 UTC.
const T0 = Date.UTC(2026, 0, 12, 9)

// The countdown is shown whatever time is left; when it shows has a test of its own.
const config = resolveConfig({ showBelowMinutes: 0 })
const state = (over: Partial<State> = {}): State => ({ ...initialState(config), ...over })
const warm = (over: Partial<State> = {}): State => state({ phase: 'WARM', anchorAt: T0, ...over })

test('time left shows seconds only under ten minutes', () => {
  const table: [number, string][] = [
    [-5 * S, '0:00'],
    [0, '0:00'],
    [999, '0:00'],
    [S, '0:01'],
    [59 * S, '0:59'],
    [60 * S, '1:00'],
    [275 * S, '4:35'],
    [600 * S - 1, '9:59'],
    [600 * S, '10 min'],
    [3300 * S - 1, '54 min'],
    [3300 * S, '55 min'],
  ]
  for (const [ms, text] of table) expect({ ms, text: formatLeft(ms) }).toEqual({ ms, text })
})

test('a TTL is named as Claude Code names it', () => {
  expect([formatTtl(300 * S), formatTtl(3600 * S), formatTtl(120 * S)]).toEqual(['5m', '1h', '2m'])
})

test('the band shows the countdown while warm and the reason while cold', () => {
  const table: [string, State, number, object | null][] = [
    ['right after the request', warm(), T0, { text: 'h⣿ Cache Bell: prompt cache expires in 4:35 · lifetime 5m assumed, not yet seen in the data', tone: 'calm' }],
    ['one millisecond before the question is due', warm(), T0 + 210 * S - 1, { text: 'h⣿ Cache Bell: prompt cache expires in 1:05 · lifetime 5m assumed, not yet seen in the data', tone: 'calm' }],
    ['once the question is due', warm(), T0 + 210 * S, { text: 'h⣿ Cache Bell: prompt cache expires in 1:05 · lifetime 5m assumed, not yet seen in the data', tone: 'warn' }],
    ['an hour-long cache', warm({ ttlMs: TTL_1H }), T0 + 60 * S, { text: 'h⣿ Cache Bell: prompt cache expires in 54 min · lifetime 1h assumed, not yet seen in the data', tone: 'calm' }],
    ['cold, expired', warm({ phase: 'COLD', coldReason: 'expired' }), T0, { text: 'h⣿ Cache Bell: prompt cache expired · the next message re-sends the whole context', tone: 'cold' }],
    ['cold, slept', warm({ phase: 'COLD', coldReason: 'sleep' }), T0, { text: 'h⣿ Cache Bell: prompt cache expired while the machine slept · the next message re-sends the whole context', tone: 'cold' }],
    ['cold, model changed', warm({ phase: 'COLD', coldReason: 'model-switch' }), T0, { text: 'h⣿ Cache Bell: prompt cache lost, the model changed · the next message re-sends the whole context', tone: 'cold' }],
    ['cold without a reason', warm({ phase: 'COLD' }), T0, { text: 'h⣿ Cache Bell: prompt cache expired · the next message re-sends the whole context', tone: 'cold' }],
    ['unknown', state(), T0, null],
    ['busy', state({ phase: 'BUSY', anchorAt: T0 }), T0, null],
    ['dormant', state({ phase: 'DORMANT' }), T0, null],
    ['warm without an anchor', state({ phase: 'WARM' }), T0, null],
  ]
  for (const [name, from, now, view] of table) expect({ name, view: band(from, now, config) }).toEqual({ name, view })
})

test('the display option picks where the countdown shows', () => {
  const table: [Record<string, unknown>, boolean, string | undefined][] = [
    // options, band drawn, status line entry
    [{ display: 'band' }, true, undefined],
    [{ display: 'status' }, false, 'cache 4:35'],
    [{ display: 'both' }, true, 'cache 4:35'],
    [{ display: 'off' }, false, undefined],
    [{ display: 'both', enabled: false }, false, undefined],
  ]
  for (const [options, hasBand, entry] of table) {
    const cfg = resolveConfig(options)
    expect({ options, hasBand: band(warm(), T0, cfg) !== null, entry: statusEntry(warm(), T0, cfg) }).toEqual({ options, hasBand, entry })
  }
})

test('the status line entry follows the phase', () => {
  const both = resolveConfig({ display: 'both' })
  expect(statusEntry(warm({ phase: 'COLD', coldReason: 'expired' }), T0, both)).toBe('cache cold')
  expect(statusEntry(state(), T0, both)).toBeUndefined()
  expect(statusEntry(state({ phase: 'BUSY' }), T0, both)).toBeUndefined()
  expect(statusEntry(state({ phase: 'DORMANT' }), T0, both)).toBeUndefined()
})

test('/bell status reports a warm cache', () => {
  const report = statusReport(warm({ ttlMs: 300 * S, ttlSource: 'transcript' }), T0 + 60 * S, resolveConfig({ mode: 'notify' }), { contextTokens: 43985 })
  expect(report).toBe(
    [
      'on, mode notify',
      'State: warm',
      'Cache TTL: 5m (read from the transcript)',
      'Last request to the API: 1:00 ago',
      'Next: asks in 2:30, cache lost in 3:35',
      'Context: 43 985 tokens',
    ].join('\n'),
  )
})

test('the status report lists only what will really happen to a warm cache', () => {
  const rowOf = (options: Record<string, unknown>, over: Partial<State> = {}): string =>
    statusReport(warm({ contextTokens: 150000, ...over }), T0, resolveConfig(options), { contextTokens: 150000 }).split('\n')[4] ?? ''
  const table: [string, Record<string, unknown>, Partial<State>, string][] = [
    ['the default asks and renews', {}, {}, 'Next: asks in 3:30, renews in 4:00, cache lost in 4:35'],
    ['its renewals used up, it asks and compacts', {}, { isAsked: true, renewals: 2 }, 'Next: asks in 3:30, compacts in 4:00, cache lost in 4:35'],
    ['asked once already', {}, { isAsked: true }, 'Next: renews in 4:00, cache lost in 4:35'],
    ['keep does not ask', { mode: 'keep' }, {}, 'Next: renews in 4:00, cache lost in 4:35'],
    ['compact-only does not ask either', { mode: 'compact-only' }, {}, 'Next: compacts in 4:00, cache lost in 4:35'],
    ['notify only asks', { mode: 'notify' }, {}, 'Next: asks in 3:30, cache lost in 4:35'],
    ['the person declined', {}, { isDeclined: true }, 'Next: nothing, cache lost in 4:35'],
    ['a small context', {}, { contextTokens: 5000 }, 'Next: nothing, cache lost in 4:35 (context below 100 000 tokens)'],
    ['a small context, switched off', { enabled: false }, { contextTokens: 5000 }, 'Next: nothing, cache lost in 4:35'],
  ]
  for (const [name, options, over, row] of table) expect({ name, row: rowOf(options, over) }).toEqual({ name, row })
})

test('/bell status before the first turn', () => {
  const report = statusReport(state(), T0, config, { contextTokens: undefined })
  expect(report).toBe(
    [
      'on, mode prepare-compact',
      'State: unknown (no finished turn yet)',
      'Cache TTL: 5m (assumed, not yet seen in the data)',
      'Last request to the API: none seen',
      'Context: not known yet',
    ].join('\n'),
  )
})

test('/bell status names a reason only for a cold cache', () => {
  const report = statusReport(warm({ coldReason: 'expired' }), T0, config, { contextTokens: 1 })
  expect(report).toMatch(/\nState: warm\n/)
})

test('/bell status names every phase and every source of the TTL', () => {
  const cold = statusReport(warm({ phase: 'COLD', coldReason: 'sleep', ttlSource: 'config' }), T0 + 900 * S, resolveConfig({ enabled: false }), { contextTokens: 0 })
  expect(cold).toMatch(/^off, mode prepare-compact/)
  expect(cold).toMatch(/State: cold, expired while the machine slept\n/)
  expect(cold).toMatch(/Cache TTL: 5m \(set in the plugin options\)/)
  expect(cold).toMatch(/Last request to the API: 15 min ago\nContext: 0 tokens$/)

  expect(statusReport(state({ phase: 'BUSY', ttlSource: 'settings' }), T0, config, { contextTokens: 1 })).toMatch(
    /State: busy \(a turn is running\)\nCache TTL: 5m \(from the Claude Code settings, not yet confirmed by a response\)/,
  )
  expect(statusReport(state({ phase: 'DORMANT', ttlMs: TTL_1H, ttlSource: 'model-switch' }), T0, config, { contextTokens: 1 })).toMatch(
    /State: dormant \(compacted, waiting for new work\)\nCache TTL: 1h \(reported at the model switch\)/,
  )
})

test('/bell status tells how large the context is and how often the cache was renewed', () => {
  const sized = resolveConfig({})
  const report = statusReport(warm({ renewals: 1 }), T0 + 60 * S, sized, { contextTokens: 120000 })
  expect(report).toMatch(/\nContext: 120 000 tokens\nRenewed 1 time of 2$/)
  expect(statusReport(warm({ isDeclined: true }), T0, sized, { contextTokens: 1 })).toMatch(/\nRenewed 0 times of 2, the cache will be left to expire$/)
  expect(statusReport(warm({ renewals: 3 }), T0, resolveConfig({ mode: 'keep' }), { contextTokens: 1 })).toMatch(/\nRenewed 3 times of 3$/)
  // A number of renewals outside the range is said, with what is used instead.
  expect(statusReport(warm(), T0, resolveConfig({ mode: 'custom', maxRenewals: 12 }), { contextTokens: 1 })).toMatch(/\nmaxRenewals is set to 12, outside 0 to 3: 3 is used$/)
  expect(statusReport(warm(), T0, resolveConfig({ mode: 'custom', maxRenewals: 3 }), { contextTokens: 1 })).not.toContain('maxRenewals')
  // A mode that only renews ends with the cache gone, and the band says after how many renewals.
  const spent = warm({ phase: 'COLD', coldReason: 'expired', renewals: 3, contextTokens: 143985 })
  expect(band(spent, T0, resolveConfig({ mode: 'keep' }))?.text).toBe('h⣿ Cache Bell: prompt cache expired after 3 renewals · the next message re-sends 144k tokens uncached')
  expect(band({ ...spent, renewals: 1 }, T0, resolveConfig({ mode: 'custom', maxRenewals: 1, compact: false }))?.text).toBe('h⣿ Cache Bell: prompt cache expired after 1 renewal · the next message re-sends 144k tokens uncached')
  expect(band({ ...spent, renewals: 1 }, T0, resolveConfig({}))?.text).toBe('h⣿ Cache Bell: prompt cache expired · the next message re-sends 144k tokens uncached')
  expect(statusReport(warm(), T0, config, { contextTokens: 1 })).not.toMatch(/Renewed/)
})

test('the countdown of a warm cache shows only once the time left is down to the limit set', () => {
  const late = resolveConfig({ showBelowMinutes: 53, display: 'both' })
  const hour = warm({ ttlMs: TTL_1H })
  // On an hour-long cache 55 minutes are left at the start: hidden until 53 are.
  const table: [string, number, string | null, string | undefined][] = [
    ['at the start', T0, null, undefined],
    ['a second before the limit', T0 + 120 * S - 1, null, undefined],
    ['at the limit', T0 + 120 * S, 'h⣿ Cache Bell: prompt cache expires in 53 min · lifetime 1h assumed, not yet seen in the data', 'cache 53 min'],
    ['later', T0 + 600 * S, 'h⣿ Cache Bell: prompt cache expires in 45 min · lifetime 1h assumed, not yet seen in the data', 'cache 45 min'],
  ]
  for (const [name, now, text, entry] of table) {
    expect({ name, text: band(hour, now, late)?.text ?? null, entry: statusEntry(hour, now, late) }).toEqual({ name, text, entry })
  }
  // A five-minute cache never has that much left: always shown. So are a cold cache and the plugin at work.
  expect(band(warm(), T0, late)?.text).toBe('h⣿ Cache Bell: prompt cache expires in 4:35 · lifetime 5m assumed, not yet seen in the data')
  expect(band(warm({ phase: 'COLD', coldReason: 'expired', ttlMs: TTL_1H }), T0, late)?.text).toMatch(/prompt cache expired/)
  expect(band(warm({ phase: 'COMPACTING', ttlMs: TTL_1H }), T0, late)?.text).toBe('h⣿ Cache Bell: compacting…')
})

test('the colours follow the theme of Claude Code', () => {
  const table: [unknown, string][] = [
    ['dark', 'dark'],
    ['light', 'light'],
    ['light-daltonized', 'light'],
    ['dark-ansi', 'dark'],
    [undefined, 'dark'],
    [7, 'dark'],
  ]
  for (const [theme, look] of table) expect({ theme, look: lookOf(theme) }).toEqual({ theme, look })
  expect(PALETTE.dark).toEqual({ letter: '#3aa3b3', tile: '#7ad8f8', warn: 'yellow', cold: 'cyan' })
  expect(PALETTE.light).toEqual({ letter: '#073a44', tile: '#00697a', warn: '#8a5a00', cold: '#005f73' })
})

test('the first-run notice says what the plugin does without the person, from the settings', () => {
  const table: [Record<string, unknown>, string | null, string[]][] = [
    // options, head, rows
    [{}, ' while you are away this plugin acts on its own, on your plan', ['before the prompt cache expires it renews the prompt cache up to 2 times, then compacts the conversation', 'Claude may ask for a compaction too: you get 30 s to cancel, or the time Claude names']],
    [{ mode: 'keep' }, ' while you are away this plugin acts on its own, on your plan', ['before the prompt cache expires it renews the prompt cache up to 3 times', 'Claude may ask for a compaction too: you get 30 s to cancel, or the time Claude names']],
    [{ mode: 'compact-only', sessionCompact: 'off' }, ' while you are away this plugin acts on its own, on your plan', ['before the prompt cache expires it compacts the conversation']],
    [{ mode: 'notify', compactCountdown: 30 }, ' this plugin can compact the conversation without you', ['Claude may ask for a compaction too: you get 30 s to cancel, or the time Claude names']],
    [{ mode: 'notify', sessionCompact: 'auto' }, ' this plugin can compact the conversation without you', ['Claude may ask for a compaction too, and gets it at once']],
    // Nothing happens without the person, or the plugin is off: nothing to tell.
    [{ mode: 'notify', sessionCompact: 'off' }, null, []],
    [{ enabled: false }, null, []],
  ]
  for (const [options, head, rows] of table) {
    const told = introOf(resolveConfig(options))
    expect({ options, head: told?.head ?? null, rows: told?.rows ?? [] }).toEqual({ options, head, rows })
  }
  expect(introOf(resolveConfig({}))?.once).toBe('this notice is shown once: OK or your next message puts it away for good')
  expect(introOf(resolveConfig({}))?.hint).toBe('change it in /config: cache-bell.mode, cache-bell.sessionCompact, cache-bell.enabled')
})

test('a size in tokens is written as short as it reads', () => {
  const table: [number, string][] = [
    [0, '0'],
    [950, '950'],
    [999, '999'],
    [1000, '1k'],
    [1499, '1k'],
    [1500, '2k'],
    [143985, '144k'],
    [999499, '999k'],
    [999500, '1.0M'],
    [1234567, '1.2M'],
  ]
  for (const [tokens, text] of table) expect({ tokens, text: formatCount(tokens) }).toEqual({ tokens, text })
})

test('a cold cache says how much the next message sends again, when the size is known', () => {
  expect(resent(null)).toBe('the next message re-sends the whole context')
  expect(resent(143985)).toBe('the next message re-sends 144k tokens uncached')
  const cold = { ...initialState(resolveConfig({})), phase: 'COLD' as const, coldReason: 'expired' as const, anchorAt: T0 }
  expect(band({ ...cold, contextTokens: 87300 }, T0, resolveConfig({}))?.text).toBe('h⣿ Cache Bell: prompt cache expired · the next message re-sends 87k tokens uncached')
  expect(band(cold, T0, resolveConfig({}))?.text).toBe('h⣿ Cache Bell: prompt cache expired · the next message re-sends the whole context')
})

test('how long a session was idle is said in minutes, then in hours', () => {
  const M = 60 * S
  const table: [number, string][] = [
    [0, '0 min'],
    [12 * M, '12 min'],
    [59 * M, '59 min'],
    [60 * M, '1 h'],
    [74 * M, '1 h'],
    [75 * M, '1.5 h'],
    [120 * M, '2 h'],
    [150 * M, '2.5 h'],
    [-5 * M, '0 min'],
  ]
  for (const [ms, text] of table) expect({ ms, text: formatIdle(ms) }).toEqual({ ms, text })
})

test('after its own compaction the band says what was done, until the next turn', () => {
  const config = resolveConfig({})
  expect(compactedText({ before: 143985, after: 21400, idleMs: 120 * 60 * S })).toBe('compacted 144k → 21k tokens after 2 h idle · /bell log')
  expect(compactedText({ before: null, after: 21400, idleMs: 12 * 60 * S })).toBe('compacted after 12 min idle · /bell log')
  expect(compactedText({ before: 143985, after: 21400, idleMs: null })).toBe('compacted 144k → 21k tokens · /bell log')

  // The person's message at T0, the plugin's compaction twelve minutes later.
  const worked = decide(warm(), T0, { kind: 'turn-start', by: 'person' }, config).state
  expect(worked.workedAt).toBe(T0)
  const compacting = { ...worked, phase: 'COMPACTING' as const, anchorAt: T0 + 480 * S }
  const at = T0 + 720 * S
  // Claude Code's hook reports the compaction first, the plugin its own with the sizes after.
  const seen = decide(compacting, at, { kind: 'compacted' }, config).state
  expect(band(seen, at, config)).toBeNull()
  const done = decide(seen, at, { kind: 'compacted', own: { before: 143985, after: 21400 } }, config).state
  expect(done).toMatchObject({ phase: 'DORMANT', lastCompaction: { before: 143985, after: 21400, idleMs: 720 * S } })
  expect(band(done, at + 3600 * S, config)).toEqual({ text: 'h⣿ Cache Bell: compacted 144k → 21k tokens after 12 min idle · /bell log', tone: 'calm' })
  // A compaction somebody else ran afterwards leaves the line; any turn or a /clear takes it down.
  expect(decide(done, at + S, { kind: 'compacted' }, config).state.lastCompaction).not.toBeNull()
  for (const by of ['person', 'other', 'self'] as const) {
    expect(decide(done, at + S, { kind: 'turn-start', by }, config).state.lastCompaction).toBeNull()
  }
  expect(decide(done, at + S, { kind: 'cleared' }, config).state.lastCompaction).toBeNull()
  // One that ran inside a turn says nothing: the person is there.
  const inTurn = decide({ ...worked, phase: 'BUSY' as const }, at, { kind: 'compacted', own: { before: 1, after: 1 } }, config).state
  expect(inTurn.lastCompaction).toBeNull()
  // A state kept by a version without the line gets the fields.
  const { workedAt: _, lastCompaction: __, ...old } = warm()
  expect(decide(old as State, T0 + S, { kind: 'tick', gapMs: S }, config).state).toMatchObject({ workedAt: null, lastCompaction: null })
})

test('/bell status opens with the plugin\'s version, when the manifest states one', () => {
  expect(versionOf('{ "name": "cache-bell", "version": "0.1.0" }')).toBe('0.1.0')
  for (const manifest of ['{ "name": "cache-bell" }', '{ "version": 3 }', '{ "version": "" }', 'not json', '']) expect({ manifest, version: versionOf(manifest) }).toEqual({ manifest, version: undefined })
  const config = resolveConfig({})
  expect(statusReport(warm(), T0, config, { contextTokens: 1, version: '0.1.0' }).split('\n')[0]).toBe('version 0.1.0 · on, mode prepare-compact')
  expect(statusReport(warm(), T0, config, { contextTokens: 1 }).split('\n')[0]).toBe('on, mode prepare-compact')
  expect(statusReport(warm(), T0, resolveConfig({ enabled: false }), { contextTokens: 1, version: '0.1.0' }).split('\n')[0]).toBe('version 0.1.0 · off, mode prepare-compact')
})

test('a TTL that is only a guess is said in the band and in the report, with what follows from it', () => {
  const acting = resolveConfig({ mode: 'prepare-compact' })
  const guessed = warm({ contextTokens: 150000, isTtlUnread: true })
  // With an hour-long limit of the band a warm cache shows nothing; the guess is shown at any time.
  expect(band(guessed, T0 + 10 * S, acting)).toEqual({ text: `h⣿ Cache Bell: ${UNREAD}`, tone: 'calm' })
  const report = statusReport(guessed, T0 + 10 * S, acting, { contextTokens: 150000 })
  expect(report).toContain('Cache TTL: 5m (assumed: the transcript could not be read, it is tried again)')
  expect(report).toContain('Next: nothing is asked, renewed or compacted until the TTL is read')
  expect(report).not.toMatch(/asks in|renews in|cache lost in/)
  // A TTL that was read and a later read that failed: the plugin goes on with what it knows.
  const known = statusReport(warm({ contextTokens: 150000, isTtlUnread: true, ttlMs: TTL_1H, ttlSource: 'transcript' }), T0 + 10 * S, acting, { contextTokens: 150000 })
  expect(known).toContain('Cache TTL: 1h (read from the transcript)')
  expect(known).toMatch(/Next: asks in/)
})

test('the status report ends with what it is told of options set to a word they do not take', () => {
  const said = 'ttl is set to "10m", which is not one of auto, 5m, 1h; the default, auto, is used'
  expect(statusReport(warm(), T0, config, { contextTokens: 1, unknown: [said] }).split('\n').at(-1)).toBe(said)
  expect(statusReport(warm(), T0, config, { contextTokens: 1, unknown: [] })).not.toContain('is set to')
})
