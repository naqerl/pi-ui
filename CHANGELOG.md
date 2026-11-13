## 1.6.157

### Changed

- The planning agent can propose a task for approval: a plan may end with a
  proposal the same way the main agent can, and it appears on the tasks page as a
  proposal until you approve or dismiss it.

## 1.6.156

### Fixed

- MCP events are deduplicated by stream generation and event id rather than by a
  cursor the daemon renumbers on restart, so a reconnect neither replays the old
  log nor swallows genuinely new events.

### Changed

- The e2e wall-clock guard allows 780 s: the browser suite grew from 233 to 279
  tests since the last bump and was failing green runs on the clock alone.

## 1.6.155

### Added

- Task cards show a `Planning` badge while a plan run is live, so work in progress
  is visible from the list and not only inside the task.
- The planning agent can ask structured questions (ask_questions /
  append_questions) and the answers appear in a panel in the plan chat.

## 1.6.154

### Fixed

- The chat keeps its reading position through a round trip to Tasks or Stats:
  coming back no longer shifts the transcript, so the message you were reading is
  still where you left it.

## 1.6.153

### Fixed

- A plan run that dies no longer goes quiet: the plan chat shows the run error
  and offers a retry, so a stalled plan is visible instead of looking idle.
- A cut event stream resumes at the last delivered cursor and reports one notice
  per durable id, instead of replaying the history it already showed.

## 1.6.152

### Changed

- The composer in the float footer stays put when you move between Chat and
  Tasks: the same field, the same size, no flash of a New-task placeholder or a
  solid dock. Empty and helper text over the background sits in a centered glass
  card like the composer itself.
- On a wide screen the open task's header is a thin Task details bar that uses
  the same chrome as a stats-page section, including the small close cross, with
  the kebab beside it. Title, status, project and created stay in the list;
  Rename and Change project are in the kebab. On a phone the last plan card keeps
  a one-gap gutter above the composer, and the header is unchanged.

## 1.6.151

### Changed

- Task details use a compact card layout. The header carries status, the short
  id, the project, and a compact created stamp; the title sits below it, and
  subtasks and the plan live on surface cards. On a phone the header is flush
  to the top of the screen, Plan and Chat are tabs with a foreground underline
  on the selected one, and the shared composer talks to the planning agent. On
  a wide screen the list, the plan, and the planning chat sit in three columns,
  and the composer stays in the same place as on the main chat page.

## 1.6.150

### Added

- The Tasks page creates work with a plus button instead of a list composer. Each new
  task opens its own planning chat: a dedicated agent that can only inspect the repo
  and edit that task's title, markdown body and project. The body uses the same
  markdown and mermaid rendering as the main chat, and follow-ups stay on that task.

## 1.6.149

### Fixed

- A proposal decision shows its result at once: the Dismiss/Approve row renders the outcome from the
  request the moment it is sent, and a late state snapshot no longer replaces it with the previous
  state before the server has confirmed.
## 1.6.148

### Fixed

- Task-card metadata stays inside the card: the times and the id chip truncate with a full-value
  title instead of overflowing, and the project name keeps its 40 % cap.
- The proposal approval row uses inline SVG icons for Dismiss and Approve instead of text glyphs, so
  it follows the theme like the rest of the UI.
## 1.6.147

### Fixed

- A sent message no longer blinks out of the transcript while the server confirms it: a state
  snapshot read before the send committed could rebuild the chat without the pending row.
- A late state snapshot or live frame can no longer undo a newer queue or steer change, because
  queue and steer updates now carry a monotonic revision.
## 1.6.146

### Fixed

- The task list keeps its scrollbar on the column edge, so a long title can no longer push it into
  the list content.
- A queued or approved message is delivered to the agent as soon as it can run, instead of waiting
  for the next nudge to pick it up.
- The working state, the activity list and run errors come from the server's own state rather than a
  client-side timer that could sit on stale information.
- A stream event older than the restore grace is dropped however it arrives, so a restored
  subscription cannot deliver history from before its own start.

## 1.6.145

### Changed

- The background-job queue and the notice chips use inline SVG icons instead of emoji glyphs, so
  they follow the colour theme and cannot appear as an empty square on a platform without that
  font.

## 1.6.144

### Fixed

- A status notice for a subscription this app does not track no longer reaches the chat, on the
  plain-text status channel as well as the JSON one, so a dead adapter generation stops announcing
  itself every couple of minutes.
- A reconnecting subscription resumes at the last delivered cursor instead of replaying from the
  restore point, so a reconnect no longer floods the chat with the history it already showed.

## 1.6.143

### Changed

- A task card now keeps its meta on one line at the bottom instead of stacking it down the right
  column, so long values cannot overflow the card.
- The `Needs you` header uses the same solid treatment as the other section headers (open, project),
  and the approval area follows it, so a pending approval reads as one block rather than a panel
  that looks like a different app.

## 1.6.142

### Fixed

- A send that is retried or re-delivered with the same client message id no longer becomes a second
  transcript row and a second turn: the placed entry is reused and the caller settles against it.
  One operator message had been answered seven times, each copy starting its own turn.
- A queue item that has been handed to the model is retired, so a harness restart cannot replay it.
- The desktop task detail no longer reserves a tall empty band above the description — the header
  gap is gone and the body starts where the title ends.

## 1.6.141

### Fixed

- A status notice for a subscription pi-ui does not track is no longer shown in the chat. The
  adapter keeps reporting a generation the app never subscribed to (typically one from before a
  restart) and every such notice started a turn; an unknown or superseded subscription now stays
  silent.
- The restore e2e stub now lists `flood-stream` in its `events/list` catalog, which is what
  `events/subscribe` validates against. The row used to stay pending forever because the follow-up
  subscribe failed on an unknown name, so 1.6.140's "start from now" path was never exercised by
  the suite.

## 1.6.140

### Fixed

- A restored MCP subscription is bounded by size as well as by age. The restore probe now asks for 25
  events instead of 100, and a hub that answers a page request with the full page is treated as stale,
  so it starts from now. A reconnect can no longer drain a four-day backlog into the chat queue, which
  is what produced the surge of queued events after the hub's events extension was fixed.

## 1.6.139

### Changed

- The e2e wall-clock guard allows 720 s instead of 660 s. A green suite with three Playwright
  retries measured 666 s and failed CI without a single failing test, so the guard was rejecting
  flaky-retry overhead rather than a slow suite.

## 1.6.138

### Changed

- Task list sections use a thin rule and a muted count instead of an inverted pill, matching the stats page.
  Task cards sit on a translucent, blurred surface so the page reads through them; the opened task keeps an
  opaque card instead of a ring, and backlog keeps its dashed, desaturated treatment.

## 1.6.137

### Fixed

- A restored MCP subscription no longer replays history. If the events it missed are older than a fifteen
  minute grace window, the stream starts from now and the missed window is reported once as a gap, so a
  restart can no longer pour days of backlog into the chat queue.
- A replay burst is capped and merged, so a reconnect delivers a bounded number of notices instead of one
  per event.

## 1.6.136

### Added

- `task_release`: the agent can move a `working` task back to `open` with a reason when the work is parked or the claim was wrong, so the badge stops claiming progress. The release is recorded as `releasedAt`/`releaseReason` and shown in the task details.

## 1.6.135

### Added

- A dashboard widget can be dragged from one section into another. The grid follows the pointer past a
  section heading, the widget keeps its own width, and a drop outside any section returns it to where it
  started instead of leaving a hole behind.

### Fixed

- Resizing the browser under a drag no longer leaves the dragged widget at the old pointer position.

## 1.6.134

### Fixed

- A status notice about a subscription that another live subscription has already superseded no longer
  reaches the chat. The notice is still ingested, so the feed stays truthful, but announcing the death of
  a generation the user is no longer using read as an outage that had not happened. A notice naming the
  live subscription itself, or one with no sibling at all, is still delivered.

## 1.6.133

### Fixed

- A restored subscription that found its stream only after paging the event catalog resumes from the
  position it recovered, instead of starting "in now" and silently skipping the window it just listed.
  The caller’s cursor still wins when one is supplied — a zero position still means "start in now" — only
  the no-cursor restore path falls back to the stored position.

