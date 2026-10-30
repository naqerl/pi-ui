import {
  defineTool,
  type ToolExecutionResult,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { Type } from "typebox";
import {
  compareTasks,
  formatTokenCount,
  liveBlockerIds,
  parseCompletion,
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

const blockSchema = Type.Object({
  id: Type.String({ description: "Task id that this blocker gates." }),
  title: Type.String({ description: "Title of the new blocker task." }),
});

const proposeSchema = Type.Object({
  title: Type.String({ description: "Title of the proposed task." }),
  rationale: Type.String({
    description:
      "Why this task is worth doing, in one or two sentences. At least 20 characters; a human uses it to decide.",
  }),
  attachments: Type.Optional(
    Type.Array(Type.String({ description: "Media id to attach to the proposal." })),
  ),
});

const doneSchema = Type.Object({
  id: Type.String({ description: "Task id from task_list." }),
  timeSpent: Type.Union([
    Type.String({ description: "How long the work took: ~25m, 2h, 1h40m or 45." }),
    Type.Number({ description: "Minutes spent, as a positive number." }),
  ]),
  tokens: Type.Number({ description: "Input plus output tokens spent; a non-negative integer." }),
  evidence: Type.String({
    description: "A commit sha, file path, screenshot path or sentence a reviewer can check.",
  }),
});

function taskCost(task: Task): string {
  if (task.status !== "done" || task.completion == null) return "";
  return ` · ${task.completion.timeSpentText} · ${formatTokenCount(task.completion.tokens)} tok`;
}

function formatLedger(ledger: TaskLedger): string {
  const lines = [`revision ${ledger.revision}`];
  const active = ledger.tasks.filter((task) => task.status !== "proposed");
  const ids = new Set(active.map((task) => task.id));
  const write = (task: Task, depth: number) => {
    const live = liveBlockerIds(ledger.tasks, task);
    const blocked = live.length > 0 ? ` blocked-by=${live.join(",")}` : "";
    const title = task.title.replace(/\s+/g, " ").trim();
    const count = task.attachments?.length ?? 0;
    const images = count > 0 ? ` images=${count}` : "";
    lines.push(
      `${"  ".repeat(depth)}${task.id} ${task.status}${blocked}${images}${taskCost(task)} ${title}`,
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
      return `${task.id} ${title}\n  proposed ${proposedAt} (${formatDateTime(proposedAt)})\n  rationale: ${task.rationale ?? ""}`;
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

/** Tools for the same ledger the tasks page edits. Not deferred, so every turn offers them. */
export function createTaskTools(bridge: TaskBridge): ToolRegistration[] {
  return [
    defineTool({
      name: "task_list",
      description:
        "List the shared todo ledger: id, status, live blockers, attached image count, and title. Ready tasks come first, then blocked, then done. A done blocker is omitted. Proposals are not work and appear only as a waiting count; use task_proposals to read them. Use task_view to see a task's images.",
      parameters: Type.Object({}),
      async execute() {
        return { output: [{ type: "text", text: formatLedger(bridge.store.ledger()) }] };
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
        "Show one task in full: its title, status, blockers, and the images attached to it when it was created.",
      parameters: idSchema,
      async execute(args) {
        const task = bridge.store.ledger().tasks.find((item) => item.id === args.id);
        if (task === undefined) return failure(new TaskError("Unknown task", 404));
        const ids = task.attachments ?? [];
        const completion = task.status === "done" ? (task.completion ?? null) : null;
        const header = [
          `${task.id} ${task.status}${task.parentId === null ? "" : ` parent=${task.parentId}`}`,
          task.blockedBy.length > 0 ? `blocked-by=${task.blockedBy.join(",")}` : "",
          task.title,
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
                `time spent ${completion.timeSpentText} (${completion.timeSpentMinutes} min)`,
                `tokens ${completion.tokens}`,
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
        "Mark one task done and record what it cost: how long it took, the tokens spent, and where a reviewer can check the work. A task with an open subtask cannot be marked done. This cannot reopen a task or edit its title.",
      parameters: doneSchema,
      async execute(args) {
        const current = bridge.store.ledger().tasks.find((task) => task.id === args.id);
        if (current?.status === "proposed") {
          return failure(new TaskError("Task is not open; a proposal must be approved first", 409));
        }
        const parsed = parseCompletion(args);
        if (!parsed.ok) return failure(new TaskError(parsed.error, 400));
        return changed(bridge, () =>
          bridge.store.update(args.id, { status: "done", completion: parsed.completion }),
        );
      },
    }),
    defineTool({
      name: "propose_task",
      description:
        "Propose a task for human approval. A proposal is not a task: it does not appear in task_list and cannot be worked on until a human approves it.",
      parameters: proposeSchema,
      async execute(args) {
        return changed(bridge, () =>
          bridge.store.propose(args.title, args.rationale, args.attachments ?? []),
        );
      },
    }),
    defineTool({
      name: "task_block",
      description:
        "Create a new open task and make it a blocker for the given task. Existing blockers stay. A done blocker no longer blocks. This cannot create a task that does not block something.",
      parameters: blockSchema,
      async execute(args) {
        return changed(bridge, () => bridge.store.addBlocker(args.id, args.title));
      },
    }),
  ];
}
