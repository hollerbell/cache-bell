import type { On, SessionMessage } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { resolveConfig } from '../../core/config'
import { initialState } from '../../core/decide'
import type { State } from '../../core/types'

const S = 1000
// A Monday morning: 2026-01-12 09:00 UTC.
const T0 = Date.UTC(2026, 0, 12, 9)

const COLUMNS = 100
const ROWS = 4

// The place above the prompt as Claude Code hands it to a ui.render hook: on which surface, and whether a
// survey of Claude Code's own stands there.
const abovePrompt = (surface: 'terminal' | 'desktop' = 'terminal', hasSurvey = false) => ({
  plugin: 'cache-bell',
  component: 'AbovePrompt' as const,
  requestId: `above-prompt-${surface}`,
  surface,
  viewport: { columns: COLUMNS, rows: 30 },
  props: { hasSurvey, isWorking: false, maxRows: ROWS, bodyColumns: COLUMNS, scroll: { offset: 0, bodyRows: ROWS }, view: {} },
})

const ASSISTANT_1H = JSON.stringify({
  type: 'assistant',
  isSidechain: false,
  message: { usage: { cache_creation: { ephemeral_1h_input_tokens: 900, ephemeral_5m_input_tokens: 0 } } },
})

const SUMMARY: SessionMessage[] = [{ role: 'user', text: 'Summary of the conversation so far.', toolUses: [] }]

type Seen = {
  toasts: string[]
  commands: string[]
  processes: number
  argv: string[][]
  statuses: (string | undefined)[]
  logs: string[]
  fills: string[]
  // what the plugin did on its own: 'fork', 'prepare', 'compact: <instructions>'
  did: string[]
  store: Map<string, unknown>
}

// What the stubs answer where a test needs something else than the usual.
const answers = { tailExit: 0, compactSkip: false, hasTranscript: true, forkRead: 143985, tokens: 143985, isSuperseded: false, theme: 'dark', isAnnouncementDropped: false, fork: 'answered' as 'answered' | 'unanswered' | 'throws', stored: null as State | null, agents: [] as string[], listed: 0, isListBroken: false, isCompactBroken: false, isStoreBroken: false, rows: {} as Record<string, unknown>, sets: [] as string[], looked: 0, draft: '', grown: 0 }

// Everything Claude Code would answer, so the mod's hooks run to their end.
const stubs = (on: On, env: Record<string, string> = {}, transcript = '', size = 100): Seen => {
  const seen: Seen = { toasts: [], commands: [], processes: 0, argv: [], statuses: [], logs: [], fills: [], did: [], store: new Map([['intro', 1]]) }
  answers.tailExit = 0
  answers.grown = 0
  answers.compactSkip = false
  answers.hasTranscript = true
  answers.forkRead = 143985
  answers.tokens = 143985
  answers.isSuperseded = false
  answers.theme = 'dark'
  answers.isAnnouncementDropped = false
  answers.fork = 'answered'
  answers.stored = null
  answers.agents = []
  answers.listed = 0
  answers.isListBroken = false
  answers.isCompactBroken = false
  answers.isStoreBroken = false
  answers.rows = {}
  answers.sets = []
  answers.looked = 0
  answers.draft = ''
  // `answers.rows` are the plugin's own rows of /config, by key; a row named "locked" refuses a change.
  on('config.list', (() => ({
    value: [
      { key: 'theme', label: 'Theme', kind: 'enum', value: answers.theme, isLocked: false },
      ...Object.entries(answers.rows).map(([key, value]) => ({ key, label: key, kind: 'string', value, isLocked: false })),
    ],
  })) as never)
  on('config.set', (($: unknown, e: { key: string; value: string }) => {
    if (e.key === 'theme') answers.theme = e.value
    else if (e.key.endsWith('.ttl')) return { deny: 'a managed setting' }
    else {
      answers.rows[e.key] = e.value
      answers.sets.push(`${e.key}=${String(e.value)}`)
    }
    return { value: e.value }
  }) as never)
  mock.env(on, env)
  // What the plugin built on this one keeps in the session; this plugin's own state stays the engine's.
  // `answers.stored` is the state an earlier instance of this plugin left behind, read until this one
  // writes its own: a reload.
  on('state.get', (($: unknown, e: { plugin: string }, next: (e: unknown) => unknown) => {
    if (e.plugin === 'holler-bell') return { value: { value: answers.isSuperseded, version: 1 } }
    return answers.stored === null ? next(e) : { value: { value: answers.stored, version: 0 } }
  }) as never)
  on('state.set', (($: unknown, e: unknown, next: (e: unknown) => unknown) => {
    answers.stored = null
    return next(e)
  }) as never)
  on('command.register', ($, e) => {
    seen.commands.push(e.name)
    return { value: { command: e.name } }
  })
  on('settings.read', () => ({ value: {} }))
  on('tool.register', ($, e) => {
    seen.commands.push(`tool ${e.name}`)
    return { value: { tool: `mcp__cache-bell__${e.name}` } }
  })
  on('ui.toast', ($, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', ($, e) => {
    seen.logs.push(e.text)
    return { value: undefined }
  })
  on('ui.status', ($, e) => {
    seen.statuses.push(e.text)
    return { value: undefined }
  })
  on('fs.stat', () => ({ value: { kind: 'file', size: size + answers.grown, mtimeMs: 0, isLink: false } }))
  on('fs.exists', () => {
    answers.looked += 1
    return { value: answers.hasTranscript }
  })
  // The plugin's own manifest, or the session's transcript.
  on('fs.read', ($, e) => ({ value: e.path.endsWith('plugin.json') ? '{ "name": "cache-bell", "version": "0.1.0" }' : transcript }))
  on('process.run', ($, e) => {
    seen.processes += 1
    seen.argv.push([...e.argv])
    return { value: { exitCode: answers.tailExit, stdout: transcript, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: answers.tokens, window: 200000, percent: 22 }, rateLimits: [] } }))
  on('store.get', ($, e) => ({ value: seen.store.get(e.key) }))
  on('store.set', ($, e) => {
    if (answers.isStoreBroken) throw new Error('disk full')
    seen.store.set(e.key, e.value)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...seen.store.keys()] }))
  on('store.delete', ($, e) => {
    seen.store.delete(e.key)
    return { value: undefined }
  })
  on('session.id', () => ({ value: 'abcd1234-0000-4000-8000-000000000000' }))
  on('model.fork', () => {
    seen.did.push('fork')
    if (answers.fork === 'throws') throw new Error('overloaded')
    if (answers.fork === 'unanswered') return { value: { isAnswered: false, reason: 'api-error' } } as never
    // A request that came too late reads nothing and writes the whole prefix again.
    const isLate = answers.forkRead === 0
    return {
      value: {
        isAnswered: true,
        text: 'ok',
        usage: { input_tokens: 3, output_tokens: 1, cache_read_input_tokens: answers.forkRead, cache_creation_input_tokens: isLate ? answers.tokens : 0 },
      },
    }
  })
  on('session.start', () => ({ cwd: '/work' }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('prompt.edit', ($, e) => ({ text: e.text.slice(0, e.start) + e.inputText + e.text.slice(e.end), cursor: e.start + e.inputText.length }) as never)
  on('prompt.submit', ($, e) => {
    // Another plugin's hook may drop the announcement before it enters.
    if (e.origin.kind === 'plugin' && answers.isAnnouncementDropped) return { drop: 'another plugin said no' } as never
    if (e.origin.kind === 'plugin') seen.did.push('prepare')
    return { text: e.text }
  })
  on('prompt.fill', ($, e) => {
    seen.fills.push(e.text)
    return { isFilled: true }
  })
  // `answers.agents` holds the status of each subagent of the session.
  on('agent.list', () => {
    answers.listed += 1
    if (answers.isListBroken) throw new Error('no agents on this surface')
    return { value: answers.agents.map((status, at) => ({ id: `agent-${at}`, description: 'a subagent', type: 'general-purpose', status })) }
  })
  // What the prompt box holds: `answers.draft`.
  on('prompt.read', () => ({ value: { text: answers.draft, cursor: answers.draft.length } }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.step', async function* ($, e) {
    yield { kind: 'text', index: 0, text: 'ok' }
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  on('turn.complete', () => ({ text: '' }))
  on('classic.Stop', () => ({}))
  on('classic.SessionStart', () => ({}))
  on('classic.PostModelSwitch', () => ({}))
  on('session.compact', ($, e) => {
    if (e.trigger !== 'manual' && e.trigger !== 'precompute' && e.trigger !== 'auto') seen.did.push(`compact[${String(e.trigger)}]: ${e.instructions ?? ''}`)
    if (answers.isCompactBroken) throw new Error('overloaded')
    return answers.compactSkip ? { skip: 'a hook said no' } : { messages: SUMMARY, tokensBefore: answers.tokens, tokensAfter: 21400 }
  })
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['drawn by Claude Code'] }))
  return seen
}

type Clock = ReturnType<typeof mock.clock>

// The text of an element with everything nested in it.
const flat = (node: unknown): string => {
  if (typeof node === 'string') return node
  const children = (node as { children?: unknown[] } | undefined)?.children ?? []
  return children.map(flat).join('')
}

// One whole turn of the main thread: its request goes out now, the turn ends `lastsMs` later.
// The person's own turn begins with their message; `isPersons: false` is a turn nobody is known to have sent.
const turn = async ($: Engine, clock: Clock, lastsMs: number, agentId?: string, isPersons = true) => {
  if (agentId === undefined && isPersons) await $.prompt.submit({ text: 'hi', wait: false, origin: { kind: 'composer' } })
  if (agentId === undefined) await $.turn.start({ text: 'hi', turnId: 't' })
  const stream = $.turn.step({ turnId: 't', index: 0, model: 'claude-test', messageCount: 1, ...(agentId === undefined ? {} : { agentId }) })
  let step = await stream.next()
  while (step.done !== true) step = await stream.next()
  await clock.advance(lastsMs)
  await $.turn.complete({ turnId: 't', answer: 'ok', durationMs: lastsMs, isAborted: false, reason: 'answer', ...(agentId === undefined ? {} : { agentId }) })
}

const bandText = async ($: Engine, surface: 'terminal' | 'desktop' = 'terminal'): Promise<string> => {
  const ui = await $.ui.mount(abovePrompt(surface))
  const found = await ui.find({ type: 'Text' })
  await ui.unmount()
  return flat(found)
}

const run = ($: Engine, args: string) =>
  $.command.run({ command: 'bell', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })

const status = async ($: Engine): Promise<string> => (await run($, 'status')).text ?? ''

// The log of compactions as the store holds it, the oldest first.
const logged = (seen: Seen): unknown[] =>
  [...seen.store.entries()]
    .filter(([key]) => key.startsWith('log:'))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, entry]) => entry)

