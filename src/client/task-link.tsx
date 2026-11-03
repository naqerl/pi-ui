import { createContext, type ReactNode, useContext, useMemo } from "react";
import type { Task } from "../shared/types";

/** What the Markdown renderer needs to turn a four-character task id into a link. */
export interface TaskLinkValue {
  tasks: readonly Task[];
  openTask: (id: string) => void;
}

const TaskLinkContext = createContext<TaskLinkValue | null>(null);

export function TaskLinkProvider({
  tasks,
  openTask,
  children,
}: TaskLinkValue & { children: ReactNode }) {
  const value = useMemo(() => ({ tasks, openTask }), [tasks, openTask]);
  return <TaskLinkContext.Provider value={value}>{children}</TaskLinkContext.Provider>;
}

export function useTaskLink(): TaskLinkValue | null {
  return useContext(TaskLinkContext);
}

const TASK_ID = /^[a-z0-9]{4}$/;

/**
 * The task a four-character codespan names, or undefined when the span is not a task id.
 * Exact ids win; a longer id can also be cited by the short handle its card shows, but only
 * when that prefix is unambiguous.
 */
export function taskForCode(text: string, tasks: readonly Task[]): Task | undefined {
  if (!TASK_ID.test(text)) return undefined;
  const exact = tasks.find((task) => task.id === text);
  if (exact !== undefined) return exact;
  const matches = tasks.filter((task) => task.id.length > text.length && task.id.startsWith(text));
  return matches.length === 1 ? matches[0] : undefined;
}
