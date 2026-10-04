import { expect, test } from 'claude-code/testing'

import { NONE } from '../../core/extension'
import { initialState } from '../../core/decide'
import { resolveConfig } from '../../core/config'
import { CHOICES, CHOICES_OF, FRAME_MS, SWING_MS, askView, chosenNotice, choiceLabel, choiceOfDigit, digitOf, dropReason, mixColor, questionParts, reloadNotice, requestAnswer, swing, wakeOf, wakePrompt, whyText, WAKE_MAX_CHARS } from '../../core/ask'
import type { OwnChoice } from '../../core/ask'

const state = initialState(resolveConfig({}))

const S = 1000

test('the two colours mix channel by channel', () => {
  const table: [number, string][] = [
    [0, '#b38f00'],
    [0.5, '#d9a000'],
    [1, '#ffb000'],
    [-1, '#b38f00'],
    [2, '#ffb000'],
  ]
  for (const [share, color] of table) expect({ share, color: mixColor(share) }).toEqual({ share, color })
})

test('the swing follows a sine: slow at both ends, fastest in the middle, back after two seconds', () => {
  const at = (ms: number): number => Math.round(swing(ms) * 1000) / 1000
  expect([at(0), at(250), at(500), at(750), at(1000), at(1500), at(2000), at(2500)]).toEqual([0, 0.146, 0.5, 0.854, 1, 0.5, 0, 0.5])
  expect([SWING_MS, FRAME_MS]).toEqual([2000, 100])
})

test('the countdown is rounded up and never leaves its range', () => {
  const table: [number, number, string][] = [
    [30 * S, 30 * S, '0:30'],
    [30 * S - 1, 30 * S, '0:30'],
    [29 * S, 30 * S, '0:29'],
    [S, 30 * S, '0:01'],
    [1, 30 * S, '0:01'],
    [0, 30 * S, '0:00'],
    [-5 * S, 30 * S, '0:00'],
    [40 * S, 30 * S, '0:30'],
    [300 * S, 300 * S, '5:00'],
    [299 * S, 300 * S, '4:59'],
    [900 * S, 900 * S, '15 min'],
  ]
  for (const [leftMs, totalMs, left] of table) expect({ leftMs, left: askView('A ', leftMs, totalMs).left }).toEqual({ leftMs, left })
})

test('the colour of the whole line swings between the two colours as the time goes', () => {
  const table: [string, number, string][] = [
    // name, time left of 30 s, colour
    ['at the start the first colour', 30 * S, '#b38f00'],
    ['a quarter of a second in, barely moved', 30 * S - 250, '#be9400'],
    ['half a second in, half way', 30 * S - 500, '#d9a000'],
    ['one second in, the second colour', 29 * S, '#ffb000'],
    ['one and a half, half way back', 29 * S - 500, '#d9a000'],
    ['two seconds in, the first colour again', 28 * S, '#b38f00'],
    ['time is up, a whole number of swings', 0, '#b38f00'],
  ]
  for (const [name, leftMs, color] of table) {
    expect({ name, ...askView('In ', leftMs, 30 * S) }).toMatchObject({ name, color, backgroundColor: undefined })
  }
  expect(askView('In ', 29 * S, 30 * S)).toEqual({ text: 'In 0:29', color: '#ffb000', backgroundColor: undefined, left: '0:29' })
})

test('the bg style swings the background under dark text', () => {
  expect(askView('In ', 30 * S, 30 * S, 'bg')).toEqual({ text: 'In 0:30', color: '#000000', backgroundColor: '#b38f00', left: '0:30' })
  expect(askView('In ', 29 * S, 30 * S, 'bg')).toMatchObject({ color: '#000000', backgroundColor: '#ffb000' })
})

test('a draft names a choice only when it is exactly its digit, among the choices offered', () => {
  const table: [string, string | null, string | null][] = [
    // draft, for the cache question, for the session's question
    ['1', 'compact', 'compact'],
    ['2', 'renew', 'skip'],
    ['3', 'cancel', null],
    ['', null, null],
    ['4', null, null],
    ['0', null, null],
    ['11', null, null],
    ['12', null, null],
    ['1 ', null, null],
    [' 1', null, null],
    ['one', null, null],
  ]
  for (const [draft, cache, session] of table) {
    expect({ draft, cache: choiceOfDigit(CHOICES_OF.cache, draft), session: choiceOfDigit(CHOICES_OF.session, draft) }).toEqual({ draft, cache, session })
  }
  const labels = (reason: 'cache' | 'session'): string[] => CHOICES_OF[reason].map(choice => `${digitOf(CHOICES_OF[reason], choice)} ${CHOICES[choice as OwnChoice].label}`)
  expect(labels('cache')).toEqual(['1 Compact', '2 Renew cache', '3 Let it expire'])
  expect(labels('session')).toEqual(['1 Compact', '2 Not now'])
  expect([choiceOfDigit(CHOICES_OF.session, '2'), choiceOfDigit(CHOICES_OF.session, '3')]).toEqual(['skip', null])
})

