import { taskPlanUrl } from "../shared/pages.js";
import type { Task } from "../shared/types.js";
import {
  clampPushText,
  notify as defaultNotify,
  MAX_BODY_CHARS,
  type PushNotification,
} from "./push.js";
import type { TaskStore } from "./tasks.js";

/** One notification per task per window, so a plan that answers repeatedly rings once. */
export const PLAN_TURN_PUSH_WINDOW_MS = 60_000;
export const PLAN_TURN_PUSH_TITLE = "Plan finished";

export type PlanTurnPushSender = (notification: PushNotification) => Promise<unknown> | unknown;

export interface PlanTurnNotifierOptions {
  readonly notify?: PlanTurnPushSender;
  readonly now?: () => number;
  /** Minimum milliseconds between pushes for the same task. Zero disables the guard. */
  readonly windowMs?: number;
  readonly burstWindowMs?: number;
  readonly coalesceMs?: number;
  readonly log?: (line: string) => void;
}

/** The push a finished planning turn produces: the task id and title, opening its plan chat. */
export function planTurnNotification(task: Pick<Task, "id" | "title">): PushNotification {
  return {
    title: PLAN_TURN_PUSH_TITLE,
    body: clampPushText(`${task.id} ${task.title}`, MAX_BODY_CHARS),
    tag: `plan-${task.id}`,
    url: taskPlanUrl(task.id),
    data: { taskId: task.id, tab: "plan" },
  };
}

/**
 * Announces a finished plan turn. A plan can answer several turns in quick
 * succession (a steer, a queued follow-up); those turns share one push per task
 * inside the window, while another task still gets its own notification.
 */
export class PlanTurnNotifier {
  private readonly notifyPush: PlanTurnPushSender;
  private readonly now: () => number;
  private readonly windowMs: number;
  private readonly log: (line: string) => void;
  private readonly lastSentAt = new Map<string, number>();

  constructor(
    private readonly store: Pick<TaskStore, "ledger">,
    options: PlanTurnNotifierOptions = {},
  ) {
    this.notifyPush = options.notify ?? defaultNotify;
    this.now = options.now ?? Date.now;
    this.windowMs =
      options.windowMs ?? options.burstWindowMs ?? options.coalesceMs ?? PLAN_TURN_PUSH_WINDOW_MS;
    this.log = options.log ?? ((line) => console.warn(line));
  }

  /** Sends the task's finished-turn push, or returns false when it was coalesced. */
  async notifyTurn(taskId: string): Promise<boolean> {
    const task = this.store.ledger().tasks.find((item) => item.id === taskId);
    if (task === undefined) return false;
    const now = this.now();
    const previous = this.lastSentAt.get(taskId);
    if (this.windowMs > 0 && previous !== undefined && now - previous < this.windowMs) {
      return false;
    }
    this.lastSentAt.set(taskId, now);
    try {
      await this.notifyPush(planTurnNotification(task));
      return true;
    } catch (error) {
      this.log(`[task-agent] plan push failed for ${taskId}: ${String(error)}`);
      return false;
    }
  }

  /** Tests and shutdown call sites can forget the window without touching the clock. */
  reset(): void {
    this.lastSentAt.clear();
  }
}
