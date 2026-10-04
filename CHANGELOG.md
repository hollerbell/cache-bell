# Changelog

What changed in each version, newest first. `/bell status` says which version runs.

## 0.2.5

- A compaction Claude asked for no longer leaves the session waiting for you. With its request Claude may
  leave itself a note of what comes next (the tool's new parameter `then`), and the plugin sends the note
  back as a prompt once the compaction is done. The question says so: `will continue after it`. The note is
  marked as Claude's own, not as your message. Nothing is sent when you cancel, when you send or are writing
  a message, when other work started meanwhile, or when the compaction fails; after three compactions in a
  row that were followed by a note, the next one waits for you. A compaction the timer starts wakes nobody.
- `Not now` leaves a trace: a notice says that the compaction was cancelled and nothing was compacted.

## 0.2.4

- When the transcript cannot be read and nothing else names the cache TTL, the plugin no longer acts on
  the five minutes it assumes: it does not ask, renew or compact, says so in the band and in
  `/bell status`, and tries the read again after 15 seconds, after a minute and then every five minutes.
  Before, a busy Windows machine could make the read time out, and a session with an hour-long cache was
  then treated as one with five minutes.
- The transcript is read far less: not at all when it did not grow, and once its TTL is confirmed no
  more than every two minutes. Of a large transcript only the end is read, by its bytes: what was appended since
  the last read, 1 MiB at the most. The cost no longer grows with the file; on Windows the read takes about half a second instead of more than one.
- The README shows the band after a compaction.

## 0.2.3

- A compaction is no longer held back by the typing of the message that asked for it: once a message is
  sent, that typing is over. Before, a compaction asked for within a minute of your last key press waited
  for you "to finish typing", and your next message dropped it.

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
