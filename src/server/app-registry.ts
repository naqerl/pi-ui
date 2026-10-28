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
import { startWebTools, type WebToolsBridge } from "./web-tools.js";

export interface AppRegistryBoot {
  readonly registry: Registry<ToolRegistration>;
  readonly webTools: WebToolsBridge | undefined;
  readonly biliTools: readonly string[];
}

export interface AppRegistryOptions {
  readonly bili?: BillionContextInline;
}

/**
 * The registry the server boots with. Web tools arrive over MCP and stay deferred;
 * `tool_search` is installed alongside them so loading a tool can expose it later.
 */
export async function createAppRegistry(
  options: AppRegistryOptions = {},
): Promise<AppRegistryBoot> {
  const registry = createRegistry();
  registry.install(
    defineExtension({
      name: "pi-ui-coding-tools",
      tools: createCodingTools().tools ?? [],
    }),
  );

  const webTools = await startWebTools();
  const usableWebTools = webTools !== undefined && webTools.tools.length > 0 ? webTools : undefined;
  if (webTools !== undefined && usableWebTools === undefined) {
    await webTools.close();
  }

  if (usableWebTools !== undefined) {
    registry.install(
      defineExtension({
        name: "pi-ui-web-tools",
        tools: usableWebTools.tools,
      }),
    );
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
    webTools: usableWebTools,
    biliTools: biliTools.map((tool) => tool.name),
  };
}
