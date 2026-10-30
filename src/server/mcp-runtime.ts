import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import {
  type CallToolResult,
  Client,
  StreamableHTTPClientTransport,
  type Transport,
} from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type { McpServerStatus, McpStatus } from "../shared/types.js";
import {
  type DurableExtensionApi,
  DurableExtensionShim,
  type DurableExtensionSink,
  type DurableExtensionTool,
} from "./durable-extensions.js";

const require = createRequire(import.meta.url);
const ADAPTER_ENTRY = pathToFileURL(require.resolve("@realmikekelly/pi-mcp-adapter")).href;
const ADAPTER_HOST_MANAGED = pathToFileURL(
  require.resolve("@realmikekelly/pi-mcp-adapter/host-managed"),
).href;
const ADAPTER_PROTOCOL = pathToFileURL(
  join(dirname(require.resolve("@realmikekelly/pi-mcp-adapter")), "runtime-protocol.ts"),
).href;
const EVENTS_ENTRY = pathToFileURL(
  require.resolve("@realmikekelly/pi-mcp-events/dist/index.js"),
).href;
const EVENTS_PROTOCOL_ENTRY = pathToFileURL(
  require.resolve("@realmikekelly/pi-mcp-events/dist/protocol.js"),
).href;

const REQUEST_TIMEOUT_MS = 30_000;
const HEADER_COMMAND_TIMEOUT_MS = 10_000;
const HEADER_COMMAND_MAX_BYTES = 1024 * 1024;

interface HostManagedMcpServer {
  createTransport(context: { server: string; signal: AbortSignal }): Transport | Promise<Transport>;
}

interface HostManagedMcpToolCall {
  readonly server: string;
  readonly tool: string;
  readonly toolName: string;
  readonly toolCallId: string;
  readonly connectionId: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly inputSchema: unknown;
  readonly signal: AbortSignal;
  dispatch(): Promise<CallToolResult>;
}

interface HostManagedMcpAdapter {
  ready(): Promise<void>;
  close(): Promise<void>;
  extensionFactory(pi: DurableExtensionApi): void;
}

interface HostManagedModule {
  createHostManagedMcpAdapter(options: {
    servers: Record<string, HostManagedMcpServer>;
    onToolCall(call: HostManagedMcpToolCall): Promise<CallToolResult>;
    requestTimeoutMs?: number;
  }): HostManagedMcpAdapter;
}

interface ProtocolServerConnection {
  readonly status: "connected";
  readonly transport: Transport;
  readonly client: Client;
  activeProtocolOperations: number;
  lastUsedAt: number;
  requestMetadata(): Record<string, unknown> | undefined;
}

interface McpProtocolDefinition {
  readonly namespace: string;
  readonly requests: readonly string[];
  readonly streams: readonly string[];
  readonly notifications: readonly string[];
}

interface McpProtocol {
  connect(server: string): Promise<unknown>;
  dispose(): void;
}

interface AdapterModule {
  readonly MCP_TOOL_APPROVAL_REQUEST_EVENT: string;
  registerMcpProtocol(pi: DurableExtensionApi, definition: McpProtocolDefinition): McpProtocol;
}

interface ProtocolModule {
  readonly MCP_PROTOCOL_EVENT: string;
  registerProtocolBridge(
    pi: DurableExtensionApi,
    resolve: (
      name: string,
    ) => Promise<{ connection: ProtocolServerConnection; signal: AbortSignal }>,
  ): void;
}

interface EventsProtocolModule {
  readonly EVENTS_PROTOCOL: McpProtocolDefinition;
}

interface EventsModule {
  default(pi: DurableExtensionApi): void;
}

interface RawServerEntry {
  readonly command?: unknown;
  readonly args?: unknown;
  readonly env?: unknown;
  readonly cwd?: unknown;
  readonly url?: unknown;
  readonly headers?: unknown;
  readonly inheritEnv?: unknown;
  readonly bearerToken?: unknown;
  readonly bearerTokenEnv?: unknown;
  readonly auth?: unknown;
  readonly disabled?: unknown;
  readonly requestTimeoutMs?: unknown;
}

export interface ServerFailure {
  readonly name: string;
  readonly auth: boolean;
}

