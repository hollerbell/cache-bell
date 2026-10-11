import { expect, test } from 'claude-code/testing'

import { DEFAULT_COMPACT_INSTRUCTIONS, DEFAULT_PING_PROMPT, DEFAULT_PREPARE_PROMPT, OPTION_DEFAULTS, WORDS, resolveConfig, unknownWords } from '../../core/config'
import { TTL_1H, TTL_5M } from '../../core/timing'

test('with no options the plugin runs the bellcompact profile', () => {
  expect(resolveConfig({})).toEqual({
    enabled: true,
    profile: 'bellcompact',
    ask: 'first',
    maxRenewals: 2,
    maxRenewalsAsked: null,
    prepareBeforeCompact: true,
    compact: true,
    compactHourOnly: true,
    preparePrompt: DEFAULT_PREPARE_PROMPT,
    pingPrompt: DEFAULT_PING_PROMPT,
    compactInstructions: DEFAULT_COMPACT_INSTRUCTIONS,
    ttlMs: null,
    minContextTokens: 80000,
    compactAtTokens: 200000,
    contextNotices: true,
    compactCountdownMs: 30000,
    askLeadMs: 0,
    sessionCompact: 'confirm',
    display: 'status',
    showBelowMs: 900000,
    readTranscript: true,
    requestHour: 'ask',
  })
})

test('the watch profile sends nothing and tells the session nothing, whatever the other options say', () => {
  const options = { profile: 'watch', idleAsk: 'every', idleRenewals: 3, idleAnnounce: true, idleCompact: 'on', compactLevelK: 150, compactContextNotices: true, compactOnRequest: 'auto' }
  expect(resolveConfig(options)).toMatchObject({
    enabled: true, profile: 'watch', ask: 'never', maxRenewals: 0, prepareBeforeCompact: false,
    compact: false, compactAtTokens: 0, contextNotices: false, sessionCompact: 'off',
  })
  // What it shows stays the person's.
  expect(resolveConfig({ profile: 'watch', display: 'both', displayBelowMinutes: 5 })).toMatchObject({ display: 'both', showBelowMs: 300000 })
})

test('switched off, by the switch or by the profile, the plugin is off whatever else is set', () => {
  expect(resolveConfig({ enabled: false })).toMatchObject({ enabled: false, profile: 'bellcompact' })
  expect(resolveConfig({ profile: 'off' })).toMatchObject({ enabled: false, profile: 'off' })
  expect(resolveConfig({ enabled: false, profile: 'watch' })).toMatchObject({ enabled: false })
})

test('the mode of 0.2.x is taken over where the new options hold their defaults', () => {
  const table: [string, object][] = [
    ['notify', { profile: 'watch', maxRenewals: 0, compact: false }],
    ['keep', { profile: 'bellcompact', compactAtTokens: 0, compact: false, ask: 'never', maxRenewals: 3, prepareBeforeCompact: true }],
    ['prepare-compact', resolveConfig({})],
    ['compact-only', { profile: 'bellcompact', ask: 'never', maxRenewals: 0, prepareBeforeCompact: false, compact: true, compactHourOnly: false, compactAtTokens: 200000 }],
    // the custom mode read options that are gone: it stands for nothing
    ['custom', resolveConfig({})],
    ['turbo', resolveConfig({})],
    ['constructor', resolveConfig({})],
  ]
  for (const [mode, fields] of table) {
    expect({ mode, got: resolveConfig({ ...OPTION_DEFAULTS, mode }) }).toMatchObject({ mode, got: fields })
    // Also where Claude Code filled in no defaults.
    expect({ mode, got: resolveConfig({ mode }) }).toMatchObject({ mode, got: fields })
  }
  // A new option set by the person wins over the mode.
  expect(resolveConfig({ mode: 'notify', profile: 'off' })).toMatchObject({ profile: 'off', enabled: false })
  expect(resolveConfig({ mode: 'keep', compactLevelK: 150, idleCompact: 'on' })).toMatchObject({ compactAtTokens: 150000, compact: true, compactHourOnly: false })
  expect(resolveConfig({ mode: 'compact-only', idleRenewals: 1, idleAnnounce: false })).toMatchObject({ maxRenewals: 1, prepareBeforeCompact: false })
  expect(resolveConfig({ mode: 'keep', idleAsk: 'every', idleRenewals: 1 })).toMatchObject({ ask: 'every', maxRenewals: 1 })
})

