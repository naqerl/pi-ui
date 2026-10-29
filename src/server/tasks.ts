import { randomInt } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { blockerClosesCycle, descendantIds, hasOpenDescendant } from "../shared/tasks.js";
import type { Task, TaskLedger, TaskStatus } from "../shared/types.js";

const ALPHABET = "abcdefghijkmnopqrstuvwxyz23456789";
const TASK_LIMIT = 500;

export class TaskError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "TaskError";
  }
}

function cloneTask(task: Task): Task {
  return {
    ...task,
    blockedBy: [...task.blockedBy],
    ...(task.attachments === undefined ? {} : { attachments: [...task.attachments] }),
  };
}

function newId(taken: Set<string>): string {
  for (let length = 4; length <= 8; length++) {
    for (let attempt = 0; attempt < 8; attempt++) {
      let id = "";
      for (let index = 0; index < length; index++) id += ALPHABET[randomInt(ALPHABET.length)];
      if (!taken.has(id)) return id;
    }
  }
  throw new TaskError("Could not allocate a task id", 500);
}

function isTask(value: unknown): value is Task {
  if (typeof value !== "object" || value === null) return false;
  const task = value as Record<string, unknown>;
  return (
    typeof task.id === "string" &&
    task.id.length > 0 &&
    task.id.length <= 16 &&
    typeof task.title === "string" &&
    (task.status === "open" || task.status === "done") &&
    (task.parentId === null || typeof task.parentId === "string") &&
    Array.isArray(task.blockedBy) &&
    task.blockedBy.every((id) => typeof id === "string") &&
    typeof task.createdAt === "string" &&
    (task.attachments === undefined ||
      (Array.isArray(task.attachments) && task.attachments.every((id) => typeof id === "string")))
  );
}

function sanitize(tasks: Task[]): Task[] {
  const ids = new Set(tasks.map((task) => task.id));
  return tasks.map((task) => ({
    ...task,
    parentId: task.parentId !== null && ids.has(task.parentId) ? task.parentId : null,
    blockedBy: [...new Set(task.blockedBy.filter((id) => id !== task.id && ids.has(id)))],
  }));
}

