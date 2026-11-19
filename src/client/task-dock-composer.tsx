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

export type TaskSurfaceStatus = {
  taskId: string;
  word: TaskStatusWord;

  quiet?: boolean;
};

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

export function useRegisterTaskDock(session: TaskDockSession | null) {
  const register = useContext(TaskDockRegister);
  useLayoutEffect(() => {
    register(session);
    return () => register(null);
  }, [register, session]);
}

export function useRegisterTaskSurfaceStatus(status: TaskSurfaceStatus | null) {
  const register = useContext(TaskSurfaceStatusRegister);
  useLayoutEffect(() => {
    register(status);
    return () => register(null);
  }, [register, status]);
}

export function useRegisterTaskRunError(surface: TaskRunErrorSurface | null) {
  const register = useContext(TaskRunErrorRegister);
  useLayoutEffect(() => {
    register(surface);
    return () => register(null);
  }, [register, surface]);
}
