import type { Registry, ToolRegistration } from "@earendil-works/pi-durable";

export const TASK_ID_PARAM = "piuiTaskId";

const WARNING = "[tasks] ignoring piuiTaskId; attribution follows the working task";

let warned = false;

function warnIgnoredTaskId(): void {
  if (warned) return;
  warned = true;
  console.warn(WARNING);
}

function hasTaskId(args: unknown): boolean {
  return typeof args === "object" && args !== null && !Array.isArray(args) && TASK_ID_PARAM in args;
}

function withoutTaskId(args: unknown): unknown {
  if (!hasTaskId(args)) return args;
  const { [TASK_ID_PARAM]: _tag, ...rest } = args as Record<string, unknown>;
  return rest;
}

export function noteLegacyTaskId(args: unknown): void {
  if (hasTaskId(args)) warnIgnoredTaskId();
}

export function withTaskParam(tool: ToolRegistration): ToolRegistration {
  const prepare = tool.prepareArguments?.bind(tool);
  return {
    ...tool,
    prepareArguments(args: unknown) {
      noteLegacyTaskId(args);
      const rest = withoutTaskId(args);
      return prepare === undefined ? rest : prepare(rest);
    },
    execute(args, api, context) {
      noteLegacyTaskId(args);
      return tool.execute(withoutTaskId(args) as typeof args, api, context);
    },
  };
}

export function attributeTools<T extends Registry<ToolRegistration>>(registry: T): T {
  const install = registry.install.bind(registry);
  registry.install = ((extension: Parameters<typeof install>[0]) =>
    install({
      ...extension,
      ...(extension.tools === undefined ? {} : { tools: extension.tools.map(withTaskParam) }),
    })) as typeof registry.install;
  return registry;
}
