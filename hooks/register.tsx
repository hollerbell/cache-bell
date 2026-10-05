// The only file that touches `$`. It observes the session, hands each observation to the pure core
// (core/decide.ts) and carries out what the core answers. What is done about the cache is decided there;
// here are the question as the person sees it, the /bell command and the log of compactions.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { CACHE_SOON, CHOICES, CHOICES_OF, FRAME_MS, SUBAGENT_ANSWER, YIELDED_ANSWER, askView, choiceLabel, choiceOfDigit, choiceTexts, choicesOf, chosenNotice, digitOf, dropReason, questionParts, reloadNotice, requestAnswer, skippedNotice, wakeOf, wakePrompt, whyText, withdrawAnswer, WAKES_MAX, WAKE_MAX_CHARS, WAKE_OVERTAKEN, WAKE_TYPING, WAKE_WHY } from '../core/ask'
import type { AskStyle, Choice, ChoiceText, Wake } from '../core/ask'
import { resolveConfig, unknownWords } from '../core/config'
import { decide, fallbackOf, initialState, needsHold } from '../core/decide'
import { NONE } from '../core/extension'
import type { Extend, Extension } from '../core/extension'
import { COUNTDOWN_MAX_S, COUNTDOWN_MIN_S, countdownOf, fillInstructions, holdOf, isCacheHit } from '../core/guards'
import { LOG_KEEP, LOG_SHOWN, OWN_CAUSE, isLogEntry, isLogKey, logEntry, logKey, logReport, outdated } from '../core/log'
import type { Cause, LogEntry } from '../core/log'
import { parseTtl, ttlFromSettings } from '../core/timing'
import { tailCommand, ttlFromTranscript } from '../core/transcript'
import type { Action, AskReason, Config, Hold, Observation, State } from '../core/types'
import { BAND_PREFIX, INTRO_KEY, INTRO_SEEN, MARK, PALETTE, PLUGIN, band, introOf, lookOf, sampleBand, statusEntry, statusReport, versionOf } from '../core/view'
import type { Band, Intro, Look } from '../core/view'

const machine = atom({ plugin: 'cache-bell', key: 'machine' } as const, null)
// The path of the session's transcript: a read that failed is tried again also after the plugin was loaded anew.
const transcript = atom({ plugin: 'cache-bell', key: 'transcript' } as const, null)
// The plugin built on this one says here that it runs in the session. This one then stands down, so the
// session is watched, asked about and compacted once, not twice.
const superior = atom({ plugin: 'holler-bell', key: 'isRunning' } as const, false)

const TICK_MS = 1000
// How often a session that shows the first-run notice asks the store whether another session put it away.
const INTRO_ASK_MS = 3000
// $.fs.read refuses a larger file; a long session's transcript is larger.
const FS_READ_LIMIT = 4 * 1024 * 1024
// How much of a larger file's end is read at the most, and at the least: a response's row is far smaller,
// but a row with a picture in it is not.
const TAIL_MAX_BYTES = 1024 * 1024
const TAIL_MIN_BYTES = 64 * 1024
// A TTL the transcript has confirmed is looked up again no sooner than this after the last read. It changes
// only when the model does (which is reported) or when Claude Code falls back to the short cache, and that
// has to be known before the short cache's time to act.
const RECHECK_MS = 2 * 60 * 1000
// After a read that failed: when it is tried again, the first, the second and every later time.
const REREAD_MS = [15 * 1000, 60 * 1000]
const REREAD_LATER_MS = 5 * 60 * 1000

// The module's own variables start over at every reload; what must survive one is in `$.state`.
let ticker: { cancel: () => void } | null = null
let lastTickAt = 0
// The session's transcript, as the last Stop named it, and what is known of reading it: the file's size
// and the time at the last read that went through, how many failed since, and when to try again.
let transcriptPath: string | undefined
let readSize: number | null = null
let readAt: number | null = null
let unread = 0
let rereadAt: number | null = null
let isReading = false
let drawn = ''
// Whether what a reload left behind in the state has been dealt with: once, at the first observation.
let isRecovered = false
// True until session.start says nobody is at the prompt: after a reload the session's events may come before
// session.start does, and they must not be lost.
let isWatching = true
// The plugin built on this one runs in the session: until the next reload this one does nothing.
let isYielding = false
// The background the colours are picked for.
let look: Look = 'dark'
// Observations are applied one at a time, in the order they came.
let queue: Promise<void> = Promise.resolve()

// Who started the turn that is about to begin, as its prompt.submit said: the plugin's own announcement,
// the person, or somebody else (a background task, another session). A turn no prompt.submit came before,
// or one whose origin says nothing, is unknown: it does not start the count of renewals over as the
// person's does, and it does not carry a question over as somebody else's does.
type TurnBy = 'person' | 'self' | 'other' | 'unknown'
let nextTurnBy: TurnBy = 'unknown'
// Who started the turn that is running.
let turnBy: TurnBy = 'unknown'
// The origins of a prompt that are known not to be the person.
const OTHERS = ['task-notification', 'scheduled-trigger', 'peer', 'plugin']

// Why the plugin's next compaction comes and who decided, kept from the question or the request to the
// compaction itself; `note` is what the session said when it asked. A compaction the plugin runs is logged
// where it is run, not in the hook every compaction passes.
let cause: Cause = OWN_CAUSE
let note = ''
// What the session wants to be told once the compaction it asked for is done; it lives and ends with `note`.
let wakeText = ''
// How many compactions in a row a prompt followed, with no message from the person between them.
let wakesInRow = 0
// The prompt that is on its way to the session, and the turns counted when its compaction ended: a turn
// that began since takes the prompt back.
let wakeSent: string | null = null
let turnsStarted = 0
let wakeAtTurns = 0
let isOwnCompaction = false

// What a plugin built on this one adds (core/extension.ts), and every answer's words with it. Set once, when
// the hooks are registered.
let extension: Extension = NONE
let texts: Readonly<Record<string, ChoiceText>> = CHOICES

// An answer nobody has words for is shown by its name.
const textOf = (choice: Choice): ChoiceText => texts[choice] ?? { label: choice }

// The band's text depends on the clock, the state does not change between ticks: redraw only when the text
// to show really changed.
const draw = async ($: EngineInterface, config: Config, state: State) => {
  const now = await $.clock.now()
  const entry = statusEntry(state, now, config)
  const view = band(state, now, config)
  const next = `${view?.text ?? ''}|${view?.tone ?? ''}|${entry ?? ''}`
  if (next === drawn) return
  drawn = next
  if (config.display === 'status' || config.display === 'both') $.ui.status(entry)
  $.ui.invalidate('ui.render')
}