/** Durable todo ledger at `DATA_DIR/tasks.json`. One list, shared by every client. */
export class TaskStore {
  private tasks: Task[] = [];
  private revision = 0;
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly file: string) {}

  ledger(): TaskLedger {
    return { tasks: this.tasks.map(cloneTask), revision: this.revision };
  }

  async load(): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(this.file, "utf8"));
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error ? error.code : "";
      if (code === "ENOENT") return;
      console.error("[pi] tasks.json could not be read; starting from an empty list", error);
      return;
    }
    if (typeof parsed !== "object" || parsed === null) return;
    const record = parsed as Record<string, unknown>;
    const tasks = Array.isArray(record.tasks) ? record.tasks.filter(isTask).map(cloneTask) : [];
    this.tasks = sanitize(tasks);
    const revision = record.revision;
    this.revision =
      typeof revision === "number" && Number.isInteger(revision) && revision >= 0 ? revision : 0;
  }

  create(
    title: string,
    parentId: string | null,
    attachments: readonly string[] = [],
  ): Promise<TaskLedger> {
    const text = title.trim();
    if (text.length === 0) return Promise.reject(new TaskError("Task title is required", 400));
    return this.commit((tasks) => {
      if (tasks.length >= TASK_LIMIT) throw new TaskError("Task list is full", 400);
      if (parentId !== null) {
        const parent = tasks.find((task) => task.id === parentId);
        if (parent === undefined) throw new TaskError("Unknown task", 404);
        if (parent.status === "done") throw new TaskError("Task is done", 409);
      }
      const task: Task = {
        id: newId(new Set(tasks.map((item) => item.id))),
        title: text,
        status: "open",
        parentId,
        blockedBy: [],
        createdAt: new Date().toISOString(),
        ...(attachments.length > 0 ? { attachments: [...attachments] } : {}),
      };
      return [...tasks, task];
    });
  }

  /** Create a new open task and append it to `id`'s blockers. */
  addBlocker(id: string, title: string): Promise<TaskLedger> {
    const text = title.trim();
    if (text.length === 0) return Promise.reject(new TaskError("Task title is required", 400));
    return this.commit((tasks) => {
      const index = tasks.findIndex((task) => task.id === id);
      const current = tasks[index];
      if (current === undefined) throw new TaskError("Unknown task", 404);
      if (tasks.length >= TASK_LIMIT) throw new TaskError("Task list is full", 400);
      const blocker: Task = {
        id: newId(new Set(tasks.map((item) => item.id))),
        title: text,
        status: "open",
        parentId: null,
        blockedBy: [],
        createdAt: new Date().toISOString(),
      };
      const withBlocker = [...tasks, blocker];
      const next = {
        ...current,
        blockedBy: normalizeBlockers(withBlocker, id, [...current.blockedBy, blocker.id]),
      };
      const copy = withBlocker.slice();
      copy[index] = next;
      return copy;
    });
  }

  update(id: string, patch: { status?: TaskStatus; blockedBy?: string[] }): Promise<TaskLedger> {
    if (patch.status === undefined && patch.blockedBy === undefined) {
      return Promise.reject(new TaskError("Nothing to update", 400));
    }
    return this.commit((tasks) => {
      const index = tasks.findIndex((task) => task.id === id);
      const current = tasks[index];
      if (current === undefined) throw new TaskError("Unknown task", 404);
      let next = current;
      if (patch.status !== undefined) {
        if (patch.status !== "open" && patch.status !== "done") {
          throw new TaskError('Status must be "open" or "done"', 400);
        }
        // A parent stays open until every subtask is done, same as kata's close rule.
        if (patch.status === "done" && hasOpenDescendant(tasks, id)) {
          throw new TaskError("Open subtasks", 409);
        }
        next = { ...next, status: patch.status };
      }
      if (patch.blockedBy !== undefined) {
        next = { ...next, blockedBy: normalizeBlockers(tasks, id, patch.blockedBy) };
      }
      const copy = tasks.slice();
      copy[index] = next;
      return copy;
    });
  }

  remove(id: string): Promise<TaskLedger> {
    return this.commit((tasks) => {
      if (!tasks.some((task) => task.id === id)) throw new TaskError("Unknown task", 404);
      const drop = descendantIds(tasks, id);
      drop.add(id);
      return tasks
        .filter((task) => !drop.has(task.id))
        .map((task) => ({
          ...task,
          blockedBy: task.blockedBy.filter((blocker) => !drop.has(blocker)),
        }));
    });
  }

  private commit(change: (tasks: Task[]) => Task[]): Promise<TaskLedger> {
    const run = this.chain.then(async () => {
      const previous = this.tasks;
      const previousRevision = this.revision;
      const next = change(previous.map(cloneTask));
      this.tasks = next;
      this.revision += 1;
      try {
        await this.save();
      } catch (error) {
        this.tasks = previous;
        this.revision = previousRevision;
        throw error;
      }
      return this.ledger();
    });
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async save(): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.${randomInt(1_000_000_000)}.tmp`;
    const body = `${JSON.stringify({ revision: this.revision, tasks: this.tasks })}\n`;
    await writeFile(temporary, body, "utf8");
    await rename(temporary, this.file);
  }
}

function normalizeBlockers(
  tasks: readonly Task[],
  id: string,
  blockedBy: readonly unknown[],
): string[] {
  const ids = new Set(tasks.map((task) => task.id));
  const next: string[] = [];
  for (const entry of blockedBy) {
    if (typeof entry !== "string" || entry.length === 0) {
      throw new TaskError("Blockers must be task ids", 400);
    }
    if (!ids.has(entry)) throw new TaskError("Unknown blocker", 400);
    if (next.includes(entry)) continue;
    if (blockerClosesCycle(tasks, id, entry)) throw new TaskError("Blockers would cycle", 409);
    next.push(entry);
  }
  return next;
}
