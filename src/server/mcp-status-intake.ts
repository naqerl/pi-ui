import { MCP_STATUS_HEAD } from "../shared/notices.js";
import type { McpEventFeed, StatusGate } from "./mcp-events.js";

/**
 * The one status gate used by the server intake, before the outbox or chat can
 * see the text. Non-status MCP notices pass through as a delivery.
 */
export function acceptMcpStatusNotice(
  feed: McpEventFeed,
  text: string,
  details?: unknown,
  customType?: string,
): StatusGate {
  if (!text.startsWith(MCP_STATUS_HEAD)) return { text, mode: "deliver" };
  return feed.filterStatusNotice(text, details, customType);
}
