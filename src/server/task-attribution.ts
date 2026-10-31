import type { Registry, ToolRegistration } from "@earendil-works/pi-durable";

/** The optional argument every tool takes so a call can say which task it works on. */
export const TASK_ID_PARAM = "piuiTaskId";

export const TASK_ID_DESCRIPTION =
  "Internal pi-ui task id. Set it to the id of the task this call works on; omit for work not part of a task.";

type ObjectSchema = {
  type: "object";
  properties?: Record<string, unknown>;
  required?: string[];
};

function isObjectSchema(schema: unknown): schema is ObjectSchema {
  return (
    typeof schema === "object" &&
    schema !== null &&
    (schema as { type?: unknown }).type === "object"
  );
}

function split(args: unknown): { taskId: string | undefined; rest: unknown } {
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return { taskId: undefined, rest: args };
  }
  const { [TASK_ID_PARAM]: taskId, ...rest } = args as Record<string, unknown>;
  return { taskId: typeof taskId === "string" ? taskId : undefined, rest };
}

/** The task id a call was tagged with, or undefined. Blank ids count as untagged. */
export function taggedTaskId(args: unknown): string | undefined {
  const id = split(args).taskId?.trim();
  return id === undefined || id.length === 0 ? undefined : id;
}

/**
 * Add the optional `piuiTaskId` argument to a tool and strip it again before the tool runs,
 * so the tool itself never sees it. The tagged call stays in the transcript, which is where
 * the chat service reads it. Tools whose arguments are not an object are left alone.
 */
export function withTaskParam(tool: ToolRegistration): ToolRegistration {
  const schema: unknown = tool.parameters;
  if (!isObjectSchema(schema)) return tool;
  if (schema.properties !== undefined && TASK_ID_PARAM in schema.properties) return tool;
  const parameters = {
    ...schema,
    properties: {
      ...(schema.properties ?? {}),
      [TASK_ID_PARAM]: { type: "string", description: TASK_ID_DESCRIPTION },
    },
  } as unknown as ToolRegistration["parameters"];
  const prepare = tool.prepareArguments?.bind(tool);
  return {
    ...tool,
    parameters,
    ...(prepare === undefined
      ? {}
      : {
          prepareArguments(args: unknown) {
            const { taskId, rest } = split(args);
            const prepared = prepare(rest);
            if (taskId === undefined || typeof prepared !== "object" || prepared === null) {
              return prepared;
            }
            return { ...(prepared as Record<string, unknown>), [TASK_ID_PARAM]: taskId };
          },
        }),
    execute(args, api, context) {
      return tool.execute(split(args).rest as typeof args, api, context);
    },
  };
}

/**
 * Make every extension installed through `registry` from now on tag-aware: built-in, task,
 * MCP and any other tools all get the same optional argument without knowing about it.
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
