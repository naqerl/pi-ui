# Changelog

Notable changes to pi-ui. Each `## <version>` section lists what changed in that release, newest first. On start, pi-ui compares its version with the last one it ran (`DATA_DIR/version.json`) and, after an update, hands the agent the sections it has not seen yet.

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
