# pi-ui

A minimal, single-conversation web UI for the [pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) coding agent, with one persistent transcript and no session management. It installs as a PWA and accepts text, titles, and URLs from the native share sheet on platforms that support Web Share Target.

## Quick start

```sh
npm install && npm run build && npm start
```

Open the URL printed by the server (by default <http://localhost:8787>). The server and the Vite client share the same origin in production; `npm run dev` runs the API on port 8787 and Vite on <http://localhost:5173>.

## Configuration

| Variable              | Meaning                                                | Default                      |
| --------------------- | ------------------------------------------------------ | ---------------------------- |
| `PORT`                | HTTP port for the server.                              | `8787`                       |
| `PI_CWD`              | Working directory used by pi for the whole process.    | `process.cwd()`              |
| `PI_MODEL`            | Model to select, as `provider/model-id` or a model id. | pi's configured default      |
| `PI_CODING_AGENT_DIR` | pi configuration/auth directory.                       | pi's `getAgentDir()` default |

The transcript is stored in `data/session.jsonl`, one JSON object per line. The directory is created on first write and is intentionally git-ignored.

## Install and share

- **iOS / iPadOS:** open the site in Safari, choose Share, then **Add to Home Screen**.
- **Android:** open the site in Chrome and choose **Install app** (or Add to Home screen).
- **Desktop:** use the install control in Chrome or Edge's address bar.

Browsers require HTTPS (or localhost) for service workers and installation. After installation, platforms with Web Share Target support list **pi** in the system share sheet. A shared title, text, and URL are posted to `/share` as `application/x-www-form-urlencoded` fields; the server appends a user message containing the shared text and URL, starts one pi run, and redirects to `/`. The same intake is available as `/share?title=...&text=...&url=...` and is useful on platforms without a native share target.

## Interaction design

Every tool call and thinking block is collapsed to one muted, monospaced line in the transcript, for example `▸ bash · 1.4s · ok` or `▸ edit · 0.2s · failed`. The transcript never renders tool arguments, tool output, or thinking text. Selecting that line opens `/activity`, which lists every tool call and thinking block in order with an expandable disclosure for its arguments, result or error, and duration; a back link returns to the chat.

The composer is pinned to the bottom. Enter sends, Shift+Enter inserts a newline, the textarea grows to about eight rows, and the Stop button replaces Send while a run is streaming. Messages are plain text bubbles; there is no markdown editor, model picker, working-directory picker, or settings screen.

## What this deliberately does not do

- No chat list, conversation titles, create/delete/switch, or multiple sessions.
- No accounts, authentication, telemetry, analytics, or database.
- No model picker, working-directory picker, settings page, or configuration UI.
- No attachments, file browser, markdown editor, message editing, or retry controls.
- No MCP servers, extensions, plugins, or tool search.
- No unit tests, test framework, or end-to-end browser harness.
- No markdown rendering, syntax highlighting, syntax-aware code blocks, or rich tool output in the transcript.

## SDK notes

The server uses the documented pi SDK directly: `createAgentSession`, `SessionManager.inMemory`, `DefaultResourceLoader`, `getAgentDir`, `session.prompt`, `session.abort`, and the documented session event stream. No SDK APIs are invented. Because the SDK exposes agent events rather than a browser protocol, `src/server/sse.ts` is the single adapter that maps those events to the SSE messages described above; persistence and history replay live in `src/server/store.ts`. On startup the JSONL transcript is replayed into a fresh in-memory session so the next run has the prior conversation as context. `PI_MODEL` selection is best-effort: if the requested model cannot be selected (for example, because its provider has no API key), the server warns and keeps the configured default instead of failing to boot.
