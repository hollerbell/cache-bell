# Changelog

What changed in each version, newest first. `/bell status` says which version runs.

## 0.3.26

- A new option, `guarded`, for a runner that starts Claude Code where its guard keeps the plugins' classic hooks (a Team or Enterprise account, managed settings). On, the plugin registers none of those hooks, and Claude Code no longer says at every start that Cache Bell's hook was skipped. Until now the message came at every start on such an account. Installed on its own, without such a runner, the message still comes; the README says so under Limits.

## 0.3.25

- When you switch the model while Claude is working and that turn then ends in an error before another request, the plugin now says it does not know the cache. Until now it took the cache as warm from the last request of the old model, which the new one cannot read.
- Not changed, only said now: since 0.3.24, a digit you bring back from your earlier prompts with the up arrow, under a question and within a minute of answering with the same digit, may also do nothing on Enter. Type it, and it answers.

## 0.3.24

- The digit you answered a question with, when Claude Code puts it back in the prompt box only after the next question opened, is now taken out too, and Enter on it does nothing: it neither answers that question nor goes to Claude. The same goes for a digit Claude Code does not let the plugin clear. A digit you type again answers as before. Until now such a digit stayed in the box, and Enter sent it as your answer.

## 0.3.23

- The README now says that a message you send while Claude is working counts as your work, and that one sent while the session answers the announcement calls the compaction off. This changelog now uses "note" only for what Claude leaves for itself and gets back after a compaction; what it writes before a compaction is its answer to the announcement. The plugin works as before.

## 0.3.22

- No change in what the plugin does: more tests for messages that come in while Claude is working.

## 0.3.21

- The digit you answered a question with is now taken out of the prompt box also when Claude Code puts it back there up to 5 seconds later. Until now it stayed in the box when it came back after 1.5 seconds.
- A digit left over in the prompt box from your last answer, when it is there as the next question opens within a minute, no longer counts as your choice. The plugin takes it out, so that Enter does not send it. Until now the next question took it for your choice. A digit Claude Code puts back only after the question opened still stays: it cannot be told from one you typed.

## 0.3.20

- When you send a message while the plugin asks, another session's message comes in at the same time, and Claude Code joins them into one turn, that turn now counts as yours: what Claude asked for is taken back and the question does not come back. Until now the other session's message could hide yours.
- When several messages come in while Claude is working, the turn that one of them starts now knows whose it is from that message. Until now only the last message counted, and a turn an earlier one started was taken for one of unknown origin, which takes back a compaction Claude asked for.
- A coordinating session's hand-off or an observer agent's report now only interrupts a question, as another session's message does. Until now it was taken for one of unknown origin and took back what Claude asked for. A message a channel relays (Slack, Telegram) still takes it back: it may be you writing from a chat, where you would not see the question come back.
- A ping from you in Slack now counts as your message at once: what Claude asked for is taken back, also when Claude takes the ping in during the turn that runs. Until now it was taken back only when the ping started a turn of its own.
- A message that another plugin keeps out is forgotten at once. Until now the plugin held its text until the next turn started and could count that turn as the message's.

## 0.3.19

- Once a compaction has begun, a message you send no longer brings the line "The compaction was called off: you went on working." The compaction goes ahead. Until now that line could show while the compaction ran.
- When you write while Claude answers the announcement before a compaction and the request of that turn fails, the plugin now counts the cache from the request before it. Until now it counted from the failed request as if the cache had seen it, and could renew or compact after the cache had already run out.
- This changelog said for 0.3.15 that only a compaction the timers brought is called off by a message you send just before it. A compaction Claude asked for is called off too, as any message of yours takes back what Claude asked for. Only the changelog was wrong; the plugin works as before.

## 0.3.18

- Under a Team or Enterprise login, or with managed settings, a finished turn no longer ends with the line "cache-bell: its classic.Stop hook was skipped". The plugin no longer uses Claude Code's Stop event: it reads the transcript when the turn ends. Until now Claude Code's built-in guard sent that event on past the plugin and said so after every turn.

## 0.3.17

- A digit you send from your phone (Remote Control) or from another app no longer answers the question, which only the terminal shows. It goes to Claude as any other message of yours and takes back a compaction Claude asked for. Until now it answered a question you could not see, so a 1 chose Compact.
- A message you send just as another session's message starts a turn now takes back a compaction Claude asked for, as any message of yours does. Until now the question could come back when that turn ended, with Compact as what happens without an answer.
- The Privacy section now also says that the plugin reads the prompt box after a digit answered a question, and that it holds a message sent while Claude is working until the next turn starts.

## 0.3.16