test('the band counts down from the last request and turns cold', { options: { mode: 'custom', ask: 'never', renewMethod: 'none', compact: false } }, async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const seen = stubs(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  expect(seen.commands).toEqual(['bell', 'tool compact'])
  expect(await bandText($)).toBe('drawn by Claude Code')

  // The request goes out at T0 and the turn runs 20 s: the countdown started with the request.
  await turn($, clock, 20 * S)
  for (const surface of ['terminal', 'desktop'] as const) {
    expect(await bandText($, surface)).toBe('h⣿ Cache Bell: prompt cache expires in 4:15')
  }

  await clock.advance(254 * S)
  expect(await bandText($)).toBe('h⣿ Cache Bell: prompt cache expires in 0:01')
  expect(seen.toasts).toEqual([])

  await clock.advance(S)
  expect(await bandText($)).toBe('h⣿ Cache Bell: prompt cache expired · the next message re-sends 144k tokens uncached')
  expect(seen.toasts).toEqual(['Prompt cache expired after 5 min without a request. The next message re-sends the whole context uncached.'])

  // Cold stays cold and says so once.
  await clock.advance(600 * S)
  expect(seen.toasts.length).toBe(1)

  // New work warms it again.
  await turn($, clock, S)
  expect(await bandText($)).toBe('h⣿ Cache Bell: prompt cache expires in 4:34')
})

test('nothing is drawn while a turn runs or a survey shows', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  stubs(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.turn.start({ text: 'hi', turnId: 't' })
  expect(await bandText($)).toBe('drawn by Claude Code')

  await turn($, clock, S)
  const ui = await $.ui.mount(abovePrompt('terminal', true))
  expect((await ui.find({ type: 'Text' }))?.children?.[0]).toBe('drawn by Claude Code')
  await ui.unmount()
})

test('a subagent request does not move the anchor', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  stubs(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await turn($, clock, 0)
  await clock.advance(100 * S)
  await turn($, clock, 0, 'agent-1')
  expect(await bandText($)).toBe('h⣿ Cache Bell: prompt cache expires in 2:55')
})

test('the TTL comes from the transcript when the turn stops', { options: { showBelowMinutes: 0 } }, async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const seen = stubs(on, {}, `${ASSISTANT_1H}\n`)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await turn($, clock, 0)
  await $.classic.Stop({ transcript_path: '/work/session.jsonl', stop_hook_active: false })
  expect(await bandText($)).toBe('h⣿ Cache Bell: prompt cache expires in 55 min')
  expect(seen.processes).toBe(0)
  expect(await status($)).toMatch(/Cache TTL: 1h \(read from the transcript\)/)
})

test('with reading the transcript switched off the file is never touched', { options: { showBelowMinutes: 0, readTranscript: false } }, async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const seen = stubs(on, {}, ASSISTANT_1H)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await turn($, clock, 0)
  await $.classic.Stop({ transcript_path: '/work/session.jsonl', stop_hook_active: false })
  expect(answers.looked).toBe(0)
  expect(seen.processes).toBe(0)
  // The lifetime stays what was assumed: five minutes.
  expect(await status($)).toContain('Cache TTL: 5m (assumed, not yet seen in the data)')
})

test('a transcript too large to read is read by its tail', { options: { showBelowMinutes: 0 } }, async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const seen = stubs(on, { OS: 'Windows_NT' }, `${ASSISTANT_1H}\n`, 4 * 1024 * 1024 + 1)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await turn($, clock, 0)
  await $.classic.Stop({ transcript_path: 'C:/work/session.jsonl', stop_hook_active: false })
  expect(seen.processes).toBe(1)
  expect(await bandText($)).toBe('h⣿ Cache Bell: prompt cache expires in 55 min')
})

test('the settings give the TTL before the first response', async ($, on) => {
  mock.clock(on, { now: T0 })
  stubs(on, { CLAUDE_CODE_PROMPT_CACHE_TTL: '1h' })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  expect(await status($)).toMatch(/Cache TTL: 1h \(from the Claude Code settings, not yet confirmed by a response\)/)
})

test('a TTL set in the options is not overridden by the transcript', { options: { ttl: '5m', mode: 'notify' } }, async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  stubs(on, { CLAUDE_CODE_PROMPT_CACHE_TTL: '1h' }, `${ASSISTANT_1H}\n`)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await turn($, clock, 0)
  await $.classic.Stop({ transcript_path: '/work/session.jsonl', stop_hook_active: false })
  expect(await status($)).toBe(
    [
      'version 0.1.0 · on, mode notify',
      'State: warm',
      'Cache TTL: 5m (set in the plugin options)',
      'Last request to the API: 0:00 ago',
      'Next: asks in 3:30, cache lost in 4:35',
      'Context: 143 985 tokens',
    ].join('\n'),
  )
})

test('/bell status answers without a turn and refuses what is not there yet', async ($, on) => {
  mock.clock(on, { now: T0 })
  stubs(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  expect(await status($)).toMatch(/^version 0\.1\.0 · on, mode prepare-compact\nState: unknown/)
  expect((await run($, '')).text).toMatch(/State: unknown/)
  expect((await run($, 'now')).text).toBe('Usage: /bell status | log [count] | demo [seconds] [bg] [stay]\n       | show calm|act|cold|intro|off | reset')
  for (const count of ['abc', '0', '201', '1.5', '-3']) expect((await run($, `log ${count}`)).text).toBe('Usage: /bell log [count], 1 to 200.')
  expect((await run($, 'log 200')).text).not.toMatch(/^Usage/)
  expect((await run($, 'log')).text).not.toMatch(/^Usage/)
})

test('a compaction puts the session to sleep and a /clear forgets it', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const seen = stubs(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await turn($, clock, 0)
  await $.session.compact({ trigger: 'manual', messages: SUMMARY })
  expect(await status($)).toMatch(/State: dormant/)
  expect(await bandText($)).toBe('drawn by Claude Code')
  await clock.advance(600 * S)
  expect(seen.toasts).toEqual([])

  await turn($, clock, 0)
  expect(await status($)).toMatch(/State: warm/)
  await $.classic.SessionStart({ source: 'compact' })
  expect(await status($)).toMatch(/State: dormant/)

  await turn($, clock, 0)
  await $.classic.SessionStart({ source: 'clear' })
  expect(await status($)).toMatch(/State: unknown/)
})

test('a precompute and a subagent compaction change nothing', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  stubs(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await turn($, clock, 0)
  await $.session.compact({ trigger: 'precompute', messages: SUMMARY })
  await $.session.compact({ trigger: 'auto', agentId: 'agent-1', messages: SUMMARY })
  expect(await status($)).toMatch(/State: warm/)
})

test('a headless run is left alone', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const seen = stubs(on)
  await $.session.start({ surface: null, isInteractive: false, cwd: '/work' })
  await turn($, clock, 0)
  await clock.advance(600 * S)
  expect(seen.toasts).toEqual([])
  expect(await status($)).toMatch(/State: unknown/)
})

test('switched off, the plugin draws nothing and says nothing', { options: { enabled: false } }, async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const seen = stubs(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await turn($, clock, 0)
  expect(await bandText($)).toBe('drawn by Claude Code')
  await clock.advance(600 * S)
  expect(seen.toasts).toEqual([])
  expect(await status($)).toMatch(/^version 0\.1\.0 · off/)
})

test('a subagent that finishes does not end the main turn', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  stubs(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.turn.start({ text: 'hi', turnId: 't' })
  await turn($, clock, 0, 'agent-1')
  expect(await status($)).toMatch(/State: busy/)
})

test('a /clear seen as the end of the session forgets the cache', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  stubs(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await turn($, clock, 0)
  await $.session.end({ reason: 'other', sessionId: 's' } as never)
  expect(await status($)).toMatch(/State: warm/)
  await $.session.end({ reason: 'clear', sessionId: 's' } as never)
  expect(await status($)).toMatch(/State: unknown/)
})

test('a compaction that was refused changes nothing', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  stubs(on)
  answers.compactSkip = true
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await turn($, clock, 0)
  await $.session.compact({ trigger: 'manual', messages: SUMMARY })
  expect(await status($)).toMatch(/State: warm/)
})

const LARGE = 4 * 1024 * 1024 + 1

test('the end of a large transcript is read with the command of the system', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const seen = stubs(on, {}, `${ASSISTANT_1H}\n`, LARGE)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await turn($, clock, 0)
  await $.classic.Stop({ transcript_path: '/work/session.jsonl', stop_hook_active: false })
  expect(seen.argv).toEqual([['tail', '-c', '1048576', '/work/session.jsonl']])
  expect(await status($)).toMatch(/Cache TTL: 1h \(read from the transcript\)/)
})

test('on Windows the end is read by PowerShell with the path inside the command', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const seen = stubs(on, { OS: 'Windows_NT' }, `${ASSISTANT_1H}\n`, LARGE)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await turn($, clock, 0)
  await $.classic.Stop({ transcript_path: 'C:\\work\\session.jsonl', stop_hook_active: false })
  expect(seen.argv.length).toBe(1)
  expect(seen.argv[0]?.slice(0, 4)).toEqual(['powershell', '-NoProfile', '-NonInteractive', '-Command'])
  expect(seen.argv[0]?.[4]).toContain("[IO.File]::Open('C:\\work\\session.jsonl','Open','Read','ReadWrite')")
  expect(seen.argv[0]?.[4]).toContain('[Math]::Min($f.Length,1048576)')
})

test('a transcript that did not grow is not read again, and a confirmed TTL only now and then', { options: { mode: 'notify' } }, async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const seen = stubs(on, {}, `${ASSISTANT_1H}\n`, LARGE)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const stop = () => $.classic.Stop({ transcript_path: '/work/session.jsonl', stop_hook_active: false })
  await turn($, clock, 0)
  await stop()
  expect(seen.processes).toBe(1)
  // The same size: nothing was appended, nothing is read.
  await stop()
  expect(seen.processes).toBe(0 + 1)
  // It grew, but the TTL was confirmed a moment ago.
  answers.grown = 5000
  await stop()
  expect(seen.processes).toBe(1)
  await clock.advance(100 * S)
  expect(seen.processes).toBe(1)
  // Two minutes after the last read what was appended is read, with no turn to wait for: should the cache
  // have turned short, that is known before the short cache's time to act. Only the appended piece is
  // read, the least the command reads.
  await clock.advance(21 * S)
  expect(seen.processes).toBe(2)
  await stop()
  expect(seen.argv).toEqual([
    ['tail', '-c', '1048576', '/work/session.jsonl'],
    ['tail', '-c', '65536', '/work/session.jsonl'],
  ])
})

