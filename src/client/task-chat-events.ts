import type { TaskChatFrame } from "../shared/types";

type Handler = (frame: TaskChatFrame) => void;

type LivenessHandler = (data: unknown) => void;

const handlers = new Set<Handler>();
const livenessHandlers = new Set<LivenessHandler>();

let lastLiveness: unknown;

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
