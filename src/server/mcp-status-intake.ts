import { MCP_STATUS_HEAD } from "../shared/notices.js";
import type { McpEventFeed } from "./mcp-events.js";

/**
 * The one status gate used by the server intake, before the outbox or chat can
 * see the text. Non-status MCP notices pass through untouched.
 */
export function acceptMcpStatusNotice(
  feed: McpEventFeed,
  text: string,
  details?: unknown,
  customType?: string,
): string | null {
  if (!text.startsWith(MCP_STATUS_HEAD)) return text;
  return feed.filterStatusNotice(text, details, customType);
}
