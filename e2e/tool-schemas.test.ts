import assert from "node:assert/strict";
import { test } from "node:test";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import { createCodingTools } from "@earendil-works/pi-durable/tools";
import { createDashboardTools } from "../src/server/dashboard-tools.js";
import { createAcpDelegateTools } from "../src/server/delegate-tools.js";
import { createDiagramTools } from "../src/server/diagram-tools.js";
import { createJobTools } from "../src/server/job-tools.js";
import { createMemoryTools } from "../src/server/memory/tools.js";
import { createOperatorTools } from "../src/server/operator-tools.js";
import { createTaskTools } from "../src/server/task-tools.js";

type JsonSchema = Record<string, unknown>;

export interface ProviderSchemaRule {
  readonly name: string;
  readonly message: string;
  /** Returns true when the rule rejects this schema node. */
  readonly matches: (node: JsonSchema, root: JsonSchema) => boolean;
}

function resolveJsonPointer(root: JsonSchema, ref: string): unknown {
  if (!ref.startsWith("#")) return undefined;
  const pointer = ref.slice(1);
  if (pointer === "") return root;
  if (!pointer.startsWith("/")) return undefined;

  let node: unknown = root;
  for (const raw of pointer.slice(1).split("/")) {
    let key: string;
    try {
      key = decodeURIComponent(raw);
    } catch {
      return undefined;
    }
    key = key.replace(/~1/g, "/").replace(/~0/g, "~");
    if (typeof node !== "object" || node === null || !Object.hasOwn(node, key)) return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return node;
}

export const PROVIDER_SCHEMA_RULES: readonly ProviderSchemaRule[] = [
  {
    // OpenAI function schemas accept one item schema; Type.Tuple serialises the array form.
    name: "items-array",
    message:
      "`items` must be one schema, not a tuple array (use Type.Array with minItems/maxItems)",
    matches: (node) => Array.isArray(node.items),
  },
  {
    // OpenAI rejects `items: false` because an array must declare an item schema.
    name: "items-false",
    message: "`items: false` is not accepted by the model provider",
    matches: (node) => node.items === false,
  },
  {
    // OpenAI resolves refs only inside the submitted document; external refs are refused.
    name: "unresolved-ref",
    message: "`$ref` does not resolve inside this schema document",
    matches: (node, root) =>
      typeof node.$ref === "string" && resolveJsonPointer(root, node.$ref) === undefined,
  },
  {
    // OpenAI wants a nullable union as anyOf: [..., {type: "null"}], not type: [..., "null"].
    name: "nullable-type-array",
    message: '`type` must not be an array containing "null" (use anyOf with {"type":"null"})',
    matches: (node) => Array.isArray(node.type) && node.type.includes("null"),
  },
];

function findSchemaViolations(toolName: string, schema: JsonSchema): string[] {
  const violations: string[] = [];
  const visit = (node: unknown, path: string): void => {
    if (Array.isArray(node)) {
      for (const [index, child] of node.entries()) visit(child, `${path}[${index}]`);
      return;
    }
    if (typeof node !== "object" || node === null) return;

    const record = node as JsonSchema;
    for (const rule of PROVIDER_SCHEMA_RULES) {
      if (rule.matches(record, schema)) violations.push(`${toolName} at ${path}: ${rule.message}`);
    }
    for (const [key, value] of Object.entries(record)) visit(value, `${path}.${key}`);
  };
  visit(schema, "$");
  return violations;
}

/** The static tools app-registry installs; MCP tools are discovered per deployment. */
function collectAgentTools(): ToolRegistration[] {
  const unused = {} as never;
  return [
    ...(createCodingTools().tools ?? []),
    ...createTaskTools(unused),
    ...createJobTools(unused),
    ...createAcpDelegateTools(unused, 0),
    ...createDashboardTools(unused),
    ...createDiagramTools(unused),
    ...createOperatorTools(unused),
    ...createMemoryTools(unused),
  ];
}

const REQUIRED_APP_TOOLS = [
  "read",
  "write",
  "edit",
  "bash",
  "task_list",
  "task_proposals",
  "task_view",
  "task_done",
  "task_working",
  "task_edit",
  "propose_task",
  "task_block",
  "job_start",
  "job_list",
  "job_output",
  "job_cancel",
  "acp_delegate",
  "acp_delegate_wait",
  "acp_delegate_cancel",
  "dashboard_get",
  "dashboard_upsert",
  "dashboard_remove",
  "dashboard_push",
  "dashboard_layout",
  "draw_diagram",
  "replace_diagram",
  "notify_operator",
  "memory_write",
  "memory_read",
  "memory_grep",
  "memory_find",
  "memory_dream",
  "memory_status",
] as const;

test("every agent tool schema is provider-safe", () => {
  const tools = collectAgentTools();
  const names = new Set(tools.map((tool) => tool.name));

  for (const name of REQUIRED_APP_TOOLS) {
    assert.ok(names.has(name), `the collected registry is missing ${name}`);
  }

  for (const tool of tools) {
    const schema = tool.parameters as unknown as JsonSchema;
    assert.equal(
      schema.type,
      "object",
      `${tool.name}: the top-level parameters schema must have type "object"`,
    );

    const violations = findSchemaViolations(tool.name, schema);
    assert.deepEqual(
      violations,
      [],
      `${tool.name}: the model provider would reject this schema:\n${violations.join("\n")}`,
    );
  }
});
