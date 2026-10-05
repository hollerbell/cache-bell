// The question in the band: its choices and their digits, why it is asked, the countdown whose line swings
// between two colours, and what the transcript and the session are told. Plain values; the shell draws them.

import type { Extension } from './extension'
import type { AskReason, Config, State } from './types'
import { BAND_PREFIX, MARK, NAME, PLUGIN, formatLeft, formatCount } from './view'
import type { Look } from './view'

// How often the line is redrawn while the countdown runs: ten frames a second, the most a band is given.
export const FRAME_MS = 100
// One full swing from the first colour to the second and back.
export const SWING_MS = 2000

const DARK_TEXT = '#000000'

// 'text': the text of the line swings between the two colours.
// 'bg': the background does, under dark text.
export type AskStyle = 'text' | 'bg'

export type AskView = {
  // the whole first line: what was asked and the countdown
  text: string
  color: string
  // undefined = no background
  backgroundColor: string | undefined
  // the countdown as text, m:ss
  left: string
}

const hex = (value: number): string => Math.round(value).toString(16).padStart(2, '0')

// On a dark background a dark yellow and a strong yellow leaning to orange; on a light one two ambers dark
// enough to read.
const SWING: Record<Look, { from: readonly number[]; to: readonly number[] }> = {
  dark: { from: [0xb3, 0x8f, 0x00], to: [0xff, 0xb0, 0x00] },
  light: { from: [0x7a, 0x5c, 0x00], to: [0xb3, 0x6b, 0x00] },
}

// 0 = the first colour, 1 = the second.
export const mixColor = (share: number, look: Look = 'dark'): string => {
  const mix = Math.min(Math.max(share, 0), 1)
  const { from, to } = SWING[look]
  return '#' + from.map((start, i) => hex(start + ((to[i] ?? start) - start) * mix)).join('')
}

// Where the swing stands after `elapsedMs`: 0 at the start, 1 half a swing later, 0 again after a whole one,
// along a sine, so the colour slows down at both ends.
export const swing = (elapsedMs: number): number => (1 - Math.cos((2 * Math.PI * elapsedMs) / SWING_MS)) / 2

export const askView = (head: string, leftMs: number, totalMs: number, style: AskStyle = 'text', look: Look = 'dark'): AskView => {
  const left = Math.min(Math.max(leftMs, 0), totalMs)
  const swinging = mixColor(swing(totalMs - left), look)
  // Rounded up, so the countdown reads 0:30 at the start and 0:00 only when the time is up.
  const clock = formatLeft(Math.ceil(left / 1000) * 1000)
  return {
    text: `${head}${clock}`,
    color: style === 'bg' ? DARK_TEXT : swinging,
    backgroundColor: style === 'bg' ? swinging : undefined,
    left: clock,
  }
}

// The answers to the question. Each has a digit: typed alone into the empty prompt it selects the answer,
// Enter confirms it at once, and without Enter the selected answer is what the time running out does.
//   compact: compact the conversation now
// when the cache is about to expire:
//   renew:   keep the cache warm for another period and ask again before it runs out
//   cancel:  do nothing and let the cache expire
// when the session asked for the compaction:
//   skip:    drop the request
// An extension adds answers of its own to its own questions.
export type OwnChoice = 'compact' | 'renew' | 'cancel' | 'skip'
export type Choice = OwnChoice | (string & {})

// `label` is on the button.
export type ChoiceText = { label: string }

export const CHOICES: Record<OwnChoice, ChoiceText> = {
  compact: { label: 'Compact' },
  renew: { label: 'Renew cache' },
  cancel: { label: 'Let it expire' },
  skip: { label: 'Not now' },
}

// What is said once a compaction the session asked for is called off: the question is gone from the band,
// and a choice made by mistake would otherwise leave nothing to see.
export const skippedNotice = (isTimers: boolean): string =>
  isTimers ? 'No answer: nothing was compacted.' : 'Compaction cancelled. Nothing was compacted.'

