import { type MutableRefObject, useEffect, useId, useRef, useState } from "react";
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
  const [openTaskId, setOpenTaskId] = useState<string | null>(null);
  const ignoreNextCardClick = useRef(false);
  const activeTasks = tasks.filter((task) => task.status !== "proposed");
  const proposedTasks = tasks
    .filter((task) => task.status === "proposed")
    .sort((a, b) => {
      const left = a.proposedAt ?? a.createdAt;
      const right = b.proposedAt ?? b.createdAt;
      return left === right ? (a.id < b.id ? -1 : 1) : left < right ? -1 : 1;
    });
  const ids = new Set(activeTasks.map((task) => task.id));
  const roots = activeTasks
    .filter((task) => task.parentId === null || !ids.has(task.parentId))
    .sort((a, b) => compareTasks(activeTasks, a, b));

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
        {proposedTasks.length > 0 && (
          <section className="flex flex-col gap-3" data-testid="task-proposals">
            <h2 className="theme-radius bg-surface px-3 py-2 font-mono text-[11px] uppercase tracking-wide text-muted-foreground">
              Proposed ({proposedTasks.length})
            </h2>
            <ul id="proposed-tasks" className="flex flex-col gap-3">
              {proposedTasks.map((task) => (
                <ProposedTask
                  key={task.id}
                  task={task}
                  notice={problem?.id === task.id ? problem.message : null}
                  onOpen={() => setOpenTaskId(task.id)}
                  onApprove={() => void apply(task.id, updateTask(task.id, { status: "open" }))}
                  onDismiss={() => void apply(task.id, removeTask(task.id))}
                />
              ))}
            </ul>
          </section>
        )}
        <ul className="flex flex-col gap-4">
          {roots.map((task) => (
            <TaskBranch
              key={task.id}
              task={task}
              tasks={activeTasks}
              armedParentId={armedParentId}
              ignoreNextCardClick={ignoreNextCardClick}
              problem={problem}
              menuTaskId={menu?.id ?? null}
              onOpenMenu={(id, x, y) => {
                setPickerId(null);
                setMenu({ id, x, y });
              }}
              onOpen={() => setOpenTaskId(task.id)}
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
      {openTask !== undefined && (
        <TaskModal
          task={openTask}
          tasks={tasks}
          onClose={() => setOpenTaskId(null)}
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
      )}
    </div>
  );
}

/** Created and closed instants on every task card, in the browser's own zone. */
export function TaskTimes({ task }: { task: Task }) {
  const created = formatDateTime(task.createdAt);
  const closed =
    task.status === "done" && typeof task.completedAt === "string"
      ? formatDateTime(task.completedAt)
      : "";
  return (
    <span
      data-testid="task-times"
      className="mt-1 flex flex-wrap items-center gap-x-2 pl-6 font-mono text-[10px] text-muted-foreground"
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

function ProposedTask({
  task,
  notice,
  onOpen,
  onApprove,
  onDismiss,
}: {
  task: Task;
  notice: string | null;
  onOpen: () => void;
  onApprove: () => void;
  onDismiss: () => void;
}) {
  const stop = (event: { stopPropagation: () => void }) => event.stopPropagation();
  return (
    <li
      data-testid={`proposal-${task.id}`}
      className="theme-radius bg-surface px-3 py-2 ring-1 ring-inset ring-foreground/10"
    >
      {/* biome-ignore lint/a11y/useSemanticElements: the card contains its own approve and dismiss buttons. */}
      <div
        role="button"
        tabIndex={0}
        aria-label={`Open proposal ${plainInline(task.title)}`}
        className="block w-full cursor-pointer select-none text-left"
        onClick={onOpen}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          onOpen();
        }}
      >
        <div className="flex items-start gap-2 text-muted-foreground">
          <span className="min-w-0 flex-1 whitespace-pre-wrap text-sm [overflow-wrap:anywhere]">
            <InlineMarkdown text={task.title} />
          </span>
          <span className="shrink-0 font-mono text-[10px]">{task.id}</span>
        </div>
        {task.rationale !== undefined && task.rationale.length > 0 && (
          <p className="mt-1 line-clamp-3 whitespace-pre-wrap text-xs text-muted-foreground [overflow-wrap:anywhere]">
            {task.rationale}
          </p>
        )}
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
          <TaskTimes task={task} />
          <span className="flex gap-1.5">
            <button
              type="button"
              aria-label={`Approve ${plainInline(task.title)}`}
              className="theme-radius bg-foreground px-2 py-1 font-mono text-[10px] text-background"
              onClick={(event) => {
                stop(event);
                onApprove();
              }}
            >
              Approve
            </button>
            <button
              type="button"
              aria-label={`Dismiss ${plainInline(task.title)}`}
              className="theme-radius border border-foreground/20 bg-surface px-2 py-1 font-mono text-[10px] text-foreground"
              onClick={(event) => {
                stop(event);
                onDismiss();
              }}
            >
              Dismiss
            </button>
          </span>
        </div>
      </div>
      {notice !== null && (
        <p
          role="alert"
          data-testid="task-error"
          className="mt-1 font-mono text-[11px] leading-4 text-destructive"
        >
          {notice}
        </p>
      )}
    </li>
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
  onOpen,
  onStatus,
}: {
  task: Task;
  tasks: Task[];
  armedParentId: string | null;
  ignoreNextCardClick: MutableRefObject<boolean>;
  problem: { id: string; message: string } | null;
  menuTaskId: string | null;
  onOpenMenu: (id: string, x: number, y: number) => void;
  onOpen: () => void;
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

  const stopAction = (event: { stopPropagation: () => void }) => event.stopPropagation();

  useEffect(() => {
    return () => {
      if (press.current !== null) window.clearTimeout(press.current);
    };
  }, []);

  return (
    <li className="min-w-0" data-testid={`task-${task.id}`}>
      {/* biome-ignore lint/a11y/useSemanticElements: the card contains its own action buttons. */}
      <div
        data-task-card=""
        role="button"
        tabIndex={0}
        aria-pressed={done}
        aria-disabled={openChildren}
        aria-label={`Open ${plainInline(task.title)}`}
        aria-describedby={notice !== null ? `task-error-${task.id}` : undefined}
        title={openChildren ? "Finish open subtasks first" : undefined}
        className={
          armedParentId === task.id
            ? "block w-full cursor-pointer select-none theme-radius bg-surface px-3 py-2 text-left ring-1 ring-inset ring-foreground/40"
            : "block w-full cursor-pointer select-none theme-radius bg-surface px-3 py-2 text-left"
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
          onOpen();
        }}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          onOpen();
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
        <TaskTimes task={task} />
        <span className="mt-2 flex flex-wrap items-center gap-1.5 pl-6" data-testid="task-actions">
          <button
            type="button"
            data-task-action="status"
            aria-pressed={done}
            aria-disabled={openChildren}
            aria-label={
              done ? `Reopen ${plainInline(task.title)}` : `Done ${plainInline(task.title)}`
            }
            className="theme-radius border border-foreground/20 bg-surface px-2 py-1 font-mono text-[10px] text-foreground aria-disabled:opacity-40"
            onPointerDown={stopAction}
            onClick={(event) => {
              stopAction(event);
              if (openChildren) return;
              onStatus(task, done ? "open" : "done");
            }}
          >
            {done ? "reopen" : "done"}
          </button>
          <button
            type="button"
            data-task-action="blocker"
            aria-label={`Add blocker to ${plainInline(task.title)}`}
            className="theme-radius border border-foreground/20 bg-surface px-2 py-1 font-mono text-[10px] text-muted-foreground"
            onPointerDown={stopAction}
            onClick={(event) => {
              stopAction(event);
              const rect = event.currentTarget.getBoundingClientRect();
              openMenu(rect.left, rect.bottom);
            }}
          >
            blocker
          </button>
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
      </div>
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
              onOpen={onOpen}
              onStatus={onStatus}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

export function TaskModal({
  task,
  tasks,
  onClose,
  onStatus,
}: {
  task: Task;
  tasks: Task[];
  onClose: () => void;
  onStatus: (task: Task, status: Task["status"]) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const done = task.status === "done";
  const completion = done ? task.completion : null;
  const blockers = task.blockedBy.map((id) => {
    const blocker = tasks.find((item) => item.id === id);
    return blocker === undefined
      ? { id, title: id, status: "missing" }
      : { id, title: plainInline(blocker.title), status: blocker.status };
  });

  useEffect(() => {
    const dialog = ref.current;
    const bodyOverflow = document.body.style.overflow;
    const htmlOverflow = document.documentElement.style.overflow;
    document.body.style.overflow = "hidden";
    document.documentElement.style.overflow = "hidden";
    if (dialog !== null && !dialog.open) dialog.showModal();
    return () => {
      dialog?.close();
      document.body.style.overflow = bodyOverflow;
      document.documentElement.style.overflow = htmlOverflow;
    };
  }, []);

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: Esc is handled by the dialog's cancel event.
    <dialog
      ref={ref}
      data-testid="task-modal"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      className="m-auto h-[calc(100dvh-1.5rem)] w-[calc(100vw-1.5rem)] max-w-[calc(100vw-1.5rem)] overflow-hidden rounded-xl border border-foreground/15 bg-surface p-0 text-foreground shadow-xl backdrop:bg-transparent sm:h-[calc(100dvh-3rem)] sm:w-[min(56rem,calc(100vw-3rem))] sm:max-w-[calc(100vw-3rem)]"
    >
      <div className="flex h-full min-h-0 flex-col">
        <header className="ink-line flex items-start gap-3 border-b px-4 py-3">
          <div className="min-w-0 flex-1">
            <div className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
              Task · {task.status}
            </div>
            <h2 id={titleId} className="mt-0.5 text-sm font-medium [overflow-wrap:anywhere]">
              <InlineMarkdown text={task.title} />
            </h2>
          </div>
          <button
            type="button"
            data-testid="task-modal-close"
            aria-label="Close"
            onClick={onClose}
            className="-mr-1 shrink-0 rounded-md px-2 py-1 font-mono text-sm text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
          >
            ✕
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 text-sm">
          {task.rationale !== undefined && task.rationale.length > 0 && (
            <section>
              <h3 className="mb-1 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
                Rationale
              </h3>
              <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{task.rationale}</p>
            </section>
          )}
          <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 font-mono text-xs">
            <dt className="text-muted-foreground">Status</dt>
            <dd>{task.status}</dd>
            <dt className="text-muted-foreground">Created</dt>
            <dd>
              <time dateTime={task.createdAt} title={formatDateTime(task.createdAt)}>
                {formatDateTime(task.createdAt)}
              </time>
            </dd>
            {task.completedAt !== null && (
              <>
                <dt className="text-muted-foreground">Closed</dt>
                <dd>
                  <time dateTime={task.completedAt} title={formatDateTime(task.completedAt)}>
                    {formatDateTime(task.completedAt)}
                  </time>
                </dd>
              </>
            )}
          </dl>
          <section className="mt-4">
            <h3 className="mb-1 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
              Blockers
            </h3>
            {blockers.length === 0 ? (
              <p className="font-mono text-xs text-muted-foreground">None</p>
            ) : (
              <ul className="flex flex-col gap-1 font-mono text-xs">
                {blockers.map((blocker) => (
                  <li key={blocker.id} className="flex gap-2 [overflow-wrap:anywhere]">
                    <span className="text-muted-foreground">{blocker.status}</span>
                    <span className="min-w-0 flex-1">{blocker.title}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
          {done && (
            <section className="mt-4" data-testid="task-modal-completion">
              <h3 className="mb-1 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
                Completion
              </h3>
              {completion === null ? (
                <p className="font-mono text-xs text-muted-foreground">No completion record</p>
              ) : (
                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 font-mono text-xs">
                  <dt className="text-muted-foreground">Time spent</dt>
                  <dd>
                    {completion.timeSpentText} ({completion.timeSpentMinutes} min)
                  </dd>
                  <dt className="text-muted-foreground">Tokens</dt>
                  <dd>{formatTokenCount(completion.tokens)}</dd>
                  <dt className="text-muted-foreground">Evidence</dt>
                  <dd className="min-w-0 [overflow-wrap:anywhere]">{completion.evidence}</dd>
                </dl>
              )}
            </section>
          )}
          <div className="mt-5 flex flex-wrap gap-1.5">
            <button
              type="button"
              aria-label={
                done ? `Reopen ${plainInline(task.title)}` : `Done ${plainInline(task.title)}`
              }
              className="theme-radius border border-foreground/20 bg-surface px-2.5 py-1 font-mono text-[11px] text-foreground"
              onClick={() => onStatus(task, done ? "open" : "done")}
            >
              {done ? "Reopen" : "Mark done"}
            </button>
          </div>
        </div>
      </div>
    </dialog>
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
