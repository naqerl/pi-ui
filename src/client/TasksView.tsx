import { useState } from "react";
import {
  ancestorIds,
  blockerClosesCycle,
  compareTasks,
  descendantIds,
  hasOpenDescendant,
  liveBlockerIds,
} from "../shared/tasks";
import type { Task, TaskLedger } from "../shared/types";
import { removeTask, updateTask } from "./task-client";

interface TasksViewProps {
  tasks: Task[];
  ready: boolean;
  headerClearance: number;
  footerClearance: number;
  armedParentId: string | null;
  onArmParent: (id: string | null) => void;
  onLedger: (ledger: TaskLedger) => void;
}

export function TasksView({
  tasks,
  ready,
  headerClearance,
  footerClearance,
  armedParentId,
  onArmParent,
  onLedger,
}: TasksViewProps) {
  const [pickerId, setPickerId] = useState<string | null>(null);
  const ids = new Set(tasks.map((task) => task.id));
  const roots = tasks
    .filter((task) => task.parentId === null || !ids.has(task.parentId))
    .sort((a, b) => compareTasks(tasks, a, b));

  const apply = async (ledger: Promise<TaskLedger | null>) => {
    const next = await ledger;
    if (next !== null) onLedger(next);
  };

  return (
    <div className="h-full overflow-y-auto" data-testid="tasks-page">
      <div
        className="mx-auto flex w-full max-w-[72ch] flex-col gap-4 px-4"
        style={{
          paddingTop: headerClearance + 16,
          paddingBottom: footerClearance + 16,
        }}
      >
        {!ready && <p className="font-mono text-xs text-muted-foreground">Loading…</p>}
        {ready && tasks.length === 0 && (
          <p className="py-8 text-center font-mono text-xs text-muted-foreground">No tasks yet.</p>
        )}
        <ul className="flex flex-col gap-4">
          {roots.map((task) => (
            <TaskBranch
              key={task.id}
              task={task}
              tasks={tasks}
              armedParentId={armedParentId}
              pickerId={pickerId}
              onArmParent={onArmParent}
              onTogglePicker={(id) => setPickerId((current) => (current === id ? null : id))}
              onStatus={(id, status) => void apply(updateTask(id, { status }))}
              onBlockers={(id, blockedBy) => void apply(updateTask(id, { blockedBy }))}
              onRemove={(id) => {
                if (armedParentId === id) onArmParent(null);
                if (pickerId === id) setPickerId(null);
                void apply(removeTask(id));
              }}
            />
          ))}
        </ul>
      </div>
    </div>
  );
}

function TaskBranch({
  task,
  tasks,
  armedParentId,
  pickerId,
  onArmParent,
  onTogglePicker,
  onStatus,
  onBlockers,
  onRemove,
}: {
  task: Task;
  tasks: Task[];
  armedParentId: string | null;
  pickerId: string | null;
  onArmParent: (id: string | null) => void;
  onTogglePicker: (id: string) => void;
  onStatus: (id: string, status: Task["status"]) => void;
  onBlockers: (id: string, blockedBy: string[]) => void;
  onRemove: (id: string) => void;
}) {
  const children = tasks
    .filter((item) => item.parentId === task.id)
    .sort((a, b) => compareTasks(tasks, a, b));
  const done = task.status === "done";
  const openChildren = !done && hasOpenDescendant(tasks, task.id);
  const blocked = liveBlockerIds(tasks, task)
    .map((id) => tasks.find((item) => item.id === id)?.title ?? id)
    .join(", ");
  const ancestors = ancestorIds(tasks, task.id);
  const descendants = descendantIds(tasks, task.id);
  const candidates = tasks
    .filter((item) => item.id !== task.id && !ancestors.has(item.id) && !descendants.has(item.id))
    .sort((a, b) => compareTasks(tasks, a, b));

  return (
    <li className="min-w-0" data-testid={`task-${task.id}`}>
      <div className={armedParentId === task.id ? "theme-radius bg-foreground/10 px-2 py-1" : ""}>
        <div className="flex items-start gap-2">
          <button
            type="button"
            aria-label={done ? `Reopen ${task.title}` : `Done ${task.title}`}
            aria-pressed={done}
            disabled={openChildren}
            title={openChildren ? "Finish open subtasks first" : undefined}
            className="mt-0.5 grid h-4 w-4 shrink-0 place-items-center border border-foreground/40 theme-radius disabled:opacity-40"
            onClick={() => onStatus(task.id, done ? "open" : "done")}
          >
            {done && <span className="block h-2 w-2 bg-foreground" />}
          </button>
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2">
              <span
                className={
                  done
                    ? "min-w-0 break-words text-sm text-muted-foreground line-through"
                    : "min-w-0 break-words text-sm"
                }
              >
                {task.title}
              </span>
              <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                {task.id}
              </span>
            </div>
            {blocked.length > 0 && (
              <p className="font-mono text-[10px] text-muted-foreground">blocked by {blocked}</p>
            )}
            {openChildren && (
              <p className="font-mono text-[10px] text-muted-foreground">open subtasks</p>
            )}
            <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[10px] text-muted-foreground">
              <button
                type="button"
                aria-pressed={armedParentId === task.id}
                aria-label={`Subtask of ${task.title}`}
                className="hover:text-foreground"
                onClick={() => onArmParent(armedParentId === task.id ? null : task.id)}
              >
                subtask
              </button>
              <button
                type="button"
                aria-expanded={pickerId === task.id}
                aria-label={`Blockers for ${task.title}`}
                className="hover:text-foreground"
                onClick={() => onTogglePicker(task.id)}
              >
                blocker
              </button>
              <button
                type="button"
                aria-label={`Remove ${task.title}`}
                className="hover:text-foreground"
                onClick={() => onRemove(task.id)}
              >
                remove
              </button>
            </div>
            {pickerId === task.id && (
              <ul className="mt-1 flex flex-col gap-1">
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
                        aria-label={`Blocked by ${other.title}`}
                        disabled={cycle}
                        className="text-left font-mono text-[11px] text-foreground hover:text-foreground disabled:opacity-40"
                        onClick={() => {
                          const blockedBy = selected
                            ? task.blockedBy.filter((id) => id !== other.id)
                            : [...task.blockedBy, other.id];
                          onBlockers(task.id, blockedBy);
                        }}
                      >
                        {selected ? "●" : "○"} {other.title}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      </div>
      {children.length > 0 && (
        <ul className="mt-3 ml-3 flex flex-col gap-3 border-l border-foreground/20 pl-3">
          {children.map((child) => (
            <TaskBranch
              key={child.id}
              task={child}
              tasks={tasks}
              armedParentId={armedParentId}
              pickerId={pickerId}
              onArmParent={onArmParent}
              onTogglePicker={onTogglePicker}
              onStatus={onStatus}
              onBlockers={onBlockers}
              onRemove={onRemove}
            />
          ))}
        </ul>
      )}
    </li>
  );
}
