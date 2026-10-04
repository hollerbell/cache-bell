---
name: compact
description: Compact this conversation at a good moment, with the plugin's compact tool. Use when the user asks to compact once the current work is done, or when a whole piece of work has just been finished and the context is large.
---

# Compacting at a good moment

The plugin compacts the conversation right after the current turn ends, while the prompt cache is still
warm. You ask for it with the plugin's `compact` tool (listed as `mcp__cache-bell__compact`); nothing is
compacted while you are still working.

## When

- The user has not said how to handle compaction: when a whole piece of work is finished, not just a step
  of it, and nothing is in progress, call the tool. The plugin asks the user and compacts when the
  countdown ends, unless they cancel.
- The user asked for it ("compact when you are done", "wrap up and compact"): call the tool when the work
  is done.
- The user's own rules come first, in either direction. "Compact after every finished task" gives you more
  freedom; "only suggest it" means you say in one sentence that this would be a good moment, and call the
  tool once they agree.
- Never in the middle of work, while a background task or a subagent is running, or right before the user
  is likely to follow up on details that a summary would lose.

## How

1. Finish what you are doing. Save your work first; a compaction keeps only a summary.
2. Call the `compact` tool. Pass `reason`: one short sentence the user will read. You may pass `countdown`:
   the seconds the user gets to cancel, 10 to 600. Leave it out to use the user's own setting.
3. Read the tool's answer. It says whether the user is asked and for how long, whether the plugin waits for
   their answer, or whether its settings do not allow a session to ask at all. If it was refused, tell the
   user and carry on.
4. End the turn and call no more tools.

The user answers in the band above the prompt: they may cancel, or, where the plugin waits for them,
confirm. If nothing is compacted, you simply continue with their next message.
