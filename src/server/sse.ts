import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { ChatMessage, StreamToolStart, ToolActivity } from "../shared/types.js";

export interface SseFrame {
  event: string;
  data: unknown;
}

export interface FrameExtras {
  assistantMessage?: ChatMessage | null;
  toolActivity?: ToolActivity;
}

/**
 * The single translation point from pi SDK session events to the browser's SSE protocol.
 */
export function mapSessionEvent(event: AgentSessionEvent, extras: FrameExtras = {}): SseFrame[] {
  switch (event.type) {
    case "message_update": {
      const update = event.assistantMessageEvent;
      if (update.type === "text_delta") {
        return [{ event: "message.delta", data: { text: update.delta } }];
      }
      if (update.type === "thinking_delta") {
        return [{ event: "thinking.delta", data: { text: update.delta } }];
      }
      return [];
    }
    case "message_end":
      return [
        {
          event: "message.done",
          data: { message: extras.assistantMessage ?? null },
        },
      ];
    case "tool_execution_start": {
      const data: StreamToolStart = {
        toolCallId: event.toolCallId,
        name: event.toolName,
        arguments: event.args,
        timestamp: new Date().toISOString(),
      };
      return [{ event: "tool.start", data }];
    }
    case "tool_execution_end": {
      const activity =
        extras.toolActivity ??
        ({
          kind: "tool",
          id: `local-${event.toolCallId}`,
          name: event.toolName,
          arguments: "{}",
          isError: event.isError,
          durationMs: event.durationMs,
          timestamp: new Date().toISOString(),
          order: Number.MAX_SAFE_INTEGER,
        } satisfies ToolActivity);
      return [
        {
          event: "tool.end",
          data: {
            toolCallId: event.toolCallId,
            name: event.toolName,
            isError: event.isError,
            durationMs: event.durationMs,
            timestamp: activity.timestamp,
            activity,
          },
        },
      ];
    }
    default:
      return [];
  }
}
