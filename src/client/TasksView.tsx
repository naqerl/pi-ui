import {
  memo,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { taskDeepLinkFromLocation } from "../shared/pages";
import { projectsOf, sameProject } from "../shared/project";
import { indexTasks, type TaskIndex } from "../shared/task-index";
import { isStaleWorking, subtaskCount, taskState } from "../shared/task-status";
import {
  compareTasks,
  formatActiveTime,
  formatTokenCount,
  hasOpenDescendant,
  isActiveStatus,
  liveBlockerIds,
  TASK_BODY_MAX_LENGTH,
  TASK_REOPEN_REASON_MAX_LENGTH,
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
import { EmptyCaption } from "./EmptyCaption";
import { haptic } from "./haptics";
import { CheckIcon, CloseIcon, RefreshIcon } from "./icons";
import { cn } from "./lib/utils";
import { InlineMarkdown, plainInline } from "./markdown";
import { projectSuggestions } from "./ProjectSuggestions";
import { TaskAgentChat } from "./TaskAgentChat";
import { type TaskDetailModel, TaskDetailVariant } from "./TaskDetailVariants";
import { TaskPlanningBadge } from "./TaskPlanningBadge";
import { removeTask, type TaskOutcome, updateTask } from "./task-client";
import { FIXTURE_PLAN_ID, mergeFixtureTasks } from "./task-detail-fixture";
import { useTaskDetailFixture } from "./task-detail-query";
import { useRegisterTaskSurfaceStatus } from "./task-dock-composer";
import { TaskLinkProvider } from "./task-link";
import { useTaskMedia } from "./use-task-media";
import { useWide, WIDE_QUERY } from "./use-wide";
import { taskStatusWord } from "./working-state";

export { useWide, WIDE_QUERY };

const LONG_PRESS_MS = 500;
/** A pointer sequence this long after the menu opened cannot still be the dismissing tap. */
const CARD_CLICK_IGNORE_MS = 700;
/** Past days of the done list shown at first; "Show older days" adds this many more. */
const DAY_PAGE = 7;
/** TaskRow also renders on its own in tests, where no plan run is live. */
const EMPTY_PLANNING: ReadonlySet<string> = new Set();
/** One vertical rhythm for every header and card stack on the tasks page. */
const TASK_STACK = "flex flex-col space-y-2";
/** Same type as a stats widget section title. */
const STATS_SECTION_TITLE =
  "text-[11px] tracking-wide text-muted-foreground [overflow-wrap:anywhere]";
/** Reserve the scrollbar's gutter so content never reflows or slides under the thumb. */
const SCROLLBAR_GUTTER = "[scrollbar-gutter:stable]";

/** A painted create whose request failed: the row stays until Retry succeeds. */
export interface TaskCreateFailure {
  error: string;
  retrying: boolean;
  onRetry: () => void;
}

interface TasksViewProps {
  tasks: Task[];
  /** Task ids whose plan agent currently has a live run. */
  planning?: readonly string[];
  activity?: TaskActivity;
  ready: boolean;
  footerClearance: number;
  onLedger: (ledger: TaskLedger) => void;
  /** A task id another page asked to open, with a request count so repeats still open it. */
  selection?: { id: string; request: number } | null;
  /** True while a task detail covers the mobile list, so the page composer can hide. */
  onMobileDetailChange?: (open: boolean) => void;
  /** Which composer belongs in the shared float footer on the Tasks page. */
  onComposerMode?: (mode: "create" | "task-chat" | "collapsed") => void;
  /** Failed optimistic creates keyed by their client task id. */
  createFailures?: Record<string, TaskCreateFailure>;
}

/** Root tasks split into one group per project, A–Z, with "No project" (null) last. */
export function groupByProject<T extends { project?: string }>(
  items: T[],
): Array<[string | null, T[]]> {
  const groups = new Map<string, T[]>();
  const names = new Map<string, string>();
  const loose: T[] = [];
  for (const item of items) {
    if (item.project === undefined) {
      loose.push(item);
      continue;
    }
    const folded = item.project.toLowerCase();
    const key = names.get(folded) ?? item.project;
    names.set(folded, key);
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

/** One pointerdown/up/click sequence; the token is shared by every handler on that event. */
type CardPointerToken = { sequence: number };
type CardClickGuard = {
  pointer: CardPointerToken | null;
  ignore: CardPointerToken | null;
  timer: number | null;
};
let cardPointerSequence = 0;
const cardPointerTokens = new WeakMap<Event, CardPointerToken>();

function cardPointerToken(event: Event): CardPointerToken {
  const known = cardPointerTokens.get(event);
  if (known !== undefined) return known;
  const token = { sequence: ++cardPointerSequence };
  cardPointerTokens.set(event, token);
  return token;
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
        "flex min-h-7 items-center gap-2 rounded-md py-1",
        dark ? "bg-surface px-3" : "px-1",
      )}
    >
      <span className={cn("min-w-0 flex-1 truncate", STATS_SECTION_TITLE)}>{children}</span>
      {chevron}
      {count !== undefined && (
        <span className="shrink-0 text-[11px] font-normal tabular-nums text-muted-foreground">
          {count}
        </span>
      )}
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
            "flex min-h-7 w-full items-center gap-2 rounded-md py-1 text-left",
            dark ? "bg-surface px-3" : "px-1 hover:bg-muted",
          )}
        >
          <span className={cn("min-w-0 flex-1 truncate", STATS_SECTION_TITLE)}>{title}</span>
          <Chevron open={open} className="text-muted-foreground" />
          {count !== undefined && (
            <span className="shrink-0 text-[11px] font-normal tabular-nums text-muted-foreground">
              {count}
            </span>
          )}
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

export const TasksView = memo(TasksViewImpl);

function TasksViewImpl({
  tasks: incomingTasks,
  planning: planningIds = [],
  activity,
  ready,
  onLedger,
  selection = null,
  onMobileDetailChange,
  onComposerMode,
  createFailures,
}: TasksViewProps) {
  const wide = useWide();
  const fixtureOn = useTaskDetailFixture();
  const linkedTask = useRef(
    typeof window === "undefined" ? null : taskDeepLinkFromLocation(window.location.href),
  );
  const serverTasks = fixtureOn ? mergeFixtureTasks(incomingTasks) : incomingTasks;
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [problem, setProblem] = useState<{ id: string; message: string } | null>(null);
  const [statusPending, setStatusPending] = useState<Record<string, boolean>>({});
  const [openTaskId, setOpenTaskId] = useState<string | null>(() =>
    fixtureOn ? FIXTURE_PLAN_ID : (linkedTask.current?.id ?? null),
  );
  const [reopenTaskId, setReopenTaskId] = useState<string | null>(null);
  const [dayLimit, setDayLimit] = useState(DAY_PAGE);
  // A decision paints its row before the request returns; null means the row is gone.
  const [optimisticTasks, setOptimisticTasks] = useState<Record<string, Task | null>>({});
  const optimisticSequence = useRef<Record<string, number>>({});
  const cardClickGuard = useRef<CardClickGuard>({ pointer: null, ignore: null, timer: null });
  const lastSelectionRequest = useRef<number | null>(null);
  const pageRef = useRef<HTMLDivElement | null>(null);
  const returnTo = useRef<{ id: string | null; offset: number; top: number } | null>(null);
  const openTaskIdRef = useRef(openTaskId);
  openTaskIdRef.current = openTaskId;
  const now = new Date();

  const tasks = useMemo(
    () =>
      serverTasks.flatMap((task) => {
        if (!(task.id in optimisticTasks)) return [task];
        const replacement = optimisticTasks[task.id];
        return replacement === null ? [] : [replacement];
      }),
    [serverTasks, optimisticTasks],
  );
  const planning = useMemo(() => {
    const live = new Set(planningIds);
    for (const task of tasks) {
      if (task.planning === true) live.add(task.id);
    }
    return live;
  }, [planningIds, tasks]);
  const facts = useMemo(() => indexTasks(tasks), [tasks]);
  const stateOf = useMemo(
    () =>
      new Map(
        tasks.map((task) => [
          task.id,
          createFailures?.[task.id] === undefined
            ? taskState(tasks, task, activity, facts)
            : ("failed" as TaskState),
        ]),
      ),
    [tasks, activity, facts, createFailures],
  );
  const state = (task: Task): TaskState => stateOf.get(task.id) ?? "ready";
  const activeTasks = useMemo(() => tasks.filter((task) => task.status !== "proposed"), [tasks]);
  const rowIndex = useMemo(() => indexTasks(activeTasks), [activeTasks]);
  const proposedTasks = tasks
    .filter((task) => task.status === "proposed")
    .sort((a, b) => {
      const left = a.proposedAt ?? a.createdAt;
      const right = b.proposedAt ?? b.createdAt;
      return left === right ? (a.id < b.id ? -1 : 1) : left < right ? -1 : 1;
    });
  // A failed create is still the operator's problem even when its row is a backlog task.
  const failedTasks = activeTasks.filter(
    (task) => task.status !== "done" && state(task) === "failed",
  );
  const ids = new Set(activeTasks.map((task) => task.id));
  const roots = activeTasks
    .filter((task) => task.parentId === null || !ids.has(task.parentId))
    .sort(rowIndex.compare);
  const hasChildren = (task: Task) => (rowIndex.children.get(task.id)?.length ?? 0) > 0;
  // A failed leaf already sits under "Needs you"; a failed parent stays in the tree with its subtasks.
  const activeRoots = roots.filter(
    (task) => task.status !== "done" && !(state(task) === "failed" && !hasChildren(task)),
  );
  // Open work is grouped by project once any task has one; grouped rows drop the label.
  const projectGroups = groupByProject(activeRoots);
  const grouped = projectGroups.some(([name]) => name !== null);
  const doneRoots = roots.filter((task) => task.status === "done").sort(byCompletedDesc);
  const days = groupByDay(doneRoots, (task) => task.completedAt ?? task.createdAt);
  const today = dayKey(now);
  if (days.length > 0 && days[0]?.[0] !== today) days.unshift([today, []]);

  const apply = async (
    id: string,
    outcome: Promise<TaskOutcome>,
    optimistic?: (task: Task) => Task | null,
  ) => {
    haptic();
    const sequence = (optimisticSequence.current[id] ?? 0) + 1;
    optimisticSequence.current[id] = sequence;
    if (optimistic !== undefined) {
      const task = tasks.find((item) => item.id === id);
      if (task !== undefined) {
        setOptimisticTasks((current) => ({ ...current, [id]: optimistic(task) }));
      }
    }
    const next = await outcome;
    // A newer action for this row owns the result now.
    if (optimisticSequence.current[id] !== sequence) return;
    setOptimisticTasks((current) => {
      if (!(id in current)) return current;
      const copy = { ...current };
      delete copy[id];
      return copy;
    });
    if (!next.ok) {
      setProblem({ id, message: next.error });
      return;
    }
    setProblem((current) => (current?.id === id ? null : current));
    onLedger(next.ledger);
  };

  const approve = (task: Task) =>
    void apply(task.id, updateTask(task.id, { status: "open" }), (current) => ({
      ...current,
      status: "open",
      proposedAt: null,
    }));
  const dismiss = (task: Task) => void apply(task.id, removeTask(task.id), () => null);

  const menuTask = menu === null ? undefined : activeTasks.find((task) => task.id === menu.id);
  // A failed create only exists on the client until Retry succeeds; its pending id has no detail.
  const openTask =
    openTaskId === null || createFailures?.[openTaskId] !== undefined
      ? undefined
      : tasks.find((task) => task.id === openTaskId);
  const reopenTask =
    reopenTaskId === null ? undefined : tasks.find((task) => task.id === reopenTaskId);
  // The tasks page owns its status: the open task's plan run, or nothing when no task is open.
  const openTaskStatus = useMemo(() => {
    if (openTask === undefined) return null;
    const word = taskStatusWord(
      openTask.id,
      planning.has(openTask.id) && isActiveStatus(openTask.status),
    );
    return word === null ? null : { taskId: openTask.id, word };
  }, [openTask, planning]);
  useRegisterTaskSurfaceStatus(openTaskStatus);

  // A narrow detail is a history entry of its own, so the OS back gesture closes
  // it. Replacing an open detail keeps one entry, not a stack of them.
  const openDetail = useCallback(
    (id: string) => {
      if (!wide) {
        const page = pageRef.current;
        // Only the list -> detail step owns a return position. Opening a child
        // from a parent detail keeps pointing at the original list position.
        if (openTaskIdRef.current === null && page !== null) {
          const pageRect = page.getBoundingClientRect();
          let anchor: { id: string; offset: number } | null = null;
          for (const card of page.querySelectorAll<HTMLElement>("[data-task-card]")) {
            const row = card.closest<HTMLElement>('li[data-testid^="task-"]');
            const testId = row?.dataset.testid;
            if (testId === undefined || !testId.startsWith("task-")) continue;
            const rect = card.getBoundingClientRect();
            if (rect.bottom <= pageRect.top + 1) continue;
            anchor = {
              id: testId.slice("task-".length),
              offset: rect.top - pageRect.top,
            };
            break;
          }
          returnTo.current = {
            id: anchor?.id ?? null,
            offset: anchor?.offset ?? 0,
            top: page.scrollTop,
          };
        }
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

  // The chat asks for a task by id after moving the pager to this page. The request count
  // lets the same id open again without the wide layout's first-row default replacing it.
  useEffect(() => {
    if (selection === null || lastSelectionRequest.current === selection.request) return;
    lastSelectionRequest.current = selection.request;
    openDetail(selection.id);
  }, [openDetail, selection]);

  useEffect(() => {
    onMobileDetailChange?.(!wide && openTaskId !== null);
    return () => onMobileDetailChange?.(false);
  }, [onMobileDetailChange, openTaskId, wide]);

  const closeDetail = useCallback(() => {
    if (!wide && taskDetailHistory()?.piTaskDetailId !== undefined) {
      window.history.back();
      return;
    }
    setOpenTaskId(null);
  }, [wide]);

  useEffect(() => {
    const onPop = (event: PopStateEvent) => {
      if (wide) return;
      const state = event.state as TaskDetailHistoryState | null;
      // Our own detail entry can surface as a popstate around a pager or a
      // replaceState; only a genuine back to an entry without this detail closes it.
      setOpenTaskId((current) =>
        current !== null && state?.piTaskDetailId === current ? current : null,
      );
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [wide]);

  useEffect(() => {
    if (!ready) return;
    if (openTaskId !== null && !tasks.some((task) => task.id === openTaskId)) {
      setOpenTaskId(null);
    }
  }, [openTaskId, ready, tasks]);

  useEffect(() => {
    if (fixtureOn) {
      openDetail(FIXTURE_PLAN_ID);
      return;
    }
    // A notification's task link owns the first render. Later layout changes
    // keep the existing narrow-list behaviour.
    if (!wide && linkedTask.current?.id === openTaskIdRef.current) {
      linkedTask.current = null;
      return;
    }
    if (!wide) setOpenTaskId(null);
  }, [wide, fixtureOn, openDetail]);

  useEffect(() => {
    const openLinkedTask = () => {
      const link =
        typeof window === "undefined" ? null : taskDeepLinkFromLocation(window.location.href);
      if (link !== null) openDetail(link.id);
    };
    window.addEventListener("hashchange", openLinkedTask);
    return () => window.removeEventListener("hashchange", openLinkedTask);
  }, [openDetail]);

  const armCardClickIgnore = useCallback((token: CardPointerToken) => {
    const guard = cardClickGuard.current;
    guard.ignore = token;
    if (guard.timer !== null) window.clearTimeout(guard.timer);
    guard.timer = window.setTimeout(() => {
      guard.timer = null;
      if (guard.ignore === token) guard.ignore = null;
    }, CARD_CLICK_IGNORE_MS);
  }, []);

  useEffect(() => {
    return () => {
      const timer = cardClickGuard.current.timer;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    if (menu === null) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (document.getElementById("task-menu")?.contains(target)) return;
      // A tap that only dismisses the menu must not also open the row. The token
      // belongs to this pointer sequence, so a missing click cannot poison the
      // next tap, which carries a new token.
      if (target instanceof Element && target.closest("[data-task-card]") !== null) {
        armCardClickIgnore(cardPointerToken(event));
      } else if (cardClickGuard.current.ignore !== null) {
        cardClickGuard.current.ignore = null;
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
  }, [armCardClickIgnore, menu]);

  useEffect(() => {
    if (openTaskId === null || menu !== null) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const target = event.target;
      // Title, body, and other fields use Escape to cancel an edit.
      if (
        target instanceof HTMLElement &&
        target.closest("input, textarea, select, [contenteditable='true']") !== null
      ) {
        return;
      }
      // Capture while a portaled menu still exists so Escape closes the menu,
      // not the task detail behind it.
      if (
        document.querySelector(
          "[data-slot='dropdown-menu-content'], [data-testid='task-detail-menu-content'], [data-testid='task-project-menu']",
        ) !== null
      ) {
        return;
      }
      closeDetail();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [closeDetail, openTaskId, menu]);

  const openMenu = (id: string, x: number, y: number) => {
    if (createFailures?.[id] !== undefined) return;
    setMenu({ id, x, y });
  };
  const requestReopen = async (task: Task, reason: string): Promise<string | null> => {
    haptic();
    const outcome = await updateTask(task.id, { status: "open", reopenReason: reason });
    if (!outcome.ok) return outcome.error;
    onLedger(outcome.ledger);
    return null;
  };
  const setStatus = async (task: Task, status: Task["status"]) => {
    if (task.status === "done" && status === "open") {
      setReopenTaskId(task.id);
      return;
    }
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
    index: rowIndex,
    planning,
    activity,
    state,
    selectedId: openTaskId,
    cardClickGuard,
    armCardClickIgnore,
    problem,
    menuTaskId: menu?.id ?? null,
    onOpenMenu: openMenu,
    onOpen: openDetail,
    showProject: true,
    createFailures,
  };

  const proposal = (task: Task) => (
    <ProposedTask
      key={task.id}
      task={task}
      showProject
      selected={openTaskId === task.id}
      notice={problem?.id === task.id ? problem.message : null}
      onOpen={() => openDetail(task.id)}
      onApprove={() => approve(task)}
      onDismiss={() => dismiss(task)}
    />
  );

  const list = (
    <div
      className={cn(TASK_STACK, "min-w-0", ready && tasks.length === 0 && "flex h-full min-h-0")}
      data-testid="task-list"
    >
      {(proposedTasks.length > 0 || failedTasks.length > 0) && (
        <Section
          title="Needs you"
          count={proposedTasks.length + failedTasks.length}
          id="needs"
          dark
          collapsible
        >
          <ul id="proposed-tasks" className={TASK_STACK} data-testid="task-proposals">
            {proposedTasks.map(proposal)}
            {failedTasks.map((task) => (
              <TaskRow key={task.id} task={task} depth={0} {...rowProps} flat />
            ))}
          </ul>
        </Section>
      )}
      {activeRoots.length > 0 && (
        <Section title="Open" count={activeRoots.length} id="active" dark collapsible>
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
        <div className="flex min-h-0 flex-1 items-center justify-center px-2">
          <EmptyCaption>No tasks yet.</EmptyCaption>
        </div>
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
        planning={planning.has(openTask.id) && isActiveStatus(openTask.status)}
        statusPending={statusPending[openTask.id] === true}
        notice={problem?.id === openTask.id && menu === null ? problem.message : null}
        onClose={closeDetail}
        onOpen={openDetail}
        onStatus={setStatus}
        onApprove={() => approve(openTask)}
        onDismiss={() => dismiss(openTask)}
        onRemove={() => {
          void apply(openTask.id, removeTask(openTask.id));
        }}
        onLedger={(ledger) => {
          setProblem((current) => (current?.id === openTask.id ? null : current));
          onLedger(ledger);
        }}
      />
    );

  const composerMode: "create" | "task-chat" | "collapsed" =
    openTask === undefined ? "create" : openTask.status === "done" ? "collapsed" : "task-chat";

  const detailOpen = openTaskId !== null;

  // A narrow detail and the list share one scroller. Open the detail at its top,
  // then put the list back under the same card when the detail closes.
  useLayoutEffect(() => {
    const page = pageRef.current;
    if (page === null) return;
    if (detailOpen) {
      page.scrollTop = 0;
      return;
    }
    const saved = returnTo.current;
    if (saved === null) return;
    returnTo.current = null;
    const restore = () => {
      const target =
        saved.id === null
          ? null
          : page.querySelector<HTMLElement>(`[data-testid="task-${CSS.escape(saved.id)}"]`);
      if (target === null) {
        page.scrollTop = saved.top;
        return;
      }
      const pageTop = page.getBoundingClientRect().top;
      page.scrollTop += target.getBoundingClientRect().top - pageTop - saved.offset;
    };
    restore();
    const frame = window.requestAnimationFrame(restore);
    return () => window.cancelAnimationFrame(frame);
  }, [detailOpen]);

  // The browser keeps its own scroll for a history entry. A narrow detail owns
  // the scroll while it is present, so stop the back navigation from fighting it.
  useEffect(() => {
    if (wide || !detailOpen) return;
    const previous = window.history.scrollRestoration;
    window.history.scrollRestoration = "manual";
    return () => {
      window.history.scrollRestoration = previous;
    };
  }, [detailOpen, wide]);

  useLayoutEffect(() => {
    onComposerMode?.(composerMode);
  }, [composerMode, onComposerMode]);
  useLayoutEffect(() => {
    return () => onComposerMode?.("create");
  }, [onComposerMode]);

  const content = (
    <div
      className={cn(
        "h-full overflow-x-hidden overscroll-x-none",
        wide || openTask !== undefined
          ? "overflow-hidden"
          : cn("overflow-y-auto", SCROLLBAR_GUTTER),
      )}
      data-testid="tasks-page"
      data-layout={wide ? "split" : "stack"}
      ref={pageRef}
    >
      <div
        className={
          wide
            ? "tasks-split grid h-full min-h-0 w-full grid-cols-[minmax(260px,320px)_minmax(280px,1fr)_minmax(300px,400px)] gap-4 px-4"
            : cn(
                "mx-auto flex h-full min-h-0 w-full max-w-[72ch] flex-col",
                openTask === undefined ? "gap-4 px-4" : "overflow-hidden",
              )
        }
        style={{
          paddingTop: !wide && openTask !== undefined ? 0 : 16,
          paddingBottom: !wide && openTask !== undefined ? 12 : 16,
        }}
        data-tasks-split={wide ? (openTask !== undefined ? "open" : "closed") : undefined}
      >
        {wide ? (
          <>
            <div data-col="side" className="flex h-full min-h-0 min-w-0 flex-col">
              <div
                className={cn(
                  "min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain",
                  SCROLLBAR_GUTTER,
                )}
              >
                {list}
              </div>
            </div>
            {openTask !== undefined ? (
              <>
                <div
                  data-col="mid"
                  data-testid="tasks-mid-col"
                  className="flex h-full min-h-0 min-w-0 flex-col"
                >
                  {detail}
                </div>
                <div
                  data-col="chat"
                  data-testid="tasks-chat-col"
                  className="flex h-full min-h-0 min-w-0 flex-col"
                >
                  <TaskAgentChat
                    key={openTask.id}
                    task={openTask}
                    projects={projectsOf(tasks.filter((item) => isActiveStatus(item.status)))}
                    variant="pane"
                    composerTarget="dock"
                  />
                </div>
              </>
            ) : (
              <div
                data-col="main"
                data-testid="task-detail-empty"
                className="col-span-2 flex h-full min-h-0 min-w-0 flex-1 items-center justify-center px-4"
              >
                <EmptyCaption>Select a task to see its details.</EmptyCaption>
              </div>
            )}
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
      {reopenTask !== undefined &&
        createPortal(
          <ReopenPrompt
            task={reopenTask}
            onCancel={() => setReopenTaskId(null)}
            onSubmit={async (reason) => {
              const error = await requestReopen(reopenTask, reason);
              if (error === null) setReopenTaskId(null);
              return error;
            }}
          />,
          document.body,
        )}
    </div>
  );

  return (
    <TaskLinkProvider tasks={tasks} openTask={openDetail}>
      {content}
    </TaskLinkProvider>
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
          "flex min-h-7 w-full items-center gap-2 rounded-md py-1 text-left",
          dark ? "bg-surface px-3" : "px-1 hover:bg-muted",
        )}
      >
        <span className={cn("min-w-0 flex-1 whitespace-normal", STATS_SECTION_TITLE)}>{label}</span>
        {dark ? (
          <>
            <Chevron open={open} className="text-muted-foreground" />
            <span className="shrink-0 text-[11px] font-normal tabular-nums text-muted-foreground">
              {count}
            </span>
          </>
        ) : (
          <>
            <Chevron open={open} />
            <Badge variant="secondary">{count}</Badge>
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
  index?: TaskIndex,
): TaskMeasured {
  const children = (index ?? indexTasks(tasks)).children;
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
    for (const child of children.get(taskId) ?? []) visit(child.id);
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

function TaskIdChip({ id, className }: { id: string; className?: string }) {
  return (
    <span
      role="note"
      id={`task-id-${id}`}
      data-testid={`task-id-${id}`}
      title={id}
      aria-label={`task ${id}`}
      className={cn(
        "w-fit max-w-full min-w-0 shrink-0 truncate whitespace-nowrap font-mono text-[11px] leading-4 text-muted-foreground",
        className,
      )}
    >
      {shortTaskId(id)}
    </span>
  );
}

/** How many times a task has come back, shown beside its id. */
function ReopenBadge({ task, testId }: { task: Task; testId?: string }) {
  const count = task.reopens?.length ?? 0;
  if (count === 0) return null;
  return (
    <Badge
      variant="outline"
      data-testid={testId ?? `task-reopens-${task.id}`}
      title={`Reopened ${count} time${count === 1 ? "" : "s"}`}
      className="h-4 gap-1 px-1.5 text-[10px] font-normal leading-4 text-muted-foreground"
    >
      <RefreshIcon size={11} />
      {count}
    </Badge>
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
  index?: TaskIndex,
): string {
  const items = index?.children.get(task.id);
  const children =
    index === undefined
      ? subtaskCount(tasks, task.id)
      : {
          total: items?.length ?? 0,
          done: items?.filter((item) => item.status === "done").length ?? 0,
        };
  const subtasks = children.total > 0 ? `${children.done} of ${children.total} subtasks done` : "";
  switch (state) {
    case "blocked": {
      const names = (index?.blockers.get(task.id) ?? liveBlockerIds(tasks, task)).map((id) => {
        const blocker =
          index === undefined ? tasks.find((item) => item.id === id) : index.byId.get(id);
        return blocker === undefined ? id : plainInline(blocker.title);
      });
      if (names.length === 0) return subtasks;
      return `Blocked by ${names[0]}${names.length > 1 ? ` and ${names.length - 1} more` : ""}`;
    }
    case "failed":
      return trace?.lastRun?.reason ?? subtasks;
    case "done": {
      const summary = measuredSummary(subtreeMeasured(tasks, task.id, traces, index));
      return summary !== "" ? summary : subtasks;
    }
    default:
      return subtasks;
  }
}

export function TaskRow({
  task,
  tasks,
  index,
  planning = EMPTY_PLANNING,
  activity,
  state,
  depth,
  flat = false,
  history = false,
  showProject = false,
  selectedId,
  cardClickGuard,
  armCardClickIgnore,
  problem,
  menuTaskId,
  onOpenMenu,
  onOpen,
  createFailures,
}: {
  task: Task;
  tasks: Task[];
  index?: TaskIndex;
  /** Task ids whose plan agent currently has a live run. */
  planning?: ReadonlySet<string>;
  activity: TaskActivity | undefined;
  state: (task: Task) => TaskState;
  depth: number;
  flat?: boolean;
  /** A row in the done-by-day list: no status badge, the day already says it. */
  history?: boolean;
  /** Name the project on the row, for lists not already grouped by project. */
  showProject?: boolean;
  selectedId: string | null;
  cardClickGuard: { current: CardClickGuard };
  armCardClickIgnore: (token: CardPointerToken) => void;
  problem: { id: string; message: string } | null;
  menuTaskId: string | null;
  onOpenMenu: (id: string, x: number, y: number) => void;
  onOpen: (id: string) => void;
  createFailures?: Record<string, TaskCreateFailure>;
}) {
  const children = flat
    ? []
    : index === undefined
      ? tasks.filter((item) => item.parentId === task.id).sort((a, b) => compareTasks(tasks, a, b))
      : (index.children.get(task.id) ?? []);
  const createFailure = createFailures?.[task.id] ?? null;
  const failedCreate = createFailure !== null;
  const current = failedCreate ? "failed" : state(task);
  const done = task.status === "done";
  const backlog = task.status === "backlog";
  const notice = problem?.id === task.id && menuTaskId !== task.id ? problem.message : null;
  const press = useRef<number | null>(null);
  const origin = useRef({ x: 0, y: 0 });
  const selected = selectedId === task.id;
  const trace = activity?.traces[task.id];
  const badge = history || (done && depth > 0) ? null : stateBadge(current, trace);
  const planningLive = planning.has(task.id) && isActiveStatus(task.status);
  const stale = current === "working" && isStaleWorking(task, activity);
  const note = rowNote(task, tasks, current, trace, activity?.traces ?? {}, index);
  const project = showProject && depth === 0 ? task.project : undefined;
  const describedBy = [
    `task-id-${task.id}`,
    notice !== null || createFailure !== null ? `task-error-${task.id}` : null,
  ].filter((id) => id !== null);

  const clearPress = () => {
    if (press.current === null) return;
    window.clearTimeout(press.current);
    press.current = null;
  };
  const openMenu = (x: number, y: number) => {
    onOpenMenu(task.id, x, y);
  };

  useEffect(() => {
    return () => {
      if (press.current !== null) window.clearTimeout(press.current);
    };
  }, []);

  return (
    <li
      className="min-w-0"
      data-testid={`task-${task.id}`}
      data-state={current}
      data-pending-task={task.id.startsWith("pending-") ? "true" : undefined}
      data-create-failed={createFailure !== null ? "true" : undefined}
    >
      {/* biome-ignore lint/a11y/useSemanticElements: the card is a row of block content. */}
      <div
        data-task-card=""
        role="button"
        tabIndex={0}
        aria-current={selected ? "true" : undefined}
        aria-label={`Open ${plainInline(task.title)}`}
        aria-describedby={describedBy.length > 0 ? describedBy.join(" ") : undefined}
        className={cn(
          "flex min-h-11 w-full cursor-pointer select-none flex-col justify-center gap-1 overflow-hidden rounded-md bg-surface px-3 py-2 text-left hover:bg-muted",
          failedCreate && "cursor-default hover:bg-surface",
          backlog && "bg-surface/60 text-muted-foreground saturate-0",
          selected && "bg-muted hover:bg-muted",
        )}
        style={{
          WebkitTouchCallout: "none",
          marginLeft: depth * 24,
          width: `calc(100% - ${depth * 24}px)`,
        }}
        onPointerDown={(event) => {
          if (failedCreate) return;
          const token = cardPointerToken(event.nativeEvent);
          cardClickGuard.current.pointer = token;
          origin.current = { x: event.clientX, y: event.clientY };
          clearPress();
          if (event.pointerType === "mouse") return;
          press.current = window.setTimeout(() => {
            press.current = null;
            armCardClickIgnore(token);
            openMenu(origin.current.x, origin.current.y);
          }, LONG_PRESS_MS);
        }}
        onPointerMove={(event) => {
          if (press.current === null) return;
          const distance = Math.hypot(
            event.clientX - origin.current.x,
            event.clientY - origin.current.y,
          );
          if (distance <= 10) return;
          clearPress();
        }}
        onPointerUp={(event) => {
          const guard = cardClickGuard.current;
          const suppress = guard.ignore !== null && guard.ignore === guard.pointer;
          clearPress();
          // Only the gesture that opened or dismissed a menu suppresses its
          // pointerup; a plain tap must keep the browser's following click.
          if (suppress) event.preventDefault();
        }}
        onPointerCancel={clearPress}
        onContextMenu={(event) => {
          event.preventDefault();
          if (failedCreate) return;
          clearPress();
          const token = cardPointerToken(event.nativeEvent);
          cardClickGuard.current.pointer = token;
          armCardClickIgnore(token);
          openMenu(event.clientX, event.clientY);
        }}
        onClick={() => {
          if (failedCreate) return;
          const guard = cardClickGuard.current;
          const ignored = guard.ignore !== null && guard.ignore === guard.pointer;
          if (guard.ignore !== null) guard.ignore = null;
          if (ignored) return;
          onOpen(task.id);
        }}
        onKeyDown={(event) => {
          if (failedCreate || event.target !== event.currentTarget) return;
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
        <span
          className={cn(
            "line-clamp-2 min-w-0 text-sm leading-5 [overflow-wrap:anywhere]",
            done || backlog ? "text-muted-foreground" : "text-foreground",
          )}
        >
          <InlineMarkdown text={task.title} />
        </span>
        {note !== "" && (
          <span className="whitespace-normal text-xs leading-4 text-muted-foreground [overflow-wrap:anywhere]">
            {note}
          </span>
        )}
        <TaskCardMeta task={task} project={project} planning={planningLive}>
          {badge !== null && (
            <Badge
              data-testid={`task-badge-${task.id}`}
              variant={
                current === "working" || current === "failed" || current === "backlog"
                  ? "default"
                  : "outline"
              }
            >
              {badge}
            </Badge>
          )}
          {planningLive && (
            <TaskPlanningBadge testId={`task-planning-${task.id}`} className="h-4" />
          )}
          {stale && <StaleMarker id={task.id} />}
          <ReopenBadge task={task} />
        </TaskCardMeta>
      </div>
      {notice !== null && (
        <ErrorText id={`task-error-${task.id}`} className="mt-1">
          {notice}
        </ErrorText>
      )}
      {createFailure !== null && (
        <div className="mt-1 flex items-start justify-between gap-2 rounded-md bg-surface px-3 py-2">
          <ErrorText id={`task-error-${task.id}`} className="min-w-0 flex-1 px-0">
            {createFailure.error}
          </ErrorText>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 shrink-0 gap-1.5 rounded-md px-2"
            data-testid={`task-create-retry-${task.id}`}
            aria-label={`Retry ${plainInline(task.title)}`}
            disabled={createFailure.retrying}
            onClick={(event) => {
              event.stopPropagation();
              createFailure.onRetry();
            }}
          >
            <RefreshIcon size={14} />
            Retry
          </Button>
        </div>
      )}
      {children.length > 0 && (
        <ul className="mt-2 flex flex-col gap-2">
          {children.map((child) => (
            <TaskRow
              key={child.id}
              task={child}
              tasks={tasks}
              index={index}
              planning={planning}
              activity={activity}
              state={state}
              depth={depth + 1}
              history={history}
              selectedId={selectedId}
              cardClickGuard={cardClickGuard}
              armCardClickIgnore={armCardClickIgnore}
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
          "flex min-h-11 w-full cursor-pointer select-none flex-col gap-2 overflow-hidden rounded-md bg-surface px-3 py-2 text-left hover:bg-muted",
          selected && "bg-muted hover:bg-muted",
        )}
        onClick={onOpen}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          onOpen();
        }}
      >
        <span className="line-clamp-2 min-w-0 text-sm leading-5 [overflow-wrap:anywhere]">
          <InlineMarkdown text={task.title} />
        </span>
        <TaskCardMeta task={task} project={showProject ? task.project : undefined}>
          <Badge variant="outline">Proposed</Badge>
        </TaskCardMeta>
        <span
          data-testid="proposal-decision"
          className="flex min-h-9 items-center justify-end gap-2 border-t border-border pt-2"
        >
          <Button
            variant="ghost"
            size="sm"
            className="h-7 shrink-0 gap-1.5 rounded-md px-2"
            aria-label={`Dismiss ${plainInline(task.title)}`}
            onClick={(event) => {
              stop(event);
              onDismiss();
            }}
          >
            <CloseIcon size={14} />
            Dismiss
          </Button>
          <Button
            size="sm"
            className="h-7 shrink-0 gap-1.5 rounded-md px-3"
            aria-label={`Approve ${plainInline(task.title)}`}
            onClick={(event) => {
              stop(event);
              onApprove();
            }}
          >
            <CheckIcon size={14} />
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

/** One clipped line of card metadata: markers, project, times and the task id. */
function TaskCardMeta({
  task,
  project,
  planning = false,
  children,
}: {
  task: Task;
  project?: string;
  /** Keep the extra chip on the existing meta line even at phone width. */
  planning?: boolean;
  children?: ReactNode;
}) {
  return (
    <span
      data-testid="task-card-meta"
      className={cn(
        "flex min-w-0 max-w-full flex-nowrap items-center gap-x-2 overflow-hidden whitespace-nowrap text-xs leading-4 text-muted-foreground",
        !planning && "max-[480px]:flex-wrap max-[480px]:whitespace-normal",
      )}
    >
      {children}
      {project !== undefined && project !== "" && (
        <span
          data-testid={`task-project-label-${task.id}`}
          title={project}
          className="min-w-0 max-w-[40%] truncate"
        >
          {project}
        </span>
      )}
      <TaskCardTimes task={task} />
      <TaskIdChip id={task.id} />
    </span>
  );
}

/** The compact created/closed clock on a task card; the detail keeps the long form. */
export function TaskCardTimes({ task }: { task: Task }) {
  const created = formatTime(task.createdAt);
  const createdFull = formatDateTime(task.createdAt);
  const closedAt =
    task.status === "done" && typeof task.completedAt === "string" ? task.completedAt : null;
  const closed = closedAt === null ? "" : formatTime(closedAt);
  const closedFull = closedAt === null ? "" : formatDateTime(closedAt);
  const title =
    closedAt === null ? `Created ${createdFull}` : `Created ${createdFull} · Closed ${closedFull}`;
  return (
    <span
      data-testid="task-card-times"
      title={title}
      className="inline-flex min-w-0 shrink items-center gap-x-2 whitespace-nowrap text-xs leading-4 text-muted-foreground"
    >
      <time dateTime={task.createdAt} title={createdFull} className="min-w-0 truncate">
        Created {created}
      </time>
      {closedAt !== null && (
        <time dateTime={closedAt} title={closedFull} className="min-w-0 truncate">
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

export function TaskDetail({
  task,
  tasks,
  state,
  trace,
  wide,
  planning = false,
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
  /** This task's plan agent currently has a live run. */
  planning?: boolean;
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
  const media = useTaskMedia(task, onLedger);
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
  {
    const model: TaskDetailModel = {
      task,
      tasks,
      media,
      state,
      trace,
      wide,
      planning,
      statusPending,
      notice,
      editingTitle,
      titleDraft,
      titleError,
      titleRef,
      setTitleDraft,
      setTitleError,
      setEditingTitle,
      saveTitle,
      editingBody,
      bodyDraft,
      bodyError,
      bodyRef,
      bodyEditorRef,
      bodyIgnoreBlur,
      setBodyDraft,
      setBodyError,
      setEditingBody,
      beginBodyEdit,
      saveBody,
      projectDraft,
      projectError,
      projectOpen,
      projectMatches,
      activeProject,
      projectAnchor,
      setProjectDraft,
      setProjectError,
      setProjectOpen,
      setProjectActive,
      saveProject,
      acceptProject,
      done,
      proposed,
      parked,
      backlogLabel,
      openChildren,
      parent,
      children,
      blockers,
      reason,
      badge,
      title,
      projects,
      onClose,
      onOpen,
      onStatus,
      onApprove,
      onDismiss,
      onRemove,
      onLedger,
    };
    return <TaskDetailVariant model={model} />;
  }
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
        {done ? "Reopen…" : "Mark done"}
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

/** A small prompt for the reason a done task is coming back. */
function ReopenPrompt({
  task,
  onCancel,
  onSubmit,
}: {
  task: Task;
  onCancel: () => void;
  onSubmit: (reason: string) => Promise<string | null>;
}) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  const trimmed = reason.trim();
  const valid = trimmed.length > 0 && trimmed.length <= TASK_REOPEN_REASON_MAX_LENGTH;

  useEffect(() => {
    reasonRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const submit = async () => {
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    const message = await onSubmit(trimmed);
    if (message !== null) {
      setError(message);
      setBusy(false);
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/60 p-4 backdrop-blur-sm"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <Card
        role="dialog"
        aria-modal="true"
        aria-labelledby={`reopen-title-${task.id}`}
        data-testid="task-reopen-prompt"
        className="w-full max-w-md bg-surface shadow-md"
      >
        <CardHeader className="flex flex-col gap-1">
          <h2 id={`reopen-title-${task.id}`} className="text-base font-semibold leading-6">
            Reopen {plainInline(task.title)}
          </h2>
          <p className="text-sm leading-5 text-muted-foreground">
            Say what is still wrong. The old completion stays in the history.
          </p>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          <label htmlFor={`reopen-reason-${task.id}`} className="text-sm font-medium leading-5">
            Reason
          </label>
          <textarea
            ref={reasonRef}
            id={`reopen-reason-${task.id}`}
            aria-label="Reopen reason"
            data-testid="task-reopen-reason"
            rows={3}
            maxLength={TASK_REOPEN_REASON_MAX_LENGTH}
            value={reason}
            placeholder="What regressed or is still wrong?"
            onChange={(event) => {
              setReason(event.target.value);
              setError(null);
            }}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                event.preventDefault();
                void submit();
              }
            }}
            className="min-h-20 w-full resize-y rounded-md border border-border bg-background px-2 py-1.5 text-sm leading-5 text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-foreground"
          />
          <span className="self-end text-xs leading-4 text-muted-foreground tabular-nums">
            {trimmed.length}/{TASK_REOPEN_REASON_MAX_LENGTH}
          </span>
          {error !== null && <ErrorText>{error}</ErrorText>}
        </CardContent>
        <CardFooter className="flex items-center justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="rounded-md"
            onClick={onCancel}
          >
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            data-testid="task-reopen-submit"
            className="rounded-md"
            disabled={!valid || busy}
            onClick={() => void submit()}
          >
            Reopen task
          </Button>
        </CardFooter>
      </Card>
    </div>,
    document.body,
  );
}
