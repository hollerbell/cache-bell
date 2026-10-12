import type { On, SessionMessage } from 'claude-code'
import { expect, mock, test as kitTest } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { HOUR_NOT_GRANTED, initialState } from '../../core/decide'
import type { State } from '../../core/types'
import { UNNAMED, UNSEEN } from '../../core/view'
import { BASE, COMPACT_ONLY, KEEP, NOTIFY, configOf } from '../core/options'

// Every test starts from the options the core's tests start from, and names only what it changes.
const test = ((name: string, how: object | (() => unknown), body?: () => unknown) =>
  typeof how === 'function'
    ? kitTest(name, { options: BASE }, how as never)
    : kitTest(name, { ...how, options: { ...BASE, ...(how as { options?: object }).options } } as never, body as never)) as typeof kitTest

const S = 1000
// Simulated minutes run the plugin's timers second by second: a test that covers an hour or more takes a few
// seconds, and on a busy machine more than the 5 the kit gives a test.
const LONG = 30 * S
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

// What a response on the five-minute cache leaves in the transcript: the usual since Claude Code 2.1.293.
const ASSISTANT_5M = JSON.stringify({
  type: 'assistant',
  isSidechain: false,
  message: { usage: { cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 900 } } },
})

const SUMMARY: SessionMessage[] = [{ role: 'user', text: 'Summary of the conversation so far.', toolUses: [] }]

type Seen = {
  envAsked: string[]
  // what the plugin wrote into the environment: 'NAME=value', or 'NAME unset'
  envSet: string[]
  // The input each tool call's row was drawn with.
  rows: unknown[]
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
const answers = { tailExit: 0, compactSkip: false, hasTranscript: true, forkRead: 143985, tokens: 143985, isSuperseded: false, theme: 'dark', isAnnouncementDropped: false, fork: 'answered' as 'answered' | 'unanswered' | 'throws', stored: null as State | null, agents: [] as string[], listed: 0, isListBroken: false, isStopBroken: false, isCompactBroken: false, isStoreBroken: false, rows: {} as Record<string, unknown>, sets: [] as string[], looked: 0, draft: '', grown: 0, appended: '', only: '', usages: 0, isUsageBroken: false, settings: {} as Record<string, unknown>, markGate: null as Promise<void> | null, takeOutGate: null as Promise<void> | null }

// Everything Claude Code would answer, so the mod's hooks run to their end.
const stubs = (on: On, env: Record<string, string> = { HOME: '/srv/jane' }, transcript = ASSISTANT_5M, size = 100): Seen => {
  const seen: Seen = { envAsked: [], envSet: [], rows: [], toasts: [], commands: [], processes: 0, argv: [], statuses: [], logs: [], fills: [], did: [], store: new Map<string, unknown>([['intro', 2]]) }
  answers.tailExit = 0
  answers.grown = 0
  answers.appended = ''
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
  answers.isStopBroken = false
  answers.only = ''
  answers.usages = 0
  answers.isUsageBroken = false
  answers.isCompactBroken = false
  answers.isStoreBroken = false
  answers.rows = {}
  answers.sets = []
  answers.looked = 0
  answers.draft = ''
  answers.settings = {}
  answers.markGate = null
  answers.takeOutGate = null
  // `answers.rows` are the plugin's own rows of /config, by key; a row named "locked" refuses a change.
  on('config.list', (() => ({
    value: [
      { key: 'theme', label: 'Theme', kind: 'enum', value: answers.theme, isLocked: false },
      ...Object.entries(answers.rows).map(([key, value]) => ({ key, label: key, kind: 'string', value, isLocked: false })),
    ],
  })) as never)
  on('config.set', (($: unknown, e: { key: string; value: string }) => {
    if (e.key === 'theme') answers.theme = e.value
    else if (e.key.endsWith('.cacheTtl')) return { deny: 'a managed setting' }
    else {
      answers.rows[e.key] = e.value
      answers.sets.push(`${e.key}=${String(e.value)}`)
    }
    return { value: e.value }
  }) as never)
  on('env.get', ($, e) => {
    seen.envAsked.push(e.name)
    return { value: env[e.name] }
  })
  // `answers.markGate`: setting the plugin's mark waits for it; `answers.takeOutGate`: taking the TTL out does.
  on('env.set', async ($, e) => {
    if (answers.markGate !== null && e.name === 'CACHE_BELL_PROMPT_CACHE_TTL' && e.value !== undefined) await answers.markGate
    if (answers.takeOutGate !== null && e.name === 'CLAUDE_CODE_PROMPT_CACHE_TTL' && e.value === undefined) await answers.takeOutGate
    if (e.value === undefined) delete env[e.name]
    else env[e.name] = e.value
    seen.envSet.push(e.value === undefined ? `${e.name} unset` : `${e.name}=${e.value}`)
    return { value: undefined }
  })
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
  on('settings.read', () => ({ value: answers.settings }))
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
  // `answers.only`: the one path that exists; '' = every path does. The path may arrive in the host's spelling.
  on('fs.exists', ($, e) => {
    answers.looked += 1
    return { value: answers.hasTranscript && (answers.only === '' || e.path.split('\\').join('/').endsWith(answers.only)) }
  })
  on('session.root', () => ({ value: '/work/my project' }))
  on('session.cwd', () => ({ value: '/work/my project/src' }))
  // The plugin's own manifest, or the session's transcript.
  on('fs.read', ($, e) => ({ value: e.path.endsWith('plugin.json') ? '{ "name": "cache-bell", "version": "0.1.0" }' : transcript + answers.appended }))
  on('process.run', ($, e) => {
    seen.processes += 1
    seen.argv.push([...e.argv])
    return { value: { exitCode: answers.tailExit, stdout: transcript, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('session.usage', () => {
    answers.usages += 1
    if (answers.isUsageBroken) throw new Error('no usage')
    return { value: { startedAt: 0, context: { tokens: answers.tokens, window: 200000, percent: 22 }, rateLimits: [] } }
  })
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
    if (e.origin.kind === 'plugin') seen.did.push(e.text.startsWith('Cache Bell: the compaction you asked for is done.') ? `wake: ${e.text}` : 'prepare')
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
  // Another plugin's Stop hook, below this one.
  on('classic.Stop', () => {
    if (answers.isStopBroken) throw new Error('another hook failed')
    return {}
  })
  on('classic.SessionStart', () => ({}))
  on('classic.PostModelSwitch', () => ({}))
  on('session.compact', ($, e) => {
    if (e.trigger !== 'manual' && e.trigger !== 'precompute' && e.trigger !== 'auto') seen.did.push(`compact[${String(e.trigger)}]: ${e.instructions ?? ''}`)
    if (answers.isCompactBroken) throw new Error('overloaded')
    return answers.compactSkip ? { skip: 'a hook said no' } : { messages: SUMMARY, tokensBefore: answers.tokens, tokensAfter: 21400 }
  })
  on('ui.render', (_, e) => {
    if (e.component === 'ToolUse') seen.rows.push((e.props as { input: unknown }).input)
    return { type: 'Text', props: {}, children: ['drawn by Claude Code'] }
  })
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

// One request of the main thread, in a turn that is already running.
const request = async ($: Engine) => {
  const stream = $.turn.step({ turnId: 't', index: 0, model: 'claude-test', messageCount: 1 })
  let step = await stream.next()
  while (step.done !== true) step = await stream.next()
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

// The status asked for while a turn runs: the command answers nothing and the plugin says it as a notice.
const busyStatus = async ($: Engine, seen: Seen): Promise<string> => {
  expect(await run($, 'status')).toEqual({})
  return seen.logs[seen.logs.length - 1] ?? ''
}

// The log of compactions as the store holds it, the oldest first.
const logged = (seen: Seen): unknown[] =>
  [...seen.store.entries()]
    .filter(([key]) => key.startsWith('log:'))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, entry]) => entry)

test('the band counts down from the last request and turns cold', { options: { idleAsk: 'never', idleRenewals: 0, idleCompact: 'off' }, timeoutMs: LONG }, async ($, on) => {
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

test('the TTL comes from the transcript when the turn stops', { options: { displayBelowMinutes: 0 } }, async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const seen = stubs(on, {}, `${ASSISTANT_1H}\n`)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await turn($, clock, 0)
  await $.classic.Stop({ transcript_path: '/work/session.jsonl', stop_hook_active: false })
  expect(await bandText($)).toBe('h⣿ Cache Bell: prompt cache expires in 55 min')
  expect(seen.processes).toBe(0)
  expect(await status($)).toMatch(/Cache TTL: 1h \(read from the transcript\)/)
})

test('a response written to the transcript after the Stop hook is read a few seconds later', { options: { displayBelowMinutes: 0 } }, async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  stubs(on, {}, '{"type":"user"}\n')
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await turn($, clock, 0)
  await $.classic.Stop({ transcript_path: '/work/session.jsonl', stop_hook_active: false })
  expect(await status($)).toContain('Cache TTL: 5m (assumed, not yet seen in the data)')
  // Nothing was appended yet: the first look finds the same file and waits for the next.
  await clock.advance(4 * S)
  expect(await status($)).toContain('Cache TTL: 5m (assumed, not yet seen in the data)')
  answers.appended = `${ASSISTANT_1H}\n`
  answers.grown = 500
  await clock.advance(10 * S)
  expect(await status($)).toMatch(/Cache TTL: 1h \(read from the transcript\)/)
  expect((await run($, 'report')).text).toContain('next try none')
})

test('the last of the late looks, half a minute on, still finds the response', { options: { displayBelowMinutes: 0 } }, async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  stubs(on, {}, '{"type":"user"}\n')
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await turn($, clock, 0)
  await $.classic.Stop({ transcript_path: '/work/session.jsonl', stop_hook_active: false })
  await clock.advance(20 * S)
  answers.appended = `${ASSISTANT_1H}\n`
  answers.grown = 500
  expect(await status($)).toContain('Cache TTL: 5m (assumed, not yet seen in the data)')
  await clock.advance(25 * S)
  expect(await status($)).toMatch(/Cache TTL: 1h \(read from the transcript\)/)
})

test('a transcript that grows with no response is read three more times after a turn, no more', { options: NOTIFY }, async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const seen = stubs(on, {}, '{"type":"user"}\n', LARGE)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await turn($, clock, 0)
  await $.classic.Stop({ transcript_path: '/work/session.jsonl', stop_hook_active: false })
  expect(seen.processes).toBe(1)
  for (let second = 1; second <= 120; second += 1) {
    answers.grown = second * 100
    await clock.advance(S)
  }
  expect(seen.processes).toBe(4)
  expect((await run($, 'report')).text).toContain('next try none')
})

test('where another Stop hook fails the transcript is still named, and a tick reads it', { options: { displayBelowMinutes: 0 } }, async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  stubs(on, {}, `${ASSISTANT_1H}\n`)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await turn($, clock, 0)
  answers.isStopBroken = true
  await $.classic.Stop({ transcript_path: '/work/session.jsonl', stop_hook_active: false }).catch(() => undefined)
  expect((await run($, 'report')).text).toContain('Transcript: path known yes')
  expect(await status($)).toContain('Cache TTL: 5m (assumed, not yet seen in the data)')
  // Past the time a hook is given, the read is done without the hook.
  await clock.advance(16 * S)
  expect(await status($)).toMatch(/Cache TTL: 1h \(read from the transcript\)/)
  expect((await run($, 'report')).text).toContain('next try none')
})

test('with reading the transcript switched off the file is never touched', { options: { displayBelowMinutes: 0, cacheTtl: 'settings' } }, async ($, on) => {
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

test('a transcript too large to read is read by its tail', { options: { displayBelowMinutes: 0 } }, async ($, on) => {
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

test('an hour named by the settings is a guess until a response in the transcript shows it', { options: { displayBelowMinutes: 0 }, timeoutMs: LONG }, async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const seen = stubs(on, { HOME: '/srv/jane', CLAUDE_CODE_PROMPT_CACHE_TTL: '1h' }, '{"type":"user"}\n')
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await turn($, clock, 0)
  await clock.advance(2 * S)
  expect(await status($)).toMatch(/Cache TTL: 1h \(from the Claude Code settings, not yet confirmed by a response\)/)
  expect(await bandText($)).toBe(`h⣿ Cache Bell: ${UNSEEN}`)
  // Past the time the hour would ask at: nothing is asked or sent.
  await clock.advance(2200 * S)
  expect(await bandText($)).toBe(`h⣿ Cache Bell: ${UNSEEN}`)
  expect(seen.did).toEqual([])
  // The next response shows the hour: from then on the transcript counts, and the hour's question comes.
  answers.appended = `${ASSISTANT_1H}\n`
  answers.grown = 500
  await turn($, clock, 0)
  await clock.advance(2 * S)
  expect(await status($)).toMatch(/Cache TTL: 1h \(read from the transcript\)/)
  expect(await bandText($)).toMatch(/^h⣿ Cache Bell: prompt cache expires in \d+ min$/)
  await clock.advance(2100 * S)
  expect((await question($)).text).toMatch(/^h⣿ Cache Bell: Cache expires soon \(144k tokens\)/)
})

// cacheRequestHour: the variable Claude Code reads, and the plugin's mark that says the value is its own.
const HOUR_SET = ['CACHE_BELL_PROMPT_CACHE_TTL=1h', 'CLAUDE_CODE_PROMPT_CACHE_TTL=1h']
const HOUR_DROPPED = ['CLAUDE_CODE_PROMPT_CACHE_TTL unset', 'CACHE_BELL_PROMPT_CACHE_TTL unset']
const NO_RESPONSE = '{"type":"user"}\n'
// A mode that neither renews nor compacts: the cache is left to go cold.
const IDLE = { idleAsk: 'never', idleRenewals: 0, idleCompact: 'off' }

test('asked for, the hour goes out with the first request of a new conversation, and the transcript has the last word', { options: { cacheRequestHour: 'on', displayBelowMinutes: 0 } }, async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const seen = stubs(on, { HOME: '/srv/jane' }, NO_RESPONSE)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  expect(seen.envSet).toEqual([])
  expect(await status($)).toMatch(/Hour-long cache: on, asked for at the next moment the cache is cold anyway/)
  await turn($, clock, 0)
  expect(seen.envSet).toEqual(HOUR_SET)
  await clock.advance(2 * S)
  expect(await status($)).toMatch(/Cache TTL: 1h \(asked for by Cache Bell \(cacheRequestHour\), not yet confirmed by a response\)\nHour-long cache: asked for, not yet confirmed by a response/)
  expect(await run($, 'report')).toMatchObject({ text: expect.stringMatching(/CLAUDE_CODE_PROMPT_CACHE_TTL 1h \(set by Cache Bell\) · TTL asked for none/) })
  // The next turn finds its own value in place: nothing is set again. Its response shows the hour.
  answers.appended = `${ASSISTANT_1H}\n`
  answers.grown = 500
  await turn($, clock, 0)
  await clock.advance(2 * S)
  expect(seen.envSet).toEqual(HOUR_SET)
  expect(await status($)).toMatch(/Cache TTL: 1h \(read from the transcript\)\nHour-long cache: asked for and granted/)
  expect(seen.toasts).toEqual([])
})

test('a response that shows five minutes after the hour was asked for is said once, and /bell status warns', { options: { cacheRequestHour: 'on' } }, async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const seen = stubs(on, { HOME: '/srv/jane' }, NO_RESPONSE)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await turn($, clock, 0)
  answers.appended = `${ASSISTANT_5M}\n`
  answers.grown = 500
  await clock.advance(5 * S)
  expect(seen.toasts).toEqual([HOUR_NOT_GRANTED])
  expect(await status($)).toMatch(/Cache TTL: 5m \(read from the transcript\)\n⚠ Hour-long cache: asked for, but the API granted only 5 minutes/)
  // The next turn's response says the same: nothing more is said.
  await turn($, clock, 0)
  answers.grown = 900
  await clock.advance(5 * S)
  expect(seen.toasts).toEqual([HOUR_NOT_GRANTED])
})

test('switched off, the plugin never takes away a TTL the person set', { options: { cacheRequestHour: 'off' } }, async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const seen = stubs(on, { HOME: '/srv/jane', CLAUDE_CODE_PROMPT_CACHE_TTL: '1h' }, NO_RESPONSE)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await turn($, clock, 0)
  await clock.advance(400 * S)
  await turn($, clock, 0)
  expect(seen.envSet).toEqual([])
})

test('on a warm cache the hour waits until the cache is cold anyway', { options: { ...IDLE, cacheRequestHour: 'on', displayBelowMinutes: 0 } }, async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  // A conversation with a response in it: its five-minute cache may still be warm.
  const seen = stubs(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await turn($, clock, 0)
  await clock.advance(2 * S)
  expect(await status($)).toMatch(/Cache TTL: 5m \(read from the transcript\)/)
  await clock.advance(60 * S)
  await turn($, clock, 0)
  expect(seen.envSet).toEqual([])
  // Cold: the next request asks for the hour.
  await clock.advance(400 * S)
  expect(await bandText($)).toMatch(/expired/)
  await turn($, clock, 0)
  expect(seen.envSet).toEqual(HOUR_SET)
})

test('switched off, the plugin takes its own hour back as it is loaded, warm or not, and never reads it as the person\'s', { options: { ...IDLE, cacheRequestHour: 'off', displayBelowMinutes: 0 } }, async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  // What an instance with the option on left in the process; the API granted five minutes all the same.
  const seen = stubs(on, { HOME: '/srv/jane', CACHE_BELL_PROMPT_CACHE_TTL: '1h', CLAUDE_CODE_PROMPT_CACHE_TTL: '1h' })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  expect(seen.envSet).toEqual(HOUR_DROPPED)
  await turn($, clock, 0)
  expect(seen.envSet).toEqual(HOUR_DROPPED)
  await clock.advance(60 * S)
  await turn($, clock, 0)
  expect(seen.envSet).toEqual(HOUR_DROPPED)
})