test('idleCompact compacts an idle session always, never, or only while its cache lives an hour', () => {
  expect(resolveConfig({ idleCompact: 'auto' })).toMatchObject({ compact: true, compactHourOnly: true })
  expect(resolveConfig({ idleCompact: 'on' })).toMatchObject({ compact: true, compactHourOnly: false })
  expect(resolveConfig({ idleCompact: 'off' })).toMatchObject({ compact: false, compactHourOnly: false })
})

test('a value that makes no sense falls back to its default', () => {
  const table: [string, Record<string, unknown>, object][] = [
    ['an unknown profile', { profile: 'turbo' }, { profile: 'bellcompact', maxRenewals: 2 }],
    ['enabled as text', { enabled: 'no' }, { enabled: true }],
    ['switched off', { enabled: false }, { enabled: false }],
    ['ttl 5m', { cacheTtl: '5m' }, { ttlMs: TTL_5M }],
    ['ttl 1h', { cacheTtl: '1h' }, { ttlMs: TTL_1H }],
    ['ttl auto', { cacheTtl: 'auto' }, { ttlMs: null, readTranscript: true }],
    ['ttl from the settings only, the transcript unread', { cacheTtl: 'settings' }, { ttlMs: null, readTranscript: false }],
    ['ttl by hand, the transcript still read', { cacheTtl: '5m' }, { ttlMs: TTL_5M, readTranscript: true }],
    ['an unknown ttl', { cacheTtl: '30m' }, { ttlMs: null }],
    ['no renewals', { idleRenewals: 0 }, { maxRenewals: 0, maxRenewalsAsked: null }],
    ['renewals at the cap', { idleRenewals: 3 }, { maxRenewals: 3, maxRenewalsAsked: null }],
    // a number outside 0 to 3 is taken to the nearer end, and what was asked for is remembered
    ['a negative number is none', { idleRenewals: -1 }, { maxRenewals: 0, maxRenewalsAsked: -1 }],
    ['renewals above the cap', { idleRenewals: 4 }, { maxRenewals: 3, maxRenewalsAsked: 4 }],
    ['renewals far above the cap', { idleRenewals: 1001 }, { maxRenewals: 3, maxRenewalsAsked: 1001 }],
    ['a fraction of a renewal', { idleRenewals: 1.5 }, { maxRenewals: 2 }],
    ['renewals as text', { idleRenewals: '3' }, { maxRenewals: 2 }],
    ['a switch that is not a switch', { idleAnnounce: 'yes', compactContextNotices: 1 }, { prepareBeforeCompact: true, contextNotices: true }],
    ['an unknown ask', { idleAsk: 'sometimes' }, { ask: 'first' }],
    ['an unknown idle compaction', { idleCompact: 'maybe' }, { compact: true, compactHourOnly: true }],
    ['a context floor of zero', { idleMinContextK: 0 }, { minContextTokens: 0 }],
    ['a negative context floor', { idleMinContextK: -1 }, { minContextTokens: 80000 }],
    ['the largest context floor', { idleMinContextK: 10000 }, { minContextTokens: 10000000 }],
    ['a context floor above the bound', { idleMinContextK: 10001 }, { minContextTokens: 80000 }],
    ['no compaction level', { compactLevelK: 0 }, { compactAtTokens: 0 }],
    ['a level of 150K', { compactLevelK: 150 }, { compactAtTokens: 150000 }],
    ['a level that is not whole', { compactLevelK: 150.5 }, { compactAtTokens: 200000 }],
    ['a countdown of a minute', { compactCountdown: 60 }, { compactCountdownMs: 60000 }],
    ['the shortest countdown', { compactCountdown: 5 }, { compactCountdownMs: 5000 }],
    ['a countdown too short', { compactCountdown: 4 }, { compactCountdownMs: 30000 }],
    ['the longest countdown', { compactCountdown: 3600 }, { compactCountdownMs: 3600000 }],
    ['a countdown too long', { compactCountdown: 3601 }, { compactCountdownMs: 30000 }],
    ['ask ten minutes ahead', { idleAskAheadMinutes: 10 }, { askLeadMs: 600000 }],
    ['a negative lead', { idleAskAheadMinutes: -1 }, { askLeadMs: 0 }],
    ['the longest lead', { idleAskAheadMinutes: 600 }, { askLeadMs: 36000000 }],
    ['a lead too long', { idleAskAheadMinutes: 601 }, { askLeadMs: 0 }],
    ['show the countdown in the last 53 minutes', { displayBelowMinutes: 53 }, { showBelowMs: 3180000 }],
    ['a negative limit for showing', { displayBelowMinutes: -1 }, { showBelowMs: 900000 }],
    ['a limit for showing above the bound', { displayBelowMinutes: 601 }, { showBelowMs: 900000 }],
    ['always shown', { displayBelowMinutes: 0 }, { showBelowMs: 0 }],
    ['a session may compact at once', { compactOnRequest: 'auto' }, { sessionCompact: 'auto' }],
    ['a session may not ask', { compactOnRequest: 'off' }, { sessionCompact: 'off' }],
    ['a session waits for the person', { compactOnRequest: 'wait' }, { sessionCompact: 'wait' }],
    ['an unknown answer to a session', { compactOnRequest: 'maybe' }, { sessionCompact: 'confirm' }],
    ['an unknown display', { display: 'popup' }, { display: 'status' }],
    ['the band only', { display: 'band' }, { display: 'band' }],
    ['the hour always', { cacheRequestHour: 'on' }, { requestHour: 'on' }],
    ['an unknown hour', { cacheRequestHour: 'yes' }, { requestHour: 'ask' }],
    ['an empty prompt switches the announcement off', { idleAnnouncePrompt: '' }, { preparePrompt: '' }],
    ['a prompt that is not text', { idleAnnouncePrompt: 7 }, { preparePrompt: DEFAULT_PREPARE_PROMPT }],
    ['an own ping prompt', { idleRenewPrompt: 'ok?' }, { pingPrompt: 'ok?' }],
    ['empty compaction instructions', { compactInstructions: '' }, { compactInstructions: '' }],
    // the options of 0.2.x other than mode and enabled are not taken over
    ['an option of 0.2.x', { ttl: '1h', maxRenewals: 0, showBelowMinutes: 1, sessionCompact: 'off' }, { ttlMs: null, maxRenewals: 2, showBelowMs: 900000, sessionCompact: 'confirm' }],
  ]
  for (const [name, options, fields] of table) {
    const config = resolveConfig(options) as unknown as Record<string, unknown>
    const got = Object.fromEntries(Object.keys(fields).map(key => [key, config[key]]))
    expect({ name, got }).toEqual({ name, got: fields })
  }
})