// The choices each of the core's reasons offers, in the order of their digits: the first is 1.
export const CHOICES_OF: Record<'cache' | 'session', readonly Choice[]> = {
  cache: ['compact', 'renew', 'cancel'],
  session: ['compact', 'skip'],
}

const isOwn = (reason: AskReason): reason is 'cache' | 'session' => reason === 'cache' || reason === 'session'

export const choicesOf = (reason: AskReason, extension: Extension): readonly Choice[] =>
  isOwn(reason) ? CHOICES_OF[reason] : (extension.reasons[reason]?.choices ?? ['compact'])

// Every answer there is, the core's and the extension's. The core's own keep their words.
export const choiceTexts = (extension: Extension): Readonly<Record<string, ChoiceText>> => ({ ...extension.choices, ...CHOICES })

export const digitOf = (choices: readonly Choice[], choice: Choice): string => String(choices.indexOf(choice) + 1)

// The choice a draft names: exactly one of the digits, nothing around it.
export const choiceOfDigit = (choices: readonly Choice[], draft: string): Choice | null =>
  choices.find(choice => digitOf(choices, choice) === draft) ?? null

export const CACHE_SOON = 'cache expires soon'

// How many renewals the plugin would still do without an answer, in words; nothing in a mode that does not
// renew.
const renewalsLeft = (state: State, config: Config): string => {
  if (config.renewMethod === 'none' || config.maxRenewals === 0) return ''
  const left = Math.max(0, config.maxRenewals - state.renewals)
  if (left === 0) return ', no automatic renewals left'
  // What comes after them, so the person sees where the course leads.
  const then = config.compact ? 'then compacts' : 'then expires'
  return `, ${left} automatic ${left === 1 ? 'renewal' : 'renewals'} left, ${then}`
}

// The reason in words.
export const whyText = (reason: AskReason, state: State, extension: Extension, config: Config): string => {
  // What is at stake: the size of the context that would be sent again, when it is known.
  const size = state.contextTokens === null ? '' : ` (${formatCount(state.contextTokens)} tokens)`
  if (reason === 'cache') return `${CACHE_SOON}${size}${renewalsLeft(state, config)}`
  if (reason === 'session') return 'the session asked for a compaction'
  return extension.reasons[reason]?.why(state) ?? ''
}

// `title` is who asks: the mark and the product's name. `head` follows it: why the plugin asks. `foot` is the
// line under the choices and stands before the countdown: the selected choice is done when the time is up,
// and, while the prompt holds a choice's digit, Enter does it at once.
export const questionParts = (isTyped: boolean, why: string, selected: ChoiceText): { title: string; head: string; foot: string } => ({
  title: BAND_PREFIX,
  head: ` ${why.slice(0, 1).toUpperCase()}${why.slice(1)}:`,
  foot: isTyped ? `[Enter] confirms · no answer: ${selected.label} in ` : `No answer: ${selected.label} in `,
})

// A choice as it is drawn: its digit, and the selected one between arrows. The other choices keep the same
// width, so nothing moves when the selection does.
export const choiceLabel = (digit: string, text: ChoiceText, isSelected: boolean): string =>
  isSelected ? `[${digit}] >${text.label}<` : `[${digit}]  ${text.label} `

// What stops a digit and Enter from reaching the model. Claude Code writes the reason into the transcript
// behind words of its own ("Prompt dropped by a hook: ..."), which read as if something went wrong.
export const dropReason = (chosen: ChoiceText): string => `${PLUGIN}: ${chosen.label}`

// That transcript line, rewritten to say what happened; null for any other line.
export const chosenNotice = (text: string, texts: Readonly<Record<string, ChoiceText>> = CHOICES): string | null => {
  const match = new RegExp(`${PLUGIN}: (.+)$`).exec(text)
  if (match === null || !Object.values(texts).some(choice => choice.label === match[1])) return null
  return `${BAND_PREFIX} ${match[1]} chosen`
}