test('the plugin\'s own hour, kept from before a reload, is never read as a TTL the person set', { options: { ...IDLE, cacheRequestHour: 'on', displayBelowMinutes: 0 } }, async ($, on) => {
  mock.clock(on, { now: T0 })
  const seen = stubs(on, { ...OWN_HOUR })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  expect(seen.envSet).toEqual([])
  const shown = await status($)
  expect(shown).toMatch(/Hour-long cache: /)
  expect(shown).not.toMatch(/a TTL of your own is set|from the Claude Code settings/)
})

test('standing down for the plugin built on this one takes its own hour back, and never the person\'s', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const seen = stubs(on, { HOME: '/srv/jane', CACHE_BELL_PROMPT_CACHE_TTL: '1h', CLAUDE_CODE_PROMPT_CACHE_TTL: '1h' })
  answers.isSuperseded = true
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await clock.advance(2 * S)
  await turn($, clock, 0)
  expect(seen.envSet).toEqual(HOUR_DROPPED)
})

// What a shell command sees of the TTL variable, and what the plugin does around it.
const OWN_HOUR = { HOME: '/srv/jane', CACHE_BELL_PROMPT_CACHE_TTL: '1h', CLAUDE_CODE_PROMPT_CACHE_TTL: '1h' }
// Taken out with the mark, the value first; put back with the mark first.
const HIDE = ['CLAUDE_CODE_PROMPT_CACHE_TTL unset', 'CACHE_BELL_PROMPT_CACHE_TTL unset']
const HIDDEN = [...HIDE, 'CACHE_BELL_PROMPT_CACHE_TTL=1h', 'CLAUDE_CODE_PROMPT_CACHE_TTL=1h']

test('a shell command runs without the plugin\'s hour, which is back once it ends, also after a failure', { options: { ...IDLE, cacheRequestHour: 'on' } }, async ($, on) => {
  mock.clock(on, { now: T0 })
  const env: Record<string, string> = { ...OWN_HOUR }
  const seen = stubs(on, env)
  const inside: (string | undefined)[] = []
  let isBroken = false
  on('tool.call', () => {
    inside.push(`${env.CLAUDE_CODE_PROMPT_CACHE_TTL}/${env.CACHE_BELL_PROMPT_CACHE_TTL}`)
    if (isBroken) throw new Error('the shell went away')
    return { result: 'done' }
  })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  expect(await $.tool.call({ tool: 'Bash', command: 'claude -p hi' } as never)).toMatchObject({ result: 'done' })
  expect(seen.envSet).toEqual(HIDDEN)
  isBroken = true
  await expect($.tool.call({ tool: 'PowerShell', command: 'claude -p hi' } as never)).rejects.toThrow()
  expect(seen.envSet).toEqual([...HIDDEN, ...HIDDEN])
  // Any other tool sees the hour as it is.
  isBroken = false
  await $.tool.call({ tool: 'Read', file_path: '/work/a' } as never)
  // Neither the value nor the mark reaches a shell command.
  expect(inside).toEqual(['undefined/undefined', 'undefined/undefined', '1h/1h'])
  expect(seen.envSet).toEqual([...HIDDEN, ...HIDDEN])
})

