import type { ToolRegistration } from "@earendil-works/pi-durable";
import { createReadTool } from "@earendil-works/pi-durable/tools";
import { isBotToolName } from "./bot-defaults.js";
import { createTaskTools, type TaskBridge } from "./task-tools.js";

export function botTools(bridge: TaskBridge): ToolRegistration[] {
  return [createReadTool(), ...createTaskTools(bridge)].filter((tool) => isBotToolName(tool.name));
}