- After you answer a question with its digit and Enter, the prompt is empty again. Until now Claude Code put the digit back in the prompt, so your next message began with it. Anything else in the prompt is left as it is.

## 0.3.15

- A message you send while Claude answers the announcement before a compaction the timers brought now calls that compaction off, as Esc does, and counts as your work. Until now the compaction followed all the same. A compaction you chose yourself still goes ahead.

## 0.3.14

- A message you send while Claude is working (not while it answers the announcement before a compaction), which Claude takes in during that turn, now counts as your work as one that starts a turn does: the idle period and its renewals start over, and "Not now" or "Let it expire" no longer holds for the next idle period. Until now such a message changed nothing of it, so after "Let it expire" the cache was left to expire although you had gone on working.

## 0.3.13

- A message sent while Claude is working, which Claude takes in during that turn, no longer marks a later turn as its own. Until now the next turn that started without a message of its own (a continuation, for example) counted as that message's, and the plugin treated it so: as your work, which starts the idle period and its renewals over, or as another session's, which kept a compaction Claude asked for that such a turn should have dropped. A message of yours taken in that way now also starts the count of `compactNotesInRow` over.

## 0.3.12

- A message you send to the session from Slack now starts the count of `compactNotesInRow` over, as one typed in the terminal does. Until now only the terminal's did, so a session you drove from Slack waited for the terminal after a few compactions. A digit sent that way still answers no question of Cache Bell's, which only the terminal shows. What a channel relays (Slack, Telegram, a build's result) does not count: it may come from a bot, not from you.

## 0.3.11

- A message from another Claude session counts as such however Claude Code delivers it: also as a SendMessage notification, or relayed by a session that coordinates others. What a session sends its own agents does not count. It starts the count of `compactNotesInRow` over, and while you are being asked about a compaction Claude asked for, it only interrupts the question. Until now only one of these ways did: after the others, the session waited for you after a few compactions, and the compaction Claude asked for was dropped.

## 0.3.10

- The tests badge in the README shows the tests of the published plugin again (412). Until now 0.3.8 and 0.3.9 counted tests that are not published with it.

## 0.3.9

- A digit only answers Cache Bell's question when you type it. A message from another Claude session, or from a background task, that holds just a choice's digit now goes to Claude like any other message. Until now such a message answered the question in your place, for example with Not now.

## 0.3.8

- A message from another Claude session now counts like yours for `compactNotesInRow`: after it, compactions may again be followed by the note Claude left for itself. Until now only your own message did, so a session that other sessions drive stopped after five compactions in a row and waited for you.

## 0.3.7

- Recent versions of Claude Code compact an idle session by themselves shortly before an hour-long cache expires, once it is above roughly 200k tokens. While Cache Bell looks after idle sessions (`profile` `bellcompact`), it now stops that compaction and goes on as it is set to: it asks, renews or compacts. If it has not asked yet in this idle period, it asks right away, unless `idleAsk` is `never`. Until now that compaction went ahead, even when you had chosen Renew. With `profile` `watch` or `off`, or below `idleMinContextK`, the plugin lets it go ahead. To turn it off in Claude Code itself, set `idleCompaction` to `false` in Claude Code's settings.

## 0.3.6

- A new option, `compactNotesInRow`: how many compactions in a row may be followed by the note Claude left for itself, before you have to write a message. Default 5; `0` = no limit. Until now the number was fixed at three, so by default a session can now carry on by itself for two more compactions. Set it to `3` to keep the earlier behaviour.

## 0.3.5

- The row of a `compact` call now shows only the reason, on one line. Until now a long reason or note wrapped into a tall, narrow column.

## 0.3.4

This version renames and regroups the options of 0.2.x (see "Options of 0.2.13" below). If you ran 0.2.13 with its default options, Claude now compacts the conversation by itself once the context passes 200K, at a good moment, without asking you first. With the default settings you still get a 30-second countdown to cancel: while you type it waits, and sending a message cancels it. To keep 0.2.13's behaviour, set `compactLevelK` to 0, `idleCompact` to `on` and `idleMinContextK` to 100, and set up the display as described under "Countdown in the status line" below. To keep only the warnings, set `profile` to `watch`.

- **Profiles.** A new option, `profile`, says what the plugin does:
  - `off`: nothing.
  - `watch`: it shows how long the prompt cache lasts and how full the context is, and does nothing on its own.
  - `bellcompact` (the default): Claude is told how full the context is. Once the context passes a level you choose (`compactLevelK`, 200K by default), Claude compacts the conversation at a good moment, after a finished piece of work. While the session is idle, the plugin renews the cache as before; whether it then compacts depends on the cache lifetime (see below).

  `/bell` shows the profile at the top, for example `bellcompact[200K]`, with one sentence on what will happen.
- **`/bell set 300K`** gives the current session a level of its own. `/bell set off` turns off compaction by size for that session, and `/bell set default` goes back to the level from the options. Nothing is written to your settings.
- **No more size question.** Until now, past the limit the plugin asked: Compact, Later or Not in this session. Now Claude is told and compacts at a good moment. `/bell set off` turns this off for one session.
- **Idle compaction only on an hour-long cache.** The new option `idleCompact` is `auto` by default: the plugin compacts an idle session before the cache expires only while the cache lives an hour. On a five-minute cache it lets the cache expire. People often come back within the hour, and a compaction would then cost more than it saves. `on` always compacts an idle session, and `off` never does.
- **The hour-long cache, on request.** The first-run notice asks what you usually do after Claude replies. If you answer that you come back within the hour, the plugin asks Claude Code for the hour-long cache:
  - It does so the next time the cache is cold anyway, so nothing is written twice.
  - It sets `CLAUDE_CODE_PROMPT_CACHE_TTL=1h` in the environment of this Claude Code process, not in your shell or your settings. Processes that Claude Code starts inherit it, with one exception: shell commands that Claude runs with its Bash or PowerShell tool in the main conversation while no subagent is running. A subagent's shell commands keep it, and so do the main conversation's while a subagent is running, because requests may go out in the meantime. A `claude -p` that inherits it drops it as it starts.
  - `/bell hour on|off` changes your answer later. The option `cacheRequestHour` (`ask`, `on`, `off`) sets it for good.
  - On the API, writing to an hour-long cache costs twice the base input price, against 1.25 times for a five-minute one; reading costs the same for both. How this counts toward Pro, Max or Team limits is not published. It pays off when you often come back after more than five minutes but within the hour.
  - A TTL you set yourself is never touched. `cacheTtl` only tells the plugin which TTL to assume. Set to `5m`, it also stops the plugin from asking for the hour-long cache.
  - After `/bell hour off`, the next request no longer asks for the hour. With `enabled` = off or `profile` = `off` the plugin never asks for it, and removes a value it set earlier as soon as it loads with that setting. If you disable or uninstall the plugin in Claude Code instead, the variable stays set until Claude Code ends.
  - With `profile` = `watch`, the plugin asks for the hour only if you chose it yourself: in the first-run notice, with `/bell hour on`, or with `cacheRequestHour` = `on`.

  `/bell status` says whether the hour was asked for and whether the API granted it.
- **Countdown in the status line.** `display` is now `status` by default (it was `band`). The countdown appears 15 minutes before the cache expires (it was 30). Questions are still shown above the prompt. To keep the old look, set `display` to `band` and `displayBelowMinutes` to 30.
- **Cache lifetime.** The new option `cacheTtl` has four values:
  - `auto`: read from the transcript, as before;
  - `settings`: the transcript is never read. The lifetime is then only a guess, so the plugin does nothing on its own while the session is idle. To have it act, choose `5m` or `1h` instead;
  - `5m` or `1h`: set by hand.

  The plugin asks, renews and compacts only when it knows the lifetime. Until now it could renew an hour-long cache needlessly.
- `minContextTokens` is now `idleMinContextK`. Its default is 80, meaning 80 000 tokens (it was 100 000 tokens in 0.2.13).
- Once the context is half full, Claude gets one line on its size after tool results (`compactContextNotices`, on by default). You don't see it, and it sends no extra request.

### Options of 0.2.13

Taken over:
- `enabled` stays as it is. `false` turns the plugin off whatever the profile.
- `mode` still applies as long as `profile` and the other new options are left at their defaults:
  - `notify` → `watch`;
  - `keep` → `bellcompact` with `compactLevelK` 0, `idleCompact` `off`, `idleAsk` `never` and `idleRenewals` 3;
  - `prepare-compact` → `bellcompact`;
  - `compact-only` → `bellcompact` with `idleCompact` `on` and `idleAsk` `never`, without renewals or announcement;
  - `custom` → the defaults.
- `compactCountdown`, `compactInstructions` and `display` keep their names and values.

Not taken over. Set these again under their new names:

| 0.2.13 | 0.3.4 |
|---|---|
| `minContextTokens` (tokens) | `idleMinContextK` (thousands) |
| `sessionCompact` | `compactOnRequest` |
| `askLeadMinutes` | `idleAskAheadMinutes` |
| `showBelowMinutes` | `displayBelowMinutes` |
| `preparePrompt` | `idleAnnouncePrompt` |
| `pingPrompt` | `idleRenewPrompt` |
| `ask` (custom) | `idleAsk` |
| `maxRenewals` (custom) | `idleRenewals` |
| `prepareBeforeCompact` (custom) | `idleAnnounce` |
| `compact` (custom) | `idleCompact` |
| `renewMethod` | removed; set `idleRenewals` to 0 for no renewals |
| `readTranscript` | removed; use `cacheTtl` `settings` |
| `ttl` | `cacheTtl`; for the hour-long cache itself, see `cacheRequestHour` |
| `compactAtK` (0 = off) | `compactLevelK` (200 by default) |

## 0.3.0–0.3.3

Internal versions, never released. Their changes are in 0.3.4.

## 0.2.13

- Where Claude Code's own events (session start, end of turn) do not reach the plugin, nothing told it
  where the session's transcript is: the cache's lifetime stayed the assumed five minutes, and a resumed
  session showed "unknown" until its first turn. The plugin now looks for the transcript itself, by the
  session's id in Claude Code's folder, shortly after the session starts and after each turn, and uses the
  file only when it is there. An event that names the transcript still goes first. `/bell report` then
  says `Transcript: path known yes, found by the session's id`.

## 0.2.12

- The plugin notes the path of the session's transcript as soon as a turn ends, before the Stop hooks of
  other plugins run, and when the transcript is not read there, a later tick of the plugin reads it.
  Until now the path was noted after those hooks had returned.
- `/bell report` has a new row, `Events seen`: how many session starts, ends of turns and requests reached
  the plugin since it was loaded, and how many of the first two named the transcript. Where a transcript
  stays unnamed, the row shows which event did not come or came without the path. Counts only, nothing of
  what was said.
- README: how to update is now in Quick start as well.

## 0.2.11

- A session you resume (`claude --resume`, `--continue`, a fork) knows its cache from the start. Until now
  the plugin showed "unknown" and assumed five minutes until the first turn in the new process had ended.
  It now reads the TTL and the time of the last request from the transcript as the session starts: the
  band and `/bell status` say how long the cache still lives, or that it ran out while the session was
  closed, and with time left the plugin asks, renews and compacts as the mode says.
- When nothing has named the cache's lifetime and the countdown runs on the assumed five minutes, the band
  says so beside it (`lifetime 5m assumed, not yet seen in the data`). Until now only `/bell status`
  did.

## 0.2.10

- `/bell status` typed while Claude is working is shown at once, as a notice of one line. Until now Claude
  Code printed it only when the turn was over, with what was true when you typed it.
- New: `/bell report` prints what a report of a problem needs, to paste into an issue: the versions, the
  model, whether another provider or an API address of your own is set (yes or no, never the address),
  the options, the state, the size of the transcript and the usage figures of its last response, and
  the plugin's last notices, of each only the plugin's own words. It holds no message text, no file
  path, no address and no key, and the plugin sends it nowhere. For it the plugin reads five more
  environment variables, named in the README's Privacy section.
- The bug report template asks for the output of `/bell report` instead of `/bell status`.

## 0.2.9

- The options that take one of a few words (`mode`, `ask`, `renewMethod`, `ttl`, `sessionCompact`,
  `display`) are a list to pick from in `/config` again, as they were before 0.2.7. A word in
  `settings.json` that an option does not accept is still replaced by the default. Claude Code now checks
  this itself, so `/bell status` no longer names the word.

## 0.2.8

- When the first-run notice is up in several sessions at once, OK or a message in one of them puts it away
  in all: the others follow within a few seconds.
- The plugin's entry in Anthropic's directory gets keywords and a home page: two more fields in the manifest.

## 0.2.7

- The plugin's entry in Anthropic's directory gets an icon, a file beside the manifest, and links to the
  repository, the documentation, the privacy section and the issues, new fields in the manifest. Claude Code
  itself reads none of them.
- The README's Privacy section now names everything the plugin reads, writes and changes.
- The options that take one of a few words (`mode`, `ask`, `renewMethod`, `ttl`, `sessionCompact`,
  `display`) are rows of free text in `/config`, no longer a list to pick from: Anthropic's plugin directory
  does not take such a list. A word an option does not take is replaced by the default,
  as before, and `/bell status` now says so and names the words the option takes.
- `/bell reset` is gone: the plugin no longer writes any setting. To go back to the defaults, change the
  rows in `/config`, or delete the plugin's key under `pluginConfigs` in `settings.json`.
- The `compact` tool's parameter for the note is called `resumeWith` (it was `then`, which is still read).

## 0.2.6

- The README says more exactly what happens with the note Claude may leave with a compaction request:
  when it is sent and when not, and, under Privacy, that the plugin only holds it in memory and does not
  write it anywhere itself; Claude Code records it in the session's transcript.

No change in what the plugin does.

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