test('a transcript that cannot be read leaves the TTL a guess: nothing is sent on it, and the read is tried again', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const seen = stubs(on, {}, `${ASSISTANT_1H}\n`, LARGE)
  answers.tailExit = 1
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await turn($, clock, 0)
  await $.classic.Stop({ transcript_path: '/work/session.jsonl', stop_hook_active: false })
  expect(seen.logs).toEqual(['transcript not read, it is tried again: Error: tail exited with 1'])
  expect(await bandText($)).toBe('h⣿ Cache Bell: prompt cache: lifetime not known yet, the transcript could not be read · nothing is renewed or compacted until it is')
  // Past the time the assumed five minutes would ask and renew at. The read was tried again after 15
  // seconds and after a minute more; the failure is said once.
  await clock.advance(280 * S)
  expect(seen.processes).toBe(3)
  expect(seen.logs.length).toBe(1)
  expect(seen.did).toEqual([])
  expect(await status($)).toContain('Next: nothing is asked, renewed or compacted until the TTL is read')
  // The next try, five minutes after the last, goes through: the hour-long cache is still warm.
  answers.tailExit = 0
  await clock.advance(100 * S)
  expect(seen.processes).toBe(4)
  expect(await status($)).toMatch(/State: warm[\s\S]*Cache TTL: 1h \(read from the transcript\)/)
  // With 54 minutes left of the hour the band has nothing to say.
  expect(await bandText($)).toBe('drawn by Claude Code')
})

test('a transcript that is gone in the middle of the tries ends them, and the plugin works with what it assumed', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const seen = stubs(on, {}, `${ASSISTANT_1H}\n`, LARGE)
  answers.tailExit = 1
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await turn($, clock, 0)
  await $.classic.Stop({ transcript_path: '/work/session.jsonl', stop_hook_active: false })
  expect(await status($)).toContain('Cache TTL: 5m (assumed: the transcript could not be read, it is tried again)')
  answers.hasTranscript = false
  await clock.advance(20 * S)
  expect(await status($)).toContain('Cache TTL: 5m (assumed, not yet seen in the data)')
  // Nothing more is looked for, second after second.
  const looked = answers.looked
  await clock.advance(30 * S)
  expect(answers.looked).toBe(looked)
  expect(seen.processes).toBe(1)
})

test('a model switch turns the cache cold and brings its TTL', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  stubs(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await turn($, clock, 0)
  await $.classic.PostModelSwitch({ cache_ttl: '1h', prompt_cache_warm: true } as never)
  const report = await status($)
  expect(report).toMatch(/State: cold, model changed/)
  expect(report).toMatch(/Cache TTL: 1h \(reported at the model switch\)/)
})

test('the display is touched only when its text changes', { options: { display: 'both', ttl: '1h', showBelowMinutes: 0 } }, async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const seen = stubs(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await turn($, clock, 0)
  await clock.advance(150 * S)
  // 150 ticks, four texts: the minute changed three times.
  expect(seen.statuses.filter(text => text !== undefined)).toEqual(['cache 55 min', 'cache 54 min', 'cache 53 min', 'cache 52 min'])
})

// A reload in a running session wipes the status line; a state that no longer changes must still be put back.
test('the first tick after the plugin is loaded draws once, whatever the state', { options: { display: 'both' } }, async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const seen = stubs(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  expect(seen.statuses.length).toBe(0)
  await clock.advance(1 * S)
  expect(seen.statuses.length).toBe(1)
  await clock.advance(30 * S)
  expect(seen.statuses.length).toBe(1)
})

test('a session that keeps no transcript is not an error', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const seen = stubs(on, {}, `${ASSISTANT_1H}\n`)
  answers.hasTranscript = false
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await turn($, clock, 0)
  await $.classic.Stop({ transcript_path: '/work/session.jsonl', stop_hook_active: false })
  expect(seen.logs).toEqual([])
  expect(await status($)).toMatch(/Cache TTL: 5m \(assumed/)
})

test('after a /clear the TTL from the settings is known again', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  stubs(on, { CLAUDE_CODE_PROMPT_CACHE_TTL: '1h' })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await turn($, clock, 0)
  await $.classic.SessionStart({ source: 'clear' })
  const report = await status($)
  expect(report).toMatch(/State: unknown/)
  expect(report).toMatch(/Cache TTL: 1h \(from the Claude Code settings/)
})

type Run = { props?: { color?: string; backgroundColor?: string; bold?: boolean; dimColor?: boolean } }
const runsOf = (node: unknown): Run[] => ((node as { children?: unknown[] } | undefined)?.children ?? []) as Run[]

// The answers a question may offer, by the key of their button.
const CHOICE_KEYS = ['compact', 'renew', 'cancel', 'skip']

// The question as drawn: its coloured line joined with the plain note under it, how the line is drawn, and
// the choices with the one that is selected.
const question = async ($: Engine, surface: 'terminal' | 'desktop' = 'terminal') => {
  const ui = await $.ui.mount(abovePrompt(surface))
  const line = await ui.find({ type: 'Text' })
  const note = await ui.find({ key: 'note' })
  const choices = await ui.find({ key: 'choices' })
  const found = []
  for (const key of CHOICE_KEYS) found.push(await ui.find({ key }))
  const buttons = found.filter(button => button !== undefined)
  await ui.unmount()
  return {
    // the first line says why, the last counts down: one after the other here, so the texts below read on
    text: `${flat(line)} ${flat(note)}`,
    note: flat(note),
    indent: [choices?.props.paddingLeft, note?.props.paddingLeft],
    // the line is drawn in four runs: the mark's letter, its tile, the name, and what swings
    mark: runsOf(line).slice(0, 2).map(run => run.props?.color),
    name: [flat(runsOf(line)[2]), runsOf(line)[2]?.props?.color, runsOf(line)[2]?.props?.backgroundColor],
    // the reason is drawn still; what swings is the line with the countdown
    headColor: runsOf(line)[3]?.props?.color,
    color: ((note?.children ?? [])[0] as Run | undefined)?.props?.color,
    backgroundColor: ((note?.children ?? [])[0] as Run | undefined)?.props?.backgroundColor,
    labels: buttons.map(button => String(button?.props.label ?? '')),
    selected: buttons.filter(button => button?.props.variant === 'primary').map(button => String(button?.props.label ?? '')),
    hotkeys: buttons.map(button => button?.props.hotkey),
  }
}

// One edit of the prompt box by the person: `inputText` replaces the span from `start` to `end` of `text`.
const edit = ($: Engine, text: string, start: number, end: number, inputText: string) =>
  // The kit raises the event, its typings do not list it.
  ($.prompt as unknown as { edit: (e: unknown) => Promise<unknown> }).edit({ origin: { kind: 'composer' }, text, cursor: start, start, end, inputText })

const enter = ($: Engine, text: string) => $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })

const opened = async ($: Engine, on: On, args = 'demo 30') => {
  const clock = mock.clock(on, { now: T0 })
  const seen = stubs(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await run($, args)
  return { clock, seen }
}

test('the demo question counts down, swings its colour, and at the end does what is selected', async ($, on) => {
  const { clock, seen } = await opened($, on)

  // Compact is selected from the start. The first line says why and stands still; the countdown under the
  // choices carries the colour.
  for (const surface of ['terminal', 'desktop'] as const) {
    expect(await question($, surface)).toEqual({
      text: 'h⣿ Cache Bell: Cache expires soon: No answer: Compact in 0:30',
      mark: ['#3aa3b3', '#7ad8f8'],
      // the name stands still in the plain colour
      name: [' Cache Bell:', undefined, undefined],
      headColor: undefined,
      color: '#b38f00',
      backgroundColor: undefined,
      note: 'No answer: Compact in 0:30',
      indent: [2, 2],
      labels: ['[1] >Compact<', '[2]  Renew cache ', '[3]  Let it expire '],
      selected: ['[1] >Compact<'],
      hotkeys: [undefined, undefined, undefined],
    })
  }

  // The colour goes to the second one in a second and is back after two.
  await clock.advance(500)
  expect(await question($)).toMatchObject({ text: 'h⣿ Cache Bell: Cache expires soon: No answer: Compact in 0:30', color: '#d9a000' })
  await clock.advance(500)
  expect(await question($)).toMatchObject({ text: 'h⣿ Cache Bell: Cache expires soon: No answer: Compact in 0:29', color: '#ffb000' })
  await clock.advance(S)
  expect(await question($)).toMatchObject({ text: 'h⣿ Cache Bell: Cache expires soon: No answer: Compact in 0:28', color: '#b38f00' })

  await clock.advance(27 * S)
  expect((await question($)).text).toBe('h⣿ Cache Bell: Cache expires soon: No answer: Compact in 0:01')
  expect(seen.toasts).toEqual([])

  await clock.advance(S)
  expect(seen.toasts).toEqual(['Demo: Compact (time ran out). Nothing was sent to the model.'])
  expect(await bandText($)).toBe('drawn by Claude Code')
  await clock.advance(10 * S)
  expect(seen.toasts.length).toBe(1)
})

test('a click does a choice at once and stops the countdown', async ($, on) => {
  const { clock, seen } = await opened($, on)
  for (const [key, label] of [['compact', 'Compact'], ['renew', 'Renew cache'], ['cancel', 'Let it expire']] as const) {
    await run($, 'demo 30')
    const ui = await $.ui.mount(abovePrompt())
    await ui.press({ key })
    await ui.unmount()
    expect(seen.toasts.at(-1)).toBe(`Demo: ${label} (clicked). Nothing was sent to the model.`)
    expect(await bandText($)).toBe('drawn by Claude Code')
  }
  await clock.advance(60 * S)
  expect(seen.toasts.length).toBe(3)
})

test('a digit selects what the time running out will do, and the countdown runs on', async ($, on) => {
  const { clock, seen } = await opened($, on)
  await clock.advance(10 * S)

  await edit($, '', 0, 0, '2')
  expect(await question($)).toMatchObject({ text: 'h⣿ Cache Bell: Cache expires soon: [Enter] confirms · no answer: Renew cache in 0:20', selected: ['[2] >Renew cache<'] })
  await clock.advance(5 * S)
  expect((await question($)).text).toBe('h⣿ Cache Bell: Cache expires soon: [Enter] confirms · no answer: Renew cache in 0:15')

  // An emptied prompt puts the default back; the countdown did not stop for any of it.
  await edit($, '2', 0, 1, '')
  expect(await question($)).toMatchObject({ text: 'h⣿ Cache Bell: Cache expires soon: No answer: Compact in 0:15', selected: ['[1] >Compact<'] })
  await edit($, '', 0, 0, '3')
  expect(await question($)).toMatchObject({ text: 'h⣿ Cache Bell: Cache expires soon: [Enter] confirms · no answer: Let it expire in 0:15', selected: ['[3] >Let it expire<'] })

  await clock.advance(15 * S)
  expect(seen.toasts).toEqual(['Demo: Let it expire (time ran out). Nothing was sent to the model.'])
})

test('a digit and Enter does the choice at once and sends nothing to the model', async ($, on) => {
  const { clock, seen } = await opened($, on)
  await edit($, '', 0, 0, '3')
  expect(await enter($, '3')).toEqual({ drop: 'cache-bell: Let it expire' })
  expect(seen.toasts).toEqual(['Demo: Let it expire (typed and confirmed with Enter). Nothing was sent to the model.'])
  expect(await bandText($)).toBe('drawn by Claude Code')
  await clock.advance(60 * S)
  expect(seen.toasts.length).toBe(1)

  // With no question open a digit is an ordinary message.
  expect(await enter($, '3')).toEqual({ text: '3' })
})

test('other text in the prompt puts the default back and the countdown still runs', async ($, on) => {
  const { clock, seen } = await opened($, on)
  await clock.advance(10 * S)
  await edit($, '', 0, 0, '2')

  // "20" is no choice.
  await edit($, '2', 1, 1, '0')
  expect(await question($)).toMatchObject({ text: 'h⣿ Cache Bell: Cache expires soon: No answer: Compact in 0:20', selected: ['[1] >Compact<'] })
  await clock.advance(5 * S)
  await edit($, '20', 2, 2, ' files')
  expect((await question($)).text).toBe('h⣿ Cache Bell: Cache expires soon: No answer: Compact in 0:15')

  // Back to a single digit selects it again.
  await edit($, '20 files', 1, 8, '')
  expect((await question($)).selected).toEqual(['[2] >Renew cache<'])
  await edit($, '2', 1, 1, 'x')

  // The time runs out while the person types: the default is done.
  await clock.advance(15 * S)
  expect(seen.toasts).toEqual(['Demo: Compact (time ran out). Nothing was sent to the model.'])
})

test('a message from the person closes the question, one from a plugin does not', async ($, on) => {
  const { clock, seen } = await opened($, on)
  await $.prompt.submit({ text: '1', wait: false, origin: { kind: 'plugin', name: 'other' } } as never)
  expect((await question($)).text).toBe('h⣿ Cache Bell: Cache expires soon: No answer: Compact in 0:30')

  await edit($, '', 0, 0, 'hello')
  expect(await enter($, 'hello')).toEqual({ text: 'hello' })
  expect(seen.toasts).toEqual(['Demo: question closed, you sent a message.'])
  expect(await bandText($)).toBe('drawn by Claude Code')
  await clock.advance(60 * S)
  expect(seen.toasts.length).toBe(1)
})

test('the demo starts by itself when the variable asks for it, and refuses a bad length', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  stubs(on, { CACHE_BELL_DEMO: '30' })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  expect(await bandText($)).toBe('drawn by Claude Code')
  await clock.advance(1500)
  expect((await question($)).text).toBe('h⣿ Cache Bell: Cache expires soon: No answer: Compact in 0:30')
  expect((await run($, 'demo 0')).text).toBe('Usage: /bell demo [seconds] [bg] [stay], 1 to 600 seconds.')
  expect((await run($, 'demo x')).text).toBe('Usage: /bell demo [seconds] [bg] [stay], 1 to 600 seconds.')
})

