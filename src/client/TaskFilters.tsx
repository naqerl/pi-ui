import { taskState } from "../shared/task-status";
import type { Task, TaskActivity } from "../shared/types";
import { cn } from "./lib/utils";

export type TaskFilter = "active" | "blocked" | "proposed";

const FILTERS = ["active", "blocked", "proposed"] as const;
const LABELS: Record<TaskFilter, string> = {
  active: "Active",
  blocked: "Blocked",
  proposed: "Proposed",
};

/** The number beside each filter, counting the same task sets the list shows. */
export function taskFilterCounts(
  tasks: Task[],
  activity: TaskActivity | undefined,
): Record<TaskFilter, number> {
  const stateOf = new Map<string, ReturnType<typeof taskState>>();
  for (const task of tasks) stateOf.set(task.id, taskState(tasks, task, activity));
  const open = tasks.filter(
    (task) => task.status !== "proposed" && task.status !== "done" && task.status !== "backlog",
  );
  return {
    active: open.length,
    blocked: open.filter((task) => stateOf.get(task.id) === "blocked").length,
    proposed: tasks.filter((task) => task.status === "proposed").length,
  };
}

/** The task filters that sit on the composer's top line while the tasks page is open. */
export function TaskFilters({
  tasks,
  activity,
  filter,
  onChange,
  className,
}: {
  tasks: Task[];
  activity: TaskActivity | undefined;
  filter: TaskFilter;
  onChange: (filter: TaskFilter) => void;
  className?: string;
}) {
  const counts = taskFilterCounts(tasks, activity);
  return (
    <div
      role="tablist"
      aria-label="Task filter"
      data-testid="task-filters"
      className={cn("flex max-w-full flex-wrap items-center gap-1", className)}
    >
      {FILTERS.map((item) => {
        const selected = filter === item;
        return (
          <button
            key={item}
            type="button"
            role="tab"
            aria-selected={selected}
            data-testid={`task-filter-${item}`}
            onClick={() => onChange(item)}
            className={cn(
              "inline-flex h-7 items-center gap-1.5 whitespace-nowrap rounded-sm px-2.5 text-sm font-medium leading-none",
              selected ? "bg-foreground text-background" : "text-muted-foreground hover:bg-muted",
            )}
          >
            {LABELS[item]}
            <span
              className={cn(
                "text-xs leading-none tabular-nums",
                selected ? "text-background/70" : "text-muted-foreground",
              )}
            >
              {counts[item]}
            </span>
          </button>
        );
      })}
    </div>
  );
}
