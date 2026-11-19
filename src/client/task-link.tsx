import { createContext, type ReactNode, useContext, useMemo } from "react";
import type { Task } from "../shared/types";

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

export function taskForCode(text: string, tasks: readonly Task[]): Task | undefined {
  if (!TASK_ID.test(text)) return undefined;
  const exact = tasks.find((task) => task.id === text);
  if (exact !== undefined) return exact;
  const matches = tasks.filter((task) => task.id.length > text.length && task.id.startsWith(text));
  return matches.length === 1 ? matches[0] : undefined;
}