test('the bg style swings the background under dark text', async ($, on) => {
  const { clock } = await opened($, on, 'demo 30 bg')
  expect(await question($)).toMatchObject({ color: '#000000', backgroundColor: '#b38f00', name: [' Cache Bell:', undefined, undefined] })
  await clock.advance(S)
  expect(await question($)).toMatchObject({ color: '#000000', backgroundColor: '#ffb000', name: [' Cache Bell:', undefined, undefined] })
})

test('a second digit replaces the first in the prompt instead of standing next to it', async ($, on) => {
  const { clock, seen } = await opened($, on)
  await edit($, '', 0, 0, '2')
  expect((await question($)).selected).toEqual(['[2] >Renew cache<'])

  // "3" typed after "2": the prompt is set to "3" and that choice is selected.
  await edit($, '2', 1, 1, '3')
  expect(seen.fills).toEqual(['3'])
  expect(await question($)).toMatchObject({ selected: ['[3] >Let it expire<'], note: '[Enter] confirms · no answer: Let it expire in 0:30' })

  // Also when typed in front of the digit, and for the same digit again.
  await edit($, '3', 0, 0, '1')
  await edit($, '1', 1, 1, '1')
  expect(seen.fills).toEqual(['3', '1', '1'])
  expect((await question($)).selected).toEqual(['[1] >Compact<'])

  // A letter after a digit is ordinary typing and nothing is replaced.
  await edit($, '1', 1, 1, 'x')
  expect(seen.fills.length).toBe(3)
  expect(await question($)).toMatchObject({ selected: ['[1] >Compact<'], note: 'No answer: Compact in 0:30' })

  // With no question open, digits are left alone.
  await clock.advance(60 * S)
  await edit($, '2', 1, 1, '3')
  expect(seen.fills.length).toBe(3)
})
// --- the plugin acting on a real cache ---

// A session whose last request went out at T0 and which has been idle since, on a five-minute cache:
// the question comes at 3:30, its deadline is 4:00, the cache is gone at 4:35.
const idle = async ($: Engine, on: On) => {
  const clock = mock.clock(on, { now: T0 })
  const seen = stubs(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await turn($, clock, 0)
  return { clock, seen }
}

// The plugin's own announcement, as Claude Code would run it: the turn that follows the plugin's prompt.
const ownTurn = ($: Engine, clock: Clock) => turn($, clock, 0, undefined, false)

test('before the cache runs out the plugin asks, and without an answer renews it', async ($, on) => {
  const { clock, seen } = await idle($, on)
  await clock.advance(209 * S)
  expect(await bandText($)).toBe('h⣿ Cache Bell: prompt cache expires in 1:06')

  await clock.advance(S)
  expect(await question($)).toMatchObject({
    text: 'h⣿ Cache Bell: Cache expires soon (144k tokens), 2 automatic renewals left, then compacts: No answer: Renew cache in 0:30',
    labels: ['[1]  Compact ', '[2] >Renew cache<', '[3]  Let it expire '],
    selected: ['[2] >Renew cache<'],
  })
  expect(seen.did).toEqual([])

  // The time runs out: one silent request beside the conversation, and the countdown starts over from it.
  await clock.advance(30 * S)
  expect(seen.did).toEqual(['fork'])
  expect(await bandText($)).toBe('h⣿ Cache Bell: prompt cache expires in 4:35')
  expect(await status($)).toMatch(/State: warm/)
})

for (const fork of ['unanswered', 'throws'] as const) {
  test(`a renewal that gets no answer (${fork}) is tried once more, then nothing more is sent`, async ($, on) => {
    const { clock, seen } = await idle($, on)
    answers.fork = fork
    await clock.advance(250 * S)
    // One attempt, and no second one a second later.
    expect(seen.did).toEqual(['fork'])
    expect(seen.toasts).toEqual([])
    await clock.advance(15 * S)
    expect(seen.did).toEqual(['fork', 'fork'])
    expect(seen.toasts).toEqual(['Renewing the prompt cache got no answer: nothing more is sent, the cache is left to expire.'])
    // No compaction is brought forward, and the cache runs out as it would have.
    await clock.advance(600 * S)
    expect(seen.did).toEqual(['fork', 'fork'])
    expect(await status($)).toMatch(/State: cold/)
  })
}

test('a real question cannot be taken down by the demo, and a message alone does not close it', async ($, on) => {
  const { clock, seen } = await idle($, on)
  await clock.advance(210 * S)
  const asked = (await question($)).text
  expect(asked).toMatch(/^h⣿ Cache Bell: Cache expires soon \(144k tokens\), 2 automatic renewals left, then compacts: /)
  for (const args of ['demo 30', 'show calm', 'show off']) expect((await run($, args)).text).toBe('A question is open. Answer it first.')
  expect((await question($)).text).toBe(asked)

  // A message another plugin drops starts no turn: the question stays, and its time still runs out.
  await enter($, 'hello')
  expect((await question($)).text).toBe(asked)
  await clock.advance(30 * S)
  expect(seen.did).toEqual(['fork'])
})

const leftBehind = (over: Partial<State>): State => ({ ...initialState(resolveConfig({})), anchorAt: T0, contextTokens: 143985, isAsked: true, ...over })

test('a question open when the plugin was loaded again is put up again for the time it has left', async ($, on) => {
  const clock = mock.clock(on, { now: T0 + 215 * S })
  const seen = stubs(on)
  answers.stored = leftBehind({ phase: 'ASKING', askReason: 'cache', askDeadline: T0 + 240 * S })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await clock.advance(S)
  expect(await question($)).toMatchObject({
    text: 'h⣿ Cache Bell: Cache expires soon (144k tokens), 2 automatic renewals left, then compacts: No answer: Renew cache in 0:24',
    selected: ['[2] >Renew cache<'],
  })
  await clock.advance(25 * S)
  expect(seen.did).toEqual(['fork'])
})

for (const phase of ['RENEWING', 'PREPARING', 'COMPACTING'] as const) {
  test(`a step that was running (${phase}) when the plugin was loaded again is not repeated`, async ($, on) => {
    const clock = mock.clock(on, { now: T0 + 241 * S })
    const seen = stubs(on)
    answers.stored = leftBehind({ phase })
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
    await clock.advance(S)
    expect(seen.toasts).toEqual(['The plugin was loaded again in the middle of a step: nothing more is done until you work in this session again.'])
    expect(await bandText($)).toBe('h⣿ Cache Bell: prompt cache expires in 0:33 · nothing will be done')
    await clock.advance(600 * S)
    expect(seen.did).toEqual([])
  })
}

test('switched off, the plugin does not put a question up again after it was loaded again', { options: { enabled: false } }, async ($, on) => {
  const clock = mock.clock(on, { now: T0 + 215 * S })
  const seen = stubs(on)
  answers.stored = leftBehind({ phase: 'ASKING', askReason: 'cache', askDeadline: T0 + 240 * S })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await clock.advance(60 * S)
  expect(await bandText($)).toBe('drawn by Claude Code')
  expect(seen.did).toEqual([])
})

test('an announcement that work overtook is dropped', async ($, on) => {
  await idle($, on)
  // The plugin's own prompt arrives while nothing is being announced: the person got in first.
  const own = { text: 'This conversation will be compacted right after this turn.', wait: false, origin: { kind: 'plugin', name: 'cache-bell' } }
  expect(await $.prompt.submit(own as never)).toEqual({ drop: 'cache-bell: work started before the compaction was announced' })
})

test('the second period is renewed without a question, the third asks again and ends with the announcement and a compaction', async ($, on) => {
  const { clock, seen } = await idle($, on)
  await clock.advance(240 * S)
  expect(seen.did).toEqual(['fork'])

  await clock.advance(239 * S)
  expect(await bandText($)).toBe('h⣿ Cache Bell: prompt cache expires in 0:36')
  await clock.advance(S)
  expect(seen.did).toEqual(['fork', 'fork'])

  // The renewals are used up. A compaction cannot be undone, so the question comes again, with Compact
  // selected; nobody answers, and the session is told that a compaction is coming.
  await clock.advance(210 * S)
  expect(await question($)).toMatchObject({
    text: 'h⣿ Cache Bell: Cache expires soon (144k tokens), no automatic renewals left: No answer: Compact in 0:30',
    selected: ['[1] >Compact<'],
  })
  expect(seen.did).toEqual(['fork', 'fork'])
  await clock.advance(30 * S)
  expect(seen.did).toEqual(['fork', 'fork', 'prepare'])
  expect(await bandText($)).toBe('h⣿ Cache Bell: announcing the compaction…')

  // Its turn ends, and a second later the compaction runs, with no instructions of the plugin's own.
  await ownTurn($, clock)
  expect(await bandText($)).toBe('h⣿ Cache Bell: compacting…')
  await clock.advance(S)
  expect(seen.did.length).toBe(4)
  expect(seen.did[3]).toMatch(/^compact\[\w+\]: $/)
  expect(await status($)).toMatch(/State: dormant/)
  // Who comes back sees what was done: twelve minutes after their last message.
  expect(await bandText($)).toBe('h⣿ Cache Bell: compacted 144k → 21k tokens after 12 min idle · /bell log')
  // The log says what it was: the cache's course, with a question nobody answered.
  expect(logged(seen)).toMatchObject([{ why: 'cache', by: 'timer', session: 'abcd1234', before: 143985, after: 21400, note: '' }])

  // Dormant: nothing more happens however long it takes.
  await clock.advance(600 * S)
  expect(seen.did.length).toBe(4)
})

test('each answer to the real question is carried out', async ($, on) => {
  const { clock, seen } = await idle($, on)
  await clock.advance(210 * S)

  // 3 and Enter: let it expire. Nothing is sent, the band says so, and the cache goes cold in time.
  await edit($, '', 0, 0, '3')
  expect(await enter($, '3')).toEqual({ drop: 'cache-bell: Let it expire' })
  expect(await bandText($)).toBe('h⣿ Cache Bell: prompt cache expires in 1:05 · nothing will be done')
  await clock.advance(65 * S)
  expect(await bandText($)).toBe('h⣿ Cache Bell: prompt cache expired · the next message re-sends 144k tokens uncached')
  expect(seen.did).toEqual([])

  // Work again, idle again: this time a click on Compact.
  await turn($, clock, 0)
  await clock.advance(210 * S)
  const ui = await $.ui.mount(abovePrompt())
  await ui.press({ key: 'compact' })
  await ui.unmount()
  expect(seen.did).toEqual(['prepare'])
  await ownTurn($, clock)
  await clock.advance(S)
  expect(seen.did.length).toBe(2)
  expect(await status($)).toMatch(/State: dormant/)
})

test('a message from the person closes the real question and starts the countdown over', async ($, on) => {
  const { clock, seen } = await idle($, on)
  await clock.advance(220 * S)
  expect((await question($)).text).toBe('h⣿ Cache Bell: Cache expires soon (144k tokens), 2 automatic renewals left, then compacts: No answer: Renew cache in 0:20')

  await enter($, 'hello')
  await turn($, clock, 0)
  expect(await bandText($)).toBe('h⣿ Cache Bell: prompt cache expires in 4:35')
  expect(seen.did).toEqual([])
  expect(seen.toasts).toEqual([])
})

test('a renewal that came too late leaves the cache cold and says so', async ($, on) => {
  const { clock, seen } = await idle($, on)
  answers.forkRead = 0
  await clock.advance(240 * S)
  expect(seen.did).toEqual(['fork'])
  expect(await bandText($)).toBe('h⣿ Cache Bell: prompt cache expired, the renewal came too late · the next message re-sends 144k tokens uncached')
  expect(seen.toasts).toEqual(['Renewing the prompt cache came too late: it had already expired. The next message re-sends the whole context uncached.'])
})

test('a small context is left alone', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const seen = stubs(on)
  answers.tokens = 12000
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await turn($, clock, 0)
  await clock.advance(274 * S)
  expect(await bandText($)).toBe('h⣿ Cache Bell: prompt cache expires in 0:01')
  expect(seen.did).toEqual([])
})

