import { type ReactNode, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
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
import { formatDateTime, formatTime } from "../shared/time";
import type {
  Task,
  TaskActivity,
  TaskHistoryEvent,
  TaskHistoryKind,
  TaskLedger,
  TaskMeasured,
  TaskState,
  TaskTrace,
} from "../shared/types";
import { InlineMarkdown, plainInline } from "./markdown";
import { mediaUrl } from "./media-client";
import { removeTask, type TaskOutcome, updateTask } from "./task-client";

const LONG_PRESS_MS = 500;
const WIDE_QUERY = "(min-width: 1024px)";
const HISTORY_LIMIT = 12;

type Filter = "active" | "blocked" | "proposed" | "done";

interface TasksViewProps {
  tasks: Task[];
  activity?: TaskActivity;
  ready: boolean;
  footerClearance: number;
  armedParentId: string | null;
  onArmParent: (id: string | null) => void;
  onLedger: (ledger: TaskLedger) => void;
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

function sameLocalDay(iso: string | null | undefined, now: Date): boolean {
  if (typeof iso !== "string") return false;
  const at = new Date(iso);
  return (
    at.getFullYear() === now.getFullYear() &&
    at.getMonth() === now.getMonth() &&
    at.getDate() === now.getDate()
  );
}

function byCompletedDesc(a: Task, b: Task): number {
  const left = a.completedAt ?? a.createdAt;
  const right = b.completedAt ?? b.createdAt;
  return left === right ? 0 : left < right ? 1 : -1;
}

export function TasksView({
  tasks,
  activity,
  ready,
  footerClearance,
  armedParentId,
  onArmParent,
  onLedger,
}: TasksViewProps) {
  const wide = useWide();
  const [filter, setFilter] = useState<Filter>("active");
  const [pickerId, setPickerId] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [problem, setProblem] = useState<{ id: string; message: string } | null>(null);
  const [openTaskId, setOpenTaskId] = useState<string | null>(null);
  const ignoreNextCardClick = useRef(false);
  const now = new Date();

  const stateOf = new Map<string, TaskState>();
  for (const task of tasks) stateOf.set(task.id, taskState(tasks, task, activity));
  const state = (task: Task): TaskState => stateOf.get(task.id) ?? "ready";

  const activeTasks = tasks.filter((task) => task.status !== "proposed");
  const openTasks = activeTasks.filter((task) => task.status !== "done");
  const doneTasks = activeTasks.filter((task) => task.status === "done").sort(byCompletedDesc);
  const proposedTasks = tasks
    .filter((task) => task.status === "proposed")
    .sort((a, b) => {
      const left = a.proposedAt ?? a.createdAt;
      const right = b.proposedAt ?? b.createdAt;
      return left === right ? (a.id < b.id ? -1 : 1) : left < right ? -1 : 1;
    });
  const failedTasks = openTasks.filter((task) => state(task) === "failed");
  const blockedTasks = openTasks.filter((task) => state(task) === "blocked");
  const ids = new Set(activeTasks.map((task) => task.id));
  const roots = activeTasks
    .filter((task) => task.parentId === null || !ids.has(task.parentId))
    .sort((a, b) => compareTasks(activeTasks, a, b));
  const hasChildren = (task: Task) => activeTasks.some((item) => item.parentId === task.id);
  // A failed leaf already sits under "Needs you"; a failed parent stays in the tree with its subtasks.
  const activeRoots = roots.filter(
    (task) => task.status !== "done" && !(state(task) === "failed" && !hasChildren(task)),
  );
  const doneToday = roots.filter(
    (task) => task.status === "done" && sameLocalDay(task.completedAt, now),
  );

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
  };

  const proposal = (task: Task) => (
    <ProposedTask
      key={task.id}
      task={task}
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
    done: doneTasks.length,
  };

  const list = (
    <div className="flex min-w-0 flex-col gap-2" data-testid="task-list">
      <NowCard
        tasks={activeTasks}
        activity={activity}
        state={state}
        counts={{
          ready: openTasks.filter((task) => state(task) === "ready" || state(task) === "partial")
            .length,
          blocked: blockedTasks.length,
          doneToday: doneTasks.filter((task) => sameLocalDay(task.completedAt, now)).length,
        }}
        onOpen={setOpenTaskId}
      />
      {tasks.length > 0 && (
        <div
          role="tablist"
          aria-label="Task filter"
          data-testid="task-filters"
          className="flex flex-wrap gap-1.5"
        >
          {(["active", "blocked", "proposed", "done"] as const).map((item) => (
            <button
              key={item}
              type="button"
              role="tab"
              aria-selected={filter === item}
              data-testid={`task-filter-${item}`}
              onClick={() => setFilter(item)}
              className={
                filter === item
                  ? "theme-radius bg-foreground px-2.5 py-1 font-mono text-[11px] text-background"
                  : "theme-radius border border-foreground/25 bg-surface px-2.5 py-1 font-mono text-[11px] text-foreground/70"
              }
            >
              {item} {counts[item]}
            </button>
          ))}
        </div>
      )}
      {filter === "active" && (
        <>
          {(proposedTasks.length > 0 || failedTasks.length > 0) && (
            <Section title="Needs you" count={proposedTasks.length + failedTasks.length} id="needs">
              <ul id="proposed-tasks" className="flex flex-col gap-1" data-testid="task-proposals">
                {proposedTasks.map(proposal)}
                {failedTasks.map((task) => (
                  <TaskRow key={task.id} task={task} depth={0} {...rowProps} flat />
                ))}
              </ul>
            </Section>
          )}
          {activeRoots.length > 0 && (
            <Section title="Active" count={openTasks.length - failedTasks.length} id="active">
              <ul className="flex flex-col gap-1">
                {activeRoots.map((task) => (
                  <TaskRow key={task.id} task={task} depth={0} {...rowProps} />
                ))}
              </ul>
            </Section>
          )}
          {doneToday.length > 0 && (
            <Section title="Done today" count={doneToday.length} id="done-today">
              <ul className="flex flex-col gap-1">
                {doneToday.map((task) => (
                  <TaskRow key={task.id} task={task} depth={0} {...rowProps} />
                ))}
              </ul>
            </Section>
          )}
        </>
      )}
      {filter === "blocked" && (
        <Section title="Blocked" count={blockedTasks.length} id="blocked">
          <ul className="flex flex-col gap-1">
            {blockedTasks.map((task) => (
              <TaskRow key={task.id} task={task} depth={0} {...rowProps} flat />
            ))}
          </ul>
        </Section>
      )}
      {filter === "proposed" && (
        <Section title="Proposed" count={proposedTasks.length} id="proposed">
          <ul id="proposed-tasks" className="flex flex-col gap-1" data-testid="task-proposals">
            {proposedTasks.map(proposal)}
          </ul>
        </Section>
      )}
      {filter === "done" && (
        <Section title="Done" count={doneTasks.length} id="done">
          <ul className="flex flex-col gap-1">
            {doneTasks.map((task) => (
              <TaskRow key={task.id} task={task} depth={0} {...rowProps} flat />
            ))}
          </ul>
        </Section>
      )}
      {!ready && (
        <p className="theme-radius bg-surface px-3 py-2 font-mono text-xs text-foreground/70">
          Loading…
        </p>
      )}
      {ready && tasks.length === 0 && (
        <p className="py-8 text-center">
          <span className="bg-foreground px-2 py-1 font-mono text-[11px] text-background">
            No tasks yet.
          </span>
        </p>
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
            ? "mx-auto grid w-full max-w-[1200px] grid-cols-[minmax(360px,440px)_1fr] items-start gap-3 px-4"
            : "mx-auto flex w-full max-w-[72ch] flex-col gap-4 px-4"
        }
        style={{ paddingTop: 16, paddingBottom: footerClearance + 16 }}
      >
        {wide ? (
          <>
            {list}
            <div className="sticky top-4 min-w-0">
              {detail ?? (
                <p
                  data-testid="task-detail-empty"
                  className="theme-radius bg-surface px-4 py-6 text-center font-mono text-[11px] text-foreground/65"
                >
                  Select a task to see its runs and history.
                </p>
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

function Section({
  title,
  count,
  id,
  children,
}: {
  title: string;
  count: number;
  id: string;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-1" data-testid={`task-section-${id}`}>
      <h2 className="theme-radius mt-1 flex items-center justify-between bg-surface px-3 py-1.5 font-mono text-[11px] uppercase tracking-wide text-foreground/65">
        <span>{title}</span>
        <span>{count}</span>
      </h2>
      {children}
    </section>
  );
}

const GLYPH_BASE =
  "grid h-4 w-4 shrink-0 place-items-center theme-radius font-mono text-[10px] leading-none";

/** A monochrome-safe status mark: shape and fill carry the state, never color alone. */
export function StatusGlyph({ state }: { state: TaskState | "idle" }) {
  switch (state) {
    case "working":
      return (
        <span
          aria-hidden
          className={`${GLYPH_BASE} border border-foreground bg-foreground text-background`}
        >
          ●
        </span>
      );
    case "done":
      return (
        <span
          aria-hidden
          className={`${GLYPH_BASE} border border-foreground/40 text-foreground/70`}
        >
          ✓
        </span>
      );
    case "blocked":
      return (
        <span
          aria-hidden
          className={`${GLYPH_BASE} border border-dashed border-foreground/40 text-foreground/70`}
        >
          ⊘
        </span>
      );
    case "failed":
      return (
        <span
          aria-hidden
          className={`${GLYPH_BASE} border-2 border-foreground font-bold text-foreground`}
        >
          ✕
        </span>
      );
    case "proposed":
      return (
        <span
          aria-hidden
          className={`${GLYPH_BASE} border border-dotted border-foreground/60 text-foreground/70`}
        >
          ?
        </span>
      );
    case "partial":
      return (
        <span
          aria-hidden
          className={`${GLYPH_BASE} border border-foreground/40 bg-[linear-gradient(90deg,var(--color-foreground)_50%,transparent_50%)] bg-clip-content p-0.5`}
        />
      );
    default:
      return <span aria-hidden className={`${GLYPH_BASE} border border-foreground/40`} />;
  }
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

function measuredSummary(trace: TaskTrace | undefined): string {
  if (trace === undefined || trace.measured.runs === 0) return "";
  const parts = [formatActiveTime(trace.measured.activeMs)];
  if (trace.measured.tokens > 0) parts.push(formatTokenCount(trace.measured.tokens));
  return parts.join(" · ");
}

function failureLabel(trace: TaskTrace | undefined): string {
  return trace?.lastRun?.outcome === "interrupted" ? "interrupted" : "failed";
}

function RowMeta({
  task,
  tasks,
  state,
  trace,
}: {
  task: Task;
  tasks: Task[];
  state: TaskState;
  trace: TaskTrace | undefined;
}) {
  const base = "shrink-0 font-mono text-[11px] text-foreground/70";
  switch (state) {
    case "working":
      return <span className={`${base} font-bold uppercase text-foreground`}>working</span>;
    case "failed":
      return (
        <span className={`${base} font-bold uppercase text-foreground`}>
          <span className="text-destructive">✕</span> {failureLabel(trace)}
        </span>
      );
    case "blocked": {
      const names = liveBlockerIds(tasks, task).map((id) => {
        const blocker = tasks.find((item) => item.id === id);
        return blocker === undefined ? id : plainInline(blocker.title);
      });
      const more = names.length > 1 ? ` +${names.length - 1}` : "";
      return (
        <span className={`${base} min-w-0 max-w-[45%] truncate`} title={names.join(", ")}>
          blocked ← {names[0]}
          {more}
        </span>
      );
    }
    case "partial": {
      const count = subtaskCount(tasks, task.id);
      return (
        <span className={base} title={`${count.done} of ${count.total} subtasks done`}>
          {count.done}/{count.total}
        </span>
      );
    }
    case "done": {
      const summary = measuredSummary(trace);
      const children = subtaskCount(tasks, task.id);
      const text =
        summary !== "" ? summary : children.total > 0 ? `${children.done}/${children.total}` : "—";
      return <span className={base}>{text}</span>;
    }
    default: {
      const children = subtaskCount(tasks, task.id);
      if (children.total > 0) {
        return (
          <span className={base} title={`${children.done} of ${children.total} subtasks done`}>
            {children.done}/{children.total}
          </span>
        );
      }
      return <span className={base}>{measuredSummary(trace)}</span>;
    }
  }
}

function TaskRow({
  task,
  tasks,
  activity,
  state,
  depth,
  flat = false,
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

  const titleClass =
    current === "working"
      ? "font-semibold text-foreground"
      : current === "failed"
        ? "font-semibold text-foreground"
        : current === "done"
          ? "text-foreground/60 line-through"
          : current === "blocked"
            ? "text-foreground/60"
            : "text-foreground";

  return (
    <li className="min-w-0" data-testid={`task-${task.id}`} data-state={current}>
      {/* biome-ignore lint/a11y/useSemanticElements: the row contains its own status button. */}
      <div
        data-task-card=""
        role="button"
        tabIndex={0}
        aria-current={selected ? "true" : undefined}
        aria-label={`Open ${plainInline(task.title)}`}
        aria-describedby={notice !== null ? `task-error-${task.id}` : undefined}
        className={`flex min-h-[42px] w-full cursor-pointer select-none items-center gap-2.5 theme-radius bg-surface px-3 py-2 text-left${
          selected || armed ? " ring-1 ring-inset ring-foreground/40" : ""
        }`}
        style={{
          WebkitTouchCallout: "none",
          marginLeft: depth * 18,
          width: `calc(100% - ${depth * 18}px)`,
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
        <button
          type="button"
          data-task-check=""
          aria-pressed={done}
          aria-disabled={openChildren}
          aria-label={
            done ? `Reopen ${plainInline(task.title)}` : `Done ${plainInline(task.title)}`
          }
          title={openChildren ? "Finish open subtasks first" : done ? "Reopen" : "Mark done"}
          className="-m-1 shrink-0 p-1 aria-disabled:opacity-60"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            if (openChildren) return;
            onStatus(task, done ? "open" : "done");
          }}
        >
          <StatusGlyph state={current} />
        </button>
        <span className={`min-w-0 flex-1 truncate text-sm ${titleClass}`}>
          <InlineMarkdown text={task.title} />
        </span>
        <RowMeta task={task} tasks={tasks} state={current} trace={activity?.traces[task.id]} />
      </div>
      {notice !== null && (
        <p
          id={`task-error-${task.id}`}
          role="alert"
          data-testid="task-error"
          className="theme-radius mt-1 bg-surface px-3 py-1 font-mono text-[11px] leading-4 text-destructive"
        >
          {notice}
        </p>
      )}
      {children.length > 0 && (
        <ul className="mt-1 flex flex-col gap-1">
          {children.map((child) => (
            <TaskRow
              key={child.id}
              task={child}
              tasks={tasks}
              activity={activity}
              state={state}
              depth={depth + 1}
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
  selected,
  notice,
  onOpen,
  onApprove,
  onDismiss,
}: {
  task: Task;
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
        className={`flex min-h-[42px] w-full cursor-pointer select-none items-center gap-2.5 theme-radius border border-dashed border-foreground/30 bg-surface px-3 py-1.5 text-left${
          selected ? " ring-1 ring-inset ring-foreground/40" : ""
        }`}
        onClick={onOpen}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          onOpen();
        }}
      >
        <StatusGlyph state="proposed" />
        <span className="min-w-0 flex-1 truncate text-sm text-foreground/80">
          <InlineMarkdown text={task.title} />
        </span>
        <span className="flex shrink-0 gap-1.5">
          <button
            type="button"
            aria-label={`Approve ${plainInline(task.title)}`}
            className="theme-radius bg-foreground px-2 py-1 font-mono text-[10px] text-background"
            onClick={(event) => {
              stop(event);
              onApprove();
            }}
          >
            approve
          </button>
          <button
            type="button"
            aria-label={`Dismiss ${plainInline(task.title)}`}
            className="theme-radius border border-foreground/25 bg-surface px-2 py-1 font-mono text-[10px] text-foreground/70"
            onClick={(event) => {
              stop(event);
              onDismiss();
            }}
          >
            ✕
          </button>
        </span>
      </div>
      {notice !== null && (
        <p
          role="alert"
          data-testid="task-error"
          className="theme-radius mt-1 bg-surface px-3 py-1 font-mono text-[11px] leading-4 text-destructive"
        >
          {notice}
        </p>
      )}
    </li>
  );
}

function NowCard({
  tasks,
  activity,
  state,
  counts,
  onOpen,
}: {
  tasks: Task[];
  activity: TaskActivity | undefined;
  state: (task: Task) => TaskState;
  counts: { ready: number; blocked: number; doneToday: number };
  onOpen: (id: string) => void;
}) {
  const running = activity?.running === true;
  const working = tasks.filter((task) => state(task) === "working");
  const parentTitle = (task: Task) => {
    const parent =
      task.parentId === null ? undefined : tasks.find((item) => item.id === task.parentId);
    return parent === undefined ? null : plainInline(parent.title);
  };
  const idleSummary = [
    counts.ready > 0 ? `${counts.ready} ready` : "",
    counts.blocked > 0 ? `${counts.blocked} blocked` : "",
    counts.doneToday > 0 ? `${counts.doneToday} done today` : "",
  ]
    .filter((part) => part !== "")
    .join(" · ");
  const line2 = "mt-0.5 truncate pl-[26px] font-mono text-[11px] text-foreground/70";

  return (
    <section
      data-testid="now-card"
      data-running={running ? "true" : "false"}
      aria-label="Now"
      aria-live="polite"
      className="theme-radius flex flex-col gap-2 border border-foreground/30 bg-surface px-3 py-2.5"
    >
      {!running && (
        <div>
          <div className="flex items-center gap-2.5 text-sm">
            <StatusGlyph state="idle" />
            <span className="font-bold">Idle</span>
            <span className="text-foreground/70">· no run in progress</span>
          </div>
          <div className={line2}>{idleSummary === "" ? "no open tasks" : idleSummary}</div>
        </div>
      )}
      {running && working.length === 0 && (
        <div>
          <div className="flex items-center gap-2.5 text-sm">
            <StatusGlyph state="working" />
            <span className="font-bold">Working</span>
          </div>
          <div className={line2}>no tool calls yet</div>
        </div>
      )}
      {working.map((task) => {
        const parent = parentTitle(task);
        return (
          <button
            key={task.id}
            type="button"
            data-testid={`now-task-${task.id}`}
            aria-label={`Working on ${plainInline(task.title)}`}
            onClick={() => onOpen(task.id)}
            className="block min-w-0 text-left"
          >
            <span className="flex items-center gap-2.5 text-sm">
              <StatusGlyph state="working" />
              <span className="shrink-0 font-bold">Working</span>
              <span className="min-w-0 truncate">
                <InlineMarkdown text={task.title} />
              </span>
            </span>
            <span className={`block ${line2}`}>
              {task.id}
              {parent === null ? "" : ` · in ${parent}`}
            </span>
          </button>
        );
      })}
    </section>
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
      className="flex flex-wrap items-center gap-x-2 font-mono text-[11px] text-foreground/65"
    >
      <time dateTime={task.createdAt} title={created}>
        created {created}
      </time>
      {closed !== "" && (
        <time dateTime={task.completedAt ?? undefined} title={closed}>
          closed {closed}
        </time>
      )}
    </span>
  );
}

const HISTORY_GLYPH: Record<TaskHistoryKind, string> = {
  created: "+",
  approved: "↑",
  blocked: "⊘",
  unblocked: "○",
  done: "✓",
  reopened: "↺",
  "run-start": "▶",
  "run-end": "■",
  failed: "✕",
};

function stateLabel(state: TaskState, trace: TaskTrace | undefined): string {
  if (state === "failed") return failureLabel(trace);
  return state;
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
      ? { id, title: id, status: "missing" }
      : { id, title: plainInline(blocker.title), status: blocker.status };
  });
  // A parent's own runs are often none; its subtasks' runs are the work done for it.
  const measured = subtree ?? trace?.measured;
  const ran = measured !== undefined && measured.runs > 0;
  const rolledUp = ran && measured.runs > (trace?.measured.runs ?? 0);
  const stats: Array<[string, string]> = [
    ["active", ran ? formatActiveTime(measured.activeMs) : "—"],
    ["tokens", ran ? formatTokenCount(measured.tokens) : "—"],
    ["cost", ran ? formatCost(measured.cost) : "—"],
    [rolledUp ? "runs · subtasks" : "runs", ran ? String(measured.runs) : "—"],
  ];
  const history: TaskHistoryEvent[] = (trace?.history ?? []).slice(-HISTORY_LIMIT);
  const hidden = (trace?.history.length ?? 0) - history.length;
  const reason =
    state === "failed" && trace?.lastRun?.reason !== undefined ? trace.lastRun.reason : null;
  const card = "theme-radius bg-surface px-4 py-3";
  const label = "mb-1.5 font-mono text-[11px] uppercase tracking-wide text-foreground/65";
  const button =
    "theme-radius border border-foreground/25 bg-surface px-2.5 py-1.5 font-mono text-[11px] text-foreground";
  const primary =
    "theme-radius bg-foreground px-3 py-1.5 font-mono text-[11px] font-bold text-background";

  return (
    <article
      data-testid="task-detail"
      aria-label={plainInline(task.title)}
      className="flex flex-col gap-2"
    >
      <header className={card}>
        <div className="flex items-center gap-2 font-mono text-[11px] text-foreground/65">
          {!wide && (
            <button
              type="button"
              data-testid="task-detail-back"
              aria-label="Back to tasks"
              onClick={onClose}
              className="theme-radius -ml-1 px-1 text-foreground"
            >
              ‹ tasks
            </button>
          )}
          <span className="min-w-0 flex-1 truncate">
            {parent !== undefined && (
              <>
                <button
                  type="button"
                  className="underline decoration-foreground/30 underline-offset-2"
                  onClick={() => onOpen(parent.id)}
                >
                  {plainInline(parent.title)}
                </button>
                {" · "}
              </>
            )}
            {task.id}
          </span>
          {wide && (
            <button
              type="button"
              data-testid="task-detail-close"
              aria-label="Close"
              onClick={onClose}
              className="theme-radius px-1.5 text-sm text-foreground/70 hover:text-foreground"
            >
              ✕
            </button>
          )}
        </div>
        <h2 className="mt-1.5 text-lg font-bold leading-snug [overflow-wrap:anywhere]">
          <InlineMarkdown text={task.title} />
        </h2>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <span
            data-testid="task-state"
            className="theme-radius inline-flex items-center gap-1.5 bg-foreground px-2 py-0.5 font-mono text-[11px] font-bold uppercase text-background"
          >
            {stateLabel(state, trace)}
          </span>
          <TaskTimes task={task} />
        </div>
        {reason !== null && (
          <p data-testid="task-failure" className="mt-2 font-mono text-[11px] text-foreground/80">
            <span className="text-destructive">✕</span> {reason}
          </p>
        )}
        {task.rationale !== undefined && task.rationale.length > 0 && (
          <p className="mt-2 whitespace-pre-wrap text-sm text-foreground/80 [overflow-wrap:anywhere]">
            {task.rationale}
          </p>
        )}
      </header>
      {!proposed && (
        <dl
          data-testid="task-stats"
          data-rollup={rolledUp ? "subtasks" : undefined}
          title={rolledUp ? "Includes runs of its subtasks" : undefined}
          className="grid grid-cols-4 gap-0.5"
        >
          {stats.map(([name, value]) => (
            <div key={name} className="theme-radius bg-surface px-3 py-2">
              <dt className="font-mono text-[10px] uppercase tracking-wide text-foreground/65">
                {name}
              </dt>
              <dd className="mt-0.5 font-mono text-sm font-bold">{value}</dd>
            </div>
          ))}
        </dl>
      )}
      {done && (
        <section className={card} data-testid="task-modal-completion">
          <h3 className={label}>Evidence</h3>
          {task.completion == null ? (
            <p className="font-mono text-xs text-foreground/65">No evidence recorded</p>
          ) : (
            <p
              data-testid="task-evidence"
              className="whitespace-pre-wrap text-sm [overflow-wrap:anywhere]"
            >
              {task.completion.evidence}
            </p>
          )}
        </section>
      )}
      {(blockers.length > 0 || children.length > 0) && (
        <section className={card}>
          {blockers.length > 0 && (
            <>
              <h3 className={label}>Blocked by</h3>
              <ul className="mb-2 flex flex-col gap-1 font-mono text-xs">
                {blockers.map((blocker) => (
                  <li key={blocker.id} className="flex gap-2 [overflow-wrap:anywhere]">
                    <span className="text-foreground/65">{blocker.status}</span>
                    <span className="min-w-0 flex-1">{blocker.title}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
          {children.length > 0 && (
            <>
              <h3 className={label}>Subtasks</h3>
              <ul className="flex flex-col gap-1 text-sm">
                {children.map((child) => (
                  <li key={child.id}>
                    <button
                      type="button"
                      onClick={() => onOpen(child.id)}
                      className={`text-left ${child.status === "done" ? "text-foreground/60 line-through" : ""}`}
                    >
                      <InlineMarkdown text={child.title} />
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      )}
      {task.attachments !== undefined && task.attachments.length > 0 && (
        <section className={`${card} flex flex-wrap gap-1.5`} data-testid="task-attachments">
          {task.attachments.map((id, index) => (
            <img
              key={id}
              src={mediaUrl(id)}
              alt={`Task attachment ${index + 1}`}
              loading="lazy"
              draggable={false}
              className="block size-16 theme-radius border border-foreground/15 object-cover"
            />
          ))}
        </section>
      )}
      <section className={card} data-testid="task-history">
        <h3 className={label}>History</h3>
        {history.length === 0 ? (
          <p className="font-mono text-xs text-foreground/65">Nothing recorded yet</p>
        ) : (
          <ol className="flex flex-col">
            {hidden > 0 && (
              <li className="pb-1 font-mono text-[11px] text-foreground/60">
                {hidden} earlier {hidden === 1 ? "event" : "events"}
              </li>
            )}
            {history.map((event, index) => (
              <li
                // biome-ignore lint/suspicious/noArrayIndexKey: history is append-only and has no ids.
                key={`${event.at}-${index}`}
                data-kind={event.kind}
                className={`grid grid-cols-[38px_14px_1fr] items-baseline gap-x-2 py-0.5 text-[13px] ${
                  event.kind === "failed" ? "font-semibold" : ""
                }`}
              >
                <time
                  dateTime={event.at}
                  title={formatDateTime(event.at)}
                  className="font-mono text-[11px] text-foreground/65"
                >
                  {formatTime(event.at)}
                </time>
                <span
                  aria-hidden
                  className={`text-center font-mono text-[11px] ${event.kind === "failed" ? "text-destructive" : "text-foreground/70"}`}
                >
                  {HISTORY_GLYPH[event.kind]}
                </span>
                <span className="min-w-0 [overflow-wrap:anywhere]">{event.text}</span>
              </li>
            ))}
          </ol>
        )}
      </section>
      {notice !== null && (
        <p
          role="alert"
          data-testid="task-error"
          className="theme-radius bg-surface px-3 py-1.5 font-mono text-[11px] leading-4 text-destructive"
        >
          {notice}
        </p>
      )}
      <div
        className="theme-radius flex flex-wrap items-center gap-1.5 bg-surface px-3 py-2"
        data-testid="task-detail-actions"
      >
        {proposed ? (
          <>
            <button
              type="button"
              className={button}
              onClick={onDismiss}
              aria-label={`Dismiss ${plainInline(task.title)} proposal`}
            >
              dismiss
            </button>
            <span className="flex-1" />
            <button
              type="button"
              className={primary}
              onClick={onApprove}
              aria-label={`Approve ${plainInline(task.title)} proposal`}
            >
              approve
            </button>
          </>
        ) : (
          <>
            <button type="button" className={button} aria-pressed={armed} onClick={onArm}>
              {armed ? "adding subtask…" : "subtask"}
            </button>
            <button
              type="button"
              className={button}
              aria-label={`Add blocker to ${plainInline(task.title)}`}
              onClick={(event) => {
                const rect = event.currentTarget.getBoundingClientRect();
                onBlock(rect.left, rect.bottom + 4);
              }}
            >
              block…
            </button>
            <button
              type="button"
              className={button}
              onClick={onRemove}
              aria-label={`Remove ${plainInline(task.title)} task`}
            >
              remove
            </button>
            <span className="flex-1" />
            <button
              type="button"
              data-testid="task-detail-status"
              aria-disabled={openChildren}
              title={openChildren ? "Finish open subtasks first" : undefined}
              className={`${done ? button : primary} aria-disabled:opacity-60`}
              onClick={() => {
                if (openChildren) return;
                onStatus(task, done ? "open" : "done");
              }}
            >
              {done ? "reopen" : "mark done"}
            </button>
          </>
        )}
      </div>
    </article>
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
  const left = Math.max(8, Math.min(point.x, window.innerWidth - 184));
  const top = Math.max(8, Math.min(point.y, window.innerHeight - 160));

  return (
    <div
      id="task-menu"
      data-testid="task-menu"
      role="menu"
      className="ink-line theme-radius fixed z-40 w-44 border bg-surface p-1 text-foreground"
      style={{ left, top }}
    >
      {notice !== null && (
        <p
          role="alert"
          data-testid="task-error"
          className="px-2 py-1 font-mono text-[11px] leading-4 text-destructive"
        >
          {notice}
        </p>
      )}
      <button
        type="button"
        role="menuitem"
        aria-label={`Subtask of ${plainInline(task.title)}`}
        className="block w-full theme-radius px-2 py-1.5 text-left font-mono text-[11px] hover:bg-foreground/10"
        onClick={onArm}
      >
        subtask
      </button>
      <button
        type="button"
        role="menuitem"
        aria-expanded={pickerOpen}
        aria-label={`Blockers for ${plainInline(task.title)}`}
        className="block w-full theme-radius px-2 py-1.5 text-left font-mono text-[11px] hover:bg-foreground/10"
        onClick={onTogglePicker}
      >
        blocker
      </button>
      {pickerOpen && (
        <ul className="flex flex-col gap-1 px-2 py-1">
          {candidates.length === 0 && (
            <li className="font-mono text-[10px] text-muted-foreground">No other tasks</li>
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
                  className="text-left font-mono text-[11px] text-foreground disabled:opacity-40"
                  onClick={() => {
                    const blockedBy = selected
                      ? task.blockedBy.filter((id) => id !== other.id)
                      : [...task.blockedBy, other.id];
                    onBlockers(blockedBy);
                  }}
                >
                  {selected ? "●" : "○"} <InlineMarkdown text={other.title} />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <button
        type="button"
        role="menuitem"
        aria-label={`Remove ${plainInline(task.title)}`}
        className="block w-full theme-radius px-2 py-1.5 text-left font-mono text-[11px] hover:bg-foreground/10"
        onClick={onRemove}
      >
        remove
      </button>
    </div>
  );
}
