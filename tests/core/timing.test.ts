import { expect, test } from 'claude-code/testing'

import { SLEEP_GAP_MS, TTL_1H, TTL_5M, autoLead, clamp, deadlines, offsets, parseTtl, ttlFromSettings } from '../../core/timing'

const S = 1000
const M = 60 * S

test('offsets from the anchor follow the TTL', () => {
  const table: [string, number, number, number, number][] = [
    // name, ttl, ask, act, max
    ['5 min', TTL_5M, 3 * M + 30 * S, 4 * M, 4 * M + 35 * S],
    // an hour-long cache is asked about a quarter of an hour ahead
    ['1 h', TTL_1H, 35 * M, 50 * M, 55 * M],
    // every margin at its lower bound: act = ttl - 60 s, ask = act - 30 s, max = ttl - 20 s
    ['2 min', 2 * M, 30 * S, 60 * S, 100 * S],
    // between the bounds the margins scale: ttl/6 = 5 min, ttl/12 = 2.5 min
    // from half an hour up the lead is a quarter of an hour, but never more than half of the time to act
    ['30 min', 30 * M, 12 * M + 30 * S, 25 * M, 27 * M + 30 * S],
    ['29 min', 29 * M, 24 * M + 10 * S - 145 * S, 24 * M + 10 * S, 29 * M - 145 * S],
    // every margin at its upper bound: act = ttl - 10 min, ask = act - 5 min, max = ttl - 5 min
    ['2 h', 120 * M, 95 * M, 110 * M, 115 * M],
  ]
  for (const [name, ttl, askMs, actMs, maxMs] of table) {
    expect({ name, ...offsets(ttl) }).toEqual({ name, askMs, actMs, maxMs })
  }
})

test('the order ask < act < max < ttl holds for every TTL', () => {
  for (const ttl of [2 * M, TTL_5M, 10 * M, 30 * M, TTL_1H, 120 * M]) {
    const { askMs, actMs, maxMs } = offsets(ttl)
    expect(askMs > 0 && askMs < actMs && actMs < maxMs && maxMs < ttl).toBe(true)
  }
})

test('the time to ask ahead can be set, but the question never comes in the first half', () => {
  const table: [string, number, number, number][] = [
    // name, ttl, lead set, ask
    ['automatic on an hour', TTL_1H, 0, 35 * M],
    ['five minutes ahead on an hour', TTL_1H, 5 * M, 45 * M],
    ['twenty minutes ahead on an hour', TTL_1H, 20 * M, 30 * M],
    ['half of the time to act is the most', TTL_1H, 25 * M, 25 * M],
    ['more than half is cut to half', TTL_1H, 40 * M, 25 * M],
    ['automatic on five minutes', TTL_5M, 0, 210 * S],
    ['one minute ahead on five minutes', TTL_5M, M, 180 * S],
    ['a quarter of an hour on five minutes is cut to half', TTL_5M, 15 * M, 120 * S],
  ]
  for (const [name, ttl, lead, askMs] of table) expect({ name, askMs: offsets(ttl, lead).askMs }).toEqual({ name, askMs })
  expect([autoLead(TTL_5M), autoLead(30 * M - 1), autoLead(30 * M), autoLead(TTL_1H)]).toEqual([30 * S, 150 * S - 1 / 12, 15 * M, 15 * M])
  expect(deadlines(0, TTL_1H, 5 * M).tAsk).toBe(45 * M)
})

test('deadlines are the offsets counted from the anchor', () => {
  const FROM = Date.UTC(2026, 0, 12, 9)
  expect(deadlines(FROM, TTL_5M)).toEqual({
    tAsk: FROM + 210 * S,
    tAct: FROM + 240 * S,
    tMax: FROM + 275 * S,
    expiresAt: FROM + 300 * S,
  })
})

test('clamp keeps a value inside its bounds', () => {
  expect([clamp(5, 10, 20), clamp(15, 10, 20), clamp(25, 10, 20), clamp(10, 10, 20), clamp(20, 10, 20)]).toEqual([10, 15, 20, 10, 20])
})

test('parseTtl reads only the two spellings Claude Code uses', () => {
  const table: [unknown, number | null][] = [
    ['5m', TTL_5M],
    ['1h', TTL_1H],
    ['auto', null],
    ['', null],
    [undefined, null],
    [300, null],
  ]
  for (const [value, ttl] of table) expect(parseTtl(value)).toBe(ttl)
})

test('ttlFromSettings follows the order Claude Code reads its settings in', () => {
  const table: [string, string | undefined, string | undefined, unknown, number | null][] = [
    // name, FORCE_PROMPT_CACHING_5M, CLAUDE_CODE_PROMPT_CACHE_TTL, promptCacheTtl, result
    ['nothing set', undefined, undefined, undefined, null],
    ['the setting alone', undefined, undefined, '1h', TTL_1H],
    ['the variable beats the setting', undefined, '5m', '1h', TTL_5M],
    ['the force flag beats both', '1', '1h', '1h', TTL_5M],
    ['a force flag of 0 is off', '0', '1h', undefined, TTL_1H],
    ['a force flag of false is off', 'False', undefined, '1h', TTL_1H],
    ['an empty force flag is off', '', undefined, '5m', TTL_5M],
    ['an unknown variable falls through to the setting', undefined, '30m', '1h', TTL_1H],
    ['an unknown setting is nothing', undefined, undefined, 'forever', null],
  ]
  for (const [name, force5m, envTtl, settingTtl, ttl] of table) {
    expect({ name, ttl: ttlFromSettings({ force5m, envTtl, settingTtl }) }).toEqual({ name, ttl })
  }
})

test('the sleep gap is far above one tick and far below the shortest TTL', () => {
  expect(SLEEP_GAP_MS).toBe(30 * S)
})
