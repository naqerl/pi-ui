import {
  createRegistry,
  defineExtension,
  type Registry,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { createToolSearchExtension } from "@earendil-works/pi-durable/tool-search";
import { createCodingTools } from "@earendil-works/pi-durable/tools";
import { startWebTools, type WebToolsBridge } from "./web-tools.js";

export interface AppRegistryBoot {
  readonly registry: Registry<ToolRegistration>;
  readonly webTools: WebToolsBridge | undefined;
}

/**
 * The registry the server boots with. Web tools arrive over MCP and stay deferred;
 * `tool_search` is installed alongside them so loading a tool can expose it later.
 */
export async function createAppRegistry(): Promise<AppRegistryBoot> {
  const registry = createRegistry();
  registry.install(
    defineExtension({
      name: "pi-ui-coding-tools",
      tools: createCodingTools().tools ?? [],
    }),
  );

  const webTools = await startWebTools();
  if (webTools === undefined) {
    return { registry, webTools: undefined };
  }
  if (webTools.tools.length === 0) {
    await webTools.close();
    return { registry, webTools: undefined };
  }

  registry.install(
    defineExtension({
      name: "pi-ui-web-tools",
      tools: webTools.tools,
    }),
  );
  registry.install(createToolSearchExtension());
  return { registry, webTools };
}
