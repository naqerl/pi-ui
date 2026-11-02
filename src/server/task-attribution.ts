import type { Registry, ToolRegistration } from "@earendil-works/pi-durable";

/**
 * The argument older clients used to tag a call with a task id. Tools no longer advertise it;
 * the execution path still strips it so a replayed transcript or an old client is accepted.
 */
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

/** Warn once when a call still carries the legacy argument, wherever it is first observed. */
export function noteLegacyTaskId(args: unknown): void {
  if (hasTaskId(args)) warnIgnoredTaskId();
}

/**
 * Keep accepting the old `piuiTaskId` argument without advertising it. It is removed before the
 * tool's own argument repair and before validation, so a strict schema still accepts the call;
 * the tool itself never sees it. The warning is emitted once per conversation.
 */
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

/**
 * Make every extension installed through `registry` from now on tolerant of the legacy
 * argument: built-in, task, MCP and any other tools strip it without exposing it in their
 * schema. Attribution itself follows the single task marked working, not this argument.
 */
export function attributeTools<T extends Registry<ToolRegistration>>(registry: T): T {
  const install = registry.install.bind(registry);
  registry.install = ((extension: Parameters<typeof install>[0]) =>
    install({
      ...extension,
      ...(extension.tools === undefined ? {} : { tools: extension.tools.map(withTaskParam) }),
    })) as typeof registry.install;
  return registry;
}
