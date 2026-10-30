import { type MutableRefObject, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ancestorIds,
  blockerClosesCycle,
  compareTasks,
  descendantIds,
  formatTokenCount,
  hasOpenDescendant,
  liveBlockerIds,
} from "../shared/tasks";
import { formatDateTime, formatTime } from "../shared/time";
import type { Task, TaskLedger } from "../shared/types";
import { InlineMarkdown, plainInline } from "./markdown";
import { mediaUrl } from "./media-client";
import { removeTask, type TaskOutcome, updateTask } from "./task-client";

const LONG_PRESS_MS = 500;

function manualCompletion(task: Task) {
  const created = Date.parse(task.createdAt);
  const minutes = Number.isFinite(created)
    ? Math.max(1, Math.round((Date.now() - created) / 60_000))
    : 1;
  return {
    timeSpent: `${minutes}m`,
    tokens: 0,
    evidence: `Closed from the tasks page (${task.id})`,
  };
}

interface TasksViewProps {
  tasks: Task[];
  ready: boolean;
  footerClearance: number;
  armedParentId: string | null;
  onArmParent: (id: string | null) => void;
  onLedger: (ledger: TaskLedger) => void;
}

export function TasksView({
  tasks,
  ready,
  footerClearance,
  armedParentId,
  onArmParent,
  onLedger,
}: TasksViewProps) {
  const [pickerId, setPickerId] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [problem, setProblem] = useState<{ id: string; message: string } | null>(null);
  const ignoreNextCardClick = useRef(false);
  const ids = new Set(tasks.map((task) => task.id));
  const roots = tasks
    .filter((task) => task.parentId === null || !ids.has(task.parentId))
    .sort((a, b) => compareTasks(tasks, a, b));

  const apply = async (id: string, outcome: Promise<TaskOutcome>) => {
    const next = await outcome;
    if (!next.ok) {
      setProblem({ id, message: next.error });
      return;
    }
    setProblem((current) => (current?.id === id ? null : current));
    onLedger(next.ledger);
  };

  const menuTask = menu === null ? undefined : tasks.find((task) => task.id === menu.id);

  useEffect(() => {
    if (menu === null) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (document.getElementById("task-menu")?.contains(target)) return;
      // A tap that only dismisses the menu must not also toggle the card.
      // A drag clears the flag from the card, so a scroll does not stick.
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

  return (
    <div
      className="h-full overflow-x-hidden overflow-y-auto overscroll-x-none"
      data-testid="tasks-page"
    >
      <div
        className="mx-auto flex w-full max-w-[72ch] flex-col gap-4 px-4"
        style={{
          paddingTop: 16,
          paddingBottom: footerClearance + 16,
        }}
      >
        {!ready && <p className="font-mono text-xs text-muted-foreground">Loading…</p>}
        {ready && tasks.length === 0 && (
          <p className="py-8 text-center">
            <span className="bg-foreground px-2 py-1 font-mono text-[11px] text-background">
              No tasks yet.
            </span>
          </p>
        )}
        <ul className="flex flex-col gap-4">
          {roots.map((task) => (
            <TaskBranch
              key={task.id}
              task={task}
              tasks={tasks}
              armedParentId={armedParentId}
              ignoreNextCardClick={ignoreNextCardClick}
              problem={problem}
              menuTaskId={menu?.id ?? null}
              onOpenMenu={(id, x, y) => {
                setPickerId(null);
                setMenu({ id, x, y });
              }}
              onStatus={(task, status) =>
                void apply(
                  task.id,
                  updateTask(
                    task.id,
                    status === "done" ? { status, completion: manualCompletion(task) } : { status },
                  ),
                )
              }
            />
          ))}
        </ul>
      </div>
      {menu !== null &&
        menuTask !== undefined &&
        createPortal(
          <TaskMenu
            task={menuTask}
            tasks={tasks}
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

function TaskBranch({
  task,
  tasks,
  armedParentId,
  ignoreNextCardClick,
  problem,
  menuTaskId,
  onOpenMenu,
  onStatus,
}: {
  task: Task;
  tasks: Task[];
  armedParentId: string | null;
  ignoreNextCardClick: MutableRefObject<boolean>;
  problem: { id: string; message: string } | null;
  menuTaskId: string | null;
  onOpenMenu: (id: string, x: number, y: number) => void;
  onStatus: (task: Task, status: Task["status"]) => void;
}) {
  const children = tasks
    .filter((item) => item.parentId === task.id)
    .sort((a, b) => compareTasks(tasks, a, b));
  const done = task.status === "done";
  const completion = done && task.completion != null ? task.completion : null;
  const openChildren = !done && hasOpenDescendant(tasks, task.id);
  const blocked = liveBlockerIds(tasks, task)
    .map((id) => {
      const title = tasks.find((item) => item.id === id)?.title;
      return title === undefined ? id : plainInline(title);
    })
    .join(", ");
  const notice = problem?.id === task.id && menuTaskId !== task.id ? problem.message : null;
  const press = useRef<number | null>(null);
  const origin = useRef({ x: 0, y: 0 });
  const openedAt = useRef(0);

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
    <li className="min-w-0" data-testid={`task-${task.id}`}>
      <button
        type="button"
        data-task-card=""
        aria-pressed={done}
        aria-disabled={openChildren}
        aria-label={done ? `Reopen ${plainInline(task.title)}` : `Done ${plainInline(task.title)}`}
        aria-describedby={notice !== null ? `task-error-${task.id}` : undefined}
        title={openChildren ? "Finish open subtasks first" : undefined}
        className={
          armedParentId === task.id
            ? "block w-full select-none theme-radius bg-surface px-3 py-2 text-left ring-1 ring-inset ring-foreground/40"
            : "block w-full select-none theme-radius bg-surface px-3 py-2 text-left"
        }
        style={{ WebkitTouchCallout: "none" }}
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
          if (openChildren) return;
          onStatus(task, done ? "open" : "done");
        }}
      >
        <span className="flex items-center gap-2">
          <span
            data-task-check=""
            className={
              openChildren
                ? "grid h-4 w-4 shrink-0 place-items-center border border-foreground/40 theme-radius opacity-40"
                : "grid h-4 w-4 shrink-0 place-items-center border border-foreground/40 theme-radius"
            }
          >
            {done && <span className="block h-2 w-2 bg-foreground" />}
          </span>
          <span
            className={
              done
                ? "min-w-0 flex-1 whitespace-pre-wrap text-sm text-muted-foreground line-through [overflow-wrap:anywhere]"
                : "min-w-0 flex-1 whitespace-pre-wrap text-sm [overflow-wrap:anywhere]"
            }
          >
            <InlineMarkdown text={task.title} />
          </span>
          <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{task.id}</span>
        </span>
        {completion !== null && (
          <span
            data-testid="task-completion"
            className="mt-1 flex flex-wrap items-center gap-x-1 pl-6 font-mono text-[10px] text-muted-foreground"
          >
            {typeof task.completedAt === "string" && (
              <time dateTime={task.completedAt} title={formatDateTime(task.completedAt)}>
                completed {formatTime(task.completedAt)}
              </time>
            )}
            <span>
              · {completion.timeSpentText} · {formatTokenCount(completion.tokens)} tok
            </span>
          </span>
        )}
        {task.attachments !== undefined && task.attachments.length > 0 && (
          <span className="mt-2 flex flex-wrap gap-1.5 pl-6" data-testid="task-attachments">
            {task.attachments.map((id, index) => (
              <img
                key={id}
                src={mediaUrl(id)}
                alt={`Task attachment ${index + 1}`}
                loading="lazy"
                draggable={false}
                className={
                  done
                    ? "block size-12 rounded-sm border border-foreground/15 object-cover opacity-60"
                    : "block size-12 rounded-sm border border-foreground/15 object-cover"
                }
              />
            ))}
          </span>
        )}
        {blocked.length > 0 && (
          <span className="mt-1 block text-left font-mono text-[10px] text-muted-foreground">
            blocked by {blocked}
          </span>
        )}
      </button>
      {notice !== null && (
        <p
          id={`task-error-${task.id}`}
          role="alert"
          data-testid="task-error"
          className="mt-1 font-mono text-[11px] leading-4 text-destructive"
        >
          {notice}
        </p>
      )}
      {children.length > 0 && (
        <ul className="mt-3 ml-3 flex flex-col gap-3 border-l border-foreground/20 pl-3">
          {children.map((child) => (
            <TaskBranch
              key={child.id}
              task={child}
              tasks={tasks}
              armedParentId={armedParentId}
              ignoreNextCardClick={ignoreNextCardClick}
              problem={problem}
              menuTaskId={menuTaskId}
              onOpenMenu={onOpenMenu}
              onStatus={onStatus}
            />
          ))}
        </ul>
      )}
    </li>
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