test('the first line names who asks and why; the last says when the selected choice is done, and that Enter does it', () => {
  const soon = whyText('cache', state, NONE, resolveConfig({}))
  expect(soon).toBe('cache expires soon, 2 automatic renewals left, then compacts')
  expect(questionParts(false, soon, CHOICES.renew)).toEqual({ title: 'h⣿ Cache Bell:', head: ' Cache expires soon, 2 automatic renewals left, then compacts:', foot: 'No answer: Renew cache in ' })
  expect(questionParts(true, soon, CHOICES.compact).foot).toBe('[Enter] confirms · no answer: Compact in ')
  // A reason with no words still makes a line.
  expect(questionParts(false, '', CHOICES.compact).head).toBe(' :')
  // What is at stake stands right after the reason, once the size of the context is known.
  expect(whyText('cache', { ...state, contextTokens: 143985 }, NONE, resolveConfig({}))).toBe('cache expires soon (144k tokens), 2 automatic renewals left, then compacts')
  expect(whyText('cache', { ...state, contextTokens: 143985 }, NONE, resolveConfig({ mode: 'compact-only' }))).toBe('cache expires soon (144k tokens)')
  expect(whyText('session', { ...state, contextTokens: 143985 }, NONE, resolveConfig({}))).toBe('the session asked for a compaction')
})

test('the cache question says how many renewals the plugin would still do on its own', () => {
  const table: [Record<string, unknown>, number, string][] = [
    // options, renewals done, the reason
    [{}, 0, 'cache expires soon, 2 automatic renewals left, then compacts'],
    [{}, 1, 'cache expires soon, 1 automatic renewal left, then compacts'],
    [{}, 2, 'cache expires soon, no automatic renewals left'],
    [{}, 5, 'cache expires soon, no automatic renewals left'],
    // A mode that does not renew, and no renewals at all: nothing to count.
    [{ mode: 'keep' }, 1, 'cache expires soon, 2 automatic renewals left, then expires'],
    [{ mode: 'keep' }, 3, 'cache expires soon, no automatic renewals left'],
    [{ mode: 'compact-only' }, 0, 'cache expires soon'],
    [{ mode: 'custom', renewMethod: 'none', maxRenewals: 2 }, 0, 'cache expires soon'],
  ]
  for (const [options, renewals, why] of table) {
    expect({ options, renewals, why: whyText('cache', { ...state, renewals }, NONE, resolveConfig(options)) }).toEqual({ options, renewals, why })
  }
})

test('a choice is drawn with its digit, the selected one between arrows, both the same width', () => {
  expect(choiceLabel('1', CHOICES.compact, true)).toBe('[1] >Compact<')
  expect(choiceLabel('1', CHOICES.compact, false)).toBe('[1]  Compact ')
  expect(choiceLabel('3', CHOICES.cancel, false).length).toBe(choiceLabel('3', CHOICES.cancel, true).length)
})

test('the transcript line for a confirmed digit says what was chosen, not that a prompt was dropped', () => {
  expect(dropReason(CHOICES.compact)).toBe('cache-bell: Compact')
  const table: [string, string | null][] = [
    ['Prompt dropped by a hook: cache-bell: Compact', 'h⣿ Cache Bell: Compact chosen'],
    ['Prompt dropped by a hook: cache-bell: Renew cache', 'h⣿ Cache Bell: Renew cache chosen'],
    ['Prompt dropped by a hook: cache-bell: Let it expire', 'h⣿ Cache Bell: Let it expire chosen'],
    ['Prompt dropped by a hook: cache-bell: Not now', 'h⣿ Cache Bell: Not now chosen'],
    ['cache-bell: Not now', 'h⣿ Cache Bell: Not now chosen'],
    // An answer the core does not have is not its line.
    ['Prompt dropped by a hook: cache-bell: Something else', null],
    // Another plugin's drop, another line of ours, and a line that only mentions a choice are left alone.
    ['Prompt dropped by a hook: other-plugin: Compact', null],
    ['cache-bell: transcript not read', null],
    ['Prompt dropped by a hook: cache-bell: Compact now', null],
    ['Compact', null],
    ['', null],
  ]
  for (const [text, said] of table) expect({ text, said: chosenNotice(text) }).toEqual({ text, said })
})

