import { expect, test } from 'claude-code/testing'

import { DEFAULT_COMPACT_INSTRUCTIONS, DEFAULT_PING_PROMPT, DEFAULT_PREPARE_PROMPT, OPTION_DEFAULTS, resetReport, resolveConfig } from '../../core/config'
import { TTL_1H, TTL_5M } from '../../core/timing'

test('with no options the plugin runs the prepare-compact preset', () => {
  expect(resolveConfig({})).toEqual({
    enabled: true,
    mode: 'prepare-compact',
    ask: 'first',
    maxRenewals: 2,
    maxRenewalsAsked: null,
    renewMethod: 'fork',
    prepareBeforeCompact: true,
    compact: true,
    preparePrompt: DEFAULT_PREPARE_PROMPT,
    pingPrompt: DEFAULT_PING_PROMPT,
    compactInstructions: DEFAULT_COMPACT_INSTRUCTIONS,
    ttlMs: null,
    minContextTokens: 100000,
    compactCountdownMs: 30000,
    askLeadMs: 0,
    sessionCompact: 'confirm',
    display: 'band',
    showBelowMs: 1800000,
    readTranscript: true,
  })
})

test('each preset sets the five behaviour options and ignores the custom ones', () => {
  const custom = { ask: 'every', maxRenewals: 1, renewMethod: 'none', prepareBeforeCompact: false, compact: false }
  const table: [string, object][] = [
    ['notify', { ask: 'first', maxRenewals: 0, renewMethod: 'none', prepareBeforeCompact: false, compact: false }],
    ['keep', { ask: 'never', maxRenewals: 3, renewMethod: 'fork', prepareBeforeCompact: false, compact: false }],
    ['prepare-compact', { ask: 'first', maxRenewals: 2, renewMethod: 'fork', prepareBeforeCompact: true, compact: true }],
    ['compact-only', { ask: 'never', maxRenewals: 0, renewMethod: 'none', prepareBeforeCompact: false, compact: true }],
    ['custom', custom],
  ]
  for (const [mode, behaviour] of table) {
    expect(resolveConfig({ ...custom, mode })).toMatchObject({ mode, ...behaviour })
  }
})

