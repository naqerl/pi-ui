import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { projectsOf, sameProject } from "../shared/project";
import { isStaleWorking, subtaskCount, taskState } from "../shared/task-status";
import {
  compareTasks,
  formatActiveTime,
  formatTokenCount,
  hasOpenDescendant,
  isActiveStatus,
  liveBlockerIds,
  TASK_BODY_MAX_LENGTH,
} from "../shared/tasks";
import { formatDateTime, formatDay, formatMonthDay, formatTime } from "../shared/time";
import type {
  Task,
  TaskActivity,
  TaskLedger,
  TaskMeasured,
  TaskState,
  TaskTrace,
} from "../shared/types";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { Card, CardContent, CardFooter, CardHeader } from "./components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./components/ui/collapsible";
import { haptic } from "./haptics";
import { cn } from "./lib/utils";
import { InlineMarkdown, Markdown, plainInline } from "./markdown";
import { mediaUrl } from "./media-client";
import { ProjectSuggestions, projectSuggestions } from "./ProjectSuggestions";
import { removeTask, type TaskOutcome, updateTask } from "./task-client";

const LONG_PRESS_MS = 500;
const WIDE_QUERY = "(min-width: 1024px)";
/** Past days of the done list shown at first; "Show older days" adds this many more. */
const DAY_PAGE = 7;
/** One vertical rhythm for every header and card stack on the tasks page. */
const TASK_STACK = "flex flex-col space-y-2";

