import {
  createRegistry,
  defineExtension,
  type Registry,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { createToolSearchExtension } from "@earendil-works/pi-durable/tool-search";
import { createCodingTools } from "@earendil-works/pi-durable/tools";
import { createBiliTools } from "./bili-tools.js";
import type { BillionContextInline } from "./billion-context.js";
import { type McpRuntime, startMcpRuntime } from "./mcp-runtime.js";
import { createTaskTools, type TaskBridge } from "./task-tools.js";

export interface AppRegistryBoot {
  readonly registry: Registry<ToolRegistration>;
  readonly mcp: McpRuntime;
  readonly biliTools: readonly string[];
  readonly taskTools: readonly string[];
}

export interface AppRegistryOptions {
  readonly bili?: BillionContextInline;
  readonly tasks: TaskBridge;
}

/**
 * The registry the server boots with. MCP tools stay deferred; `tool_search`
 * is installed alongside them so loading a tool can expose it later.
 */
export async function createAppRegistry(options: AppRegistryOptions): Promise<AppRegistryBoot> {
  const registry = createRegistry();
  const taskTools = createTaskTools(options.tasks);
  registry.install(
    defineExtension({
      name: "pi-ui-coding-tools",
      tools: createCodingTools().tools ?? [],
    }),
  );
  registry.install(
    defineExtension({
      name: "pi-ui-task-tools",
      tools: taskTools,
    }),
  );

  const mcp = await startMcpRuntime();
  if (mcp.toolNames.length > 0) {
    mcp.install(registry);
    registry.install(createToolSearchExtension());
  }

  const biliTools = await createBiliTools(options.bili);
  if (biliTools.length > 0) {
    registry.install(
      defineExtension({
        name: "pi-ui-billion-context-tools",
        tools: biliTools,
      }),
    );
  }

  return {
    registry,
    mcp,
    biliTools: biliTools.map((tool) => tool.name),
    taskTools: taskTools.map((tool) => tool.name),
  };
}
