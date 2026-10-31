import { randomInt } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { blockerClosesCycle, descendantIds, hasOpenDescendant } from "../shared/tasks.js";
import type { Task, TaskCompletion, TaskLedger, TaskStatus } from "../shared/types.js";
import { clampPushText, MAX_BODY_CHARS, notify, type PushNotification } from "./push.js";

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

/** Older ledgers also stored self-reported time and tokens; only the evidence is kept. */
function readCompletion(value: unknown): TaskCompletion | null {
  if (typeof value !== "object" || value === null) return null;
  const evidence = (value as Record<string, unknown>).evidence;
  return typeof evidence === "string" ? { evidence } : null;
}

function cloneTask(task: Task): Task {
  return {
    ...task,
    blockedBy: [...task.blockedBy],
    ...(task.attachments === undefined ? {} : { attachments: [...task.attachments] }),
    completedAt: typeof task.completedAt === "string" ? task.completedAt : null,
    completion: readCompletion(task.completion),
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
    (task.status === "open" || task.status === "done" || task.status === "proposed") &&
    (task.parentId === null || typeof task.parentId === "string") &&
    Array.isArray(task.blockedBy) &&
    task.blockedBy.every((id) => typeof id === "string") &&
    typeof task.createdAt === "string" &&
    (task.proposedAt === undefined ||
      task.proposedAt === null ||
      typeof task.proposedAt === "string") &&
    (task.rationale === undefined || typeof task.rationale === "string") &&
    (task.attachments === undefined ||
      (Array.isArray(task.attachments) &&
        task.attachments.every((id) => typeof id === "string"))) &&
    (task.completedAt === undefined ||
      task.completedAt === null ||
      typeof task.completedAt === "string") &&
    (task.completion === undefined ||
      task.completion === null ||
      readCompletion(task.completion) !== null)
  );
}

function sanitize(tasks: Task[]): Task[] {
  const ids = new Set(tasks.map((task) => task.id));
  return tasks.map((task) => {
    const proposed = task.status === "proposed";
    return {
      ...task,
      parentId: proposed
        ? null
        : task.parentId !== null && ids.has(task.parentId)
          ? task.parentId
          : null,
      blockedBy: proposed
        ? []
        : [...new Set(task.blockedBy.filter((id) => id !== task.id && ids.has(id)))],
    };
  });
}

export type TaskNotifier = (notification: PushNotification) => Promise<void> | void;

export interface TaskStoreOptions {
  /** Where a status change is announced. Tests replace the web push sender. */
  readonly notify?: TaskNotifier;
}

const defaultTaskNotifier: TaskNotifier = async (notification) => {
  await notify(notification);
};

/** Durable todo ledger at `DATA_DIR/tasks.json`. One list, shared by every client. */
export class TaskStore {
  private tasks: Task[] = [];
  private revision = 0;
  private chain: Promise<void> = Promise.resolve();
  private readonly notifyTask: TaskNotifier;