test('of two shell commands at once, the hour comes back only after the last one', { options: { ...IDLE, cacheRequestHour: 'on', compactContextNotices: false } }, async ($, on) => {
  mock.clock(on, { now: T0 })
  const seen = stubs(on, { ...OWN_HOUR })
  const ends: (() => void)[] = []
  on('tool.call', () => new Promise(resolve => {
    ends.push(() => resolve({ result: 'done' }))
  }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  // The kit hands calls on while the test waits on one of its own.
  const until = async (isDone: () => boolean) => {
    for (let i = 0; i < 200 && !isDone(); i++) await status($)
  }
  let done = 0
  void $.tool.call({ tool: 'Bash', command: 'sleep 1' } as never).then(() => (done += 1))
  void $.tool.call({ tool: 'Bash', command: 'sleep 2' } as never).then(() => (done += 1))
  await until(() => ends.length === 2)
  expect(ends.length).toBe(2)
  ends[0]?.()
  await until(() => done === 1)
  expect(seen.envSet).toEqual(HIDE)
  ends[1]?.()
  await until(() => done === 2)
  expect(seen.envSet).toEqual(HIDDEN)
})

test('a subagent\'s shell command leaves the hour where it is: the main thread may send requests meanwhile', { options: { ...IDLE, cacheRequestHour: 'on' } }, async ($, on) => {
  mock.clock(on, { now: T0 })
  const env: Record<string, string> = { ...OWN_HOUR }
  const seen = stubs(on, env)
  const inside: (string | undefined)[] = []
  on('tool.call', () => {
    inside.push(env.CLAUDE_CODE_PROMPT_CACHE_TTL)
    return { result: 'done' }
  })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.tool.call({ tool: 'Bash', command: 'ls', agentId: 'a1' } as never)
  await $.tool.call({ tool: 'PowerShell', command: 'ls', agentId: 'a1' } as never)
  expect(inside).toEqual(['1h', '1h'])
  expect(seen.envSet).toEqual([])
})

test('while a subagent runs, the main thread\'s shell command keeps the hour too: the subagent sends requests meanwhile', { options: { ...IDLE, cacheRequestHour: 'on' } }, async ($, on) => {
  mock.clock(on, { now: T0 })
  const env: Record<string, string> = { ...OWN_HOUR }
  const seen = stubs(on, env)
  const inside: (string | undefined)[] = []
  on('tool.call', () => {
    inside.push(env.CLAUDE_CODE_PROMPT_CACHE_TTL)
    return { result: 'done' }
  })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  answers.agents = ['running']
  await $.tool.call({ tool: 'Bash', command: 'ls' } as never)
  answers.agents = ['completed']
  await $.tool.call({ tool: 'Bash', command: 'ls' } as never)
  expect(inside).toEqual(['1h', undefined])
  expect(seen.envSet).toEqual(HIDDEN)
})

test('given back while a shell command runs, the hour is not taken out for the next one, nor put back after them', { options: { ...IDLE, compactContextNotices: false } }, async ($, on) => {
  mock.clock(on, { now: T0 })
  const env: Record<string, string> = { ...OWN_HOUR }
  const seen = stubs(on, env)
  seen.store.set('hour', 'yes')
  const ends: (() => void)[] = []
  on('tool.call', () => new Promise(resolve => {
    ends.push(() => resolve({ result: 'done' }))
  }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const until = async (isDone: () => boolean) => {
    for (let i = 0; i < 200 && !isDone(); i++) await status($)
  }
  let done = 0
  void $.tool.call({ tool: 'Bash', command: 'sleep 1' } as never).then(() => (done += 1))
  await until(() => ends.length === 1)
  expect(seen.envSet).toEqual(HIDE)
  await run($, 'hour off')
  expect(seen.envSet).toEqual([...HIDE, ...HOUR_DROPPED])
  // The person sets a TTL of their own; the next command leaves it alone.
  env.CLAUDE_CODE_PROMPT_CACHE_TTL = '5m'
  void $.tool.call({ tool: 'Bash', command: 'sleep 2' } as never).then(() => (done += 1))
  await until(() => ends.length === 2)
  ends[0]?.()
  ends[1]?.()
  await until(() => done === 2)
  expect(seen.envSet).toEqual([...HIDE, ...HOUR_DROPPED])
  expect(env.CLAUDE_CODE_PROMPT_CACHE_TTL).toBe('5m')
})

test('a shell command that starts while the hour is being put back waits for it, and is counted', { options: { ...IDLE, cacheRequestHour: 'on', compactContextNotices: false } }, async ($, on) => {
  mock.clock(on, { now: T0 })
  const env: Record<string, string> = { ...OWN_HOUR }
  const seen = stubs(on, env)
  let open: () => void = () => {}
  const ends: (() => void)[] = []
  const inside: (string | undefined)[] = []
  on('tool.call', () => new Promise(resolve => {
    inside.push(`${env.CLAUDE_CODE_PROMPT_CACHE_TTL}/${env.CACHE_BELL_PROMPT_CACHE_TTL}`)
    ends.push(() => resolve({ result: 'done' }))
  }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const until = async (isDone: () => boolean) => {
    for (let i = 0; i < 200 && !isDone(); i++) await status($)
  }
  let done = 0
  void $.tool.call({ tool: 'Bash', command: 'sleep 1' } as never).then(() => (done += 1))
  await until(() => ends.length === 1)
  answers.markGate = new Promise(resolve => {
    open = resolve
  })
  // The first command ends; putting the hour back stops at its mark.
  ends[0]?.()
  for (let i = 0; i < 20; i++) await status($)
  void $.tool.call({ tool: 'Bash', command: 'sleep 2' } as never).then(() => (done += 1))
  await status($)
  answers.markGate = null
  open()
  await until(() => ends.length === 2)
  // Put back first, then taken out for the new command, which runs without it.
  expect(seen.envSet).toEqual([...HIDDEN, ...HIDE])
  expect(inside).toEqual(['undefined/undefined', 'undefined/undefined'])
  ends[1]?.()
  await until(() => done === 2)
  expect(seen.envSet).toEqual([...HIDDEN, ...HIDDEN])
})

test('a shell command that starts while the hour is being taken out for another waits until it is out', { options: { ...IDLE, cacheRequestHour: 'on', compactContextNotices: false } }, async ($, on) => {
  mock.clock(on, { now: T0 })
  const env: Record<string, string> = { ...OWN_HOUR }
  const seen = stubs(on, env)
  let open: () => void = () => {}
  const ends: (() => void)[] = []
  const inside: (string | undefined)[] = []
  on('tool.call', () => new Promise(resolve => {
    inside.push(`${env.CLAUDE_CODE_PROMPT_CACHE_TTL}/${env.CACHE_BELL_PROMPT_CACHE_TTL}`)
    ends.push(() => resolve({ result: 'done' }))
  }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const until = async (isDone: () => boolean) => {
    for (let i = 0; i < 200 && !isDone(); i++) await status($)
  }
  answers.takeOutGate = new Promise(resolve => {
    open = resolve
  })
  let done = 0
  // The first command stops while its hour is taken out; the second starts meanwhile.
  void $.tool.call({ tool: 'Bash', command: 'sleep 1' } as never).then(() => (done += 1))
  for (let i = 0; i < 20; i++) await status($)
  void $.tool.call({ tool: 'PowerShell', command: 'sleep 2' } as never).then(() => (done += 1))
  for (let i = 0; i < 20; i++) await status($)
  expect(inside).toEqual([])
  answers.takeOutGate = null
  open()
  await until(() => ends.length === 2)
  // Neither of them saw the hour.
  expect(inside).toEqual(['undefined/undefined', 'undefined/undefined'])
  ends[0]?.()
  ends[1]?.()
  await until(() => done === 2)
  expect(seen.envSet).toEqual(HIDDEN)
})

test('around a shell command the person\'s own TTL is left alone, and so is one set while it runs', { options: { ...IDLE, cacheRequestHour: 'on' } }, async ($, on) => {
  mock.clock(on, { now: T0 })
  const env: Record<string, string> = { HOME: '/srv/jane', CLAUDE_CODE_PROMPT_CACHE_TTL: '1h' }
  const seen = stubs(on, env)
  const inside: (string | undefined)[] = []
  on('tool.call', () => {
    inside.push(env.CLAUDE_CODE_PROMPT_CACHE_TTL)
    // Somebody else sets the variable while the command runs.
    env.CLAUDE_CODE_PROMPT_CACHE_TTL = '5m'
    return { result: 'done' }
  })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.tool.call({ tool: 'Bash', command: 'ls' } as never)
  expect(seen.envSet).toEqual([])
  // The plugin's hour, replaced while the command ran: what was set stays.
  env.CACHE_BELL_PROMPT_CACHE_TTL = '1h'
  env.CLAUDE_CODE_PROMPT_CACHE_TTL = '1h'
  await $.tool.call({ tool: 'Bash', command: 'ls' } as never)
  expect(inside).toEqual(['1h', undefined])
  expect(seen.envSet).toEqual(HIDE)
  expect(env.CACHE_BELL_PROMPT_CACHE_TTL).toBeUndefined()
  expect(env.CLAUDE_CODE_PROMPT_CACHE_TTL).toBe('5m')
})

test('standing down leaves a TTL the person set as it is', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const seen = stubs(on, { HOME: '/srv/jane', CLAUDE_CODE_PROMPT_CACHE_TTL: '1h' })
  answers.isSuperseded = true
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await clock.advance(2 * S)
  expect(seen.envSet).toEqual([])
})

// A TTL of the person's own, in every place and spelling: the plugin asks for nothing over it.
for (const [name, env, settings] of [
  ['in the environment', { CLAUDE_CODE_PROMPT_CACHE_TTL: '5m' }, {}],
  ['in the environment, spelled so the plugin cannot read it', { CLAUDE_CODE_PROMPT_CACHE_TTL: '60m' }, {}],
  ['as the five minutes forced', { FORCE_PROMPT_CACHING_5M: '1' }, {}],
  ['in Claude Code\'s settings', {}, { promptCacheTtl: '5m' }],
  ['in Claude Code\'s settings, spelled so the plugin cannot read it', {}, { promptCacheTtl: '60m' }],
] as [string, Record<string, string>, Record<string, unknown>][]) {
  test(`a TTL the person set ${name} is left alone`, { options: { cacheRequestHour: 'on' } }, async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    const seen = stubs(on, { HOME: '/srv/jane', ...env }, NO_RESPONSE)
    answers.settings = settings
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
    await turn($, clock, 0)
    expect(seen.envSet).toEqual([])
    expect(await status($)).toMatch(/Hour-long cache: on, but a TTL of your own is set; nothing is asked for/)
  })
}

// cacheTtl only says what the plugin counts with: Claude Code asks for its default all the same.
test('cacheTtl 1h is no TTL of the person\'s own: the hour is asked for', { options: { cacheTtl: '1h', cacheRequestHour: 'on' } }, async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const seen = stubs(on, { HOME: '/srv/jane' }, NO_RESPONSE)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await turn($, clock, 0)
  expect(seen.envSet).toEqual(HOUR_SET)
})

// Counted on five minutes, a cache that lasts the hour would be renewed and compacted for nothing.
test('cacheTtl 5m holds the hour back as a TTL of the person\'s own does', { options: { cacheTtl: '5m', cacheRequestHour: 'on' } }, async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const seen = stubs(on, { HOME: '/srv/jane' }, NO_RESPONSE)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await turn($, clock, 0)
  expect(seen.envSet).toEqual([])
  expect(await status($)).toMatch(/Hour-long cache: on, but not asked for, because cache-bell\.cacheTtl is 5m/)
  expect((await run($, 'hour')).text).toContain('cache-bell.cacheTtl is 5m in /config, so Cache Bell does not ask for the hour-long cache.')
})

test('a TTL the person sets while the plugin holds its hour takes over before the next request', { options: { cacheRequestHour: 'on' } }, async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const seen = stubs(on, { ...OWN_HOUR })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await turn($, clock, 0)
  expect(seen.envSet).toEqual([])
  answers.settings = { promptCacheTtl: '5m' }
  expect(await status($)).toMatch(/Hour-long cache: on, but a TTL of your own is set; nothing is asked for/)
  await clock.advance(10 * S)
  await turn($, clock, 0)
  expect(seen.envSet).toEqual(HOUR_DROPPED)
})

test('a TTL the person sets over the plugin\'s hour takes its mark away: a later 1h of theirs stays theirs', { options: { cacheRequestHour: 'on' } }, async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const env: Record<string, string> = { ...OWN_HOUR }
  const seen = stubs(on, env)
  on('tool.call', () => ({ result: 'done' }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await turn($, clock, 0)
  expect(seen.envSet).toEqual([])
  env.CLAUDE_CODE_PROMPT_CACHE_TTL = '5m'
  await clock.advance(10 * S)
  await turn($, clock, 0)
  expect(seen.envSet).toEqual(['CACHE_BELL_PROMPT_CACHE_TTL unset'])
  env.CLAUDE_CODE_PROMPT_CACHE_TTL = '1h'
  await clock.advance(10 * S)
  await turn($, clock, 0)
  await $.tool.call({ tool: 'Bash', command: 'ls' } as never)
  expect(await status($)).toMatch(/Hour-long cache: on, but a TTL of your own is set; nothing is asked for/)
  expect(seen.envSet).toEqual(['CACHE_BELL_PROMPT_CACHE_TTL unset'])
  expect(env.CLAUDE_CODE_PROMPT_CACHE_TTL).toBe('1h')
})

test('a TTL the person set before the plugin is loaded again takes over from its hour at once', { options: { cacheRequestHour: 'on' } }, async ($, on) => {
  mock.clock(on, { now: T0 })
  const seen = stubs(on, { ...OWN_HOUR })
  answers.settings = { promptCacheTtl: '5m' }
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  expect(seen.envSet).toEqual(HOUR_DROPPED)
})

test('a conversation whose transcript is not where it is looked for is not taken for a new one', { options: { cacheRequestHour: 'on' } }, async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const seen = stubs(on, { HOME: '/srv/jane' }, NO_RESPONSE)
  answers.hasTranscript = false
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await turn($, clock, 0)
  expect(seen.envSet).toEqual([])
})

test('a headless run asks for no hour', { options: { cacheRequestHour: 'on' } }, async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const seen = stubs(on, { HOME: '/srv/jane' }, NO_RESPONSE)
  await $.session.start({ surface: null, isInteractive: false, cwd: '/work' })
  await turn($, clock, 0)
  expect(seen.envSet).toEqual([])
})

// Started from a command that kept the plugin's hour: a subagent's shell, a hook.
test('a headless run that inherited the plugin\'s hour gives it back', { options: { cacheRequestHour: 'on' } }, async ($, on) => {
  mock.clock(on, { now: T0 })
  const seen = stubs(on, { ...OWN_HOUR })
  await $.session.start({ surface: null, isInteractive: false, cwd: '/work' })
  expect(seen.envSet).toEqual(HIDE)
})

test('a headless run leaves a TTL of the person\'s own as it is', { options: { cacheRequestHour: 'on' } }, async ($, on) => {
  mock.clock(on, { now: T0 })
  const seen = stubs(on, { HOME: '/srv/jane', CLAUDE_CODE_PROMPT_CACHE_TTL: '1h' })
  await $.session.start({ surface: null, isInteractive: false, cwd: '/work' })
  expect(seen.envSet).toEqual([])
})

test('switched off, the plugin asks for no hour either', { options: { cacheRequestHour: 'on', enabled: false } }, async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const seen = stubs(on, { HOME: '/srv/jane' }, NO_RESPONSE)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await turn($, clock, 0)
  expect(seen.envSet).toEqual([])
})

test('in the off profile the plugin asks for no hour either', { options: { cacheRequestHour: 'on', profile: 'off' } }, async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const seen = stubs(on, { HOME: '/srv/jane' }, NO_RESPONSE)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await turn($, clock, 0)
  expect(seen.envSet).toEqual([])
})

for (const options of [{ enabled: false }, { profile: 'off' }]) {
  test(`loaded with ${JSON.stringify(options)}, the plugin takes its own hour back at once, and never the person's`, { options: { ...options, cacheRequestHour: 'on' } }, async ($, on) => {
    mock.clock(on, { now: T0 })
    const seen = stubs(on, { ...OWN_HOUR })
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
    expect(seen.envSet).toEqual(HOUR_DROPPED)
  })
  test(`loaded with ${JSON.stringify(options)}, a TTL the person set stays`, { options: { ...options, cacheRequestHour: 'on' } }, async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    const seen = stubs(on, { HOME: '/srv/jane', CLAUDE_CODE_PROMPT_CACHE_TTL: '1h' }, NO_RESPONSE)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
    await turn($, clock, 0)
    expect(seen.envSet).toEqual([])
  })
}

test('in the watch profile nobody\'s answer asks for no hour', { options: { profile: 'watch' } }, async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const seen = stubs(on, { HOME: '/srv/jane' }, NO_RESPONSE)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await turn($, clock, 0)
  expect(seen.envSet).toEqual([])
})

test('in the watch profile /bell hour on asks for the hour', { options: { profile: 'watch' } }, async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const seen = stubs(on, { HOME: '/srv/jane' }, NO_RESPONSE)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await run($, 'hour on')
  await turn($, clock, 0)
  expect(seen.envSet).toEqual(HOUR_SET)
})

