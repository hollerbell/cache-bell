# Changelog

What changed in each version, newest first. `/bell status` says which version runs.

## 0.2.3

- Typing the message that asks for a compaction no longer holds that compaction back: once a message is
  sent, the typing that wrote it is over. Before, a compaction asked for within a minute of your last key
  waited for you "to finish typing", and your next message dropped it.

## 0.2.2

- A message from another session, or a background task's result, no longer drops a compaction Claude asked
  for. It only interrupts the question: when that turn ends the question comes back, with the time its
  countdown had left and at least ten seconds. A digit you had typed still selects its choice. Your own
  message drops the request, as before.
- Claude can take its request back: the `compact` tool takes `cancel`. This also takes back a compaction
  that waits for a subagent.
- When you ask Claude for the compaction yourself, in your own message, the countdown is three seconds.
- A question about the cache that another turn interrupted is not counted as asked: the plugin asks again
  in the next idle period.
- A question that is put up again after the plugin was reloaded keeps the choice you had typed.
- The log of compactions no longer credits a later compaction to a request that was dropped.

## 0.2.1

- The README gives the install from GitHub first (`claude plugin marketplace add hollerbell/cache-bell`)
  and from a clone second, and says how to update and remove the plugin either way.

No change in what the plugin does.

## 0.2.0

The first public version.

- A countdown above the prompt until the prompt cache expires, and a question before it does: compact,
  renew the cache, or let it expire.
- Presets `notify`, `keep`, `prepare-compact` (the default) and `compact-only`, and a custom mode. No mode
  sends more than three renewal requests in one idle period.
- Claude can ask for a compaction once its work is done (the skill and the tool `compact`); you get a
  countdown to cancel, or with `sessionCompact` = `wait` nothing is compacted without your answer.
- A compaction the timer starts waits while you type and while a subagent runs, and never past the cache.
- `/bell status`, `/bell log`, `/bell demo`, `/bell show` and `/bell reset`.
- A log of compactions kept on your machine.
