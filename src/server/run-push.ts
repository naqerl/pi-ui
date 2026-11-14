import { PAGE_PATHS, taskPlanUrl } from "../shared/pages.js";
import { clampPushText, notify as defaultNotify, type PushNotification } from "./push.js";

/** Repeated copies of the same failure inside this window ring only once. */
export const RUN_ERROR_PUSH_WINDOW_MS = 60_000;
/** The phone shows one short line of the provider's own failure text. */
export const RUN_ERROR_PUSH_BODY_CHARS = 120;
export const RUN_ERROR_CHAT_TITLE = "Turn failed in chat";

/** The text that identifies a failure for coalescing, before it is shortened for the phone. */
function errorKey(input: RunErrorPushInput): string {
  const message = input.message.replace(/\s+/g, " ").trim();
  return `${input.taskId ?? "chat"}\u0000${message}`;
}

export type RunErrorPushSender = (notification: PushNotification) => Promise<unknown> | unknown;

export interface RunErrorPushInput {
  /** The error's own message, the same summary the transcript shows. */
  readonly message: string;
  /** The task whose plan chat failed; absent for the main chat. */
  readonly taskId?: string;
}

export interface RunErrorNotifierOptions {
  readonly notify?: RunErrorPushSender;
  readonly now?: () => number;
  /** Minimum milliseconds between pushes for the same error. Zero disables coalescing. */
  readonly windowMs?: number;
  readonly burstWindowMs?: number;
  readonly coalesceMs?: number;
  readonly log?: (line: string) => void;
}

/** A run failure reaches the phone with the surface that owns it. */
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

/**
 * Announces a failed turn over the existing push path. One error message rings
 * once per window, while a different message is news and gets its own push.
 */
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

  /** Sends the failure push, or returns false when an identical one was just sent. */
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

  /** Tests and shutdown call sites can forget the window without touching the clock. */
  reset(): void {
    this.lastSentAt.clear();
  }
}
