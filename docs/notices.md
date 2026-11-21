# Notices

A notice is a machine event the chat shows as a one-line chip instead of a
bubble. Every notice is recorded as a durable entry first, so a reload or a
stream reconnect rebuilds the same chip from storage instead of replaying it
from the live stream. Some notices also wake the agent with a model message;
others are display-only.

## Routing

| Event                 | Chat chip | Model turn | Where it is recorded                              |
| --------------------- | --------- | ---------- | ------------------------------------------------- |
| Background job        | yes       | yes        | `ui.job-notice`, as one chip and one activity row |
| Background job (plan) | queued    | yes        | `ui.job-notice` in the plan conversation          |
| MCP event             | yes       | yes        | `ui.mcp-notice`, first entry of the notice group  |
| MCP status            | yes       | no         | `ui.mcp-notice`, update of an open notice group   |
| Delegate run          | yes       | yes        | `ui.delegate-notice`                              |
| Memory write          | yes       | no         | `ui.memory-write`                                 |
| Idle nudge            | yes       | yes        | `ui.idle-nudge`                                   |
| Legacy job bubble     | no        | no         | an old `user` entry, migrated to an activity row  |

The two rules behind the table:

- A chip is the only chat surface for a machine event. A notice never renders
  as a user bubble, and an event that has a chip is never also repeated as
  plain text in the transcript.
- A model turn happens only when the stored entry carries a model message.
  `ui.job-notice` for a `notify: false` or cancelled job, a memory write and an
  MCP status update carry data only, so they show a chip and start nothing.

## Background jobs

`ui.job-notice` is the only entry kind for a job result. One stored entry feeds
both surfaces:

- the chat chip at order `entry.id * 10_000`, with `role: "system"` and
  `notice.kind === "job"`, whose summary comes from `parseJob`
  (`job build finished ✓ 12s`, `job build failed ✗ exit 4`,
  `job build cancelled · 12s`, `job build lost on restart`);
- the activity row with id `j-<entry.id>` at the same order.

The chip's `NoticeDialog` renders `JobDetails` for a job notice: command, status,
exit code, signal, duration and last output. The Activity page shows the same
fields in its own `JobActivityRow`; the composer's background-jobs sheet lists
running jobs only.

Every writer places that one kind: a notified job through `submitJobNotice`, a
`notify: false` or cancelled job through `recordNotice`, a lost-on-restart job
through the same notifier path, and a plan-owned job in the plan conversation.
Both chats queue the chip while busy. The queued entry carries the queue key,
so the pending chip and the placed chip share one message id and the pending
form is replaced instead of joined by a second chip. A plan whose pane is
already closed falls back to `recordNotice`, so the result still lands as one
chip and one activity row.

Because the entry that wakes the agent is also the entry that draws the chip,
the result reaches the model exactly once and the chat shows it exactly once.
The `ChatView` activity filter keeps job rows out of inline tool groups, so a
single finish is never painted twice.

### Worked example

Conversation 2 holds notice entry `104467`, created
`2026-11-21T13:27:01.126Z`. It was a job result, so after the change the
transcript rebuild emits:

- a chat chip `m-104467` at order `104467 * 10_000 = 1_044_670_000`, timestamp
  `2026-11-21T13:27:01.126Z`;
- the activity row `j-104467` at the same order and timestamp.

The agent's reply to that wake arrived at `13:28:05`. Its entry has a later id,
so its order is above `1_044_670_000` and the chip sorts before the reply. No
new entry, prompt or `jobNotice()` text was written for this: the chip appears
purely because the stored entry is rebuilt.

An old conversation that stored a job result as a plain `user` entry is
different. The transcript builder moves that entry to the activity row and
never paints a bubble for it, so no legacy job text is left in the chat.

## Reconnects

The chip is deduplicated by message id, and the activity row by its `j-` id. A
reload reads the snapshot, and a stream reconnect folds the same entry again;
either path yields exactly one chip per stored entry in the slot the entry's
order names. A live entry pushes its chip when it is appended, and placement
may push the same chip id again; the client replaces the chip instead of adding
a second one.
