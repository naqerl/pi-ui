import {
  createRegistry,
  defineExtension,
  type Registry,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { createToolSearchExtension } from "@earendil-works/pi-durable/tool-search";
import {
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
} from "@earendil-works/pi-durable/tools";
import { createTimedBashTool } from "./bash-tool.js";
import { createBiliTools } from "./bili-tools.js";
import type { BillionContextInline } from "./billion-context.js";
import type { DashboardManager } from "./dashboard.js";
import { createDashboardTools } from "./dashboard-tools.js";
import { createAcpDelegateTools } from "./delegate-tools.js";
import type { DelegateManager } from "./delegates.js";
import { createDiagramTools, type DiagramBridge } from "./diagram-tools.js";
import { createJobTools } from "./job-tools.js";
import type { JobManager } from "./jobs.js";
import { createMcpQueueMergeExtension } from "./mcp-queue-merge.js";
import { type McpRuntime, startMcpRuntime } from "./mcp-runtime.js";
import type { SnapshotCache } from "./memory/snapshot.js";
import type { MemoryStore } from "./memory/store.js";
import { createMemoryTools, type MemoryWriteRecord } from "./memory/tools.js";
import type { ModelCatalogReload } from "./models.js";
import { createOperatorTools, type OperatorBridge } from "./operator-tools.js";
import { createReloadTool } from "./reload-tools.js";
import { attributeTools } from "./task-attribution.js";
import { createTaskTools, type TaskBridge } from "./task-tools.js";

export interface AppRegistryBoot {
  readonly registry: Registry<ToolRegistration>;
  readonly mcp: McpRuntime;
  readonly biliTools: readonly string[];
  readonly taskTools: readonly string[];
  readonly jobTools: readonly string[];
  readonly delegateTools: readonly string[];
  readonly dashboardTools: readonly string[];
  readonly memoryTools: readonly string[];
  readonly diagramTools: readonly string[];
  readonly operatorTools: readonly string[];
  readonly reloadTools: readonly string[];
}

export interface AppRegistryOptions {
  readonly dataDir?: string;
  readonly bili?: BillionContextInline;
  readonly tasks: TaskBridge;
  readonly jobs?: JobManager;
  readonly delegates?: DelegateManager;
  readonly dashboard?: DashboardManager;
  readonly memory?: {
    readonly store: MemoryStore;
    readonly snapshot?: SnapshotCache;
    readonly onWrite?: (record: MemoryWriteRecord) => void | Promise<void>;
  };
  readonly diagrams?: DiagramBridge;
  readonly operator?: OperatorBridge;
  readonly reload?: {
    readonly prompt?: () => Promise<{ readonly instructions: string; readonly changed: boolean }>;
    readonly models?: () => Promise<ModelCatalogReload>;
  };
}

export async function createAppRegistry(options: AppRegistryOptions): Promise<AppRegistryBoot> {
  const registry = attributeTools(createRegistry());
  const taskTools = createTaskTools(options.tasks);
  registry.install(
    defineExtension({
      name: "pi-ui-coding-tools",
      tools: [
        createReadTool(),
        createWriteTool(),
        createEditTool(),
        options.jobs === undefined ? createBashTool() : createTimedBashTool(options.jobs),
      ],
    }),
  );
  registry.install(
    defineExtension({
      name: "pi-ui-task-tools",
      tools: taskTools,
    }),
  );
  registry.install(createMcpQueueMergeExtension());

  const jobTools = options.jobs === undefined ? [] : createJobTools(options.jobs);
  if (jobTools.length > 0) {
    registry.install(defineExtension({ name: "pi-ui-job-tools", tools: jobTools }));
  }

  const delegateTools =
    options.delegates === undefined ? [] : createAcpDelegateTools(options.delegates);
  if (delegateTools.length > 0) {
    registry.install(defineExtension({ name: "pi-ui-delegate-tools", tools: delegateTools }));
  }

  const dashboardTools =
    options.dashboard === undefined ? [] : createDashboardTools(options.dashboard);
  if (dashboardTools.length > 0) {
    registry.install(defineExtension({ name: "pi-ui-dashboard-tools", tools: dashboardTools }));
  }

  const memoryTools =
    options.memory === undefined
      ? []
      : createMemoryTools(options.memory.store, options.memory.snapshot, {
          ...(options.memory.onWrite === undefined ? {} : { onWrite: options.memory.onWrite }),
        });
  if (memoryTools.length > 0) {
    registry.install(defineExtension({ name: "pi-ui-memory-tools", tools: memoryTools }));
  }

  const diagramTools = options.diagrams === undefined ? [] : createDiagramTools(options.diagrams);
  if (diagramTools.length > 0) {
    registry.install(defineExtension({ name: "pi-ui-diagram-tools", tools: diagramTools }));
  }

  const operatorTools = options.operator === undefined ? [] : createOperatorTools(options.operator);
  if (operatorTools.length > 0) {
    registry.install(defineExtension({ name: "pi-ui-operator-tools", tools: operatorTools }));
  }

  const mcp = await startMcpRuntime(
    options.dataDir === undefined ? {} : { dataDir: options.dataDir },
  );
  mcp.install(registry);
  registry.install(createToolSearchExtension());

  const reloadTool = createReloadTool({
    mcp: async () => {
      const result = await mcp.reload("mcp");
      return {
        ok: result.ok,
        details: {
          added: result.added,
          removed: result.removed,
          changed: result.changed,
          unchanged: result.unchanged,
          ...(result.subscriptions === undefined ? {} : { subscriptions: result.subscriptions }),
        },
        errors: [...result.errors],
      };
    },
    subscriptions: async () => {
      const result = await mcp.reload("subscriptions");
      return {
        ok: result.ok,
        details: { ...(result.subscriptions ?? {}) },
        errors: [...result.errors],
      };
    },
    ...(options.reload?.prompt === undefined
      ? {}
      : {
          prompt: async () => {
            const result = await options.reload?.prompt?.();
            if (result === undefined) {
              return { ok: false, details: {}, errors: ["reload prompt is not available"] };
            }
            return {
              ok: true,
              details: { changed: result.changed, chars: result.instructions.length },
            };
          },
        }),
    ...(options.reload?.models === undefined
      ? {}
      : {
          models: async () => {
            const result = await options.reload?.models?.();
            if (result === undefined) {
              return { ok: false, details: {}, errors: ["reload models is not available"] };
            }
            return {
              ok: result.errors.length === 0,
              details: {
                total: result.models.length,
                added: result.added,
                removed: result.removed,
                models: result.models,
              },
              errors: [...result.errors],
            };
          },
        }),
  });
  registry.install(defineExtension({ name: "pi-ui-reload-tools", tools: [reloadTool] }));

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
    delegateTools: delegateTools.map((tool) => tool.name),
    dashboardTools: dashboardTools.map((tool) => tool.name),
    memoryTools: memoryTools.map((tool) => tool.name),
    diagramTools: diagramTools.map((tool) => tool.name),
    operatorTools: operatorTools.map((tool) => tool.name),
    reloadTools: [reloadTool.name],
  };
}
