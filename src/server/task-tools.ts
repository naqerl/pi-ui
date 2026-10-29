import {
  defineTool,
  type ToolExecutionResult,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { compareTasks, liveBlockerIds } from "../shared/tasks.js";
import type { Task, TaskLedger } from "../shared/types.js";
import { TaskError, type TaskStore } from "./tasks.js";

/** The process-wide ledger and the hook that tells open browsers it changed. */
export interface TaskBridge {
  readonly store: TaskStore;
  publish(ledger: TaskLedger): void;
}

const idSchema = Type.Object({
  id: Type.String({ description: "Task id from task_list." }),
});

const blockSchema = Type.Object({
  id: Type.String({ description: "Task id that this blocker gates." }),
  title: Type.String({ description: "Title of the new blocker task." }),
});

function formatLedger(ledger: TaskLedger): string {
  const lines = [`revision ${ledger.revision}`];
  const ids = new Set(ledger.tasks.map((task) => task.id));
  const write = (task: Task, depth: number) => {
    const live = liveBlockerIds(ledger.tasks, task);
    const blocked = live.length > 0 ? ` blocked-by=${live.join(",")}` : "";
    const title = task.title.replace(/\s+/g, " ").trim();
    lines.push(`${"  ".repeat(depth)}${task.id} ${task.status}${blocked} ${title}`);
    const children = ledger.tasks
      .filter((item) => item.parentId === task.id)
      .sort((a, b) => compareTasks(ledger.tasks, a, b));
    for (const child of children) write(child, depth + 1);
  };
  const roots = ledger.tasks
    .filter((task) => task.parentId === null || !ids.has(task.parentId))
    .sort((a, b) => compareTasks(ledger.tasks, a, b));
  if (roots.length === 0) lines.push("(empty)");
  for (const root of roots) write(root, 0);
  return lines.join("\n");
}

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
        "List the shared todo ledger: id, status, live blockers, and title. Ready tasks come first, then blocked, then done. A done blocker is omitted.",
      parameters: Type.Object({}),
      async execute() {
        return { output: [{ type: "text", text: formatLedger(bridge.store.ledger()) }] };
      },
    }),
    defineTool({
      name: "task_done",
      description:
        "Mark one task done. A task with an open subtask cannot be marked done. This cannot reopen a task or edit its title.",
      parameters: idSchema,
      async execute(args) {
        return changed(bridge, () => bridge.store.update(args.id, { status: "done" }));
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
