import {
  type ConversationId,
  defineExtension,
  GenerationTask,
  type HookApi,
  hook,
} from "@earendil-works/pi-durable";

export type McpQueueMerger = () => void | Promise<void>;

const mergers = new Map<ConversationId, McpQueueMerger>();

export function registerMcpQueueMerger(
  conversationId: ConversationId,
  merger: McpQueueMerger,
): void {
  mergers.set(conversationId, merger);
}

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
