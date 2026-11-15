# Tasks

The tasks page is a shared todo ledger. Open work is grouped by project, A–Z,
with "No project" last.

## Draft planning

The create composer's status row has a `Plan task` toggle, on by default and remembered for
the browser session when the operator turns it off. With it on, submitting creates the task in the
`planning` state and starts its plan run with the composer text as the task body. The draft is not
open work: idle nudges ignore it, `task_working` refuses it, and it waits in the Drafts section
until a human approves it. The agent's `task_list` hides drafts unless it asks with
`includePlanning: true`.

## API and lean state

The tasks APIs are transport-cached: `GET /api/tasks`, `GET /api/tasks/activity`, `GET /api/jobs`
and `GET /api/state` return a content ETag, and a matching `If-None-Match` gets `304` with no body.
The main chat keeps its held snapshot when `/api/state` answers `304`. Activity uses a weak
validator over the persisted trace data; its `304` carries `X-Pi-Activity-Now` so a client can
advance the clock without re-sending the trace ledger.
Jobs are the same list as `/api/jobs`; `GET /api/state` leaves them out unless `?jobs=1` (or
`?activity=1`) is asked for, because the jobs stream and endpoint already carry them.

`GET /api/tasks/activity` is the measured run/activity ledger on its own. `GET /api/tasks` and
`GET /api/state` leave that field out unless `?activity=1` is present. The tasks page fetches the
activity ledger separately while a task surface is visible and keeps the last value on `304`.

`/api/state` is the list view, not the full editor payload: a task with a markdown body or
rationale carries `bodyOmitted: true`, a short `bodyHash` and the last body line as
`bodyExcerpt`. `GET /api/tasks/:id` returns that one row with its full `body` and `rationale` plus
the same derived `planning` flag as the ledger. The tasks page fetches it when a detail opens,
including a deep link, and again when the lean row's `bodyHash` changes, so an edit made in the
plan chat or another client appears without closing the detail.

## Planning chat

The list composer is gone. A plus-sign button in the dock creates an untitled
task ("New task") and opens its detail. Each task has its own plan-mode agent
session, separate from the main chat:

- The agent may only use `bash`, `read`, and one `edit_task` tool bound to that
  task. The system prompt forbids editing the workspace.
- Its job is to formulate the task and propose a design for how it would be
  solved. `edit_task` writes the title, markdown body, and optional project.
- The first message in the embedded chat can include an `@project` token (with
  the same autocomplete as before). That token is stripped from the text; if the
  title is still the placeholder, the first line becomes the title.
- Sessions persist under `DATA_DIR/task-agents/<taskId>/` and resume after a
  server restart. Marking a task done stops a running turn but keeps the
  transcript (the composer is hidden until the task is reopened). Deleting a
  task stops the agent and removes its session files.

The task body is ordinary markdown. Fenced `mermaid` (or `pele`) blocks use the
same diagram renderer as the main chat.