## 1.6.132

### Fixed

- A subscription whose stored cursor is a zero position (`hub:0`) no longer replays the server's whole
  history on connect. `reopenSubscription` sends the cursor the caller chose and treats a zero position as
  "start in now" instead of falling back to another stored position, and a subscribe burst is bounded, so a
  reconnect costs one notice rather than a queue of them.

## 1.6.131

### Fixed

- A merged MCP burst that exceeds the notice text limit is split into bounded multi-part notices
  instead of one over-long chip that the e2e contract read as a false remainder. `submitMcpDelivery`
  keeps one identity per part (`<id>#<n>`), so a retry replays the parts a previous attempt did not
  commit instead of re-sending one coalesced blob.

## 1.6.130

### Fixed

- The MCP outbox queued one chat submission per event, so a busy hub turned into a queue of ~200
  pending deliveries (189 of them cancelled by hand). A burst is now folded into one waiting
  delivery: events are deduplicated by `server/name/eventId` across subscriptions, the batch is
  bounded at 50 with the older ones counted in the head ("N older events dropped from this batch"),
  and a gap-only batch adds its dedupe keys without queueing a second entry. Status and raw notices
  keep their own waiting item so they are never merged into an event envelope.
- Delivery is one item at a time instead of a batch of 50, which removes the source of a duplicate
  submission: an item already passed to `deliver()` stays protected until its removal write
  succeeds, so a failed removal retries the removal rather than re-submitting a text that has been
  merged with a newer event.
- A second subscription to the same server no longer replays what the first one delivered: the
  subscription store deduplicates by server, name and arguments and drops the stale record.


## 1.6.129

### Fixed

- The subscription registry merged the durable delivered-id list with what it already held, so the set
  could only ever grow: a list poisoned with ids from an older hub numbering came back on every write
  and every event was classified as a replay, which is why no MCP event chip appeared for days. The
  feed now owns that list outright (the newest record wins, and it may shrink). Removes the temporary
  diagnostic from 1.6.128.


## 1.6.128

### Added

- Temporary diagnostic: `seedDelivered` appends its inputs and the epoch decision to
  `/tmp/mcp-seed-diag.log`, so the last unknown in the silent-chip defect can be read instead of
  inferred. Removed once the cause is confirmed.


## 1.6.127

### Fixed

- The epoch check now resolves the cursor inside `seedDelivered` itself, from the startup record,
  the registry row or the live view, and refuses to trust a restored set when no cursor is known.
  Before, a caller that passed no cursor (the restore result) skipped the check entirely, so the
  poisoned set was re-seeded on every reconnect and no event chip could ever be produced.


## 1.6.126

### Fixed