interface ProtocolConnection {
  readonly client: Client;
  readonly transport: Transport;
  readonly controller: AbortController;
}

const adapterModule = (await import(ADAPTER_ENTRY)) as AdapterModule;
const hostManagedModule = (await import(ADAPTER_HOST_MANAGED)) as HostManagedModule;
const protocolModule = (await import(ADAPTER_PROTOCOL)) as ProtocolModule;
const eventsModule = (await import(EVENTS_ENTRY)) as EventsModule;
const eventsProtocolModule = (await import(EVENTS_PROTOCOL_ENTRY)) as EventsProtocolModule;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") result[key] = entry;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function interpolateEnv(value: string): string {
  return value.replace(
    /\$\{(\w+)\}|\$env:(\w+)|\{env:(\w+)\}/g,
    (_match, a: string | undefined, b: string | undefined, c: string | undefined) => {
      const name = a ?? b ?? c;
      const replacement = name === undefined ? undefined : process.env[name];
      if (replacement === undefined) {
        throw new Error("Missing environment value");
      }
      return replacement;
    },
  );
}

/** Resolve a credential expression once, at boot. The value never leaves this module. */
function resolveSecret(value: string): string {
  if (value.startsWith("!!")) return interpolateEnv(value.slice(1));
  if (!value.startsWith("!")) return interpolateEnv(value);
  const result = spawnSync(value.slice(1), {
    shell: true,
    encoding: "utf8",
    timeout: HEADER_COMMAND_TIMEOUT_MS,
    maxBuffer: HEADER_COMMAND_MAX_BYTES,
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
  });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error("Header command failed");
  }
  const output = result.stdout.trim();
  if (output.length === 0) throw new Error("Header command returned no value");
  return output;
}

function resolveHeaders(name: string, raw: unknown): Record<string, string> | undefined {
  const record = stringRecord(raw);
  if (record === undefined) return undefined;
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) {
    try {
      headers[key] = resolveSecret(value);
    } catch {
      throw new Error(`MCP server "${name}" header "${key}" could not be resolved`);
    }
  }
  try {
    new Headers(headers);
  } catch {
    throw new Error(`MCP server "${name}" has an invalid header`);
  }
  return headers;
}

function resolveServerEnv(raw: unknown): Record<string, string> | undefined {
  const record = stringRecord(raw);
  if (record === undefined) return undefined;
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [key, interpolateEnv(value)]),
  );
}

function serverEntry(value: unknown): RawServerEntry {
  return isRecord(value) ? value : {};
}

function serverRequestTimeout(name: string, raw: unknown): number {
  const value = serverEntry(raw).requestTimeoutMs;
  if (value === undefined) return REQUEST_TIMEOUT_MS;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`MCP server "${name}" has an invalid requestTimeoutMs`);
  }
  return Math.max(1, Math.floor(value));
}

function buildServerDefinition(name: string, raw: unknown): HostManagedMcpServer {
  const entry = serverEntry(raw);
  const url = typeof entry.url === "string" ? entry.url : undefined;
  if (url !== undefined) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`MCP server "${name}" has an invalid URL`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(`MCP server "${name}" has an unsupported URL`);
    }
    let headers = resolveHeaders(name, entry.headers);
    const bearerToken =
      entry.auth === false
        ? undefined
        : typeof entry.bearerToken === "string"
          ? resolveSecret(entry.bearerToken)
          : typeof entry.bearerTokenEnv === "string"
            ? process.env[entry.bearerTokenEnv]
            : undefined;
    if (bearerToken !== undefined && bearerToken.length > 0) {
      headers ??= {};
      headers.Authorization ??= `Bearer ${bearerToken}`;
    }
    return {
      createTransport() {
        return new StreamableHTTPClientTransport(parsed, {
          ...(headers === undefined ? {} : { requestInit: { headers } }),
        });
      },
    };
  }

  const command = typeof entry.command === "string" ? entry.command : undefined;
  if (command === undefined || command.length === 0) {
    throw new Error(`MCP server "${name}" needs a command or URL`);
  }
  const args = Array.isArray(entry.args)
    ? entry.args.filter((arg): arg is string => typeof arg === "string")
    : [];
  const configuredEnv = resolveServerEnv(entry.env);
  const inheritEnv = entry.inheritEnv !== false;
  const env = inheritEnv ? { ...getDefaultEnvironment(), ...configuredEnv } : { ...configuredEnv };
  const cwd = typeof entry.cwd === "string" ? entry.cwd : undefined;
  return {
    createTransport() {
      return new StdioClientTransport({
        command,
        args,
        env,
        ...(cwd === undefined ? {} : { cwd }),
        stderr: "ignore",
      });
    },
  };
}

function inheritedEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  return env;
}

function webAccessServer(agentDir: string): HostManagedMcpServer | undefined {
  try {
    const packagePath = require.resolve("pi-web-access/package.json");
    const cli = join(dirname(packagePath), "dist", "mcp-cli.js");
    if (!existsSync(cli)) return undefined;
    // The bundled server reads the same provider keys and agent-dir
    // web-search.json as pi, so give it the boot environment explicitly.
    const env = {
      ...getDefaultEnvironment(),
      ...inheritedEnvironment(),
      PI_CODING_AGENT_DIR: agentDir,
    };
    return {
      createTransport() {
        return new StdioClientTransport({
          command: "node",
          args: [cli],
          env,
          stderr: "ignore",
        });
      },
    };
  } catch {
    return undefined;
  }
}

async function readServers(): Promise<{
  servers: Record<string, HostManagedMcpServer>;
  timeouts: Record<string, number>;
  configuredNames: readonly string[];
  failures: ServerFailure[];
}> {
  const agentDir = resolve(
    process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent"),
  );
  const path = resolve(agentDir, "mcp.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? (error as { code?: unknown }).code
        : undefined;
    if (code !== "ENOENT") {
      console.warn(`mcp: could not read ${path}`);
    }
    parsed = undefined;
  }

  const root = isRecord(parsed) ? parsed : undefined;
  const configured =
    (root === undefined ? undefined : isRecord(root.mcpServers) ? root.mcpServers : undefined) ??
    (root === undefined ? undefined : isRecord(root.servers) ? root.servers : undefined) ??
    (root !== undefined && root.mcpServers === undefined && root.servers === undefined
      ? root
      : undefined);

  const servers: Record<string, HostManagedMcpServer> = {};
  const timeouts: Record<string, number> = {};
  const failures: ServerFailure[] = [];
  const names: string[] = [];
  if (configured !== undefined) {
    for (const [name, raw] of Object.entries(configured)) {
      if (name.startsWith("$")) continue;
      const entry = serverEntry(raw);
      if (entry.disabled === true) continue;
      names.push(name);
      try {
        const definition = buildServerDefinition(name, raw);
        servers[name] = definition;
        timeouts[name] = serverRequestTimeout(name, raw);
      } catch (error) {
        failures.push({ name, auth: httpStatus(error) === 401 || httpStatus(error) === 403 });
        console.warn(describeBootFailure(name, error));
      }
    }
  }

  if (configured === undefined || !Object.hasOwn(configured, "web")) {
    const web = webAccessServer(agentDir);
    if (web === undefined) {
      console.warn("mcp: pi-web-access MCP entry was not found");
    } else {
      servers.web = web;
      timeouts.web = REQUEST_TIMEOUT_MS;
      if (!names.includes("web")) names.push("web");
    }
  }

  return { servers, timeouts, configuredNames: names, failures };
}

function httpStatus(error: unknown): number | undefined {
  let current: unknown = error;
  const seen = new Set<unknown>();
  for (let depth = 0; depth < 6 && current !== undefined; depth++) {
    if (typeof current !== "object" || current === null || seen.has(current)) break;
    seen.add(current);
    if ("status" in current && typeof current.status === "number") {
      return current.status;
    }
    current = "cause" in current ? current.cause : undefined;
  }
  return undefined;
}

function credentialsRejected(name: string): string {
  return `server ${name} rejected the configured credentials`;
}

function describeBootFailure(name: string, error: unknown): string {
  const status = httpStatus(error);
  if (status === 401 || status === 403) return `mcp: ${credentialsRejected(name)}`;
  return `mcp: server ${name} is unavailable`;
}

function credentialsResult(name: string): CallToolResult {
  return {
    content: [{ type: "text", text: credentialsRejected(name) }],
    isError: true,
  };
}

