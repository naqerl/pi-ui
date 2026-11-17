import type { TaskChatFrame } from "../shared/types";

type Handler = (frame: TaskChatFrame) => void;
/** The main stream's liveness payload, forwarded to a task shim that has no stream of its own. */
type LivenessHandler = (data: unknown) => void;

const handlers = new Set<Handler>();
const livenessHandlers = new Set<LivenessHandler>();
/** The newest heartbeat, replayed to a pane that mounts between two of them. */
let lastLiveness: unknown;

/**
 * Subscribe to plan-conversation frames relayed by the main stream. `taskId` filters
 * at the publisher, so a plan pane never renders another task's frames.
 */
export function subscribeTaskChatEvents(handler: Handler, taskId?: string): () => void {
  const filtered: Handler =
    taskId === undefined
      ? handler
      : (frame) => {
          if (frame.taskId === taskId) handler(frame);
        };
  handlers.add(filtered);
  return () => {
    handlers.delete(filtered);
  };
}

export function publishTaskChatEvent(frame: TaskChatFrame): void {
  for (const handler of handlers) handler(frame);
}

/** The main stream is the one connection; its heartbeats are forwarded to task shims. */
export function subscribeTaskChatLiveness(handler: LivenessHandler): () => void {
  livenessHandlers.add(handler);
  if (lastLiveness !== undefined) handler(lastLiveness);
  return () => {
    livenessHandlers.delete(handler);
  };
}

export function publishTaskChatLiveness(data: unknown): void {
  lastLiveness = data;
  for (const handler of livenessHandlers) handler(data);
}
