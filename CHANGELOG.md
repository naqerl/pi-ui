# Changelog

Notable changes to pi-ui. Each `## <version>` section lists what changed in that release, newest first. On start, pi-ui compares its version with the last one it ran (`DATA_DIR/version.json`) and, after an update, hands the agent the sections it has not seen yet.

## Unreleased

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
