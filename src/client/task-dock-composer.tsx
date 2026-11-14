import { createContext, type ReactNode, useContext, useLayoutEffect } from "react";
import type { MessageMode, RunError } from "../shared/types";
import type { TaskStatusWord } from "./working-state";

export type TaskDockSession = {
  taskId: string;
  placeholder: string;
  running: boolean;
  error: string | null;
  send: (text: string, mode?: MessageMode, attachments?: string[]) => Promise<boolean> | boolean;
  stop: () => void | Promise<void>;
  dismissError: () => void;
};

/** The open task's own status, shown in the composer slot while the tasks page is active. */
export type TaskSurfaceStatus = {
  taskId: string;
  word: TaskStatusWord;
};

/** The open task's run error, hosted by the one app-level header instead of the plan pane. */
export type TaskRunErrorSurface = {
  taskId: string;
  error: RunError | null;
  dismiss: (id: string) => void;
};

const TaskDockRegister = createContext<(session: TaskDockSession | null) => void>(() => {});
const TaskSurfaceStatusRegister = createContext<(status: TaskSurfaceStatus | null) => void>(
  () => {},
);
const TaskRunErrorRegister = createContext<(surface: TaskRunErrorSurface | null) => void>(() => {});

export function TaskDockComposerProvider({
  onSession,
  onStatus,
  onRunError,
  children,
}: {
  onSession: (session: TaskDockSession | null) => void;
  onStatus: (status: TaskSurfaceStatus | null) => void;
  onRunError: (surface: TaskRunErrorSurface | null) => void;
  children: ReactNode;
}) {
  return (
    <TaskDockRegister.Provider value={onSession}>
      <TaskSurfaceStatusRegister.Provider value={onStatus}>
        <TaskRunErrorRegister.Provider value={onRunError}>{children}</TaskRunErrorRegister.Provider>
      </TaskSurfaceStatusRegister.Provider>
    </TaskDockRegister.Provider>
  );
}

/** TaskAgentChat registers its dock send/stop/placeholder while the task is open. */
export function useRegisterTaskDock(session: TaskDockSession | null) {
  const register = useContext(TaskDockRegister);
  useLayoutEffect(() => {
    register(session);
    return () => register(null);
  }, [register, session]);
}

/** The tasks page registers the open task's status; null means no task is open. */
export function useRegisterTaskSurfaceStatus(status: TaskSurfaceStatus | null) {
  const register = useContext(TaskSurfaceStatusRegister);
  useLayoutEffect(() => {
    register(status);
    return () => register(null);
  }, [register, status]);
}

/** TaskAgentChat registers the open task's run error for the app-level header. */
export function useRegisterTaskRunError(surface: TaskRunErrorSurface | null) {
  const register = useContext(TaskRunErrorRegister);
  useLayoutEffect(() => {
    register(surface);
    return () => register(null);
  }, [register, surface]);
}