const RELOADED = 'The plugin was loaded again in the middle of a step: nothing more is done until you work in this session again.'

// The state outlives a reload, what the plugin had in hand does not. A question is put up again for the time
// it has left. A step that was running (a renewal, the announcement, the compaction) may or may not have gone
// through: it is not repeated, the course ends here.
const recover = async ($: EngineInterface, config: Config, state: State, now: number): Promise<State> => {
  if (state.phase === 'ASKING' && state.askReason !== null) {
    // Switched off, or standing down for the plugin built on this one: the core drops the question itself.
    if (question === null && config.enabled && !isYielding) ask($, config, state, now, state.askReason, state.askDeadline ?? now, fallbackOf(state, config, extension))
    return state
  }
  if (state.phase !== 'RENEWING' && state.phase !== 'PREPARING' && state.phase !== 'COMPACTING') return state
  const { state: rested, actions } = decide(state, now, { kind: 'refused', reason: RELOADED }, config, extension)
  await update($, machine, () => rested)
  for (const action of actions) perform($, config, action, rested, now)
  return rested
}

const apply = async ($: EngineInterface, config: Config, observation: Observation) => {
  const now = await $.clock.now()
  const stored = (await read($, machine)) ?? initialState(config)
  const isFirst = !isRecovered
  isRecovered = true
  const before = isFirst ? await recover($, config, stored, now) : stored
  const { state, actions } = decide(before, now, observation, config, extension)
  if (state !== before) await update($, machine, () => state)
  for (const action of actions) perform($, config, action, state, now)
  // Nothing drawn yet since the plugin was loaded: a reload in a running session wiped the status line, and
  // a state that no longer changes (a cold cache) would never put it back.
  if (actions.length > 0 || drawn === '') await draw($, config, state)
}

const observe = ($: EngineInterface, config: Config, observation: Observation): Promise<void> => {
  queue = queue
    .then(() => apply($, config, observation))
    .catch(err => $.ui.log(`${observation.kind} failed: ${String(err)}`))
  return queue
}

// When the person last changed the prompt box, a digit that answers the open question aside. What the box
// holds is not kept. null = not since the plugin was loaded.
let lastEditAt: number | null = null

// Claude Code could not list its subagents: said once, and not asked again until the plugin is loaded anew.
let isListless = false

const agentsNow = async ($: EngineInterface) => {
  if (isListless) return []
  try {
    return await $.agent.list()
  } catch (err) {
    isListless = true
    $.ui.log(`subagents not listed, a compaction will not wait for them: ${String(err)}`)
    return []
  }
}

// What stands in the way of a compaction right now: the person is typing, or a subagent still runs.
const holdNow = async ($: EngineInterface, state: State | null): Promise<Hold | null> => {
  const now = await $.clock.now()
  // A compaction waits for typing and no key is remembered: the plugin was loaded again meanwhile. Whoever
  // was typing may still be, so the minute starts over.
  if (lastEditAt === null && state?.held?.by === 'typing') lastEditAt = now
  return holdOf(lastEditAt === null ? null : now - lastEditAt, await agentsNow($))
}

const tick = async ($: EngineInterface, config: Config) => {
  if (await yields($)) return
  const now = await $.clock.now()
  const gapMs = lastTickAt === 0 ? 0 : now - lastTickAt
  lastTickAt = now
  // Before the core's turn: the queue it waits for may be long.
  await followIntro($, now)
  const state = await read($, machine)
  const hold = state !== null && needsHold(state, now, config) ? await holdNow($, state) : null
  await observe($, config, { kind: 'tick', gapMs, hold })
  // The plugin was loaded anew with a read still owed: what the module knew of it is gone.
  if (state?.isTtlUnread === true && rereadAt === null && unread === 0 && !isReading && config.ttlMs === null) {
    if (!config.readTranscript) {
      // Nothing will be read: the default is all there is.
      await observe($, config, { kind: 'ttl-unread', isUnread: false })
    } else {
      transcriptPath ??= (await read($, transcript)) ?? undefined
      if (transcriptPath !== undefined) rereadAt = now
    }
  }
  // A read that failed, or was put off, is done without waiting for the next turn: an idle session has none.
  if (rereadAt !== null && now >= rereadAt) void readTranscriptTtl($, config, transcriptPath).catch(err => $.ui.log(`transcript not read: ${String(err)}`))
}

// What the person asked Claude Code for. Settings are read by name: the object can hold secrets.
const readSettingsTtl = async ($: EngineInterface): Promise<number | null> => {
  const settings = (await $.settings.read()) as { promptCacheTtl?: unknown }
  return ttlFromSettings({
    force5m: await $.env.get('FORCE_PROMPT_CACHING_5M'),
    envTtl: await $.env.get('CLAUDE_CODE_PROMPT_CACHE_TTL'),
    settingTtl: settings.promptCacheTtl,
  })
}

// The end of the transcript: a small file whole, of a large one only what was appended since the last read.
const readTail = async ($: EngineInterface, path: string, size: number): Promise<string> => {
  if (size <= FS_READ_LIMIT) return $.fs.read(path)
  const added = readSize !== null && size > readSize ? size - readSize : TAIL_MAX_BYTES
  const bytes = Math.min(Math.max(added, TAIL_MIN_BYTES), TAIL_MAX_BYTES)
  const isWindows = (await $.env.get('OS')) === 'Windows_NT'
  const result = await $.process.run(tailCommand(path, bytes, isWindows), { timeoutMs: 10000 })
  if (result.exitCode !== 0) throw new Error(`tail exited with ${result.exitCode}`)
  return result.stdout
}

