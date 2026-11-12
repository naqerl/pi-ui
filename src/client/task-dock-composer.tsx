import { createContext, type ReactNode, useContext, useLayoutEffect } from "react";
import type { MessageMode } from "../shared/types";

export type TaskDockSession = {
  taskId: string;
  placeholder: string;
  running: boolean;
  error: string | null;
  send: (text: string, mode?: MessageMode, attachments?: string[]) => Promise<boolean> | boolean;
  stop: () => void | Promise<void>;
  dismissError: () => void;
};

const TaskDockRegister = createContext<(session: TaskDockSession | null) => void>(() => {});

export function TaskDockComposerProvider({
  onSession,
  children,
}: {
  onSession: (session: TaskDockSession | null) => void;
  children: ReactNode;
}) {
  return <TaskDockRegister.Provider value={onSession}>{children}</TaskDockRegister.Provider>;
}

/** TaskAgentChat registers its dock send/stop/placeholder while the task is open. */
export function useRegisterTaskDock(session: TaskDockSession | null) {
  const register = useContext(TaskDockRegister);
  useLayoutEffect(() => {
    register(session);
    return () => register(null);
  }, [register, session]);
}
