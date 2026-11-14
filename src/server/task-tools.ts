import {
  defineTool,
  type ToolExecutionResult,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { Type } from "typebox";
import {
  compareTasks,
  liveBlockerIds,
  parseCompletion,
  parseReleaseReason,
  parseReopenReason,
  TASK_BODY_MAX_LENGTH,
} from "../shared/tasks.js";
import { formatDateTime } from "../shared/time.js";
import type { Task, TaskLedger } from "../shared/types.js";
import type { MediaStore } from "./media.js";
import { TaskError, type TaskStore } from "./tasks.js";

/** The process-wide ledger and the hook that tells open browsers it changed. */
export interface TaskBridge {
  readonly store: TaskStore;
  /** Where task images live. Without it, task_view returns only the text. */
  readonly media?: MediaStore;
  publish(ledger: TaskLedger): void;
}

const idSchema = Type.Object({
  id: Type.String({ description: "Task id from task_list." }),
});

const projectSchema = Type.Optional(
  Type.String({
    description:
      "Short project name such as pi-ui (letters, digits, . _ -). Use one already in task_list when it fits.",
  }),
);

const bodySchema = Type.Optional(
  Type.String({
    description: `Free markdown description shown under the title, up to ${TASK_BODY_MAX_LENGTH} characters. Separate from a proposal's rationale.`,
  }),
);

const blockSchema = Type.Object({
  id: Type.String({ description: "Task id that this blocker gates." }),
  title: Type.String({ description: "Title of the new blocker task." }),
  body: bodySchema,
  project: Type.Optional(
    Type.String({
      description:
        "Project of the new blocker. Defaults to the gated task's project; pass it only when the blocker belongs elsewhere.",
    }),
  ),
});

const proposeSchema = Type.Object({
  title: Type.String({ description: "Title of the proposed task." }),
  rationale: Type.String({
    description:
      "Why this task is worth doing, in one or two sentences. At least 20 characters; a human uses it to decide.",
  }),
  body: bodySchema,
  attachments: Type.Optional(
    Type.Array(Type.String({ description: "Media id to attach to the proposal." })),
  ),
  project: projectSchema,
});

const editSchema = Type.Object({
  id: Type.String({ description: "Task id from task_list." }),
  title: Type.Optional(Type.String({ description: "New title; it must not be empty." })),
  body: bodySchema,
  project: Type.Optional(
    Type.Union([Type.String(), Type.Null()], {
      description: "New project name, or null to clear it.",
    }),
  ),
});

const doneSchema = Type.Object({
  id: Type.String({ description: "Task id from task_list." }),
  evidence: Type.String({
    description: "A commit sha, file path, screenshot path or sentence a reviewer can check.",
  }),
});

const reopenSchema = Type.Object({
  id: Type.String({ description: "Task id from task_list." }),
  reason: Type.String({
    description:
      "What the operator said is still wrong, in one or two sentences, up to 500 characters.",
  }),
});

const workingSchema = Type.Object({
  id: Type.String({ description: "Task id from task_list." }),
  note: Type.Optional(
    Type.String({
      description: "What you are working on, up to 200 characters. Echoed back, not stored.",
    }),
  ),
});

const releaseSchema = Type.Object({
  id: Type.String({ description: "Task id from task_list." }),
  reason: Type.String({
    description:
      "Why the work is being parked, in one or two sentences, at least 3 and up to 500 characters.",
  }),
});

const WORKING_NOTE_MAX_LENGTH = 200;

function workingNote(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new TaskError("note must be a string", 400);
  const note = value.trim();
  if (note.length > WORKING_NOTE_MAX_LENGTH) {
    throw new TaskError(`note must be at most ${WORKING_NOTE_MAX_LENGTH} characters`, 400);
  }
  return note.length === 0 ? undefined : note;
}

function formatLedger(ledger: TaskLedger, includePlanning = false): string {
  const lines = [`revision ${ledger.revision}`];
  const active = ledger.tasks.filter(
    (task) =>
      task.status !== "proposed" &&
      task.status !== "backlog" &&
      (includePlanning || task.status !== "planning"),
  );
  const ids = new Set(active.map((task) => task.id));
  const write = (task: Task, depth: number) => {
    const live = liveBlockerIds(ledger.tasks, task);
    const blocked = live.length > 0 ? ` blocked-by=${live.join(",")}` : "";
    const title = task.title.replace(/\s+/g, " ").trim();
    const count = task.attachments?.length ?? 0;
    const images = count > 0 ? ` images=${count}` : "";
    const project = task.project === undefined ? "" : ` @${task.project}`;
    lines.push(
      `${"  ".repeat(depth)}${task.id} ${task.status}${blocked}${images}${project} ${title}`,
    );
    const children = active
      .filter((item) => item.parentId === task.id)
      .sort((a, b) => compareTasks(active, a, b));
    for (const child of children) write(child, depth + 1);
  };
  const roots = active
    .filter((task) => task.parentId === null || !ids.has(task.parentId))
    .sort((a, b) => compareTasks(active, a, b));
  if (roots.length === 0) lines.push("(empty)");
  for (const root of roots) write(root, 0);
  const proposals = ledger.tasks.filter((task) => task.status === "proposed").length;
  if (proposals > 0) lines.push(`proposals: ${proposals} waiting for approval`);
  const planning = includePlanning
    ? ledger.tasks.filter((task) => task.status === "planning").length
    : 0;
  if (planning > 0) {
    lines.push(`planning: ${planning} draft(s) are still being specified; do not execute them yet`);
  }
  return lines.join("\n");
}

function formatProposals(ledger: TaskLedger): string {
  const proposals = ledger.tasks
    .filter((task) => task.status === "proposed")
    .sort((a, b) =>
      a.createdAt === b.createdAt ? (a.id < b.id ? -1 : 1) : a.createdAt < b.createdAt ? -1 : 1,
    );
  if (proposals.length === 0) return "No proposals waiting for approval.";
  return proposals
    .map((task) => {
      const proposedAt = task.proposedAt ?? task.createdAt;
      const title = task.title.replace(/\s+/g, " ").trim();
      const project = task.project === undefined ? "" : ` @${task.project}`;
      return `${task.id}${project} ${title}\n  proposed ${proposedAt} (${formatDateTime(proposedAt)})\n  rationale: ${task.rationale ?? ""}`;
    })
    .join("\n");
}

type ToolResultContent = NonNullable<ToolExecutionResult["output"]>[number][];

function failure(error: unknown): ToolExecutionResult {
  const message = error instanceof TaskError ? error.message : "Could not update tasks";
  return { output: [{ type: "text", text: message }], isError: true };
}

async function changed(
  bridge: TaskBridge,
  action: () => Promise<TaskLedger>,
): Promise<ToolExecutionResult> {
  try {
    const ledger = await action();
    bridge.publish(ledger);
    return { output: [{ type: "text", text: formatLedger(ledger) }] };
  } catch (error) {
    return failure(error);
  }
}

/**
 * The one propose_task definition, shared by the main chat and the planning agent.
 * A proposal is never open work until a human approves it.
 */
export function createProposeTaskTool(bridge: TaskBridge): ToolRegistration {
  return defineTool({
    name: "propose_task",
    description:
      "Propose a task for human approval. A proposal is not a task: it does not appear in task_list and cannot be worked on until a human approves it.",
    parameters: proposeSchema,
    async execute(args) {
      return changed(bridge, () =>
        bridge.store.propose(
          args.title,
          args.rationale,
          args.attachments ?? [],
          args.project,
          args.body,
        ),
      );
    },
  });
}

/** Tools for the same ledger the tasks page edits. Not deferred, so every turn offers them. */
export function createTaskTools(bridge: TaskBridge): ToolRegistration[] {
  return [
    defineTool({
      name: "task_list",
      description:
        "List the shared todo ledger: id, status, live blockers, attached image count, @project when set, and title. Ready tasks come first, then blocked, then done. A done blocker is omitted. Proposals and backlog tasks are not work: proposals appear only as a waiting count; use task_proposals to read them. Planning drafts are still being specified and must not be executed yet; they are hidden unless includePlanning is true. Use task_view to see a task's images.",
      parameters: Type.Object({
        includePlanning: Type.Optional(
          Type.Boolean({
            description:
              "Include tasks still in the planning state. They are drafts being specified and must not be executed yet. Default false.",
          }),
        ),
      }),
      async execute(args) {
        return {
          output: [
            {
              type: "text",
              text: formatLedger(bridge.store.ledger(), args.includePlanning === true),
            },
          ],
        };
      },
    }),
    defineTool({
      name: "task_proposals",
      description:
        "List tasks proposed for human approval, with their id, title, rationale and when they were proposed. A proposal is not open work.",
      parameters: Type.Object({}),
      async execute() {
        return { output: [{ type: "text", text: formatProposals(bridge.store.ledger()) }] };
      },
    }),
    defineTool({
      name: "task_view",
      description:
        "Show one task in full: its title, status, blockers, project, and the images attached to it when it was created.",
      parameters: idSchema,
      async execute(args) {
        const task = bridge.store.ledger().tasks.find((item) => item.id === args.id);
        if (task === undefined || task.status === "backlog") {
          return failure(new TaskError("Unknown task", 404));
        }
        const ids = task.attachments ?? [];
        const completion = task.status === "done" ? (task.completion ?? null) : null;
        const header = [
          `${task.id} ${task.status}${task.parentId === null ? "" : ` parent=${task.parentId}`}`,
          task.blockedBy.length > 0 ? `blocked-by=${task.blockedBy.join(",")}` : "",
          task.project === undefined ? "" : `project=${task.project}`,
          task.title,
          ...(task.body === undefined ? [] : [task.body]),
          ids.length > 0
            ? `${ids.length} attached image${ids.length === 1 ? "" : "s"} follow.`
            : "",
          ...(task.status === "proposed"
            ? [
                `proposed ${task.proposedAt ?? task.createdAt}`,
                `rationale: ${task.rationale ?? ""}`,
              ]
            : []),
          ...(completion === null
            ? []
            : [
                `completed ${task.completedAt === null ? "unknown" : formatDateTime(task.completedAt)}`,
                `evidence ${completion.evidence}`,
              ]),
        ].filter((line) => line.length > 0);
        const output: ToolResultContent = [{ type: "text", text: header.join("\n") }];
        for (const id of ids) {
          if (bridge.media === undefined) break;
          try {
            output.push(...(await bridge.media.images([id])));
          } catch {
            output.push({ type: "text", text: `image ${id} is missing` });
          }
        }
        return { output };
      },
    }),
    defineTool({
      name: "task_done",
      description:
        "Mark one task done and say where a reviewer can check the work. Time, tokens and cost are measured from the calls made while the task was marked working, so do not report them. A task with an open subtask cannot be marked done. This cannot reopen a task or edit its title; use task_reopen to reopen a done task with a reason.",
      parameters: doneSchema,
      async execute(args) {
        const current = bridge.store.ledger().tasks.find((task) => task.id === args.id);
        if (current === undefined || current.status === "backlog") {
          return failure(new TaskError("Unknown task", 404));
        }
        if (current.status === "proposed") {
          return failure(new TaskError("Task is not open; a proposal must be approved first", 409));
        }
        if (current.status === "planning") {
          return failure(
            new TaskError("Task is still being planned; approve it before executing it", 409),
          );
        }
        const parsed = parseCompletion(args);
        if (!parsed.ok) return failure(new TaskError(parsed.error, 400));
        return changed(bridge, () =>
          bridge.store.update(args.id, { status: "done", completion: parsed.completion }),
        );
      },
    }),
    defineTool({
      name: "task_reopen",
      description:
        "Reopen a done task with the reason it is coming back. Use this only when the operator asks to reopen a task or reports that a completed task is still wrong, regressed or misbehaving. Never reopen a task on your own initiative to undo a review verdict or to keep working on something you consider unfinished — propose a new task instead.",
      parameters: reopenSchema,
      async execute(args) {
        const current = bridge.store.ledger().tasks.find((task) => task.id === args.id);
        if (current === undefined) return failure(new TaskError("Unknown task", 404));
        const parsed = parseReopenReason(args.reason);
        if (!parsed.ok) return failure(new TaskError(parsed.error, 400));
        if (current.status !== "done") {
          return failure(new TaskError("Only a done task can be reopened", 409));
        }
        try {
          const ledger = await bridge.store.update(args.id, {
            status: "open",
            reopenReason: parsed.reason,
            reopenedBy: "agent",
          });
          bridge.publish(ledger);
          const task = ledger.tasks.find((item) => item.id === args.id);
          const count = task?.reopens?.length ?? 1;
          return {
            output: [
              {
                type: "text",
                text: `${args.id} open ${task?.title ?? current.title}\nreopened: ${parsed.reason}\nreopen #${count}`,
              },
            ],
          };
        } catch (error) {
          return failure(error);
        }
      },
    }),
    defineTool({
      name: "task_working",
      description:
        "Mark one task working before starting it. Sets its status to working, records when the work began and stamps lastWorkedAt. Pass an optional short note about what you are doing; it is echoed back but not stored. A proposal or backlog task cannot be marked working, and a done task must be reopened with task_reopen first.",
      parameters: workingSchema,
      async execute(args) {
        const current = bridge.store.ledger().tasks.find((task) => task.id === args.id);
        if (current === undefined || current.status === "backlog") {
          return failure(new TaskError("Unknown task", 404));
        }
        if (current.status === "done") {
          return failure(
            new TaskError("Task is done; use task_reopen with a reason to reopen it", 409),
          );
        }
        if (current.status === "proposed") {
          return failure(new TaskError("Task is not open; a proposal must be approved first", 409));
        }
        if (current.status === "planning") {
          return failure(
            new TaskError("Task is still being planned; approve it before marking it working", 409),
          );
        }
        let note: string | undefined;
        try {
          note = workingNote(args.note);
        } catch (error) {
          return failure(error);
        }
        const result = await changed(bridge, () =>
          bridge.store.update(args.id, { status: "working" }),
        );
        if (result.isError === true) return result;
        const task = bridge.store.ledger().tasks.find((item) => item.id === args.id);
        if (task === undefined) return result;
        const lines = [`${task.id} ${task.status} ${task.title}`];
        if (task.workingSince !== undefined) {
          lines.push(`working since ${task.workingSince} (${formatDateTime(task.workingSince)})`);
        }
        if (note !== undefined) lines.push(`note: ${note}`);
        return { output: [{ type: "text", text: lines.join("\n") }] };
      },
    }),
    defineTool({
      name: "task_release",
      description:
        "Release a working task back to open when the work is parked — queued, scheduled or waiting on another task — or when the working claim turns out to be wrong. The reason is recorded and shown in the task details. Only a working task can be released. Do not use this to stop tracking real work: if you are still doing it, keep it working with task_working instead.",
      parameters: releaseSchema,
      async execute(args) {
        const current = bridge.store.ledger().tasks.find((task) => task.id === args.id);
        if (current === undefined || current.status === "backlog") {
          return failure(new TaskError("Unknown task", 404));
        }
        if (current.status === "done") {
          return failure(
            new TaskError("Task is done; use task_reopen with a reason to reopen it", 409),
          );
        }
        if (current.status === "proposed") {
          return failure(new TaskError("Task is not open; a proposal must be approved first", 409));
        }
        if (current.status !== "working") {
          return failure(new TaskError("Only a working task can be released", 409));
        }
        const parsed = parseReleaseReason(args.reason);
        if (!parsed.ok) return failure(new TaskError(parsed.error, 400));
        try {
          const ledger = await bridge.store.update(args.id, {
            status: "open",
            releaseReason: parsed.reason,
          });
          bridge.publish(ledger);
          const task = ledger.tasks.find((item) => item.id === args.id);
          return {
            output: [
              {
                type: "text",
                text: `${args.id} open ${task?.title ?? current.title}\nreleased: ${parsed.reason}`,
              },
            ],
          };
        } catch (error) {
          return failure(error);
        }
      },
    }),
    defineTool({
      name: "task_edit",
      description:
        "Edit an existing task's title, body or project. The body is free markdown shown under the title in the tasks page; pass an empty string to clear it. A title cannot be empty.",
      parameters: editSchema,
      async execute(args) {
        const current = bridge.store.ledger().tasks.find((task) => task.id === args.id);
        if (current === undefined || current.status === "backlog") {
          return failure(new TaskError("Unknown task", 404));
        }
        const patch: { title?: string; body?: string; project?: string | null } = {};
        if (args.title !== undefined) patch.title = args.title;
        if (args.body !== undefined) patch.body = args.body;
        if (args.project !== undefined) patch.project = args.project;
        return changed(bridge, () => bridge.store.update(args.id, patch));
      },
    }),
    createProposeTaskTool(bridge),
    defineTool({
      name: "task_block",
      description:
        "Create a new open task and make it a blocker for the given task. Existing blockers stay. A done blocker no longer blocks. This cannot create a task that does not block something.",
      parameters: blockSchema,
      async execute(args) {
        const current = bridge.store.ledger().tasks.find((task) => task.id === args.id);
        if (current === undefined || current.status === "backlog") {
          return failure(new TaskError("Unknown task", 404));
        }
        return changed(bridge, () =>
          bridge.store.addBlocker(args.id, args.title, args.project, args.body),
        );
      },
    }),
  ];
}