// The TTL the API really granted is only in the transcript. It is read while it is not known, and then
// seldom: a file that did not grow is not read at all, and a confirmed TTL is looked up again only now and
// then. A read that fails is tried again, and until one goes through the core is told that the TTL is not
// read. Where there is nothing to read (reading switched off, no transcript), the TTL stays what the
// settings or the default say.
async function readTranscriptTtl($: EngineInterface, config: Config, path: string | undefined): Promise<void> {
  if (!config.readTranscript || config.ttlMs !== null || path === undefined || path === '' || isReading) return
  isReading = true
  try {
    // A session that keeps no transcript (a child session, persistence switched off) has nothing to read.
    if (!(await $.fs.exists(path))) {
      // The file is gone in the middle of a run of failures: there is nothing left to try.
      if (unread > 0) await observe($, config, { kind: 'ttl-unread', isUnread: false })
      unread = 0
      rereadAt = null
      return
    }
    const { size } = await $.fs.stat(path)
    const now = await $.clock.now()
    const state = await read($, machine)
    const isConfirmed = state !== null && state.ttlSource === 'transcript' && !state.isTtlUnread
    if (unread === 0 && size === readSize) {
      rereadAt = null
      return
    }
    // Read a moment ago: what was appended since is read once that moment has passed, turn or no turn.
    if (unread === 0 && isConfirmed && readAt !== null && now - readAt < RECHECK_MS) {
      rereadAt = readAt + RECHECK_MS
      return
    }
    const ttlMs = ttlFromTranscript(await readTail($, path, size))
    readSize = size
    readAt = now
    unread = 0
    rereadAt = null
    await observe($, config, ttlMs === null ? { kind: 'ttl-unread', isUnread: false } : { kind: 'ttl', ttlMs, source: 'transcript' })
  } catch (err) {
    unread += 1
    rereadAt = (await $.clock.now()) + (REREAD_MS[unread - 1] ?? REREAD_LATER_MS)
    // Said once for a run of failures, not at every try.
    if (unread === 1) $.ui.log(`transcript not read, it is tried again: ${String(err)}`)
    await observe($, config, { kind: 'ttl-unread', isUnread: true })
  } finally {
    isReading = false
  }
}

// Safe to call any number of times: a reload runs session.start again with the old timers already dropped.
const observeSettingsTtl = async ($: EngineInterface, config: Config) => {
  if (config.ttlMs !== null) return
  try {
    const ttlMs = await readSettingsTtl($)
    if (ttlMs !== null) await observe($, config, { kind: 'ttl', ttlMs, source: 'settings' })
  } catch (err) {
    $.ui.log(`settings not read: ${String(err)}`)
  }
}

// The question in the band: asked, counted down, answered by a click, by a digit and Enter, or by the time
// running out. `selected` is what the time running out does; the person moves it by typing a choice's digit
// into the prompt. The countdown never stands still.
type Question = {
  startedAt: number
  totalMs: number
  style: AskStyle
  selected: Choice
  // the prompt holds exactly the selected choice's digit: Enter would confirm it
  isTyped: boolean
  // a demo that stays up while messages are sent, to see the band next to a running turn
  isSticky: boolean
  // what an empty prompt selects: the choice the question opened with
  fallback: Choice
  // the choices offered, in the order of their digits, and why the question is asked
  choices: readonly Choice[]
  why: string
  // where a real question's answer goes, with whether the timer gave it; null for a demo, which only
  // says what was chosen
  answer: ((choice: Choice, isTimers: boolean) => void) | null
}
type How = 'clicked' | 'typed and confirmed with Enter' | 'time ran out'

const DEMO_CHOICE: Choice = 'compact'

const leftOf = (asked: Question, now: number): number => asked.startedAt + asked.totalMs - now

const demoStyle = (word: string | undefined): AskStyle => (word === 'bg' ? 'bg' : 'text')

let question: Question | null = null
// A look of the band held for a screenshot (/bell show); null = the real state is drawn.
let shown: Band | null = null
let blinker: { cancel: () => void } | null = null
// The first-run notice while it is up: what the plugin does without the person. null = seen, or nothing to say.
let intro: Intro | null = null
// When the store was last asked whether the notice was put away in another session; 0 = not yet.
let introAskedAt = 0
// The notice is up for a look only (/bell show intro): the store neither takes it down nor learns of it.
let isIntroLook = false

const endQuestion = ($: EngineInterface, said: string) => {
  if (question === null) return
  question = null
  blinker?.cancel()
  blinker = null
  $.ui.invalidate('ui.render')
  $.ui.toast(said)
}

// Takes the question down without a word: the core closed it (work resumed, the cache ran out).
const dropQuestion = ($: EngineInterface) => {
  if (question === null) return
  question = null
  blinker?.cancel()
  blinker = null
  $.ui.invalidate('ui.render')
}

const closeQuestion = ($: EngineInterface, choice: Choice, how: How) => {
  const answer = question?.answer ?? null
  if (answer === null) return endQuestion($, `Demo: ${textOf(choice).label} (${how}). Nothing was sent to the model.`)
  // A choice the person selected by its digit is theirs, also when the time ran out on it.
  const isTimers = how === 'time ran out' && question?.isTyped !== true
  dropQuestion($)
  if (choice === 'skip') $.ui.toast(skippedNotice(isTimers))
  if (choice === 'compact') cause = { ...cause, by: isTimers ? 'timer' : 'person' }
  answer(choice, isTimers)
}

const blink = async ($: EngineInterface) => {
  const now = await $.clock.now()
  // The question may have been closed while the clock was read.
  if (question === null) return
  if (leftOf(question, now) <= 0) closeQuestion($, question.selected, 'time ran out')
  else $.ui.invalidate('ui.render')
}

// A demo question: the cache question's choices and words, no answer to carry out.
const DEMO: Pick<Question, 'isSticky' | 'fallback' | 'answer' | 'choices' | 'why'> = { isSticky: false, fallback: DEMO_CHOICE, answer: null, choices: CHOICES_OF.cache, why: CACHE_SOON }

const openQuestion = async ($: EngineInterface, asked: Omit<Question, 'startedAt' | 'selected' | 'isTyped'>) => {
  const startedAt = await $.clock.now()
  // A digit already in the prompt box is the person's choice: a question that comes back (after another
  // session's turn, after a reload) must not forget it.
  const typed = choiceOfDigit(asked.choices, (await $.prompt.read()).text)
  // Nothing is awaited from here on, so two questions opened at once leave one timer.
  blinker?.cancel()
  question = { ...asked, startedAt, selected: typed ?? asked.fallback, isTyped: typed !== null }
  blinker = $.clock.every(FRAME_MS, () => void blink($))
  $.ui.invalidate('ui.render')
}

// What the prompt box holds decides what is selected: exactly a choice's digit selects that choice, anything
// else (an empty box, other text) puts the default back.
const draftChanged = ($: EngineInterface, draft: string) => {
  if (question === null) return
  const typed = choiceOfDigit(question.choices, draft)
  question = { ...question, selected: typed ?? question.fallback, isTyped: typed !== null }
  $.ui.invalidate('ui.render')
}

