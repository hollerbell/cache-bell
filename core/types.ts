// Shared shapes of the core. Nothing in core/ touches `$`: time and everything observed come in as values,
// so the whole decision logic runs under table tests without a session.

import type { AskReason, Hold, State } from '../types'
import type { Choice } from './ask'

// The state is kept in `$.state`, so its types live in the plugin's contract.
export type { AskReason, ColdReason, Hold, Phase, RestPhase, State, TtlSource } from '../types'

export type Observation =
  // gapMs: how long since the previous tick; a long gap means the machine slept
  // hold: what stands in the way of a compaction right now (left out = nothing)
  | { kind: 'tick'; gapMs: number; hold?: Hold | null }
  // by: who started the turn. Only a person's turn counts as work; the plugin's own is its announcement;
  // 'other' is known to be somebody else's (another session, a background task), 'unknown' is a turn whose
  // origin nobody stated.
  | { kind: 'turn-start'; by: 'person' | 'self' | 'other' | 'unknown' }
  | { kind: 'request'; sentAt: number }
  // isAborted: the turn was interrupted or ended in an error instead of an answer
  // isFailed: it ended in an error, so its last request may never have reached the cache
  | { kind: 'turn-complete'; contextTokens?: number | undefined; isAborted?: boolean | undefined; isFailed?: boolean | undefined; hold?: Hold | null }
  // the person's answer to the question, or the selected choice when its time ran out
  // isTimers: nobody answered and the time ran out; only then can `hold` make a compaction wait
  | { kind: 'answer'; choice: Choice; isTimers?: boolean; hold?: Hold | null }
  // a renewal's request came back: whether it read the cache, and when it was sent
  | { kind: 'renewed'; isHit: boolean; sentAt: number }
  // a renewal's request got no answer (an API error, a refusal): the cache is as warm as it was
  | { kind: 'renew-failed' }
  | { kind: 'compact-failed' }
  // the shell was about to compact and found something in the way
  | { kind: 'held'; hold: Hold }
  // the session asked for a compaction, in the turn that is running
  // countdownMs: how long the session wants the person to have to cancel; left out = the option's
  | { kind: 'requested'; countdownMs?: number | null }
  // the session takes back what it asked for earlier
  | { kind: 'withdrawn' }
  // /bell set: the compaction level of this session, in tokens; 0 = none, null = the option's again
  | { kind: 'level'; levelTokens: number | null }
  // the shell could not carry out a step (the announcement did not get through)
  | { kind: 'refused'; reason: string }
  // requested: the plugin set the hour in Claude Code's environment, before a request; default: it took the
  // hour back and nothing else asks for a TTL
  | { kind: 'ttl'; ttlMs: number; source: 'transcript' | 'settings' | 'requested' | 'default' }
  // the transcript could not be read, or was read and names no TTL
  | { kind: 'ttl-unread'; isUnread: boolean }
  | { kind: 'model-switch'; ttlMs: number | null }
  // own: the plugin ran it itself, with the sizes before and after in tokens, and isIdle when it ran before an
  // idle session's cache expired; tokensAfter: the size after another's compaction, where Claude Code said it
  | { kind: 'compacted'; own?: { before: number | null; after: number | null; isIdle?: boolean }; tokensAfter?: number | null }
  | { kind: 'cleared' }
  // the session was resumed from its transcript in a new process: when its last request went out, as the
  // transcript or Claude Code says, and the size of the context then
  | { kind: 'resumed'; lastRequestAt: number; contextTokens?: number | undefined }

export type Action =
  | { kind: 'redraw' }
  | { kind: 'notify'; text: string }
  // ask the person; `deadline` is when the selected choice is done without an answer
  | { kind: 'ask'; reason: AskReason; deadline: number; selected: Choice }
  | { kind: 'close-question' }
  // one request that reads the cache and so renews it
  | { kind: 'renew' }
  // tell the session that a compaction is coming
  | { kind: 'prepare' }
  | { kind: 'compact' }

export type Decision = { state: State; actions: Action[] }

// off: nothing; watch: the countdown and the size, nothing sent and nothing said to the session; bellcompact:
// the session compacts from its level on, and the plugin keeps the cache of an idle session (the idle options)
export type Profile = 'off' | 'watch' | 'bellcompact'

export type Config = {
  enabled: boolean
  profile: Profile
  ask: 'first' | 'every' | 'never'
  maxRenewals: number
  // the number the person set when it lay outside 0 to the cap and was taken to the nearer end; null otherwise
  maxRenewalsAsked: number | null
  prepareBeforeCompact: boolean
  compact: boolean
  // compact only while the cache lives an hour (idleCompact auto): on five minutes the person is mostly back
  // after the compaction, which then cost them their conversation for nothing
  compactHourOnly: boolean
  preparePrompt: string
  pingPrompt: string
  compactInstructions: string
  // null = read it from the data (transcript, model switch, settings)
  ttlMs: number | null
  minContextTokens: number
  // the context size the person wants a compaction at; 0 = none
  compactAtTokens: number
  // whether Claude is told how full the context is, after a tool result in a turn
  contextNotices: boolean
  // how long a question that does not wait for the cache (one the session asked for, an extension's) waits
  compactCountdownMs: number
  // how many compactions in a row may be followed by the session's note with no message from the person
  // between them; 0 = no limit
  wakesMax: number
  // how long before the time to act the cache question appears; 0 = automatic
  askLeadMs: number
  // what a compaction the session asked for does: ask and compact when the countdown ends, ask and wait
  // for the person's answer, compact at once, or not allowed
  sessionCompact: 'confirm' | 'wait' | 'auto' | 'off'
  display: 'band' | 'status' | 'both' | 'off'
  // the countdown of a warm cache shows once at most this much time is left; 0 = always
  showBelowMs: number
  // whether the session's transcript may be read (cacheTtl other than settings)
  readTranscript: boolean
  // the hour-long cache (cacheRequestHour): on, off, or as the person answers the question about their rhythm
  requestHour: 'ask' | 'on' | 'off'
}