test('a compaction that is refused leaves the cache cold', { options: { mode: 'compact-only' } }, async ($, on) => {
  const { clock, seen } = await idle($, on)
  answers.compactSkip = true
  await clock.advance(241 * S)
  expect(seen.did.length).toBe(1)
  expect(await status($)).toMatch(/State: cold, compaction failed/)
})


test('with the limit of the manifest an hour-long cache shows its countdown from 30 minutes left', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  stubs(on, {}, `${ASSISTANT_1H}\n`)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await turn($, clock, 0)
  await $.classic.Stop({ transcript_path: '/work/session.jsonl', stop_hook_active: false })
  expect(await bandText($)).toBe('drawn by Claude Code')
  await clock.advance(1499 * S)
  expect(await bandText($)).toBe('drawn by Claude Code')
  await clock.advance(S)
  expect(await bandText($)).toBe('h⣿ Cache Bell: prompt cache expires in 30 min')
})

test('the mark wears the brand colours in the band, whatever the tone of the line', { options: { mode: 'custom', ask: 'never', renewMethod: 'none', compact: false } }, async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  stubs(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await turn($, clock, 0)
  const drawn = async () => {
    const ui = await $.ui.mount(abovePrompt())
    const line = await ui.find({ type: 'Text' })
    await ui.unmount()
    return runsOf(line).map(run => [flat(run), run.props?.color, run.props?.bold === true, run.props?.dimColor === true])
  }
  expect(await drawn()).toEqual([
    ['h', '#3aa3b3', true, false],
    ['⣿', '#7ad8f8', true, false],
    // the name in the plain colour, then the message in the tone of the moment
    [' Cache Bell:', undefined, true, false],
    [' prompt cache expires in 4:35', undefined, false, true],
  ])
  await clock.advance(210 * S)
  expect((await drawn())[3]).toEqual([' prompt cache expires in 1:05', 'yellow', false, false])
  await clock.advance(65 * S)
  expect((await drawn()).map(run => run[1])).toEqual(['#3aa3b3', '#7ad8f8', undefined, 'cyan'])
})

// --- the session asks for a compaction ---

// A turn of the main thread in which Claude calls the plugin's tool, as the compact skill tells it to.
const askingTurn = async ($: Engine, clock: Clock): Promise<string> => {
  await $.turn.start({ text: 'wrap up', turnId: 't' })
  const stream = $.turn.step({ turnId: 't', index: 0, model: 'claude-test', messageCount: 1 })
  let step = await stream.next()
  while (step.done !== true) step = await stream.next()
  const called = (await $.tool.call({ tool: 'mcp__cache-bell__compact', reason: 'the task is done' } as never)) as { result?: unknown }
  await $.turn.complete({ turnId: 't', answer: 'note', durationMs: 0, isAborted: false, reason: 'answer' })
  await clock.settle()
  return String(called.result)
}

test('a session that asks is answered, and the person gets the countdown to cancel', { options: { compactCountdown: 30 } }, async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const seen = stubs(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  expect(await askingTurn($, clock)).toMatch(/^Compaction requested\. When this turn ends the user is asked and has up to 30 seconds to cancel/)

  expect(await question($)).toMatchObject({
    text: 'h⣿ Cache Bell: The session asked for a compaction: No answer: Compact in 0:30',
    labels: ['[1] >Compact<', '[2]  Not now '],
    selected: ['[1] >Compact<'],
  })

  // No answer: the compaction runs, with no announcement: the session asked for it itself.
  await clock.advance(31 * S)
  expect(seen.did.length).toBe(1)
  expect(seen.did[0]).toMatch(/^compact\[\w+\]: $/)
  expect(await status($)).toMatch(/State: dormant/)
  // The log keeps what the session said, and that nobody answered.
  expect(logged(seen)).toMatchObject([{ why: 'session', by: 'timer', before: 143985, after: 21400, note: 'the task is done' }])
  const report = ((await run($, 'log')).text ?? '').split('\n')
  expect(report[0]).toBe('Compactions, the last 1 of 1 kept:')
  expect(report[1]).toMatch(/ {2}143 985 → 21 400 tokens · the session asked, no answer · session abcd1234 · "the task is done"$/)
})

test('the log tells the person who said yes from the timer, and keeps a /compact and Claude Code\'s own', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const seen = stubs(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  expect((await run($, 'log')).text).toBe('No compaction has been logged yet.')
  await askingTurn($, clock)
  await edit($, '', 0, 0, '1')
  await enter($, '1')
  await clock.advance(2 * S)
  expect(logged(seen)).toMatchObject([{ why: 'session', by: 'person', note: 'the task is done' }])

  // A /compact of the person's own, and one Claude Code ran because the context was full.
  await clock.advance(60 * S)
  await $.session.compact({ trigger: 'manual', messages: SUMMARY })
  await clock.advance(60 * S)
  await $.session.compact({ trigger: 'auto', messages: SUMMARY })
  expect(logged(seen).slice(1)).toMatchObject([
    { why: 'manual', by: 'person', before: 143985, after: 21400, note: '' },
    { why: 'auto', by: 'claude-code', note: '' },
  ])
  // A subagent's compaction and a precompute are not the conversation's.
  await $.session.compact({ trigger: 'auto', agentId: 'agent-1', messages: SUMMARY })
  await $.session.compact({ trigger: 'precompute', messages: SUMMARY })
  expect(logged(seen).length).toBe(3)
  expect(((await run($, 'log 2')).text ?? '').split('\n').length).toBe(3)
})

test('the person can drop what the session asked for', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const seen = stubs(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await askingTurn($, clock)
  // Three minutes when nothing else is set.
  expect((await question($)).text).toBe('h⣿ Cache Bell: The session asked for a compaction: No answer: Compact in 0:30')
  await edit($, '', 0, 0, '2')
  expect(await enter($, '2')).toEqual({ drop: 'cache-bell: Not now' })
  await clock.advance(200 * S)
  expect(seen.did).toEqual([])
  expect(await status($)).toMatch(/State: warm/)
})

test('set to auto the compaction follows the turn at once; set to off the session is refused', { options: { sessionCompact: 'auto' } }, async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const seen = stubs(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  expect(await askingTurn($, clock)).toMatch(/^Compaction requested\. The conversation will be compacted right after this turn ends/)
  expect(await bandText($)).toBe('h⣿ Cache Bell: compacting…')
  await clock.advance(S)
  expect(seen.did.length).toBe(1)
  expect(await status($)).toMatch(/State: dormant/)
})

test('set to off the session is refused and nothing happens', { options: { sessionCompact: 'off' } }, async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const seen = stubs(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  expect(await askingTurn($, clock)).toMatch(/^Refused: /)
  await clock.advance(200 * S)
  expect(seen.did).toEqual([])
  expect(await status($)).toMatch(/State: warm/)
})

