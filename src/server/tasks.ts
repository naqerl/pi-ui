import { randomInt } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { OperatorNoticeRecord } from "../shared/notices.js";
import { normalizeProject, PROJECT_MAX_LENGTH, sameProject } from "../shared/project.js";
import {
  blockerClosesCycle,
  descendantIds,
  hasOpenDescendant,
  TASK_BODY_MAX_LENGTH,
} from "../shared/tasks.js";
import type { Task, TaskCompletion, TaskLedger, TaskStatus } from "../shared/types.js";
import { clampPushText, MAX_BODY_CHARS, notify, type PushNotification } from "./push.js";

const ALPHABET = "abcdefghijkmnopqrstuvwxyz23456789";
const TASK_LIMIT = 500;
/** Changes closer together than this become one push notification. */
export const TASK_PUSH_WINDOW_MS = 3_000;
/** A burst replaces the previous burst notification instead of piling up. */
export const TASK_PUSH_TAG = "ledger";

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

/**
 * The project a task gets: `undefined` falls back to `inherited`, null clears it, and a
 * string must be a valid project name.
 */
function chooseProject(
  value: string | null | undefined,
  tasks: readonly Task[],
  inherited?: string,
): string | undefined {
  if (value === undefined) return inherited;
  if (value === null) return undefined;
  const name = normalizeProject(value);
  if (name === null) {
    throw new TaskError(
      `Project must be a short name (letters, digits, . _ -, up to ${PROJECT_MAX_LENGTH} characters)`,
      400,
    );
  }
  // Reuse an existing spelling so `PI-UI` and `pi-ui` stay one project.
  return (
    tasks.find((task) => task.project !== undefined && sameProject(task.project, name))?.project ??
    name
  );
}

function withProject(task: Task, project: string | undefined): Task {
  const { project: _drop, ...rest } = task;
  return project === undefined ? rest : { ...rest, project };
}

function withBody(task: Task, body: string | undefined): Task {
  const { body: _drop, ...rest } = task;
  return body === undefined ? rest : { ...rest, body };
}

/** A title the ledger can store, or a 400 that names the field. */
function normalizeTitle(value: unknown): string {
  if (typeof value !== "string") throw new TaskError("title must be a string", 400);
  const title = value.trim();
  if (title.length === 0) throw new TaskError("title must not be empty", 400);
  return title;
}

/** A trimmed body, or undefined for an empty one, with the length cap enforced. */
function normalizeBody(value: unknown): string | undefined {
  if (typeof value !== "string") throw new TaskError("body must be a string", 400);
  const body = value.trim();
  if (body.length > TASK_BODY_MAX_LENGTH) {
    throw new TaskError(`body must be at most ${TASK_BODY_MAX_LENGTH} characters`, 400);
  }
  return body.length === 0 ? undefined : body;
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
    (task.status === "open" ||
      task.status === "done" ||
      task.status === "proposed" ||
      task.status === "backlog") &&
    (task.parentId === null || typeof task.parentId === "string") &&
    Array.isArray(task.blockedBy) &&
    task.blockedBy.every((id) => typeof id === "string") &&
    typeof task.createdAt === "string" &&
    (task.proposedAt === undefined ||
      task.proposedAt === null ||
      typeof task.proposedAt === "string") &&
    (task.rationale === undefined || typeof task.rationale === "string") &&
    (task.body === undefined || typeof task.body === "string") &&
    (task.project === undefined || typeof task.project === "string") &&
    (task.lastWorkedAt === undefined ||
      task.lastWorkedAt === null ||
      typeof task.lastWorkedAt === "string") &&
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
    const project = normalizeProject(task.project) ?? undefined;
    const body = typeof task.body === "string" ? task.body.trim() : "";
    return withBody(
      {
        ...withProject(task, project),
        parentId: proposed
          ? null
          : task.parentId !== null && ids.has(task.parentId)
            ? task.parentId
            : null,
        blockedBy: proposed
          ? []
          : [...new Set(task.blockedBy.filter((id) => id !== task.id && ids.has(id)))],
      },
      body.length > 0 && body.length <= TASK_BODY_MAX_LENGTH ? body : undefined,
    );
  });
}