const OVERTAKEN = 'work started before the compaction was announced'
const NOT_ANNOUNCED = 'The compaction could not be announced to the session: nothing was compacted.'

// One small question asked beside the conversation: it reads the cached prefix, which renews it, and leaves
// no trace in the transcript.
const renew = async ($: EngineInterface, config: Config) => {
  if (isYielding) return
  const sentAt = await $.clock.now()
  try {
    const result = await $.model.fork({ prompt: config.pingPrompt })
    // What the request read says whether the cache was hit, with or without a reply; a request that came
    // back with no usage never got there.
    const usage = 'usage' in result ? result.usage : undefined
    if (usage === undefined || usage === null) await observe($, config, { kind: 'renew-failed' })
    else await observe($, config, { kind: 'renewed', isHit: isCacheHit(usage), sentAt })
  } catch (err) {
    $.ui.log(`renewal failed: ${String(err)}`)
    await observe($, config, { kind: 'renew-failed' })
  }
}

// The announcement is a turn of its own: the session is told that a compaction is coming.
const prepare = async ($: EngineInterface, config: Config) => {
  // Work that began since the core decided takes the announcement back, as it does the compaction.
  await queue
  if (isYielding || (await read($, machine))?.phase !== 'PREPARING') return
  try {
    // The plugin's own prompt may not pass through its own prompt.submit hook: mark the turn here.
    nextTurnBy = 'self'
    // An announced compaction is the timers' own: no note of the session's follows it.
    wakeText = ''
    const result = await $.prompt.submit({ text: config.preparePrompt })
    // Another plugin's hook may drop the prompt: then nothing was announced and nothing is compacted.
    if (result.drop === undefined) return
    $.ui.log(`announcement dropped: ${String(result.drop)}`)
  } catch (err) {
    $.ui.log(`announcement not sent: ${String(err)}`)
  }
  nextTurnBy = 'unknown'
  await observe($, config, { kind: 'refused', reason: NOT_ANNOUNCED })
}

// One entry for a compaction that went through. The log must never stand in the way of the work.
const writeLog = async ($: EngineInterface, why: Cause, before: number | null, after: number | null, said: string) => {
  try {
    const entry = logEntry(why, await $.clock.now(), await $.session.id(), before, after, said)
    await $.store.set(logKey(entry), entry)
    for (const key of outdated(await $.store.keys())) await $.store.delete(key)
  } catch (err) {
    $.ui.log(`compaction not logged: ${String(err)}`)
  }
}

const readLog = async ($: EngineInterface): Promise<LogEntry[]> => {
  const entries: LogEntry[] = []
  for (const key of (await $.store.keys()).filter(isLogKey)) {
    const entry = await $.store.get(key)
    if (isLogEntry(entry)) entries.push(entry)
  }
  return entries
}

const sizeNow = async ($: EngineInterface): Promise<number | null> => {
  try {
    return (await $.session.usage()).context.tokens ?? null
  } catch {
    return null
  }
}

// The session is told what it left for itself: a turn of its own, as the announcement is. Nothing is sent
// when the person is writing a message, they will say what comes next; nor when work began since the
// compaction started (`atTurns`), a message sent while it ran included. The prompt waits for the session to
// be idle, so the prompt.submit hook looks once more.
const wake = async ($: EngineInterface, text: string, atTurns: number) => {
  const prompt = wakePrompt(text)
  try {
    // A digit left in the prompt box answered the question; it is no message being written.
    const draft = (await $.prompt.read()).text.trim()
    if (draft !== '' && choiceOfDigit(CHOICES_OF.session, draft) === null) return $.ui.log(WAKE_TYPING)
    if (turnsStarted !== atTurns) return $.ui.log(WAKE_OVERTAKEN)
    wakeSent = prompt
    wakeAtTurns = atTurns
    // The turn is somebody else's as the core sees it, whether or not the prompt passes this plugin's own hook.
    nextTurnBy = 'other'
    const result = await $.prompt.submit({ text: prompt })
    if (result.drop === undefined) wakesInRow++
    else {
      nextTurnBy = 'unknown'
      $.ui.log(`note after the compaction not sent: ${String(result.drop)}`)
    }
  } catch (err) {
    nextTurnBy = 'unknown'
    $.ui.log(`note after the compaction not sent: ${String(err)}`)
  }
  if (wakeSent === prompt) wakeSent = null
}

const compact = async ($: EngineInterface, config: Config, anchorAt: number | null) => {
  // A second passed since the core decided: a turn that began meanwhile takes the compaction back.
  await queue
  const state = await read($, machine)
  if (isYielding || state?.phase !== 'COMPACTING') return
  // The person began to type, or a subagent started, since the core decided: the compaction waits, unless
  // the person ordered it.
  const hold = state.isOrdered ? null : await holdNow($, state)
  if (hold !== null) return observe($, config, { kind: 'held', hold })
  try {
    const instructions = fillInstructions(config.compactInstructions, await $.clock.now(), anchorAt)
    const before = await sizeNow($)
    const why = cause
    const said = note
    const then = wakeText
    const atTurns = turnsStarted
    cause = OWN_CAUSE
    note = ''
    wakeText = ''
    isOwnCompaction = true
    const result = await $.session.compact(instructions === '' ? {} : { instructions }).finally(() => {
      isOwnCompaction = false
    })
    // The state first, the log after: a turn that starts meanwhile must find the compaction noted.
    if (result.skip !== undefined) return observe($, config, { kind: 'compact-failed' })
    const sizes = { before: result.tokensBefore ?? before, after: result.tokensAfter ?? null }
    await observe($, config, { kind: 'compacted', own: sizes })
    await writeLog($, why, sizes.before, sizes.after, said)
    if (why.why === 'session' && then !== '' && !isYielding) void wake($, then, atTurns)
  } catch (err) {
    $.ui.log(`compaction failed: ${String(err)}`)
    await observe($, config, { kind: 'compact-failed' })
  }
}

