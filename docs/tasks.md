# Tasks

The tasks page is a shared todo ledger. Open work is grouped by project, A–Z,
with "No project" last.

## Draft planning

The create composer's status row has a `Plan this task` toggle, on by default and remembered for
the browser session when the operator turns it off. With it on, submitting creates the task in the
`planning` state and starts its plan run with the composer text as the task body. The draft is not
open work: idle nudges ignore it, `task_working` refuses it, and it waits in the Drafts section
until a human approves it. The agent's `task_list` hides drafts unless it asks with
`includePlanning: true`.

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
