import { expect, test } from 'claude-code/testing'

import { initialState } from '../../core/decide'
import { REPORT_HEAD, digestOf, errorCode, noticeHead, problemReport } from '../../core/report'
import type { ReportFacts } from '../../core/report'
import { TTL_1H } from '../../core/timing'
import type { State } from '../../core/types'
import { NOTIFY, configOf } from './options'

const T0 = Date.UTC(2026, 0, 12, 9)

const row = (usage: unknown, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ type: 'assistant', isSidechain: false, version: '2.1.292', message: { role: 'assistant', model: 'claude-test-1', content: [{ type: 'text', text: 'a secret said aloud' }], usage }, ...extra })

const USAGE = {
  input_tokens: 2,
  cache_creation_input_tokens: 5287,
  cache_read_input_tokens: 91285,
  cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 5287 },
  output_tokens: 120,
  service_tier: 'standard',
  server_tool_use: { web_search_requests: 0, nested: { deeper: 1 } },
}

test('the end of a transcript is digested to counts, the last usage as numbers, the model and the version', () => {
  const text = [row({ input_tokens: 1 }), 'half a li', JSON.stringify({ type: 'user', message: { content: 'hi' } }), row({ input_tokens: 9 }, { isSidechain: true }), row(USAGE)].join('\n')
  expect(digestOf(text)).toEqual({
    responses: 2,
    usage:
      'input_tokens=2 cache_creation_input_tokens=5287 cache_read_input_tokens=91285 cache_creation{ephemeral_5m_input_tokens=0 ephemeral_1h_input_tokens=5287} output_tokens=120 service_tier server_tool_use{web_search_requests=0 nested}',
    model: 'claude-test-1',
    version: '2.1.292',
  })
  expect(digestOf('')).toEqual({ responses: 0, usage: null, model: undefined, version: undefined })
})

test('a response without usage, and a model that is not a plain name, say so and show nothing else', () => {
  const digest = digestOf(JSON.stringify({ type: 'assistant', version: 7, message: { model: 'arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/abc' } }))
  expect(digest).toEqual({ responses: 1, usage: null, model: '(not shown)', version: undefined })
})

test('a model is shown as providers write one, and nothing that could name an account', () => {
  const model = (name: unknown) => digestOf(JSON.stringify({ type: 'assistant', message: { model: name } })).model
  for (const name of ['claude-opus-4-5-20251101', 'us.anthropic.claude-sonnet-4-5-20250929-v1:0', 'claude-opus-4-5@20251101', 'claude-sonnet-4-5[1m]']) expect(model(name)).toBe(name)
  for (const name of ['arn:aws:bedrock:us-east-1::foundation-model', 'profile-123456789012', 'https://gateway.example.com/model', 'my model', 'x'.repeat(81)]) expect(model(name)).toBe('(not shown)')
  expect(model(undefined)).toBeUndefined()
  expect(model('')).toBeUndefined()
})

test('a usage key that is not a plain word is left out, and no more than forty are shown', () => {
  const usage = digestOf(JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 1, 'jane@example.com': 2, 'a key with spaces': 3, nested: { 'https://x': 1, ok: 2 } } } })).usage
  expect(usage).toBe('input_tokens=1 nested{ok=2}')
  const many = Object.fromEntries(Array.from({ length: 60 }, (_, at) => [`k${at}`, at]))
  expect(digestOf(JSON.stringify({ type: 'assistant', message: { usage: many } })).usage?.split(' ').length).toBe(40)
})

