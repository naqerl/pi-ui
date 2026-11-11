# Action-to-effect latency

Measured on the e2e backend with its fake model, Node v24, on one machine. The
script opens the SSE stream, sends one message to an idle agent, then creates a
proposal whose title starts with `SLOW`. The fake model holds that approval's run
for 60 seconds, so every number below is delivery on the change itself, not on
the model finishing.

`before` is `8739e53` (release 1.6.142); `after` is this change. Times are
milliseconds from the request leaving the client. `decision push` is the first
SSE `message.done` whose notice names the approved proposal.

The request numbers are warm-path: the server had answered `/api/health` and
the SSE stream had already reported `idle` before the timed request, which is
the state an operator is in when the composer is usable. A cold first
`/api/message` against a just-booted server measured 229–262 ms after and
229–235 ms before in an independent HTTP run (one 262 ms sample); that is
backend warm-up and is not attributed to this change. The table below is the
same-script warm before/after comparison.

| Step | Before | After |
| --- | ---: | ---: |
| idle send: POST acknowledged | 33.4 | 27.8 |
| idle send: run starts | 243.5 | 234.6 |
| idle send: assistant reply visible | 668.3 | 657.9 |
| approval: PATCH acknowledged | 5.4 | 12.9 |
| approval: tasks ledger pushed | 6.3 | 28.0 |
| approval: decision chip pushed | none before the 60 s run ended | 27.9 |
| approval: run starts | 29.8 | 27.9 |

## After, raw trace (ms since page start)

| Step | Start | End | Delta |
| --- | ---: | ---: | ---: |
| idle send request leaves the client | 2822.8 | 2854.0 (202 acknowledged) | 31.2 |
| acknowledgement → run starts | 2854.0 | 3060.8 | 206.8 |
| run starts → fake model reply pushed | 3060.8 | 3478.2 | 417.4 |
| approval request leaves the client | 7962.4 | 7977.3 (200 acknowledged) | 14.9 |
| approval acknowledgement → decision chip pushed | 7977.3 | 7996.1 | 18.8 |
| approval → decision chip / task ledger / run start | 7962.4 | 7996.1–7996.2 | 33.7–33.8 |

The 417 ms row is the fake model's streamed reply, not pipeline work. Every
queue, decision and push step after the acknowledgement is under 250 ms, and
the idle send→visible and approval→delivered paths are under 1 s.

## What the numbers found

1. **The approval chip had no push of its own.** `TaskDecisionEntry` (and the
   idle nudge) was projected by `buildTranscript`, but `message_end` only
   broadcast queue, steer, MCP, delegate and memory-delta entries. The chip was
   therefore visible only after the run it started finished and forced a state
   refresh, or after the client's slower fallback refresh. It now uses the same
   placed-entry push as the other notice chips. This was the long wait: with a
   held model the before number is the whole run, not a fixed timeout.
2. **An approval returned before its queue entry existed.** `TaskStore.announce`
   fired decision delivery with `void`. It now awaits the notice after saving
   the ledger, so the approval's queue entry is placed before the request
   returns. The two writes remain separate commits: a notice failure is logged
   and does not undo the task, so HTTP 200 means the ledger changed, not that
   the notice succeeded. The durable admission carries `decision:<proposalId>`
   as its request id, so a retry cannot place the entry twice.
3. **A failed run left its queue asleep.** Durable's default `afterFailedRun` is
   `keep`; queued inputs then wait for the next submission or an idle nudge.
   `ChatService` now wakes the drain on queue placement, on run end, on a settled
   queue item and when the quiet-run watchdog observes no live run. It submits
   one `continue`, sharing an in-flight drain and ignoring a run that started
   meanwhile. The idle nudge is no longer a delivery mechanism.
4. **SSE could be buffered by a proxy.** The stream now sends
   `X-Accel-Buffering: no`. The 20-second heartbeat remains only as a keepalive;
   a comment says it is not a state-delivery cadence.

## Checks

`npx tsc --noEmit`, `npx biome check src e2e`, `npx e2e run` for the touched
chat/task specs, and the unit suite, including a regression that an
early-returning drain cannot leave a stale in-flight guard. No dependency, tool
schema or colour changes.
