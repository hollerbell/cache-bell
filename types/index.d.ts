// The plugin's type contract: the values it keeps in `$.state`. core/types.ts re-exports the state's types
// from here, so they are written once.

// UNKNOWN, WARM, COLD and DORMANT are where an idle session rests. BUSY is a turn of the session.
// ASKING, RENEWING, PREPARING and COMPACTING are the plugin's own steps on a warm cache.
export type Phase = 'UNKNOWN' | 'BUSY' | 'WARM' | 'ASKING' | 'RENEWING' | 'PREPARING' | 'COMPACTING' | 'COLD' | 'DORMANT'

export type RestPhase = 'UNKNOWN' | 'WARM' | 'COLD' | 'DORMANT'

// Where the TTL in the state came from, strongest first.
export type TtlSource = 'config' | 'transcript' | 'model-switch' | 'settings' | 'default'

// Why the question is asked: the cache is about to expire, the session itself asked for a compaction, or a
// reason an extension added (core/extension.ts).
export type AskReason = 'cache' | 'session' | (string & {})

export type ColdReason = 'expired' | 'sleep' | 'model-switch' | 'renew-missed' | 'compact-failed' | 'postponed'

// What a compaction waits for: the person is typing, or a subagent still runs.
export type Hold = 'typing' | 'agent'

export type State = {
  phase: Phase
  // When the last main-thread request to the API was sent. The cache's lifetime runs from here,
  // not from the end of the turn. null = no request seen since the start, a /clear or a compaction.
  anchorAt: number | null
  ttlMs: number
  ttlSource: TtlSource
  coldReason: ColdReason | null
  // While a turn runs and has sent no request yet: the phase to return to if it ends that way.
  // null outside a turn and once the turn has sent a request.
  resumeTo: RestPhase | null
  // How many times the cache was renewed since the person last worked in the session.
  renewals: number
  // How many renewal requests were sent in that time, answered or not: the cap is on what goes out.
  renewalsSent: number
  // A renewal got no answer: when the one retry may go out. null = no retry is pending.
  retryAt: number | null
  // The request before the last one, or what the anchor was before the turn: what the cache is known to
  // have seen, should the last request turn out to have failed.
  priorAnchorAt: number | null
  // The question was asked since the person last worked in the session.
  isAsked: boolean
  // The person chose to let the cache expire: nothing more is done until they work again.
  isDeclined: boolean
  // The size of the context after the last turn; null = not known (also right after a compaction).
  contextTokens: number | null
  // While ASKING: why, and when the selected choice is done without an answer.
  askReason: AskReason | null
  askDeadline: number | null
  // What an extension remembers. The core stores it and never reads it.
  ext: Readonly<Record<string, unknown>>
  // The session asked for a compaction in the turn that is running: it is taken up when the turn ends.
  isRequested: boolean
  // The countdown that session asked for with its request, in ms; null = the one from the options.
  requestMs: number | null
  // A compaction that was due and waits: for what, and whether its announcement is behind it (made, or not
  // needed). null = none waits.
  held: { by: Hold; isTold: boolean } | null
  // The person themselves said Compact: the compaction on its way waits for nothing.
  isOrdered: boolean
  // When the person last sent a message of their own: how long the session has been idle counts from here.
  workedAt: number | null
  // The plugin's own compaction, for the line the band shows until the next turn: the sizes in tokens and
  // how long the session had been idle. null = none since the last turn.
  lastCompaction: { before: number | null; after: number | null; idleMs: number | null } | null
}

declare module 'claude-code' {
  interface PluginState {
    'cache-bell': { machine: State | null }
    // Written by the plugin built on this one (it carries this contract): true while it runs in the session.
    // This plugin only reads it, and stands down when it is set.
    'holler-bell': { isRunning: boolean }
  }
}