test("of a notice only the plugin's own words are kept, and of what went wrong a code or an error's name", () => {
  expect(noticeHead("transcript not read, it is tried again: Error: ENOENT: no such file, open 'D:\\people\\jane doe\\s.jsonl'")).toBe('transcript not read, it is tried again (ENOENT)')
  expect(noticeHead('renewal failed: Error: getaddrinfo ENOTFOUND gateway.example.com')).toBe('renewal failed (ENOTFOUND)')
  expect(noticeHead('compaction failed: APIError: 529 overloaded, request_id req_011abc, org 4f2a')).toBe('compaction failed (APIError)')
  expect(noticeHead('announcement dropped: the user wrote "my secret plan" and I refuse it')).toBe('announcement dropped')
  expect(noticeHead('transcript not read: Error: tail exited with 1')).toBe('transcript not read (exited with 1)')
  expect(noticeHead('standing down: the plugin built on this one runs in the session')).toBe('standing down')
  expect(noticeHead('no colon here')).toBe('no colon here')
  expect(noticeHead(`${'x'.repeat(150)}: y`).length).toBe(100)
  expect(errorCode("Error: EACCES: permission denied, open '/srv/jane/s.jsonl'")).toBe('EACCES')
  expect(errorCode('something went wrong at klient\\projekt\\s.jsonl')).toBe('an error')
})

const facts = (over: Partial<ReportFacts> = {}): ReportFacts => ({
  version: '0.2.10',
  isWindows: true,
  surface: 'terminal',
  surfaces: { now: ['terminal'], asked: { terminal: 12 }, drawn: { terminal: 12 }, changes: [] },
  model: 'claude-test-1',
  env: {},
  askedTtlMs: null,
  contextTokens: 73678,
  transcript: { isKnown: true, exists: true, size: 2512331, readAt: T0 - 38000, failed: 0, rereadAt: null },
  tail: digestOf(row(USAGE)),
  events: { starts: 1, startsWithPath: 1, requests: 9 },
  guarded: false,
  notices: [],
  ...over,
})

test('the report says what an issue needs, row by row', () => {
  const config = configOf({})
  const state: State = { ...initialState(config), phase: 'WARM', anchorAt: T0 - 40000, ttlMs: TTL_1H, ttlSource: 'transcript' }
  expect(problemReport(state, T0, config, facts()).split('\n')).toEqual([
    REPORT_HEAD,
    'Cache Bell 0.2.10 · Claude Code 2.1.292 · Windows · terminal',
    'Surfaces: terminal · band asked for: terminal 12 · drawn: terminal 12 · seen: nothing',
    'Model: claude-test-1 · Bedrock no · Vertex no · Foundry no · own API address no',
    'Cache settings: DISABLE_PROMPT_CACHING no · FORCE_PROMPT_CACHING_5M no · CLAUDE_CODE_PROMPT_CACHE_TTL not set · TTL asked for none',
    'Options: enabled true · profile bellcompact · compactLevelK 0 · compactContextNotices true · compactOnRequest confirm · compactCountdown 30 · compactNotesInRow 5 · idleMinContextK 80 · idleAsk first · idleAskAheadMinutes 0 · idleRenewals 2 · idleCompact on · idleAnnounce true · cacheTtl auto · cacheRequestHour ask · display band · displayBelowMinutes 30 · texts changed: none',
    'State: WARM · TTL 1h from transcript · TTL unread no · last request 0:40 ago · context 73 678 tokens · renewals 0',
    'Transcript: path known yes · exists yes · size 2 512 331 bytes · read for the TTL 0:38 ago · failed reads 0 · next try none',
    'End of the transcript: responses of the main thread 1 · usage of the last: input_tokens=2 cache_creation_input_tokens=5287 cache_read_input_tokens=91285 cache_creation{ephemeral_5m_input_tokens=0 ephemeral_1h_input_tokens=5287} output_tokens=120 service_tier server_tool_use{web_search_requests=0 nested}',
    "Events seen: SessionStart 1, with the transcript's path 1 · requests of the main thread 9",
    "The plugin's last notices: none",
  ])
  // Guarded, no SessionStart can come: its count would only look like a fault.
  expect(problemReport(state, T0, config, facts({ guarded: true })).split('\n')[9]).toBe('Events seen: SessionStart not registered (guarded) · requests of the main thread 9')
})