// Carries out what the core decided. Anything that takes time runs on its own and reports back as an
// observation: it must not hold up the queue the observations go through.
const ask = ($: EngineInterface, config: Config, state: State, now: number, reason: AskReason, deadline: number, selected: Choice) => {
  // A compaction that waits keeps its own cause through a question about the cache.
  if (state.held === null) {
    cause = { why: reason, by: 'timer' }
    // What the session said belongs to its own request only.
    if (reason !== 'session') note = ''
    if (reason !== 'session') wakeText = ''
  }
  const why = whyText(reason, state, extension, config) + (reason === 'session' && wakeText !== '' ? WAKE_WHY : '')
  const answer = async (choice: Choice, isTimers: boolean) => {
    // Any answer but Compact ends what was asked: a later compaction is the cache's course again. Only a
    // compaction that waits keeps its cause through a renewal.
    if (choice !== 'compact' && !(choice === 'renew' && state.held !== null)) {
      cause = OWN_CAUSE
      note = ''
      wakeText = ''
    }
    // The person's own answer is carried out whatever stands in the way; the timer's is not.
    await observe($, config, { kind: 'answer', choice, isTimers, hold: isTimers ? await holdNow($, state) : null })
  }
  void openQuestion($, {
    totalMs: Math.max(0, deadline - now),
    style: 'text',
    isSticky: false,
    fallback: selected,
    answer: (choice, isTimers) => void answer(choice, isTimers),
    choices: choicesOf(reason, extension),
    why,
  })
}

const perform = ($: EngineInterface, config: Config, action: Action, state: State, now: number) => {
  if (action.kind === 'notify') $.ui.toast(action.text)
  else if (action.kind === 'ask') ask($, config, state, now, action.reason, action.deadline, action.selected)
  else if (action.kind === 'close-question') {
    dropQuestion($)
    // The core closed the question with nothing left of the request: what the session said goes with it.
    if (state.phase !== 'COMPACTING' && state.phase !== 'PREPARING' && state.held === null && !state.isRequested) {
      cause = OWN_CAUSE
      note = ''
      wakeText = ''
    }
  }
  else if (action.kind === 'renew') {
    // A renewal is the cache's course again, whatever was asked before, unless a compaction waits through it.
    if (state.held === null) {
      cause = OWN_CAUSE
      note = ''
      wakeText = ''
    }
    void renew($, config)
  }
  else if (action.kind === 'prepare') void prepare($, config)
  // A compaction is refused while a turn's hook is still open: a moment later the turn is over.
  else if (action.kind === 'compact') $.clock.after(1000, () => void compact($, config, state.anchorAt))
}

// Whether this plugin stands down, taking everything of its own off the screen the first time it finds out.
// The other plugin may start after this one, so the timer keeps asking.
const yields = async ($: EngineInterface): Promise<boolean> => {
  if (!isYielding) {
    let isSuperseded = false
    try {
      isSuperseded = (await read($, superior)) === true
    } catch {
      // Nothing is kept under that name: the other plugin is not here.
    }
    if (!isSuperseded) return false
    isYielding = true
    shown = null
    intro = null
    dropQuestion($)
    $.ui.status(undefined)
    $.ui.invalidate('ui.render')
    $.ui.log('standing down: the plugin built on this one runs in the session')
  }
  isWatching = false
  ticker?.cancel()
  ticker = null
  return true
}

// Claude Code's theme says whether the background is light.
const readLook = async ($: EngineInterface) => {
  let theme: unknown
  try {
    theme = (await $.config.list()).find(row => row.key === 'theme')?.value
  } catch (err) {
    $.ui.log(`theme not read: ${String(err)}`)
  }
  const next = lookOf(theme)
  if (next === look) return
  look = next
  $.ui.invalidate('ui.render')
}

// The notice is shown until the person presses OK or sends a message; only then is it remembered as seen,
// in the plugin's store, so it comes once on a machine and not in every session.
const showIntro = async ($: EngineInterface, config: Config) => {
  try {
    if ((await $.store.get(INTRO_KEY)) === INTRO_SEEN) return
  } catch (err) {
    $.ui.log(`store not read: ${String(err)}`)
  }
  // The plugin built on this one may have turned up while the store was read: then it is its to tell.
  if (isYielding) return
  intro = introOf(config)
  isIntroLook = false
  if (intro !== null) $.ui.invalidate('ui.render')
}

// Several sessions may show the notice at once: OK in one of them puts it away in all, within a few seconds.
const followIntro = async ($: EngineInterface, now: number) => {
  if (intro === null || isIntroLook || now - introAskedAt < INTRO_ASK_MS) return
  introAskedAt = now
  try {
    if ((await $.store.get(INTRO_KEY)) !== INTRO_SEEN || intro === null || isIntroLook) return
  } catch {
    // Asked again in a moment.
    return
  }
  intro = null
  $.ui.invalidate('ui.render')
}

const dismissIntro = async ($: EngineInterface) => {
  if (intro === null) return
  intro = null
  $.ui.invalidate('ui.render')
  // A look taken down is not the notice seen: the other sessions keep theirs.
  if (isIntroLook) return
  try {
    await $.store.set(INTRO_KEY, INTRO_SEEN)
  } catch (err) {
    $.ui.log(`store not written: ${String(err)}`)
  }
}

// Nothing is awaited between the test and the assignment, so two events at once start one timer.
const ensureStarted = ($: EngineInterface, config: Config) => {
  if (!isWatching) return
  if (ticker === null) ticker = $.clock.every(TICK_MS, () => void tick($, config))
}

const start = async ($: EngineInterface, config: Config, isInteractive: boolean) => {
  // Nobody is at the prompt in `claude -p` or under the SDK: there the plugin does nothing.
  isWatching = isInteractive
  if (!isWatching) {
    ticker?.cancel()
    ticker = null
    return
  }
  if (await yields($)) return
  ensureStarted($, config)
  await readLook($)
  await showIntro($, config)
  try {
    await $.command.register({
      name: 'bell',
      description: 'Cache Bell: the state of the prompt cache',
      argumentHint: 'status | log [count] | demo [seconds] [bg] [stay] | show calm|act|cold|intro|off',
      immediate: true,
    })
  } catch (err) {
    $.ui.log(`/bell not registered: ${String(err)}`)
  }
  // The tool the compact skill calls. Claude Code lists it as mcp__cache-bell__compact.
  try {
    await $.tool.register({
      name: 'compact',
      description:
        'Ask Cache Bell to compact this conversation right after the current turn ends. A compaction replaces the conversation with a summary and cannot be undone. Call it only when the work in hand is finished, then end the turn. The answer says whether the user is asked first.',
      inputSchema: {
        type: 'object',
        properties: {
          reason: { type: 'string', description: 'One short sentence: why now. Kept in the log of compactions.' },
          countdown: { type: 'number', description: `Seconds the user gets to cancel, ${COUNTDOWN_MIN_S} to ${COUNTDOWN_MAX_S}. Leave it out to use the user's own setting.` },
          resumeWith: { type: 'string', description: `What you want to be told once the compaction is done: the plugin sends it to you as a prompt, and you go on from it. Say what to pick up, in a sentence or two (${WAKE_MAX_CHARS} characters at most). Leave it out when nothing is left to do: the session then waits for the user.` },
          userAsked: { type: 'boolean', description: 'true only when the user themselves asked you, in this conversation, to compact: the countdown is then three seconds.' },
          cancel: { type: 'boolean', description: 'true takes back a request you made earlier, with its countdown. Nothing else is done.' },
        },
      },
    })
  } catch (err) {
    $.ui.log(`compact tool not registered: ${String(err)}`)
  }
  await observeSettingsTtl($, config)
  // An assisted test: CACHE_BELL_DEMO=30 shows the question for 30 s right after the start.
  const demo = ((await $.env.get('CACHE_BELL_DEMO')) ?? '').trim().split(/\s+/)
  const demoSeconds = Number(demo[0])
  if (demoSeconds > 0) $.clock.after(1500, () => void openQuestion($, { ...DEMO, totalMs: demoSeconds * 1000, style: demoStyle(demo[1]) }))
}

