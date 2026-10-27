import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { type TSchema, Type } from "@earendil-works/pi-ai";
import {
  defineTool,
  type ToolExecutionResult,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import {
  type CallToolResult,
  McpClient,
  type Tool as McpTool,
  StdioTransport,
  toLlmContent,
} from "@earendil-works/pi-mcp";

const TOOL_PREFIX = "mcp__web__";
const INITIAL_RESTART_DELAY_MS = 500;
const MAX_RESTART_DELAY_MS = 30_000;
const STABLE_CONNECTION_MS = 30_000;
const CLIENT_NAME = "pi-ui";
const CLIENT_VERSION = "1.1.0";

const STARTING_RESULT: ToolExecutionResult = {
  output: [{ type: "text", text: "web tools are starting" }],
  isError: true,
};

type JsonSchema = Record<string, unknown>;

/** Resolve the pi-web-access MCP entry point without assuming where the server was started. */
function resolveMcpCommand(): { command: string; args: string[] } {
  const require = createRequire(import.meta.url);
  try {
    const packageJson = require.resolve("pi-web-access/package.json");
    const cli = join(dirname(packageJson), "dist", "mcp-cli.js");
    if (existsSync(cli)) return { command: process.execPath, args: [cli] };
  } catch {
    // Fall through to the package-manager shim below.
  }

  const shim = resolve(process.cwd(), "node_modules", ".bin", "pi-web-access-mcp");
  if (existsSync(shim)) return { command: shim, args: [] };

  throw new Error("pi-web-access-mcp was not found");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const warnedShapes = new Set<string>();

function unknownSchema(schema: unknown, reason: string): TSchema {
  if (!warnedShapes.has(reason)) {
    warnedShapes.add(reason);
    console.warn(`[pi] web tool schema: ${reason}; treating it as unknown`);
  }
  return Type.Unknown(isRecord(schema) ? schemaOptions(schema) : {});
}

/** Keywords TypeBox can carry straight through to the model. `format` is deliberately dropped. */
function schemaOptions(schema: JsonSchema): Record<string, unknown> {
  const options: Record<string, unknown> = {};
  for (const key of [
    "title",
    "description",
    "default",
    "examples",
    "deprecated",
    "readOnly",
    "writeOnly",
  ]) {
    if (schema[key] !== undefined) options[key] = schema[key];
  }
  return options;
}

function copyNumberOptions(schema: JsonSchema, options: Record<string, unknown>): void {
  for (const key of ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"]) {
    if (typeof schema[key] === "number") options[key] = schema[key];
  }
}

function copyStringOptions(schema: JsonSchema, options: Record<string, unknown>): boolean {
  if (schema.enum !== undefined) {
    if (!Array.isArray(schema.enum) || !schema.enum.every((value) => typeof value === "string")) {
      return false;
    }
    options.enum = [...schema.enum];
  }
  for (const key of ["minLength", "maxLength"]) {
    if (typeof schema[key] === "number") options[key] = schema[key];
  }
  if (typeof schema.pattern === "string") options.pattern = schema.pattern;
  return true;
}

function copyArrayOptions(schema: JsonSchema, options: Record<string, unknown>): void {
  for (const key of ["minItems", "maxItems", "uniqueItems"]) {
    if (typeof schema[key] === "number" || typeof schema[key] === "boolean") {
      options[key] = schema[key];
    }
  }
}

/**
 * Convert the JSON Schema from `tools/list` to TypeBox. The bridge only needs the shapes
 * the web server emits; anything else becomes `Unknown` so one odd tool never stops boot.
 */
export function jsonSchemaToTypeBox(schema: unknown): TSchema {
  if (!isRecord(schema)) return unknownSchema(schema, "schema is not an object");

  const options = schemaOptions(schema);

  if (Array.isArray(schema.anyOf)) {
    if (schema.anyOf.length === 0) return unknownSchema(schema, "empty anyOf");
    return Type.Union(
      schema.anyOf.map((variant) => jsonSchemaToTypeBox(variant)) as [TSchema, ...TSchema[]],
      options,
    );
  }

  if (schema.type === "object" || (schema.type === undefined && schema.properties !== undefined)) {
    if (schema.properties !== undefined && !isRecord(schema.properties)) {
      return unknownSchema(schema, "object properties are not an object");
    }
    const required = new Set(
      Array.isArray(schema.required)
        ? schema.required.filter((name): name is string => typeof name === "string")
        : [],
    );
    const properties: Record<string, TSchema> = {};
    for (const [name, property] of Object.entries(schema.properties ?? {})) {
      const converted = jsonSchemaToTypeBox(property);
      properties[name] = required.has(name) ? converted : Type.Optional(converted);
    }
    return Type.Object(properties, options);
  }

  switch (schema.type) {
    case "string": {
      const stringOptions = { ...options };
      if (!copyStringOptions(schema, stringOptions)) {
        return unknownSchema(schema, "string enum contains a non-string value");
      }
      return Type.String(stringOptions);
    }
    case "number": {
      const numberOptions = { ...options };
      copyNumberOptions(schema, numberOptions);
      return Type.Number(numberOptions);
    }
    case "integer": {
      const integerOptions = { ...options };
      copyNumberOptions(schema, integerOptions);
      return Type.Integer(integerOptions);
    }
    case "boolean":
      return Type.Boolean(options);
    case "array": {
      if (schema.items === undefined) return unknownSchema(schema, "array has no items");
      const arrayOptions = { ...options };
      copyArrayOptions(schema, arrayOptions);
      return Type.Array(jsonSchemaToTypeBox(schema.items), arrayOptions);
    }
    case "null":
      return Type.Null(options);
    default:
      return unknownSchema(schema, `unsupported schema type ${JSON.stringify(schema.type)}`);
  }
}

function createRegistration(tool: McpTool, bridge: WebToolsBridge): ToolRegistration {
  return defineTool({
    name: `${TOOL_PREFIX}${tool.name}`,
    description: tool.description ?? `Run the ${tool.name} web tool.`,
    parameters: jsonSchemaToTypeBox(tool.inputSchema),
    deferred: true,
    callers: ["tools"],
    async execute(args): Promise<ToolExecutionResult> {
      return bridge.call(tool.name, args as Record<string, unknown>);
    },
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Owns the one pi-web-access MCP process. Tools call the current client; a child that
 * exits is replaced on a timer, and calls made while it is gone get a normal error result
 * instead of rejecting the model turn.
 */
export class WebToolsBridge {
  private readonly registrations: ToolRegistration[] = [];
  private client: McpClient | undefined;
  private openingClient: McpClient | undefined;
  private childPid: number | undefined;
  private active = false;
  private closed = false;
  private connecting = false;
  private restartTimer: NodeJS.Timeout | undefined;
  private stableTimer: NodeJS.Timeout | undefined;
  private restartDelayMs = INITIAL_RESTART_DELAY_MS;
  private callQueue: Promise<void> = Promise.resolve();

  readonly tools: readonly ToolRegistration[] = this.registrations;

  get pid(): number | undefined {
    return this.childPid;
  }

  get connected(): boolean {
    return this.client?.connectionState === "connected";
  }

  async start(): Promise<boolean> {
    try {
      const tools = await this.connect();
      for (const tool of tools) {
        try {
          this.registrations.push(createRegistration(tool, this));
        } catch (error) {
          console.error(`[pi] could not bridge web tool ${tool.name}`, error);
        }
      }
      this.active = true;
      return true;
    } catch (error) {
      console.error(`[pi] web tools are unavailable: ${errorMessage(error)}`);
      await this.close();
      return false;
    }
  }

  /** Serialize every MCP call: one child, and never more than one request in flight. */
  async call(toolName: string, args: Record<string, unknown>): Promise<ToolExecutionResult> {
    const run = this.callQueue.then(
      () => this.callOnce(toolName, args),
      () => this.callOnce(toolName, args),
    );
    this.callQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run.catch((error) => {
      console.error(`[pi] web tool ${toolName} failed`, error);
      return STARTING_RESULT;
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.active = false;
    this.clearTimers();
    const client = this.client ?? this.openingClient;
    this.client = undefined;
    this.openingClient = undefined;
    this.childPid = undefined;
    await client?.close().catch(() => undefined);
  }

  private async callOnce(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<ToolExecutionResult> {
    const client = this.client;
    if (this.closed || client === undefined || client.connectionState !== "connected") {
      return STARTING_RESULT;
    }

    try {
      const result: CallToolResult = await client.callTool(toolName, args);
      return {
        output: toLlmContent({ content: result.content }),
        isError: result.isError,
      };
    } catch (error) {
      if (this.closed || this.client !== client || client.connectionState !== "connected") {
        return STARTING_RESULT;
      }
      console.error(`[pi] web tool ${toolName} failed`, error);
      return {
        output: [{ type: "text", text: `web tool ${toolName} failed: ${errorMessage(error)}` }],
        isError: true,
      };
    }
  }

  private async connect(): Promise<McpTool[]> {
    const { command, args } = resolveMcpCommand();
    const transport = new StdioTransport({
      command,
      args,
      inheritEnv: true,
      onStderr: (chunk) => {
        const text = chunk.trimEnd();
        if (text.length > 0) console.error(`[pi] web mcp: ${text}`);
      },
    });
    const client = new McpClient({ name: CLIENT_NAME, version: CLIENT_VERSION });

    this.connecting = true;
    this.openingClient = client;
    client.onClose(() => this.handleClose(client));

    try {
      await client.connect(transport);
      this.childPid = transport.pid;
      const tools = await client.listTools();
      this.client = client;
      this.openingClient = undefined;
      this.connecting = false;
      if (this.closed) throw new Error("web tools bridge closed while connecting");
      if (client.connectionState !== "connected") throw new Error("web MCP child disconnected");
      if (!this.active) this.restartDelayMs = INITIAL_RESTART_DELAY_MS;
      this.stableTimer = setTimeout(() => {
        this.restartDelayMs = INITIAL_RESTART_DELAY_MS;
      }, STABLE_CONNECTION_MS);
      this.stableTimer.unref();
      return tools;
    } catch (error) {
      if (this.client === client) this.client = undefined;
      if (this.openingClient === client) this.openingClient = undefined;
      this.childPid = undefined;
      this.connecting = false;
      await client.close().catch(() => undefined);
      throw error;
    }
  }

  private handleClose(client: McpClient): void {
    if (this.closed) return;
    const wasCurrent = this.client === client;
    const wasOpening = this.openingClient === client;
    if (wasCurrent) {
      this.client = undefined;
      this.childPid = undefined;
    }
    if ((wasCurrent || wasOpening) && this.active) this.scheduleRestart();
  }

  private scheduleRestart(): void {
    if (!this.active || this.closed || this.connecting || this.restartTimer !== undefined) return;
    if (this.stableTimer !== undefined) {
      clearTimeout(this.stableTimer);
      this.stableTimer = undefined;
    }
    const delay = this.restartDelayMs;
    this.restartDelayMs = Math.min(this.restartDelayMs * 2, MAX_RESTART_DELAY_MS);
    console.warn(`[pi] web MCP child exited; restarting in ${delay}ms`);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      void this.restart();
    }, delay);
    this.restartTimer.unref();
  }

  private async restart(): Promise<void> {
    if (!this.active || this.closed || this.connecting) return;
    try {
      await this.connect();
      console.warn("[pi] web MCP child restarted");
    } catch (error) {
      console.error(`[pi] web MCP restart failed: ${errorMessage(error)}`);
      this.scheduleRestart();
    }
  }

  private clearTimers(): void {
    if (this.restartTimer !== undefined) {
      clearTimeout(this.restartTimer);
      this.restartTimer = undefined;
    }
    if (this.stableTimer !== undefined) {
      clearTimeout(this.stableTimer);
      this.stableTimer = undefined;
    }
  }
}

/** Start the child once. A child that cannot start leaves the server running without web tools. */
export async function startWebTools(): Promise<WebToolsBridge | undefined> {
  const bridge = new WebToolsBridge();
  if (!(await bridge.start())) return undefined;
  return bridge;
}