function sanitizeServerName(server: string): string {
  return Array.from(server, (char) =>
    /^[A-Za-z0-9_-]$/.test(char) ? char : `_${char.codePointAt(0)?.toString(16) ?? "0"}_`,
  ).join("");
}

function originalToolName(server: string, tool: DurableExtensionTool): string {
  const label = tool.label ?? "";
  if (label.startsWith("MCP: ")) return label.slice(5);
  const prefix = `${sanitizeServerName(server)}_`;
  return tool.name.startsWith(prefix) ? tool.name.slice(prefix.length) : tool.name;
}

function qualifiedTool(server: string, tool: DurableExtensionTool): DurableExtensionTool {
  const original = originalToolName(server, tool).replace(/\./g, "_");
  return {
    ...tool,
    name: `${sanitizeServerName(server)}__${original}`,
    label: `MCP: ${original}`,
  };
}

function credentialAwareTool(server: string, tool: DurableExtensionTool): DurableExtensionTool {
  const execute = tool.execute.bind(tool);
  return {
    ...tool,
    async execute(toolCallId, params, signal) {
      const result = await execute(toolCallId, params, signal);
      const text = result.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n");
      const rejected = credentialsRejected(server);
      // The host-managed adapter prefixes an isError result with "Error: ".
      // Keep the credential rejection to the exact permitted wording.
      if (text === rejected || text === `Error: ${rejected}`) {
        return { ...result, content: [{ type: "text", text: rejected }], isError: true };
      }
      return result;
    },
  };
}

function serverApi(shim: DurableExtensionShim, server: string): DurableExtensionApi {
  const api = Object.create(shim) as DurableExtensionApi;
  Object.defineProperty(api, "registerTool", {
    value: (tool: DurableExtensionTool) =>
      shim.registerTool(credentialAwareTool(server, qualifiedTool(server, tool))),
  });
  return api;
}

function protocolError(name: string, error: unknown): Error {
  const status = httpStatus(error);
  if (status === 401 || status === 403) return new Error(credentialsRejected(name));
  return new Error(`MCP server ${name} is unavailable`);
}

const STALE_SESSION_CODE = -32600;

/**
 * A restarted server rejects the previous HTTP session with JSON-RPC -32600
 * Invalid Request. pi-mcp-events treats any protocol error as terminal, so
 * the subscription stays failed and looks idle. Any other error, including
 * method-not-found, still reaches the adapter unchanged.
 */
function isStaleSessionResponse(message: unknown): boolean {
  if (!isRecord(message) || "method" in message || !isRecord(message.error)) return false;
  const text = message.error.message;
  return message.error.code === STALE_SESSION_CODE || text === "Invalid Request";
}

/**
 * The adapter installs its handlers on the transport it is given, while the
 * MCP client delivers frames to the transport it connected. Keep delivery on
 * the connected transport, and present the adapter with handlers that hide a
 * stale Invalid Request behind an ordinary close.
 */
