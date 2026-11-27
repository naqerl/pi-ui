import type { ToolRegistration } from "@earendil-works/pi-durable";
import { createReadTool } from "@earendil-works/pi-durable/tools";
import { isBotToolName } from "./bot-defaults.js";
import { createTaskTools, type TaskBridge } from "./task-tools.js";

/**
 * The whole bot catalog, in declaration order. `createTaskTools` already returns
 * `propose_task`, so only the read tool is added here; the test pins the composed
 * names to the catalog so a second copy cannot creep back in.
 */
export function botTools(bridge: TaskBridge): ToolRegistration[] {
  return [createReadTool(), ...createTaskTools(bridge)].filter((tool) =>
    isBotToolName(tool.name),
  );
}