test('the report says on which surfaces the band was asked for and drawn, and which came and went', () => {
  const config = configOf({})
  const report = problemReport(
    initialState(config),
    T0,
    config,
    facts({
      surfaces: {
        now: ['terminal', 'desktop', '/srv/jane/x'],
        asked: { terminal: 30, desktop: 4, 'a surface named by a client': 1 },
        drawn: { terminal: 30 },
        changes: [
          { surface: 'desktop', change: 'attached' },
          { surface: 'D:\\people\\jane', change: 'attached' },
          { surface: 'desktop', change: 'left' },
        ],
      },
    }),
  )
  expect(report.split('\n')[2]).toBe(
    'Surfaces: terminal, desktop, (not shown) · band asked for: terminal 30, desktop 4, (not shown) 1 · drawn: terminal 30 · seen: desktop attached, (not shown) attached, desktop left',
  )
  expect(problemReport(initialState(config), T0, config, facts({ surfaces: { now: null, asked: {}, drawn: {}, changes: [] } })).split('\n')[2]).toBe(
    'Surfaces: not read · band asked for: none · drawn: none · seen: nothing',
  )
  expect(problemReport(initialState(config), T0, config, facts({ surfaces: { now: ['terminal'], asked: {}, drawn: {}, changes: null } })).split('\n')[2]).toBe(
    'Surfaces: terminal · band asked for: none · drawn: none · seen: not watched',
  )
})

test('what the person wrote or set is never in the report: an address, a prompt, a path, a key', () => {
  const config = configOf({ idleAnnouncePrompt: 'my own secret prompt', cacheTtl: '5m', ...NOTIFY })
  const report = problemReport(
    initialState(config),
    T0,
    config,
    facts({
      version: undefined,
      isWindows: false,
      surface: undefined,
      model: 'arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/abc',
      env: { bedrock: '1', vertex: '0', baseUrl: 'https://gateway.example.com/key-abc', noCaching: 'true', force5m: '', ttl: 'not a word!' },
      askedTtlMs: TTL_1H,
      contextTokens: undefined,
      transcript: { isKnown: true, exists: null, size: null, readAt: null, failed: 2, rereadAt: T0 + 60000 },
      tail: errorCode("Error: EACCES: permission denied, open '/srv/jane/.claude/projects/x/s.jsonl'"),
      notices: [noticeHead('transcript not read, it is tried again: Error: EBUSY: D:\\people\\jane\\.claude\\projects\\x\\s.jsonl')],
    }),
  )
  expect(report.split('\n').slice(1)).toEqual([
    'Cache Bell version unknown · Claude Code version not seen · not Windows · surface unknown',
    'Surfaces: terminal · band asked for: terminal 12 · drawn: terminal 12 · seen: nothing',
    'Model: (not shown) · Bedrock yes · Vertex no · Foundry no · own API address yes',
    'Cache settings: DISABLE_PROMPT_CACHING yes · FORCE_PROMPT_CACHING_5M no · CLAUDE_CODE_PROMPT_CACHE_TTL (not shown) · TTL asked for 1h',
    'Options: enabled true · profile bellcompact · compactLevelK 0 · compactContextNotices true · compactOnRequest confirm · compactCountdown 30 · compactNotesInRow 5 · idleMinContextK 80 · idleAsk first · idleAskAheadMinutes 0 · idleRenewals 0 · idleCompact off · idleAnnounce true · cacheTtl 5m · cacheRequestHour ask · display band · displayBelowMinutes 30 · texts changed: idleAnnouncePrompt',
    'State: UNKNOWN · TTL 5m from config · TTL unread no · last request never · context unknown · renewals 0',
    'Transcript: path known yes · exists not asked · size unknown · read for the TTL never · failed reads 2 · next try in 1:00',
    'End of the transcript: not read: EACCES',
    "Events seen: SessionStart 1, with the transcript's path 1 · requests of the main thread 9",
    "The plugin's last notices: ",
    '  transcript not read, it is tried again (EBUSY)',
  ])
  for (const secret of ['gateway', 'key-abc', 'my own secret', 'jane', 'not a word', '123456789012', 'arn:']) expect(report).not.toContain(secret)
})

test('with no transcript there is nothing to read, and the report says so', () => {
  const config = configOf({})
  const report = problemReport(initialState(config), T0, config, facts({ transcript: { isKnown: false, exists: null, size: null, readAt: null, failed: 0, rereadAt: null }, tail: null }))
  expect(report).toContain('Transcript: path known no · exists not asked')
  expect(report).toContain('End of the transcript: nothing to read')
  expect(report).toContain('Claude Code version not seen')
})
