// Where a plugin built on top of this one adds reasons of its own to ask for a compaction. An extension is
// pure, like the rest of core/: it never sees `$`. The shell hands it the plugin's options once and the core
// asks it at the few places below. What it needs to remember lives in the state's `ext`, which the core
// stores and never reads.

import type { Choice, ChoiceText } from './ask'
import type { OptionValue } from './config'
import type { Config, State } from './types'

export type Ext = State['ext']

export type ExtensionReason = {
  // the answers offered, in the order of their digits; 'compact' is the core's own and compacts
  choices: readonly Choice[]
  // what the question opens with, and what is done when nobody answers
  selected: Choice
  // the reason in words, for the line under the choices
  why: (state: State) => string
}

export type Extension = {
  reasons: Readonly<Record<string, ExtensionReason>>
  // the answers it adds to the core's own
  choices: Readonly<Record<string, ChoiceText>>
  // A turn ended on a warm cache and the core has nothing to ask: the reason of a question to ask now.
  due: (state: State, config: Config) => string | null
  // One of its answers was given: what it remembers from now on. null = not an answer of its own.
  answer: (state: State, choice: Choice) => Ext | null
  // The person worked on past its question without answering it.
  passedOver: (state: State) => Ext
  // The conversation was compacted or cleared: what is still worth remembering.
  reset: (ext: Ext, after: 'compacted' | 'cleared') => Ext
  // its rows of the /bell status report
  status: (state: State) => string[]
  // the options it adds to the plugin's, each with its default
  defaults: Readonly<Record<string, OptionValue>>
}

export const NONE: Extension = {
  reasons: {},
  choices: {},
  due: () => null,
  answer: () => null,
  passedOver: state => state.ext,
  reset: () => ({}),
  status: () => [],
  defaults: {},
}

// The plugin's options → its extension. The options are plugin.json's userConfig, unchecked.
export type Extend = (options: Readonly<Record<string, unknown>>) => Extension