test('in the watch profile the answer "within the hour", kept on the machine, asks for the hour', { options: { profile: 'watch' } }, async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const seen = stubs(on, { HOME: '/srv/jane' }, NO_RESPONSE)
  seen.store.set('hour', 'yes')
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await turn($, clock, 0)
  expect(seen.envSet).toEqual(HOUR_SET)
})

test('in the watch profile cacheRequestHour on asks for the hour', { options: { profile: 'watch', cacheRequestHour: 'on' } }, async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const seen = stubs(on, { HOME: '/srv/jane' }, NO_RESPONSE)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await turn($, clock, 0)
  expect(seen.envSet).toEqual(HOUR_SET)
})

test('in the watch profile the answer no asks for nothing', { options: { profile: 'watch' } }, async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const seen = stubs(on, { HOME: '/srv/jane' }, NO_RESPONSE)
  seen.store.set('hour', 'no')
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await turn($, clock, 0)
  expect(seen.envSet).toEqual([])
})

test('a TTL set in the options counts at once: the plugin asks and renews on it', { options: { cacheTtl: '5m' } }, async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const seen = stubs(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await turn($, clock, 0)
  expect(await bandText($)).toBe('h⣿ Cache Bell: prompt cache expires in 4:35')
  await clock.advance(210 * S)
  expect((await question($)).text).toMatch(/^h⣿ Cache Bell: Cache expires soon \(144k tokens\), 2 automatic renewals left/)
  await clock.advance(30 * S)
  expect(seen.did).toEqual(['fork'])
})

// The default since 0.3.3: no band, only the status line. A question still shows above the prompt.
test('shown in the status line only, the plugin still asks its question above the prompt', { options: { display: 'status', cacheTtl: '5m' } }, async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  stubs(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await turn($, clock, 0)
  await clock.advance(210 * S)
  expect((await question($)).text).toMatch(/^h⣿ Cache Bell: Cache expires soon \(144k tokens\), 2 automatic renewals left/)
})

test('with reading the transcript switched off and no TTL set nothing is renewed or compacted, and the band says how to name it', { options: { cacheTtl: 'settings' }, timeoutMs: LONG }, async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const seen = stubs(on, { HOME: '/srv/jane', CLAUDE_CODE_PROMPT_CACHE_TTL: '1h' })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await turn($, clock, 0)
  await clock.advance(2 * S)
  expect(await bandText($)).toBe(`h⣿ Cache Bell: ${UNNAMED}`)
  expect(await status($)).toContain('Next: nothing is asked, renewed or compacted until you set the cacheTtl option')
  // Past the time five minutes and the hour would ask and act at: nothing was sent.
  await clock.advance(3100 * S)
  expect(seen.did).toEqual([])
  expect(answers.looked).toBe(0)
  // An hour after the last request the cache is taken for gone.
  await clock.advance(200 * S)
  expect(await status($)).toContain('State: cold, expired')
  expect(seen.did).toEqual([])
})

test('a TTL set in the options is not overridden by the transcript', { options: { ...NOTIFY, cacheTtl: '5m' } }, async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  stubs(on, { CLAUDE_CODE_PROMPT_CACHE_TTL: '1h' }, `${ASSISTANT_1H}\n`)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await turn($, clock, 0)
  await $.classic.Stop({ transcript_path: '/work/session.jsonl', stop_hook_active: false })
  expect(await status($)).toBe(
    [
      'version 0.1.0 · on, bellcompact[off]',
      'When idle above 80K, Cache Bell asks what to do before the cache expires.',
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
  expect(await status($)).toMatch(/^version 0\.1\.0 · on, bellcompact\[off\]\nWhen idle above 80K, .*\nState: unknown/)
  expect((await run($, '')).text).toMatch(/State: unknown/)
  expect((await run($, 'now')).text).toBe('Usage: /bell status | report | log [count] | hour [on|off] | set <level>K|off|default\n       | demo [seconds] [bg] [stay] | show calm|act|cold|intro|off')
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
  const seen = stubs(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.turn.start({ text: 'hi', turnId: 't' })
  await request($)
  await turn($, clock, 0, 'agent-1')
  expect(await busyStatus($, seen)).toMatch(/State: busy/)
})

test('a status asked for while a turn runs is said at once, as a notice of one line', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const seen = stubs(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.prompt.submit({ text: 'hi', wait: false, origin: { kind: 'composer' } })
  await $.turn.start({ text: 'hi', turnId: 't' })
  await request($)
  await clock.advance(8 * S)
  // The command itself answers nothing: Claude Code would print it only after the turn.
  for (const args of ['', 'status']) expect(await run($, args)).toEqual({})
  expect(seen.logs).toEqual(Array(2).fill('version 0.1.0 · on, bellcompact[off] · When idle above 80K, Cache Bell asks first, renews the cache up to 2 times, then compacts before it expires. · State: busy (a turn is running) · Cache TTL: 5m (read from the transcript) · Last request to the API: 0:08 ago · Context: 143 985 tokens'))
  // The other verbs answer as ever.
  expect((await run($, 'log')).text).not.toMatch(/^Usage/)

  // Idle again, the command answers by itself.
  await $.turn.complete({ turnId: 't', answer: 'ok', durationMs: 8 * S, isAborted: false, reason: 'answer' })
  expect(await status($)).toMatch(/State: warm/)
  expect(seen.logs.length).toBe(2)
})

test('/bell report gathers what an issue needs and shows no address and no path', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const seen = stubs(on, { OS: 'Windows_NT', ANTHROPIC_BASE_URL: 'https://gateway.example.com', CLAUDE_CODE_USE_BEDROCK: '1' }, `${ASSISTANT_1H}\n`)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  // Before anything was seen the report still answers.
  expect((await run($, 'report')).text).toContain('Transcript: path known no · exists not asked · size unknown · read for the TTL never')

  await turn($, clock, 0)
  await $.classic.Stop({ transcript_path: '/work/session.jsonl', stop_hook_active: false })
  await clock.advance(40 * S)
  const rows = ((await run($, 'report')).text ?? '').split('\n')
  expect(rows[1]).toBe('Cache Bell 0.1.0 · Claude Code version not seen · Windows · terminal')
  expect(rows[2]).toMatch(/^Surfaces: .* · band asked for: .* · drawn: .* · seen: nothing$/)
  expect(rows[3]).toBe('Model: claude-test · Bedrock yes · Vertex no · Foundry no · own API address yes')
  expect(rows[6]).toBe('State: WARM · TTL 1h from transcript · TTL unread no · last request 0:40 ago · context 143 985 tokens · renewals 0')
  expect(rows[7]).toBe('Transcript: path known yes · exists yes · size 100 bytes · read for the TTL 0:40 ago · failed reads 0 · next try none')
  expect(rows[8]).toBe('End of the transcript: responses of the main thread 1 · usage of the last: cache_creation{ephemeral_1h_input_tokens=900 ephemeral_5m_input_tokens=0}')
  expect(rows[9]).toBe("Events seen: SessionStart 0, with the transcript's path 0 · Stop 1, with the path 1 · requests of the main thread 1")
  expect(rows[10]).toBe("The plugin's last notices: none")
  expect(rows.join('\n')).not.toMatch(/gateway|session\.jsonl|\/work/)
  expect(seen.logs).toEqual([])
})

test('/bell report names a transcript that cannot be read and the notice that said so, without the path', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  stubs(on, {}, `${ASSISTANT_1H}\n`, 5 * 1024 * 1024)
  answers.tailExit = 1
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await turn($, clock, 0)
  await $.classic.Stop({ transcript_path: '/work/session.jsonl', stop_hook_active: false })
  const text = (await run($, 'report')).text ?? ''
  expect(text).toContain('size 5 242 880 bytes · read for the TTL never · failed reads 1 · next try in 0:15')
  expect(text).toContain('End of the transcript: not read: exited with 1')
  expect(text).toContain("The plugin's last notices: none")
  // The second failed read is told, and the report names it without the path.
  await clock.advance(16 * S)
  const again = (await run($, 'report')).text ?? ''
  expect(again).toContain('failed reads 2')
  expect(again).toMatch(/The plugin's last notices: \n  .*transcript not read/)
  expect(again).not.toMatch(/The plugin's last notices:[\s\S]*session\.jsonl/)
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

test('on Windows PowerShell is started by its full path under SystemRoot, not looked up by name', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const seen = stubs(on, { OS: 'Windows_NT', SystemRoot: 'C:\\WINDOWS' }, `${ASSISTANT_1H}\n`, LARGE)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await turn($, clock, 0)
  await $.classic.Stop({ transcript_path: 'C:\\work\\session.jsonl', stop_hook_active: false })
  expect(seen.argv[0]?.[0]).toBe('C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
  expect(await status($)).toMatch(/Cache TTL: 1h \(read from the transcript\)/)
})

test('a transcript that did not grow is not read again, and a confirmed TTL only now and then', { options: NOTIFY }, async ($, on) => {
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
  // One failure is not said yet: the next try may go through.
  expect(seen.logs).toEqual([])
  expect(await bandText($)).toBe('h⣿ Cache Bell: prompt cache: lifetime not known yet, the transcript could not be read · nothing is renewed or compacted until it is')
  // The first retry, after 15 seconds, fails too: now it is said.
  await clock.advance(16 * S)
  expect(seen.logs).toEqual(['transcript not read, it is tried again: Error: tail exited with 1'])
  // Past the time the assumed five minutes would ask and renew at. The read was tried again after 15
  // seconds and after a minute more; the failure is said once.
  await clock.advance(264 * S)
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

test('a read that fails once and goes through at the next try is not said at all', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const seen = stubs(on, {}, `${ASSISTANT_1H}\n`, LARGE)
  answers.tailExit = 1
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await turn($, clock, 0)
  await $.classic.Stop({ transcript_path: '/work/session.jsonl', stop_hook_active: false })
  answers.tailExit = 0
  await clock.advance(16 * S)
  expect(seen.processes).toBe(2)
  expect(seen.logs).toEqual([])
  expect(await status($)).toMatch(/Cache TTL: 1h \(read from the transcript\)/)
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

// A transcript whose last request went out `secondsAgo` before T0, answered with a write to the hour's cache.
const dated = (secondsAgo: number, type: string, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ type, isSidechain: false, timestamp: new Date(T0 - secondsAgo * S).toISOString(), message: { content: 'hi' }, ...extra })
const answer = (secondsAgo: number): string =>
  dated(secondsAgo, 'assistant', { message: { model: 'claude-test', usage: { input_tokens: 2, output_tokens: 9, cache_creation_input_tokens: 900, cache_creation: { ephemeral_1h_input_tokens: 900, ephemeral_5m_input_tokens: 0 } } } })
const transcriptOf = (secondsAgo: number): string => [dated(secondsAgo, 'user'), answer(secondsAgo - 5), ''].join('\n')

const resume = ($: Engine, extra: Record<string, unknown> = {}) => $.classic.SessionStart({ source: 'resume', transcript_path: '/work/session.jsonl', ...extra } as never)

test('a resumed session knows its cache at once: the TTL and the last request from the transcript', { options: { displayBelowMinutes: 0 } }, async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const seen = stubs(on, {}, transcriptOf(850))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  expect(await status($)).toMatch(/State: unknown/)
  // Claude Code counts from the response's end, here ten minutes ago; the transcript's request wins.
  await resume($, { seconds_since_last_response: 600, context_tokens: 48261 })
  const report = await status($)
  expect(report).toMatch(/State: warm\nCache TTL: 1h \(read from the transcript\)\nLast request to the API: 14 min ago/)
  expect(await bandText($)).toBe('h⣿ Cache Bell: prompt cache expires in 40 min')
  expect(seen.toasts).toEqual([])
  // The next turn takes over as ever.
  await turn($, clock, 0)
  expect(await status($)).toMatch(/Last request to the API: 0:00 ago/)
})

const BY_ID = '/srv/jane/.claude/projects/-work-my-project/abcd1234-0000-4000-8000-000000000000.jsonl'

test('where no event names the transcript, it is found by the session id after the turn and read', { options: { displayBelowMinutes: 0 } }, async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  stubs(on, { HOME: '/srv/jane' }, `${ASSISTANT_1H}\n`)
  answers.only = BY_ID
  answers.hasTranscript = false
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work/my project' })
  // A new session has no file yet: nothing is found, nothing is taken up.
  await clock.advance(5 * S)
  expect(await status($)).toMatch(/State: unknown/)
  answers.hasTranscript = true
  await turn($, clock, 0)
  expect((await run($, 'report')).text).toContain('Transcript: path known no')
  await clock.advance(3 * S)
  expect(await status($)).toMatch(/Cache TTL: 1h \(read from the transcript\)/)
  expect((await run($, 'report')).text).toContain("Transcript: path known yes, found by the session's id · exists yes")
  // An event that comes after all names it from then on.
  await $.classic.Stop({ transcript_path: '/work/session.jsonl', stop_hook_active: false })
  expect((await run($, 'report')).text).toContain('Transcript: path known yes · exists')
})

test('a session resumed in a process that is told nothing is taken up from the transcript found by its id', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  stubs(on, { USERPROFILE: 'D:\\people\\jane', CLAUDE_CONFIG_DIR: '/srv/jane/.claude' }, transcriptOf(850))
  answers.only = BY_ID
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work/my project' })
  expect(await status($)).toMatch(/State: unknown/)
  await clock.advance(3 * S)
  expect(await status($)).toMatch(/State: warm\nCache TTL: 1h \(read from the transcript\)\nLast request to the API: 14 min ago/)
})

test('with reading the transcript switched off it is not looked for by the session id either', { options: { cacheTtl: 'settings' } }, async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const seen = stubs(on, { HOME: '/srv/jane' }, transcriptOf(850))
  answers.only = BY_ID
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work/my project' })
  await clock.advance(3 * S)
  await turn($, clock, 0)
  await clock.advance(3 * S)
  expect(answers.looked).toBe(0)
  expect(seen.envAsked.filter(name => name === 'HOME' || name === 'USERPROFILE' || name === 'CLAUDE_CONFIG_DIR')).toEqual([])
  expect((await run($, 'report')).text).toContain('Transcript: path known no')
})

test('the transcript is also found in the folder of the working directory, and on Windows under USERPROFILE', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  stubs(on, { OS: 'Windows_NT', HOME: '/elsewhere', USERPROFILE: '/srv/jane', CLAUDE_CONFIG_DIR: '' }, transcriptOf(850))
  answers.only = '/srv/jane/.claude/projects/-work-my-project-src/abcd1234-0000-4000-8000-000000000000.jsonl'
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work/my project' })
  await clock.advance(3 * S)
  expect(await status($)).toMatch(/State: warm\nCache TTL: 1h \(read from the transcript\)/)
})

test('a resume inside a process that is told nothing is taken up by the session id too', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  stubs(on, { HOME: '/srv/jane' }, transcriptOf(850))
  answers.only = BY_ID
  answers.hasTranscript = false
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work/my project' })
  await clock.advance(5 * S)
  expect(await status($)).toMatch(/State: unknown/)
  answers.hasTranscript = true
  await $.session.end({ reason: 'resume', sessionId: 's' } as never)
  await clock.advance(3 * S)
  expect(await status($)).toMatch(/State: warm\nCache TTL: 1h \(read from the transcript\)/)
})

