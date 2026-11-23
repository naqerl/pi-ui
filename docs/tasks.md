# Tasks

The tasks page is a shared todo ledger. Open work is grouped by project, A–Z,
with "No project" last.

## Recent tasks

Ctrl+Tab moves to the Tasks page and opens the next task in a per-browser ring of
recently opened tasks; Ctrl+Shift+Tab walks the same ring backwards, and Ctrl+I
and Ctrl+O are their aliases. Both ends wrap, and every press commits at once,
so the detail opens on the keypress instead of waiting for a key release. A
small pill above the page reads `n/total`, the title, the project and the task
id until 1.4 s after the last press.

The ring holds only tasks opened in this browser, most recent first, capped at
12 ids and stored in `localStorage` under `pi-ui:recent-tasks`. A card tap, a
deep link, a task chip in the chat and a newly created task all count; there is
no server-side recency fill. It survives a reload, is shared by every task on
this origin, and skips ids the ledger no longer has. Done tasks stay in it. Each
open moves an existing task to the front; reopening the front entry does not
write again.

Cycling must not reorder itself: opening a task moves it to the front, so a
naive read on every press would bounce between two tasks. A press that starts a
new burst (no earlier press, or a gap longer than 1.5 s) snapshots the ring and
the position of the open task; presses inside the burst advance that snapshot.
Opening a task by hand clears the snapshot, so the next press starts from the
task the operator just picked; closing the detail clears it too, so the next
press opens the most recent entry again.

A normal browser tab reserves Ctrl+Tab and Ctrl+Shift+Tab for its own tab strip
and never delivers them to the page; the installed PWA has no tab strip and
does. That is why Ctrl+I and Ctrl+O exist: Ctrl+I is the forward binding that
works in a plain tab. On Windows and Linux, Chrome may open its file dialog on
Ctrl+O before the page sees it, so Ctrl+O is the less reliable backward alias.
With fewer than two ring entries, and when the ring would only wrap back to the
open task, all four keys stay with the browser.

## Full screen

`/fullscreen` in the task composer hides the task list and the planning chat so the
open task's body owns the page width. It only exists on a wide viewport (1024 px
and up) with a detail open; elsewhere the palette still lists it, dimmed with
`desktop only` or `no task open`, and Enter runs nothing. An unavailable command
leaves the typed text in the composer, and the browser's own full-screen API is
never called. The mode is a layout state: no URL, no history entry, no stored
preference.

The side list and the chat column stay mounted and are hidden with `hidden` and
`inert`, so the planning session, its scroll position and the task dock keep
their state; the list's scroll position is restored when it returns. On a
narrow viewport the split is a stack and the command is unavailable.

Three things leave the mode: Escape, the cross in the details bar, and the same
command again. Escape is layered — the composer palette, an open menu or dialog,
and an inline title or body edit each consume it first — so one press never
closes two things. Leaving full screen keeps the detail open; the next Escape
closes it. The corner cross becomes the exit control while the mode is on, and
switching tasks with Ctrl+Tab keeps the body at full width.

## Draft planning

The create composer's status row has a `Plan task` toggle, on by default and remembered for
the browser session when the operator turns it off. With it on, submitting creates the task in the
`planning` state and starts its plan run with the composer text as the task body. The draft is not
open work: idle nudges ignore it, `task_working` refuses it, and it waits in the Drafts section
until a human approves it. Its list card says `Planning` while the plan agent is live and
`Waits approval` once the run stops, so the tag never claims the operator's turn during a run. The
agent's `task_list` hides drafts unless it asks with `includePlanning: true`.

`propose_task` takes one `prompt` and always stages the same draft: the prompt is saved as the
draft's title and body, its plan run starts, and the operator approves the draft once the body is
ready. An optional `project` and existing image `attachments` carry over. There is no rationale,
body or flag to pass. A follow-up proposed by a plan agent becomes its own planning draft with its
own plan agent. If the plan run fails to start, the draft is still saved and the tool reports that
the run did not start.

## Depends on

A task's dependencies are its `blockedBy` ids. The relation is printed as `depends-on=` in
the ledger and in every task tool: the ledger line shows every stored dependency, with `(done)`
marking a satisfied one, and `task_view` shows both directions as `depends-on=` and `required-by=`
with id, status and title. There is no separate reverse field; "required by" is derived.

A dependency gates while its status is `open`, `working` or `planning`. `done`, `backlog`,
`proposed` and a missing id are not gates, and one predicate in `src/shared/tasks.ts` keeps the
ledger, task state, index and idle nudges in agreement. `task_depends` replaces a task's whole
dependency list (an empty list clears it) and refuses an unknown id, a self-dependency, a proposed
or backlog dependency, and any cycle with 409 and nothing written. A cycle message names the path,
for example `Blockers would cycle: a1 → b2 → a1`. `task_block` still creates a new task that gates
an existing one.

Starting a task with a pending dependency is refused before any write. The refusal states the law —
a task may only start after every task it depends on is implemented and marked done — then lists
each pending dependency as `id status title`, notes when one is still being planned and waiting for
approval, and names the two ways forward: implement and `task_done` those ids first, or correct the
order with `task_depends`. A satisfied dependency never refuses, and `task_done` is never gated:
dependencies gate starting, not finishing.

The plan agent reads before it designs. It lists the other tasks in its project with `task_list`,
opens related ones with `task_view`, and aligns by naming the shared module, API or type and the
order in which both tasks land instead of designing a second mechanism. It records a real ordering
with `task_depends` in one direction only; a task still in `planning` is read to avoid conflict, not
treated as approved work whose outcome the design can assume.

Plan sessions install one scoped `createTaskTools` factory. With a scope, `task_list` lists every
task in the planned task's project, including planning drafts and proposed ideas marked "not
approved"; when the planned task has no project it lists every project and names the project on
each line. Scoped `task_view` refuses ids outside that project, and scoped `task_depends` accepts
only an ordering that involves the planned task in either direction.

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