  constructor(
    private readonly file: string,
    options: TaskStoreOptions = {},
  ) {
    this.notifyTask = options.notify ?? defaultTaskNotifier;
  }

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
        if (parent.status === "proposed") {
          throw new TaskError("Task is not open; a proposal must be approved first", 409);
        }
      }
      const task: Task = {
        id: newId(new Set(tasks.map((item) => item.id))),
        title: text,
        status: "open",
        parentId,
        blockedBy: [],
        createdAt: new Date().toISOString(),
        completedAt: null,
        completion: null,
        ...(attachments.length > 0 ? { attachments: [...attachments] } : {}),
      };
      return [...tasks, task];
    });
  }

  /** Record a task idea for human approval. It is not open work until approved. */
  propose(
    title: string,
    rationale: string,
    attachments: readonly string[] = [],
  ): Promise<TaskLedger> {
    const text = title.trim();
    if (text.length === 0) return Promise.reject(new TaskError("Task title is required", 400));
    const reason = typeof rationale === "string" ? rationale.trim() : "";
    if (reason.length < 20) {
      return Promise.reject(
        new TaskError(
          "A proposal needs a rationale of at least 20 characters so a human can judge why it is worth doing",
          400,
        ),
      );
    }
    return this.commit((tasks) => {
      if (tasks.length >= TASK_LIMIT) throw new TaskError("Task list is full", 400);
      const now = new Date().toISOString();
      const task: Task = {
        id: newId(new Set(tasks.map((item) => item.id))),
        title: text,
        status: "proposed",
        parentId: null,
        blockedBy: [],
        createdAt: now,
        proposedAt: now,
        rationale: reason,
        completedAt: null,
        completion: null,
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
        completedAt: null,
        completion: null,
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

  update(
    id: string,
    patch: { status?: TaskStatus; blockedBy?: string[]; completion?: TaskCompletion },
  ): Promise<TaskLedger> {
    if (patch.status === undefined && patch.blockedBy === undefined) {
      return Promise.reject(new TaskError("Nothing to update", 400));
    }
    return this.commit((tasks) => {
      const index = tasks.findIndex((task) => task.id === id);
      const current = tasks[index];
      if (current === undefined) throw new TaskError("Unknown task", 404);
      let next = current;
      if (patch.status !== undefined) {
        if (patch.status !== "open" && patch.status !== "done" && patch.status !== "proposed") {
          throw new TaskError('Status must be "open", "done" or "proposed"', 400);
        }
        if (patch.status === "proposed" && current.status !== "proposed") {
          throw new TaskError("Only a proposal can be moved to proposed", 409);
        }
        if (patch.status === "done" && current.status === "proposed") {
          throw new TaskError("Task is not open; a proposal must be approved first", 409);
        }
        // A parent stays open until every subtask is done, same as kata's close rule.
        if (patch.status === "done" && hasOpenDescendant(tasks, id)) {
          throw new TaskError("Open subtasks", 409);
        }
        if (patch.status === "done") {
          next = {
            ...next,
            status: "done",
            completedAt:
              current.status === "done" && current.completedAt !== null
                ? current.completedAt
                : new Date().toISOString(),
            // A human closing a task may not leave evidence; keep what was there.
            completion:
              patch.completion === undefined
                ? current.status === "done"
                  ? current.completion
                  : null
                : { ...patch.completion },
          };
        } else if (patch.status === "proposed") {
          next = {
            ...next,
            status: "proposed",
            parentId: null,
            blockedBy: [],
            proposedAt: current.proposedAt ?? new Date().toISOString(),
            completedAt: null,
            completion: null,
          };
        } else {
          next = {
            ...next,
            status: "open",
            completedAt: null,
            completion: null,
            ...(current.status === "proposed" ? { proposedAt: null } : {}),
          };
        }
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
      await this.announce(previous, this.tasks);
      return this.ledger();
    });
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** One push when a proposal appears or a task moves to done; a repeat write stays quiet. */
  private async announce(previous: readonly Task[], next: readonly Task[]): Promise<void> {
    const before = new Map(previous.map((task) => [task.id, task]));
    const notifications: PushNotification[] = [];
    for (const task of next) {
      const old = before.get(task.id);
      if (task.status === "proposed" && old?.status !== "proposed") {
        notifications.push({
          title: "New proposal",
          body: clampPushText(task.title, MAX_BODY_CHARS),
          tag: task.id,
          url: "/tasks",
        });
      } else if (task.status === "done" && old !== undefined && old.status !== "done") {
        notifications.push({
          title: "Task done",
          body: clampPushText(task.title, MAX_BODY_CHARS),
          tag: task.id,
          url: "/tasks",
        });
      }
    }
    await Promise.all(
      notifications.map(async (notification) => {
        try {
          await this.notifyTask(notification);
        } catch (error) {
          // A push failure must never fail the write that caused it.
          console.error(`[pi] task push failed for ${notification.tag}:`, error);
        }
      }),
    );
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
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const next: string[] = [];
  for (const entry of blockedBy) {
    if (typeof entry !== "string" || entry.length === 0) {
      throw new TaskError("Blockers must be task ids", 400);
    }
    const blocker = byId.get(entry);
    if (blocker === undefined) throw new TaskError("Unknown blocker", 400);
    // A proposal is not work, so it can never gate another task.
    if (blocker.status === "proposed") continue;
    if (next.includes(entry)) continue;
    if (blockerClosesCycle(tasks, id, entry)) throw new TaskError("Blockers would cycle", 409);
    next.push(entry);
  }
  return next;
}