test('with an event that names the transcript the session id is not asked for', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  stubs(on, { HOME: '/srv/jane' }, `${ASSISTANT_1H}\n`)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work/my project' })
  await $.classic.SessionStart({ source: 'startup', transcript_path: '/work/session.jsonl' } as never)
  await turn($, clock, 0)
  await $.classic.Stop({ transcript_path: '/work/session.jsonl', stop_hook_active: false })
  await clock.advance(5 * S)
  expect((await run($, 'report')).text).toContain('Transcript: path known yes · exists')
})

test('a session resumed after its cache ran out is cold, and nobody is told', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const seen = stubs(on, {}, transcriptOf(8 * 3600))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await resume($, { seconds_since_last_response: 8 * 3600 - 5, context_tokens: 269655 })
  expect(await status($)).toMatch(/State: cold, expired\nCache TTL: 1h \(read from the transcript\)/)
  expect(await bandText($)).toBe('h⣿ Cache Bell: prompt cache expired · the next message re-sends 270k tokens uncached')
  await clock.advance(60 * S)
  expect(seen.toasts).toEqual([])
})

test('where the transcript is not read, a resumed session counts from the time Claude Code gives', { options: { cacheTtl: 'settings' } }, async ($, on) => {
  mock.clock(on, { now: T0 })
  stubs(on, {}, transcriptOf(850))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await resume($, { seconds_since_last_response: 120 })
  expect(await status($)).toMatch(/State: warm\nCache TTL: 5m \(assumed, not yet seen in the data\)\nLast request to the API: 2:00 ago/)
  expect(answers.looked).toBe(0)
})

test('where the transcript is not read, a resumed session stays a guess and nothing is sent on it', { options: { cacheTtl: 'settings' } }, async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const seen = stubs(on, {}, transcriptOf(850))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await resume($, { seconds_since_last_response: 120 })
  expect(await bandText($)).toBe(`h⣿ Cache Bell: ${UNNAMED}`)
  // Past the time five minutes would ask, act and give up at: still warm, and nothing was sent.
  await clock.advance(600 * S)
  expect(await status($)).toMatch(/State: warm\nCache TTL: 5m \(assumed, not yet seen in the data\)/)
  expect(seen.did).toEqual([])
})

test('a resumed session whose transcript shows no lifetime keeps what the settings named as a guess', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const plain = dated(115, 'assistant', { message: { model: 'claude-test', usage: { input_tokens: 2, output_tokens: 9 } } })
  const seen = stubs(on, { HOME: '/srv/jane', CLAUDE_CODE_PROMPT_CACHE_TTL: '1h' }, [dated(120, 'user'), plain, ''].join('\n'))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await resume($)
  expect(await status($)).toMatch(/State: warm\nCache TTL: 1h \(from the Claude Code settings, not yet confirmed by a response\)\nLast request to the API: 2:00 ago/)
  expect(await bandText($)).toBe(`h⣿ Cache Bell: ${UNSEEN}`)
  await clock.advance(600 * S)
  expect(await status($)).toMatch(/State: warm\nCache TTL: 1h \(from the Claude Code settings/)
  expect(seen.did).toEqual([])
})

test('with the TTL set in the options the last request still comes from the transcript', { options: { cacheTtl: '5m' } }, async ($, on) => {
  mock.clock(on, { now: T0 })
  stubs(on, {}, transcriptOf(200))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await resume($, { seconds_since_last_response: 20 })
  expect(await status($)).toMatch(/State: warm\nCache TTL: 5m \(set in the plugin options\)\nLast request to the API: 3:20 ago/)
})

test('a session resumed after a failed request counts from the last one that was answered', async ($, on) => {
  mock.clock(on, { now: T0 })
  const failed = dated(57, 'assistant', { isApiErrorMessage: true, message: { model: '<synthetic>', usage: { input_tokens: 0, output_tokens: 0 } } })
  stubs(on, {}, [dated(3 * 3600, 'user'), answer(3 * 3600 - 5), dated(60, 'user'), failed, ''].join('\n'))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await resume($, { seconds_since_last_response: 57 })
  expect(await status($)).toMatch(/State: cold, expired\nCache TTL: 1h \(read from the transcript\)\nLast request to the API: 180 min ago/)
})

test('a session resumed right after a compaction is left alone, whatever time Claude Code gives', async ($, on) => {
  mock.clock(on, { now: T0 })
  stubs(on, {}, [dated(900, 'user'), answer(895), dated(300, 'system', { subtype: 'compact_boundary' }), dated(300, 'user', { isCompactSummary: true }), ''].join('\n'))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await resume($, { seconds_since_last_response: 300, context_tokens: 21400 })
  expect(await status($)).toMatch(/State: unknown[^\n]*\nCache TTL: 1h \(read from the transcript\)\nLast request to the API: none seen/)
  expect(await bandText($)).toBe('drawn by Claude Code')
})

test('a resume inside the process reads the new transcript at once, though the old one was read a moment ago', { options: { displayBelowMinutes: 0 } }, async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  stubs(on, {}, transcriptOf(1200))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await turn($, clock, 0)
  await $.classic.Stop({ transcript_path: '/work/old.jsonl', stop_hook_active: false })
  await $.session.end({ reason: 'resume', sessionId: 's' } as never)
  await resume($, { transcript_path: '/work/session.jsonl', seconds_since_last_response: 30 })
  expect(await status($)).toMatch(/State: warm\nCache TTL: 1h \(read from the transcript\)\nLast request to the API: 20 min ago/)
})

test('a resume that names no transcript and no time, and one in a session already at work, change nothing', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  stubs(on, {}, transcriptOf(850))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.classic.SessionStart({ source: 'resume' } as never)
  expect(await status($)).toMatch(/State: unknown/)
  await $.classic.SessionStart({ source: 'startup', transcript_path: '/work/session.jsonl', seconds_since_last_response: 30 } as never)
  expect(await status($)).toMatch(/State: unknown/)
  await turn($, clock, 0)
  await clock.advance(20 * S)
  await resume($, { seconds_since_last_response: 3 })
  expect(await status($)).toMatch(/Last request to the API: 0:20 ago/)
})

test('a model switch turns the cache cold and brings its TTL', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  stubs(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await turn($, clock, 0)
  await $.classic.PostModelSwitch({ cache_ttl: '1h', prompt_cache_warm: true } as never)
  const report = await status($)
  expect(report).toMatch(/State: cold, model changed/)
  expect(report).toMatch(/Cache TTL: 1h \(asked for at the model switch, not yet confirmed by a response\)/)
})

test('the TTL a model switch brings is a guess until a response after it shows the lifetime', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const seen = stubs(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await turn($, clock, 0)
  await clock.advance(2 * S)
  expect(await status($)).toMatch(/Cache TTL: 5m \(read from the transcript\)/)
  await $.classic.PostModelSwitch({ cache_ttl: '1h', prompt_cache_warm: true } as never)
  // A turn on the new model whose response is not in the transcript yet: the hour is only what was asked for.
  await turn($, clock, 0)
  await clock.advance(2 * S)
  expect(await status($)).toMatch(/Cache TTL: 1h \(asked for at the model switch, not yet confirmed by a response\)/)
  expect(await bandText($)).toBe(`h⣿ Cache Bell: ${UNSEEN}`)
  await clock.advance(600 * S)
  expect(seen.did).toEqual([])
  // Its response shows five minutes: they count.
  answers.grown = 500
  await turn($, clock, 0)
  await clock.advance(2 * S)
  expect(await status($)).toMatch(/Cache TTL: 5m \(read from the transcript\)/)
  expect(await bandText($)).toBe('h⣿ Cache Bell: prompt cache expires in 4:33')
})