test('a value that makes no sense falls back to its default', () => {
  const table: [string, Record<string, unknown>, object][] = [
    ['an unknown mode', { mode: 'turbo' }, { mode: 'prepare-compact', maxRenewals: 2 }],
    ['enabled as text', { enabled: 'no' }, { enabled: true }],
    ['switched off', { enabled: false }, { enabled: false }],
    ['ttl 5m', { ttl: '5m' }, { ttlMs: TTL_5M }],
    ['ttl 1h', { ttl: '1h' }, { ttlMs: TTL_1H }],
    ['ttl auto', { ttl: 'auto' }, { ttlMs: null }],
    ['an unknown ttl', { ttl: '30m' }, { ttlMs: null }],
    ['no renewals', { mode: 'custom', maxRenewals: 0 }, { maxRenewals: 0, maxRenewalsAsked: null }],
    ['renewals at the cap', { mode: 'custom', maxRenewals: 3 }, { maxRenewals: 3, maxRenewalsAsked: null }],
    // a number outside 0 to 3 is taken to the nearer end, and what was asked for is remembered
    ['what used to mean no limit is the cap now', { mode: 'custom', maxRenewals: -1 }, { maxRenewals: 3, maxRenewalsAsked: -1 }],
    ['any other negative number is none', { mode: 'custom', maxRenewals: -2 }, { maxRenewals: 0, maxRenewalsAsked: -2 }],
    ['renewals above the cap', { mode: 'custom', maxRenewals: 4 }, { maxRenewals: 3, maxRenewalsAsked: 4 }],
    ['renewals far above the cap', { mode: 'custom', maxRenewals: 1001 }, { maxRenewals: 3, maxRenewalsAsked: 1001 }],
    ['a preset ignores the number', { mode: 'keep', maxRenewals: 99 }, { maxRenewals: 3, maxRenewalsAsked: null }],
    ['a fraction of a renewal', { mode: 'custom', maxRenewals: 1.5 }, { maxRenewals: 2 }],
    ['renewals as text', { mode: 'custom', maxRenewals: '3' }, { maxRenewals: 2 }],
    ['custom mode with nothing set', { mode: 'custom' }, { ask: 'first', maxRenewals: 2, renewMethod: 'fork', prepareBeforeCompact: true, compact: true }],
    ['custom mode with switches that are not switches', { mode: 'custom', prepareBeforeCompact: 'yes', compact: 1 }, { prepareBeforeCompact: true, compact: true }],
    ['an unknown ask', { mode: 'custom', ask: 'sometimes' }, { ask: 'first' }],
    ['an unknown renewal method', { mode: 'custom', renewMethod: 'ping' }, { renewMethod: 'fork' }],
    ['a context floor of zero', { minContextTokens: 0 }, { minContextTokens: 0 }],
    ['a negative context floor', { minContextTokens: -1 }, { minContextTokens: 100000 }],
    ['a countdown of a minute', { compactCountdown: 60 }, { compactCountdownMs: 60000 }],
    ['the shortest countdown', { compactCountdown: 5 }, { compactCountdownMs: 5000 }],
    ['a countdown too short', { compactCountdown: 4 }, { compactCountdownMs: 30000 }],
    ['the longest countdown', { compactCountdown: 3600 }, { compactCountdownMs: 3600000 }],
    ['a countdown too long', { compactCountdown: 3601 }, { compactCountdownMs: 30000 }],
    ['ask ten minutes ahead', { askLeadMinutes: 10 }, { askLeadMs: 600000 }],
    ['a negative lead', { askLeadMinutes: -1 }, { askLeadMs: 0 }],
    ['the longest lead', { askLeadMinutes: 600 }, { askLeadMs: 36000000 }],
    ['a lead too long', { askLeadMinutes: 601 }, { askLeadMs: 0 }],
    ['the largest context floor', { minContextTokens: 10000000 }, { minContextTokens: 10000000 }],
    ['a context floor above the bound', { minContextTokens: 10000001 }, { minContextTokens: 100000 }],
    ['show the countdown in the last 53 minutes', { showBelowMinutes: 53 }, { showBelowMs: 3180000 }],
    ['a negative limit for showing', { showBelowMinutes: -1 }, { showBelowMs: 1800000 }],
    ['a limit for showing above the bound', { showBelowMinutes: 601 }, { showBelowMs: 1800000 }],
    ['always shown', { showBelowMinutes: 0 }, { showBelowMs: 0 }],
    ['a session may compact at once', { sessionCompact: 'auto' }, { sessionCompact: 'auto' }],
    ['a session may not ask', { sessionCompact: 'off' }, { sessionCompact: 'off' }],
    ['a session waits for the person', { sessionCompact: 'wait' }, { sessionCompact: 'wait' }],
    ['an unknown answer to a session', { sessionCompact: 'maybe' }, { sessionCompact: 'confirm' }],
    ['an unknown display', { display: 'popup' }, { display: 'band' }],
    ['the status line only', { display: 'status' }, { display: 'status' }],
    ['an empty prompt switches the announcement off', { preparePrompt: '' }, { preparePrompt: '' }],
    ['a prompt that is not text', { preparePrompt: 7 }, { preparePrompt: DEFAULT_PREPARE_PROMPT }],
    ['an own ping prompt', { pingPrompt: 'ok?' }, { pingPrompt: 'ok?' }],
    ['empty compaction instructions', { compactInstructions: '' }, { compactInstructions: '' }],
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
  const other: Record<string, unknown> = { enabled: false, mode: 'custom', ask: 'never', maxRenewals: 1, renewMethod: 'none', prepareBeforeCompact: false, compact: false, preparePrompt: 'x', pingPrompt: 'y', compactInstructions: 'z', ttl: '1h', minContextTokens: 5, compactCountdown: 77, sessionCompact: 'off', askLeadMinutes: 9, display: 'off', showBelowMinutes: 7, readTranscript: false }
  expect(Object.keys(other).sort()).toEqual(Object.keys(OPTION_DEFAULTS).sort())
  for (const name of Object.keys(OPTION_DEFAULTS)) {
    const changed = resolveConfig({ ...OPTION_DEFAULTS, mode: 'custom', [name]: other[name] })
    expect({ name, same: JSON.stringify(changed) === JSON.stringify(resolveConfig({ ...OPTION_DEFAULTS, mode: 'custom' })) }).toEqual({ name, same: name === 'mode' })
  }
})

test('a reset says what it put back and what it could not', () => {
  expect(resetReport([], [])).toBe('Every option already has its default.')
  expect(resetReport(['mode', 'ttl'], [])).toBe('Put back to the default: mode, ttl.')
  expect(resetReport([], ['ttl'])).toBe('Not changed, Claude Code refused: ttl.')
})
