import {
  defineTool,
  type ToolExecutionResult,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { sameProject } from "../shared/project.js";
import {
  compareTasks,
  dependencyCyclePath,
  liveBlockerIds,
  parseCompletion,
  parseReleaseReason,
  parseReopenReason,
  proposedDraftTitle,
  TASK_ATTACHMENTS_MAX,
  TASK_BODY_MAX_LENGTH,
} from "../shared/tasks.js";
import { formatDateTime } from "../shared/time.js";
import type { Task, TaskLedger } from "../shared/types.js";
import { MediaError, type MediaStore, validateAttachmentIds } from "./media.js";
import { TaskError, type TaskStore } from "./tasks.js";

/** Starts the plan run that writes a draft's body. The main chat injects the plan agent here. */
export type PlanSubmitter = (taskId: string, body: string) => Promise<void>;

/** The process-wide ledger and the hook that tells open browsers it changed. */
export interface TaskBridge {
  readonly store: TaskStore;
  /** Where task images live. Without it, task_view returns only the text. */
  readonly media?: MediaStore;
  /** Starts a planning draft's plan run. Without it the draft is saved but stays unplanned. */
  plan?: PlanSubmitter;
  publish(ledger: TaskLedger): void;
}

export interface PlanDraftInput {
  readonly title: string;
  readonly titleFromId?: (id: string) => string;
  readonly parentId?: string | null;
  readonly body?: string | null;
  readonly project?: string | null;
  readonly attachments?: readonly string[];
  readonly createdBy?: NonNullable<Task["createdBy"]>;
}

/** Narrows the shared task tools to the planning agent's project and task. */
export interface TaskToolOptions {
  readonly scope?: { readonly taskId: string };
}

export interface PlanDraft {
  readonly ledger: TaskLedger;
  readonly task: Task;
  readonly started: boolean;
}

/**
 * Saves a task in the planning state and starts the plan run that writes its body.
 * A missing or failing runner leaves the draft in place for the operator to finish.
 * This is the one plan-draft path: the create route and propose_task both call it.
 */
export async function createPlanDraft(
  bridge: TaskBridge,
  input: PlanDraftInput,
): Promise<PlanDraft> {
  const { ledger, task } = await bridge.store.createWithResult(
    input.title,
    input.parentId ?? null,
    input.attachments ?? [],
    input.project,
    input.body ?? input.title,
    {
      status: "planning",
      createdBy: input.createdBy ?? "operator",
      ...(input.titleFromId === undefined ? {} : { titleFromId: input.titleFromId }),
    },
  );
  bridge.publish(ledger);
  if (bridge.plan === undefined) return { ledger, task, started: false };
  try {
    await bridge.plan(task.id, task.body ?? task.title);
    return { ledger, task, started: true };
  } catch (error) {
    console.error(`[pi] could not start the plan run for ${task.id}`, error);
    return { ledger, task, started: false };
  }
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

const dependsSchema = Type.Object({
  id: Type.String({ description: "Task id whose dependencies are being set." }),
  dependsOn: Type.Array(
    Type.String({ description: "Task id that must be implemented and marked done first." }),
  ),
});

const proposeSchema = Type.Object({
  prompt: Type.String({
    description: `The work to plan, written as one prompt. It becomes the draft's body, up to ${TASK_BODY_MAX_LENGTH} characters; the draft is titled \`Proposed <id>\` until its plan agent names it.`,
  }),
  project: projectSchema,
  attachments: Type.Optional(
    Type.Array(Type.String({ description: "Media id to attach to the draft." }), {
      maxItems: TASK_ATTACHMENTS_MAX,
    }),
  ),
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
  attachments: Type.Optional(
    Type.Array(Type.String({ description: "Media id to keep on the task." }), {
      maxItems: TASK_ATTACHMENTS_MAX,
      description:
        "Replaces the task's images with this list, in order. Pass an empty list to remove them all.",
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

function titleOf(task: Task): string {
  return task.title.replace(/\s+/g, " ").trim();
}

/** `depends-on=id[,id(done)]`, naming every stored dependency. */
function dependencyToken(task: Task, byId: ReadonlyMap<string, Task>): string {
  if (task.blockedBy.length === 0) return "";
  const ids = task.blockedBy.map((id) => (byId.get(id)?.status === "done" ? `${id}(done)` : id));
  return ` depends-on=${ids.join(",")}`;
}

function relationLine(label: string, tasks: readonly Task[]): string {
  if (tasks.length === 0) return "";
  return `${label}=${tasks.map((task) => `${task.id} ${task.status} ${titleOf(task)}`).join("; ")}`;
}

function formatScopedLedger(ledger: TaskLedger, project: string | undefined): string {
  const tasks = ledger.tasks.filter(
    (task) =>
      project === undefined || (task.project !== undefined && sameProject(task.project, project)),
  );
  const byId = new Map(ledger.tasks.map((task) => [task.id, task]));
  const lines = [`revision ${ledger.revision}`];
  if (tasks.length === 0) lines.push("(empty)");
  for (const task of [...tasks].sort((a, b) => compareTasks(tasks, a, b))) {
    const dependency = dependencyToken(task, byId);
    const projectTag =
      project === undefined && task.project !== undefined ? ` @${task.project}` : "";
    const approval = task.status === "proposed" ? " (not approved)" : "";
    lines.push(`${task.id} ${task.status}${dependency}${projectTag}${approval} ${titleOf(task)}`);
  }
  return lines.join("\n");
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
  const byId = new Map(ledger.tasks.map((task) => [task.id, task]));
  const write = (task: Task, depth: number) => {
    const dependency = dependencyToken(task, byId);
    const title = titleOf(task);
    const count = task.attachments?.length ?? 0;
    const images = count > 0 ? ` images=${count}` : "";
    const project = task.project === undefined ? "" : ` @${task.project}`;
    lines.push(
      `${"  ".repeat(depth)}${task.id} ${task.status}${dependency}${images}${project} ${title}`,
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
 * It always saves a planning draft whose body is the prompt, titled `Proposed <id>` until
 * its plan agent names it, and starts its plan run so the agent writes the body before
 * the operator approves it.
 */
export function createProposeTaskTool(bridge: TaskBridge): ToolRegistration {
  return defineTool({
    name: "propose_task",
    description:
      "Propose work by describing it as one prompt. Saves a planning draft whose body is the prompt, titled `Proposed <id>` until its plan agent names it, then starts the plan agent that writes its body. The operator approves the draft on the tasks page when it is ready. There is no rationale or flag to pass.",
    parameters: proposeSchema,
    async execute(args) {
      if (args.prompt.trim().length === 0) {
        return failure(new TaskError("prompt must not be empty", 400));
      }
      let attachments: string[] | undefined;
      if (args.attachments !== undefined) {
        if (bridge.media === undefined) {
          return failure(new TaskError("Task images are unavailable", 500));
        }
        try {
          attachments = await validateAttachmentIds(
            bridge.media,
            args.attachments,
            TASK_ATTACHMENTS_MAX,
          );
        } catch (error) {
          return failure(error instanceof MediaError ? new TaskError(error.message, 400) : error);
        }
      }
      try {
        const draft = await createPlanDraft(bridge, {
          title: args.prompt,
          titleFromId: proposedDraftTitle,
          body: args.prompt,
          project: args.project,
          attachments,
          createdBy: "agent",
        });
        return { output: [{ type: "text", text: planDraftText(draft) }] };
      } catch (error) {
        return failure(error);
      }
    },
  });
}

function planDraftText(draft: PlanDraft): string {
  if (draft.started) {
    return `Draft ${draft.task.id} saved as "${draft.task.title}" and its plan run started. The plan agent names the draft and writes the body; the operator approves it on the tasks page when it is ready.`;
  }
  return `Draft ${draft.task.id} is saved as "${draft.task.title}", but its plan run did not start. The operator should name the draft and edit the body on the tasks page before approving it.`;
}

/** Refuse a dependency list before a write: unknown, self, unapproved and cyclic ids. */
function validateDependencies(ledger: TaskLedger, id: string, dependsOn: readonly string[]): void {
  const byId = new Map(ledger.tasks.map((task) => [task.id, task]));
  for (const dependencyId of dependsOn) {
    if (dependencyId === id) {
      const path = dependencyCyclePath(ledger.tasks, id, dependencyId);
      throw new TaskError(`Blockers would cycle: ${path.join(" → ")}`, 409);
    }
    const dependency = byId.get(dependencyId);
    if (dependency === undefined) {
      throw new TaskError(`Unknown dependency ${dependencyId}`, 409);
    }
    if (dependency.status === "proposed" || dependency.status === "backlog") {
      throw new TaskError(
        `${dependencyId} is ${dependency.status} and is not approved work, so it cannot gate a task`,
        409,
      );
    }
    const cycle = dependencyCyclePath(ledger.tasks, id, dependencyId);
    if (cycle.length > 0) {
      throw new TaskError(`Blockers would cycle: ${cycle.join(" → ")}`, 409);
    }
  }
}

/** Tools for the same ledger the tasks page edits. Not deferred, so every turn offers them. */
export function createTaskTools(
  bridge: TaskBridge,
  options: TaskToolOptions = {},
): ToolRegistration[] {
  const scope = options.scope;
  const scopeProject = (): string | undefined => {
    if (scope === undefined) return undefined;
    return bridge.store.ledger().tasks.find((task) => task.id === scope.taskId)?.project;
  };
  return [
    defineTool({
      name: "task_list",
      description:
        scope === undefined
          ? "List the shared todo ledger: id, status, depends-on, attached image count, @project when set, and title. Ready tasks come first, then blocked, then done. Every stored dependency is shown; a done dependency is marked (done). Proposals and backlog tasks are not work: proposals appear only as a waiting count; use task_proposals to read them. Planning drafts are still being specified and must not be executed yet; they are hidden unless includePlanning is true. Use task_view to see a task's images."
          : "List the tasks in this plan's project: id, status, depends-on and title, including planning drafts and proposed ideas marked not approved. With no project set, lists every project and names it on each line.",
      parameters: Type.Object({
        includePlanning: Type.Optional(
          Type.Boolean({
            description:
              "Include tasks still in the planning state. They are drafts being specified and must not be executed yet. Default false.",
          }),
        ),
      }),
      async execute(args) {
        const ledger = bridge.store.ledger();
        return {
          output: [
            {
              type: "text",
              text:
                scope === undefined
                  ? formatLedger(ledger, args.includePlanning === true)
                  : formatScopedLedger(ledger, scopeProject()),
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
        "Show one task in full: its title, status, depends-on and required-by relations, project, and the images currently attached to it.",
      parameters: idSchema,
      async execute(args) {
        const ledger = bridge.store.ledger();
        const task = ledger.tasks.find((item) => item.id === args.id);
        if (task === undefined || task.status === "backlog") {
          return failure(new TaskError("Unknown task", 404));
        }
        const project = scopeProject();
        if (
          scope !== undefined &&
          project !== undefined &&
          (task.project === undefined || !sameProject(task.project, project))
        ) {
          return failure(new TaskError("Task is outside this plan's project", 403));
        }
        const byId = new Map(ledger.tasks.map((item) => [item.id, item]));
        const dependsOn = task.blockedBy
          .map((id) => byId.get(id))
          .filter((item): item is Task => item !== undefined);
        const requiredBy = ledger.tasks.filter((item) => item.blockedBy.includes(task.id));
        const ids = task.attachments ?? [];
        const completion = task.status === "done" ? (task.completion ?? null) : null;
        const header = [
          `${task.id} ${task.status}${task.parentId === null ? "" : ` parent=${task.parentId}`}`,
          relationLine("depends-on", dependsOn),
          relationLine("required-by", requiredBy),
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
      name: "task_depends",
      description:
        'Set the whole "Depends on" list for one task. Pass every task id that must be implemented and marked done first, or an empty list to clear the ordering. An unknown id, a task depending on itself, a proposed or backlog dependency, and any cycle are refused without a write. Use task_block to create a new task that gates this one.',
      parameters: dependsSchema,
      async execute(args) {
        const ledger = bridge.store.ledger();
        const task = ledger.tasks.find((item) => item.id === args.id);
        if (task === undefined || task.status === "backlog") {
          return failure(new TaskError("Unknown task", 404));
        }
        if (
          scope !== undefined &&
          args.id !== scope.taskId &&
          (args.dependsOn.length === 0 ||
            !args.dependsOn.every((dependencyId) => dependencyId === scope.taskId))
        ) {
          return failure(
            new TaskError(
              `task_depends in a plan may only change an ordering that involves ${scope.taskId}`,
              409,
            ),
          );
        }
        try {
          validateDependencies(ledger, args.id, args.dependsOn);
          const next = await bridge.store.update(args.id, { blockedBy: [...args.dependsOn] });
          bridge.publish(next);
          return {
            output: [
              {
                type: "text",
                text:
                  scope === undefined
                    ? formatLedger(next)
                    : formatScopedLedger(next, scopeProject()),
              },
            ],
          };
        } catch (error) {
          return failure(error);
        }
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
        "Mark one task working before starting it. Sets its status to working, records when the work began and stamps lastWorkedAt. Pass an optional short note about what you are doing; it is echoed back but not stored. A task may only start after every task it depends on is implemented and marked done; a pending dependency refuses the call without changing anything. A proposal or backlog task cannot be marked working, and a done task must be reopened with task_reopen first.",
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
        const ledger = bridge.store.ledger();
        const pending = liveBlockerIds(ledger.tasks, current);
        if (pending.length > 0) {
          const byId = new Map(ledger.tasks.map((task) => [task.id, task]));
          const lines = [
            `${current.id} cannot start: it depends on tasks that are not done.`,
            "",
            "A task may only start after every task it depends on is implemented and marked done.",
            "Pending dependencies:",
          ];
          for (const dependencyId of pending) {
            const dependency = byId.get(dependencyId);
            if (dependency === undefined) {
              lines.push(`- ${dependencyId} missing`);
              continue;
            }
            const planning =
              dependency.status === "planning"
                ? " (still being planned and waiting for approval)"
                : "";
            lines.push(`- ${dependency.id} ${dependency.status} ${titleOf(dependency)}${planning}`);
          }
          lines.push(
            "",
            "Implement and mark those tasks done with task_done first, or correct the order with task_depends.",
          );
          return { output: [{ type: "text", text: lines.join("\n") }], isError: true };
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
        "Edit an existing task's title, body, project or images. The body is free markdown shown under the title in the tasks page; pass an empty string to clear it. A title cannot be empty. An attachments list replaces the task's images; pass an empty list to remove them all.",
      parameters: editSchema,
      async execute(args) {
        const current = bridge.store.ledger().tasks.find((task) => task.id === args.id);
        if (current === undefined || current.status === "backlog") {
          return failure(new TaskError("Unknown task", 404));
        }
        const patch: {
          title?: string;
          body?: string;
          project?: string | null;
          attachments?: string[];
        } = {};
        if (args.title !== undefined) patch.title = args.title;
        if (args.body !== undefined) patch.body = args.body;
        if (args.project !== undefined) patch.project = args.project;
        if (args.attachments !== undefined) {
          if (bridge.media === undefined) {
            return failure(new TaskError("Task images are unavailable", 500));
          }
          try {
            patch.attachments = await validateAttachmentIds(
              bridge.media,
              args.attachments,
              TASK_ATTACHMENTS_MAX,
            );
          } catch (error) {
            return failure(error instanceof MediaError ? new TaskError(error.message, 400) : error);
          }
        }
        return changed(bridge, () => bridge.store.update(args.id, patch));
      },
    }),
    createProposeTaskTool(bridge),
    defineTool({
      name: "task_block",
      description:
        "Create a new open task and make the given task depend on it. Existing dependencies stay. This cannot create a task that does not gate something.",
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
