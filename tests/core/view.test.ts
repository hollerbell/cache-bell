import { expect, test } from 'claude-code/testing'

import { decide, initialState } from '../../core/decide'
import { TTL_1H, TTL_5M } from '../../core/timing'
import type { State } from '../../core/types'
import { PALETTE, UNNAMED, UNREAD, UNSEEN, band, compactRowInput, compactedText, formatIdle, hourRow, introOf, formatLeft, formatCount, formatTtl, lookOf, resent, statusEntry, statusReport, versionOf } from '../../core/view'
import type { HourState } from '../../core/view'
import { COMPACT_ONLY, KEEP, NOTIFY, configOf } from './options'

const S = 1000
// A Monday morning: 2026-01-12 09:00 UTC.
const T0 = Date.UTC(2026, 0, 12, 9)

// The countdown is shown whatever time is left; when it shows has a test of its own.
const config = configOf({ displayBelowMinutes: 0 })
const state = (over: Partial<State> = {}): State => ({ ...initialState(config), ...over })
const warm = (over: Partial<State> = {}): State => state({ phase: 'WARM', anchorAt: T0, ttlSource: 'transcript', ...over })

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
    ['right after the request', warm(), T0, { text: 'h⣿ Cache Bell: prompt cache expires in 4:35', tone: 'calm' }],
    ['one millisecond before the question is due', warm(), T0 + 210 * S - 1, { text: 'h⣿ Cache Bell: prompt cache expires in 1:05', tone: 'calm' }],
    ['once the question is due', warm(), T0 + 210 * S, { text: 'h⣿ Cache Bell: prompt cache expires in 1:05', tone: 'warn' }],
    ['an hour-long cache', warm({ ttlMs: TTL_1H }), T0 + 60 * S, { text: 'h⣿ Cache Bell: prompt cache expires in 54 min', tone: 'calm' }],
    ['a TTL set in the options', warm({ ttlSource: 'config' }), T0, { text: 'h⣿ Cache Bell: prompt cache expires in 4:35', tone: 'calm' }],
    ['a TTL that is only a guess', warm({ ttlSource: 'default' }), T0, { text: `h⣿ Cache Bell: ${UNSEEN}`, tone: 'calm' }],
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
    const cfg = configOf(options)
    expect({ options, hasBand: band(warm(), T0, cfg) !== null, entry: statusEntry(warm(), T0, cfg) }).toEqual({ options, hasBand, entry })
  }
})

test('the status line entry follows the phase', () => {
  const both = configOf({ display: 'both' })
  expect(statusEntry(warm({ phase: 'COLD', coldReason: 'expired' }), T0, both)).toBe('cache cold')
  expect(statusEntry(state(), T0, both)).toBeUndefined()
  expect(statusEntry(state({ phase: 'BUSY' }), T0, both)).toBeUndefined()
  expect(statusEntry(state({ phase: 'DORMANT' }), T0, both)).toBeUndefined()
})

