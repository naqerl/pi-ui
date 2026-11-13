import { createContext, type ReactNode, useContext, useLayoutEffect } from "react";
import type { MessageMode } from "../shared/types";
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

const TaskDockRegister = createContext<(session: TaskDockSession | null) => void>(() => {});
const TaskSurfaceStatusRegister = createContext<(status: TaskSurfaceStatus | null) => void>(
  () => {},
);

export function TaskDockComposerProvider({
  onSession,
  onStatus,
  children,
}: {
  onSession: (session: TaskDockSession | null) => void;
  onStatus: (status: TaskSurfaceStatus | null) => void;
  children: ReactNode;
}) {
  return (
    <TaskDockRegister.Provider value={onSession}>
      <TaskSurfaceStatusRegister.Provider value={onStatus}>
        {children}
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