test('the table of defaults is what the configuration resolves to with nothing set', () => {
  expect(resolveConfig(OPTION_DEFAULTS)).toEqual(resolveConfig({}))
  // Each of them is really read: another value changes what is resolved.
  const other: Record<string, unknown> = {
    enabled: false, profile: 'watch', compactLevelK: 300, compactContextNotices: false, compactOnRequest: 'off', compactCountdown: 77,
    compactInstructions: 'z', idleMinContextK: 5, idleAsk: 'never', idleAskAheadMinutes: 9, idleRenewals: 1,
    idleRenewPrompt: 'y', idleCompact: 'on', idleAnnounce: false, idleAnnouncePrompt: 'x', cacheTtl: '1h',
    cacheRequestHour: 'on', display: 'off', displayBelowMinutes: 7,
  }
  expect(Object.keys(other).sort()).toEqual(Object.keys(OPTION_DEFAULTS).sort())
  for (const name of Object.keys(OPTION_DEFAULTS)) {
    const changed = resolveConfig({ ...OPTION_DEFAULTS, [name]: other[name] })
    expect({ name, same: JSON.stringify(changed) === JSON.stringify(resolveConfig(OPTION_DEFAULTS)) }).toEqual({ name, same: false })
  }
})

test('an option set to a word it does not take is named, with the words it takes and the default used', () => {
  expect(unknownWords({})).toEqual([])
  expect(unknownWords(OPTION_DEFAULTS)).toEqual([])
  expect(unknownWords({ profile: 'Watch', compactOnRequest: 'confirm', display: 7 })).toEqual([
    'profile is set to "Watch", which is not one of off, watch, bellcompact; the default, bellcompact, is used',
    'display is set to 7, which is not one of band, status, both, off; the default, status, is used',
  ])
  // 0.2.x's mode is only taken over: a word it never took is no mistake of the new options.
  expect(unknownWords({ mode: 'Keep' })).toEqual([])
  // Every word the table names is taken as it is, and the default of each option is one of its words.
  for (const [name, words] of Object.entries(WORDS)) {
    for (const word of words) expect({ name, word, said: unknownWords({ [name]: word }) }).toEqual({ name, word, said: [] })
    expect({ name, has: (words as readonly unknown[]).includes(OPTION_DEFAULTS[name]) }).toEqual({ name, has: true })
  }
})
