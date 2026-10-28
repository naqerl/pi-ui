# pi-ui

A minimal, single-conversation web UI for the [pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) coding agent, with one durable conversation and no session management. It installs as a PWA and accepts text, titles, and URLs from the native share sheet on platforms that support Web Share Target.

It ships as `ghcr.io/naqerl/pi-ui`. The container has no credentials baked in: your real pi agent directory is bind-mounted at runtime, so the UI uses your `auth.json` and the model catalog configured there. The conversation is stored in SQLite by `@earendil-works/pi-durable`; one host directory holds pi's working tree together with that database, so a whole session survives container replacement. Context compression runs in-process through `billion-context`; its session/index data lives in a second host directory, `~/.local/share/billion-context`, which must also be writable and persistent.

## Quick start (local)

```sh
npm install && npm run build && npm start
```

Open the URL printed by the server (by default <http://localhost:8787>). The server and the Vite client share the same origin in production; `npm run dev` runs the API on port 8787 and Vite on <http://localhost:5173>.

## Run the container

```sh
docker pull ghcr.io/naqerl/pi-ui:v1.1.0

docker run -d --name pi-ui --restart unless-stopped \
  -p 8787:8787 \
  -v "${PI_WORK_DIR:-$HOME/pi-work}:/workspace" \
  -v "${PI_AGENT_DIR:-$HOME/.pi/agent}:/home/pi/.pi/agent" \
  -v "${BILI_DATA_DIR:-$HOME/.local/share/billion-context}:/home/pi/.local/share/billion-context" \
  ghcr.io/naqerl/pi-ui:v1.1.0
```

Open <http://localhost:8787>. The host working directory defaults to `~/pi-work`; create it first if `$HOME/pi-work` does not exist. The agent directory defaults to `~/.pi/agent`, which is the directory pi already uses on the host. Create the compression-state directory before the first run too: `mkdir -p ~/.local/share/billion-context`.

The compose file is the same setup with the paths and comments in one place:

```sh
docker compose up -d
# or build the image locally instead of pulling it
docker compose up -d --build
```

The host paths can be overridden with environment variables:

```sh
PI_WORK_DIR=$HOME/pi-session PI_AGENT_DIR=$HOME/.pi/agent PORT=9000 docker compose up -d
```

### What comes from the mounts

| Host mount                                             | Container path                          | What lives there                                                                                                                                                                                                                                        |
| ------------------------------------------------------ | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `${PI_WORK_DIR:-./work}`                               | `/workspace`                            | pi's working tree, everything a session creates, and the durable conversation at `data/pi.sqlite3`. This is the single directory that backs a whole session.                                                                                            |
| `${PI_AGENT_DIR:-$HOME/.pi/agent}`                     | `/home/pi/.pi/agent`                    | Your real pi state: `auth.json`, `settings.json`, optional model overrides, installed pi packages, and pi's own history/state. Mounted read-write because pi writes here. This mount supplies the provider credentials for both pi and billion-context. |
| `${BILI_DATA_DIR:-$HOME/.local/share/billion-context}` | `/home/pi/.local/share/billion-context` | billion-context's in-process compression state: session files, `index.db`, and logs. Must be writable by uid 1000 and persistent.                                                                                                                       |

The database is not a separate mount. It is created inside the workspace mount, so replacing the container keeps both the files pi worked on and the conversation that produced them.

The image contains no `auth.json` and no API keys. Credentials reach the process only through the agent-directory mount.

### Context compression state

Billion-context is installed in inline mode. Its engine runs inside the server process and listens on the virtual origin `http://billion-context.inline`; an outermost fetch wrapper stamps each model request with the current durable conversation ID. The engine keeps its own session files and SQLite index under `~/.local/share/billion-context` (honoring `XDG_DATA_HOME`, `XDG_CONFIG_HOME`, and `XDG_STATE_HOME` when set). That directory must be writable by the process and mounted persistently, or compression history is recreated after every container replacement. It does not contain credentials; provider credentials still come from `PI_CODING_AGENT_DIR` (`auth.json`) and the environment. Losing this directory costs compression continuity, not the durable chat transcript, which remains in `<DATA_DIR>/pi.sqlite3`.

## Configuration

| Variable              | Meaning                                                                                                 | Default                      |
| --------------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------- |
| `PORT`                | HTTP port for the server.                                                                               | `8787`                       |
| `PI_CWD`              | Working directory pi operates in. Must exist or the server refuses to start.                            | `process.cwd()`              |
| `DATA_DIR`            | Directory for `pi.sqlite3` and `current.json`. Relative paths resolve against `PI_CWD`.                 | `<PI_CWD>/data`              |
| `PI_MODEL`            | Model to select, as `provider/model-id` or a model id.                                                  | pi's configured default      |
| `PI_CODING_AGENT_DIR` | pi configuration/auth directory. In the image this is `/home/pi/.pi/agent`, bind-mounted from the host. | pi's `getAgentDir()` default |

The durable conversation is stored at `<DATA_DIR>/pi.sqlite3` (by default `<PI_CWD>/data/pi.sqlite3`). `<DATA_DIR>/current.json` records the single current conversation ID. On boot the server resumes that conversation when the database still has it; otherwise it creates a new one and rewrites the file. The directory is created on first boot and is intentionally git-ignored.

If the process is killed during a turn, the next boot keeps the committed transcript and marks the unfinished turn `interrupted` in `/api/state`. It does not replay the turn token by token; the composer accepts the next message instead.

On boot the server logs the working directory, database path, conversation ID, whether it was resumed, and whether the previous run was interrupted. It also logs the selected model, or a clear warning when no credentials are available. The registry contains the coding tools (`read`, `bash`, `edit`, `write`) plus four deferred web tools (`mcp__web__web_search`, `mcp__web__fetch_content`, `mcp__web__get_search_content`, `mcp__web__source_check`) bridged from the `pi-web-access` MCP child. `tool_search` is installed so those deferred tools do not inflate the system prompt. When the inline engine answers `GET /__bili/plugin/manifest`, the registry also exposes its compression tools (`compress`, `decompress`, `search_context`, `acp_status`, `acp_cache`, `acp_read_original_image`); if the manifest is unreachable those tools are absent and the rest of the server still boots. Other MCP servers, coding-agent extensions, and codemode are not loaded.

## Install and share

- **iOS / iPadOS:** open the site in Safari, choose Share, then **Add to Home Screen**.
- **Android:** open the site in Chrome and choose **Install app** (or Add to Home screen).
- **Desktop:** use the install control in Chrome or Edge's address bar.

Browsers require HTTPS (or localhost) for service workers and installation. After installation, platforms with Web Share Target support list **pi** in the system share sheet. A shared title, text, and URL are posted to `/share` as `application/x-www-form-urlencoded` fields; the server appends a user message containing the shared text and URL, starts one pi run, and redirects to `/`. The same intake is available as `/share?title=...&text=...&url=...` and is useful on platforms without a native share target.

## Interaction design

Every tool call and thinking block is collapsed to one muted, monospaced line in the transcript, for example `▸ bash · 1.4s · ok` or `▸ edit · 0.2s · failed`. The transcript never renders tool arguments, tool output, or thinking text. Selecting that line opens `/activity`, which lists every tool call and thinking block in order with an expandable disclosure for its arguments, result or error, and duration; a back link returns to the chat.

The composer is pinned to the bottom. Enter sends, Shift+Enter inserts a newline, the textarea grows to about eight rows, and the Stop button replaces Send while a run is streaming. Messages are plain text bubbles; there is no markdown editor, model picker, working-directory picker, or settings screen.

## Releases

Pushing a `v*` tag runs `.github/workflows/release.yml`, which builds and pushes `ghcr.io/naqerl/pi-ui` to GitHub Container Registry with semver tags, `latest`, provenance, and GitHub Actions layer cache. Tag `v1.1.0` publishes `:v1.1.0` (the tag the commands above use), `:1.1.0`, `:1.1`, and `:latest`; the `v`-prefixed tag is emitted explicitly with `type=semver,pattern=v{{version}}` because the plain `{{version}}` pattern strips the leading `v`. The workflow can also be started manually with `workflow_dispatch` to rebuild an existing ref. There is intentionally no build on every push to a branch.

The image is built for `linux/amd64` only. The release job does not run an emulated `linux/arm64` build, because the QEMU build does not fit the job budget; add it to `platforms` only after confirming it builds reliably in CI.

GHCR creates a new package as private on first push. Set the `pi-ui` package's visibility to public once in the package settings on GitHub; after that, `docker pull ghcr.io/naqerl/pi-ui:v1.1.0` works without authentication. The publish job prints the resulting tags and digest in the workflow run summary.

## What this deliberately does not do

- No chat list, conversation titles, create/delete/switch, or multiple sessions.
- No accounts, authentication, telemetry, or analytics.
- No model picker, working-directory picker, settings page, or configuration UI.
- No attachments, file browser, markdown editor, message editing, or retry controls.
- No arbitrary MCP servers, codemode, or coding-agent extensions. The only MCP child is the bundled `pi-web-access` server behind the four `mcp__web__*` tools; `tool_search` exposes them on demand. Billion-context is not spawned as a proxy or extension: it runs in-process in inline mode and only adds its own compression tools when its manifest is reachable.
- No unit tests, test framework, or end-to-end browser harness.
- No markdown rendering, syntax highlighting, syntax-aware code blocks, or rich tool output in the transcript.

## SDK notes

The session layer is `@earendil-works/pi-durable` over `openNodeSqliteStorage()` at `<DATA_DIR>/pi.sqlite3`. User input goes through `Conversation.submit()`; streaming comes from `watchEvents()` and is adapted to the same SSE event names in `src/server/chat-service.ts`. The coding tools come from `createCodingTools()` and are installed with `createRegistry()` and `defineExtension()`. The model catalog is built with the installed coding agent's `ModelRuntime.create()`, following `dist/core/model-runtime.js`: it reads `auth.json`, optional `models-store.json` overrides, and the built-in pi-ai provider catalog from `PI_CODING_AGENT_DIR`. The system prompt is still built by the coding agent's `createAgentSession()`/`DefaultResourceLoader` path from `src/server/pi.ts`, then stored as the durable conversation's `instructions`. `/api/state` reports usage (`input`, `output`, `cacheRead`, `cacheWrite`, `cost`) and context usage from durable usage documents. `PI_MODEL` selection is best-effort: if the requested model cannot be selected, the server warns and keeps the configured default instead of failing to boot.

At bootstrap, before the durable harness exists, `src/server/billion-context.ts` imports `billion-context`'s pi-native entry, keeps its in-process fetch transport, and installs the pi-ui identity wrapper outermost. Every model request is rewritten to `http://billion-context.inline/bili/<provider URL>` and stamped with `x-bili-plugin-conversation` (read from `<DATA_DIR>/current.json`), `x-bili-plugin-agent: pi`, and — once the model catalog is available — the selected model's `x-bili-plugin-model`, `x-bili-plugin-context-window`, and `x-bili-plugin-max-output` limits. The wrapper passes the original method, headers, body stream, and response stream through untouched; it never buffers or re-serialises an SSE response. The one conversation is registered with `POST /__bili/plugin/register` after boot without blocking it. Because the wrapper resolves a single global `current.json`, this design assumes the UI's one-conversation model; a future multi-conversation feature must stamp from the request's durable conversation instead. Automatic pi-durable compaction is disabled so billion-context owns compression; manual compaction still works. `node scripts/bridge-check.mjs --bili` prints the origin, registration, an observed proxied request, the applied conversation header, and either one real model turn or `skipped: no provider credentials`.
