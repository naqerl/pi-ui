import { type ReactNode, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { type ProjectFilter, projectsOf, sameProject } from "../shared/project";
import { subtaskCount, taskState } from "../shared/task-status";
import {
  ancestorIds,
  blockerClosesCycle,
  compareTasks,
  descendantIds,
  formatActiveTime,
  formatCost,
  formatTokenCount,
  hasOpenDescendant,
  liveBlockerIds,
} from "../shared/tasks";
import { formatDateTime, formatDay, formatTime } from "../shared/time";
import type {
  Task,
  TaskActivity,
  TaskHistoryEvent,
  TaskLedger,
  TaskMeasured,
  TaskState,
  TaskTrace,
} from "../shared/types";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { Card, CardContent, CardFooter, CardHeader } from "./components/ui/card";
import { Checkbox } from "./components/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./components/ui/collapsible";
import { NativeSelect } from "./components/ui/native-select";
import { Separator } from "./components/ui/separator";
import { cn } from "./lib/utils";
import { InlineMarkdown, plainInline } from "./markdown";
import { mediaUrl } from "./media-client";
import { ProjectSelect } from "./ProjectSelect";
import { removeTask, type TaskOutcome, updateTask } from "./task-client";

const LONG_PRESS_MS = 500;
const WIDE_QUERY = "(min-width: 1024px)";
const HISTORY_LIMIT = 12;
/** Past days of the done list shown at first; "Show older days" adds this many more. */
const DAY_PAGE = 7;

type Filter = "active" | "blocked" | "proposed";

interface TasksViewProps {
  tasks: Task[];
  activity?: TaskActivity;
  ready: boolean;
  footerClearance: number;
  armedParentId: string | null;
  onArmParent: (id: string | null) => void;
  onLedger: (ledger: TaskLedger) => void;
  projectFilter: ProjectFilter;
  onProjectFilter: (filter: ProjectFilter) => void;
}

/** Whether a task belongs in the list the project filter shows. */
export function inProject(task: { project?: string }, filter: ProjectFilter): boolean {
  if (filter.kind === "all") return true;
  if (filter.kind === "none") return task.project === undefined;
  return sameProject(task.project, filter.name);
}

/** Root tasks split into one group per project, A–Z, with "No project" (null) last. */
export function groupByProject<T extends { project?: string }>(
  items: T[],
): Array<[string | null, T[]]> {
  const groups = new Map<string, T[]>();
  const loose: T[] = [];
  for (const item of items) {
    if (item.project === undefined) {
      loose.push(item);
      continue;
    }
    const key = [...groups.keys()].find((name) => sameProject(name, item.project)) ?? item.project;
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [item]);
    else group.push(item);
  }
  const named = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  return loose.length > 0 ? [...named, [null, loose]] : named;
}

const FILTER_ALL = "all";
const FILTER_NONE = "none";

function filterValue(filter: ProjectFilter): string {
  return filter.kind === "project" ? `project:${filter.name}` : filter.kind;
}

function useWide(): boolean {
  const [wide, setWide] = useState(
    () => typeof window !== "undefined" && window.matchMedia(WIDE_QUERY).matches,
  );
  useEffect(() => {
    const query = window.matchMedia(WIDE_QUERY);
    const update = () => setWide(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return wide;
}

/** A local calendar day as `YYYY-MM-DD`, the key the day groups sort and match on. */
export function dayKey(value: string | Date): string {
  const at = typeof value === "string" ? new Date(value) : value;
  const month = String(at.getMonth() + 1).padStart(2, "0");
  const day = String(at.getDate()).padStart(2, "0");
  return `${at.getFullYear()}-${month}-${day}`;
}

/** "Today", "Yesterday", or a short weekday and date such as "Thu, Oct 29". */
export function dayLabel(key: string, now: Date): string {
  if (key === dayKey(now)) return "Today";
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (key === dayKey(yesterday)) return "Yesterday";
  const [year, month, day] = key.split("-").map(Number);
  const date = new Date(year ?? 1970, (month ?? 1) - 1, day ?? 1);
  return formatDay(date, now.getFullYear());
}

/** Items grouped by the local day of `at`, newest day first, keeping each group's order. */
export function groupByDay<T>(items: T[], at: (item: T) => string): Array<[string, T[]]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = dayKey(at(item));
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [item]);
    else group.push(item);
  }
  return [...groups.entries()].sort(([a], [b]) => (a < b ? 1 : a > b ? -1 : 0));
}

function byCompletedDesc(a: Task, b: Task): number {
  const left = a.completedAt ?? a.createdAt;
  const right = b.completedAt ?? b.createdAt;
  return left === right ? 0 : left < right ? 1 : -1;
}

function Heading({ children, count }: { children: ReactNode; count?: number }) {
  return (
    <h2 className="flex items-center gap-2 px-1 text-sm font-medium leading-5 text-foreground">
      {children}
      {count !== undefined && (
        <span className="text-sm font-normal leading-5 text-muted-foreground">{count}</span>
      )}
    </h2>
  );
}

function Section({
  id,
  title,
  count,
  children,
}: {
  id: string;
  title: string;
  count?: number;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2" data-testid={`task-section-${id}`}>
      <Heading count={count}>{title}</Heading>
      {children}
    </section>
  );
}

