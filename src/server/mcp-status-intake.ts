import { MCP_STATUS_HEAD } from "../shared/notices.js";
import type { McpEventFeed, StatusGate } from "./mcp-events.js";

export function acceptMcpStatusNotice(
  feed: McpEventFeed,
  text: string,
  details?: unknown,
  customType?: string,
): StatusGate {
  if (!text.startsWith(MCP_STATUS_HEAD)) return { text, mode: "deliver" };
  return feed.filterStatusNotice(text, details, customType);
}
