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

`propose_task` stages the same draft when it is called with `plan: true`: the task is saved in
`planning`, its plan run starts, and the operator approves the draft once the body is ready. With no
plan runner the draft is still saved and the tool reports that the run did not start.

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
- Sessions persist under `DATA_DIR/task-agents/<taskId>/`. Every plan turn that
  was live when the server stopped is resumed automatically at boot, including
  runs on open and working tasks; a turn stopped before the restart stays
  stopped. Tasks and session directories with no run marker are opened lazily
  when their chat is viewed. Marking a task done stops a running turn but keeps
  the transcript (the composer is hidden until the task is reopened). Deleting a
  task stops the agent and removes its session files.

The task body is ordinary markdown. Fenced `mermaid` (or `pele`) blocks use the
same diagram renderer as the main chat.

## Body shape

A planned body is a specification in four sections, in this order: `## Goal` (one sentence — the
outcome), `## Requirements` (numbered invariants, each naming the check that covers it),
`## Scenarios` (Gherkin — copied from the project's `features/*.feature` vocabulary when it has one,
written out when it does not) and `## Architecture` (one bullet per module: path and what changes).
The plan prompt states the rule and `e2e/task-agent.test.ts` pins it; `edit_task` accepts any body,
because a plan saves skeletons on the way to the shape.