test('/bell show holds the band in a look for a screenshot, and off puts the real one back', { options: { mode: 'custom', ask: 'never', renewMethod: 'none', compact: false } }, async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const seen = stubs(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  // Before any turn the real band shows nothing; a look shows at once.
  expect((await run($, 'show calm')).text).toBe('Showing the band as "calm". /bell show off puts the real one back.')
  expect(await bandText($)).toBe('h⣿ Cache Bell: prompt cache expires in 42 min')
  await run($, 'show act')
  expect(await bandText($)).toBe('h⣿ Cache Bell: prompt cache expires in 4:10')
  await run($, 'show cold')
  expect(await bandText($)).toBe('h⣿ Cache Bell: prompt cache expired · the next message re-sends 144k tokens uncached')

  // The look stays whatever the cache does, and sends nothing.
  await turn($, clock, 0)
  await clock.advance(100 * S)
  expect(await bandText($)).toBe('h⣿ Cache Bell: prompt cache expired · the next message re-sends 144k tokens uncached')
  expect((await run($, 'show off')).text).toBe('The band shows the real state again.')
  expect(await bandText($)).toBe('h⣿ Cache Bell: prompt cache expires in 2:55')
  expect((await run($, 'show nonsense')).text).toBe('Usage: /bell show calm | act | cold | intro | off')
  expect(seen.did).toEqual([])
})

test('instructions of the person\'s own go to the compaction with the time and the idle minutes filled in', { options: { mode: 'compact-only', compactInstructions: 'Idle {idle} min at {time}.' } }, async ($, on) => {
  const { clock, seen } = await idle($, on)
  await clock.advance(241 * S)
  expect(seen.did.length).toBe(1)
  expect(seen.did[0]).toMatch(/^compact\[\w+\]: Idle 4 min at \d{4}-\d\d-\d\d \d\d:\d\d UTC\.$/)
})

// --- the plugin built on this one runs in the same session ---

test('with the plugin built on it already running, this one does nothing from the start', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const seen = stubs(on)
  answers.isSuperseded = true
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  // Neither the command nor the tool is registered: the other plugin has its own.
  expect(seen.commands).toEqual([])

  await turn($, clock, 0)
  await clock.advance(400 * S)
  expect(await bandText($)).toBe('drawn by Claude Code')
  expect(seen.did).toEqual([])
  expect(seen.toasts).toEqual([])
  expect(seen.logs).toEqual(['standing down: the plugin built on this one runs in the session'])
})

test('when the plugin built on it starts later, this one takes its question down and stands down', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const seen = stubs(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await turn($, clock, 0)
  await clock.advance(215 * S)
  expect((await question($)).text).toMatch(/^h⣿ Cache Bell: Cache expires soon \(144k tokens\), 2 automatic renewals left, then compacts: No answer: Renew cache in /)

  answers.isSuperseded = true
  await clock.advance(S)
  expect(await bandText($)).toBe('drawn by Claude Code')
  // Nothing is renewed, announced or compacted, and the cache running out is not this plugin's to report.
  await clock.advance(400 * S)
  expect(seen.did).toEqual([])
  expect(seen.toasts).toEqual([])
  expect(await bandText($)).toBe('drawn by Claude Code')

  // The session's tool says where to ask instead, and a new turn changes nothing.
  const called = (await $.tool.call({ tool: 'mcp__cache-bell__compact' } as never)) as { result?: unknown }
  expect(String(called.result)).toMatch(/^Refused: Cache Bell stands down in this session/)
  await turn($, clock, 0)
  await clock.advance(215 * S)
  expect(await bandText($)).toBe('drawn by Claude Code')
  expect(seen.did).toEqual([])
})

// --- the background ---

const inks = async ($: Engine) => {
  const ui = await $.ui.mount(abovePrompt())
  const line = await ui.find({ type: 'Text' })
  await ui.unmount()
  return runsOf(line).map(part => [flat(part), part.props?.color])
}

const WATCH = { mode: 'custom', ask: 'never', renewMethod: 'none', compact: false }

test('on a light theme the mark and the message wear the colours for a light background', { options: WATCH }, async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  stubs(on)
  answers.theme = 'light'
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await turn($, clock, 0)
  await clock.advance(210 * S)
  expect(await inks($)).toEqual([['h', '#073a44'], ['⣿', '#00697a'], [' Cache Bell:', undefined], [' prompt cache expires in 1:05', '#8a5a00']])
  await clock.advance(65 * S)
  expect((await inks($))[3]?.[1]).toBe('#005f73')

  // The person switches the theme in /config: the colours follow at once.
  await $.config.set({ key: 'theme', value: 'dark' } as never)
  expect((await inks($)).map(part => part[1])).toEqual(['#3aa3b3', '#7ad8f8', undefined, 'cyan'])
})

test('the question swings between the ambers for a light background', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  stubs(on)
  answers.theme = 'light'
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await run($, 'demo 30')
  expect((await question($)).color).toBe('#7a5c00')
  await clock.advance(S)
  expect((await question($)).color).toBe('#b36b00')
})

// --- an announcement or a compaction that does not go as planned ---

// Announces and compacts at the time to act, with no question and no renewal.
const ANNOUNCE = { mode: 'custom', ask: 'never', maxRenewals: 0, renewMethod: 'none', prepareBeforeCompact: true, compact: true }

test('an announcement the person interrupts is not followed by a compaction', { options: ANNOUNCE }, async ($, on) => {
  const { clock, seen } = await idle($, on)
  await clock.advance(240 * S)
  expect(seen.did).toEqual(['prepare'])
  expect(await bandText($)).toBe('h⣿ Cache Bell: announcing the compaction…')

  // Esc in the announcement's turn.
  await $.turn.start({ text: 'announcement', turnId: 'a' })
  await $.turn.complete({ turnId: 'a', answer: '', durationMs: 0, isAborted: true, reason: 'aborted' })
  await clock.settle()
  await clock.advance(20 * S)
  expect(seen.did).toEqual(['prepare'])
  expect(seen.toasts).toEqual(['The compaction was called off: its announcement did not finish.'])
  expect(await bandText($)).toMatch(/nothing will be done$/)
})

test('an announcement another plugin dropped leaves the conversation as it is', { options: ANNOUNCE }, async ($, on) => {
  const { clock, seen } = await idle($, on)
  answers.isAnnouncementDropped = true
  await clock.advance(240 * S)
  expect(seen.did).toEqual([])
  expect(seen.toasts).toEqual(['The compaction could not be announced to the session: nothing was compacted.'])
  expect(await bandText($)).toMatch(/nothing will be done$/)
  expect(await status($)).toMatch(/State: warm/)
  await clock.advance(600 * S)
  expect(seen.did).toEqual([])
})

test('a turn that begins in the second before the compaction takes it back', { options: ANNOUNCE }, async ($, on) => {
  const { clock, seen } = await idle($, on)
  await clock.advance(240 * S)
  await ownTurn($, clock)
  expect(await bandText($)).toBe('h⣿ Cache Bell: compacting…')

  // The person's message was waiting behind the announcement: its turn starts at once.
  await enter($, 'and one more thing')
  await $.turn.start({ text: 'and one more thing', turnId: 'u' })
  await clock.advance(5 * S)
  expect(seen.did).toEqual(['prepare'])
  expect(seen.toasts).toEqual([])
  expect(await status($)).toMatch(/State: busy/)
})

// The person typing: one key into the prompt box.
const key = ($: Engine) => edit($, 'and then fix th', 15, 15, 'e')

test('text that only lies in the prompt box holds nothing back', { options: ANNOUNCE }, async ($, on) => {
  const { clock, seen } = await idle($, on)
  await clock.advance(100 * S)
  await key($)
  await clock.advance(140 * S)
  expect(seen.did).toEqual(['prepare'])
})

test('a compaction waits while the person types and follows a minute after the last key', { options: ANNOUNCE }, async ($, on) => {
  const { clock, seen } = await idle($, on)
  await clock.advance(195 * S)
  await key($)
  await clock.advance(5 * S)
  await key($)
  await clock.advance(45 * S)
  expect(seen.did).toEqual([])
  expect(await bandText($)).toBe('h⣿ Cache Bell: prompt cache expires in 0:30 · compaction waits for you to finish typing')
  expect(await status($)).toContain('Compaction waits for you to finish typing')

  // 4:19, less than a minute since the last key at 3:20; a second later the minute is over.
  await clock.advance(14 * S)
  expect(seen.did).toEqual([])
  await clock.advance(S)
  expect(seen.did).toEqual(['prepare'])
  await ownTurn($, clock)
  await clock.advance(S)
  expect(seen.did.length).toBe(2)
  expect(await status($)).toMatch(/State: dormant/)
})

test('a person who keeps typing until the cache runs out gets no compaction, and is told', { options: ANNOUNCE }, async ($, on) => {
  const { clock, seen } = await idle($, on)
  await clock.advance(230 * S)
  await key($)
  await clock.advance(45 * S)
  expect(seen.did).toEqual([])
  expect(seen.toasts).toEqual(['The compaction waited for your typing or a running subagent until the prompt cache ran out: nothing was compacted. The next message re-sends the whole context uncached.'])
  expect(await bandText($)).toBe('h⣿ Cache Bell: prompt cache expired, the compaction was postponed · the next message re-sends 144k tokens uncached')
  await clock.advance(120 * S)
  expect(seen.did).toEqual([])
})

test('a compaction waits for a subagent that still runs and follows once it is done', { options: ANNOUNCE }, async ($, on) => {
  const { clock, seen } = await idle($, on)
  answers.agents = ['completed', 'running']
  await clock.advance(250 * S)
  expect(seen.did).toEqual([])
  expect(await bandText($)).toBe('h⣿ Cache Bell: prompt cache expires in 0:25 · compaction waits for a running subagent')

  answers.agents = ['completed', 'completed']
  await clock.advance(S)
  expect(seen.did).toEqual(['prepare'])
})

