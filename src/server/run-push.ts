import { PAGE_PATHS, taskPlanUrl } from "../shared/pages.js";
import { clampPushText, notify as defaultNotify, type PushNotification } from "./push.js";

export const RUN_ERROR_PUSH_WINDOW_MS = 60_000;

export const RUN_ERROR_PUSH_BODY_CHARS = 120;
export const RUN_ERROR_CHAT_TITLE = "Turn failed in chat";

function errorKey(input: RunErrorPushInput): string {
  const message = input.message.replace(/\s+/g, " ").trim();
  return `${input.taskId ?? "chat"}\u0000${message}`;
}

export type RunErrorPushSender = (notification: PushNotification) => Promise<unknown> | unknown;

export interface RunErrorPushInput {
  readonly message: string;

  readonly taskId?: string;
}

export interface RunErrorNotifierOptions {
  readonly notify?: RunErrorPushSender;
  readonly now?: () => number;

  readonly windowMs?: number;
  readonly burstWindowMs?: number;
  readonly coalesceMs?: number;
  readonly log?: (line: string) => void;
}

export function runErrorNotification(input: RunErrorPushInput): PushNotification {
  const taskId = input.taskId?.trim();
  const plan = taskId !== undefined && taskId.length > 0;
  const body = clampPushText(input.message, RUN_ERROR_PUSH_BODY_CHARS);
  return {
    title: plan ? `Turn failed in the plan chat for ${taskId}` : RUN_ERROR_CHAT_TITLE,
    body: body.length > 0 ? body : "The turn ended with an error.",
    tag: plan ? `run-error-${taskId}` : "run-error",
    url: plan ? taskPlanUrl(taskId) : PAGE_PATHS.chat,
    data: plan ? { taskId, tab: "plan" } : { tab: "chat" },
  };
}

export class RunErrorNotifier {
  private readonly notifyPush: RunErrorPushSender;
  private readonly now: () => number;
  private readonly windowMs: number;
  private readonly log: (line: string) => void;
  private readonly lastSentAt = new Map<string, number>();

  constructor(options: RunErrorNotifierOptions = {}) {
    this.notifyPush = options.notify ?? defaultNotify;
    this.now = options.now ?? Date.now;
    this.windowMs =
      options.windowMs ?? options.burstWindowMs ?? options.coalesceMs ?? RUN_ERROR_PUSH_WINDOW_MS;
    this.log = options.log ?? ((line) => console.warn(line));
  }

  async deliver(input: RunErrorPushInput): Promise<boolean> {
    const key = errorKey(input);
    const now = this.now();
    const previous = this.lastSentAt.get(key);
    if (this.windowMs > 0 && previous !== undefined && now - previous < this.windowMs) {
      return false;
    }
    this.lastSentAt.set(key, now);
    try {
      await this.notifyPush(runErrorNotification(input));
      return true;
    } catch (error) {
      this.log(`[pi] run error push failed: ${String(error)}`);
      return false;
    }
  }

  reset(): void {
    this.lastSentAt.clear();
  }
}