export type TaskNotifier = (notification: PushNotification) => Promise<void> | void;

/** Where a proposal decision is recorded as a persistent notice in the chat. */
export type TaskNoticeRecorder = (record: OperatorNoticeRecord) => Promise<void> | void;

export interface TaskStoreOptions {
  /** Where a status change is announced. Tests replace the web push sender. */
  readonly notify?: TaskNotifier;
  /** Where a proposal approval or decline is recorded as an operator notice. */
  readonly notice?: TaskNoticeRecorder;
  /** Alias for callers that name the chat method. */
  readonly recordOperatorNotice?: TaskNoticeRecorder;
  /** Alias for callers that describe the recorded action. */
  readonly recordNotice?: TaskNoticeRecorder;
  /** How long a burst may keep growing before it is sent. Zero disables coalescing. */
  readonly pushWindowMs?: number;
  /** Alias for callers that describe the window as a burst window. */
  readonly burstWindowMs?: number;
  /** Alias for callers that describe the wait as a coalescing window. */
  readonly coalesceMs?: number;
  /** Alias for callers that describe the wait as a plain window. */
  readonly windowMs?: number;
}

type PendingTaskKind = "proposal" | "done" | "approved" | "declined";

interface PendingTaskChange {
  readonly task: Task;
  readonly kind: PendingTaskKind;
}

function pushTitle(kind: PendingTaskKind): string {
  switch (kind) {
    case "proposal":
      return "New proposal";
    case "done":
      return "Task done";
    case "approved":
      return "Proposal approved";
    case "declined":
      return "Proposal declined";
  }
}