test('/bell status reports a warm cache', () => {
  const report = statusReport(warm({ ttlMs: 300 * S, ttlSource: 'transcript' }), T0 + 60 * S, configOf(NOTIFY), { contextTokens: 43985 })
  expect(report).toBe(
    [
      'on, bellcompact[off]',
      'When idle above 80K, Cache Bell asks what to do before the cache expires.',
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
    statusReport(warm({ contextTokens: 150000, ...over }), T0, configOf(options), { contextTokens: 150000 }).split('\n')[5] ?? ''
  const table: [string, Record<string, unknown>, Partial<State>, string][] = [
    ['the default asks and renews', {}, {}, 'Next: asks in 3:30, renews in 4:00, cache lost in 4:35'],
    ['its renewals used up, it asks and compacts', {}, { isAsked: true, renewals: 2 }, 'Next: asks in 3:30, compacts in 4:00, cache lost in 4:35'],
    ['asked once already', {}, { isAsked: true }, 'Next: renews in 4:00, cache lost in 4:35'],
    ['keep does not ask', KEEP, {}, 'Next: renews in 4:00, cache lost in 4:35'],
    ['compact-only does not ask either', COMPACT_ONLY, {}, 'Next: compacts in 4:00, cache lost in 4:35'],
    ['notify only asks', NOTIFY, {}, 'Next: asks in 3:30, cache lost in 4:35'],
    ['the person declined', {}, { isDeclined: true }, 'Next: nothing, cache lost in 4:35'],
    ['a small context', {}, { contextTokens: 5000 }, 'Next: nothing, cache lost in 4:35 (context below 80 000 tokens)'],
    ['a small context, switched off', { enabled: false }, { contextTokens: 5000 }, 'Next: nothing, cache lost in 4:35'],
  ]
  for (const [name, options, over, row] of table) expect({ name, row: rowOf(options, over) }).toEqual({ name, row })
})

test('/bell status before the first turn', () => {
  const report = statusReport(state(), T0, config, { contextTokens: undefined })
  expect(report).toBe(
    [
      'on, bellcompact[off]',
      'When idle above 80K, Cache Bell asks first, renews the cache up to 2 times, then compacts before it expires.',
      'State: unknown (no finished turn yet)',
      'Cache TTL: 5m (assumed, not yet seen in the data)',
      'Last request to the API: none seen',
      'Context: not known yet',
    ].join('\n'),
  )
})

test('/bell status says in one sentence under the top row what the options make the plugin do', () => {
  const said = (options: Record<string, unknown>, over: Partial<State> = {}): string =>
    statusReport(warm(over), T0, configOf(options), { contextTokens: 1 }).split('\n')[1] ?? ''
  const table: [Record<string, unknown>, Partial<State>, string][] = [
    [{ enabled: false }, {}, 'Cache Bell does nothing in this session.'],
    [{ profile: 'off' }, {}, 'Cache Bell does nothing in this session.'],
    [{ profile: 'watch' }, {}, 'Cache Bell only shows how long the cache lasts; it sends nothing and tells Claude nothing.'],
    [{}, {}, 'When idle above 80K, Cache Bell asks first, renews the cache up to 2 times, then compacts before it expires.'],
    [NOTIFY, {}, 'When idle above 80K, Cache Bell asks what to do before the cache expires.'],
    [{ ...NOTIFY, idleAsk: 'never' }, {}, 'Cache Bell shows how long the cache lasts and sends nothing on its own.'],
    [KEEP, {}, 'When idle above 80K, Cache Bell renews the cache up to 3 times.'],
    [COMPACT_ONLY, {}, 'When idle above 80K, Cache Bell compacts before it expires.'],
    [{ ...COMPACT_ONLY, idleCompact: 'auto', idleMinContextK: 120 }, {}, 'When idle above 120K, Cache Bell compacts before it expires (only with the hour-long cache).'],
    [{ compactLevelK: 150, ...COMPACT_ONLY }, {}, 'Past 150K Claude is asked to compact at a good moment; when idle above 80K, Cache Bell compacts before it expires.'],
    [{ compactLevelK: 150, ...NOTIFY, idleAsk: 'never' }, { levelTokens: 300000 }, 'Past 300K Claude is asked to compact at a good moment.'],
    [{ compactLevelK: 150, ...NOTIFY, idleAsk: 'never', compactOnRequest: 'off' }, {}, 'Cache Bell shows how long the cache lasts and sends nothing on its own.'],
  ]
  for (const [options, over, row] of table) expect({ options, row: said(options, over) }).toEqual({ options, row })
})

test('/bell status names a reason only for a cold cache', () => {
  const report = statusReport(warm({ coldReason: 'expired' }), T0, config, { contextTokens: 1 })
  expect(report).toMatch(/\nState: warm\n/)
})

test('/bell status names every phase and every source of the TTL', () => {
  const cold = statusReport(warm({ phase: 'COLD', coldReason: 'sleep', ttlSource: 'config' }), T0 + 900 * S, configOf({ enabled: false }), { contextTokens: 0 })
  expect(cold).toMatch(/^off, bellcompact\[off\]/)
  expect(cold).toMatch(/State: cold, expired while the machine slept\n/)
  expect(cold).toMatch(/Cache TTL: 5m \(set in the plugin options\)/)
  expect(cold).toMatch(/Last request to the API: 15 min ago\nContext: 0 tokens$/)

  expect(statusReport(state({ phase: 'BUSY', ttlSource: 'settings' }), T0, config, { contextTokens: 1 })).toMatch(
    /State: busy \(a turn is running\)\nCache TTL: 5m \(from the Claude Code settings, not yet confirmed by a response\)/,
  )
  expect(statusReport(state({ phase: 'DORMANT', ttlMs: TTL_1H, ttlSource: 'model-switch' }), T0, config, { contextTokens: 1 })).toMatch(
    /State: dormant \(compacted, waiting for new work\)\nCache TTL: 1h \(asked for at the model switch, not yet confirmed by a response\)/,
  )
})

test('/bell status tells how large the context is and how often the cache was renewed', () => {
  const sized = configOf({})
  const report = statusReport(warm({ renewals: 1 }), T0 + 60 * S, sized, { contextTokens: 120000 })
  expect(report).toMatch(/\nContext: 120 000 tokens\nRenewed 1 time of 2$/)
  expect(statusReport(warm({ isDeclined: true }), T0, sized, { contextTokens: 1 })).toMatch(/\nRenewed 0 times of 2, the cache will be left to expire$/)
  expect(statusReport(warm({ renewals: 3 }), T0, configOf(KEEP), { contextTokens: 1 })).toMatch(/\nRenewed 3 times of 3$/)
  // A number of renewals outside the range is said, with what is used instead.
  expect(statusReport(warm(), T0, configOf({ idleRenewals: 12 }), { contextTokens: 1 })).toMatch(/\nidleRenewals is set to 12, outside 0 to 3: 3 is used$/)
  expect(statusReport(warm(), T0, configOf({ idleRenewals: 3 }), { contextTokens: 1 })).not.toContain('idleRenewals')
  // A mode that only renews ends with the cache gone, and the band says after how many renewals.
  const spent = warm({ phase: 'COLD', coldReason: 'expired', renewals: 3, contextTokens: 143985 })
  expect(band(spent, T0, configOf(KEEP))?.text).toBe('h⣿ Cache Bell: prompt cache expired after 3 renewals · the next message re-sends 144k tokens uncached')
  expect(band({ ...spent, renewals: 1 }, T0, configOf({ idleRenewals: 1, idleCompact: 'off' }))?.text).toBe('h⣿ Cache Bell: prompt cache expired after 1 renewal · the next message re-sends 144k tokens uncached')
  expect(band({ ...spent, renewals: 1 }, T0, configOf({}))?.text).toBe('h⣿ Cache Bell: prompt cache expired · the next message re-sends 144k tokens uncached')
  expect(statusReport(warm(), T0, config, { contextTokens: 1 })).not.toMatch(/Renewed/)
})

test('the countdown of a warm cache shows only once the time left is down to the limit set', () => {
  const late = configOf({ displayBelowMinutes: 53, display: 'both' })
  const hour = warm({ ttlMs: TTL_1H })
  // On an hour-long cache 55 minutes are left at the start: hidden until 53 are.
  const table: [string, number, string | null, string | undefined][] = [
    ['at the start', T0, null, undefined],
    ['a second before the limit', T0 + 120 * S - 1, null, undefined],
    ['at the limit', T0 + 120 * S, 'h⣿ Cache Bell: prompt cache expires in 53 min', 'cache 53 min'],
    ['later', T0 + 600 * S, 'h⣿ Cache Bell: prompt cache expires in 45 min', 'cache 45 min'],
  ]
  for (const [name, now, text, entry] of table) {
    expect({ name, text: band(hour, now, late)?.text ?? null, entry: statusEntry(hour, now, late) }).toEqual({ name, text, entry })
  }
  // A five-minute cache never has that much left: always shown. So are a cold cache and the plugin at work.
  expect(band(warm(), T0, late)?.text).toBe('h⣿ Cache Bell: prompt cache expires in 4:35')
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
    [KEEP, ' while you are away this plugin acts on its own, on your plan', ['before the prompt cache expires it renews the prompt cache up to 3 times', 'Claude may ask for a compaction too: you get 30 s to cancel, or the time Claude names']],
    [{ ...COMPACT_ONLY, compactOnRequest: 'off' }, ' while you are away this plugin acts on its own, on your plan', ['before the prompt cache expires it compacts the conversation']],
    [{ ...NOTIFY, compactCountdown: 30 }, ' this plugin can compact the conversation without you', ['Claude may ask for a compaction too: you get 30 s to cancel, or the time Claude names']],
    [{ ...NOTIFY, compactOnRequest: 'auto' }, ' this plugin can compact the conversation without you', ['Claude may ask for a compaction too, and gets it at once']],
    // Nothing happens without the person, or the plugin is off: nothing to tell.
    [{ ...NOTIFY, compactOnRequest: 'off' }, null, []],
    [{ enabled: false }, null, []],
  ]
  for (const [options, head, rows] of table) {
    const told = introOf(configOf(options))
    expect({ options, head: told?.head ?? null, rows: told?.rows ?? [] }).toEqual({ options, head, rows })
  }
  // idleCompact auto: the notice says the compaction comes only with the hour-long cache.
  expect(JSON.stringify(introOf(configOf({ idleCompact: 'auto' })))).toContain('compacts the conversation (with the hour-long cache only)')
  expect(JSON.stringify(introOf(configOf({ idleCompact: 'on' })))).not.toContain('hour-long cache only')
  expect(introOf(configOf({}))?.once).toBe('this notice is shown once: OK or your next message puts it away for good')
  expect(introOf(configOf({}))?.hint).toBe('change it in /config: cache-bell.profile, cache-bell.compactOnRequest, cache-bell.enabled')
})

test('the notice tells what is new since 0.2.x, as a whole sentence with or without the countdown, and the price where it asks about the hour', () => {
  const upgradeRow = (options: Record<string, unknown>): string | undefined =>
    introOf(configOf({ compactLevelK: 200, ...options }), false, true)?.rows.find(row => row.startsWith('new in 0.3.4: '))
  expect(upgradeRow({})).toBe('new in 0.3.4: by default, Claude now compacts by itself once the context passes 200K, after a finished piece of work, with a countdown to cancel. For warnings only, set cache-bell.profile to watch; the CHANGELOG has the details')
  for (const compactOnRequest of ['auto', 'wait']) {
    expect(upgradeRow({ compactOnRequest })).toBe('new in 0.3.4: by default, Claude now compacts by itself once the context passes 200K, after a finished piece of work. For warnings only, set cache-bell.profile to watch; the CHANGELOG has the details')
  }
  // Where Claude may not ask, or there is no level, nothing of it is new.
  expect(upgradeRow({ compactOnRequest: 'off' })).toBeUndefined()
  expect(upgradeRow({ compactLevelK: 0 })).toBeUndefined()
  const price = 'on the API, writing to an hour-long cache costs twice the base input price, against 1.25 times for a five-minute one; reading costs the same for both. How this counts toward Pro, Max or Team limits is not published'
  expect(introOf(configOf({}), true)?.rows).toContain(price)
  expect(introOf(configOf({}))?.rows).not.toContain(price)
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
  const cold = { ...initialState(configOf({})), phase: 'COLD' as const, coldReason: 'expired' as const, anchorAt: T0 }
  expect(band({ ...cold, contextTokens: 87300 }, T0, configOf({}))?.text).toBe('h⣿ Cache Bell: prompt cache expired · the next message re-sends 87k tokens uncached')
  expect(band(cold, T0, configOf({}))?.text).toBe('h⣿ Cache Bell: prompt cache expired · the next message re-sends the whole context')
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
  const config = configOf({})
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
  const config = configOf({})
  expect(statusReport(warm(), T0, config, { contextTokens: 1, version: '0.1.0' }).split('\n')[0]).toBe('version 0.1.0 · on, bellcompact[off]')
  expect(statusReport(warm(), T0, config, { contextTokens: 1 }).split('\n')[0]).toBe('on, bellcompact[off]')
  expect(statusReport(warm(), T0, configOf({ enabled: false }), { contextTokens: 1, version: '0.1.0' }).split('\n')[0]).toBe('version 0.1.0 · off, bellcompact[off]')
})

test('/bell status says where the hour-long cache stands, and warns when the API did not grant it', () => {
  const head = 'Hour-long cache:'
  const table: [HourState, Partial<State>, string | null][] = [
    [null, {}, null],
    ['waiting', {}, `${head} on, asked for at the next moment the cache is cold anyway`],
    ['own-ttl', {}, `${head} on, but a TTL of your own is set; nothing is asked for`],
    ['taking-back', {}, `${head} off, the hour asked for earlier goes with the next request`],
    ['asked', { ttlMs: TTL_1H, ttlSource: 'requested' }, `${head} asked for, not yet confirmed by a response`],
    ['asked', { ttlMs: TTL_1H, ttlSource: 'transcript' }, `${head} asked for and granted`],
    ['asked', { ttlMs: TTL_5M, ttlSource: 'transcript' }, `⚠ ${head} asked for, but the API granted only 5 minutes; the plugin times the cache on 5 minutes`],
  ]
  for (const [hour, over, row] of table) {
    expect(hourRow(warm(over), hour)).toBe(row)
    const rows = statusReport(warm(over), T0, config, { contextTokens: 1, hour }).split('\n')
    expect(rows.filter(line => line.includes(head))).toEqual(row === null ? [] : [row])
  }
})

test('a TTL that is only a guess is said in the band and in the report, with what follows from it', () => {
  const acting = configOf({})
  const guessed = warm({ contextTokens: 150000, ttlSource: 'default', isTtlUnread: true })
  // With an hour-long limit of the band a warm cache shows nothing; the guess is shown at any time.
  expect(band(guessed, T0 + 10 * S, acting)).toEqual({ text: `h⣿ Cache Bell: ${UNREAD}`, tone: 'calm' })
  const report = statusReport(guessed, T0 + 10 * S, acting, { contextTokens: 150000 })
  expect(report).toContain('Cache TTL: 5m (assumed: the transcript could not be read, it is tried again)')
  expect(report).toContain('Next: nothing is asked, renewed or compacted until the TTL is read')
  expect(report).not.toMatch(/asks in|renews in|cache lost in/)
  // What the settings or a model switch named is only what was asked for: a guess too, until a response shows it.
  const hinted = warm({ contextTokens: 150000, ttlSource: 'settings', ttlMs: TTL_1H })
  expect(band(hinted, T0 + 10 * S, acting)).toEqual({ text: `h⣿ Cache Bell: ${UNSEEN}`, tone: 'calm' })
  const hintedReport = statusReport(hinted, T0 + 10 * S, acting, { contextTokens: 150000 })
  expect(hintedReport).toContain('Cache TTL: 1h (from the Claude Code settings, not yet confirmed by a response)')
  expect(hintedReport).toContain('Next: nothing is asked, renewed or compacted until a response shows the TTL')
  // The default is five minutes, a compaction waits for the hour: the report says both.
  const waitsOnDefault = warm({ contextTokens: 150000, ttlSource: 'default', held: { by: 'typing', isTold: true } })
  expect(statusReport(waitsOnDefault, T0 + 10 * S, acting, { contextTokens: 150000 }))
    .toContain('Cache TTL: 5m (assumed, not yet seen in the data), a waiting compaction counts on 1h until the TTL is known')
  expect(statusReport(warm({ contextTokens: 150000, ttlSource: 'default' }), T0 + 10 * S, acting, { contextTokens: 150000 })).not.toContain('a waiting compaction counts on')
  // The status line counts no hour down as a fact behind a guess.
  const status = configOf({ display: 'status', displayBelowMinutes: 0 })
  expect(statusEntry(hinted, T0 + 10 * S, status)).toBe('cache lifetime unknown')
  expect(statusEntry(warm({ contextTokens: 150000, ttlSource: 'default' }), T0 + 10 * S, status)).toBe('cache lifetime unknown')
  expect(band(warm({ contextTokens: 150000, ttlSource: 'model-switch' }), T0 + 10 * S, acting)).toEqual({ text: `h⣿ Cache Bell: ${UNSEEN}`, tone: 'calm' })
  expect(band(warm({ contextTokens: 150000, ttlSource: 'default' }), T0 + 10 * S, acting)).toEqual({ text: `h⣿ Cache Bell: ${UNSEEN}`, tone: 'calm' })
  // A compaction that waits behind a guess counts down to the hour the guess is given, and says it is assumed,
  // whatever named the guess; the report counts to the same hour.
  const waiting = warm({ contextTokens: 150000, ttlSource: 'settings', held: { by: 'typing', isTold: true } })
  expect(band(waiting, T0 + 10 * S, acting)?.text).toBe('h⣿ Cache Bell: prompt cache expires in 54 min · lifetime 1h assumed, not yet seen in the data · compaction waits for you to finish typing')
  expect(statusReport(waiting, T0 + 10 * S, acting, { contextTokens: 150000 })).not.toMatch(/in 4:\d\d/)
  expect(statusEntry(waiting, T0 + 10 * S, configOf({ display: 'status' }))).toBe('cache 54 min')
  // With reading the transcript switched off nothing will show it: the band says how to name it.
  const blind = configOf({ cacheTtl: 'settings' })
  expect(band(warm({ contextTokens: 150000, ttlSource: 'default' }), T0 + 10 * S, blind)).toEqual({ text: `h⣿ Cache Bell: ${UNNAMED}`, tone: 'calm' })
  expect(band(warm({ contextTokens: 150000, ttlSource: 'settings', ttlMs: TTL_1H }), T0 + 10 * S, blind)).toEqual({ text: `h⣿ Cache Bell: ${UNNAMED}`, tone: 'calm' })
  expect(statusReport(warm({ contextTokens: 150000, ttlSource: 'default' }), T0 + 10 * S, blind, { contextTokens: 150000 }))
    .toContain('Next: nothing is asked, renewed or compacted until you set the cacheTtl option')
  // A TTL set in the options is no guess: the countdown, with no word of an assumption.
  const byHand = { ...configOf({ cacheTtl: '5m', displayBelowMinutes: 0 }), readTranscript: false }
  expect(band(warm({ contextTokens: 150000, ttlSource: 'config' }), T0 + 10 * S, byHand)?.text).toBe('h⣿ Cache Bell: prompt cache expires in 4:25')
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

test('the row of a compact call shows the reason alone, cut to what is left of the line', () => {
  const long = 'The work on the review is done and its fixes are pushed, so the conversation can be compacted now.'
  // `● cache-bell - compact (MCP)(reason: "")` takes 40 columns, one more stays free.
  expect(compactRowInput({ reason: 'Done.', resumeWith: 'x'.repeat(2000), countdown: 30 }, 80)).toEqual({ reason: 'Done.' })
  const cut = compactRowInput({ reason: long }, 80).reason as string
  expect(cut).toBe(`${long.slice(0, 38)}…`)
  expect(cut.length).toBe(39)
  // A reason over several lines is one line; a narrow window still leaves 12 characters.
  expect(compactRowInput({ reason: 'One.\n  Two.' }, 80)).toEqual({ reason: 'One. Two.' })
  expect((compactRowInput({ reason: long }, 20).reason as string).length).toBe(12)
  expect(compactRowInput({ cancel: true, reason: 'no' }, 80)).toEqual({ cancel: true })
  expect(compactRowInput({ userAsked: true }, 80)).toEqual({})
  expect(compactRowInput(undefined, 80)).toEqual({})
})
