import {
  type ConversationId,
  defineExtension,
  GenerationTask,
  type HookApi,
  hook,
} from "@earendil-works/pi-durable";

/** A callback run just before durable applies the final queue boundary. */
export type McpQueueMerger = () => void | Promise<void>;

const mergers = new Map<ConversationId, McpQueueMerger>();

/** Register the chat service that owns a conversation's queued MCP notices. */
export function registerMcpQueueMerger(
  conversationId: ConversationId,
  merger: McpQueueMerger,
): void {
  mergers.set(conversationId, merger);
}

/** Forget a chat service once its conversation closes. */
export function unregisterMcpQueueMerger(
  conversationId: ConversationId,
  merger: McpQueueMerger,
): void {
  if (mergers.get(conversationId) === merger) mergers.delete(conversationId);
}

async function mergeBeforeBoundary(api: HookApi): Promise<undefined> {
  const merger = mergers.get(api.conversationId);
  if (merger !== undefined) await merger();
  return undefined;
}

/**
 * pi-durable's final boundary places one follow-up at a time. This hook runs
 * immediately before that boundary, so the owner can collapse the consecutive
 * MCP notice entries the boundary is about to hand to the model.
 */
export function createMcpQueueMergeExtension() {
  return defineExtension({
    name: "pi-ui-mcp-queue-merge",
    hooks: [
      hook(GenerationTask, {
        onYield: (_answer, api) => mergeBeforeBoundary(api),
      }),
    ],
  });
}
