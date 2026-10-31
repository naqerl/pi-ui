import {
  defineTool,
  type ToolExecutionResult,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { Type } from "typebox";
import type { OperatorNoticeRecord } from "../shared/notices.js";
import type { PushNotification } from "./push.js";

/** The limits the tool validates before anything is sent or clamped. */
export const NOTIFY_OPERATOR_LIMITS = {
  title: 60,
  body: 140,
  reason: 200,
} as const;

/** At most one operator push in this window; later calls are suppressed. */
export const NOTIFY_OPERATOR_RATE_LIMIT_MS = 30_000;

export interface OperatorBridge {
  /** Sends the push and returns how many subscriptions accepted it. Never throws. */
  notify(notification: PushNotification): Promise<number> | number;
  /** Adds the chat chip for the call; a failure here never fails the tool. */
  recordNotice(record: OperatorNoticeRecord): void | Promise<void>;
}

export interface OperatorToolOptions {
  /** Override the clock in tests. */
  readonly now?: () => number;
  /** How long one push keeps later calls suppressed. */
  readonly rateLimitMs?: number;
}

function text(value: string, isError = false): ToolExecutionResult {
  return { output: [{ type: "text", text: value }], ...(isError ? { isError: true } : {}) };
}

function overLength(field: string, value: string, limit: number): string | null {
  if (value.length === 0) return `${field} is required and must be 1-${limit} characters.`;
  if (value.length > limit) {
    return `${field} is too long: ${value.length} characters, the limit is ${limit}. Shorten it rather than truncating.`;
  }
  return null;
}

/** Tools for asking the operator for a decision. Not deferred, so every turn offers it. */
export function createOperatorTools(
  bridge: OperatorBridge,
  options: OperatorToolOptions = {},
): ToolRegistration[] {
  const now = options.now ?? Date.now;
  const rateLimitMs = options.rateLimitMs ?? NOTIFY_OPERATOR_RATE_LIMIT_MS;
  let lastSentAt: number | undefined;

  return [
    defineTool({
      name: "notify_operator",
      description:
        "Use when you need a decision to be made by the user. Sends a web push to the operator's devices and returns how many subscriptions received it.",
      parameters: Type.Object({
        title: Type.String({
          minLength: 1,
          maxLength: NOTIFY_OPERATOR_LIMITS.title,
          description: "Short headline, 1-60 characters.",
        }),
        body: Type.String({
          minLength: 1,
          maxLength: NOTIFY_OPERATOR_LIMITS.body,
          description:
            "The question or the decision needed, in one or two sentences, 1-140 characters.",
        }),
        reason: Type.String({
          minLength: 1,
          maxLength: NOTIFY_OPERATOR_LIMITS.reason,
          description: "Why this cannot wait for the next user message, 1-200 characters.",
        }),
      }),
      async execute(args) {
        const title = typeof args.title === "string" ? args.title.trim() : "";
        const body = typeof args.body === "string" ? args.body.trim() : "";
        const reason = typeof args.reason === "string" ? args.reason.trim() : "";
        const invalid =
          overLength("title", title, NOTIFY_OPERATOR_LIMITS.title) ??
          overLength("body", body, NOTIFY_OPERATOR_LIMITS.body) ??
          overLength("reason", reason, NOTIFY_OPERATOR_LIMITS.reason);
        if (invalid !== null) return text(invalid, true);

        const at = now();
        const suppressed = lastSentAt !== undefined && at - lastSentAt < rateLimitMs;
        let sent = 0;
        if (!suppressed) {
          lastSentAt = at;
          try {
            sent = await bridge.notify({
              title,
              body,
              tag: "notify-operator",
              url: "/chat",
              data: { reason },
            });
          } catch (error) {
            // A dead push service must still leave a successful tool result.
            console.error("[pi] operator push failed", error);
            sent = 0;
          }
        }

        try {
          await bridge.recordNotice({ title, body, reason });
        } catch (error) {
          console.error("[pi] could not record the operator notice", error);
        }

        return text(
          suppressed ? 'sent: 0, suppressed: "rate limited"' : `sent: ${Math.max(0, sent)}`,
        );
      },
    }),
  ];
}