- The stale-epoch guard only covered one of the three places that re-seed the durable delivered-id set
  (startup records, a late registry row, and the adapter's restore result). The restore path runs on
  every reconnect and re-filled the set with ids from the old hub epoch, so event chips stayed dead.
  All three now compare against the cursor they resume from.

## 1.6.125

### Fixed

- Type error in the stale-epoch guard shipped in 1.6.124 (`record.cursor` is `string | null`). No behaviour change.

## 1.6.124

### Fixed

- MCP event chips stopped arriving entirely once the hub renumbered its event ids (a reinstall or a
  state reset restarts the cursor numbering): the durable delivered-id set then held ids the new stream
  would never exceed, so every fresh event was classified as a replay and dropped without a chip. A
  restored set whose ids sit ahead of the cursor being resumed is now discarded as a stale epoch, so
  the stream is trusted again.

## 1.6.123

### Fixed

- An MCP event id leaves the delivered set only when a chip for it was committed, so a stream that is active, heartbeat-fresh and cursor-advancing can no longer deliver nothing: duplicates advance the cursor without consuming novelty, a `replayed: true` entry that was never chipped is chipped on the next drain, and a failed notice submission keeps its chip for retry.

## 1.6.122

### Fixed

- Dragging a dashboard widget no longer scatters the others: the layout the grid receives keeps its identity, the grid owns the layout while a gesture is in flight, a drag over an occupied cell is refused instead of displacing a chain, and the committed layout is clamped to 12 columns with overlaps pushed down.

## 1.6.121

### Fixed

- MCP event novelty is based on stable event IDs, never timestamps. Exact novel subsets cross an atomic on-disk outbox before cursor acknowledgment; failed persistence blocks later batches, failed submissions retry FIFO, and stable durable request IDs make retries/restarts idempotent. Busy events retain their queue/cancel identities and burst merging; idle replay is delivered in bounded batches.
- Restore resumes at the acknowledged cursor instead of dropping downtime. Heartbeat/status/list metadata cannot advance it. Provider replay-truncation warnings now become durable chat status chips, including warnings raised before the message sink is ready. The subscription watchdog removed in 1.6.120 stays removed.
- Task projects retain A–Z order with No project last even with backlog-only projects. The Open count agrees with root/group counts; project names and blocker explanations wrap instead of clipping.

### Performance

- Index task relationships/blockers once per ledger and reuse them for state derivation, row children and subtree totals. Existing Working/status precedence is unchanged and covered by randomized indexed-versus-original equivalence tests.
- Memoize the task page and historical message bubbles; batch draft paints per animation frame and coalesce snapshot refresh bursts with a trailing read. Full draft replacement remains replay-compatible without sending the same prefix twice in each SSE frame.

## 1.6.120

### Removed

- The MCP subscription watchdog. It polled every subscription every 15 s to prove the far end still
  knew it, and reopened a stream three heartbeats after silence. Both servers now answer a lost
  session loudly (`NotFound -32023`), and the runtime already re-initialises on that, so the
  watchdog was a second liveness mechanism guarding the same failure. A subscription that goes quiet
  is now reported as quiet rather than retried: one mechanism, one truth. `polledEventCursor` moved
  to `mcp-events.ts` because the model-facing poll path still uses it.

## 1.6.119

### Fixed

- MCP events reach the chat again. Two changes: the policy no longer drops an event because the
  server served it from a cursor (SEP-3415 dedupes by `eventId`, so the delivered-id set decides what
  is news), and a restored subscription now resumes with `cursor: null` — start from now — instead of
  replaying the backlog it missed while pi-ui was down. Events that happen during a restart are
  dropped on purpose; the stream is live again immediately.

## 1.6.118

### Changed

- Actualized the pi family: `@earendil-works/pi-ai` 1.3.0 → 1.5.0, `@earendil-works/pi-coding-agent`
  1.4.0 → 1.5.0 and `@earendil-works/pi-codemode` 1.4.0 → 1.5.0 (`pi-durable` was already 1.5.0).
  No source changes were needed: 360 unit tests pass, the server boots and serves /api/state.

## 1.6.117

### Fixed

- The e2e budget guard no longer fails a green run: a flaky spec costs a full Playwright retry,
  and the 600 s check turned 225 passed / 0 failed at 611 s into a red build. The guard now
  allows 660 s and prints the number it measured.

## 1.6.116

### Added

- The pi-ui update note is a card you can open: clicking it shows the changelog the agent was
  told about, in a sheet like the activity view, instead of leaving the text hidden from the
  operator. The note still reads as one line in the transcript.

## 1.6.115

### Fixed

- An MCP recovery notice ("session lost (http404), re-initialized, tool list refreshed") now
  travels as MCP status instead of an ordinary message, so the chat draws one chip rather than a
  queued bubble that reads like something the operator typed.

## 1.6.114

### Added

- Agent subagents: `acp_delegate`, `acp_delegate_wait` and `acp_delegate_cancel` run a task in an
  isolated context (reviewer, researcher, worker, planner, oracle) and report back as one chip with
  a result and an activity file, never as a bubble. Depth and concurrency are capped, every delegate
  has a hard timeout and can be cancelled.

### Fixed

- MCP connections survive a server restart: when a server no longer knows our session (HTTP 404
  `session not found` or JSON-RPC `-32600`), the call re-initializes, refreshes the tool list and is
  retried once, with one honest notice and an accurate status. A server that adds a tool while we are
  connected becomes callable without restarting pi, and a server that is down retries with backoff
  instead of staying dead for the process lifetime.

- `stats`: revert the sparkline width change from 1.6.107 — the y-axis keeps its gutter on the left instead of putting the ticks inside the plot, and sparkline cards go back to the standard `px-3` padding so their inset matches every other widget.

## 1.6.107

- `stats`: the sparkline fills its widget — the y-axis no longer reserves a left gutter for tick labels (they sit inside the plot, on the right) and sparkline cards use the narrower gutter, so the plot reaches the card's inner edge. `qiu9`.

## 1.6.106

Widgets moved and resized with hand-written pointer math, and collisions were resolved only
after the drop, so a card teleported on release. `react-grid-layout` was already a dependency
but only its class names were used.

- Each dashboard section is now a `GridLayout` (`cols: 12`, `rowHeight: 44`, `margin: [12,12]`,
  `compactType: null`, `preventCollision: false`), so the grid makes room during the gesture.
- The grip is the drag handle; `draggableCancel` excludes buttons, links, inputs and
  `[data-no-press]` so the click animation and the composer keep working.
- Width stays continuous while resizing and snaps to 4/6/12 on release, with `w` and `span`
  derived from one another; one layout write per gesture instead of one per pointer event.
- `packLayoutSlots` is now a server-side sanitiser and the default-board builder, not a per-frame
  pass; it still rejects overlapping stored layouts.
- Grip and resize corner take `touch-action: none`, card bodies keep `pan-y` so page swipe works.

## 1.6.105

The browser suite was 621 s against a 600 s budget. Four specs accounted for 405 s of it,
and most of that was boot: a fresh `app.open()` starts a new browser context, which takes a
new proxy shard, which boots a backend — 7-9 s per test.

- `e2e/chat.e2e.ts`, `e2e/stats.e2e.ts`, `e2e/mcp-events.e2e.ts` and `e2e/stats-grid-touch.e2e.ts`
  now share one app instance per serial group, swapping state through the existing `browser.route`
  mocks and `/api/state` reloads instead of paying for a boot per test.
- Tests that must see a fresh process keep their own app and say so: ledger seeding, restart and
  kill, first-paint, and reconnect/persistence.
- No assertion was weakened, no test removed and no `waitForTimeout` introduced — the four files
  keep the same test counts (15, 6, 8, 11) and the same `expect` counts.

## 1.6.104

- **Memory writes no longer rewrite the system prompt.** A long-term topic write is announced as one compact tail delta (topic, title, size, date, and a pointer to `memory_read`); the injected snapshot is only rebuilt when the prompt is rewritten anyway — first turn, day rollover, compaction. Daily and scratchpad writes change nothing, as before.

## 1.6.103

- Approving or dismissing a proposal now applies to the ledger and repaints the row immediately; the decision is delivered to the model as a queued notice once the agent is free, instead of holding the request open until the running turn ends.
## 1.6.102 - 2026-11-05

- fix(chat): the stick-to-bottom hook re-pinned `scrollTop` on every scroller resize, and the
  composer’s 220 ms height animation resizes the scroller on every frame — so the transcript was
  dragged to the dock’s moving edge and the composer appeared to slide over the last messages
  instead of moving them up. `sync()` now separates the two events: content growth pins an attached
  reader as before, a shrinking viewport pins it back to the end so the expanding dock pushes the
  transcript up with it, and a growing viewport is left to the browser’s own clamp. The scroll
  handler detaches only on an upward reader scroll, so a transient resize distance cannot turn the
  pin off mid-animation.

## 1.6.101 - 2026-11-05

- fix(chat): the submit gate matched only the literal `MCP event data follows.`, so every other MCP
  notice — subscription status, and any payload that did not parse — fell through to `chat.submit`
  and arrived as a full message bubble with raw JSON in the transcript. Routing now asks the shared
  `isMcpNotice` predicate, keeping `dropMcpEventsBefore` for event batches; an unparseable payload
  becomes one `/mcp` chip whose details hold the raw text. The model-facing text (preambles, status
  text, payloads, trailer) is unchanged byte for byte.

## 1.6.100 - 2026-11-04

- test(e2e): 7-9 s of every browser test was `app.open()` — a new browser context gets a new proxy
  shard, and the shard boots a fresh backend. `pager-hscroll` now shares one serial-group app (each
  member swaps the `**/api/state**` route and refreshes), and so do the nine mocked
  `tasks-detail` tests. `pager-hscroll` 104 s → 43 s wall, `tasks-detail` 152 s → 88 s. The four
  tests that seed the real ledger through `POST /api/tasks` keep their own fresh boot on purpose.

## 1.6.99 - 2026-11-04

- test(stats): the 250 s unavailable-row test was not slow assertions — it was the e2e shard
  proxy's 240 s health deadline plus the retry. The test now boots a backend of its own, mocks
  `/api/dashboard` with the default built-in board and stubs `/api/stream` before navigation, so the
  empty MCP row and the four `dd` values come from the fixture. 250.17 s in CI becomes 3.1 s, the
  file 45 s, five consecutive runs green.

## 1.6.98 - 2026-11-04

- test(e2e): two specs no longer sample the UI once and hope. `pager-hscroll` polls for a mounted, laid-out code block (and for the page to become `tasks`) before dispatching a gesture, and `task-projects` polls for exactly one visible match of each task title so a transient optimistic duplicate cannot make the query ambiguous, then polls the project-group order until the server ledger settles. Assertions are unchanged; five consecutive local runs of both files passed 14/14 at 109-111 s.

## 1.6.97 - 2026-11-04

- fix(jobs): keep the index write safe for two managers and isolate the job-store
  tests. The temporary file was named after the process rather than the writer, so
  two managers on one data directory renamed each other's half-written file — the
  `ENOENT ... jobs.json.<pid>.tmp` in CI — and writes were serialised per manager
  instead of per index path. Temporary names now carry a write counter, every write
  on a path is chained, and a failed write removes only its own temp file, leaving
  the previous index intact.
- test(jobs): every job-store test gets its own data directory, so a manager can no
  longer adopt a job left running by an earlier test and notify the wrong test when
  it ends (`expected [] / actual ['j2']`). A two-manager case proves a concurrent
  save from each survives a fresh load.

## 1.6.96 - 2026-11-04

- test(e2e): stop the two specs that failed on 1.6.94 from failing on timing.
  The MCP-events widget test installed its `/api/state` mock _after_ the first
  page had already fetched it, so whether three rows appeared depended on a
  later refresh landing inside the assertion window; it now installs the route
  before the stats reload, retires any in-flight fetch through the existing
  focus refresh, and polls the row count until it is exactly 3. The composer
  test asserted a fixed 300 ms settle against a 220 ms transition and could
  sample a mid-animation frame on a loaded runner; it now polls the body height
  on both sides of each switch and still requires the resting height within
  0.5 px. Five consecutive runs each: dashboard 69.2-72.4 s, stats 86.9-91.7 s.
  No product code and no test-only hooks (t6vc).

## 1.6.95 - 2026-11-04

- fix(pager): a swipe that starts on a widget card now changes the page for good. 1.6.93 made cards stop claiming the gesture, but the rule underneath still handed **every leftward touch** to any horizontally scrollable element without asking whether it could still scroll — at its right edge it could not, so the gesture was dropped and swipes worked only on empty background. The hand-off is now edge-aware per direction (`scrollLeft + clientWidth < scrollWidth - 1` leftward, `scrollLeft > 0` rightward), `data-hscroll` surfaces still always own their gesture, and a sub-pixel overflow no longer turns a card into a gesture sink (km8w).

## 1.6.94 - 2026-11-04

- fix(tasks): a single tap on a task card opens its details on a phone. The menu-scoped click suppression now remembers which pointer sequence it belongs to and expires, a plain tap no longer cancels its own click, and the detail survives the history state it pushed itself (ye5r).

## 1.6.93 - 2026-11-04

- feat(dashboard): a task duration widget showing p50, p90 and the average time between a task being created and completed (vc85).
- fix(stats): a swipe that starts on a card now pages the dashboard instead of being eaten by the widget (km8w).

## 1.6.92 - 2026-11-04

- feat(ui): every control answers a press with a compositor-only scale (0.97) under `prefers-reduced-motion: no-preference`, with a `data-no-press` escape hatch for drag handles and resize corners; the rule is written into AGENTS.md (uroi).

## 1.6.89 - 2026-11-04

- test(tasks): poll for the create request the optimistic task card precedes, instead of reading the route counter once and racing the fetch on a loaded runner.

## 1.6.88 - 2026-11-04

- fix(dashboard): the grid specs seed the five-widget board they patch, so the layout endpoint no longer rejects a widget the reset had just tombstoned (69rjb).
- fix(composer): C-j focuses the composer on the tasks page instead of paging to chat, keeping the draft and the caret (bmk3).

## 1.6.87 - 2026-11-04

- feat(dashboard): every builtin widget source now goes through the same registry as poll widgets, with a committed default board, tombstones for deleted widgets and a reset that restores the default (69rj).
- fix(durable): detect and repair a torn live document instead of failing the turn, plus a `durable-doctor` CLI to inspect and heal one by hand (3zed).
- fix(e2e): restore the five specs 1.6.86 broke — the widget counts and the theme polls — so CI is green again (xfw2b).

## 1.6.86 - 2026-11-04

- feat(stats): drive plot and status colours from the theme palette, so charts follow the active theme instead of fixed hues (xfw2).
- test(e2e): consolidate the browser suite from 43 files to 24, moving shared cases into themed siblings (e2e2).

## 1.6.85 - 2026-11-04

- feat(tasks): reopen a finished task with a required reason, count reopens and show the ↻ badge (i59h).

## 1.6.84 - 2026-11-04

- feat(memory): `memory_grep` (keyword/regex over topics, MEMORY.md, SCRATCHPAD.md and recent dailies) and a line-ranged `memory_read`, so a memory lookup costs lines instead of whole documents (mgv2).

## 1.6.83 - 2026-11-03

- feat(memory): memory_write can append to a long_term topic instead of rewriting it (k4ec).

## 1.6.82 - 2026-11-03

- test(chat): judge the scroll-pin sampling window by elapsed time and a handful of frames, so a busy CI runner stops failing it (pinb).

## 1.6.81 - 2026-11-03

- fix(mcp): drop restored subscriptions the server no longer knows, and drop backlog from a stale cursor (mbav).
- chore(deps): upgrade pi-durable to 1.5.0 (u4j7).

## 1.6.80 - 2026-11-03

- feat(chat): alt-1/2/3 jump to a page and ctrl-j focuses the composer (8g7p).

## 1.6.79 - 2026-11-03

- fix(stats): pin the chart crosshair on a real click instead of a synthetic pointer, so the e2e suite is green again (xhair2).

## 1.6.78 - 2026-11-03

- feat(chat): preview a task from its 4-character id and open it on click (c3fc).

## 1.6.77 - 2026-11-03

- feat(tasks): create tasks directly and paint them before the response (2div).

## 1.6.76 - 2026-11-03

- test(chat): assert the memory chip outcome instead of the optimistic id, so the e2e suite is green again (mchip).

## 1.6.75 - 2026-11-03

- feat(stats): click a chart to pin a crosshair, its dots and the values at that point (xhair).

## 1.6.74 - 2026-11-03

- feat(dashboard): a sparkline can map its headline to an explicit value instead of the derived last point (hetz).

## 1.6.73 - 2026-11-03

- perf(chat): the thread scrolls itself, so the composer stops reflowing it (lift).
- fix(chat): clear the composer when the bubble is painted (cwb1).
- refactor(stats): drop the section button and drag grip, hold to drag (n7yg).

## 1.6.72 - 2026-11-03

- refactor(stats): drop the tokens footnote (4hh4).

## 1.6.71 - 2026-11-03

- feat(theme): drive status colours from theme tokens (eeyz).

## 1.6.70 - 2026-11-03

- perf(chat): the pending bubble is painted before the server round trip and reconciled by client key, marker writes are coalesced per tick, and submit timing is measured (fej6).

## 1.6.69 - 2026-11-03

- feat(tasks): the section chevron sits before the task count, matching the block headers above it (9eky).

## 1.6.68 - 2026-11-03

- fix(tasks): the backlog badge gets a filled background instead of the only outline badge on the page (8efd).

## 1.6.67 - 2026-11-03

- feat(stats): the dashboard becomes a composable grid — widgets drag, resize and group into sections, layout persists through the same `dashboard_layout` payload the agent writes, and mobile keeps the single-column stack (w3mg).

## 1.6.66 - 2026-11-03

- `sops` is pinned to 3.13.3 and its SHA-256 is verified before the binary is installed, so a re-tagged or tampered GitHub release cannot enter the image; `pinentry-curses` is installed alongside `gnupg` so a passphrase-protected key has a prompt when a terminal exists.
- The image's GnuPG home is now documented and wired: `/home/pi/.gnupg` is an optional read-write mount (`GNUPGHOME_DIR`, default `~/.pi-ui/gnupg`). It cannot be the host's live `~/.gnupg` — GnuPG 2.4 writes a keybox (`pubring.db`) that bookworm's gpg 2.2 cannot read, and two live agents would share one socket. The README's new **SOPS and GPG keys** section exports a key on the host and imports it into that home with one throwaway container; `docker-compose.yml`, the `docker run` example and the mount table carry the same change.

## 1.6.65 - 2026-11-03

- chore(image): ship `gnupg`, `age` and the `sops` binary in the runtime image so the agent can decrypt SOPS-encrypted secrets; no key material is baked in.

## 1.6.64 - 2026-11-03

- feat(dashboard): a general chart spec — multiple series with their own colour, type and dash style, x labels, a formatted y axis, a legend and reference lines; the old five-key sparkline input still renders (kab7).

## 1.6.63 - 2026-11-02

- test(tools): reject tool schemas the model provider refuses — the tuple schema that broke every request is now a lint test (g8ix).

## 1.6.62 - 2026-11-02

- fix(tools): describe the sparkline chart yDomain as a two-number array instead of a JSON-schema tuple, which some providers reject with "Invalid schema for function 'dashboard_upsert'".

## 1.6.61 - 2026-11-02

- feat(stats): render sparkline widgets with shadcn charts and an optional chart config (23va).

## 1.6.60 - 2026-11-02

- fix(ui): a horizontally scrollable code block or diagram keeps its own gesture; the pager only takes over when the block has nowhere left to scroll (8mq6).

## 1.6.59 - 2026-11-02

- feat(ui): vibrate on user mutations (approve, send, task actions, settings) through one haptic helper that respects prefers-reduced-motion (7q9g).

## 1.6.58 - 2026-11-02

- test(nudge): assert the actualize wording that 1.6.55 shipped, so the unit job stops failing.

## 1.6.57 - 2026-11-02

- feat(nudge): ask for a memory write after a task was closed (ss3u).

## 1.6.56 - 2026-11-02

- fix(chat): animate the composer body height instead of snapping the grid at the end of the slide (shgf).
- refactor(tasks): attribute tool calls to the working task instead of a piuiTaskId argument (om9j).

## 1.6.55 - 2026-11-02

- feat(nudge): ask the agent to actualize stale working tasks as well as new work (mnok).
- fix(chat): mark MCP notices as non-messages and drop assistant echoes (4bwv).

## 1.6.54 - 2026-11-02

- feat(chat): show a memory-search chip with hit counts, one chip per turn (2r8i).

## 1.6.53 - 2026-11-02

- fix(chat): the whole composer slides on page switch, not only its text (por2).
- refactor(tasks): drop the metrics table from the task detail view (gaba).
- feat(tasks): tell the model when a proposal is approved or declined (uixu).
- fix(tasks): one consistent gap between headers and cards (h7oi).

## 1.6.52 - 2026-11-02

- feat(composer): the active page marker is a small square instead of a long line, page switches animate and buzz once, and the back button closes a task detail instead of leaving the app (2co6).

## 1.6.51 - 2026-11-02

- test(display): keep the done-group fixture inside today so the browser suite cannot flake around midnight (tdfl).

## 1.6.50 - 2026-11-02

- feat(mcp): deliver a burst of queued MCP events as one message, so a flood arrives as one notice (kfgp).

## 1.6.49 - 2026-11-02

- feat(tasks): edit the title and body in place, the title control growing with its content instead of collapsing into a one-line input, saving on blur (arwn).

## 1.6.48 - 2026-11-02

- test(jobs): poll for job output instead of sleeping, so the unit job stops failing on a slow runner (jfla).

# Changelog

Notable changes to pi-ui. Each `## <version>` section lists what changed in that release, newest first. On start, pi-ui compares its version with the last one it ran (`DATA_DIR/version.json`) and, after an update, hands the agent the sections it has not seen yet.

## Unreleased

## 1.6.47 - 2026-11-01

- Project names come only from open tasks, project headers use the solid Open header background, and the project line sits above the task body.
- The task id moved to the top right of the card, the activity table is gone from the detail view, and the task_working tool now exists so the idle nudge names a real tool.
- The composer animates on the compositor instead of layout, and the operator notice glyph is neutral with no push on an approval.

## 1.6.46 - 2026-11-01

- The browser suite now runs in parallel and finishes in minutes instead of an hour: several app shards per box, workers derived from the available CPUs, and CI fails when the suite exceeds ten minutes.
- The tasks e2e file was split into views, body, title and project specs so one change no longer re-runs a thousand lines.
- Shard startup was hardened for concurrent load, which is what made the parallel run flaky at first.

## 1.6.45 - 2026-11-01

- The Active / Blocked / Proposed filter row is gone from the tasks list: every task renders in one list under its state heading, so the counts no longer squeeze the working status, and on a narrow window nothing scrolls sideways any more.
- Two e2e assertions that failed on `main` now match what the app renders: the HH:MM chips and the history page structure.

## 1.6.44 - 2026-11-01

- The task detail lost its activity table, and the backlog toggle now sits where that table was, so a task opened from the list shows what it is for and what state it is in without a scroll.
- A queued MCP notice chip has a blurred translucent background, so its text stays readable over the moving background before the event reaches the model.

- A task that has received a tagged tool call keeps its Working badge after the run ends, instead of dropping back to ready at the end of the turn or after ten quiet minutes. The ledger now stores `lastWorkedAt`, so the badge also survives a restart, and closing or reopening the task clears it.
- A working task untouched for over an hour keeps its badge but gains a small muted `stale` marker, and the idle nudge names those tasks and asks the agent to confirm the work, block it, or mark it done. Stale requests are appended to the remembered idle decision prompt, so the same backlog stays quiet until it changes.
- The Active / Blocked / Proposed task filters moved from the composer's top line to the top of the task list, where they scroll with the list instead of squeezing the working status; on a narrow window the row scrolls sideways rather than wrapping its counts.
- A long press on the tasks page's Send button parks the next task in the backlog: the composer shows a Backlog chip and muted placeholder, a second long press (or Escape, a pointer move, or releasing early) cancels, and a short press still creates a normal task.
- Backlog tasks stay out of the way on the tasks page: their cards are blurred and desaturated, they sort after live work in their project, a project with only backlog tasks sits at the end, and they do not count in Active, Blocked or Proposed.
- The agent's ledger tools hide backlog tasks from `task_list`, counts and reports, and `task_view`, `task_edit`, `task_done` and `task_block` refuse a backlog id as unknown.

## 1.6.43 - 2026-11-01

- Task cards carry the 4-char id beside the title and move their status actions into the card menu, so the row no longer opens a menu by accident.
- Idle nudges became a remembered per-task decision protocol: the agent marks a task working, blocked or ignored, a working task is asked for a status update at most once an hour, and an ignored task returns only after three nudges.
- A task marked working keeps its badge until it is finished, and a task with no tool activity for an hour is added to the next nudge so its status is re-confirmed.
- The active/blocked/proposed filters left the composer for the task list itself, which now owns the filter row on every screen size.
- A task can be created as hidden backlog by long-pressing Send: it parks at the end of its group with a blurred background and stays invisible to the agent until it is promoted.

## 1.6.42 - 2026-11-01

- Opening the chat now hydrates the conversation immediately instead of requiring a page switch: the first paint waits for one real state fetch, a failed fetch keeps the last state and retries with backoff, and the page refreshes again when it becomes visible or the app regains focus.
- A task's working status survives a reload: the Working badge stays until its run reaches a terminal outcome or the task closes, and a snapshot that omits the run activity no longer clears a badge that was already shown.
- A live run that has made no tool call for an hour gets one status-check nudge per task, asking whether it is still in progress, done or blocked and to update the ledger; it is a notice chip and never fires for a terminal, blocked or waiting run.

## 1.6.41 - 2026-11-01

- The MCP subscription is watched for silence: after 60 seconds without a pushed event or heartbeat it is reported as stalled, re-subscribed from the cursor the server last returned, and reported as dead when two recoveries fail to restore traffic. A dead or muted stream is no longer shown as "active".
- Every MCP subscription exposes its connection state (`active`, `stalled`, `recovering`, `dead` or `cancelled`) through `/api/state`, and the MCP status card and the events page show a stalled or dead subscription in the warning colour with its reason.
- MCP cursors are opaque server truth: the cursor a poll returns is persisted even when the replay is truncated or empty, and a lower or differently shaped cursor is never replaced by a remembered one. `lastEventAt`, `lastPollAt`, `lastError` and `lastErrorAt` are recorded per subscription, while poll replies never reset the silence clock.
- A successful MCP protocol connection clears every previous failure for that server, so a server that recovers is no longer reported unavailable from the boot probe.

## 1.6.40 - 2026-11-01

- A task body renders as Markdown in a scrollable, height-limited area inside the detail card, so a long description no longer stretches the page.
- On desktop the first task of the current filter is selected as soon as the list arrives, and the detail stays open beside the list without a close button; mobile still opens details only when tapped.
- Task cards show the short 4-char id badge again, on open and done rows, and no longer carry a checkbox; done and reopen stay available in the task detail.

## 1.6.39 - 2026-10-31

- A queued MCP event is now a machine chip, not a bubble: the events that arrive while a turn is running are submitted as notices, so their raw payload never appears in the chat as something you said.
- The queued chip is readable and matches the chip it becomes — same glyph, same mono label, transparent background instead of faded text — and a burst of notices is one chip showing how many are queued, whose cancel button removes them all.
- The cancel test in e2e/jobs.test.ts waits for the job events instead of guessing at timings, so the suite no longer fails at random.
## 1.6.38 - 2026-10-31

- An MCP event subscription that died after a restart no longer reads as "active" forever: a stalled stream is reopened (or replaced) instead of silently delivering nothing, and a subscription that never delivers is reported as dead rather than healthy.
- A machine notice that arrives while a turn is running is rendered as a transparent chip in the chat instead of a bubble, so a queued job no longer looks like something you said.

## 1.6.37 - 2026-10-31

- A task can be edited in its detail view: title, body and project are now settable there, with an empty title refused and a project picked from suggestions.

## 1.6.36 - 2026-10-31

- The Active / Blocked / Proposed filters moved onto the composer's top line, the selected filter and the Open header share one dark pill with the count on the right, the Done header is gone and closed tasks are grouped into "Done today", "Done yesterday" and per-date sections with their own counts and chevrons.

## 1.6.35 - 2026-10-31

- Approving or declining a proposal now reaches the chat and the phone: an approval pushes "Proposal approved" and appends an operator notice, a deleted proposal pushes "Proposal declined", and a decision inside the burst window replaces that task's pending "New proposal" entry instead of adding a second one.

## 1.6.34 - 2026-10-31

- Task cards show when they were created at the bottom right and when a done task was closed.

## 1.6.33 - 2026-10-31

- Chips and timestamp rows show `hh:mm` only. The `seconds` option is gone from `formatTime`, so the MCP-event chip, the events page and the notifications row agree with message bubbles.
- Task cards show when they were created at the bottom right, and when a done task was closed; the detail header keeps the long form.

## 1.6.32 - 2026-10-31

- The Tasks page drops the "Working on …" line; a running task shows its Working badge in the list.
- Projects are set only with `@name` in a new task's title (autocomplete as before; the token is removed from the title). The composer's Project select, the "New project…" input, the project filter next to the tabs and the remembered last-used/filter default are gone: without `@` a top-level task has no project, and a subtask takes its parent's.
- Open tasks are always grouped by project in collapsible sections with a count, A–Z, "No project" last, once any task has a project. The task detail shows the project as plain text.

## 1.6.31 - 2026-10-31

- Tasks can carry an optional project. It is stored in the ledger, accepted by the API (`project` on create and update, `null` clears it) and by the agent task tools; names are reused case-insensitively and subtasks inherit their parent's project.
- Fast tagging when adding a task: the composer on the Tasks page has a plain Project select (with "New project…"), and typing `@name` in the title opens an autocomplete (arrow keys, Enter/Tab or tap to accept, Esc to dismiss). An unknown name creates the project, and the `@token` is removed from the title.
- The default project for a new task is the parent's, then the active filter, then the last one used, else "No project".
- The task list has a project filter (All projects / each project / No project) that also sets the default. Under "All projects", open tasks are grouped into collapsible project sections with a count, "No project" last. The task detail has an editable Project line.

## 1.6.30 - 2026-10-31

- Ledger notifications coalesce: a burst of proposals and completions arrives as one push ("3 tasks updated") instead of one per task, a repeat of the same task inside the burst is mentioned once with its final status, tagged notifications now pass `renotify: true` so a replacement actually alerts, and a pending burst is flushed on shutdown instead of being dropped.

## 1.6.29 - 2026-10-31

- The Tasks page is simplified to plain shadcn-style primitives on theme tokens: each row is a checkbox, the title, an optional status badge (Working, Blocked, Failed, Proposed, Done) and an optional muted one-liner such as "Blocked by …" or "2 of 4 subtasks done". No glyph boxes, mono uppercase labels or dashed/struck-through tricks; rows, badges and buttons are vertically centred and action labels like "Block" never truncate.
- The Now card is now a single line ("Working on …"), shown only while something is running. The Untracked line and its counting are removed; `piuiTaskId` tagging and measured stats stay.
- Finished work is grouped by day under Done: Today is expanded, then Yesterday and dates like "Thu, Oct 29" as collapsed sections with a count. A week of days is shown at first, with "Show older days" for more. The separate Done filter is gone.
- The task detail is a minimal card: title and badge, created/closed time, measured stats as label/value pairs, blockers and subtasks, and a short history grouped by day.

## 1.6.28 - 2026-10-31

- Tasks show what is actually happening instead of what the agent remembered to mark. Each task gets one derived display state (working, ready, blocked, needs you, failed, done) from the ledger plus measured activity: tool calls tagged with `piuiTaskId` attribute runs to a task, so a task the agent is working on shows as working even if it was never marked in progress, and a long call in flight keeps it working and counts its time.
- Work without a task is visible too: untagged tool calls are summed into an "Untracked" line on the Now card.
- Time, tokens and cost per task are measured from its runs (rolled up over subtasks) rather than reported by the agent; completion keeps only the evidence.
- The Tasks page is reworked: slim rows grouped into Needs you / Active / Done today with filter chips, a Now card listing the tasks being worked on, and a task detail with state, rationale, blockers, attachments, measured stats and a short run history — no tool-call lists. On desktop the detail opens beside the list. Everything uses theme tokens and radii, and states stay distinguishable in monochrome themes.

## 1.6.27 - 2026-10-31

- A test run can no longer reach live data or a real push endpoint: `npm test` runs through `scripts/run-tests.mjs`, which puts `DATA_DIR`, `PI_MEMORY_DIR` and the XDG roots inside a temp tree and forces `NODE_ENV=test`; the server refuses to boot with a live data dir in test mode, and the push service throws and logs instead of delivering to a non-allowlisted endpoint. The lockfile also repairs `npm ci --dry-run`.

## 1.6.26 - 2026-10-31

- A message sent while a run is active now shows up immediately as a queued bubble with its own cancel control, instead of appearing out of nowhere when the turn ends: the pending list comes from the server queue, so it also survives a reload, and a placed message keeps its id instead of being replaced. A page left open across a server restart no longer goes silent — `onopen` resets the stream revisions and a snapshot with a lower counter is adopted, so deltas are applied again while out-of-order ones are still dropped.

## 1.6.25 - 2026-10-31

- The idle nudge now ignores work that cannot legally be picked: a task whose `blockedBy` names an open task no longer counts, and the notice names the blockers instead of demanding a pick.
- Nudges fire once per task set. The set of unblocked open task ids is hashed and recorded in `data/idle-nudge.json`, so the same backlog cannot nudge twice, not even across a restart; a new task or a task becoming unblocked earns exactly one nudge. A corrupt record is ignored rather than breaking startup, and the hash is only written after the nudge was actually submitted.

## 1.6.24 - 2026-10-31

- MCP event notices are coalesced: a burst of hub events arrives as one chip instead of one notice per event, repeats of an already delivered `eventId` are dropped, and a long run no longer fills the chat with `hub.run` frames.

## 1.6.23 - 2026-10-31

- Maintenance release with no user-facing change.


## 1.6.22 - 2026-10-31

- Push notifications go out only when the agent asks for them: the new `notify_operator` tool sends a title, body and reason to the operator devices, and the request shows as a ✉ chip in the chat. Assistant replies no longer push.

## 1.6.21 - 2026-10-31

- Diagrams open full screen: a viewer over the chat with zoom (wheel, buttons, pinch) and drag-to-pan, keyboard escape to close, and the inline diagram keeps its own scroll container.

## 1.6.20 - 2026-10-31

- nudge the agent after 20 idle minutes when work is open


## 1.6.19 - 2026-10-31

- compact notifications row with the toggle on the right


## 1.6.18 - 2026-10-31

- Durable MCP subscription ids that survive a restart: the registry keeps the subscription id and cursor, so a restarted server resumes the same stream instead of opening a new one.


## 1.6.17 - 2026-10-31

- Proposed tasks come first on the tasks page, above ready work: each proposal shows its title, a clamped rationale, when it was proposed and the approve/dismiss actions.
- A task opens in a full-screen modal (a rounded card with a margin so the animated background stays visible) with its description, blockers, the completion report and the created/closed times; the card buttons do not open it.
- Task cards carry `created …` and, once done, `closed …` in the reader's local time zone.
- Writing a memory shows a chip in the chat; tapping it shows the file and what was written, with an Undo button that sends a steer asking the agent to restore that file.
- Web push now also fires on a new proposal and on a finished task.

## 1.6.16 - 2026-10-31

- A failing model no longer holds the chat: the turn gets three attempts in all (two retries, one to five seconds apart instead of durable's default three retries with a minute-long ceiling), and when one turn has spent two and a half minutes retrying it is stopped with a line in the chat and the next queued message starts straight away. Before, a provider that kept failing left every message sent behind it waiting, sometimes for hours. `PI_RETRY_MAX`, `PI_RETRY_BASE_MS`, `PI_RETRY_MAX_DELAY_MS` and `PI_RETRY_BUDGET_MS` override the numbers.
## 1.6.15 - 2026-10-30

- Web push notifications: enable them from the settings row and the PWA shows a system notification when an MCP event, a background job or an interrupted run lands while the app is not in the foreground. The worker stays silent when a window is focused, the server keeps subscriptions in `DATA_DIR/push-subscriptions.json` with a VAPID key pair in `DATA_DIR/push-vapid.json` (mode 0600), and a `404`/`410` from the push service drops the dead endpoint instead of retrying forever.
## 1.6.14 - 2026-10-30

- The interrupted-run note only appears when the run actually left something behind: nothing is written for a run that produced no partial reply and was not stopped, and the chip promises a resume only when one will happen.
## 1.6.13 - 2026-10-30

- The interrupted-run note is a warning chip like the MCP and job notices, in amber, and it states whether the run was interrupted or stopped.
- The settings button in the composer dock has no border or background and lines up with the send button.
- The working row says `thinking` while the model is thinking and `working` otherwise, so a thinking spell no longer looks like a running command.
- The fast-model reply summary and its expand control were removed; replies render in full.
## 1.6.12 - 2026-10-30

- `propose_task` lets the agent write down a task it thinks is worth doing without pretending it is one: a proposal is stored as `proposed`, stays out of `task_list` (which reports only `proposals: N waiting for approval`), and `task_proposals` lists it with its rationale. A human approves it into an open task from the Proposed section of the tasks page, or dismisses it.
## 1.6.11 - 2026-10-30

- `task_done` now requires a completion report — time spent, tokens spent and evidence a reviewer can check (a commit, a path, or a sentence) — and the ledger shows the completion time plus `· ~25m · 120k tok` on a done card and in `task_view`. `PATCH /api/tasks/:id` enforces the same contract.
## 1.6.10 - 2026-10-30

- The agent can draw a diagram into the chat with `draw_diagram` and revise it in place with `replace_diagram`: diagrams are stored under `DATA_DIR/diagrams`, a message carries only `{id, revision}`, and an invalid source renders as an error card rather than a blank. Rendering is bundled through `pele`, so a drawing needs no network.
## 1.6.9 - 2026-10-30

- The composer's run status is the animation plus the word `working`: the elapsed timer and the `no output for …` text are gone, along with the interval that re-rendered the dock every second.

## 1.6.8 - 2026-10-30

- Timestamps are UTC on the wire and local on screen through one helper, so an MCP event shows the same clock in the chat notice and in the `MCP events` widget instead of two.

## 1.6.7 - 2026-10-30

- MCP event subscriptions survive a restart: the registry is persisted under `data/mcp-subscriptions.json`, restored at boot **from its stored cursor**, and events at or below that cursor are dropped instead of replayed. A pure replay no longer changes the feed or wakes a turn; a mixed delivery reports `replayed N event(s) … skipped`.
## 1.6.6 - 2026-10-30

- The mobile PWA paints the home-indicator row in the app theme, in light and dark: the manifest colours and the `theme-color` meta follow the theme, and a themed blocker sits behind the dock so the platform never draws its own white band.

## 1.6.5 - 2026-10-30

- A steer stays visible from the moment the server accepts it until the turn that consumed it produced a real message: it renders as a pending bubble, turns into the transcript entry atomically, and reports a drop instead of disappearing.

## 1.6.4 - 2026-10-30

- The floating header is gone. Run status, the page indicator and the settings menu now share one row on top of the composer dock — active runs keep the working indicator, an idle chat says `idle`, and the `pi` label became a bordered gear button with the same popover. The dock and its navigation row stay visible on the stats page (only the composer body collapses, hidden and inert), and the header's clearance measurement and the working-strip slide styles are deleted.
- The image ships `openssh-client` (`ssh`, `scp`, `sftp`, `ssh-keygen`, `ssh-keyscan`) and creates `/home/pi/.ssh` at mode 700, so the agent's bash tool can reach other machines instead of only this one. No identity is baked in.
- `docker-compose.yml` and the README's `docker run` example mount one file read-only: the SSH private key at `/home/pi/.ssh/id_ed25519`, the name `ssh` uses by default. `SSH_KEY_FILE` overrides the source path. The mount is optional — without it the container simply has no identity — and read-only stops the container rewriting or rotating the key, not using it.
- The README explains the parts the mount does not cover: `known_hosts` and `config` are not mounted, so an unknown host prompts and a non-interactive session fails until `-o StrictHostKeyChecking=accept-new` (or a `known_hosts` inside the workspace mount) is supplied, and `Host` aliases have to be spelled out on the command line. The source key must stay `0600` because the container uid (1000) matches a normal host uid, which is when OpenSSH enforces the mode.

## 1.6.3 - 2026-10-30

- A finished turn carries a short summary of the agent's final answer, written by the fast model: it reuses the configured `ModelRuntime`, is bounded by a 20 s timeout and roughly 120 tokens, is cached per message, and stays out of the way when it fails or when the turn is skipped. The chat shows it under the answer with an **expand** control that reveals the original message.
- The run activity opens as a modal over the chat instead of replacing the page, so the conversation stays mounted and keeps its scroll and draft while you look at what the agent did.
- Code blocks keep their copy button until the block is hovered or focused: it hides behind `@media (hover: hover) and (pointer: fine)`, so a phone keeps a visible control, `focus-visible` and the keyboard reveal it, and the copied/failed feedback survives the pointer leaving.
- The `MCP events` and background-job chips are blurred panels over the content instead of flat fills, matching the floating cards above the composer.
- The `MCP events` widget keeps the last three events instead of the last twenty, so it fits the stats page without scrolling.

## 1.6.2 - 2026-10-30

- Events from an MCP subscription now pass through untouched. The hub names every occurrence after its subscription and carries the kind in `data.kind`, so the repairs added in 1.6.1 (numeric `eventId`/`timestamp` coercion, `data` → `null`, renaming to the stream name with `data.eventName`, the single-open-stream fallback) are gone; the transport hook logs, once per server and reason, an `events/event` frame `pi-mcp-events` would reject, and the notice and widgets show `data.kind` when present, else the name.
- The container no longer needs the hub's configuration directory: the hub bearer token is mounted on its own at `/run/secrets/zeroshot-hub-token` and read through `bearerToken`, so the Hetzner token, the gateway key and the GitHub token stay out of the chat process.
- pi-ui no longer rewrites MCP events: the repairs added in 1.6.1 (numeric ids and timestamps, missing `data`, renaming an event to its stream and keeping its kind in `data.eventName`, routing a frame without a subscription id) are gone now that the zeroshot hub names each event after its stream (naqerl/zeroshot#8). Events `pi-mcp-events` would drop are still logged once per server and reason (`[mcp] zeroshot: events/event is named "hub.job", not its stream "hub"; pi-mcp-events drops it`), and the chat notice and both MCP widgets show an event's `data.kind` when it has one.
- The container no longer mounts the zeroshot configuration directory. It mounts one read-only file instead, `hub/api-token`, at `/run/secrets/zeroshot-hub-token`, and `mcp.json` reads it with `"bearerToken": "!cat /run/secrets/zeroshot-hub-token"`. Before this, the `!echo Bearer $(cat /home/user/.config/zeroshot/hub/api-token)` header forced the whole directory to be mounted, which put the hub's Hetzner token, its gateway key and its GitHub token inside the chat process just to reach one bearer token. Existing installs must change that header to the `bearerToken` form and replace `ZEROSHOT_CONFIG_DIR` with `ZEROSHOT_HUB_TOKEN_FILE`; a stale header now fails loudly at boot as an unreadable file rather than silently taking the whole directory with it.

## 1.6.1 - 2026-10-30

- Memory is a set of files the agent can keep, search and consolidate: `data/memory/MEMORY.md` is a short index, one nested file per topic holds the body, `find` scores topics by term overlap instead of loading everything, and a consolidation pass turns dated journal entries into topic text at checkpoints, so the injected block stays byte-stable between them and the prompt cache keeps hitting. Markdown files, no database, and every write is a rename; the tools are `memory_write`, `memory_read`, `memory_find`, `memory_dream` and `memory_status`.
- The image can now be checked instead of assumed: `scripts/verify-image-topology.sh` measures what a job box actually provides — the chromium revision and whether it matches the `playwright-core` that the repo resolves, whether `/opt/playwright` is writable, a real screenshot whose PNG width and height are read from the bytes, the runtimes, the pi launcher and its extension list, cgroups and free disk — and `docs/image-topology.md` records the readings and what each one rules out.
- Events from an MCP subscription reach the chat notice, `/api/state`, the `MCP events` widget and the MCP widget again. `pi-mcp-events` dropped every event with a numeric id or timestamp, or a kind other than the stream name (such as `hub.job` on a `hub` stream), without a word, while heartbeats kept moving the cursor; pi-ui now repairs those events on the way in and logs each repair once per server (`[mcp] zeroshot: events/event numeric eventId; repaired`). Every extension notice is logged as one line, a failing notice handler is logged instead of lost in a timer, and each subscription shows its last cursor on `/events`, in the `MCP events` widget data and in `mcpEvents.subscriptions`.

## 1.6.0 - 2026-10-30

- The stats page is a dashboard of widgets the agent can build and edit: each widget declares its own data and polling interval, an isolated poll runner fetches only the widgets on screen, and a live Hetzner servers example ships with the docs.
- The composer is hidden on the stats page: the dock slides down out of view there and back up on the chat and tasks pages.
- A turn interrupted by a server restart is now resumed by pi-durable from its last checkpoint instead of sending the agent a synthetic continuation message. The transcript no longer gains that extra user turn; queued messages are still restored.
- MCP status and events moved from the chat header to the stats page: the MCP widget shows each server's live subscriptions, and a new default `MCP events` widget lists the latest 20 events, newest first. Existing dashboards get it once.
- Background job results no longer appear in the chat as user messages. Each one is kept on the activity page where it happened, such as `job build finished ✓ 12s`; opening it shows the job's command, status, exit code, duration and last output. Results for cancelled jobs and jobs started with `notify: false` are activity-only too, and the agent never sees them. MCP events still show in the chat as a one-line notice.
- A run can no longer stay "working" forever after the server lost its end: when the agent's event stream ends (a failed session, a listener error) the server reattaches it, a snapshot that replaces dropped events settles the run state, and a run quiet for 30s is checked against the agent's live state and cleared when nothing is running. The server logs each of these (`[pi] agent event stream ended`, `[pi] no agent events for …`, `[pi] run state reconciled …`).
- The working strip shows how long the run has gone (`working · 1m 05s`) and, after 30s without any output from the agent, how long it has been quiet (`· no output for 45s`), so a stalled model stream is visible instead of a still "working".
- Steers go into the run at its next turn boundary, all of them together and in the order sent: while a tool runs they enter right after it, before the model's next answer. Before, the agent took one steer per boundary, so the rest waited for the end of the run and each started a run of its own. A steer that already went in is no longer sent twice when it is turned into a steer again.
- A steer the run has not reached yet shows at the bottom of the chat as `steer · pending` (in every tab and after a reload) and moves to where it entered once the run takes it. ArrowUp in an empty composer takes back the newest pending steer and puts its text and images back in the composer; press it again for the one before. `POST /api/steer/:id` with `{"action":"unsend"}` does the same and answers 409 once the steer is in.

## 1.5.1 - 2026-10-29

- An installed app no longer opens on a white splash before it paints: the manifest's `background_color` defaults to #171717, matching `theme_color`.
- The page declares `color-scheme` — `light dark` statically, the active theme's mode from the server, and updated when the theme changes — so the system bars and native controls follow the theme.

## 1.5.0 - 2026-10-29

- The agent can run shell commands as background jobs, list them, read their output and cancel them. pi tells the agent when a job finishes.
- On start after an update, pi tells the agent which version it now runs and what changed, from this changelog.
- Long sessions open with the latest 30 messages; older ones load as you scroll up. Markdown renders as it nears the screen, long tool output is collapsed, and heavy views load on demand.
- A finished reply scrolls into view from its start, with its run info on top.
- Attach images with the plus button next to the message box; they show as previews and reach the agent.
- A stats page left of the chat shows context use, tokens, cache hits and MCP server status.
- The dither background recovers when the browser drops its WebGL context, so an idle PWA no longer turns white.
- The PWA system bars and manifest take the active theme's colors.
- Task titles render inline Markdown, and the empty task list reads like the latest indicator.
- Run info sits on a card, wraps on phones and no longer counts thinking blocks.
- Code blocks have a copy button, and every message shows its hh:mm time.
- Long words, code blocks and tables stay inside chat bubbles.

## 1.4.3 - 2026-10-29

- The working indicator shows above the message box.

## 1.4.2 - 2026-10-29

- The chat stays live, and stale MCP event connections reconnect.

## 1.4.1 - 2026-10-29

- The image ships the Omarchy themes, and the background warp draws from oklch colors.

## 1.4.0 - 2026-10-29

- A swipeable task list with subtasks and blockers, and narrower task tools for the agent.
- The page takes its colors from the Omarchy theme, and the pi menu was added.

## 1.3.0 - 2026-10-28

- An explicit container MCP contract; unavailable MCP servers are shown.
- Interrupted runs are recovered and resumed, replies render Markdown, and the app has e2e tests.
- A stable composer across sends, runs and mobile viewports, over a blurred black footer.
## 1.6.113

- **MCP events stream again after a restart.** An event stamped before this process
  started was stored with `replayed: true`, and replayed events are dropped before they
  become a notice — so a healthy `events/stream` subscription advanced its cursor and
  delivered nothing, with `lastEventAt` frozen for sixteen hours. Novelty is now the
  durable delivered-id set alone: a known id is a re-delivery, anything else is news
  whenever it was produced. A batch that reports `dropped_events` also records a `gap`
  (count and time) on `/api/state` instead of leaving the missing window silent.

## 1.6.112

- Tapping a push notification no longer lands on a 404. The payloads always
  carried the client's routes (`/chat`, `/tasks`), but `openWindow` is a real
  document request and the server had no shell for them, so the browser got a
  404 before the router could run. The server now serves the app shell for the
  page routes it owns in a shared `PAGE_PATHS` table; `/api/*` and unknown paths
  keep returning a real 404.

## 1.6.111

- CI caught what my local gate did not: 1.6.110 left a stray blank line in this
  changelog, so `biome check .` failed the lint job before any test ran. The
  chart fix itself is unchanged (34 px y-axis, 4 px tick margin); only the
  formatter's complaint is gone. Lesson repeated: the release gate is
  `biome check .` over the whole tree, never `biome check src e2e`.

## 1.6.110

- Widget charts keep their y-axis on the left but stop paying Recharts' default
  60 px gutter for it: the axis is 34 px wide with a 4 px tick margin, so the plot
  fills the card instead of leaving a band on the left and a gap on the right.
  Card padding is unchanged for every widget kind, so nothing looks inset.

## 1.6.109

- The dashboard no longer carries an empty-state line or a "newer default dashboard
  available" banner with its Reset button. Widgets are the page: the grid shows the
  grid, and a reset happens because the agent was asked for it, not by tapping a bar
  that appears whenever the default board changes.
## 1.6.166

### Fixed

- The plan chat keeps no static band above its transcript: the first message carries its own
  top gap and scrolls away with it, so the pane no longer shows a fixed empty strip.

## 1.6.165

### Changed

- The plan chat and the chat share one core: transcript, scroll, steer/queue and planning
  status come from the same state machine, and only the tool set and the system prompt differ.
- The tasks list carries no status word while a plan run is live; the open task shows its
  planning status on its own pane, not on the card.

## 1.6.164

### Fixed

- Activity rows line their disclosure chevron up with the row text: the glyph is centred on the row
  rather than on the box, so an expanded and a collapsed row look aligned.

## 1.6.163

### Fixed

- The activity entry for a run appears as soon as the agent reports "working", instead of waiting for
  the first tool call, so the message no longer arrives late or looks missing.

## 1.6.162

### Fixed

- The working/idle indicator follows the surface you are looking at: the chat keeps the run state of
  its own conversation, and tasks shows planning only for the task that has a live plan run, instead
  of carrying one global status across pages.

## 1.6.161

### Fixed

- On a narrow screen the task detail opens at the top of the pane instead of wherever the list was
  scrolled, and going back restores the list to the position you left it.

## 1.6.160

### Fixed

- A queued decision notice about a proposed task renders as its chip instead of a second user
  row carrying the same sentence, and only that kind of notice suppresses its queued copy — an
  MCP status notice is drawn from its queue row, so it keeps it.

## 1.6.159

### Added

- A diagram that fails to parse can be repaired in place: the parse error now comes back with
  the diagram's id, and `edit_diagram` takes that id plus the corrected source, so a syntax slip
  near the top no longer costs the agent a full re-emit of the body and a new id.

## 1.6.158

### Fixed

- A task created from the composer is no longer lost: a create that fails leaves the row in place,
  says what went wrong, and can be retried, instead of silently disappearing.
