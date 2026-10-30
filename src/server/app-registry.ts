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
import type { DashboardManager } from "./dashboard.js";
import { createDashboardTools } from "./dashboard-tools.js";
import { createJobTools } from "./job-tools.js";
import type { JobManager } from "./jobs.js";
import { type McpRuntime, startMcpRuntime } from "./mcp-runtime.js";
import type { SnapshotCache } from "./memory/snapshot.js";
import type { MemoryStore } from "./memory/store.js";
import { createMemoryTools } from "./memory/tools.js";
import { createTaskTools, type TaskBridge } from "./task-tools.js";

export interface AppRegistryBoot {
  readonly registry: Registry<ToolRegistration>;
  readonly mcp: McpRuntime;
  readonly biliTools: readonly string[];
  readonly taskTools: readonly string[];
  readonly jobTools: readonly string[];
  readonly dashboardTools: readonly string[];
  readonly memoryTools: readonly string[];
}

export interface AppRegistryOptions {
  readonly bili?: BillionContextInline;
  readonly tasks: TaskBridge;
  /** Background shell jobs. Without it, the job tools are not offered. */
  readonly jobs?: JobManager;
  /** The agent-editable dashboard page. Without it, the dashboard tools are not offered. */
  readonly dashboard?: DashboardManager;
  /** The layered memory tree and its injected-snapshot cache. */
  readonly memory?: { readonly store: MemoryStore; readonly snapshot?: SnapshotCache };
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

  const jobTools = options.jobs === undefined ? [] : createJobTools(options.jobs);
  if (jobTools.length > 0) {
    registry.install(defineExtension({ name: "pi-ui-job-tools", tools: jobTools }));
  }

  const dashboardTools =
    options.dashboard === undefined ? [] : createDashboardTools(options.dashboard);
  if (dashboardTools.length > 0) {
    registry.install(defineExtension({ name: "pi-ui-dashboard-tools", tools: dashboardTools }));
  }

  const memoryTools =
    options.memory === undefined
      ? []
      : createMemoryTools(options.memory.store, options.memory.snapshot);
  if (memoryTools.length > 0) {
    registry.install(defineExtension({ name: "pi-ui-memory-tools", tools: memoryTools }));
  }

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
    jobTools: jobTools.map((tool) => tool.name),
    dashboardTools: dashboardTools.map((tool) => tool.name),
    memoryTools: memoryTools.map((tool) => tool.name),
  };
}
