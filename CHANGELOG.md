# Changelog

Notable changes to pi-ui. Each `## <version>` section lists what changed in that release, newest first. On start, pi-ui compares its version with the last one it ran (`DATA_DIR/version.json`) and, after an update, hands the agent the sections it has not seen yet.

## Unreleased

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