// On an hour-long cache five minutes lie between the time to act (50 min) and the last safe moment. The
// session starts a few seconds before the time to act, so the test does not tick through the hour.
test('a key pressed while the compaction is announced holds it back, with no second announcement', { options: { ...ANNOUNCE, ttl: '1h' } }, async ($, on) => {
  const clock = mock.clock(on, { now: T0 + 2995 * S })
  const seen = stubs(on)
  answers.stored = leftBehind({ phase: 'WARM', ttlMs: 3600 * S, ttlSource: 'config', isAsked: false })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await clock.advance(5 * S)
  expect(seen.did).toEqual(['prepare'])
  await key($)
  await ownTurn($, clock)
  await clock.advance(5 * S)
  expect(seen.did).toEqual(['prepare'])
  expect(await bandText($)).toMatch(/compaction waits for you to finish typing$/)
  // A minute after the key the way is clear: the compaction, and nothing said twice.
  await clock.advance(60 * S)
  expect(seen.did.length).toBe(2)
  expect(seen.did[1]).toMatch(/^compact\[/)
})

test('a subagent that starts in the second before the compaction holds it back', { options: ANNOUNCE }, async ($, on) => {
  const { clock, seen } = await idle($, on)
  await clock.advance(240 * S)
  await ownTurn($, clock)
  expect(await bandText($)).toBe('h⣿ Cache Bell: compacting…')
  answers.agents = ['running']
  await clock.advance(3 * S)
  expect(seen.did).toEqual(['prepare'])
  expect(await bandText($)).toMatch(/compaction waits for a running subagent$/)

  // It is done: the compaction follows, and the session is not told twice.
  answers.agents = ['completed']
  await clock.advance(2 * S)
  expect(seen.did.length).toBe(2)
  expect(seen.did[1]).toMatch(/^compact\[/)
})

test('the person who answers Compact gets it, whatever stands in the way', async ($, on) => {
  const { clock, seen } = await idle($, on)
  answers.agents = ['running']
  await clock.advance(210 * S)
  await key($)
  const ui = await $.ui.mount(abovePrompt())
  await ui.press({ key: 'compact' })
  await ui.unmount()
  expect(seen.did).toEqual(['prepare'])
  // The subagent still runs and the key is seconds old: the announcement and the compaction go through.
  await ownTurn($, clock)
  await clock.advance(S)
  expect(seen.did.length).toBe(2)
  expect(seen.did[1]).toMatch(/^compact\[/)
  expect(logged(seen)).toMatchObject([{ why: 'cache', by: 'person' }])
})

test('a digit that selects a choice is an answer, not typing', { options: { mode: 'custom', ask: 'first', maxRenewals: 0, renewMethod: 'none', prepareBeforeCompact: false, sessionCompact: 'auto' } }, async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const seen = stubs(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  // A demo question: a digit, a second digit over it, and the digit taken back.
  await run($, 'demo 30')
  await edit($, '', 0, 0, '2')
  await edit($, '2', 1, 1, '3')
  await edit($, '3', 0, 1, '')
  await clock.advance(31 * S)
  // What the session asks for right after is not held back as if the person were typing.
  await askingTurn($, clock)
  await clock.advance(2 * S)
  expect(seen.did.length).toBe(1)
  expect(seen.did[0]).toMatch(/^compact\[/)
})

test('a list of subagents that cannot be read is said once, and typing still holds a compaction back', { options: ANNOUNCE }, async ($, on) => {
  const { clock, seen } = await idle($, on)
  answers.isListBroken = true
  await clock.advance(230 * S)
  await key($)
  await clock.advance(30 * S)
  expect(seen.did).toEqual([])
  expect(await bandText($)).toMatch(/compaction waits for you to finish typing$/)
  expect(seen.logs.length).toBe(1)
  expect(seen.logs[0]).toMatch(/^subagents not listed, a compaction will not wait for them: /)
  // asked once when the turn ended, and once more when it failed
  expect(answers.listed).toBe(2)
})

test('a compaction that waited for typing when the plugin was loaded again waits a minute more', { options: ANNOUNCE }, async ($, on) => {
  const clock = mock.clock(on, { now: T0 + 200 * S })
  const seen = stubs(on)
  answers.stored = leftBehind({ phase: 'WARM', held: { by: 'typing', isTold: false } })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await clock.advance(59 * S)
  expect(seen.did).toEqual([])
  await clock.advance(2 * S)
  expect(seen.did).toEqual(['prepare'])
})

test('what the session asked for and a subagent held back is done after the turn that brings the result', { options: { sessionCompact: 'auto' } }, async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const seen = stubs(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  answers.agents = ['running']
  await askingTurn($, clock)
  await clock.advance(250 * S)
  // The cache was renewed meanwhile, and the compaction still waits.
  expect(seen.did).toEqual(['fork'])
  expect(await status($)).toContain('Compaction waits for a running subagent')

  // The subagent is done: its result starts a turn of the session, and the compaction follows that turn.
  answers.agents = ['completed']
  await $.prompt.submit({ text: 'task result', wait: false, origin: { kind: 'task-notification' } } as never)
  await turn($, clock, 0, undefined, false)
  await clock.advance(2 * S)
  expect(seen.did.length).toBe(2)
  expect(seen.did[1]).toMatch(/^compact\[/)
  expect(logged(seen)).toMatchObject([{ why: 'session', by: 'plugin', note: 'the task is done' }])
})

test('a key pressed while the question is up means the timer compacts nothing under the person', { options: { mode: 'custom', ask: 'first', maxRenewals: 0, renewMethod: 'none' } }, async ($, on) => {
  const { clock, seen } = await idle($, on)
  await clock.advance(210 * S)
  expect((await question($)).selected).toEqual(['[1] >Compact<'])
  await clock.advance(10 * S)
  await key($)
  // The time runs out at 4:00; the minute after the key ends past the cache's last safe moment.
  await clock.advance(20 * S)
  expect(seen.did).toEqual([])
  expect(await bandText($)).toMatch(/compaction waits for you to finish typing$/)
  await clock.advance(35 * S)
  expect(seen.did).toEqual([])
  expect(await status($)).toContain('State: cold, compaction postponed')
})

test('what the session asked for waits while its subagent still runs', { options: { sessionCompact: 'auto' } }, async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const seen = stubs(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  answers.agents = ['running']
  await askingTurn($, clock)
  await clock.advance(5 * S)
  expect(seen.did).toEqual([])
  expect(await status($)).toContain('Compaction waits for a running subagent')

  answers.agents = ['completed']
  await clock.advance(2 * S)
  expect(seen.did.length).toBe(1)
  expect(seen.did[0]).toMatch(/^compact\[/)
  expect(logged(seen)).toMatchObject([{ why: 'session', by: 'plugin' }])
})

test('the subagents are asked about only when a compaction could start', { options: ANNOUNCE }, async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  stubs(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await clock.advance(30 * S)
  expect(answers.listed).toBe(0)
  await turn($, clock, 0)
  // Once when the turn ended, then not for the four minutes until the time to act.
  await clock.advance(239 * S)
  expect(answers.listed).toBe(1)
  await clock.advance(S)
  expect(answers.listed).toBe(2)
})

test('a compaction that fails with an error leaves the cache cold, says so and logs nothing', { options: { mode: 'compact-only' } }, async ($, on) => {
  const { clock, seen } = await idle($, on)
  answers.isCompactBroken = true
  await clock.advance(241 * S)
  expect(seen.did.length).toBe(1)
  expect(seen.toasts).toEqual(['The compaction did not go through and the prompt cache has run out. The next message re-sends the whole context uncached.'])
  expect(await status($)).toContain('State: cold, compaction failed')
  expect(logged(seen)).toEqual([])
  expect(seen.logs.length).toBe(1)
  expect(seen.logs[0]).toMatch(/^compaction failed: /)
  // Nothing is tried again.
  await clock.advance(600 * S)
  expect(seen.did.length).toBe(1)
})

test('a log that cannot be written does not stand in the way of the compaction', { options: { mode: 'compact-only' } }, async ($, on) => {
  const { clock, seen } = await idle($, on)
  answers.isStoreBroken = true
  await clock.advance(241 * S)
  expect(seen.did.length).toBe(1)
  expect(await status($)).toMatch(/State: dormant/)
  expect(seen.toasts).toEqual([])
  expect(seen.logs.length).toBe(1)
  expect(seen.logs[0]).toMatch(/^compaction not logged: /)
})

test('the log keeps its newest 200 entries and leaves the rest of the store alone', { options: { mode: 'compact-only' } }, async ($, on) => {
  const { clock, seen } = await idle($, on)
  const old = Array.from({ length: 200 }, (_, at) => `log:2025-12-01T00:${String(Math.floor(at / 60)).padStart(2, '0')}:${String(at % 60).padStart(2, '0')}.000Z:aaaaaaaa`)
  for (const key of old) seen.store.set(key, { why: 'manual' })
  await clock.advance(241 * S)
  const keys = [...seen.store.keys()]
  expect(keys.filter(key => key.startsWith('log:')).length).toBe(200)
  expect(keys).not.toContain(old[0])
  expect(keys).toContain(old[1])
  expect(keys).toContain('intro')
  expect(keys.some(key => key.startsWith('log:2026-01-12T09:04:01') && key.endsWith(':abcd1234'))).toBe(true)
})

test('in the notify mode nothing is ever sent: no renewal, no announcement, no compaction', { options: { mode: 'notify' } }, async ($, on) => {
  const { clock, seen } = await idle($, on)
  await clock.advance(210 * S)
  expect((await question($)).labels).toEqual(['[1]  Compact ', '[2]  Renew cache ', '[3] >Let it expire<'])
  await clock.advance(300 * S)
  expect(seen.did).toEqual([])
  expect(await status($)).toContain('State: cold, expired')
})

test('set to wait, what the session asked for is done only when the person says so', { options: { sessionCompact: 'wait' } }, async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const seen = stubs(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  expect(await askingTurn($, clock)).toBe('Compaction requested. When this turn ends the user is asked; this request compacts the conversation only if they say so. End this turn now and call no more tools.')
  expect(await question($)).toMatchObject({
    text: 'h⣿ Cache Bell: The session asked for a compaction: No answer: Not now in 3:30',
    selected: ['[2] >Not now<'],
  })
  // Nobody answers until the cache's own course takes over, with its own question: the request is dropped.
  await clock.advance(211 * S)
  expect((await question($)).text).toMatch(/^h⣿ Cache Bell: Cache expires soon \(144k tokens\), 2 automatic renewals left, then compacts: /)
  await clock.advance(30 * S)
  expect(seen.did).toEqual(['fork'])
  expect(logged(seen)).toEqual([])
})

test('the session may name the countdown of its request; without one the option decides', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const seen = stubs(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.turn.start({ text: 'wrap up', turnId: 't' })
  const stream = $.turn.step({ turnId: 't', index: 0, model: 'claude-test', messageCount: 1 })
  let step = await stream.next()
  while (step.done !== true) step = await stream.next()
  const called = (await $.tool.call({ tool: 'mcp__cache-bell__compact', reason: 'done', countdown: 45 } as never)) as { result?: unknown }
  expect(String(called.result)).toMatch(/has up to 45 seconds to cancel/)
  await $.turn.complete({ turnId: 't', answer: 'ok', durationMs: 0, isAborted: false, reason: 'answer' })
  await clock.settle()
  expect((await question($)).text).toBe('h⣿ Cache Bell: The session asked for a compaction: No answer: Compact in 0:45')
  await clock.advance(46 * S)
  expect(seen.did.length).toBe(1)
  expect(seen.did[0]).toMatch(/^compact\[/)

  // The next request names none: 30 seconds.
  await turn($, clock, 0)
  expect(await askingTurn($, clock)).toMatch(/has up to 30 seconds to cancel/)
  expect((await question($)).text).toBe('h⣿ Cache Bell: The session asked for a compaction: No answer: Compact in 0:30')
})

test('a turn nobody is known to have sent does not start the count of renewals over', { options: { mode: 'keep' } }, async ($, on) => {
  const { clock, seen } = await idle($, on)
  await clock.advance(3 * 240 * S)
  expect(seen.did).toEqual(['fork', 'fork', 'fork'])

  // A turn with no message of the person before it (a background task's result): the cache is warm again,
  // and still nothing more is renewed.
  await turn($, clock, 0, undefined, false)
  await clock.advance(600 * S)
  expect(seen.did).toEqual(['fork', 'fork', 'fork'])
  expect(await bandText($)).toBe('h⣿ Cache Bell: prompt cache expired after 3 renewals · the next message re-sends 144k tokens uncached')

  // The person's own message does.
  await turn($, clock, 0)
  await clock.advance(240 * S)
  expect(seen.did).toEqual(['fork', 'fork', 'fork', 'fork'])
})

test('notify with a waiting session request sends nothing at all without the person', { options: { mode: 'notify', sessionCompact: 'wait' } }, async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const seen = stubs(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await turn($, clock, 0)
  await askingTurn($, clock)
  expect((await question($)).selected).toEqual(['[2] >Not now<'])
  // The request waits, the cache's own question comes and goes, the cache runs out: nothing was sent.
  await clock.advance(211 * S)
  expect((await question($)).selected).toEqual(['[3] >Let it expire<'])
  await clock.advance(600 * S)
  expect(seen.did).toEqual([])
  expect(logged(seen)).toEqual([])
  expect(await status($)).toContain('State: cold, expired')
})

test('/bell reset puts back the options that differ from their defaults, and only those', async ($, on) => {
  mock.clock(on, { now: T0 })
  stubs(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  expect((await run($, 'reset')).text).toBe('Every option already has its default.')

  answers.rows = {
    'cache-bell.mode': 'keep',
    'cache-bell.maxRenewals': 2,
    'cache-bell.compactCountdown': 180,
    'cache-bell.enabled': false,
    'cache-bell.ttl': '1h',
    'other-plugin.mode': 'keep',
  }
  expect((await run($, 'reset')).text).toBe('Put back to the default: enabled, mode, compactCountdown.\nNot changed, Claude Code refused: ttl.')
  expect(answers.sets).toEqual(['cache-bell.enabled=true', 'cache-bell.mode=prepare-compact', 'cache-bell.compactCountdown=30'])
  expect(answers.rows['other-plugin.mode']).toBe('keep')
})

// A turn another session's message starts: its prompt comes in with an origin that is not the person's.
const otherTurn = async ($: Engine, clock: Clock, lastsMs: number) => {
  await $.prompt.submit({ text: 'a message from another session', wait: false, origin: { kind: 'peer' } } as never)
  await turn($, clock, lastsMs, undefined, false)
}

test('a message from another session only interrupts the question about what Claude asked for', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const seen = stubs(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await turn($, clock, 0)
  await askingTurn($, clock)
  expect((await question($)).text).toBe('h⣿ Cache Bell: The session asked for a compaction: No answer: Compact in 0:30')

  // Ten seconds in, another session writes: the question goes for the length of that turn.
  await clock.advance(10 * S)
  await otherTurn($, clock, 5 * S)
  await clock.settle()
  expect(seen.did).toEqual([])
  expect((await question($)).text).toBe('h⣿ Cache Bell: The session asked for a compaction: No answer: Compact in 0:20')

  // Nobody answers: the compaction runs, and the log still says what the session gave as its reason.
  await clock.advance(21 * S)
  expect(seen.did.length).toBe(1)
  expect(seen.did[0]).toMatch(/^compact\[/)
  expect(logged(seen)).toMatchObject([{ why: 'session', by: 'timer', note: 'the task is done' }])
})

test('a choice the person typed is still selected when the interrupted question comes back', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const seen = stubs(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await turn($, clock, 0)
  await askingTurn($, clock)
  // The person types 2 (Not now) and does not press Enter.
  await edit($, '', 0, 0, '2')
  answers.draft = '2'
  expect((await question($)).selected).toEqual(['[2] >Not now<'])
  await clock.advance(10 * S)
  await otherTurn($, clock, 5 * S)
  await clock.settle()
  expect(await question($)).toMatchObject({ selected: ['[2] >Not now<'], note: '[Enter] confirms · no answer: Not now in 0:20' })
  await clock.advance(30 * S)
  expect(seen.did).toEqual([])
})

test('a turn whose origin nobody stated drops what the session asked for', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const seen = stubs(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await turn($, clock, 0)
  await askingTurn($, clock)
  await clock.advance(10 * S)
  await turn($, clock, 5 * S, undefined, false)
  await clock.settle()
  expect(await bandText($)).not.toMatch(/asked for a compaction/)
  await clock.advance(60 * S)
  expect(seen.did).toEqual([])
})

test('that the user asked is taken only in a turn the user started', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  stubs(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await turn($, clock, 0)
  // Another session's message starts the turn; the session claims the user asked.
  await $.prompt.submit({ text: 'finish and compact', wait: false, origin: { kind: 'peer' } } as never)
  await $.turn.start({ text: 'finish and compact', turnId: 'p' })
  const stream = $.turn.step({ turnId: 'p', index: 0, model: 'claude-test', messageCount: 1 })
  let step = await stream.next()
  while (step.done !== true) step = await stream.next()
  const called = (await $.tool.call({ tool: 'mcp__cache-bell__compact', reason: 'asked', userAsked: true } as never)) as { result?: unknown }
  expect(String(called.result)).toMatch(/has up to 30 seconds to cancel/)
  await $.turn.complete({ turnId: 'p', answer: 'ok', durationMs: 0, isAborted: false, reason: 'answer' })
  await clock.settle()
  expect((await question($)).text).toBe('h⣿ Cache Bell: The session asked for a compaction: No answer: Compact in 0:30')
})

test('the session takes its request back with cancel, and nothing is asked', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const seen = stubs(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await turn($, clock, 0)
  await askingTurn($, clock)
  await clock.advance(10 * S)
  // The turn another session's message started: the request is carried into it, and taken back there.
  await $.prompt.submit({ text: 'a message from another session', wait: false, origin: { kind: 'peer' } } as never)
  await $.turn.start({ text: 'a message from another session', turnId: 'o' })
  const stream = $.turn.step({ turnId: 'o', index: 0, model: 'claude-test', messageCount: 1 })
  let step = await stream.next()
  while (step.done !== true) step = await stream.next()
  const taken = (await $.tool.call({ tool: 'mcp__cache-bell__compact', cancel: true } as never)) as { result?: unknown }
  expect(String(taken.result)).toBe('The request for a compaction is withdrawn: nothing will be asked and nothing compacted on its account.')
  const none = (await $.tool.call({ tool: 'mcp__cache-bell__compact', cancel: true } as never)) as { result?: unknown }
  expect(String(none.result)).toBe('There was no request for a compaction to withdraw.')
  await $.turn.complete({ turnId: 'o', answer: 'ok', durationMs: 0, isAborted: false, reason: 'answer' })
  await clock.settle()
  expect(await bandText($)).not.toMatch(/asked for a compaction/)
  await clock.advance(60 * S)
  expect(seen.did).toEqual([])
  expect(logged(seen)).toEqual([])
})

test('what the user asked the session for is compacted after three seconds', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const seen = stubs(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await turn($, clock, 0)
  // The person types the message and sends it: that typing is over, and holds nothing back.
  await key($)
  await $.prompt.submit({ text: 'finish this and compact', wait: false, origin: { kind: 'composer' } })
  await $.turn.start({ text: 'finish this and compact', turnId: 't' })
  const stream = $.turn.step({ turnId: 't', index: 0, model: 'claude-test', messageCount: 1 })
  let step = await stream.next()
  while (step.done !== true) step = await stream.next()
  const called = (await $.tool.call({ tool: 'mcp__cache-bell__compact', reason: 'you asked', userAsked: true, countdown: 120 } as never)) as { result?: unknown }
  expect(String(called.result)).toMatch(/has up to 3 seconds to cancel/)
  await $.turn.complete({ turnId: 't', answer: 'ok', durationMs: 0, isAborted: false, reason: 'answer' })
  await clock.settle()
  expect((await question($)).text).toBe('h⣿ Cache Bell: The session asked for a compaction: No answer: Compact in 0:03')
  await clock.advance(2 * S)
  expect(seen.did).toEqual([])
  await clock.advance(2 * S)
  expect(seen.did.length).toBe(1)
  expect(seen.did[0]).toMatch(/^compact\[/)
})

test('a subagent cannot ask for the compaction of the main conversation', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const seen = stubs(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.turn.start({ text: 'work', turnId: 't' })
  const called = (await $.tool.call({ tool: 'mcp__cache-bell__compact', agentId: 'agent-1' } as never)) as { result?: unknown }
  expect(String(called.result)).toMatch(/^Refused: only the main conversation can ask for a compaction/)
  await $.turn.complete({ turnId: 't', answer: 'done', durationMs: 0, isAborted: false, reason: 'answer' })
  await clock.settle()
  expect(await bandText($)).toBe('drawn by Claude Code')
  expect(seen.did).toEqual([])
})

// --- the first-run notice ---

const introDrawn = async ($: Engine) => {
  const ui = await $.ui.mount(abovePrompt())
  const drawn = flat(await ui.drawn())
  const button = await ui.find({ key: 'intro-ok' })
  await ui.unmount()
  return { drawn, hasButton: button !== undefined }
}

test('the first time on a machine the band says what the plugin does without the person', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const seen = stubs(on)
  seen.store.clear()
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const shown = await introDrawn($)
  expect(shown.hasButton).toBe(true)
  expect(shown.drawn).toBe(
    [
      'h⣿ Cache Bell: while you are away this plugin acts on its own, on your plan',
      'before the prompt cache expires it renews the prompt cache up to 2 times, then compacts the conversation',
      'Claude may ask for a compaction too: you get 30 s to cancel, or the time Claude names',
      'this notice is shown once: OK or your next message puts it away for good',
      'change it in /config: cache-bell.mode, cache-bell.sessionCompact, cache-bell.enabled',
    ].join(''),
  )
  // Not yet seen: closing the session now shows it again next time.
  expect(seen.store.get('intro')).toBe(undefined)

  // The first message the person sends takes it down and it is remembered as seen.
  await enter($, 'hello')
  await turn($, clock, 0)
  expect(seen.store.get('intro')).toBe(1)
  expect(await bandText($)).toBe('h⣿ Cache Bell: prompt cache expires in 4:35')
})

test('OK takes the notice down, and a machine that has seen it is not told again', async ($, on) => {
  mock.clock(on, { now: T0 })
  const seen = stubs(on)
  seen.store.clear()
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const ui = await $.ui.mount(abovePrompt())
  await ui.press({ key: 'intro-ok' })
  await ui.unmount()
  expect(seen.store.get('intro')).toBe(1)
  expect(await bandText($)).toBe('drawn by Claude Code')

  // /bell show intro puts it up again, for a look; a question stands over it, and show off takes it down.
  await run($, 'show intro')
  expect((await introDrawn($)).hasButton).toBe(true)
  await run($, 'demo 30')
  expect((await question($)).text).toMatch(/^h⣿ Cache Bell: Cache expires soon: No answer: Compact in 0:30/)
  expect((await introDrawn($)).hasButton).toBe(false)
  await run($, 'show off')
  await run($, 'show intro')
  await run($, 'show off')
  expect(await bandText($)).toBe('drawn by Claude Code')
})

test('a machine that has seen the notice starts without it', async ($, on) => {
  mock.clock(on, { now: T0 })
  stubs(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  expect(await bandText($)).toBe('drawn by Claude Code')
})