function ErrorText({
  id,
  className,
  children,
}: {
  id?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <p
      id={id}
      role="alert"
      data-testid="task-error"
      className={cn("px-1 text-xs leading-4 text-destructive", className)}
    >
      {children}
    </p>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      className={cn(
        "size-4 shrink-0 text-muted-foreground transition-transform",
        open && "rotate-180",
      )}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

export function TasksView({
  tasks,
  activity,
  ready,
  footerClearance,
  armedParentId,
  onArmParent,
  onLedger,
  projectFilter,
  onProjectFilter,
}: TasksViewProps) {
  const wide = useWide();
  const [filter, setFilter] = useState<Filter>("active");
  const [pickerId, setPickerId] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [problem, setProblem] = useState<{ id: string; message: string } | null>(null);
  const [openTaskId, setOpenTaskId] = useState<string | null>(null);
  const [dayLimit, setDayLimit] = useState(DAY_PAGE);
  const ignoreNextCardClick = useRef(false);
  const now = new Date();

  const stateOf = new Map<string, TaskState>();
  for (const task of tasks) stateOf.set(task.id, taskState(tasks, task, activity));
  const state = (task: Task): TaskState => stateOf.get(task.id) ?? "ready";

  const projects = projectsOf(tasks);
  const shown = (task: Task) => inProject(task, projectFilter);
  // With every project in view, open work is grouped by project, so its rows drop the label.
  const grouped = projectFilter.kind === "all" && projects.length > 0;
  const labelled = projectFilter.kind === "all";
  const activeTasks = tasks.filter((task) => task.status !== "proposed");
  const openTasks = activeTasks.filter((task) => task.status !== "done" && shown(task));
  const proposedTasks = tasks
    .filter((task) => task.status === "proposed" && shown(task))
    .sort((a, b) => {
      const left = a.proposedAt ?? a.createdAt;
      const right = b.proposedAt ?? b.createdAt;
      return left === right ? (a.id < b.id ? -1 : 1) : left < right ? -1 : 1;
    });
  const failedTasks = openTasks.filter((task) => state(task) === "failed");
  const blockedTasks = openTasks.filter((task) => state(task) === "blocked");
  const workingTasks = openTasks.filter((task) => state(task) === "working");
  const ids = new Set(activeTasks.map((task) => task.id));
  const roots = activeTasks
    .filter((task) => task.parentId === null || !ids.has(task.parentId))
    .sort((a, b) => compareTasks(activeTasks, a, b));
  const hasChildren = (task: Task) => activeTasks.some((item) => item.parentId === task.id);
  // A failed leaf already sits under "Needs you"; a failed parent stays in the tree with its subtasks.
  const activeRoots = roots.filter(
    (task) =>
      task.status !== "done" && shown(task) && !(state(task) === "failed" && !hasChildren(task)),
  );
  const projectGroups = groupByProject(activeRoots);
  const doneRoots = roots
    .filter((task) => task.status === "done" && shown(task))
    .sort(byCompletedDesc);
  const days = groupByDay(doneRoots, (task) => task.completedAt ?? task.createdAt);
  const today = dayKey(now);
  if (days.length > 0 && days[0]?.[0] !== today) days.unshift([today, []]);

  const apply = async (id: string, outcome: Promise<TaskOutcome>) => {
    const next = await outcome;
    if (!next.ok) {
      setProblem({ id, message: next.error });
      return;
    }
    setProblem((current) => (current?.id === id ? null : current));
    onLedger(next.ledger);
  };

  const menuTask = menu === null ? undefined : activeTasks.find((task) => task.id === menu.id);
  const openTask = openTaskId === null ? undefined : tasks.find((task) => task.id === openTaskId);

  useEffect(() => {
    if (openTaskId !== null && !tasks.some((task) => task.id === openTaskId)) setOpenTaskId(null);
  }, [openTaskId, tasks]);

  useEffect(() => {
    if (menu === null) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (document.getElementById("task-menu")?.contains(target)) return;
      // A tap that only dismisses the menu must not also open the row.
      if (target instanceof Element && target.closest("[data-task-card]") !== null) {
        ignoreNextCardClick.current = true;
      }
      setMenu(null);
      setPickerId(null);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMenu(null);
        setPickerId(null);
      }
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  useEffect(() => {
    if (openTaskId === null || menu !== null) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpenTaskId(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [openTaskId, menu]);

  const openMenu = (id: string, x: number, y: number, picker = false) => {
    setPickerId(picker ? id : null);
    setMenu({ id, x, y });
  };
  const setStatus = (task: Task, status: Task["status"]) =>
    void apply(task.id, updateTask(task.id, { status }));

  const rowProps = {
    tasks: activeTasks,
    activity,
    state,
    selectedId: openTaskId,
    armedParentId,
    ignoreNextCardClick,
    problem,
    menuTaskId: menu?.id ?? null,
    onOpenMenu: openMenu,
    onOpen: setOpenTaskId,
    onStatus: setStatus,
    showProject: labelled,
  };

  const proposal = (task: Task) => (
    <ProposedTask
      key={task.id}
      task={task}
      showProject={labelled}
      selected={openTaskId === task.id}
      notice={problem?.id === task.id ? problem.message : null}
      onOpen={() => setOpenTaskId(task.id)}
      onApprove={() => void apply(task.id, updateTask(task.id, { status: "open" }))}
      onDismiss={() => void apply(task.id, removeTask(task.id))}
    />
  );

  const counts: Record<Filter, number> = {
    active: openTasks.length,
    blocked: blockedTasks.length,
    proposed: proposedTasks.length,
  };
  const labels: Record<Filter, string> = {
    active: "Active",
    blocked: "Blocked",
    proposed: "Proposed",
  };

  const list = (
    <div className="flex min-w-0 flex-col gap-5" data-testid="task-list">
      {workingTasks.length > 0 && (
        <p
          data-testid="now-line"
          aria-live="polite"
          className="px-1 text-sm leading-5 text-muted-foreground"
        >
          Working on{" "}
          {workingTasks.map((task, index) => (
            <span key={task.id}>
              {index > 0 && ", "}
              <button
                type="button"
                data-testid={`now-task-${task.id}`}
                aria-label={`Working on ${plainInline(task.title)}`}
                onClick={() => setOpenTaskId(task.id)}
                className="font-medium text-foreground underline-offset-4 hover:underline"
              >
                {plainInline(task.title)}
              </button>
            </span>
          ))}
        </p>
      )}
      {tasks.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <div
            role="tablist"
            aria-label="Task filter"
            data-testid="task-filters"
            className="inline-flex h-9 w-fit items-center rounded-md bg-muted p-1 text-muted-foreground"
          >
            {(["active", "blocked", "proposed"] as const).map((item) => (
              <button
                key={item}
                type="button"
                role="tab"
                aria-selected={filter === item}
                data-testid={`task-filter-${item}`}
                onClick={() => setFilter(item)}
                className={cn(
                  "inline-flex h-7 items-center gap-1.5 whitespace-nowrap rounded-sm px-3 text-sm font-medium leading-none",
                  filter === item && "bg-background text-foreground shadow-sm",
                )}
              >
                {labels[item]}
                <span className="text-xs leading-none text-muted-foreground">{counts[item]}</span>
              </button>
            ))}
          </div>
          {(projects.length > 0 || projectFilter.kind !== "all") && (
            <NativeSelect
              aria-label="Project filter"
              data-testid="task-project-filter"
              className="h-9 [&>select]:h-9"
              value={filterValue(projectFilter)}
              onChange={(event) => {
                const next = event.target.value;
                if (next === FILTER_ALL) onProjectFilter({ kind: "all" });
                else if (next === FILTER_NONE) onProjectFilter({ kind: "none" });
                else onProjectFilter({ kind: "project", name: next.slice("project:".length) });
              }}
            >
              <option value={FILTER_ALL}>All projects</option>
              {projects.map((name) => (
                <option key={name} value={`project:${name}`}>
                  {name}
                </option>
              ))}
              {projectFilter.kind === "project" &&
                !projects.some((name) => sameProject(name, projectFilter.name)) && (
                  <option value={filterValue(projectFilter)}>{projectFilter.name}</option>
                )}
              <option value={FILTER_NONE}>No project</option>
            </NativeSelect>
          )}
        </div>
      )}
      {filter === "active" && (
        <>
          {(proposedTasks.length > 0 || failedTasks.length > 0) && (
            <Section title="Needs you" count={proposedTasks.length + failedTasks.length} id="needs">
              <ul id="proposed-tasks" className="flex flex-col gap-2" data-testid="task-proposals">
                {proposedTasks.map(proposal)}
                {failedTasks.map((task) => (
                  <TaskRow key={task.id} task={task} depth={0} {...rowProps} flat />
                ))}
              </ul>
            </Section>
          )}
          {activeRoots.length > 0 && (
            <Section title="Open" count={openTasks.length - failedTasks.length} id="active">
              {grouped ? (
                projectGroups.map(([name, items]) => (
                  <Group
                    key={name ?? ""}
                    testId={`task-project-${name ?? "none"}`}
                    label={name ?? "No project"}
                    count={items.length}
                    defaultOpen
                  >
                    <ul className="flex flex-col gap-2">
                      {items.map((task) => (
                        <TaskRow
                          key={task.id}
                          task={task}
                          depth={0}
                          {...rowProps}
                          showProject={false}
                        />
                      ))}
                    </ul>
                  </Group>
                ))
              ) : (
                <ul className="flex flex-col gap-2">
                  {activeRoots.map((task) => (
                    <TaskRow key={task.id} task={task} depth={0} {...rowProps} />
                  ))}
                </ul>
              )}
            </Section>
          )}
          {days.length > 0 && (
            <section className="flex flex-col gap-2" data-testid="task-section-done">
              <Heading>Done</Heading>
              {days.slice(0, dayLimit + 1).map(([key, items]) => (
                <Group
                  key={key}
                  testId={`task-day-${key}`}
                  label={dayLabel(key, now)}
                  count={items.length}
                  defaultOpen={key === today}
                >
                  {items.length === 0 ? (
                    <p className="px-1 text-sm leading-5 text-muted-foreground">
                      Nothing done yet today.
                    </p>
                  ) : (
                    <ul className="flex flex-col gap-2">
                      {items.map((task) => (
                        <TaskRow key={task.id} task={task} depth={0} {...rowProps} history />
                      ))}
                    </ul>
                  )}
                </Group>
              ))}
              {days.length > dayLimit + 1 && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-fit rounded-md"
                  onClick={() => setDayLimit((limit) => limit + DAY_PAGE)}
                >
                  Show older days
                </Button>
              )}
            </section>
          )}
        </>
      )}
      {filter === "blocked" && (
        <Section title="Blocked" count={blockedTasks.length} id="blocked">
          <ul className="flex flex-col gap-2">
            {blockedTasks.map((task) => (
              <TaskRow key={task.id} task={task} depth={0} {...rowProps} flat />
            ))}
          </ul>
        </Section>
      )}
      {filter === "proposed" && (
        <Section title="Proposed" count={proposedTasks.length} id="proposed">
          <ul id="proposed-tasks" className="flex flex-col gap-2" data-testid="task-proposals">
            {proposedTasks.map(proposal)}
          </ul>
        </Section>
      )}
      {!ready && <p className="px-1 text-sm text-muted-foreground">Loading…</p>}
      {ready && tasks.length === 0 && (
        <p className="py-8 text-center text-sm text-muted-foreground">No tasks yet.</p>
      )}
    </div>
  );

  const detail =
    openTask === undefined ? null : (
      <TaskDetail
        task={openTask}
        tasks={tasks}
        state={state(openTask)}
        trace={activity?.traces[openTask.id]}
        subtree={subtreeMeasured(tasks, openTask.id, activity?.traces ?? {})}
        wide={wide}
        armed={armedParentId === openTask.id}
        notice={problem?.id === openTask.id && menu === null ? problem.message : null}
        onClose={() => setOpenTaskId(null)}
        onOpen={setOpenTaskId}
        onStatus={setStatus}
        onArm={() => onArmParent(armedParentId === openTask.id ? null : openTask.id)}
        onBlock={(x, y) => openMenu(openTask.id, x, y, true)}
        projects={projects}
        onProject={(project) => void apply(openTask.id, updateTask(openTask.id, { project }))}
        onApprove={() => void apply(openTask.id, updateTask(openTask.id, { status: "open" }))}
        onDismiss={() => void apply(openTask.id, removeTask(openTask.id))}
        onRemove={() => {
          if (armedParentId === openTask.id) onArmParent(null);
          void apply(openTask.id, removeTask(openTask.id));
        }}
      />
    );

  return (
    <div
      className="h-full overflow-x-hidden overflow-y-auto overscroll-x-none"
      data-testid="tasks-page"
      data-layout={wide ? "split" : "stack"}
    >
      <div
        className={
          wide
            ? "mx-auto grid w-full max-w-[1200px] grid-cols-[minmax(360px,440px)_1fr] items-start gap-6 px-4"
            : "mx-auto flex w-full max-w-[72ch] flex-col gap-4 px-4"
        }
        style={{ paddingTop: 16, paddingBottom: footerClearance + 16 }}
      >
        {wide ? (
          <>
            {list}
            <div className="sticky top-4 min-w-0">
              {detail ?? (
                <Card
                  data-testid="task-detail-empty"
                  className="items-center px-4 py-10 text-sm text-muted-foreground"
                >
                  Select a task to see its details.
                </Card>
              )}
            </div>
          </>
        ) : (
          (detail ?? list)
        )}
      </div>
      {menu !== null &&
        menuTask !== undefined &&
        createPortal(
          <TaskMenu
            task={menuTask}
            tasks={activeTasks}
            point={menu}
            pickerOpen={pickerId === menuTask.id}
            onArm={() => {
              onArmParent(armedParentId === menuTask.id ? null : menuTask.id);
              setMenu(null);
              setPickerId(null);
            }}
            onTogglePicker={() =>
              setPickerId((current) => (current === menuTask.id ? null : menuTask.id))
            }
            notice={problem?.id === menuTask.id ? problem.message : null}
            onBlockers={(blockedBy) =>
              void apply(menuTask.id, updateTask(menuTask.id, { blockedBy }))
            }
            onRemove={() => {
              if (armedParentId === menuTask.id) onArmParent(null);
              setPickerId(null);
              setMenu(null);
              void apply(menuTask.id, removeTask(menuTask.id));
            }}
          />,
          document.body,
        )}
    </div>
  );
}

function Group({
  testId,
  label,
  count,
  defaultOpen,
  children,
}: {
  testId: string;
  label: string;
  count: number;
  defaultOpen: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      data-testid={testId}
      data-open={open ? "true" : "false"}
    >
      <CollapsibleTrigger className="flex h-9 w-full items-center gap-2 rounded-md px-1 text-left text-sm font-medium leading-5 hover:bg-muted">
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <Badge variant="secondary">{count}</Badge>
        <Chevron open={open} />
      </CollapsibleTrigger>
      <CollapsibleContent className="pt-1">{children}</CollapsibleContent>
    </Collapsible>
  );
}

/** What a task and all its subtasks measured, summed. */
export function subtreeMeasured(
  tasks: Task[],
  id: string,
  traces: Record<string, TaskTrace>,
): TaskMeasured {
  const sum: TaskMeasured = { runs: 0, calls: 0, activeMs: 0, tokens: 0, cost: 0 };
  const seen = new Set<string>();
  const visit = (taskId: string) => {
    if (seen.has(taskId)) return;
    seen.add(taskId);
    const own = traces[taskId]?.measured;
    if (own !== undefined) {
      sum.runs += own.runs;
      sum.calls += own.calls;
      sum.activeMs += own.activeMs;
      sum.tokens += own.tokens;
      sum.cost += own.cost;
    }
    for (const child of tasks) if (child.parentId === taskId) visit(child.id);
  };
  visit(id);
  return sum;
}

function measuredSummary(measured: TaskMeasured | undefined): string {
  if (measured === undefined || measured.runs === 0) return "";
  const parts = [formatActiveTime(measured.activeMs)];
  if (measured.tokens > 0) parts.push(`${formatTokenCount(measured.tokens)} tokens`);
  return parts.join(" · ");
}

function failureLabel(trace: TaskTrace | undefined): string {
  return trace?.lastRun?.outcome === "interrupted" ? "Interrupted" : "Failed";
}

/** The status word for a badge, or null for a plain open task. */
export function stateBadge(state: TaskState, trace: TaskTrace | undefined): string | null {
  switch (state) {
    case "working":
      return "Working";
    case "blocked":
      return "Blocked";
    case "failed":
      return failureLabel(trace);
    case "proposed":
      return "Proposed";
    case "done":
      return "Done";
    default:
      return null;
  }
}

/** The one muted line under a row's title, or "" for none. */
function rowNote(
  task: Task,
  tasks: Task[],
  state: TaskState,
  trace: TaskTrace | undefined,
  traces: Record<string, TaskTrace>,
): string {
  const children = subtaskCount(tasks, task.id);
  const subtasks = children.total > 0 ? `${children.done} of ${children.total} subtasks done` : "";
  switch (state) {
    case "blocked": {
      const names = liveBlockerIds(tasks, task).map((id) => {
        const blocker = tasks.find((item) => item.id === id);
        return blocker === undefined ? id : plainInline(blocker.title);
      });
      if (names.length === 0) return subtasks;
      return `Blocked by ${names[0]}${names.length > 1 ? ` and ${names.length - 1} more` : ""}`;
    }
    case "failed":
      return trace?.lastRun?.reason ?? subtasks;
    case "done": {
      const summary = measuredSummary(subtreeMeasured(tasks, task.id, traces));
      return summary !== "" ? summary : subtasks;
    }
    default:
      return subtasks;
  }
}

function TaskRow({
  task,
  tasks,
  activity,
  state,
  depth,
  flat = false,
  history = false,
  showProject = false,
  selectedId,
  armedParentId,
  ignoreNextCardClick,
  problem,
  menuTaskId,
  onOpenMenu,
  onOpen,
  onStatus,
}: {
  task: Task;
  tasks: Task[];
  activity: TaskActivity | undefined;
  state: (task: Task) => TaskState;
  depth: number;
  flat?: boolean;
  /** A row in the done-by-day list: no status badge, the day already says it. */
  history?: boolean;
  /** Name the project on the row, for lists not already grouped by project. */
  showProject?: boolean;
  selectedId: string | null;
  armedParentId: string | null;
  ignoreNextCardClick: { current: boolean };
  problem: { id: string; message: string } | null;
  menuTaskId: string | null;
  onOpenMenu: (id: string, x: number, y: number) => void;
  onOpen: (id: string) => void;
  onStatus: (task: Task, status: Task["status"]) => void;
}) {
  const children = flat
    ? []
    : tasks.filter((item) => item.parentId === task.id).sort((a, b) => compareTasks(tasks, a, b));
  const current = state(task);
  const done = task.status === "done";
  const openChildren = !done && hasOpenDescendant(tasks, task.id);
  const notice = problem?.id === task.id && menuTaskId !== task.id ? problem.message : null;
  const press = useRef<number | null>(null);
  const origin = useRef({ x: 0, y: 0 });
  const openedAt = useRef(0);
  const selected = selectedId === task.id;
  const armed = armedParentId === task.id;
  const trace = activity?.traces[task.id];
  const badge = history || (done && depth > 0) ? null : stateBadge(current, trace);
  const note = [
    showProject && depth === 0 ? (task.project ?? "") : "",
    rowNote(task, tasks, current, trace, activity?.traces ?? {}),
  ]
    .filter((part) => part !== "")
    .join(" · ");

  const clearPress = () => {
    if (press.current === null) return;
    window.clearTimeout(press.current);
    press.current = null;
  };
  const openMenu = (x: number, y: number) => {
    openedAt.current = Date.now();
    onOpenMenu(task.id, x, y);
  };

  useEffect(() => {
    return () => {
      if (press.current !== null) window.clearTimeout(press.current);
    };
  }, []);

  return (
    <li className="min-w-0" data-testid={`task-${task.id}`} data-state={current}>
      {/* biome-ignore lint/a11y/useSemanticElements: the row contains its own checkbox. */}
      <div
        data-task-card=""
        role="button"
        tabIndex={0}
        aria-current={selected ? "true" : undefined}
        aria-label={`Open ${plainInline(task.title)}`}
        aria-describedby={notice !== null ? `task-error-${task.id}` : undefined}
        className={cn(
          "flex min-h-11 w-full cursor-pointer select-none items-center gap-3 rounded-md border border-border bg-surface px-3 py-2 text-left hover:bg-muted",
          (selected || armed) && "ring-1 ring-foreground",
        )}
        style={{
          WebkitTouchCallout: "none",
          marginLeft: depth * 24,
          width: `calc(100% - ${depth * 24}px)`,
        }}
        onPointerDown={(event) => {
          origin.current = { x: event.clientX, y: event.clientY };
          clearPress();
          if (event.pointerType === "mouse") return;
          press.current = window.setTimeout(() => {
            press.current = null;
            openMenu(origin.current.x, origin.current.y);
          }, LONG_PRESS_MS);
        }}
        onPointerMove={(event) => {
          if (press.current === null && !ignoreNextCardClick.current) return;
          const distance = Math.hypot(
            event.clientX - origin.current.x,
            event.clientY - origin.current.y,
          );
          if (distance <= 10) return;
          clearPress();
          ignoreNextCardClick.current = false;
        }}
        onPointerUp={(event) => {
          const suppress = Date.now() - openedAt.current < 700;
          clearPress();
          if (suppress) event.preventDefault();
        }}
        onPointerCancel={clearPress}
        onContextMenu={(event) => {
          event.preventDefault();
          clearPress();
          openMenu(event.clientX, event.clientY);
        }}
        onClick={() => {
          if (ignoreNextCardClick.current) {
            ignoreNextCardClick.current = false;
            return;
          }
          if (Date.now() - openedAt.current < 700) return;
          onOpen(task.id);
        }}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          onOpen(task.id);
        }}
      >
        <Checkbox
          checked={done}
          data-task-check=""
          aria-pressed={done}
          aria-disabled={openChildren}
          aria-label={
            done ? `Reopen ${plainInline(task.title)}` : `Done ${plainInline(task.title)}`
          }
          title={openChildren ? "Finish open subtasks first" : done ? "Reopen" : "Mark done"}
          className="relative before:absolute before:-inset-3 before:content-['']"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            if (openChildren) return;
            onStatus(task, done ? "open" : "done");
          }}
        />
        <span className="flex min-w-0 flex-1 flex-col justify-center gap-0.5">
          <span
            className={cn(
              "line-clamp-2 text-sm leading-5 [overflow-wrap:anywhere]",
              done ? "text-muted-foreground" : "text-foreground",
            )}
          >
            <InlineMarkdown text={task.title} />
          </span>
          {note !== "" && (
            <span className="truncate text-xs leading-4 text-muted-foreground" title={note}>
              {note}
            </span>
          )}
        </span>
        {badge !== null && (
          <Badge variant={current === "working" || current === "failed" ? "default" : "outline"}>
            {badge}
          </Badge>
        )}
      </div>
      {notice !== null && (
        <ErrorText id={`task-error-${task.id}`} className="mt-1">
          {notice}
        </ErrorText>
      )}
      {children.length > 0 && (
        <ul className="mt-2 flex flex-col gap-2">
          {children.map((child) => (
            <TaskRow
              key={child.id}
              task={child}
              tasks={tasks}
              activity={activity}
              state={state}
              depth={depth + 1}
              history={history}
              selectedId={selectedId}
              armedParentId={armedParentId}
              ignoreNextCardClick={ignoreNextCardClick}
              problem={problem}
              menuTaskId={menuTaskId}
              onOpenMenu={onOpenMenu}
              onOpen={onOpen}
              onStatus={onStatus}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

function ProposedTask({
  task,
  showProject,
  selected,
  notice,
  onOpen,
  onApprove,
  onDismiss,
}: {
  task: Task;
  showProject: boolean;
  selected: boolean;
  notice: string | null;
  onOpen: () => void;
  onApprove: () => void;
  onDismiss: () => void;
}) {
  const stop = (event: { stopPropagation: () => void }) => event.stopPropagation();
  return (
    <li data-testid={`proposal-${task.id}`} data-state="proposed" className="min-w-0">
      {/* biome-ignore lint/a11y/useSemanticElements: the row contains its own approve and dismiss buttons. */}
      <div
        role="button"
        tabIndex={0}
        aria-current={selected ? "true" : undefined}
        aria-label={`Open proposal ${plainInline(task.title)}`}
        className={cn(
          "flex min-h-11 w-full cursor-pointer select-none flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-border bg-surface px-3 py-2 text-left hover:bg-muted",
          selected && "ring-1 ring-foreground",
        )}
        onClick={onOpen}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          onOpen();
        }}
      >
        <span className="flex min-w-0 flex-1 basis-40 flex-col gap-0.5">
          <span className="line-clamp-2 text-sm leading-5 [overflow-wrap:anywhere]">
            <InlineMarkdown text={task.title} />
          </span>
          {showProject && task.project !== undefined && (
            <span className="text-xs leading-4 text-muted-foreground [overflow-wrap:anywhere]">
              {task.project}
            </span>
          )}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-2">
          <Badge variant="outline">Proposed</Badge>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 shrink-0 rounded-md px-2"
            aria-label={`Dismiss ${plainInline(task.title)}`}
            onClick={(event) => {
              stop(event);
              onDismiss();
            }}
          >
            Dismiss
          </Button>
          <Button
            size="sm"
            className="h-7 shrink-0 rounded-md px-3"
            aria-label={`Approve ${plainInline(task.title)}`}
            onClick={(event) => {
              stop(event);
              onApprove();
            }}
          >
            Approve
          </Button>
        </span>
      </div>
      {notice !== null && (
        <div className="mt-1">
          <ErrorText>{notice}</ErrorText>
        </div>
      )}
    </li>
  );
}

/** Created and closed instants of a task, in the browser's own zone. */
export function TaskTimes({ task }: { task: Task }) {
  const created = formatDateTime(task.createdAt);
  const closed =
    task.status === "done" && typeof task.completedAt === "string"
      ? formatDateTime(task.completedAt)
      : "";
  return (
    <span
      data-testid="task-times"
      className="flex flex-wrap items-center gap-x-3 text-xs leading-4 text-muted-foreground"
    >
      <time dateTime={task.createdAt} title={created}>
        Created {created}
      </time>
      {closed !== "" && (
        <time dateTime={task.completedAt ?? undefined} title={closed}>
          Closed {closed}
        </time>
      )}
    </span>
  );
}

function SubHeading({ children }: { children: ReactNode }) {
  return <h3 className="text-sm font-medium leading-5">{children}</h3>;
}

export function TaskDetail({
  task,
  tasks,
  state,
  trace,
  subtree,
  wide,
  armed,
  notice,
  onClose,
  onOpen,
  onStatus,
  onArm,
  onBlock,
  onApprove,
  onDismiss,
  onRemove,
  projects = [],
  onProject,
}: {
  task: Task;
  tasks: Task[];
  state: TaskState;
  trace: TaskTrace | undefined;
  /** This task plus its subtasks, when the detail should show what the subtree cost. */
  subtree?: TaskMeasured;
  wide: boolean;
  armed: boolean;
  notice: string | null;
  onClose: () => void;
  onOpen: (id: string) => void;
  onStatus: (task: Task, status: Task["status"]) => void;
  onArm: () => void;
  onBlock: (x: number, y: number) => void;
  onApprove: () => void;
  onDismiss: () => void;
  onRemove: () => void;
  projects?: string[];
  /** Move the task to another project, or null for none. Absent: the project is read-only. */
  onProject?: (project: string | null) => void;
}) {
  const done = task.status === "done";
  const proposed = task.status === "proposed";
  const openChildren = !done && hasOpenDescendant(tasks, task.id);
  const parent =
    task.parentId === null ? undefined : tasks.find((item) => item.id === task.parentId);
  const children = tasks
    .filter((item) => item.parentId === task.id && item.status !== "proposed")
    .sort((a, b) => compareTasks(tasks, a, b));
  const blockers = task.blockedBy.map((id) => {
    const blocker = tasks.find((item) => item.id === id);
    return blocker === undefined
      ? { id, title: id, done: false }
      : { id, title: plainInline(blocker.title), done: blocker.status === "done" };
  });
  // A parent's own runs are often none; its subtasks' runs are the work done for it.
  const measured = subtree ?? trace?.measured;
  const ran = measured !== undefined && measured.runs > 0;
  const rolledUp = ran && measured.runs > (trace?.measured.runs ?? 0);
  const stats: Array<[string, string]> = [
    ["Active time", ran ? formatActiveTime(measured.activeMs) : "—"],
    ["Tokens", ran ? formatTokenCount(measured.tokens) : "—"],
    ["Cost", ran ? formatCost(measured.cost) : "—"],
    [rolledUp ? "Runs with subtasks" : "Runs", ran ? String(measured.runs) : "—"],
  ];
  const events: TaskHistoryEvent[] = (trace?.history ?? []).slice(-HISTORY_LIMIT);
  const hidden = (trace?.history.length ?? 0) - events.length;
  const now = new Date();
  const eventDays = groupByDay([...events].reverse(), (event) => event.at);
  const reason =
    state === "failed" && trace?.lastRun?.reason !== undefined ? trace.lastRun.reason : null;
  const badge = stateBadge(state, trace) ?? "Open";
  const title = plainInline(task.title);

  return (
    <Card data-testid="task-detail" aria-label={title} role="article">
      <CardHeader>
        <div className="flex min-h-8 items-center gap-2">
          {!wide && (
            <Button
              variant="ghost"
              size="sm"
              data-testid="task-detail-back"
              aria-label="Back to tasks"
              onClick={onClose}
              className="-ml-2 shrink-0 rounded-md px-2"
            >
              Back
            </Button>
          )}
          <span className="min-w-0 flex-1 truncate text-xs leading-4 text-muted-foreground">
            {parent !== undefined && (
              <button
                type="button"
                className="underline-offset-4 hover:underline"
                onClick={() => onOpen(parent.id)}
              >
                {plainInline(parent.title)}
              </button>
            )}
          </span>
          {wide && (
            <Button
              variant="ghost"
              size="sm"
              data-testid="task-detail-close"
              aria-label="Close"
              onClick={onClose}
              className="-mr-2 shrink-0 rounded-md px-2"
            >
              Close
            </Button>
          )}
        </div>
        <div className="flex items-start gap-3">
          <h2 className="min-w-0 flex-1 text-lg font-semibold leading-7 [overflow-wrap:anywhere]">
            <InlineMarkdown text={task.title} />
          </h2>
          <Badge
            data-testid="task-state"
            className="mt-1"
            variant={state === "working" || state === "failed" ? "default" : "outline"}
          >
            {badge}
          </Badge>
        </div>
        <TaskTimes task={task} />
        {reason !== null && (
          <p data-testid="task-failure" className="text-sm leading-5 text-muted-foreground">
            {reason}
          </p>
        )}
        {task.rationale !== undefined && task.rationale.length > 0 && (
          <p className="whitespace-pre-wrap text-sm leading-5 [overflow-wrap:anywhere]">
            {task.rationale}
          </p>
        )}
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div
          className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1"
          data-testid="task-project-line"
        >
          <span className="text-xs leading-4 text-muted-foreground">Project</span>
          {onProject === undefined ? (
            <span className="text-sm leading-5">{task.project ?? "No project"}</span>
          ) : (
            <ProjectSelect
              label="Project"
              testId="task-project"
              value={task.project ?? null}
              projects={projects}
              onChange={onProject}
              className="min-w-0 max-w-full"
            />
          )}
        </div>
        {!proposed && (
          <dl
            data-testid="task-stats"
            data-rollup={rolledUp ? "subtasks" : undefined}
            title={rolledUp ? "Includes runs of its subtasks" : undefined}
            className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4"
          >
            {stats.map(([name, value]) => (
              <div key={name} className="flex min-w-0 flex-col gap-1">
                <dt className="text-xs leading-4 text-muted-foreground">{name}</dt>
                <dd className="text-sm font-medium leading-5 tabular-nums">{value}</dd>
              </div>
            ))}
          </dl>
        )}
        {done && (
          <section className="flex flex-col gap-1" data-testid="task-modal-completion">
            <SubHeading>Evidence</SubHeading>
            {task.completion == null ? (
              <p className="text-sm leading-5 text-muted-foreground">No evidence recorded</p>
            ) : (
              <p
                data-testid="task-evidence"
                className="whitespace-pre-wrap text-sm leading-5 [overflow-wrap:anywhere]"
              >
                {task.completion.evidence}
              </p>
            )}
          </section>
        )}
        {blockers.length > 0 && (
          <section className="flex flex-col gap-1">
            <SubHeading>Blocked by</SubHeading>
            <ul className="flex flex-col gap-1">
              {blockers.map((blocker) => (
                <li
                  key={blocker.id}
                  className="flex min-h-6 items-center gap-2 text-sm leading-5 [overflow-wrap:anywhere]"
                >
                  <span className="min-w-0 flex-1">{blocker.title}</span>
                  {blocker.done && <Badge variant="outline">Done</Badge>}
                </li>
              ))}
            </ul>
          </section>
        )}
        {children.length > 0 && (
          <section className="flex flex-col gap-1">
            <SubHeading>Subtasks</SubHeading>
            <ul className="flex flex-col gap-1">
              {children.map((child) => (
                <li key={child.id} className="flex min-h-6 items-center gap-2">
                  <button
                    type="button"
                    onClick={() => onOpen(child.id)}
                    className="min-w-0 flex-1 text-left text-sm leading-5 underline-offset-4 hover:underline"
                  >
                    <InlineMarkdown text={child.title} />
                  </button>
                  {child.status === "done" && <Badge variant="outline">Done</Badge>}
                </li>
              ))}
            </ul>
          </section>
        )}
        {task.attachments !== undefined && task.attachments.length > 0 && (
          <section className="flex flex-wrap gap-2" data-testid="task-attachments">
            {task.attachments.map((id, index) => (
              <img
                key={id}
                src={mediaUrl(id)}
                alt={`Task attachment ${index + 1}`}
                loading="lazy"
                draggable={false}
                className="block size-16 rounded-md border border-border object-cover"
              />
            ))}
          </section>
        )}
        <Separator />
        <section className="flex flex-col gap-2" data-testid="task-history">
          <SubHeading>History</SubHeading>
          {events.length === 0 ? (
            <p className="text-sm leading-5 text-muted-foreground">Nothing recorded yet</p>
          ) : (
            <div className="flex flex-col gap-3">
              {eventDays.map(([key, items]) => (
                <div key={key} className="flex flex-col gap-1">
                  <p className="text-xs font-medium leading-4 text-muted-foreground">
                    {dayLabel(key, now)}
                  </p>
                  <ol className="flex flex-col gap-1">
                    {items.map((event, index) => (
                      <li
                        // biome-ignore lint/suspicious/noArrayIndexKey: history is append-only and has no ids.
                        key={`${event.at}-${index}`}
                        data-kind={event.kind}
                        className="flex items-baseline gap-3 text-sm leading-5"
                      >
                        <time
                          dateTime={event.at}
                          title={formatDateTime(event.at)}
                          className="w-11 shrink-0 tabular-nums text-muted-foreground"
                        >
                          {formatTime(event.at)}
                        </time>
                        <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                          {event.text}
                        </span>
                      </li>
                    ))}
                  </ol>
                </div>
              ))}
              {hidden > 0 && (
                <p className="text-xs leading-4 text-muted-foreground">
                  {hidden} earlier {hidden === 1 ? "event" : "events"}
                </p>
              )}
            </div>
          )}
        </section>
        {notice !== null && <ErrorText>{notice}</ErrorText>}
      </CardContent>
      <CardFooter className="flex-wrap gap-2" data-testid="task-detail-actions">
        {proposed ? (
          <>
            <Button
              variant="outline"
              size="sm"
              className="shrink-0 rounded-md"
              onClick={onDismiss}
              aria-label={`Dismiss ${title} proposal`}
            >
              Dismiss
            </Button>
            <span className="flex-1" />
            <Button
              size="sm"
              className="shrink-0 rounded-md"
              onClick={onApprove}
              aria-label={`Approve ${title} proposal`}
            >
              Approve
            </Button>
          </>
        ) : (
          <>
            <Button
              variant="outline"
              size="sm"
              className="shrink-0 rounded-md"
              aria-pressed={armed}
              onClick={onArm}
            >
              {armed ? "Adding subtask" : "Subtask"}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="shrink-0 rounded-md"
              aria-label={`Add blocker to ${title}`}
              onClick={(event) => {
                const rect = event.currentTarget.getBoundingClientRect();
                onBlock(rect.left, rect.bottom + 4);
              }}
            >
              Block
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="shrink-0 rounded-md"
              onClick={onRemove}
              aria-label={`Remove ${title} task`}
            >
              Remove
            </Button>
            <span className="flex-1" />
            <Button
              size="sm"
              variant={done ? "outline" : "default"}
              data-testid="task-detail-status"
              aria-disabled={openChildren}
              title={openChildren ? "Finish open subtasks first" : undefined}
              className="shrink-0 rounded-md aria-disabled:opacity-50"
              onClick={() => {
                if (openChildren) return;
                onStatus(task, done ? "open" : "done");
              }}
            >
              {done ? "Reopen" : "Mark done"}
            </Button>
          </>
        )}
      </CardFooter>
    </Card>
  );
}

function TaskMenu({
  task,
  tasks,
  point,
  pickerOpen,
  notice,
  onArm,
  onTogglePicker,
  onBlockers,
  onRemove,
}: {
  task: Task;
  tasks: Task[];
  point: { x: number; y: number };
  pickerOpen: boolean;
  notice: string | null;
  onArm: () => void;
  onTogglePicker: () => void;
  onBlockers: (blockedBy: string[]) => void;
  onRemove: () => void;
}) {
  const ancestors = ancestorIds(tasks, task.id);
  const descendants = descendantIds(tasks, task.id);
  const candidates = tasks
    .filter((item) => item.id !== task.id && !ancestors.has(item.id) && !descendants.has(item.id))
    .sort((a, b) => compareTasks(tasks, a, b));
  const left = Math.max(8, Math.min(point.x, window.innerWidth - 248));
  const top = Math.max(8, Math.min(point.y, window.innerHeight - 160));
  const item =
    "flex min-h-8 w-full items-center rounded-sm px-2 text-left text-sm leading-5 hover:bg-muted";

  return (
    <div
      id="task-menu"
      data-testid="task-menu"
      role="menu"
      className="fixed z-40 w-60 rounded-md border border-border bg-surface p-1 text-foreground shadow-md"
      style={{ left, top }}
    >
      {notice !== null && (
        <div className="px-1 py-1">
          <ErrorText>{notice}</ErrorText>
        </div>
      )}
      <button
        type="button"
        role="menuitem"
        aria-label={`Subtask of ${plainInline(task.title)}`}
        className={item}
        onClick={onArm}
      >
        Add subtask
      </button>
      <button
        type="button"
        role="menuitem"
        aria-expanded={pickerOpen}
        aria-label={`Blockers for ${plainInline(task.title)}`}
        className={item}
        onClick={onTogglePicker}
      >
        Blocked by…
      </button>
      {pickerOpen && (
        <ul className="flex max-h-60 flex-col overflow-y-auto py-1">
          {candidates.length === 0 && (
            <li className="px-2 py-1 text-sm leading-5 text-muted-foreground">No other tasks</li>
          )}
          {candidates.map((other) => {
            const selected = task.blockedBy.includes(other.id);
            const cycle = !selected && blockerClosesCycle(tasks, task.id, other.id);
            return (
              <li key={other.id}>
                <button
                  type="button"
                  aria-pressed={selected}
                  aria-label={`Blocked by ${plainInline(other.title)}`}
                  disabled={cycle}
                  className={cn(item, "gap-2 disabled:opacity-50")}
                  onClick={() => {
                    const blockedBy = selected
                      ? task.blockedBy.filter((id) => id !== other.id)
                      : [...task.blockedBy, other.id];
                    onBlockers(blockedBy);
                  }}
                >
                  <span
                    aria-hidden
                    data-state={selected ? "checked" : "unchecked"}
                    className="grid size-4 shrink-0 place-items-center rounded-sm border border-foreground/60 text-background data-[state=checked]:border-foreground data-[state=checked]:bg-foreground"
                  >
                    {selected && (
                      <svg
                        aria-hidden
                        viewBox="0 0 24 24"
                        className="size-3"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth={3}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="M20 6 9 17l-5-5" />
                      </svg>
                    )}
                  </span>
                  <span className="min-w-0 flex-1 truncate">
                    <InlineMarkdown text={other.title} />
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <div className="-mx-1 my-1 h-px bg-border" />
      <button
        type="button"
        role="menuitem"
        aria-label={`Remove ${plainInline(task.title)}`}
        className={item}
        onClick={onRemove}
      >
        Remove
      </button>
    </div>
  );
}