/** A decision is shown in the chat but never rings the operator's phone. */
function pushes(kind: PendingTaskKind): kind is "proposal" | "done" {
  return kind === "proposal" || kind === "done";
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
  private readonly recordTaskNotice: TaskNoticeRecorder | undefined;
  private readonly pushWindowMs: number;
  private queuedCommits = 0;
  private pendingChanges = new Map<string, PendingTaskChange>();
  private flushTimer: NodeJS.Timeout | undefined;
  private flushing: Promise<void> | undefined;

  constructor(
    private readonly file: string,
    options: TaskStoreOptions = {},
  ) {
    this.notifyTask = options.notify ?? defaultTaskNotifier;
    this.recordTaskNotice = options.notice ?? options.recordOperatorNotice ?? options.recordNotice;
    this.pushWindowMs =
      options.pushWindowMs ??
      options.burstWindowMs ??
      options.coalesceMs ??
      options.windowMs ??
      TASK_PUSH_WINDOW_MS;
  }

  ledger(): TaskLedger {
    return { tasks: this.tasks.map(cloneTask), revision: this.revision };
  }

  /**
   * Remember that a tool call tagged this task. Only open work is touched: a closed task keeps
   * its empty stamp, and a tagged call that finishes after `task_done` must not revive it.
   */
  noteWorked(id: string, at: number | string | Date = Date.now()): Promise<TaskLedger> {
    const date = at instanceof Date ? at : new Date(at);
    if (!Number.isFinite(date.getTime())) return Promise.reject(new TaskError("Invalid time", 400));
    const stamp = date.toISOString();
    return this.commit((tasks) => {
      const index = tasks.findIndex((task) => task.id === id);
      const current = tasks[index];
      if (current === undefined || current.status !== "open") return tasks;
      if (current.lastWorkedAt === stamp) return tasks;
      const copy = tasks.slice();
      copy[index] = { ...current, lastWorkedAt: stamp };
      return copy;
    });
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
    project?: string | null,
    body?: string | null,
    mode?: TaskStatus | { status?: TaskStatus; backlog?: boolean } | boolean,
  ): Promise<TaskLedger> {
    const text = title.trim();
    if (text.length === 0) return Promise.reject(new TaskError("Task title is required", 400));
    let content: string | undefined;
    try {
      content = body === undefined || body === null ? undefined : normalizeBody(body);
    } catch (error) {
      return Promise.reject(error);
    }
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
      const parent = parentId === null ? undefined : tasks.find((item) => item.id === parentId);
      const name = chooseProject(project, tasks, parent?.project);
      const status = createStatus(mode);
      const task: Task = {
        id: newId(new Set(tasks.map((item) => item.id))),
        title: text,
        status,
        parentId,
        blockedBy: [],
        createdAt: new Date().toISOString(),
        completedAt: null,
        completion: null,
        ...(attachments.length > 0 ? { attachments: [...attachments] } : {}),
        ...(name === undefined ? {} : { project: name }),
        ...(content === undefined ? {} : { body: content }),
      };
      return [...tasks, task];
    });
  }

  /** Record a task idea for human approval. It is not open work until approved. */
  propose(
    title: string,
    rationale: string,
    attachments: readonly string[] = [],
    project?: string | null,
    body?: string | null,
  ): Promise<TaskLedger> {
    const text = title.trim();
    if (text.length === 0) return Promise.reject(new TaskError("Task title is required", 400));
    const reason = typeof rationale === "string" ? rationale.trim() : "";
    let content: string | undefined;
    try {
      content = body === undefined || body === null ? undefined : normalizeBody(body);
    } catch (error) {
      return Promise.reject(error);
    }
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
      const name = chooseProject(project, tasks);
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
        ...(name === undefined ? {} : { project: name }),
        ...(content === undefined ? {} : { body: content }),
      };
      return [...tasks, task];
    });
  }

  /** Create a new open task and append it to `id`'s blockers. */
  addBlocker(
    id: string,
    title: string,
    project?: string | null,
    body?: string | null,
  ): Promise<TaskLedger> {
    const text = title.trim();
    if (text.length === 0) return Promise.reject(new TaskError("Task title is required", 400));
    let content: string | undefined;
    try {
      content = body === undefined || body === null ? undefined : normalizeBody(body);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.commit((tasks) => {
      const index = tasks.findIndex((task) => task.id === id);
      const current = tasks[index];
      if (current === undefined) throw new TaskError("Unknown task", 404);
      if (tasks.length >= TASK_LIMIT) throw new TaskError("Task list is full", 400);
      const name = chooseProject(project, tasks, current.project);
      const blocker: Task = {
        id: newId(new Set(tasks.map((item) => item.id))),
        title: text,
        status: "open",
        parentId: null,
        blockedBy: [],
        createdAt: new Date().toISOString(),
        completedAt: null,
        completion: null,
        ...(name === undefined ? {} : { project: name }),
        ...(content === undefined ? {} : { body: content }),
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
    patch: {
      /** A new title; trimmed and refused when empty. */
      title?: string;
      /** Free markdown, or an empty string to clear it. */
      body?: string;
      status?: TaskStatus;
      blockedBy?: string[];
      completion?: TaskCompletion;
      /** A new project name, or null to clear it. */
      project?: string | null;
    },
  ): Promise<TaskLedger> {
    if (
      patch.title === undefined &&
      patch.body === undefined &&
      patch.status === undefined &&
      patch.blockedBy === undefined &&
      patch.project === undefined
    ) {
      return Promise.reject(new TaskError("Nothing to update", 400));
    }
    return this.commit((tasks) => {
      const index = tasks.findIndex((task) => task.id === id);
      const current = tasks[index];
      if (current === undefined) throw new TaskError("Unknown task", 404);
      let next = current;
      if (patch.title !== undefined) {
        next = { ...next, title: normalizeTitle(patch.title) };
      }
      if (patch.body !== undefined) {
        next = withBody(next, normalizeBody(patch.body));
      }
      if (patch.status !== undefined) {
        if (
          patch.status !== "open" &&
          patch.status !== "done" &&
          patch.status !== "proposed" &&
          patch.status !== "backlog"
        ) {
          throw new TaskError('Status must be "open", "done", "proposed" or "backlog"', 400);
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
            lastWorkedAt: null,
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
            lastWorkedAt: null,
          };
        } else {
          next = {
            ...next,
            status: patch.status,
            completedAt: null,
            completion: null,
            // Reopening starts an untouched task; an already-open task keeps its stamp.
            ...(current.status === "open" ? {} : { lastWorkedAt: null }),
            ...(current.status === "proposed" ? { proposedAt: null } : {}),
          };
        }
      }
      if (patch.blockedBy !== undefined) {
        next = { ...next, blockedBy: normalizeBlockers(tasks, id, patch.blockedBy) };
      }
      if (patch.project !== undefined)
        next = withProject(next, chooseProject(patch.project, tasks));
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
    this.queuedCommits += 1;
    const run = this.chain
      .then(async () => {
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
      })
      .finally(() => {
        this.queuedCommits -= 1;
      });
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * One push when a proposal appears or a task moves to done. Approving or
   * declining a proposal records the chat notice only. A repeat write, or
   * deleting anything that was not a proposal, stays quiet.
   */
  private async announce(previous: readonly Task[], next: readonly Task[]): Promise<void> {
    const before = new Map(previous.map((task) => [task.id, task]));
    const present = new Set(next.map((task) => task.id));
    const changes: PendingTaskChange[] = [];
    for (const task of next) {
      const old = before.get(task.id);
      if (old?.status === "proposed" && task.status !== "proposed") {
        // Approving makes it open; approving and completing in one step makes it done.
        changes.push({ task, kind: "approved" });
      } else if (task.status === "proposed" && old?.status !== "proposed") {
        changes.push({ task, kind: "proposal" });
      } else if (task.status === "done" && old !== undefined && old.status !== "done") {
        changes.push({ task, kind: "done" });
      } else if (
        old !== undefined &&
        old.status !== task.status &&
        this.pendingChanges.has(task.id)
      ) {
        // The task left the state that was queued (for example a proposal was
        // approved before the burst flushed), so the old summary would be wrong.
        this.pendingChanges.delete(task.id);
      }
    }
    for (const old of previous) {
      if (old.status !== "proposed" || present.has(old.id)) continue;
      // Deleting a proposal is how a decline is expressed. Cancel its pending
      // "New proposal" entry so the burst cannot describe the old state.
      this.pendingChanges.delete(old.id);
      changes.push({ task: old, kind: "declined" });
    }
    if (changes.length === 0) return;

    await Promise.all(changes.map((change) => this.recordDecisionNotice(change)));

    // A decision stays in the chat. Drop its proposal's pending push, which
    // would otherwise describe a state the ledger has already left.
    const notifiable = changes.filter((change) => {
      if (pushes(change.kind)) return true;
      this.pendingChanges.delete(change.task.id);
      return false;
    });
    if (notifiable.length === 0) return;

    // A write that arrives while another write is already queued belongs to a
    // burst. A lone change still goes out with the write that caused it.
    if (this.pushWindowMs > 0 && (this.pendingChanges.size > 0 || this.queuedCommits > 1)) {
      this.queueBurst(notifiable, next);
      return;
    }

    await Promise.all(notifiable.map((change) => this.sendIndividual(change)));
  }

  private queueBurst(changes: readonly PendingTaskChange[], next: readonly Task[]): void {
    for (const change of changes) this.pendingChanges.set(change.task.id, change);

    // Ledger order, not arrival order, and one entry per task even if it moved twice.
    const ordered = new Map<string, PendingTaskChange>();
    for (const task of next) {
      const change = this.pendingChanges.get(task.id);
      if (change !== undefined) ordered.set(task.id, change);
    }
    // A declined proposal is no longer in the ledger, so it has no ledger position.
    for (const [id, change] of this.pendingChanges) {
      if (change.kind === "declined") ordered.set(id, change);
    }
    this.pendingChanges = ordered;

    if (this.flushTimer !== undefined) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      void this.flushBurst();
    }, this.pushWindowMs);
    this.flushTimer.unref?.();
  }

  private sendIndividual(change: PendingTaskChange): Promise<void> {
    return this.deliver({
      title: pushTitle(change.kind),
      body: clampPushText(change.task.title, MAX_BODY_CHARS),
      tag: change.task.id,
      url: "/tasks",
    });
  }

  private async recordDecisionNotice(change: PendingTaskChange): Promise<void> {
    if (change.kind !== "approved" && change.kind !== "declined") return;
    if (this.recordTaskNotice === undefined) return;
    const approved = change.kind === "approved";
    try {
      await this.recordTaskNotice({
        title: pushTitle(change.kind),
        body: `${pushTitle(change.kind)}: ${change.task.title}`,
        reason: approved
          ? "A human approved this proposal on the tasks page."
          : "A human declined this proposal on the tasks page.",
      });
    } catch (error) {
      // A notice failure must never fail the ledger write that caused it.
      console.error(`[pi] task notice failed for ${change.task.id}:`, error);
    }
  }

  private async deliver(notification: PushNotification): Promise<void> {
    try {
      await this.notifyTask(notification);
    } catch (error) {
      // A push failure must never fail the write that caused it.
      console.error(`[pi] task push failed for ${notification.tag}:`, error);
    }
  }

  /** Sends the accumulated burst once its window closes. */
  private flushBurst(): Promise<void> {
    if (this.flushTimer !== undefined) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    const changes = [...this.pendingChanges.values()];
    this.pendingChanges.clear();
    if (changes.length === 0) return Promise.resolve();
    const run =
      changes.length === 1
        ? this.sendIndividual(changes[0] as PendingTaskChange)
        : this.sendBurst(changes);
    this.flushing = run;
    return run.finally(() => {
      if (this.flushing === run) this.flushing = undefined;
    });
  }

  private sendBurst(changes: readonly PendingTaskChange[]): Promise<void> {
    const body = clampPushText(
      changes.map((change) => `${pushTitle(change.kind)}: ${change.task.title}`).join(" · "),
      MAX_BODY_CHARS,
    );
    return this.deliver({
      title: `${changes.length} task${changes.length === 1 ? "" : "s"} updated`,
      body: body || "Ledger updated",
      tag: TASK_PUSH_TAG,
      url: "/tasks",
    });
  }

  /** Flushes a pending burst so shutdown does not silently drop it. */
  async flush(): Promise<void> {
    await this.flushBurst();
    await this.flushing;
  }

  /** Alias with the plural that reads naturally at shutdown call sites. */
  flushNotifications(): Promise<void> {
    return this.flush();
  }

  async close(): Promise<void> {
    await this.flush();
  }

  private async save(): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.${randomInt(1_000_000_000)}.tmp`;
    const body = `${JSON.stringify({ revision: this.revision, tasks: this.tasks })}\n`;
    await writeFile(temporary, body, "utf8");
    await rename(temporary, this.file);
  }
}

/** Resolve the create API's status, `backlog` boolean, or options object. */
function createStatus(
  mode: TaskStatus | { status?: TaskStatus; backlog?: boolean } | boolean | undefined,
): TaskStatus {
  const status =
    mode === undefined
      ? "open"
      : typeof mode === "boolean"
        ? mode
          ? "backlog"
          : "open"
        : typeof mode === "string"
          ? mode
          : (mode.status ?? (mode.backlog === true ? "backlog" : "open"));
  if (status !== "open" && status !== "backlog") {
    throw new TaskError('A new task must be "open" or "backlog"', 400);
  }
  return status;
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