// A /clear starts the state over. The TTL the API was seen to grant stays; what the settings ask for is
// read again, in case it changed.
const cleared = async ($: EngineInterface, config: Config) => {
  await observe($, config, { kind: 'cleared' })
  await observeSettingsTtl($, config)
}

// The plugin's version, read from its own manifest the first time it is asked for.
let version: string | undefined

const versionNow = async ($: EngineInterface): Promise<string | undefined> => {
  if (version !== undefined) return version
  try {
    version = versionOf(await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`))
  } catch (err) {
    $.ui.log(`manifest not read: ${String(err)}`)
  }
  return version
}

// What /bell takes, said whenever it is given something else.
const USAGE = 'Usage: /bell status | log [count] | demo [seconds] [bg] [stay]\n       | show calm|act|cold|intro|off'

const command = async ($: EngineInterface, config: Config, unknown: readonly string[], args: string) => {
  const words = args.trim().split(/\s+/)
  const verb = words[0]?.toLowerCase() ?? ''
  // A real question stays up: taken down from here, the core would still act on it when its time ran out.
  if ((verb === 'demo' || verb === 'show') && question !== null && question.answer !== null) {
    return { text: 'A question is open. Answer it first.' }
  }
  if (verb === 'demo') {
    const seconds = Number(words[1] ?? '30')
    if (!(seconds > 0 && seconds <= 600)) return { text: 'Usage: /bell demo [seconds] [bg] [stay], 1 to 600 seconds.' }
    await openQuestion($, { ...DEMO, totalMs: seconds * 1000, style: demoStyle(words[2]), isSticky: words.includes('stay') })
    return { text: `Demo question for ${seconds} s. Nothing is sent to the model.` }
  }
  // For screenshots: holds the band in one of its looks, whatever the cache really does. Sends nothing.
  if (verb === 'show' && words[1] === 'intro') {
    // The real notice, still up, stays the real one.
    isIntroLook = intro === null || isIntroLook
    intro = introOf(config)
    $.ui.invalidate('ui.render')
    return { text: intro === null ? 'With these settings there is nothing to tell.' : 'Showing the first-run notice.' }
  }
  if (verb === 'show') {
    // A notice put up for a look goes with any other look; it is not remembered as seen.
    intro = null
    shown = sampleBand(words[1] ?? '')
    dropQuestion($)
    $.ui.invalidate('ui.render')
    if (shown !== null) return { text: `Showing the band as "${words[1]}". /bell show off puts the real one back.` }
    return { text: words[1] === 'off' ? 'The band shows the real state again.' : 'Usage: /bell show calm | act | cold | intro | off' }
  }
  if (verb === 'log') {
    const count = Number(words[1] ?? LOG_SHOWN)
    if (!(Number.isInteger(count) && count >= 1 && count <= LOG_KEEP)) return { text: `Usage: /bell log [count], 1 to ${LOG_KEEP}.` }
    try {
      return { text: logReport(await readLog($), count) }
    } catch (err) {
      return { text: `The log could not be read: ${String(err)}` }
    }
  }
  if (verb !== '' && verb !== 'status') {
    return { text: USAGE }
  }
  await queue
  const state = (await read($, machine)) ?? initialState(config)
  const usage = await $.session.usage()
  return { text: statusReport(state, await $.clock.now(), config, { contextTokens: usage.context.tokens, version: await versionNow($), unknown }, extension) }
}

// The plugin's hooks. `extend` is how a plugin built on this one adds to it: its own hooks module calls this
// from its `register`. The open plugin has none.
export const registerWith = (on: Parameters<Register>[0], options: Parameters<Register>[1], extend: Extend) => {
  const config = resolveConfig(options)
  const unknown = unknownWords(options)
  extension = extend(options)
  texts = choiceTexts(extension)

  on('session.start', async ($, e, next) => {
    await start($, config, e.isInteractive)
    return next(e)
  })

  // A /clear ends the conversation and starts no new session.start: forget what was known of the cache.
  on('session.end', async ($, e, next) => {
    if (isWatching && (e.reason === 'clear' || e.reason === 'resume')) await cleared($, config)
    return next(e)
  })

  on('command.run', { command: 'bell' }, ($, e, next) => (isYielding ? next(e) : command($, config, unknown, e.args)))

  // The session asks for a compaction. Nothing is compacted inside a turn: the request is noted and taken
  // up when the turn ends.
  on('tool.call', { tool: 'mcp__cache-bell__compact' }, async ($, e) => {
    if (isYielding) return { result: YIELDED_ANSWER }
    if ((e as { agentId?: string }).agentId !== undefined) return { result: SUBAGENT_ANSWER }
    // The session takes back what it asked for earlier: a request an interrupted question carried over.
    if ((e as { cancel?: unknown }).cancel === true) {
      await queue
      const kept = await read($, machine)
      const hadRequest = kept !== null && (kept.isRequested || kept.held !== null)
      if (hadRequest) {
        cause = OWN_CAUSE
        note = ''
        wakeText = ''
        await observe($, config, { kind: 'withdrawn' })
      }
      return { result: withdrawAnswer(hadRequest) }
    }
    const isAllowed = isWatching && config.enabled && config.sessionCompact !== 'off'
    const asked = e as { countdown?: unknown; userAsked?: unknown; resumeWith?: unknown; then?: unknown }
    let wakes: Wake = 'none'
    // That the user asked is the session's word: it is taken only in a turn the user started.
    const countdownMs = countdownOf(asked.countdown, asked.userAsked === true && turnBy === 'person')
    if (isAllowed) {
      // Only a request the core takes up explains a compaction: one made while the plugin's own
      // announcement runs changes nothing.
      const reason = (e as { reason?: unknown }).reason
      const current = await read($, machine)
      // A request already carried over keeps what was said with it.
      if (current?.phase === 'BUSY' && !current.isRequested) {
        cause = { why: 'session', by: 'plugin' }
        note = typeof reason === 'string' ? reason : ''
        wakeText = ''
      }
      // The note passed last counts; a call without one leaves the earlier note standing.
      // `then` is what the parameter was called before 0.2.7: a session that read the older skill still passes it.
      const wanted = wakeOf(asked.resumeWith) || wakeOf(asked.then)
      if (wanted !== '') {
        wakeText = wakesInRow < WAKES_MAX ? wanted : ''
        wakes = wakeText !== '' ? 'kept' : 'capped'
      } else if (wakeText !== '') wakes = 'kept'
      await observe($, config, { kind: 'requested', countdownMs })
      // A request the core did not take up is followed by nothing.
      const taken = await read($, machine)
      if (taken === null || !(taken.isRequested || taken.held !== null)) {
        wakeText = ''
        wakes = 'none'
      }
    }
    // What the core took: a second request in one turn changes nothing, its countdown included.
    const taken = (await read($, machine))?.requestMs ?? config.compactCountdownMs
    return { result: requestAnswer(config.sessionCompact, isWatching && config.enabled, taken, wakes) }
  })

  // What the person types into the prompt moves a question's selection.
  on('prompt.edit', async ($, e, next) => {
    const edited = e.text.slice(0, e.start) + e.inputText + e.text.slice(e.end)
    // Typing is a sign that the person is here. Under a question a choice's digit is an answer, typed or
    // taken back, and no sign of anything else.
    const isDigit = question !== null && (edited === '' || choiceOfDigit(question.choices, e.inputText) !== null)
    if (!isDigit) lastEditAt = await $.clock.now()
    if (question === null) return next(e)
    // A choice's digit typed while the prompt holds another choice's digit replaces it: "2" then "3" is
    // "3", not "23".
    if (choiceOfDigit(question.choices, e.text) !== null && choiceOfDigit(question.choices, e.inputText) !== null) {
      const result = await next(e)
      await $.prompt.fill({ text: e.inputText })
      draftChanged($, e.inputText)
      return result
    }
    draftChanged($, edited)
    return next(e)
  })

  // A digit and Enter answers the question and is not a message for the model. Any other message from the
  // person is real work: whatever was asked no longer needs an answer.
  on('prompt.submit', async ($, e, next) => {
    const isOwn = e.origin.kind === 'plugin' && e.origin.name === PLUGIN
    // The note after a compaction: a turn of somebody else's as the core sees it, and no announcement.
    if (isOwn && wakeSent !== null && e.text === wakeSent) {
      if (turnsStarted !== wakeAtTurns) return { drop: `${PLUGIN}: ${WAKE_OVERTAKEN}` }
      nextTurnBy = 'other'
      return next(e)
    }
    const isPerson = e.origin.kind === 'composer' || e.origin.kind === 'bridge' || e.origin.kind === 'sdk'
    // The announcement waits for the session to be idle. When work got in first, the compaction it
    // announces is off, and so is the announcement.
    if (isOwn && (await read($, machine))?.phase !== 'PREPARING') return { drop: `${PLUGIN}: ${OVERTAKEN}` }
    nextTurnBy = isOwn ? 'self' : isPerson ? 'person' : OTHERS.includes(e.origin.kind) ? 'other' : 'unknown'
    if (isPerson) void dismissIntro($)
    // The message is sent: the typing that wrote it is over, and must not hold back what the message asks for.
    if (isPerson) lastEditAt = null
    // The person's message, also one sent into a turn that is running, takes back what the session asked
    // for and what waits: they are at work.
    if (isPerson && (question === null || choiceOfDigit(question.choices, e.text.trim()) === null)) {
      // Forgotten here, not only when the turn starts: another plugin may drop the message.
      cause = OWN_CAUSE
      note = ''
      wakeText = ''
      void observe($, config, { kind: 'withdrawn' })
    }
    if (question === null || e.origin.kind === 'plugin') return next(e)
    const typed = choiceOfDigit(question.choices, e.text.trim())
    if (typed === null) {
      // A real question is the core's to close, when the turn this message starts begins: a message that
      // starts no turn (another plugin dropped it) leaves the question up.
      if (question.isSticky || question.answer !== null) return next(e)
      endQuestion($, 'Demo: question closed, you sent a message.')
      return next(e)
    }
    closeQuestion($, typed, 'typed and confirmed with Enter')
    return { drop: dropReason(textOf(typed)) }
  })

  // The line Claude Code leaves in the transcript for that digit says a prompt was dropped by a hook.
  // Nothing went wrong: say what was chosen instead.
  on('session.append', { door: 'notice' }, ($, e, next) => {
    const content = e.message.content
    if (!Array.isArray(content)) return next(e)
    let isOurs = false
    const rewritten = content.map(block => {
      const said = block.type === 'text' && typeof block.text === 'string' ? (chosenNotice(block.text, texts) ?? reloadNotice(block.text)) : null
      if (said === null) return block
      isOurs = true
      return { ...block, text: said }
    })
    return isOurs ? next({ ...e, message: { ...e.message, content: rewritten } }) : next(e)
  })

  // The person switched the theme: the colours follow.
  on('config.set', { key: 'theme' }, async ($, e, next) => {
    const result = await next(e)
    if (isWatching) await readLook($)
    return result
  })

  on('turn.start', async ($, e, next) => {
    ensureStarted($, config)
    const by = nextTurnBy
    nextTurnBy = 'unknown'
    turnBy = by
    turnsStarted++
    if (by === 'person') wakesInRow = 0
    // Work that is not the plugin's own announcement: what was asked before no longer explains a compaction.
    // Only a compaction that waits for a subagent keeps its cause through the turn that brings the result.
    // So does the session's request that an interrupted question carries over.
    const before = await read($, machine)
    const isCarried = before !== null && (before.held !== null || (before.phase === 'ASKING' && before.askReason === 'session'))
    if (by === 'person' || (by !== 'self' && !isCarried)) {
      cause = OWN_CAUSE
      note = ''
      wakeText = ''
    }
    if (isWatching) await observe($, config, { kind: 'turn-start', by })
    return next(e)
  })

  // One request to the model. The moment it is sent is the cache's anchor; only the main thread counts,
  // a subagent's request has a prefix of its own.
  on('turn.step', async function* ($, e, next) {
    if (isWatching && e.agentId === undefined) {
      await observe($, config, { kind: 'request', sentAt: await $.clock.now() })
    }
    return yield* next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (isWatching && e.agentId === undefined) {
      await observe($, config, { kind: 'turn-complete', contextTokens: (await sizeNow($)) ?? undefined, isAborted: e.isAborted || e.reason !== 'answer', isFailed: e.reason === 'error', hold: await holdNow($, await read($, machine)) })
      // What explained a compaction is forgotten once nothing is left for it to explain: no question, no
      // step of the plugin's own, nothing waiting.
      const after = await read($, machine)
      if (after !== null && after.phase !== 'ASKING' && after.phase !== 'PREPARING' && after.phase !== 'COMPACTING' && after.held === null) {
        cause = OWN_CAUSE
        note = ''
        wakeText = ''
      }
    }
    return result
  })

  // The other Stop hooks go first: reading a large transcript's tail starts a process.
  on('classic.Stop', async ($, e, next) => {
    const result = await next(e)
    if (isWatching && e.transcript_path !== transcriptPath) {
      transcriptPath = e.transcript_path
      // Another file: what was read of the old one says nothing of it.
      readSize = null
      await update($, transcript, () => transcriptPath ?? null)
    }
    if (isWatching) await readTranscriptTtl($, config, transcriptPath)
    return result
  })

  // Every compaction of the main conversation that reaches the hook: the person's /compact and the engine's
  // own. A precompute installs nothing.
  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    const isInstalled = result.skip === undefined && e.agentId === undefined && e.trigger !== 'precompute'
    // The person's /compact and Claude Code's own: the plugin's are logged where it runs them.
    const isOthers = !isOwnCompaction && (e.trigger === 'manual' || e.trigger === 'auto')
    if (isWatching && isInstalled && isOthers) {
      const why: Cause = e.trigger === 'manual' ? { why: 'manual', by: 'person' } : { why: 'auto', by: 'claude-code' }
      await writeLog($, why, result.tokensBefore ?? null, result.tokensAfter ?? null, '')
    }
    if (isWatching && isInstalled) await observe($, config, { kind: 'compacted' })
    return result
  })

  // A compaction this hook did not see (one a plugin ran) still ends with a SessionStart of source compact.
  on('classic.SessionStart', async ($, e, next) => {
    if (isWatching && e.source === 'compact') await observe($, config, { kind: 'compacted' })
    if (isWatching && e.source === 'clear') await cleared($, config)
    return next(e)
  })

  on('classic.PostModelSwitch', async ($, e, next) => {
    if (isWatching) await observe($, config, { kind: 'model-switch', ttlMs: parseTtl(e.cache_ttl) })
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (isYielding) return next(e)
    if (question !== null && !e.props.hasSurvey) {
      const { Box, Button, Text } = $.ui.resolve(e)
      const asked = question
      const { title, head, foot } = questionParts(asked.isTyped, asked.why, textOf(asked.selected))
      const leftMs = leftOf(asked, await $.clock.now())
      const view = askView(foot, leftMs, asked.totalMs, asked.style, look)

      // The Buttons carry no hotkey: Claude Code would press one as soon as its digit stood alone in the
      // prompt. Here a digit only selects; Enter, the time running out or a click does it.
      return (
        <Box flexDirection="column">
          <Text bold>
            <Text color={PALETTE[look].letter}>{MARK[0]}</Text>
            <Text color={PALETTE[look].tile}>{MARK.slice(1)}</Text>
            <Text>{title.slice(MARK.length)}</Text>
            <Text>{head}</Text>
          </Text>
          <Box key="choices" flexDirection="row" gap={2} paddingLeft={2}>
            {asked.choices.map(choice =>
              choice === asked.selected ? (
                <Button key={choice} label={choiceLabel(digitOf(asked.choices, choice), textOf(choice), true)} plain variant="primary" onPress={() => closeQuestion($, choice, 'clicked')} />
              ) : (
                <Button key={choice} label={choiceLabel(digitOf(asked.choices, choice), textOf(choice), false)} plain dimColor onPress={() => closeQuestion($, choice, 'clicked')} />
              ),
            )}
          </Box>
          <Box key="note" paddingLeft={2}>
            <Text color={view.color} backgroundColor={view.backgroundColor}>
              {view.text}
            </Text>
          </Box>
        </Box>
      )
    }
    if (intro !== null && !e.props.hasSurvey) {
      const { Box, Button, Text } = $.ui.resolve(e)
      const told = intro
      return (
        <Box flexDirection="column">
          <Text bold>
            <Text color={PALETTE[look].letter}>{MARK[0]}</Text>
            <Text color={PALETTE[look].tile}>{MARK.slice(1)}</Text>
            <Text>{BAND_PREFIX.slice(MARK.length)}</Text>
            <Text>{told.head}</Text>
          </Text>
          {told.rows.map((row, at) => (
            <Box key={`intro-row-${at}`} paddingLeft={2}>
              <Text>{row}</Text>
            </Box>
          ))}
          <Box key="intro-once" paddingLeft={2}>
            <Text dimColor>{told.once}</Text>
          </Box>
          <Box key="intro-foot" flexDirection="row" gap={2} paddingLeft={2}>
            <Button key="intro-ok" label="OK" variant="primary" onPress={() => void dismissIntro($)} />
            <Text dimColor>{told.hint}</Text>
          </Box>
        </Box>
      )
    }
    const state = await read($, machine)
    if (e.props.hasSurvey) return next(e)
    const view = shown ?? (state === null ? null : band(state, await $.clock.now(), config))
    if (view === null) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    const color = view.tone === 'calm' ? undefined : PALETTE[look][view.tone]

    return (
      <Box>
        <Text>
          <Text color={PALETTE[look].letter} bold>
            {MARK[0]}
          </Text>
          <Text color={PALETTE[look].tile} bold>
            {MARK.slice(1)}
          </Text>
          <Text bold>{BAND_PREFIX.slice(MARK.length)}</Text>
          <Text color={color} dimColor={view.tone === 'calm'}>
            {view.text.slice(BAND_PREFIX.length)}
          </Text>
        </Text>
      </Box>
    )
  })
}

export const register: Register = (on, options) => {
  registerWith(on, options, () => NONE)
}