test('the display is touched only when its text changes', { options: { display: 'both', cacheTtl: '1h', displayBelowMinutes: 0 } }, async ($, on) => {
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
  test(`a renewal that gets no answer (${fork}) is tried once more, then nothing more is sent`, { timeoutMs: LONG }, async ($, on) => {
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

const leftBehind = (over: Partial<State>): State => ({ ...initialState(configOf()), anchorAt: T0, ttlSource: 'transcript', contextTokens: 143985, isAsked: true, ...over })

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

test('the second period is renewed without a question, the third asks again and ends with the announcement and a compaction', { timeoutMs: LONG }, async ($, on) => {
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

test('a compaction that is refused leaves the cache cold', { options: COMPACT_ONLY }, async ($, on) => {
  const { clock, seen } = await idle($, on)
  answers.compactSkip = true
  await clock.advance(241 * S)
  expect(seen.did.length).toBe(1)
  expect(await status($)).toMatch(/State: cold, compaction failed/)
})


test('with the limit of the manifest an hour-long cache shows its countdown from 30 minutes left', { timeoutMs: LONG }, async ($, on) => {
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

test('the mark wears the brand colours in the band, whatever the tone of the line', { options: { idleAsk: 'never', idleRenewals: 0, idleCompact: 'off' } }, async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  stubs(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await turn($, clock, 0)
  await clock.advance(2 * S)
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
    [' prompt cache expires in 4:33', undefined, false, true],
  ])
  await clock.advance(208 * S)
  expect((await drawn())[3]).toEqual([' prompt cache expires in 1:05', 'yellow', false, false])
  await clock.advance(65 * S)
  expect((await drawn()).map(run => run[1])).toEqual(['#3aa3b3', '#7ad8f8', undefined, 'cyan'])
})

// --- how full the context is, told to Claude after a tool result ---

// A tool call of the main thread, or of a subagent: what comes back to the model beside the result.
const toolContext = async ($: Engine, agentId?: string): Promise<readonly string[] | undefined> => {
  const input = agentId === undefined ? { tool: 'Bash', command: 'ls' } : { tool: 'Bash', command: 'ls', agentId }
  return ((await $.tool.call(input as never)) as { context?: readonly string[] }).context
}

test('past half the window Claude is told how full the context is, once per step, and a subagent is told nothing', async ($, on) => {
  mock.clock(on, { now: T0 })
  stubs(on)
  on('tool.call', () => ({ result: 'files' }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  answers.tokens = 90000
  expect(await toolContext($)).toBeUndefined()
  answers.tokens = 143985
  expect(await toolContext($, 'a1')).toBeUndefined()
  expect(await toolContext($)).toEqual(['[cache-bell] Context notice: 144k of a 200k window (72%).'])
  expect(await toolContext($)).toBeUndefined()
  answers.tokens = 170000
  expect(await toolContext($)).toEqual(['[cache-bell] Context notice: 170k of a 200k window (85%).'])
})

test('past the limit the person set Claude is told they want a compaction', { options: { compactLevelK: 100, compactContextNotices: false } }, async ($, on) => {
  mock.clock(on, { now: T0 })
  stubs(on)
  on('tool.call', () => ({ result: 'files' }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  answers.tokens = 99000
  expect(await toolContext($)).toBeUndefined()
  answers.tokens = 120000
  expect(await toolContext($)).toEqual([
    '[cache-bell] User preference notice: the user set a context limit of 100k; the context is now 120k of a 200k window (60%), 20k over. The user wants a compaction at the next good point: see skill cache-bell:compact.',
  ])
})

test('with both options off, or the plugin switched off, nothing is added to a tool result', { options: { compactContextNotices: false } }, async ($, on) => {
  mock.clock(on, { now: T0 })
  stubs(on)
  on('tool.call', () => ({ result: 'files' }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  answers.tokens = 195000
  answers.usages = 0
  expect(await toolContext($)).toBeUndefined()
  // Nothing is even asked of Claude Code.
  expect(answers.usages).toBe(0)
})

test('with the plugin switched off nothing is added to a tool result', { options: { enabled: false, compactLevelK: 100 } }, async ($, on) => {
  mock.clock(on, { now: T0 })
  stubs(on)
  on('tool.call', () => ({ result: 'files' }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  answers.tokens = 195000
  expect(await toolContext($)).toBeUndefined()
})

test('a denied tool call carries no line, and a failing usage or tool leaves the call as it was', async ($, on) => {
  mock.clock(on, { now: T0 })
  stubs(on)
  let tool: 'deny' | 'files' = 'deny'
  on('tool.call', () => (tool === 'deny' ? { deny: 'not allowed' } : { result: 'files' }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  answers.tokens = 195000
  const call = () => $.tool.call({ tool: 'Bash', command: 'ls' } as never) as Promise<unknown>
  expect(await call()).toEqual({ deny: 'not allowed' })
  tool = 'files'
  answers.isUsageBroken = true
  expect(await call()).toEqual({ result: 'files' })
})

test('/bell set gives this session a level of its own, none, or the option\'s again', { options: { compactLevelK: 100, compactContextNotices: false } }, async ($, on) => {
  mock.clock(on, { now: T0 })
  stubs(on)
  on('tool.call', () => ({ result: 'files' }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  answers.tokens = 120000
  expect((await run($, 'set 150K')).text).toBe('This session is asked to compact once its context is past 150K, at a good moment. /bell set default puts the level of the options back.')
  expect(await status($)).toMatch(/^version 0\.1\.0 · on, bellcompact\[150K, this session\]\n/)
  expect(await toolContext($)).toBeUndefined()
  answers.tokens = 160000
  expect((await toolContext($))?.[0]).toMatch(/^\[cache-bell\] User preference notice: the user set a context limit of 150k; .*, 10k over\./)
  expect((await run($, 'set off')).text).toBe('This session is not asked to compact at a size. /bell set default puts the level of the options back.')
  expect(await status($)).toMatch(/^version 0\.1\.0 · on, bellcompact\[off, this session\]\n/)
  answers.tokens = 170000
  expect(await toolContext($)).toBeUndefined()
  expect((await run($, 'set default')).text).toBe('This session compacts from the level of cache-bell.compactLevelK again: 100K.')
  expect(await status($)).toMatch(/^version 0\.1\.0 · on, bellcompact\[100K\]\n/)
  expect((await toolContext($))?.[0]).toMatch(/limit of 100k; .*, 70k over\./)
  // A word it does not take changes nothing.
  for (const word of ['0', '10001K', 'lots', '']) expect((await run($, `set ${word}`)).text).toBe('Usage: /bell set <level>K | off | default, the level 1K to 10000K')
  expect(await status($)).toMatch(/^version 0\.1\.0 · on, bellcompact\[100K\]\n/)
})

test('/bell set counts only in the bellcompact profile', { options: { profile: 'watch' } }, async ($, on) => {
  mock.clock(on, { now: T0 })
  stubs(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  expect((await run($, 'set 150')).text).toBe('The compaction level counts only in the bellcompact profile; cache-bell.profile is watch.')
})

test('where Claude may not ask for a compaction it is told only how full the context is', { options: { compactLevelK: 100, compactOnRequest: 'off' } }, async ($, on) => {
  mock.clock(on, { now: T0 })
  stubs(on)
  on('tool.call', () => ({ result: 'files' }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  answers.tokens = 120000
  expect((await toolContext($))?.[0]).toBe('[cache-bell] Context notice: 120k of a 200k window (60%).')
})

// The level is the session's alone: an idle session that the plugin does not compact is no reason to keep quiet.
for (const options of [{ compactLevelK: 0 }, { compactLevelK: 0, ...KEEP }]) {
  test(`without a level (${JSON.stringify(options)}) Claude is told only how full the context is`, { options: { compactLevelK: 100, ...options } }, async ($, on) => {
    mock.clock(on, { now: T0 })
    stubs(on)
    on('tool.call', () => ({ result: 'files' }))
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
    answers.tokens = 120000
    expect((await toolContext($))?.[0]).toBe('[cache-bell] Context notice: 120k of a 200k window (60%).')
  })
}

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
  expect(seen.toasts).toEqual(['Compaction cancelled. Nothing was compacted.'])
  await clock.advance(200 * S)
  expect(seen.did).toEqual([])
  expect(await status($)).toMatch(/State: warm/)
})

test('set to auto the compaction follows the turn at once; set to off the session is refused', { options: { compactOnRequest: 'auto' } }, async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const seen = stubs(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  expect(await askingTurn($, clock)).toMatch(/^Compaction requested\. The conversation will be compacted right after this turn ends/)
  expect(await bandText($)).toBe('h⣿ Cache Bell: compacting…')
  await clock.advance(S)
  expect(seen.did.length).toBe(1)
  expect(await status($)).toMatch(/State: dormant/)
})

test('set to off the session is refused and nothing happens', { options: { compactOnRequest: 'off' } }, async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const seen = stubs(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  expect(await askingTurn($, clock)).toMatch(/^Refused: /)
  await clock.advance(200 * S)
  expect(seen.did).toEqual([])
  expect(await status($)).toMatch(/State: warm/)
})

test('/bell show holds the band in a look for a screenshot, and off puts the real one back', { options: { idleAsk: 'never', idleRenewals: 0, idleCompact: 'off' } }, async ($, on) => {
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

test('instructions of the person\'s own go to the compaction with the time and the idle minutes filled in', { options: { ...COMPACT_ONLY, compactInstructions: 'Idle {idle} min at {time}.' } }, async ($, on) => {
  const { clock, seen } = await idle($, on)
  await clock.advance(241 * S)
  expect(seen.did.length).toBe(1)
  expect(seen.did[0]).toMatch(/^compact\[\w+\]: Idle 4 min at \d{4}-\d\d-\d\d \d\d:\d\d UTC\.$/)
})

test('after renewals and the announcement {idle} still counts from the person\'s last message', { timeoutMs: LONG, options: { compactInstructions: 'Idle {idle} min.' } }, async ($, on) => {
  const { clock, seen } = await idle($, on)
  await clock.advance(720 * S)
  expect(seen.did).toEqual(['fork', 'fork', 'prepare'])
  await ownTurn($, clock)
  await clock.advance(S)
  expect(seen.did[3]).toMatch(/^compact\[\w+\]: Idle 12 min\.$/)
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

test('when the plugin built on it starts later, this one takes its question down and stands down', { timeoutMs: LONG }, async ($, on) => {
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

const WATCH = { idleAsk: 'never', idleRenewals: 0, idleCompact: 'off' }

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
const ANNOUNCE = { idleAsk: 'never', idleRenewals: 0, idleAnnounce: true, idleCompact: 'on' }

test('an announcement the person interrupts is not followed by a compaction', { options: ANNOUNCE, timeoutMs: LONG }, async ($, on) => {
  const { clock, seen } = await idle($, on)
  await clock.advance(240 * S)
  expect(seen.did).toEqual(['prepare'])
  expect(await bandText($)).toBe('h⣿ Cache Bell: announcing the compaction…')

  // Esc in the announcement's turn. A status asked for in it is said at once, as in any turn.
  await $.turn.start({ text: 'announcement', turnId: 'a' })
  expect(await busyStatus($, seen)).toMatch(/State: warm, announcing the compaction/)
  await $.turn.complete({ turnId: 'a', answer: '', durationMs: 0, isAborted: true, reason: 'aborted' })
  await clock.settle()
  await clock.advance(20 * S)
  expect(seen.did).toEqual(['prepare'])
  expect(seen.toasts).toEqual(['The compaction was called off: its announcement did not finish.'])
  expect(await bandText($)).toMatch(/nothing will be done$/)
})

test('an announcement another plugin dropped leaves the conversation as it is', { options: ANNOUNCE, timeoutMs: LONG }, async ($, on) => {
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
  expect(await busyStatus($, seen)).toMatch(/State: busy/)
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

test('a compaction waits for a subagent that still runs and follows once it is done', { options: ANNOUNCE, timeoutMs: LONG }, async ($, on) => {
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
test('a key pressed while the compaction is announced holds it back, with no second announcement', { options: { ...ANNOUNCE, cacheTtl: '1h' } }, async ($, on) => {
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

test('a digit that selects a choice is an answer, not typing', { options: { idleAsk: 'first', idleRenewals: 0, idleAnnounce: false, compactOnRequest: 'auto' } }, async ($, on) => {
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

test('what the session asked for and a subagent held back is done after the turn that brings the result', { options: { compactOnRequest: 'auto' } }, async ($, on) => {
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

test('a key pressed while the question is up means the timer compacts nothing under the person', { options: { idleAsk: 'first', idleRenewals: 0 } }, async ($, on) => {
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

test('what the session asked for waits while its subagent still runs', { options: { compactOnRequest: 'auto' } }, async ($, on) => {
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

test('a compaction that fails with an error leaves the cache cold, says so and logs nothing', { options: COMPACT_ONLY, timeoutMs: LONG }, async ($, on) => {
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

test('a log that cannot be written does not stand in the way of the compaction', { options: COMPACT_ONLY }, async ($, on) => {
  const { clock, seen } = await idle($, on)
  answers.isStoreBroken = true
  await clock.advance(241 * S)
  expect(seen.did.length).toBe(1)
  expect(await status($)).toMatch(/State: dormant/)
  expect(seen.toasts).toEqual([])
  expect(seen.logs.length).toBe(1)
  expect(seen.logs[0]).toMatch(/^compaction not logged: /)
})

test('the log keeps its newest 200 entries and leaves the rest of the store alone', { options: COMPACT_ONLY }, async ($, on) => {
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

test('in the notify mode nothing is ever sent: no renewal, no announcement, no compaction', { options: NOTIFY, timeoutMs: LONG }, async ($, on) => {
  const { clock, seen } = await idle($, on)
  await clock.advance(210 * S)
  expect((await question($)).labels).toEqual(['[1]  Compact ', '[2]  Renew cache ', '[3] >Let it expire<'])
  await clock.advance(300 * S)
  expect(seen.did).toEqual([])
  expect(await status($)).toContain('State: cold, expired')
})

test('set to wait, what the session asked for is done only when the person says so', { options: { compactOnRequest: 'wait' }, timeoutMs: LONG }, async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const seen = stubs(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  // A first turn, and the transcript found by the session's id shows the five minutes.
  await turn($, clock, 0)
  await clock.advance(2 * S)
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

test('a turn nobody is known to have sent does not start the count of renewals over', { options: KEEP, timeoutMs: LONG }, async ($, on) => {
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

test('notify with a waiting session request sends nothing at all without the person', { options: { ...NOTIFY, compactOnRequest: 'wait' }, timeoutMs: LONG }, async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const seen = stubs(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await turn($, clock, 0)
  await clock.advance(2 * S)
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
  // Answered about the hour already: the notice asks nothing.
  seen.store.set('hour', 'no')
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const shown = await introDrawn($)
  expect(shown.hasButton).toBe(true)
  expect(shown.drawn).toBe(
    [
      'h⣿ Cache Bell: while you are away this plugin acts on its own, on your plan',
      'before the prompt cache expires it renews the prompt cache up to 2 times, then compacts the conversation',
      'Claude may ask for a compaction too: you get 30 s to cancel, or the time Claude names',
      'this notice is shown once: OK or your next message puts it away for good',
      'change it in /config: cache-bell.profile, cache-bell.compactOnRequest, cache-bell.enabled',
    ].join(''),
  )
  // Not yet seen: closing the session now shows it again next time.
  expect(seen.store.get('intro')).toBe(undefined)

  // The first message the person sends takes it down and it is remembered as seen.
  await enter($, 'hello')
  await turn($, clock, 0)
  expect(seen.store.get('intro')).toBe(2)
  await clock.advance(2 * S)
  expect(await bandText($)).toBe('h⣿ Cache Bell: prompt cache expires in 4:33')
})

test('OK takes the notice down, and a machine that has seen it is not told again', async ($, on) => {
  mock.clock(on, { now: T0 })
  const seen = stubs(on)
  seen.store.clear()
  // Answered about the hour already: the notice asks nothing.
  seen.store.set('hour', 'no')
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const ui = await $.ui.mount(abovePrompt())
  await ui.press({ key: 'intro-ok' })
  await ui.unmount()
  expect(seen.store.get('intro')).toBe(2)
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

test('OK in another session takes the notice down here too, but not one put up for a look', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const seen = stubs(on)
  seen.store.clear()
  // Answered about the hour already: the notice asks nothing.
  seen.store.set('hour', 'no')
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await clock.advance(10 * S)
  expect((await introDrawn($)).hasButton).toBe(true)
  // The other session writes what this one would have written.
  seen.store.set('intro', 2)
  await clock.advance(4 * S)
  await clock.settle()
  expect((await introDrawn($)).hasButton).toBe(false)
  await run($, 'show intro')
  await clock.advance(10 * S)
  await clock.settle()
  expect((await introDrawn($)).hasButton).toBe(true)
})

test('the real notice stays the real one under /bell show intro, and a look that is put away is not remembered', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const seen = stubs(on)
  seen.store.clear()
  // Answered about the hour already: the notice asks nothing.
  seen.store.set('hour', 'no')
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await run($, 'show intro')
  seen.store.set('intro', 2)
  await clock.advance(4 * S)
  await clock.settle()
  expect((await introDrawn($)).hasButton).toBe(false)
  // A look, on a machine that has not seen the notice: OK takes it down and writes nothing.
  seen.store.clear()
  await run($, 'show intro')
  const ui = await $.ui.mount(abovePrompt())
  await ui.press({ key: 'intro-ok' })
  await ui.unmount()
  expect((await introDrawn($)).hasButton).toBe(false)
  expect(seen.store.get('intro')).toBe(undefined)
})

test('a machine that has seen the notice starts without it', async ($, on) => {
  mock.clock(on, { now: T0 })
  stubs(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  expect(await bandText($)).toBe('drawn by Claude Code')
})

// The notice with the question about the rhythm of work: what it shows, and its two buttons.
const hourAsked = async ($: Engine) => {
  const ui = await $.ui.mount(abovePrompt())
  const drawn = flat(await ui.drawn())
  const first = await ui.find({ key: 'intro-hour' })
  const second = await ui.find({ key: 'intro-yes' })
  await ui.unmount()
  return { drawn, isAsked: first !== undefined || second !== undefined }
}

const press = async ($: Engine, key: string) => {
  const ui = await $.ui.mount(abovePrompt())
  await ui.press({ key })
  await ui.unmount()
}

test('the first-run notice asks what the person does after a reply; "within the hour" asks for the hour at the next cold moment', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const seen = stubs(on, { HOME: '/srv/jane' }, NO_RESPONSE)
  seen.store.clear()
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const shown = await hourAsked($)
  expect(shown.isAsked).toBe(true)
  expect(shown.drawn).toContain('When Claude finishes a reply, what do you usually do next?')
  expect(shown.drawn).toContain('/bell hour on|off changes it later')
  // Nothing is set by the answer itself: the hour waits for a request on a cold cache.
  await press($, 'intro-hour')
  expect(seen.store.get('hour')).toBe('yes')
  expect(seen.store.get('rhythm')).toBe('within-hour')
  expect(seen.store.get('intro')).toBe(2)
  expect(seen.envSet).toEqual([])
  expect(await bandText($)).toBe('drawn by Claude Code')
  await turn($, clock, 0)
  expect(seen.envSet).toEqual(HOUR_SET)
  expect(await status($)).toMatch(/Hour-long cache: asked for, not yet confirmed by a response/)
})

test('"Reply within a few minutes" asks for no hour and is remembered as the answer', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const seen = stubs(on, { HOME: '/srv/jane' }, NO_RESPONSE)
  seen.store.clear()
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await press($, 'intro-soon')
  expect(seen.store.get('hour')).toBe('no')
  expect(seen.store.get('rhythm')).toBe('soon')
  expect(seen.store.get('intro')).toBe(2)
  await turn($, clock, 0)
  expect(seen.envSet).toEqual([])
})

test('a message instead of an answer asks for no hour and is no answer', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const seen = stubs(on, { HOME: '/srv/jane' }, NO_RESPONSE)
  seen.store.clear()
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await turn($, clock, 0)
  expect(seen.store.get('hour')).toBe(undefined)
  expect(seen.store.get('intro')).toBe(2)
  expect(seen.envSet).toEqual([])
  expect(await status($)).not.toMatch(/Hour-long cache/)
})

test('a machine that saw the notice before it asked about the hour sees it again, unless the hour is settled otherwise', async ($, on) => {
  mock.clock(on, { now: T0 })
  const seen = stubs(on, { HOME: '/srv/jane', CLAUDE_CODE_PROMPT_CACHE_TTL: '5m' })
  seen.store.set('intro', 1)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  // A TTL of the person's own: nothing new to tell.
  expect(await bandText($)).toBe('drawn by Claude Code')
})

test('a machine that ran 0.2.x is told once that Claude now compacts past the level, and how to keep the old ways', { options: { compactLevelK: 200 } }, async ($, on) => {
  mock.clock(on, { now: T0 })
  const seen = stubs(on, { HOME: '/srv/jane', CLAUDE_CODE_PROMPT_CACHE_TTL: '5m' })
  seen.store.set('intro', 1)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  // The hour is settled by the person's own TTL: only the new level is told.
  expect((await introDrawn($)).drawn).toContain('new in 0.3.4: by default, Claude now compacts by itself once the context passes 200K, after a finished piece of work, with a countdown to cancel. For warnings only, set cache-bell.profile to watch; the CHANGELOG has the details')
  const ui = await $.ui.mount(abovePrompt())
  await ui.press({ key: 'intro-ok' })
  await ui.unmount()
  expect(seen.store.get('intro')).toBe(2)
})

test('a new machine is told the level, and that /bell set changes it', { options: { compactLevelK: 200 } }, async ($, on) => {
  mock.clock(on, { now: T0 })
  const seen = stubs(on)
  seen.store.clear()
  seen.store.set('hour', 'no')
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  expect((await introDrawn($)).drawn).toContain('past 200K Claude compacts the conversation itself at a good moment (/bell set changes it for this session)')
})

test('a machine that saw the notice before it asked about the hour is asked now', async ($, on) => {
  mock.clock(on, { now: T0 })
  const seen = stubs(on)
  seen.store.set('intro', 1)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  expect((await hourAsked($)).isAsked).toBe(true)
  // Pauses the five minutes cover, or ones the hour would not outlast either: no hour.
  await press($, 'intro-hours')
  expect(seen.store.get('hour')).toBe('no')
  expect(seen.store.get('rhythm')).toBe('hours')
  expect(seen.store.get('intro')).toBe(2)
})

test('/bell hour on asks for the hour at the next cold moment, off gives it back at once',{ options: { idleAsk: 'never', idleRenewals: 0, idleCompact: 'off' } }, async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const seen = stubs(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  expect(await run($, 'hour')).toEqual({ text: 'You did not answer yet: the hour-long cache is not asked for.' })
  expect(await run($, 'hour maybe')).toEqual({ text: 'Usage: /bell hour [on|off]' })
  await turn($, clock, 0)
  await clock.advance(2 * S)
  expect((await run($, 'hour on')).text).toBe('On: Cache Bell asks Claude Code for the hour-long cache.\nIt takes effect at the next moment the prompt cache is cold anyway, in every session on this machine.')
  // Warm: nothing yet.
  await turn($, clock, 0)
  expect(seen.envSet).toEqual([])
  await clock.advance(400 * S)
  await turn($, clock, 0)
  expect(seen.envSet).toEqual(HOUR_SET)
  expect((await run($, 'hour off')).text).toBe('Off: Cache Bell does not ask for the hour-long cache.\nThe hour asked for in this session is given back now; other sessions give it back with their next request.')
  expect(seen.envSet).toEqual([...HOUR_SET, ...HOUR_DROPPED])
  expect(await status($)).toMatch(/Cache TTL: 5m \(assumed, not yet seen in the data\)/)
  // Off again: nothing more to give back.
  expect((await run($, 'hour off')).text).toBe('Off: Cache Bell does not ask for the hour-long cache.')
})

test('back within the hour after the plugin\'s own compaction, the person gets a second chance, once on a machine', { options: COMPACT_ONLY, timeoutMs: LONG }, async ($, on) => {
  const { clock, seen } = await idle($, on)
  seen.store.set('hour', 'no')
  await clock.advance(241 * S)
  expect(seen.did[0]).toMatch(/^compact/)
  // Back ten minutes later: the turn ends with the question.
  await clock.advance(600 * S)
  await turn($, clock, 0)
  const shown = await hourAsked($)
  expect(shown.isAsked).toBe(true)
  expect(shown.drawn).toContain('you came back 10 minutes after a compaction')
  expect(shown.drawn).toContain('Switch to the hour-long cache?')
  await press($, 'intro-yes')
  expect(seen.store.get('hour')).toBe('yes')
  expect(seen.store.get('hourSecond')).toBe(1)
  // The first-run notice stays as it was.
  expect(seen.store.get('intro')).toBe(2)
})

test('No to the second chance is kept: after the next compaction it is not asked again', { options: COMPACT_ONLY, timeoutMs: LONG }, async ($, on) => {
  const { clock, seen } = await idle($, on)
  seen.store.set('hour', 'no')
  await clock.advance(241 * S)
  await clock.advance(600 * S)
  await turn($, clock, 0)
  await press($, 'intro-no')
  expect(seen.store.get('hour')).toBe('no')
  expect(seen.store.get('hourSecond')).toBe(1)
  expect(seen.envSet).toEqual([])
  // Idle again, compacted again, back within the hour: no question.
  await clock.advance(241 * S)
  expect(seen.did.filter(did => did.startsWith('compact')).length).toBe(2)
  await clock.advance(600 * S)
  await turn($, clock, 0)
  expect((await hourAsked($)).isAsked).toBe(false)
})

for (const [name, kept, options, ownTtl] of [
  ['to whoever said yes', { hour: 'yes' }, {}, false],
  ['a second time on the machine', { hourSecond: 1 }, {}, false],
  ['where cacheRequestHour is off', { hour: 'no' }, { cacheRequestHour: 'off' }, false],
  ['where cacheRequestHour is on', { hour: 'no' }, { cacheRequestHour: 'on' }, false],
  ['to whoever set a TTL of their own', { hour: 'no' }, {}, true],
] as [string, Record<string, unknown>, Record<string, unknown>, boolean][]) {
  test(`no second chance ${name}`, { options: { ...COMPACT_ONLY, ...options }, timeoutMs: LONG }, async ($, on) => {
    const { clock, seen } = await idle($, on)
    for (const [key, value] of Object.entries(kept)) seen.store.set(key, value)
    if (ownTtl) answers.settings = { promptCacheTtl: '5m' }
    await clock.advance(241 * S)
    expect(seen.did[0]).toMatch(/^compact/)
    await clock.advance(600 * S)
    await turn($, clock, 0)
    expect((await hourAsked($)).isAsked).toBe(false)
  })
}

test('no second chance after a compaction the session asked for: the hour would have spared none', { timeoutMs: LONG }, async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const seen = stubs(on)
  seen.store.set('hour', 'no')
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await turn($, clock, 0)
  await askingWith($, clock, undefined)
  await clock.advance(32 * S)
  await clock.settle()
  expect(seen.did.filter(did => did.startsWith('compact')).length).toBe(1)
  await clock.advance(600 * S)
  await turn($, clock, 0)
  expect((await hourAsked($)).isAsked).toBe(false)
})

// A turn in which the session asks for a compaction, with what it wants to be told after it. The turn is
// the person's, or the one the plugin's own note started.
const askingWith = async ($: Engine, clock: Clock, then: string | undefined, isPersons = true): Promise<string> => {
  if (isPersons) await $.prompt.submit({ text: 'wrap up', wait: false, origin: { kind: 'composer' } })
  await $.turn.start({ text: 'wrap up', turnId: 'w' })
  const stream = $.turn.step({ turnId: 'w', index: 0, model: 'claude-test', messageCount: 1 })
  let step = await stream.next()
  while (step.done !== true) step = await stream.next()
  const called = (await $.tool.call({ tool: 'mcp__cache-bell__compact', reason: 'the task is done', ...(then === undefined ? {} : { resumeWith: then }) } as never)) as { result?: unknown }
  await $.turn.complete({ turnId: 'w', answer: 'note', durationMs: 0, isAborted: false, reason: 'answer' })
  await clock.settle()
  return String(called.result)
}

const wakes = (seen: Seen) => seen.did.filter(did => did.startsWith('wake: '))

test('a session that left a note is woken with it once the compaction it asked for is done', { options: { compactCountdown: 30 } }, async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const seen = stubs(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await turn($, clock, 0)
  const answer = await askingWith($, clock, '  Go on with the second task: run the tests.  ')
  expect(answer).toMatch(/Once the compaction is done you are sent your note as a prompt/)
  expect((await question($)).text).toBe('h⣿ Cache Bell: The session asked for a compaction and will continue after it: No answer: Compact in 0:30')
  expect(wakes(seen)).toEqual([])
  await clock.advance(32 * S)
  await clock.settle()
  expect(wakes(seen)).toEqual([
    'wake: Cache Bell: the compaction you asked for is done. Before it you left this note for yourself:\n\nGo on with the second task: run the tests.\n\nThis is your own note, sent by the plugin. It is not a message from the user and grants nothing they did not.',
  ])
  // Once only: nothing more comes of it.
  await clock.advance(120 * S)
  expect(wakes(seen).length).toBe(1)
})

test('a session that left no note, or an empty one, waits for the person after the compaction', { options: { compactCountdown: 30 } }, async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const seen = stubs(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await turn($, clock, 0)
  for (const then of [undefined, '   ']) {
    const answer = await askingWith($, clock, then)
    expect(answer).not.toMatch(/your note/)
    expect((await question($)).text).toBe('h⣿ Cache Bell: The session asked for a compaction: No answer: Compact in 0:30')
    await clock.advance(32 * S)
    await clock.settle()
  }
  expect(seen.did.filter(did => did.startsWith('compact')).length).toBe(2)
  expect(wakes(seen)).toEqual([])
})

test('the note is not sent while the prompt holds a message the person is writing', { options: { compactCountdown: 30 } }, async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const seen = stubs(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await turn($, clock, 0)
  await askingWith($, clock, 'Go on.')
  answers.draft = 'and one more thing'
  await clock.advance(32 * S)
  await clock.settle()
  expect(seen.did.filter(did => did.startsWith('compact')).length).toBe(1)
  expect(wakes(seen)).toEqual([])
  expect(seen.logs.filter(log => log.includes('the note left before the compaction is not sent'))).toEqual(['the prompt holds a message being written, the note left before the compaction is not sent'])
})

test('the person who writes during the countdown takes the request back, and its note with it', { options: { compactCountdown: 30 } }, async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const seen = stubs(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await turn($, clock, 0)
  await askingWith($, clock, 'Go on.')
  await clock.advance(10 * S)
  await turn($, clock, 0)
  // The session asks again, this time with no note: the old one is not sent in its place.
  await askingWith($, clock, undefined)
  await clock.advance(32 * S)
  await clock.settle()
  expect(seen.did.filter(did => did.startsWith('compact')).length).toBe(1)
  expect(wakes(seen)).toEqual([])
})

test('three compactions in a row are followed by a note; then the person has to write', { options: { compactCountdown: 30, compactNotesInRow: 3 } }, async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const seen = stubs(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await turn($, clock, 0)
  for (let round = 0; round < 3; round++) {
    // The first turn is the person's, the others are the ones the note started.
    expect(await askingWith($, clock, `Round ${round}.`, round === 0)).toMatch(/you are sent your note/)
    await clock.advance(32 * S)
    await clock.settle()
    expect(wakes(seen).length).toBe(round + 1)
  }
  const refused = await askingWith($, clock, 'Round 3.', false)
  expect(refused).toMatch(/^Compaction requested\. .* Your note will not be sent: 3 compactions in a row were already followed by one, and the user has to write first\./)
  await clock.advance(32 * S)
  await clock.settle()
  expect(seen.did.filter(did => did.startsWith('compact')).length).toBe(4)
  expect(wakes(seen).length).toBe(3)
  // The person's message starts the count over.
  expect(await askingWith($, clock, 'Round 4.')).toMatch(/you are sent your note/)
  await clock.advance(32 * S)
  await clock.settle()
  expect(wakes(seen).length).toBe(4)
})

for (const [name, options, rounds] of [['five by default', {}, 5], ['any number with the limit off', { compactNotesInRow: 0 }, 7]] as const) {
  test(`notes in a row: ${name}`, { options: { compactCountdown: 30, ...options }, timeoutMs: LONG }, async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    const seen = stubs(on)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
    await turn($, clock, 0)
    for (let round = 0; round < rounds; round++) {
      expect(await askingWith($, clock, `Round ${round}.`, round === 0)).toMatch(/you are sent your note/)
      await clock.advance(32 * S)
      await clock.settle()
    }
    expect(wakes(seen).length).toBe(rounds)
    const next = await askingWith($, clock, 'One more.', false)
    if (rounds === 5) expect(next).toMatch(/Your note will not be sent: 5 compactions in a row/)
    else expect(next).toMatch(/you are sent your note/)
  })
}

test('a compaction that fails, or one the person calls off, is followed by no note', { options: { compactCountdown: 30 }, timeoutMs: LONG }, async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const seen = stubs(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await turn($, clock, 0)
  await askingWith($, clock, 'Go on.')
  answers.compactSkip = true
  await clock.advance(32 * S)
  await clock.settle()
  expect(seen.did.filter(did => did.startsWith('compact')).length).toBe(1)
  expect(wakes(seen)).toEqual([])
  answers.compactSkip = false
  // Asked again and called off: "2" and Enter is Not now.
  await askingWith($, clock, 'Go on.')
  await edit($, '', 0, 0, '2')
  await enter($, '2')
  await clock.advance(600 * S)
  await clock.settle()
  expect(wakes(seen)).toEqual([])
})

test('of two requests in one turn the note passed last counts; a digit left in the prompt is no message', { options: { compactCountdown: 30 } }, async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const seen = stubs(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await turn($, clock, 0)
  await $.prompt.submit({ text: 'wrap up', wait: false, origin: { kind: 'composer' } })
  await $.turn.start({ text: 'wrap up', turnId: 'w' })
  const stream = $.turn.step({ turnId: 'w', index: 0, model: 'claude-test', messageCount: 1 })
  let step = await stream.next()
  while (step.done !== true) step = await stream.next()
  const first = (await $.tool.call({ tool: 'mcp__cache-bell__compact', reason: 'done' } as never)) as { result?: unknown }
  expect(String(first.result)).not.toMatch(/your note/)
  const second = (await $.tool.call({ tool: 'mcp__cache-bell__compact', reason: 'done', resumeWith: 'First.' } as never)) as { result?: unknown }
  expect(String(second.result)).toMatch(/you are sent your note/)
  const third = (await $.tool.call({ tool: 'mcp__cache-bell__compact', reason: 'done', resumeWith: 'Second.' } as never)) as { result?: unknown }
  expect(String(third.result)).toMatch(/you are sent your note/)
  // A call with no note leaves the last one standing, and says so.
  const fourth = (await $.tool.call({ tool: 'mcp__cache-bell__compact', reason: 'done' } as never)) as { result?: unknown }
  expect(String(fourth.result)).toMatch(/you are sent your note/)
  await $.turn.complete({ turnId: 'w', answer: 'note', durationMs: 0, isAborted: false, reason: 'answer' })
  await clock.settle()
  answers.draft = '1'
  await clock.advance(32 * S)
  await clock.settle()
  expect(wakes(seen).map(wake => /\n\n(.*)\n\n/.exec(wake)?.[1])).toEqual(['Second.'])
})

test('a compaction the timers bring wakes nobody, also after a request that was taken back', { options: COMPACT_ONLY }, async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const seen = stubs(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await turn($, clock, 0)
  await askingWith($, clock, 'Go on.')
  await clock.advance(5 * S)
  // The person writes: the request is off. Then they leave, and the cache takes its course to the compaction.
  await turn($, clock, 0)
  await clock.advance(300 * S)
  await clock.settle()
  expect(seen.did.filter(did => did.startsWith('compact')).length).toBe(1)
  expect(wakes(seen)).toEqual([])
})

// The manifest lists the words: Claude Code hands the plugin the default in place of any other, and says so itself.
test('an option set to a word it does not take reads as the default', { options: { profile: 'kep', cacheTtl: '10m' } }, async ($, on) => {
  mock.clock(on, { now: T0 })
  stubs(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const report = await status($)
  expect(report).toContain('on, bellcompact[off]')
  // Where the manifest lists the words an option takes, Claude Code hands over the default and there is
  // nothing to say. Where it lists none (the form for a place that takes no such lists), the word comes
  // through and the report names it.
  if (report.includes('is set to')) {
    expect(report).toContain('profile is set to "kep", which is not one of off, watch, bellcompact; the default, bellcompact, is used')
    expect(report).toContain('cacheTtl is set to "10m", which is not one of auto, settings, 5m, 1h; the default, auto, is used')
  }
})

test('the note is also taken under the name the parameter had before 0.2.7', { options: { compactCountdown: 30 } }, async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const seen = stubs(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await turn($, clock, 0)
  await $.prompt.submit({ text: 'wrap up', wait: false, origin: { kind: 'composer' } })
  await $.turn.start({ text: 'wrap up', turnId: 'w' })
  const called = (await $.tool.call({ tool: 'mcp__cache-bell__compact', reason: 'done', then: 'Go on.' } as never)) as { result?: unknown }
  expect(String(called.result)).toMatch(/you are sent your note as a prompt/)
  await $.turn.complete({ turnId: 'w', answer: 'note', durationMs: 0, isAborted: false, reason: 'answer' })
  await clock.settle()
  await clock.advance(32 * S)
  await clock.settle()
  expect(wakes(seen).length).toBe(1)
  expect(wakes(seen)[0]).toContain('Go on.')
})

// Of the two names of the note the new one counts; an empty new one leaves the old.
for (const [passed, sent] of [[{ resumeWith: 'New.', then: 'Old.' }, 'New.'], [{ resumeWith: '  ', then: 'Old.' }, 'Old.']] as const) {
  test(`a request with resumeWith "${passed.resumeWith}" and then "${passed.then}" is followed by "${sent}"`, { options: { compactCountdown: 30 } }, async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    const seen = stubs(on)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
    await turn($, clock, 0)
    await $.prompt.submit({ text: 'wrap up', wait: false, origin: { kind: 'composer' } })
    await $.turn.start({ text: 'wrap up', turnId: 'w' })
    await $.tool.call({ tool: 'mcp__cache-bell__compact', reason: 'done', ...passed } as never)
    await $.turn.complete({ turnId: 'w', answer: 'note', durationMs: 0, isAborted: false, reason: 'answer' })
    await clock.settle()
    await clock.advance(32 * S)
    await clock.settle()
    expect(wakes(seen).length).toBe(1)
    expect(wakes(seen)[0]).toContain(`\n\n${sent}\n\n`)
  })
}

test('the report says on which surfaces the band was asked for and drawn, and which came and went', async ($, on) => {
  on('session.attach', async (_, e) => ({ clientId: e.clientId }))
  on('session.detach', async (_, e) => ({ clientId: e.clientId }))
  mock.clock(on, { now: T0 })
  stubs(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const before = (await run($, 'report')).text ?? ''
  const count = (text: string, row: string, surface: string): number => Number(new RegExp(`${row}: [^·]*${surface} (\\d+)`).exec(text)?.[1] ?? 0)
  await run($, 'demo 30')
  await question($, 'desktop')
  await $.session.attach({ surface: 'mobile', clientId: 'phone-of-jane' })
  await $.session.detach({ surface: 'mobile', clientId: 'phone-of-jane', reason: 'detached' })
  const after = (await run($, 'report')).text ?? ''
  expect(count(after, 'band asked for', 'desktop')).toBe(count(before, 'band asked for', 'desktop') + 1)
  expect(count(after, 'drawn', 'desktop')).toBe(count(before, 'drawn', 'desktop') + 1)
  expect(after).toMatch(/seen: [^·]*mobile attached, mobile left$/m)
  expect(after).not.toContain('jane')
})

// What Claude Code passes for the row of a tool call.
const toolUse = (tool: string, input: unknown, surface: 'terminal' | 'desktop' = 'terminal') => ({
  plugin: 'cache-bell',
  component: 'ToolUse' as const,
  requestId: 'toolu_1',
  surface,
  viewport: { columns: 80, rows: 30 },
  props: { tool_use_id: 'toolu_1', tool, input, isRunning: false, isErrored: false, isInterrupted: false },
})

test('the row of a compact call is drawn with the reason alone; other tools and the desktop app are left as they are', async ($, on) => {
  mock.clock(on, { now: T0 })
  const seen = stubs(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const input = { reason: 'Done.', resumeWith: 'Go on with the tests. '.repeat(40), countdown: 30 }
  for (const row of [toolUse('mcp__cache-bell__compact', input), toolUse('Bash', input), toolUse('mcp__cache-bell__compact', input, 'desktop')]) {
    const ui = await $.ui.mount(row as never)
    await ui.unmount()
  }
  expect(seen.rows).toEqual([{ reason: 'Done.' }, input, input])
})