interface TasksViewProps {
  tasks: Task[];
  activity?: TaskActivity;
  ready: boolean;
  footerClearance: number;
  onLedger: (ledger: TaskLedger) => void;
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

type TaskDetailHistoryState = Record<string, unknown> & { piTaskDetailId?: string };

/** The current history state, when it is an object we can add the detail marker to. */
function taskDetailHistory(): TaskDetailHistoryState | null {
  const state: unknown = window.history.state;
  return state !== null && typeof state === "object" ? (state as TaskDetailHistoryState) : null;
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

/** The heading for one done day: "Done today", "Done yesterday", then "Done <date>". */
export function doneDayLabel(key: string, now: Date): string {
  if (key === dayKey(now)) return "Done today";
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (key === dayKey(yesterday)) return "Done yesterday";
  const [year, month, day] = key.split("-").map(Number);
  const date = new Date(year ?? 1970, (month ?? 1) - 1, day ?? 1);
  return `Done ${formatMonthDay(date, now.getFullYear())}`;
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

function Heading({
  children,
  count,
  dark = false,
  chevron,
}: {
  children: ReactNode;
  count?: number;
  dark?: boolean;
  chevron?: ReactNode;
}) {
  return (
    <h2
      className={cn(
        "flex h-9 items-center gap-2 rounded-md text-sm font-medium leading-5",
        dark ? "bg-foreground px-3 text-background" : "px-1 text-foreground",
      )}
    >
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {count !== undefined && (
        <span
          className={cn(
            "shrink-0 text-sm font-normal leading-5 tabular-nums",
            dark ? "text-background/80" : "text-muted-foreground",
          )}
        >
          {count}
        </span>
      )}
      {chevron}
    </h2>
  );
}

function Section({
  id,
  title,
  count,
  children,
  dark = false,
  collapsible = false,
}: {
  id: string;
  title: string;
  count?: number;
  children: ReactNode;
  dark?: boolean;
  collapsible?: boolean;
}) {
  const [open, setOpen] = useState(true);
  if (collapsible) {
    return (
      <Collapsible
        open={open}
        onOpenChange={setOpen}
        data-testid={`task-section-${id}`}
        data-open={open ? "true" : "false"}
      >
        <CollapsibleTrigger
          className={cn(
            "flex h-9 w-full items-center gap-2 rounded-md px-3 text-left text-sm font-medium leading-5",
            dark ? "bg-foreground text-background" : "text-foreground hover:bg-muted",
          )}
        >
          <span className="min-w-0 flex-1 truncate">{title}</span>
          {count !== undefined && (
            <span
              className={cn(
                "shrink-0 text-sm font-normal leading-5 tabular-nums",
                dark ? "text-background/80" : "text-muted-foreground",
              )}
            >
              {count}
            </span>
          )}
          <Chevron open={open} className={dark ? "text-background/80" : undefined} />
        </CollapsibleTrigger>
        <CollapsibleContent className={`${TASK_STACK} pt-2`}>{children}</CollapsibleContent>
      </Collapsible>
    );
  }
  return (
    <section className="flex flex-col" data-testid={`task-section-${id}`}>
      <Heading count={count} dark={dark}>
        {title}
      </Heading>
      <div className={`${TASK_STACK} pt-2`}>{children}</div>
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

function Chevron({ open, className }: { open: boolean; className?: string }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      className={cn(
        "size-4 shrink-0 transition-transform",
        className ?? "text-muted-foreground",
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

export function TasksView({ tasks, activity, ready, footerClearance, onLedger }: TasksViewProps) {
  const wide = useWide();
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [problem, setProblem] = useState<{ id: string; message: string } | null>(null);
  const [statusPending, setStatusPending] = useState<Record<string, boolean>>({});
  const [openTaskId, setOpenTaskId] = useState<string | null>(null);
  const [dayLimit, setDayLimit] = useState(DAY_PAGE);
  const ignoreNextCardClick = useRef(false);
  const now = new Date();

  const stateOf = new Map<string, TaskState>();
  for (const task of tasks) stateOf.set(task.id, taskState(tasks, task, activity));
  const state = (task: Task): TaskState => stateOf.get(task.id) ?? "ready";

  const activeTasks = tasks.filter((task) => task.status !== "proposed");
  const openTasks = activeTasks.filter(
    (task) => task.status !== "done" && task.status !== "backlog",
  );
  const proposedTasks = tasks
    .filter((task) => task.status === "proposed")
    .sort((a, b) => {
      const left = a.proposedAt ?? a.createdAt;
      const right = b.proposedAt ?? b.createdAt;
      return left === right ? (a.id < b.id ? -1 : 1) : left < right ? -1 : 1;
    });
  const failedTasks = openTasks.filter((task) => state(task) === "failed");
  const ids = new Set(activeTasks.map((task) => task.id));
  const roots = activeTasks
    .filter((task) => task.parentId === null || !ids.has(task.parentId))
    .sort((a, b) => compareTasks(activeTasks, a, b));
  const hasChildren = (task: Task) => activeTasks.some((item) => item.parentId === task.id);
  // A failed leaf already sits under "Needs you"; a failed parent stays in the tree with its subtasks.
  const activeRoots = roots.filter(
    (task) => task.status !== "done" && !(state(task) === "failed" && !hasChildren(task)),
  );
  // Open work is grouped by project once any task has one; grouped rows drop the label.
  const projectGroups = groupByProject(activeRoots);
  // A project with only parked work moves behind every project that has live work.
  projectGroups.sort(([, a], [, b]) => {
    const parkedA = a.every((task) => task.status === "backlog");
    const parkedB = b.every((task) => task.status === "backlog");
    return parkedA === parkedB ? 0 : parkedA ? 1 : -1;
  });
  const grouped = projectGroups.some(([name]) => name !== null);
  const doneRoots = roots.filter((task) => task.status === "done").sort(byCompletedDesc);
  const days = groupByDay(doneRoots, (task) => task.completedAt ?? task.createdAt);
  const today = dayKey(now);
  if (days.length > 0 && days[0]?.[0] !== today) days.unshift([today, []]);

  const apply = async (id: string, outcome: Promise<TaskOutcome>) => {
    haptic();
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

  // A narrow detail is a history entry of its own, so the OS back gesture closes
  // it. Replacing an open detail keeps one entry, not a stack of them.
  const openDetail = useCallback(
    (id: string) => {
      if (!wide) {
        const current = taskDetailHistory();
        const next = { ...(current ?? {}), piTaskDetailId: id };
        if (current?.piTaskDetailId !== undefined) {
          window.history.replaceState(next, "", window.location.href);
        } else {
          window.history.pushState(next, "", window.location.href);
        }
      }
      setOpenTaskId(id);
    },
    [wide],
  );

  const closeDetail = useCallback(() => {
    if (!wide && taskDetailHistory()?.piTaskDetailId !== undefined) {
      window.history.back();
      return;
    }
    setOpenTaskId(null);
  }, [wide]);

  useEffect(() => {
    const onPop = () => {
      if (!wide) setOpenTaskId(null);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [wide]);

  // The first row the list shows, used when the desktop has nothing selected.
  const firstVisibleId =
    proposedTasks[0]?.id ??
    failedTasks[0]?.id ??
    (grouped ? projectGroups.flatMap(([, items]) => items) : activeRoots)[0]?.id ??
    doneRoots[0]?.id ??
    null;
  useEffect(() => {
    if (!wide) return;
    setOpenTaskId((current) => {
      if (current !== null && tasks.some((task) => task.id === current)) return current;
      return firstVisibleId;
    });
  }, [wide, firstVisibleId, tasks]);

  useEffect(() => {
    if (!wide) setOpenTaskId(null);
  }, [wide]);

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
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMenu(null);
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
    if (openTaskId === null || menu !== null || wide) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeDetail();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [closeDetail, openTaskId, menu, wide]);

  const openMenu = (id: string, x: number, y: number) => {
    setMenu({ id, x, y });
  };
  const setStatus = async (task: Task, status: Task["status"]) => {
    setStatusPending((current) => ({ ...current, [task.id]: true }));
    try {
      await apply(task.id, updateTask(task.id, { status }));
    } finally {
      setStatusPending((current) => {
        if (current[task.id] !== true) return current;
        const next = { ...current };
        delete next[task.id];
        return next;
      });
    }
  };

  const rowProps = {
    tasks: activeTasks,
    activity,
    state,
    selectedId: openTaskId,
    ignoreNextCardClick,
    problem,
    menuTaskId: menu?.id ?? null,
    onOpenMenu: openMenu,
    onOpen: openDetail,
    showProject: true,
  };

  const proposal = (task: Task) => (
    <ProposedTask
      key={task.id}
      task={task}
      showProject
      selected={openTaskId === task.id}
      notice={problem?.id === task.id ? problem.message : null}
      onOpen={() => openDetail(task.id)}
      onApprove={() => void apply(task.id, updateTask(task.id, { status: "open" }))}
      onDismiss={() => void apply(task.id, removeTask(task.id))}
    />
  );

  const list = (
    <div className={`${TASK_STACK} min-w-0`} data-testid="task-list">
      {(proposedTasks.length > 0 || failedTasks.length > 0) && (
        <Section title="Needs you" count={proposedTasks.length + failedTasks.length} id="needs">
          <ul id="proposed-tasks" className={TASK_STACK} data-testid="task-proposals">
            {proposedTasks.map(proposal)}
            {failedTasks.map((task) => (
              <TaskRow key={task.id} task={task} depth={0} {...rowProps} flat />
            ))}
          </ul>
        </Section>
      )}
      {activeRoots.length > 0 && (
        <Section
          title="Open"
          count={openTasks.length - failedTasks.length}
          id="active"
          dark
          collapsible
        >
          {grouped ? (
            projectGroups.map(([name, items]) => (
              <Group
                key={name ?? ""}
                testId={`task-project-${name ?? "none"}`}
                label={name ?? "No project"}
                count={items.length}
                defaultOpen
                dark
              >
                <ul className={TASK_STACK}>
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
            <ul className={TASK_STACK}>
              {activeRoots.map((task) => (
                <TaskRow key={task.id} task={task} depth={0} {...rowProps} />
              ))}
            </ul>
          )}
        </Section>
      )}
      {days.length > 0 && (
        <section className={TASK_STACK} data-testid="task-section-done">
          {days.slice(0, dayLimit + 1).map(([key, items]) => (
            <Group
              key={key}
              testId={`task-day-${key}`}
              label={doneDayLabel(key, now)}
              count={items.length}
              defaultOpen={key === today}
              dark
            >
              {items.length === 0 ? (
                <p className="px-1 text-sm leading-5 text-muted-foreground">
                  Nothing done yet today.
                </p>
              ) : (
                <ul className={TASK_STACK}>
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
        wide={wide}
        statusPending={statusPending[openTask.id] === true}
        notice={problem?.id === openTask.id && menu === null ? problem.message : null}
        onClose={closeDetail}
        onOpen={openDetail}
        onStatus={setStatus}
        onApprove={() => void apply(openTask.id, updateTask(openTask.id, { status: "open" }))}
        onDismiss={() => void apply(openTask.id, removeTask(openTask.id))}
        onRemove={() => {
          void apply(openTask.id, removeTask(openTask.id));
        }}
        onLedger={(ledger) => {
          setProblem((current) => (current?.id === openTask.id ? null : current));
          onLedger(ledger);
        }}
      />
    );

  return (
    <div
      className={cn(
        "h-full overflow-x-hidden overscroll-x-none",
        wide ? "overflow-hidden" : "overflow-y-auto",
      )}
      data-testid="tasks-page"
      data-layout={wide ? "split" : "stack"}
    >
      <div
        className={
          wide
            ? "mx-auto grid h-full min-h-0 w-full max-w-[1200px] grid-cols-[minmax(360px,440px)_1fr] gap-6 px-4"
            : "mx-auto flex w-full max-w-[72ch] flex-col gap-4 px-4"
        }
        style={{ paddingTop: 16, paddingBottom: footerClearance + 16 }}
      >
        {wide ? (
          <>
            <div className="min-h-0 overflow-y-auto overscroll-contain">{list}</div>
            <div className="flex min-h-0 min-w-0 flex-col">
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
            statusPending={statusPending[menuTask.id] === true}
            notice={problem?.id === menuTask.id ? problem.message : null}
            onStatus={(task, status) => {
              setMenu(null);
              setStatus(task, status);
            }}
            onRemove={() => {
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
  dark = false,
}: {
  testId: string;
  label: string;
  count: number;
  defaultOpen: boolean;
  children: ReactNode;
  dark?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      data-testid={testId}
      data-open={open ? "true" : "false"}
    >
      <CollapsibleTrigger
        className={cn(
          "flex h-9 w-full items-center gap-2 rounded-md text-left text-sm font-medium leading-5",
          dark ? "bg-foreground px-3 text-background" : "px-1 hover:bg-muted",
        )}
      >
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {dark ? (
          <>
            <Chevron open={open} className="text-background/80" />
            <span className="shrink-0 text-sm font-normal leading-5 tabular-nums text-background/80">
              {count}
            </span>
          </>
        ) : (
          <>
            <Badge variant="secondary">{count}</Badge>
            <Chevron open={open} />
          </>
        )}
      </CollapsibleTrigger>
      <CollapsibleContent className={`${TASK_STACK} pt-2`}>{children}</CollapsibleContent>
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

/** The short task id, the handle cards and the detail share. */
export function shortTaskId(id: string): string {
  return id.slice(0, 4);
}

function TaskIdBadge({
  id,
  testId = `task-id-${id}`,
  className,
}: {
  id: string;
  testId?: string;
  className?: string;
}) {
  return (
    <Badge
      variant="outline"
      data-testid={testId}
      title={id}
      className={cn("font-mono text-[10px] leading-4 text-muted-foreground", className)}
    >
      {shortTaskId(id)}
    </Badge>
  );
}

/** The bare task id beside the title, so a card carries the handle agents use. */
function TaskIdChip({ id, className }: { id: string; className?: string }) {
  return (
    <span
      role="note"
      id={`task-id-${id}`}
      data-testid={`task-id-${id}`}
      title={id}
      aria-label={`task ${id}`}
      className={cn(
        "w-fit shrink-0 whitespace-nowrap font-mono text-[11px] leading-4 text-muted-foreground",
        className,
      )}
    >
      {shortTaskId(id)}
    </span>
  );
}

/** The quiet marker that says a working badge has not been touched for over an hour. */
function StaleMarker({ id }: { id: string }) {
  return (
    <Badge
      variant="outline"
      data-testid={`task-stale-${id}`}
      className="h-4 px-1.5 text-[10px] font-normal leading-4 text-muted-foreground"
    >
      stale
    </Badge>
  );
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
    case "backlog":
      return "Backlog";
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

export function TaskRow({
  task,
  tasks,
  activity,
  state,
  depth,
  flat = false,
  history = false,
  showProject = false,
  selectedId,
  ignoreNextCardClick,
  problem,
  menuTaskId,
  onOpenMenu,
  onOpen,
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
  ignoreNextCardClick: { current: boolean };
  problem: { id: string; message: string } | null;
  menuTaskId: string | null;
  onOpenMenu: (id: string, x: number, y: number) => void;
  onOpen: (id: string) => void;
}) {
  const children = flat
    ? []
    : tasks.filter((item) => item.parentId === task.id).sort((a, b) => compareTasks(tasks, a, b));
  const current = state(task);
  const done = task.status === "done";
  const backlog = task.status === "backlog";
  const notice = problem?.id === task.id && menuTaskId !== task.id ? problem.message : null;
  const press = useRef<number | null>(null);
  const origin = useRef({ x: 0, y: 0 });
  const openedAt = useRef(0);
  const selected = selectedId === task.id;
  const trace = activity?.traces[task.id];
  const badge = history || (done && depth > 0) ? null : stateBadge(current, trace);
  const stale = current === "working" && isStaleWorking(task, activity);
  const note = [
    showProject && depth === 0 ? (task.project ?? "") : "",
    rowNote(task, tasks, current, trace, activity?.traces ?? {}),
  ]
    .filter((part) => part !== "")
    .join(" · ");
  const describedBy = [
    `task-id-${task.id}`,
    notice !== null ? `task-error-${task.id}` : null,
  ].filter((id) => id !== null);

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
      {/* biome-ignore lint/a11y/useSemanticElements: the card is a row of block content. */}
      <div
        data-task-card=""
        role="button"
        tabIndex={0}
        aria-current={selected ? "true" : undefined}
        aria-label={`Open ${plainInline(task.title)}`}
        aria-describedby={describedBy.length > 0 ? describedBy.join(" ") : undefined}
        className={cn(
          "flex min-h-11 w-full cursor-pointer select-none items-center gap-3 rounded-md border border-border bg-surface px-3 py-2 text-left hover:bg-muted",
          backlog &&
            "border-dashed bg-surface/60 text-muted-foreground backdrop-blur-sm saturate-0",
          selected && "ring-1 ring-foreground",
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
          if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
            event.preventDefault();
            const box = event.currentTarget.getBoundingClientRect();
            openMenu(box.left + 16, box.top + box.height / 2);
            return;
          }
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          onOpen(task.id);
        }}
      >
        <span className="flex min-w-0 flex-1 flex-col justify-start gap-0.5 self-stretch">
          <span
            className={cn(
              "line-clamp-2 min-w-0 text-sm leading-5 [overflow-wrap:anywhere]",
              done || backlog ? "text-muted-foreground" : "text-foreground",
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
        <span className="flex min-h-9 shrink-0 flex-col items-end justify-between self-stretch">
          <span className="flex items-center justify-end gap-1.5">
            {badge !== null && (
              <Badge
                variant={current === "working" || current === "failed" ? "default" : "outline"}
              >
                {badge}
              </Badge>
            )}
            {stale && <StaleMarker id={task.id} />}
            <TaskIdChip id={task.id} />
          </span>
          <TaskCardTimes task={task} />
        </span>
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
              ignoreNextCardClick={ignoreNextCardClick}
              problem={problem}
              menuTaskId={menuTaskId}
              onOpenMenu={onOpenMenu}
              onOpen={onOpen}
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
        <span className="flex min-w-0 flex-1 basis-40 flex-col justify-start gap-0.5 self-stretch">
          <span className="line-clamp-2 text-sm leading-5 [overflow-wrap:anywhere]">
            <InlineMarkdown text={task.title} />
          </span>
          {showProject && task.project !== undefined && (
            <span className="text-xs leading-4 text-muted-foreground [overflow-wrap:anywhere]">
              {task.project}
            </span>
          )}
        </span>
        <span className="ml-auto flex shrink-0 flex-col items-end justify-between gap-1 self-stretch">
          <span className="flex items-center justify-end gap-2">
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
            <TaskIdBadge id={task.id} />
          </span>
          <TaskCardTimes task={task} />
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

/** The compact created/closed clock on a task card; the detail keeps the long form. */
export function TaskCardTimes({ task }: { task: Task }) {
  const created = formatTime(task.createdAt);
  const closedAt =
    task.status === "done" && typeof task.completedAt === "string" ? task.completedAt : null;
  const closed = closedAt === null ? "" : formatTime(closedAt);
  return (
    <span
      data-testid="task-card-times"
      className="flex flex-wrap items-end justify-end gap-x-2 text-xs leading-4 text-muted-foreground"
    >
      <time dateTime={task.createdAt} title={formatDateTime(task.createdAt)}>
        Created {created}
      </time>
      {closedAt !== null && (
        <time dateTime={closedAt} title={formatDateTime(closedAt)}>
          Closed {closed}
        </time>
      )}
    </span>
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
  wide,
  statusPending = false,
  notice,
  onClose,
  onOpen,
  onStatus,
  onApprove,
  onDismiss,
  onRemove,
  onLedger,
}: {
  task: Task;
  tasks: Task[];
  state: TaskState;
  trace: TaskTrace | undefined;
  wide: boolean;
  statusPending?: boolean;
  notice: string | null;
  onClose: () => void;
  onOpen: (id: string) => void;
  onStatus: (task: Task, status: Task["status"]) => void;
  onApprove: () => void;
  onDismiss: () => void;
  onRemove: () => void;
  /** Called after an inline edit saves, so the tasks page takes the new ledger. */
  onLedger?: (ledger: TaskLedger) => void;
}) {
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(task.title);
  const [titleError, setTitleError] = useState<string | null>(null);
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const titleBusy = useRef(false);

  const [editingBody, setEditingBody] = useState(false);
  const [bodyDraft, setBodyDraft] = useState(task.body ?? "");
  const [bodyError, setBodyError] = useState<string | null>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const bodyEditorRef = useRef<HTMLDivElement>(null);
  const bodyIgnoreBlur = useRef(false);
  const bodyBusy = useRef(false);

  const [projectDraft, setProjectDraft] = useState(task.project ?? "");
  const [projectError, setProjectError] = useState<string | null>(null);
  const [projectOpen, setProjectOpen] = useState(false);
  const [projectActive, setProjectActive] = useState(0);
  const projectAnchor = useRef<HTMLDivElement>(null);
  const projectBusy = useRef(false);
  const projects = projectsOf(tasks.filter((item) => isActiveStatus(item.status)));
  const projectQuery = projectDraft.trim().replace(/^@/, "");
  const projectMatches =
    projectOpen && projectDraft.trim().length > 0 ? projectSuggestions(projects, projectQuery) : [];
  const activeProject = Math.min(projectActive, Math.max(0, projectMatches.length - 1));

  // A different task starts with a clean editor; a saved edit refreshes its draft.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only when the open task changes
  useEffect(() => {
    setEditingTitle(false);
    setTitleDraft(task.title);
    setTitleError(null);
    setEditingBody(false);
    setBodyDraft(task.body ?? "");
    setBodyError(null);
    setProjectDraft(task.project ?? "");
    setProjectError(null);
    setProjectOpen(false);
  }, [task.id]);

  useEffect(() => {
    if (!editingTitle) setTitleDraft(task.title);
  }, [task.title, editingTitle]);

  useEffect(() => {
    if (!editingBody) setBodyDraft(task.body ?? "");
  }, [task.body, editingBody]);

  useEffect(() => {
    if (!projectBusy.current) setProjectDraft(task.project ?? "");
  }, [task.project]);

  useEffect(() => {
    if (editingTitle) titleRef.current?.focus();
  }, [editingTitle]);

  useEffect(() => {
    if (!editingBody) return;
    const element = bodyRef.current;
    if (element === null) return;
    element.focus({ preventScroll: true });
    element.setSelectionRange(element.value.length, element.value.length);
  }, [editingBody]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the draft changes the height being measured
  useLayoutEffect(() => {
    if (!editingTitle) return;
    const element = titleRef.current;
    if (element === null) return;
    element.style.height = "0px";
    element.style.height = `${element.scrollHeight}px`;
  }, [editingTitle, titleDraft]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: bodyDraft, wide and bodyError change the height being measured
  useLayoutEffect(() => {
    if (!editingBody) return;
    const element = bodyRef.current;
    if (element === null) return;
    element.style.height = "0px";
    const contentHeight = element.scrollHeight;
    if (wide) {
      const available = bodyEditorRef.current?.clientHeight ?? contentHeight;
      element.style.height = `${Math.min(contentHeight, available)}px`;
      element.style.overflowY = contentHeight > available ? "auto" : "hidden";
    } else {
      element.style.height = `${contentHeight}px`;
      element.style.overflowY = "auto";
    }
  }, [editingBody, bodyDraft, bodyError, wide]);

  const saveTitle = async (value = titleDraft) => {
    if (titleBusy.current) return;
    const next = value.trim();
    if (next.length === 0) {
      setTitleError("Title must not be empty");
      setTitleDraft(task.title);
      setEditingTitle(false);
      return;
    }
    if (next === task.title) {
      setTitleDraft(task.title);
      setTitleError(null);
      setEditingTitle(false);
      return;
    }
    haptic();
    titleBusy.current = true;
    const outcome = await updateTask(task.id, { title: next });
    titleBusy.current = false;
    if (!outcome.ok) {
      setTitleError(outcome.error);
      setTitleDraft(task.title);
      setEditingTitle(false);
      return;
    }
    setTitleError(null);
    setTitleDraft(next);
    setEditingTitle(false);
    onLedger?.(outcome.ledger);
  };

  const saveBody = async (value = bodyDraft) => {
    if (bodyBusy.current) return;
    const next = value.trim();
    if (next.length > TASK_BODY_MAX_LENGTH) {
      setBodyError(`Body must be at most ${TASK_BODY_MAX_LENGTH} characters`);
      return;
    }
    if (next === (task.body ?? "")) {
      setBodyError(null);
      bodyIgnoreBlur.current = true;
      setEditingBody(false);
      return;
    }
    haptic();
    bodyBusy.current = true;
    const outcome = await updateTask(task.id, { body: next });
    bodyBusy.current = false;
    if (!outcome.ok) {
      setBodyError(outcome.error);
      return;
    }
    setBodyError(null);
    setBodyDraft(next);
    bodyIgnoreBlur.current = true;
    setEditingBody(false);
    onLedger?.(outcome.ledger);
  };

  const beginBodyEdit = () => {
    if (editingBody) return;
    bodyIgnoreBlur.current = false;
    setBodyDraft(task.body ?? "");
    setBodyError(null);
    setEditingBody(true);
  };

  const saveProject = async (value = projectDraft) => {
    if (projectBusy.current) return;
    const typed = value.trim().replace(/^@/, "");
    const next = typed.length === 0 ? null : typed;
    const unchanged = next === null ? task.project === undefined : sameProject(next, task.project);
    if (unchanged) {
      setProjectDraft(task.project ?? "");
      setProjectError(null);
      setProjectOpen(false);
      return;
    }
    haptic();
    projectBusy.current = true;
    const outcome = await updateTask(task.id, { project: next });
    projectBusy.current = false;
    if (!outcome.ok) {
      setProjectError(outcome.error);
      setProjectOpen(false);
      return;
    }
    setProjectError(null);
    setProjectDraft(outcome.ledger.tasks.find((item) => item.id === task.id)?.project ?? "");
    setProjectOpen(false);
    onLedger?.(outcome.ledger);
  };

  const acceptProject = (name: string) => {
    setProjectDraft(name);
    setProjectActive(0);
    setProjectOpen(false);
    setProjectError(null);
    void saveProject(name);
  };
  const done = task.status === "done";
  const proposed = task.status === "proposed";
  const parked = task.status === "backlog";
  const backlogLabel = parked ? "Reopen" : "Backlog";
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
  const reason =
    state === "failed" && trace?.lastRun?.reason !== undefined ? trace.lastRun.reason : null;
  const badge = stateBadge(state, trace) ?? "Open";
  const title = plainInline(task.title);

  return (
    <Card
      data-testid="task-detail"
      aria-label={title}
      role="article"
      className={cn(wide && "h-full min-h-0")}
    >
      <CardHeader className={cn(wide && "min-h-0 flex-1 overflow-hidden")}>
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
        </div>
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            {editingTitle ? (
              <div className="flex min-w-0 flex-col gap-1">
                <textarea
                  ref={titleRef}
                  aria-label="Task title"
                  aria-invalid={titleError !== null ? true : undefined}
                  data-testid="task-title-input"
                  rows={Math.max(1, titleDraft.split("\n").length)}
                  value={titleDraft}
                  onChange={(event) => {
                    setTitleDraft(event.target.value);
                    setTitleError(null);
                  }}
                  onBlur={(event) => void saveTitle(event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      event.preventDefault();
                      event.stopPropagation();
                      setTitleDraft(task.title);
                      setTitleError(null);
                      setEditingTitle(false);
                    }
                  }}
                  className="block w-full min-w-0 resize-none overflow-hidden border-0 bg-transparent p-0 text-lg font-semibold leading-7 text-foreground outline-none [overflow-wrap:anywhere] focus-visible:ring-1 focus-visible:ring-foreground"
                />
                {titleError !== null && <ErrorText>{titleError}</ErrorText>}
              </div>
            ) : (
              <div className="flex w-full min-w-0 flex-col gap-1">
                {/* biome-ignore lint/a11y/useSemanticElements: the read-only markdown is replaced by a textarea when focused. */}
                <div
                  role="textbox"
                  aria-readonly="true"
                  aria-label="Task title"
                  tabIndex={0}
                  data-testid="task-title"
                  className="min-w-0 cursor-text outline-none focus-visible:ring-1 focus-visible:ring-foreground"
                  onFocus={() => {
                    setTitleDraft(task.title);
                    setTitleError(null);
                    setEditingTitle(true);
                  }}
                >
                  <h2 className="min-w-0 text-lg font-semibold leading-7 [overflow-wrap:anywhere]">
                    <InlineMarkdown text={task.title} />
                  </h2>
                </div>
                {titleError !== null && <ErrorText>{titleError}</ErrorText>}
              </div>
            )}
          </div>
          <span className="mt-1 flex shrink-0 items-center gap-1.5">
            <TaskIdBadge id={task.id} testId="task-detail-id" />
            <Badge
              data-testid="task-state"
              variant={state === "working" || state === "failed" ? "default" : "outline"}
            >
              {badge}
            </Badge>
          </span>
        </div>
        <div className="flex min-w-0 flex-col gap-1" data-testid="task-project-line">
          <div className="flex min-w-0 items-center gap-3">
            <span className="shrink-0 text-xs leading-4 text-muted-foreground">Project</span>
            <div ref={projectAnchor} className="min-w-0 flex-1">
              {projectMatches.length > 0 && (
                <ProjectSuggestions
                  anchor={projectAnchor}
                  items={projectMatches}
                  active={activeProject}
                  onHover={setProjectActive}
                  onAccept={(item) => acceptProject(item.name)}
                />
              )}
              <input
                type="text"
                aria-label="Task project"
                data-testid="task-project-input"
                value={projectDraft}
                placeholder="No project"
                aria-autocomplete="list"
                aria-controls={projectMatches.length > 0 ? "project-suggestions" : undefined}
                aria-activedescendant={
                  projectMatches.length > 0 ? `project-suggestion-${activeProject}` : undefined
                }
                onChange={(event) => {
                  setProjectDraft(event.target.value);
                  setProjectError(null);
                  setProjectActive(0);
                  setProjectOpen(true);
                }}
                onFocus={() => setProjectActive(0)}
                onBlur={() => {
                  setProjectOpen(false);
                  void saveProject();
                }}
                onKeyDown={(event) => {
                  if (projectMatches.length > 0) {
                    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                      event.preventDefault();
                      const count = projectMatches.length;
                      setProjectActive(
                        (activeProject + (event.key === "ArrowDown" ? 1 : count - 1)) % count,
                      );
                      return;
                    }
                    if (event.key === "Enter" || event.key === "Tab") {
                      event.preventDefault();
                      const item = projectMatches[activeProject];
                      if (item !== undefined) acceptProject(item.name);
                      return;
                    }
                    if (event.key === "Escape") {
                      event.preventDefault();
                      event.stopPropagation();
                      setProjectOpen(false);
                      return;
                    }
                  }
                  if (event.key === "Enter") {
                    event.preventDefault();
                    setProjectOpen(false);
                    void saveProject();
                  } else if (event.key === "Escape") {
                    event.preventDefault();
                    event.stopPropagation();
                    setProjectDraft(task.project ?? "");
                    setProjectError(null);
                    setProjectOpen(false);
                  }
                }}
                className="h-8 w-full min-w-0 rounded-md border border-border bg-background px-2 text-sm leading-5 text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-foreground"
              />
            </div>
          </div>
          {projectError !== null && <ErrorText>{projectError}</ErrorText>}
        </div>
        {editingBody ? (
          <div
            data-testid="task-body-section"
            className={cn("flex min-w-0 flex-col gap-1", wide && "min-h-0 flex-1")}
          >
            <div
              ref={bodyEditorRef}
              className={cn("flex min-w-0 flex-col", wide && "min-h-0 flex-1 overflow-hidden")}
            >
              <textarea
                ref={bodyRef}
                aria-label="Task body"
                data-testid="task-body-input"
                rows={1}
                maxLength={TASK_BODY_MAX_LENGTH}
                value={bodyDraft}
                placeholder="Write markdown…"
                onChange={(event) => {
                  setBodyDraft(event.target.value);
                  setBodyError(null);
                }}
                onBlur={(event) => {
                  if (bodyIgnoreBlur.current) {
                    bodyIgnoreBlur.current = false;
                    return;
                  }
                  void saveBody(event.currentTarget.value);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.preventDefault();
                    event.stopPropagation();
                    bodyIgnoreBlur.current = true;
                    setBodyDraft(task.body ?? "");
                    setBodyError(null);
                    setEditingBody(false);
                  }
                }}
                className={cn(
                  "block w-full min-w-0 resize-none border-0 bg-transparent p-0 pr-1 text-sm leading-5 text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-foreground",
                  wide ? "overflow-hidden" : "overflow-y-auto max-h-[min(60vh,40rem)]",
                )}
              />
            </div>
            {bodyError !== null && <ErrorText>{bodyError}</ErrorText>}
          </div>
        ) : (
          // biome-ignore lint/a11y/useSemanticElements: the body keeps its markdown descendants instead of becoming a fieldset.
          <div
            data-testid="task-body-section"
            role="group"
            aria-label="Task body"
            {...{ tabIndex: 0 }}
            className={cn(
              "flex min-w-0 cursor-text flex-col gap-1 outline-none focus-visible:ring-1 focus-visible:ring-foreground",
              wide && "min-h-0 flex-1",
            )}
            onClick={(event) => {
              if (event.target instanceof Element && event.target.closest("a, button") !== null) {
                return;
              }
              beginBodyEdit();
            }}
            onKeyDown={(event) => {
              if (event.target !== event.currentTarget) return;
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                beginBodyEdit();
              }
            }}
          >
            <div
              data-testid={
                task.body !== undefined && task.body.length > 0 ? "task-body" : undefined
              }
              className={cn(
                "min-w-0 cursor-text text-sm leading-5",
                task.body !== undefined && task.body.length > 0
                  ? cn(
                      "overflow-y-auto pr-1",
                      wide ? "min-h-0 max-h-full flex-1" : "max-h-[min(60vh,40rem)]",
                    )
                  : "text-muted-foreground",
              )}
            >
              {task.body !== undefined && task.body.length > 0 ? (
                <Markdown text={task.body} />
              ) : (
                <p className="whitespace-pre-wrap break-words">Write markdown…</p>
              )}
            </div>
          </div>
        )}
      </CardHeader>
      <CardContent
        className={cn(
          "flex flex-col gap-4",
          wide && "max-h-[40vh] min-h-0 shrink-0 overflow-y-auto",
        )}
      >
        <TaskTimes task={task} />
        {reason !== null && (
          <p data-testid="task-failure" className="text-sm leading-5 text-muted-foreground">
            {reason}
          </p>
        )}
        {task.rationale !== undefined && task.rationale.length > 0 && (
          <div
            data-testid="task-rationale"
            className={cn("min-w-0", wide && "max-h-40 overflow-y-auto pr-1")}
          >
            <p className="whitespace-pre-wrap text-sm leading-5 [overflow-wrap:anywhere]">
              {task.rationale}
            </p>
          </div>
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
        {notice !== null && <ErrorText>{notice}</ErrorText>}
      </CardContent>
      <CardFooter
        className={cn("flex-wrap gap-2", wide && "shrink-0")}
        data-testid="task-detail-actions"
      >
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
            <Button
              variant="outline"
              size="sm"
              data-testid="task-detail-backlog"
              className="shrink-0 rounded-md"
              disabled={statusPending}
              onClick={() => onStatus(task, parked ? "open" : "backlog")}
            >
              {backlogLabel}
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
            {!done && (
              <Button
                variant="outline"
                size="sm"
                data-testid="task-detail-backlog"
                className="shrink-0 rounded-md"
                disabled={statusPending}
                onClick={() => onStatus(task, parked ? "open" : "backlog")}
              >
                {backlogLabel}
              </Button>
            )}
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
  notice,
  statusPending,
  onStatus,
  onRemove,
}: {
  task: Task;
  tasks: Task[];
  point: { x: number; y: number };
  notice: string | null;
  statusPending: boolean;
  onStatus: (task: Task, status: Task["status"]) => void;
  onRemove: () => void;
}) {
  const done = task.status === "done";
  const openChildren = !done && hasOpenDescendant(tasks, task.id);
  const left = Math.max(8, Math.min(point.x, window.innerWidth - 248));
  const top = Math.max(8, Math.min(point.y, window.innerHeight - 200));
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
      {notice !== null && <div className="-mx-1 my-1 h-px bg-border" />}
      {!done && (
        <button
          type="button"
          role="menuitem"
          data-testid="task-menu-backlog"
          aria-label={`${task.status === "backlog" ? "Reopen" : "Backlog"} ${plainInline(task.title)}`}
          disabled={statusPending}
          className={cn(item, "disabled:opacity-50")}
          onClick={() => onStatus(task, task.status === "backlog" ? "open" : "backlog")}
        >
          {task.status === "backlog" ? "Reopen" : "Backlog"}
        </button>
      )}
      <button
        type="button"
        role="menuitem"
        aria-label={`${done ? "Reopen" : "Mark done"} ${plainInline(task.title)}`}
        aria-disabled={openChildren}
        disabled={openChildren}
        title={openChildren ? "Finish open subtasks first" : undefined}
        className={cn(item, "disabled:opacity-50")}
        onClick={() => {
          if (openChildren) return;
          onStatus(task, done ? "open" : "done");
        }}
      >
        {done ? "Reopen" : "Mark done"}
      </button>
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