// Claude Code's line after it loaded the plugin again (an option changed, a file changed), which lists every
// hook: cut to what happened. Null for any other line.
export const reloadNotice = (text: string): string | null => {
  const match = new RegExp(`^(${PLUGIN}: (?:.+ — )?reloaded) \\(\\d+ hooks?: [^)]*\\)$`).exec(text)
  return match === null ? null : (match[1] ?? null)
}

// What the session's tool answers while the plugin stands down, for Claude to read.
export const YIELDED_ANSWER =
  'Refused: Cache Bell stands down in this session, the plugin built on it is at work. Ask for the compaction with that plugin\'s compact tool.'

// What a subagent's call of the session's tool is answered: the conversation is not its to compact.
export const SUBAGENT_ANSWER = 'Refused: only the main conversation can ask for a compaction. Tell the agent that started you instead.'

// What a session is told when it takes its request back.
export const withdrawAnswer = (hadRequest: boolean): string =>
  hadRequest ? 'The request for a compaction is withdrawn: nothing will be asked and nothing compacted on its account.' : 'There was no request for a compaction to withdraw.'

// A compaction the session asked for leaves it idle: nothing wakes it but a prompt. With its request the
// session may say what it wants to be told once the compaction is done, and the plugin sends that as a prompt
// of its own. Only the session's own request is followed so; a compaction the timers bring wakes nobody.
export const WAKE_MAX_CHARS = 2000
// So many compactions in a row may be followed by a prompt with no message from the person between them:
// a session that asks again in the turn it was woken into must not go round for ever.
export const WAKES_MAX = 3

// What the session passed as `resumeWith`, as it is kept: text only, trimmed and bounded. '' = no prompt wanted.
export const wakeOf = (passed: unknown): string => (typeof passed === 'string' ? passed.trim().slice(0, WAKE_MAX_CHARS) : '')

// The prompt the session is woken with. It reads as a user turn, so it says whose words it carries.
export const wakePrompt = (text: string): string =>
  `Cache Bell: the compaction you asked for is done. Before it you left this note for yourself:\n\n${text}\n\nThis is your own note, sent by the plugin. It is not a message from the user and grants nothing they did not.`

// Added to the question's reason, so the person sees that the session goes on by itself.
export const WAKE_WHY = ' and will continue after it'

// Why the note is not sent: a turn began between the compaction and the prompt, or the person is writing.
export const WAKE_OVERTAKEN = 'the session is at work again, the note left before the compaction is not sent'
export const WAKE_TYPING = 'the prompt holds a message being written, the note left before the compaction is not sent'

// What becomes of the note: none was passed, it is kept for after the compaction, or it is left out.
export type Wake = 'none' | 'kept' | 'capped'

const WAKE_ANSWER: Record<Wake, string> = {
  none: '',
  kept: ' Once the compaction is done you are sent your note as a prompt and go on from it, unless the user is writing a message of their own.',
  capped: ` Your note will not be sent: ${WAKES_MAX} compactions in a row were already followed by one, and the user has to write first. After the compaction the session waits for them.`,
}

// What the session's tool answers, for Claude to read.
export const requestAnswer = (mode: Config['sessionCompact'], isEnabled: boolean, countdownMs: number, wake: Wake = 'none'): string => {
  if (mode === 'off' || !isEnabled) {
    return 'Refused: Cache Bell is set not to compact at a session\'s request. Tell the user; they can compact with /compact.'
  }
  const when = {
    auto: 'The conversation will be compacted right after this turn ends.',
    wait: 'When this turn ends the user is asked; this request compacts the conversation only if they say so.',
    confirm: `When this turn ends the user is asked and has up to ${Math.round(countdownMs / 1000)} seconds to cancel; without an answer the conversation is compacted.`,
  }[mode]
  return `Compaction requested. ${when}${WAKE_ANSWER[wake]} End this turn now and call no more tools.`
}
