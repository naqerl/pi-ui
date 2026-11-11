export interface TaskChatEvent {
  taskId: string;
  event: string;
  data: unknown;
}

type Handler = (frame: TaskChatEvent) => void;

const handlers = new Set<Handler>();

export function subscribeTaskChatEvents(handler: Handler): () => void {
  handlers.add(handler);
  return () => {
    handlers.delete(handler);
  };
}

export function publishTaskChatEvent(frame: TaskChatEvent): void {
  for (const handler of handlers) handler(frame);
}
