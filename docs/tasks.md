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

## Draft planning

The create composer's status row has a `Plan task` toggle, on by default and remembered for
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
- Sessions persist under `DATA_DIR/task-agents/<taskId>/`. Every plan turn that
  was live when the server stopped is resumed automatically at boot, including
  runs on open and working tasks; a turn stopped before the restart stays
  stopped. Tasks and session directories with no run marker are opened lazily
  when their chat is viewed. Marking a task done stops a running turn but keeps
  the transcript (the composer is hidden until the task is reopened). Deleting a
  task stops the agent and removes its session files.

The task body is ordinary markdown. Fenced `mermaid` (or `pele`) blocks use the
same diagram renderer as the main chat.