function watchStaleSession(transport: Transport, retire: () => void): Transport {
  let onMessage = transport.onmessage;
  let onClose = transport.onclose;
  let retired = false;

  const retireOnce = () => {
    if (retired) return;
    retired = true;
    try {
      onClose?.();
    } finally {
      setTimeout(retire, 0);
    }
  };

  transport.onmessage = (message, extra) => {
    if (retired) return;
    if (isStaleSessionResponse(message)) {
      retireOnce();
      return;
    }
    onMessage?.(message, extra);
  };
  transport.onclose = () => {
    retireOnce();
  };

  return new Proxy(transport, {
    get(target, property) {
      if (property === "onmessage") return onMessage;
      if (property === "onclose") return onClose;
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
    set(target, property, value) {
      if (property === "onmessage") {
        onMessage = typeof value === "function" ? (value as Transport["onmessage"]) : undefined;
        return true;
      }
      if (property === "onclose") {
        onClose = typeof value === "function" ? (value as Transport["onclose"]) : undefined;
        return true;
      }
      return Reflect.set(target, property, value, target);
    },
  });
}

function sameProtocolDefinition(a: McpProtocolDefinition, b: McpProtocolDefinition): boolean {
  return (
    a.namespace === b.namespace &&
    a.requests.length === b.requests.length &&
    a.streams.length === b.streams.length &&
    a.notifications.length === b.notifications.length &&
    a.requests.every((value, index) => value === b.requests[index]) &&
    a.streams.every((value, index) => value === b.streams[index]) &&
    a.notifications.every((value, index) => value === b.notifications[index])
  );
}

export interface McpRuntimeOptions {
  readonly submit?: DurableExtensionSink;
}

/**
 * Bridges the host-managed MCP adapter and pi-mcp-events into the durable
 * registry. There is no extension loader: the shim has exactly the surface
 * these two packages need.
 */
export class McpRuntime {
  readonly shim: DurableExtensionShim;
  readonly serverNames: readonly string[];
  readonly failedServers: ServerFailure[];
  readonly protocol: McpProtocol;
  private readonly servers: Record<string, HostManagedMcpServer>;
  private readonly adapters: HostManagedMcpAdapter[] = [];
  private readonly protocolConnections = new Set<ProtocolConnection>();
  private closed = false;

  private constructor(
    shim: DurableExtensionShim,
    servers: Record<string, HostManagedMcpServer>,
    serverNames: readonly string[],
    failedServers: ServerFailure[],
    protocol: McpProtocol,
  ) {
    this.shim = shim;
    this.servers = servers;
    this.serverNames = serverNames;
    this.failedServers = [...failedServers];
    this.protocol = protocol;
  }

  static async start(options: McpRuntimeOptions = {}): Promise<McpRuntime> {
    const shim = new DurableExtensionShim();
    shim.setMessageSink(options.submit);
    const { servers, timeouts, configuredNames, failures } = await readServers();

    shim.events.on(adapterModule.MCP_TOOL_APPROVAL_REQUEST_EVENT, (request: unknown) => {
      if (!isRecord(request) || typeof request.claim !== "function") return;
      const claim = request.claim as (handler: () => string) => boolean;
      claim(() => "allow_once");
    });

    let resolveProtocol:
      | ((name: string) => Promise<{
          connection: ProtocolServerConnection;
          signal: AbortSignal;
        }>)
      | undefined;
    let protocol: McpProtocol | undefined;
    // pi-mcp-events asks for the protocol again when its tool first connects.
    // Serve the registration made below for that repeated request instead of
    // letting the adapter reject a duplicate namespace.
    shim.events.on(protocolModule.MCP_PROTOCOL_EVENT, (raw: unknown) => {
      if (
        protocol === undefined ||
        !isRecord(raw) ||
        raw.result !== undefined ||
        raw.error !== undefined ||
        !isRecord(raw.definition)
      ) {
        return;
      }
      const definition = raw.definition;
      if (
        definition.namespace === eventsProtocolModule.EVENTS_PROTOCOL.namespace &&
        Array.isArray(definition.requests) &&
        Array.isArray(definition.streams) &&
        Array.isArray(definition.notifications) &&
        sameProtocolDefinition(
          {
            namespace: definition.namespace,
            requests: definition.requests as string[],
            streams: definition.streams as string[],
            notifications: definition.notifications as string[],
          },
          eventsProtocolModule.EVENTS_PROTOCOL,
        )
      ) {
        raw.result = protocol;
      }
    });
    protocolModule.registerProtocolBridge(shim, async (name) => {
      if (resolveProtocol === undefined) throw new Error("MCP protocol is not ready");
      return resolveProtocol(name);
    });
    protocol = adapterModule.registerMcpProtocol(shim, eventsProtocolModule.EVENTS_PROTOCOL);
    const runtime = new McpRuntime(shim, servers, configuredNames, failures, protocol);
    resolveProtocol = (name) => runtime.protocolConnection(name);
    eventsModule.default(shim);
    await shim.dispatch("session_start");

    const onToolCall = async (call: HostManagedMcpToolCall): Promise<CallToolResult> => {
      try {
        return await call.dispatch();
      } catch (error) {
        const status = httpStatus(error);
        if (status === 401 || status === 403) return credentialsResult(call.server);
        // The adapter turns a HostManagedMcpError into its fixed delivery-class
        // result, including the machine-readable details.error value.
        throw error;
      }
    };

    await Promise.all(
      Object.entries(servers).map(async ([name, definition]) => {
        const adapter = hostManagedModule.createHostManagedMcpAdapter({
          servers: { [name]: definition },
          onToolCall,
          requestTimeoutMs: timeouts[name] ?? REQUEST_TIMEOUT_MS,
        });
        try {
          await adapter.ready();
          adapter.extensionFactory(serverApi(shim, name));
          runtime.adapters.push(adapter);
        } catch (error) {
          await adapter.close().catch(() => {});
          const auth = httpStatus(error) === 401 || httpStatus(error) === 403;
          runtime.failedServers.push({ name, auth });
          console.warn(describeBootFailure(name, error));
        }
      }),
    );

    return runtime;
  }

  get tools(): readonly ToolRegistration[] {
    return this.shim.tools;
  }

  get toolNames(): readonly string[] {
    return this.shim.tools.map((tool) => tool.name);
  }

  /** Names and availability only: never a URL, command, header, or token. */
  get status(): McpStatus {
    const failures = new Map(this.failedServers.map((failure) => [failure.name, failure]));
    const toolNames = this.toolNames;
    const servers: McpServerStatus[] = this.serverNames.map((name) => {
      const failure = failures.get(name);
      const prefix = `${sanitizeServerName(name)}__`;
      return {
        name,
        available: failure === undefined,
        authRejected: failure?.auth ?? false,
        tools:
          failure === undefined ? toolNames.filter((toolName) => toolName.startsWith(prefix)) : [],
      };
    });
    return {
      servers,
      unavailable: servers.filter((server) => !server.available).map((server) => server.name),
    };
  }

  setSubmit(sink: DurableExtensionSink | undefined): void {
    this.shim.setMessageSink(sink);
  }

  /** Observes MCP event batches and mcp_events tool results. Never includes secrets. */
  setObserver(observer: Parameters<DurableExtensionShim["setObserver"]>[0]): void {
    this.shim.setObserver(observer);
  }

  install(registry: Parameters<DurableExtensionShim["install"]>[0]): void {
    this.shim.install(registry);
  }

  private async protocolConnection(name: string): Promise<{
    connection: ProtocolServerConnection;
    signal: AbortSignal;
  }> {
    if (this.closed) throw new Error("MCP runtime is closed");
    const definition = this.servers[name];
    if (definition === undefined) throw new Error(`Unknown MCP server: ${name}`);
    const controller = new AbortController();
    let transport: Transport;
    try {
      transport = await definition.createTransport({ server: name, signal: controller.signal });
    } catch (error) {
      throw protocolError(name, error);
    }
    const client = new Client(
      { name: "pi-ui-events", version: "1.0.0" },
      { capabilities: {}, inputRequired: { autoFulfill: false } },
    );
    try {
      await client.connect(transport);
    } catch (error) {
      await client.close().catch(() => {});
      await transport.close().catch(() => {});
      throw protocolError(name, error);
    }
    // A server that was down during the boot probe can come back later. The
    // protocol connection is a live probe of the same definition, so clear the
    // boot failure instead of reporting it for the rest of the process.
    const failure = this.failedServers.findIndex((entry) => entry.name === name);
    if (failure !== -1) this.failedServers.splice(failure, 1);
    const entry = { client, transport, controller };
    this.protocolConnections.add(entry);
    const watched = watchStaleSession(transport, () => {
      if (!this.protocolConnections.delete(entry)) return;
      controller.abort();
      void client.close().catch(() => {});
      void transport.close().catch(() => {});
    });
    const connection: ProtocolServerConnection = {
      status: "connected",
      transport: watched,
      client,
      activeProtocolOperations: 0,
      lastUsedAt: Date.now(),
      requestMetadata: () => undefined,
    };
    return { connection, signal: controller.signal };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.shim.dispatch("session_shutdown").catch(() => {});
    this.protocol.dispose();
    await Promise.allSettled(
      [...this.protocolConnections].map(async ({ client, transport, controller }) => {
        controller.abort();
        await client.close().catch(() => {});
        await transport.close().catch(() => {});
      }),
    );
    this.protocolConnections.clear();
    await Promise.allSettled(this.adapters.map((adapter) => adapter.close()));
    this.shim.close();
  }
}

export async function startMcpRuntime(options: McpRuntimeOptions = {}): Promise<McpRuntime> {
  return McpRuntime.start(options);
}
