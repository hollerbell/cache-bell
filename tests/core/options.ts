// The options the tests of the core start from, so that a test names only what it changes: an idle session
// compacts on a five-minute cache too, nothing is compacted at a size, and the band shows the last 30 minutes.
// The tests were written against these, the defaults of 0.2.x; config.test.ts holds the defaults of today.

import { resolveConfig } from '../../core/config'
import type { Config } from '../../core/types'

export const BASE = { idleCompact: 'on', compactLevelK: 0, display: 'band', displayBelowMinutes: 30 }

// What 0.2.x's modes did, in the options of today: asks and sends nothing; renews and never compacts;
// compacts without a question, a renewal or an announcement.
export const NOTIFY = { idleRenewals: 0, idleCompact: 'off' }
export const KEEP = { idleAsk: 'never', idleRenewals: 3, idleAnnounce: false, idleCompact: 'off' }
export const COMPACT_ONLY = { idleAsk: 'never', idleRenewals: 0, idleAnnounce: false }

export const configOf = (options: Readonly<Record<string, unknown>> = {}): Config => resolveConfig({ ...BASE, ...options })