test('the line Claude Code writes after a reload loses its list of hooks', () => {
  const table: [string, string | null][] = [
    ['cache-bell: options changed — reloaded (16 hooks: session.start, session.end, ui.render)', 'cache-bell: options changed — reloaded'],
    ['cache-bell: file changed — reloaded (1 hook: ui.render)', 'cache-bell: file changed — reloaded'],
    ['cache-bell: reloaded (2 hooks: turn.start, ui.render)', 'cache-bell: reloaded'],
    // Another plugin's line, and any other line of ours, are left alone.
    ['other-plugin: options changed — reloaded (2 hooks: a, b)', null],
    ['cache-bell: options changed — reloaded', null],
    ['cache-bell: transcript not read', null],
    ['', null],
  ]
  for (const [text, said] of table) expect({ text, said: reloadNotice(text) }).toEqual({ text, said })
})

test('the answer to a session that asks for a compaction says what will happen and what to do', () => {
  expect(whyText('session', state, NONE, resolveConfig({}))).toBe('the session asked for a compaction')
  expect(questionParts(false, 'the session asked for a compaction', CHOICES.compact).head).toBe(' The session asked for a compaction:')
  const confirm = requestAnswer("confirm", true, 30000)
  expect(confirm).toMatch(/^Compaction requested\. When this turn ends the user is asked and has up to 30 seconds to cancel; without an answer the conversation is compacted\. End this turn now and call no more tools\.$/)
  expect(requestAnswer('confirm', true, 30000)).toMatch(/has up to 30 seconds to cancel/)
  expect(requestAnswer('auto', true, 180000)).toMatch(/^Compaction requested\. The conversation will be compacted right after this turn ends\. End this turn now and call no more tools\.$/)
  expect(requestAnswer('wait', true, 20000)).toBe('Compaction requested. When this turn ends the user is asked; this request compacts the conversation only if they say so. End this turn now and call no more tools.')
  expect(requestAnswer('wait', false, 20000)).toMatch(/^Refused: /)
  expect(requestAnswer('off', true, 180000)).toMatch(/^Refused: /)
  expect(requestAnswer('confirm', false, 180000)).toMatch(/^Refused: /)
  expect(requestAnswer('auto', false, 180000)).toMatch(/^Refused: /)
})

test('on a light background the line swings between two darker ambers', () => {
  expect([mixColor(0, 'light'), mixColor(0.5, 'light'), mixColor(1, 'light')]).toEqual(['#7a5c00', '#976400', '#b36b00'])
  expect(mixColor(1)).toBe('#ffb000')
  expect(askView('In ', 29 * S, 30 * S, 'text', 'light')).toMatchObject({ color: '#b36b00', backgroundColor: undefined })
  expect(askView('In ', 30 * S, 30 * S, 'bg', 'light')).toMatchObject({ color: '#000000', backgroundColor: '#7a5c00' })
})

test('the note for after a compaction is text, trimmed and bounded, and the answer says what becomes of it', () => {
  expect([wakeOf(undefined), wakeOf(7), wakeOf('  '), wakeOf(' go on \n')]).toEqual(['', '', '', 'go on'])
  expect(wakeOf('x'.repeat(WAKE_MAX_CHARS + 50)).length).toBe(WAKE_MAX_CHARS)
  expect(wakePrompt('go on')).toMatch(/^Cache Bell: the compaction you asked for is done\..*\n\ngo on\n\nThis is your own note, sent by the plugin\. It is not a message from the user/s)
  expect(requestAnswer('auto', true, 30000, 'kept')).toBe(
    'Compaction requested. The conversation will be compacted right after this turn ends. Once the compaction is done you are sent your note as a prompt and go on from it, unless the user is writing a message of their own. End this turn now and call no more tools.',
  )
  expect(requestAnswer('off', true, 30000, 'kept')).toMatch(/^Refused: /)
  expect(requestAnswer('off', true, 30000, 'kept')).not.toMatch(/note/)
})
