import {
  defineTool,
  type ToolExecutionResult,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import type { BillionContextInline } from "./billion-context.js";
import { jsonSchemaToTypeBox } from "./json-schema.js";

/**
 * Expose billion-context's compression tools only when the in-process engine
 * answers the manifest endpoint. Missing or unreachable engines leave the
 * coding/web tool registry exactly as it was.
 */
export async function createBiliTools(
  bili: BillionContextInline | undefined,
): Promise<readonly ToolRegistration[]> {
  if (bili === undefined || !bili.enabled) return [];

  const tools = await bili.manifest();
  if (tools === undefined) return [];

  return tools.map((tool) =>
    defineTool({
      name: tool.name,
      description: tool.description ?? `Run the billion-context ${tool.name} tool.`,
      parameters: jsonSchemaToTypeBox(tool.inputSchema),
      async execute(args, api): Promise<ToolExecutionResult> {
        const conversationId = String(api.conversationId ?? bili.currentConversationId() ?? "");
        if (conversationId.length === 0) {
          return {
            output: [{ type: "text", text: "billion-context: no conversation id" }],
            isError: true,
          };
        }
        try {
          const result = await bili.callTool(conversationId, tool.name, args);
          return {
            output: [{ type: "text", text: result.text }],
            isError: result.failed,
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return {
            output: [{ type: "text", text: `billion-context tool error: ${message}` }],
            isError: true,
          };
        }
      },
    }),
  );
}
