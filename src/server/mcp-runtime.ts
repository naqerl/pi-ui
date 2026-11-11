import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import {
  type CallToolResult,
  Client,
  StreamableHTTPClientTransport,
  type Transport,
} from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { MCP_STATUS_HEAD } from "../shared/notices.js";
import type { McpServerStatus, McpStatus } from "../shared/types.js";
import {
  type DurableExtensionApi,
  type DurableExtensionMessage,
  DurableExtensionShim,
  type DurableExtensionSink,
  type DurableExtensionTool,
} from "./durable-extensions.js";
import { checkEventNotifications } from "./mcp-event-check.js";
import { type ExtensionNotice, polledEventCursor, RESTORE_GRACE_MS } from "./mcp-events.js";
import {
  hasPosition,
  type McpSubscriptionRecord,
  McpSubscriptionRegistry,
  recordKey,
  recordStableId,
  subscriptionEnabled,
} from "./mcp-subscriptions.js";

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
const EVENTS_STREAM_ENTRY = pathToFileURL(
  require.resolve("@realmikekelly/pi-mcp-events/dist/stream.js"),
).href;

const REQUEST_TIMEOUT_MS = 30_000;
const HEADER_COMMAND_TIMEOUT_MS = 10_000;
const HEADER_COMMAND_MAX_BYTES = 1024 * 1024;

interface HostManagedMcpServer {
  createTransport(context: { server: string; signal: AbortSignal }): Transport | Promise<Transport>;
  /** MCP tool names to expose. Omit to expose every tool the server lists. */
  readonly tools?: readonly string[];
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

interface ProtocolSession {
  readonly signal: AbortSignal;
  request(method: string, params?: Record<string, unknown>): Promise<unknown>;
  close(): void;
}

interface McpProtocol {
  connect(server: string): Promise<ProtocolSession>;
  dispose(): void;
}

interface EventsStreamSubscription {
  readonly id: string;
  readonly cursor: string | null;
  readonly status: string;
}

interface EventsStreamConnection {
  subscribe(
    name: string,
    args: Record<string, unknown>,
    cursor?: string | null,
  ): Promise<EventsStreamSubscription>;
  cancel(id: string): Promise<void>;
  close(error?: string): void;
}

interface EventsStreamModule {
  readonly EventConnection: new (
    server: string,
    session: ProtocolSession,
    onEvent: (subscription: EventsStreamSubscription, event: Record<string, unknown>) => void,
    onStatus: (
      subscription: EventsStreamSubscription & { endReason?: string },
      unexpected: boolean,
    ) => void,
    onGap: (subscription: EventsStreamSubscription) => void,
    timeoutMs: number,
    options: {
      reconnect?: () => Promise<ProtocolSession>;
      onClose?: () => void;
    },
  ) => EventsStreamConnection;
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
  /** Transport-level reason, never a URL, command, header, or token. */
  readonly reason?: string;
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
const eventsStreamModule = (await import(EVENTS_STREAM_ENTRY)) as EventsStreamModule;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A zero cursor is not a position: never return it to a caller as a resume point. */
function positionCursor(answer: unknown, fallback: string | null): string | null {
  if (typeof answer === "string" && hasPosition(answer)) return answer;
  return fallback !== null && hasPosition(fallback) ? fallback : null;
}

/** A stored zero cursor is not a position: say once that the stream starts now. */
function logStartFromNow(record: McpSubscriptionRecord, sent: string | null): void {
  const stored = record.cursor;
  if (sent !== null || typeof stored !== "string" || stored.length === 0) return;
  if (hasPosition(stored)) return;
  console.log(`mcp: ${record.server}/${record.name} restarted from now (stored cursor ${stored})`);
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
    // The Streamable HTTP client reports an unauthenticated request as an
    // UnauthorizedError without an HTTP status field. It still means 401.
    if (current instanceof Error && current.name === "UnauthorizedError") return 401;
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

function protocolError(name: string, error: unknown): Error {
  const status = httpStatus(error);
  if (status === 401 || status === 403) return new Error(credentialsRejected(name));
  return new Error(`MCP server ${name} is unavailable`);
}

const STALE_SESSION_CODE = -32600;
const STALE_SESSION_TEXTS = new Set(["Invalid Request", "invalid during session initialization"]);

type StaleSessionReason = "http404" | "jsonrpc-32600";

/** Text a server uses when it has forgotten the session it gave us. */
function staleSessionText(text: string): boolean {
  return STALE_SESSION_TEXTS.has(text) || /session not found/i.test(text);
}

/**
 * A restarted server rejects the previous HTTP session with a 404 whose body
 * says `session not found`, or with JSON-RPC -32600 Invalid Request / invalid
 * during session initialization. pi-mcp-events treats any protocol error as
 * terminal, so the subscription stays failed and looks idle. Any other error,
 * including method-not-found, still reaches the adapter unchanged.
 */
function isStaleSessionResponse(message: unknown): boolean {
  if (!isRecord(message) || "method" in message || !isRecord(message.error)) return false;
  const text = message.error.message;
  return (
    message.error.code === STALE_SESSION_CODE ||
    (typeof text === "string" && staleSessionText(text))
  );
}

function stringField(value: unknown, key: string): string | undefined {
  return isRecord(value) && typeof value[key] === "string" ? value[key] : undefined;
}

/**
 * Classify a tool-call failure without trusting a fixed error class: the
 * adapter keeps the real transport error only as `cause`.
 */
function staleSessionReason(error: unknown): StaleSessionReason | undefined {
  let current: unknown = error;
  const seen = new Set<unknown>();
  for (let depth = 0; depth < 8 && current !== undefined; depth++) {
    if (typeof current !== "object" || current === null || seen.has(current)) break;
    seen.add(current);
    const status = "status" in current && typeof current.status === "number" ? current.status : 0;
    const code =
      "code" in current && typeof current.code === "number"
        ? current.code
        : "protocolCode" in current && typeof current.protocolCode === "number"
          ? current.protocolCode
          : undefined;
    const texts = [
      current instanceof Error ? current.message : undefined,
      stringField(current, "statusText"),
      stringField(current, "body"),
      stringField(isRecord(current) && isRecord(current.data) ? current.data : undefined, "text"),
    ].filter((text): text is string => text !== undefined);
    if (status === 404 && texts.some((text) => /session not found/i.test(text))) {
      return "http404";
    }
    if (code === STALE_SESSION_CODE && texts.some(staleSessionText)) {
      return "jsonrpc-32600";
    }
    current = "cause" in current ? current.cause : undefined;
  }
  return undefined;
}

function transportFailureReason(error: unknown): string {
  const status = httpStatus(error);
  if (status !== undefined) return `HTTP ${status}`;
  const code = errorCode(error);
  if (code !== undefined) return `JSON-RPC ${code}`;
  return "server unreachable";
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

/**
 * The adapter re-lists after tools/list_changed but keeps the catalog it froze
 * at ready(), so a new tool never becomes callable there. Watch the transport
 * so the channel can re-initialize and register the grown set through the shim.
 */
function watchToolListChanges(transport: Transport, onChange: () => void): Transport {
  let onMessage = transport.onmessage;
  transport.onmessage = (message, extra) => {
    if ("method" in message && message.method === "notifications/tools/list_changed") onChange();
    onMessage?.(message, extra);
  };
  return new Proxy(transport, {
    get(target, property) {
      if (property === "onmessage") return onMessage;
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
    set(target, property, value) {
      if (property === "onmessage") {
        onMessage = typeof value === "function" ? (value as Transport["onmessage"]) : undefined;
        return true;
      }
      return Reflect.set(target, property, value, target);
    },
  });
}

function sameProtocolDefinition(a: McpProtocolDefinition, b: McpProtocolDefinition): boolean {
  return (
    a.namespace === b.namespace &&
    a.streams.length === b.streams.length &&
    a.notifications.length === b.notifications.length &&
    b.requests.every((value) => a.requests.includes(value)) &&
    a.streams.every((value, index) => value === b.streams[index]) &&
    a.notifications.every((value, index) => value === b.notifications[index])
  );
}

export interface McpRuntimeOptions {
  readonly submit?: DurableExtensionSink;
  /** Data directory for the durable subscription registry. */
  readonly dataDir?: string;
  /** Share one registry with the event feed instead of creating it from `dataDir`. */
  readonly subscriptions?: McpSubscriptionRegistry;
}

export interface RestoredMcpSubscription extends McpSubscriptionRecord {
  readonly id: string;
}

interface RestoreProbe {
  readonly missing: boolean;
  readonly cursor: string | null;
  readonly stale: boolean;
  readonly reason?: string;
  /** The catalog fallback had to page before it found this stream. */
  readonly catalogPaged?: boolean;
  /** What the cursor probe would have replayed, when it answered with events. */
  readonly backlog?: RestoreBacklog;
}

function errorCode(error: unknown): number | undefined {
  if (!isRecord(error)) return undefined;
  if (typeof error.code === "number") return error.code;
  return errorCode(error.cause);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A JSON-RPC -32023 (NotFound) or an explicit unknown-subscription reply. */
function isUnknownSubscriptionError(error: unknown): boolean {
  if (errorCode(error) === -32023) return true;
  const text = errorText(error);
  if (/method not found/i.test(text)) return false;
  return /(?:unknown|not found|no such|missing|expired)[^.]{0,32}subscription|subscription[^.]{0,32}(?:unknown|not found|no such|missing|expired)/i.test(
    text,
  );
}

function pollEvent(item: unknown): Record<string, unknown> | undefined {
  if (!isRecord(item)) return undefined;
  return isRecord(item.event) ? item.event : item;
}

/**
 * Probe page size, and the replay bound: anything this big is summarised as a
 * gap instead of replayed. A restart that missed a few events still delivers
 * them; one that missed a burst reports the burst in one line.
 */
const RESTORE_PROBE_MAX_EVENTS = 25;

interface RestoreBacklog {
  readonly stale: boolean;
  readonly count: number;
  readonly truncated: boolean;
}

/** Describe what the server's poll answer would replay from this cursor. */
function pollBacklog(response: unknown, startedAt: number): RestoreBacklog {
  if (!isRecord(response)) return { stale: false, count: 0, truncated: false };
  const events = Array.isArray(response.events)
    ? response.events
    : response.event === undefined
      ? []
      : [response.event];
  let first: number | undefined;
  for (const item of events) {
    const event = pollEvent(item);
    const raw = event?.timestamp;
    const parsed = typeof raw === "number" ? raw : typeof raw === "string" ? Date.parse(raw) : NaN;
    if (!Number.isFinite(parsed)) continue;
    if (first === undefined || parsed < first) first = parsed;
  }
  const truncated = response.truncated === true;
  // A full probe page means the backlog is at least this large: whatever its
  // timestamps say, replaying it is a flood, so it is the old case too.
  const fullPage = events.length >= RESTORE_PROBE_MAX_EVENTS;
  // An untimestamped truncated answer is still a backlog, so it is the old
  // case. A timestamped answer decides by the first missed event.
  const stale =
    fullPage || (first === undefined ? truncated : first < startedAt - RESTORE_GRACE_MS);
  return { stale, count: events.length, truncated: truncated || fullPage };
}

const CHANNEL_RETRY_DELAYS_MS = [1_000, 5_000, 15_000, 60_000, 300_000] as const;
const TOOL_REFRESH_DEBOUNCE_MS = 50;

interface McpChannelHooks {
  onFailure(name: string, auth: boolean, reason?: string): void;
  onConnected(name: string): void;
  onNotice(text: string, details: Record<string, unknown>): void;
}

interface StaleSessionFailure {
  readonly reason: StaleSessionReason;
  readonly error: unknown;
}

interface ChannelCall {
  readonly token: number;
  stale?: StaleSessionFailure;
}

/**
 * Owns one server's adapter for the whole process. The model-facing tools are
 * registered once, against this channel, so a stale session or a server that
 * was down at boot can be replaced without tripping the shim's duplicate-name
 * guard. A call retries at most once, and only for a stale-session signature.
 */
class McpServerChannel {
  private adapter: HostManagedMcpAdapter | undefined;
  private tools = new Map<string, DurableExtensionTool>();
  private readonly registered = new Set<string>();
  /** One adapter lifecycle operation or tool call at a time. */
  private tail: Promise<void> = Promise.resolve();
  /** Identity of the call currently running through this channel. */
  private activeCall: ChannelCall | undefined;
  private nextCallToken = 0;
  private initPromise: Promise<boolean> | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private attempt = 0;
  private hadFailure = false;
  private closed = false;

  constructor(
    private readonly name: string,
    private readonly definition: HostManagedMcpServer,
    private readonly timeout: number,
    private readonly shim: DurableExtensionShim,
    private readonly hooks: McpChannelHooks,
  ) {}

  /** The tools the current adapter lists, in shim-visible names. */
  get toolNames(): readonly string[] {
    return [...this.tools.keys()];
  }

  initialize(reason?: StaleSessionReason, announce = true): Promise<boolean> {
    return this.startInitialize(reason, announce, false);
  }

  async call(
    name: string,
    args: unknown,
    signal: AbortSignal | undefined,
    toolCallId: string,
  ): Promise<AgentToolResult> {
    return this.enqueue(() => this.runCall(name, args, signal, toolCallId));
  }

  /**
   * Calls, recovery, catalog refreshes and backoff probes share one queue. A
   * recovery must never close an adapter under another in-flight call, and a
   * queued call must see the fresh adapter rather than a transient gap.
   */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task, task);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async runCall(
    name: string,
    args: unknown,
    signal: AbortSignal | undefined,
    toolCallId: string,
  ): Promise<AgentToolResult> {
    if (this.closed) return this.missingResult(name);
    const call = { token: ++this.nextCallToken };
    this.activeCall = call;
    try {
      const first = this.tools.get(name);
      if (first === undefined) return this.missingResult(name);
      let result: AgentToolResult;
      try {
        result = await first.execute(toolCallId, args, signal);
      } catch (error) {
        const stale = this.takeStale(call);
        if (stale === undefined) throw error;
        return this.recoverAndRetry(name, args, signal, toolCallId, call, stale);
      }
      const stale = this.takeStale(call);
      if (stale === undefined) return result;
      return this.recoverAndRetry(name, args, signal, toolCallId, call, stale);
    } finally {
      if (this.activeCall === call) this.activeCall = undefined;
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.activeCall = undefined;
    this.clearRetry();
    if (this.refreshTimer !== undefined) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
    }
    await this.initPromise?.catch(() => {});
    const adapter = this.adapter;
    this.adapter = undefined;
    this.tools = new Map();
    await adapter?.close().catch(() => {});
  }

  private startInitialize(
    reason: StaleSessionReason | undefined,
    announce: boolean,
    refresh: boolean,
  ): Promise<boolean> {
    if (this.closed) return Promise.resolve(false);
    if (this.initPromise !== undefined) return this.initPromise;
    const promise = this.runInitialize(reason, announce, refresh).finally(() => {
      this.initPromise = undefined;
    });
    this.initPromise = promise;
    return promise;
  }

  private async runInitialize(
    reason: StaleSessionReason | undefined,
    announce: boolean,
    refresh: boolean,
  ): Promise<boolean> {
    if (this.closed) return false;
    const previous = this.adapter;
    const adapter = this.createAdapter();
    try {
      await adapter.ready();
      if (this.closed) {
        await adapter.close().catch(() => {});
        return false;
      }
      const captured = new Map<string, DurableExtensionTool>();
      adapter.extensionFactory(this.captureApi(captured));
      this.adapter = adapter;
      this.tools = captured;
      for (const tool of captured.values()) this.registerPassthrough(tool);
      if (previous !== undefined && previous !== adapter) {
        await previous.close().catch(() => {});
      }
      const wasFailed = this.hadFailure;
      this.hadFailure = false;
      this.attempt = 0;
      this.clearRetry();
      this.hooks.onConnected(this.name);
      if (announce) {
        if (reason !== undefined) {
          this.notice(
            `mcp ${this.name}: session lost (${reason}), re-initialized, tool list refreshed`,
            { server: this.name, reason },
          );
        } else if (wasFailed) {
          this.notice(`mcp ${this.name}: re-initialized, tool list refreshed`, {
            server: this.name,
          });
        }
      }
      return true;
    } catch (error) {
      await adapter.close().catch(() => {});
      if (refresh) {
        console.warn(`mcp: could not refresh the tool list for ${this.name}`, error);
        return false;
      }
      this.recordFailure(
        error,
        reason === undefined ? transportFailureReason(error) : `session lost (${reason})`,
      );
      if (announce && reason !== undefined) {
        this.notice(`mcp ${this.name}: session lost (${reason}), re-initialize failed`, {
          server: this.name,
          reason,
        });
      }
      return false;
    }
  }

  private createAdapter(): HostManagedMcpAdapter {
    const definition: HostManagedMcpServer = {
      ...this.definition,
      createTransport: async (context) =>
        watchToolListChanges(await this.definition.createTransport(context), () =>
          this.onToolListChanged(),
        ),
    };
    return hostManagedModule.createHostManagedMcpAdapter({
      servers: { [this.name]: definition },
      onToolCall: (call) => this.onToolCall(call),
      requestTimeoutMs: this.timeout,
    });
  }

  private captureApi(captured: Map<string, DurableExtensionTool>): DurableExtensionApi {
    const api = Object.create(this.shim) as DurableExtensionApi;
    Object.defineProperty(api, "registerTool", {
      value: (tool: DurableExtensionTool) => {
        const qualified = credentialAwareTool(this.name, qualifiedTool(this.name, tool));
        captured.set(qualified.name, qualified);
      },
    });
    return api;
  }

  /** Registered once; later adapters only change what the passthrough dispatches to. */
  private registerPassthrough(tool: DurableExtensionTool): void {
    if (this.registered.has(tool.name)) return;
    this.registered.add(tool.name);
    this.shim.registerTool({
      name: tool.name,
      ...(tool.label === undefined ? {} : { label: tool.label }),
      description: tool.description,
      ...(tool.promptSnippet === undefined ? {} : { promptSnippet: tool.promptSnippet }),
      parameters: tool.parameters,
      execute: (toolCallId, params, signal) => this.call(tool.name, params, signal, toolCallId),
    });
  }

  private async onToolCall(call: HostManagedMcpToolCall): Promise<CallToolResult> {
    try {
      return await call.dispatch();
    } catch (error) {
      const status = httpStatus(error);
      if (status === 401 || status === 403) return credentialsResult(call.server);
      const reason = staleSessionReason(error);
      if (reason !== undefined && this.activeCall !== undefined) {
        this.activeCall.stale = { reason, error };
      }
      throw error;
    }
  }

  private takeStale(call: ChannelCall): StaleSessionFailure | undefined {
    const stale = call.stale;
    call.stale = undefined;
    return stale;
  }

  private async recoverAndRetry(
    name: string,
    args: unknown,
    signal: AbortSignal | undefined,
    toolCallId: string,
    call: ChannelCall,
    stale: StaleSessionFailure,
  ): Promise<AgentToolResult> {
    await this.initPromise?.catch(() => {});
    const previous = this.adapter;
    this.adapter = undefined;
    this.tools = new Map();
    await previous?.close().catch(() => {});
    const recovered = await this.initialize(stale.reason, false);
    if (!recovered) {
      this.notice(`mcp ${this.name}: session lost (${stale.reason}), re-initialize failed`, {
        server: this.name,
        reason: stale.reason,
      });
      throw stale.error;
    }
    const retryTool = this.tools.get(name);
    if (retryTool === undefined) {
      this.notice(
        `mcp ${this.name}: session lost (${stale.reason}), re-initialized, tool list refreshed`,
        { server: this.name, reason: stale.reason },
      );
      return this.missingResult(name);
    }
    let retried: AgentToolResult;
    try {
      retried = await retryTool.execute(toolCallId, args, signal);
    } catch (error) {
      const again = this.takeStale(call);
      if (again !== undefined) {
        await this.failAdapter(again.reason);
        this.notice(`mcp ${this.name}: session lost (${again.reason}), retry failed`, {
          server: this.name,
          reason: again.reason,
        });
        throw again.error;
      }
      if (signal?.aborted === true) throw error;
      const reason = transportFailureReason(error);
      await this.failTransport(error, reason);
      this.notice(`mcp ${this.name}: retry failed (${reason})`, {
        server: this.name,
        reason,
      });
      throw error;
    }
    const again = this.takeStale(call);
    if (again !== undefined) {
      await this.failAdapter(again.reason);
      this.notice(`mcp ${this.name}: session lost (${again.reason}), retry failed`, {
        server: this.name,
        reason: again.reason,
      });
      throw again.error;
    }
    this.notice(
      `mcp ${this.name}: session lost (${stale.reason}), re-initialized, tool list refreshed`,
      { server: this.name, reason: stale.reason },
    );
    return retried;
  }

  /** The retry also failed: keep the adapter closed and let backoff take over. */
  private async failAdapter(reason: StaleSessionReason): Promise<void> {
    const adapter = this.adapter;
    this.adapter = undefined;
    this.tools = new Map();
    await adapter?.close().catch(() => {});
    this.recordFailure(
      new Error(`MCP server ${this.name} lost its session (${reason})`),
      `session lost (${reason})`,
    );
  }

  private async failTransport(error: unknown, reason: string): Promise<void> {
    const adapter = this.adapter;
    this.adapter = undefined;
    this.tools = new Map();
    await adapter?.close().catch(() => {});
    this.recordFailure(error, reason);
  }

  private missingResult(name: string): AgentToolResult {
    const text =
      this.adapter === undefined
        ? `MCP server "${this.name}" is unavailable; tool "${name}" was not run.`
        : `MCP tool "${name}" is no longer offered by server "${this.name}".`;
    return { content: [{ type: "text", text }], details: {}, isError: true };
  }

  private onToolListChanged(): void {
    if (this.closed || this.refreshTimer !== undefined) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      void this.refreshTools();
    }, TOOL_REFRESH_DEBOUNCE_MS);
    this.refreshTimer.unref?.();
  }

  private refreshTools(): Promise<void> {
    return this.enqueue(() => this.runRefresh());
  }

  private async runRefresh(): Promise<void> {
    if (this.closed || this.adapter === undefined) return;
    const before = new Set(this.tools.keys());
    const refreshed = await this.startInitialize(undefined, false, true);
    if (!refreshed) return;
    const added = [...this.tools.keys()].filter((name) => !before.has(name));
    if (added.length > 0) {
      this.notice(`mcp ${this.name}: tool list refreshed`, { server: this.name, tools: added });
    }
  }

  private notice(text: string, details: Record<string, unknown>): void {
    this.hooks.onNotice(text, details);
  }

  private recordFailure(error: unknown, reason?: string): void {
    this.hadFailure = true;
    const auth = httpStatus(error) === 401 || httpStatus(error) === 403;
    this.hooks.onFailure(this.name, auth, reason);
    console.warn(describeBootFailure(this.name, error));
    // A rejected credential is not transient; retrying it would only repeat it.
    if (!auth) this.scheduleRetry();
  }

  private scheduleRetry(): void {
    if (this.closed || this.retryTimer !== undefined) return;
    const delay =
      CHANNEL_RETRY_DELAYS_MS[Math.min(this.attempt, CHANNEL_RETRY_DELAYS_MS.length - 1)];
    this.attempt += 1;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.enqueue(() => this.initialize());
    }, delay);
    this.retryTimer.unref?.();
  }

  private clearRetry(): void {
    if (this.retryTimer === undefined) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }
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
  /** Process start time; no event from before it may become a chat notice. */
  readonly startedAt: number;
  private readonly servers: Record<string, HostManagedMcpServer>;
  private readonly channels = new Map<string, McpServerChannel>();
  private readonly protocolConnections = new Set<ProtocolConnection>();
  private readonly subscriptionStore: McpSubscriptionRegistry | undefined;
  /** New subscription id → the persisted entry it was restored from. */
  private readonly restored = new Map<string, McpSubscriptionRecord>();
  /** Entries whose server was not available yet; kept until a later connection. */
  private readonly pendingRestore = new Map<string, McpSubscriptionRecord>();
  /** Restored entries the server rejected; never retried by this process. */
  private readonly dropped = new Set<string>();
  private readonly restoring = new Set<string>();
  /** Stable ids that already announced the backlog they did not replay. */
  private readonly restoreGaps = new Set<string>();
  /** Direct fallback streams, used only when the mcp_events tool is not registered. */
  private readonly directSubscriptions = new Map<string, EventsStreamConnection>();
  /** One reusable poll session per server; a new one per tick would leak transports. */
  private readonly pollSessions = new Map<string, ProtocolSession>();
  private readonly pendingNotices: ExtensionNotice[] = [];
  private observer: ((notice: ExtensionNotice) => unknown) | undefined;
  private closed = false;

  private constructor(
    shim: DurableExtensionShim,
    servers: Record<string, HostManagedMcpServer>,
    serverNames: readonly string[],
    failedServers: ServerFailure[],
    protocol: McpProtocol,
    subscriptionStore: McpSubscriptionRegistry | undefined,
    startedAt: number,
  ) {
    this.shim = shim;
    this.servers = servers;
    this.serverNames = serverNames;
    this.failedServers = [...failedServers];
    this.protocol = protocol;
    this.subscriptionStore = subscriptionStore;
    this.startedAt = startedAt;
  }

  static async start(options: McpRuntimeOptions = {}): Promise<McpRuntime> {
    const startedAt = Date.now();
    const shim = new DurableExtensionShim();
    shim.setMessageSink(options.submit);
    const subscriptionStore =
      options.subscriptions ??
      (options.dataDir === undefined ? undefined : new McpSubscriptionRegistry(options.dataDir));
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
    // The watchdog needs events/poll on the same mediated connection the
    // events extension uses. It is intentionally not sent to the extension.
    protocol = adapterModule.registerMcpProtocol(shim, {
      ...eventsProtocolModule.EVENTS_PROTOCOL,
      requests: [...eventsProtocolModule.EVENTS_PROTOCOL.requests, "events/poll"],
    });
    const runtime = new McpRuntime(
      shim,
      servers,
      configuredNames,
      failures,
      protocol,
      subscriptionStore,
      startedAt,
    );
    resolveProtocol = (name) => runtime.protocolConnection(name);
    // pi-mcp-events constructs EventConnection with only reconnect/onClose
    // (dist/index.js:68), so maxRetries/retryBaseMs/heartbeatTimeoutMs cannot
    // be supplied here. dist/stream.js:300 stops after five retries; the
    // subscription watchdog reopens a stream that stays dead after that.
    eventsModule.default(shim);
    await shim.dispatch("session_start");

    for (const [name, definition] of Object.entries(servers)) {
      runtime.channels.set(
        name,
        new McpServerChannel(name, definition, timeouts[name] ?? REQUEST_TIMEOUT_MS, shim, {
          onFailure: (server, auth, reason) => runtime.markFailure(server, auth, reason),
          onConnected: (server) => runtime.markConnected(server),
          onNotice: (text, details) => runtime.notifyChannel(text, details),
        }),
      );
    }
    await Promise.all([...runtime.channels.values()].map((channel) => channel.initialize()));

    await runtime.restoreSubscriptions();
    return runtime;
  }

  /** The shared durable registry, or undefined when this runtime was started without a data dir. */
  get subscriptionRegistry(): McpSubscriptionRegistry | undefined {
    return this.subscriptionStore;
  }

  /**
   * Ask the hub whether a subscription's cursor is really current. This uses
   * the same adapter protocol connection as mcp_events, never a second client.
   */
  async pollEvents(
    server: string,
    name: string,
    cursor: string | null,
    maxEvents = 1,
  ): Promise<unknown> {
    const session = await this.pollSession(server);
    try {
      return await session.request("events/poll", { name, cursor, maxEvents });
    } catch (error) {
      if (session.signal.aborted) {
        session.close();
        if (this.pollSessions.get(server) === session) this.pollSessions.delete(server);
      }
      throw error;
    }
  }

  private async pollSession(server: string): Promise<ProtocolSession> {
    let session = this.pollSessions.get(server);
    if (session === undefined || session.signal.aborted) {
      session?.close();
      session = await this.protocol.connect(server);
      this.pollSessions.set(server, session);
    }
    return session;
  }

  /** The event catalog, used only when a server cannot answer the cursor probe. */
  private async listEventNames(
    server: string,
    wanted: string,
  ): Promise<{ names: string[]; paged: boolean }> {
    const session = await this.pollSession(server);
    try {
      const names: string[] = [];
      const cursors = new Set<string>();
      let cursor: string | undefined;
      for (;;) {
        const result = await session.request("events/list", cursor === undefined ? {} : { cursor });
        if (!isRecord(result) || !Array.isArray(result.events)) {
          throw new Error("events/list returned no catalog");
        }
        for (const item of result.events) {
          if (isRecord(item) && typeof item.name === "string" && item.name.length > 0) {
            names.push(item.name);
          }
        }
        // Stop at the first page that names the stream we are restoring.
        if (names.includes(wanted)) return { names, paged: cursor !== undefined };
        const next =
          typeof result.nextCursor === "string" && result.nextCursor.length > 0
            ? result.nextCursor
            : undefined;
        if (next === undefined) return { names, paged: cursor !== undefined };
        // Match pi-mcp-events: reject a repeated cursor or an endless catalog.
        if (cursors.has(next) || cursors.size >= 100) {
          throw new Error("events/list pagination did not terminate");
        }
        cursors.add(next);
        cursor = next;
      }
    } catch (error) {
      if (session.signal.aborted) {
        session.close();
        if (this.pollSessions.get(server) === session) this.pollSessions.delete(server);
      }
      throw error;
    }
  }

  /**
   * Stop the dead adapter stream and subscribe again at the hub cursor. The
   * normal path is the mcp_events tool, so the extension keeps owning the
   * replacement stream. A direct protocol session is used only when that tool
   * is not registered.
   */
  async reopenSubscription(
    record: McpSubscriptionRecord,
    cursor: string | null | undefined,
  ): Promise<{ id?: string; cursor: string | null; status: string; endReason?: string }> {
    // When the caller supplies a cursor it wins: a real position resumes there
    // and a zero position means "start in now", never the stored position.
    // Only "no cursor at all" falls back to the record's usable position.
    const sent =
      cursor === null || cursor === undefined
        ? hasPosition(record.cursor)
          ? record.cursor
          : null
        : hasPosition(cursor)
          ? cursor
          : null;
    logStartFromNow(record, sent);
    if (this.toolNames.includes("mcp_events")) {
      if (record.id !== null && record.id !== undefined && record.id.length > 0) {
        await this.shim
          .callTool("mcp_events", { action: "unsubscribe", subscription_id: record.id })
          .catch(() => {});
      }
      const result = await this.shim.callTool("mcp_events", {
        action: "subscribe",
        server: record.server,
        name: record.name,
        arguments: record.arguments,
        cursor: sent,
      });
      const details = isRecord(result.details) ? result.details : undefined;
      if (result.isError === true) {
        throw new Error(
          details !== undefined && typeof details.error === "string"
            ? details.error
            : "subscription failed",
        );
      }
      const raw =
        details !== undefined && isRecord(details.subscription) ? details.subscription : {};
      return {
        ...(typeof raw.id === "string" ? { id: raw.id } : {}),
        cursor: positionCursor(raw.cursor, sent),
        status: typeof raw.status === "string" ? raw.status : "active",
        ...(typeof raw.endReason === "string" ? { endReason: raw.endReason } : {}),
      };
    }
    return this.reopenDirect(record, sent);
  }

  private async reopenDirect(
    record: McpSubscriptionRecord,
    cursor: string | null,
  ): Promise<{ id: string; cursor: string | null; status: string; endReason?: string }> {
    if (record.id !== null && record.id !== undefined) {
      const previous = this.directSubscriptions.get(record.id);
      if (previous !== undefined) {
        await previous.cancel(record.id).catch(() => {});
        previous.close();
        this.directSubscriptions.delete(record.id);
      }
    }
    const session = await this.protocol.connect(record.server);
    let connection!: EventsStreamConnection;
    const options = {
      reconnect: () => this.protocol.connect(record.server),
      onClose: () => {
        for (const [id, item] of this.directSubscriptions) {
          if (item === connection) this.directSubscriptions.delete(id);
        }
      },
    };
    connection = new eventsStreamModule.EventConnection(
      record.server,
      session,
      (subscription, event) => {
        this.deliverNotice({
          customType: "mcp-events",
          details: {
            events: [{ subscription_id: subscription.id, server: record.server, event }],
          },
        });
      },
      (subscription, unexpected) => {
        if (!unexpected) return;
        this.deliverNotice({
          customType: "mcp-events-status",
          details: { subscriptions: [{ ...subscription, server: record.server }] },
        });
      },
      () => {},
      15_000,
      options,
    );
    try {
      const subscription = await connection.subscribe(record.name, record.arguments, cursor);
      this.directSubscriptions.set(subscription.id, connection);
      return {
        id: subscription.id,
        cursor: positionCursor(subscription.cursor, cursor),
        status: subscription.status,
      };
    } catch (error) {
      connection.close();
      throw error;
    }
  }

  /** Subscriptions opened at boot, with the id pi-mcp-events assigned this process. */
  get restoredSubscriptions(): RestoredMcpSubscription[] {
    return [...this.restored].map(([id, record]) => ({ ...record, id }));
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
    const servers: McpServerStatus[] = this.serverNames.map((name) => {
      const failure = failures.get(name);
      const channel = this.channels.get(name);
      return {
        name,
        available: failure === undefined,
        authRejected: failure?.auth ?? false,
        tools: failure === undefined && channel !== undefined ? [...channel.toolNames] : [],
        ...(failure?.reason === undefined ? {} : { reason: failure.reason }),
      };
    });
    return {
      servers,
      unavailable: servers.filter((server) => !server.available).map((server) => server.name),
    };
  }

  /** Keep one failure entry per server, so a later reconnect replaces the old reason. */
  private markFailure(name: string, auth: boolean, reason?: string): void {
    for (let failure = this.failedServers.length - 1; failure >= 0; failure -= 1) {
      if (this.failedServers[failure]?.name === name) this.failedServers.splice(failure, 1);
    }
    this.failedServers.push({ name, auth, ...(reason === undefined ? {} : { reason }) });
  }

  private markConnected(name: string): void {
    for (let failure = this.failedServers.length - 1; failure >= 0; failure -= 1) {
      if (this.failedServers[failure]?.name === name) this.failedServers.splice(failure, 1);
    }
  }

  /** Recovery is news for the chat and a status broadcast for every open tab. */
  private notifyChannel(text: string, details: Record<string, unknown>): void {
    // A recovery notice is MCP status, not a user turn. The head routes it through
    // the MCP notice path, so the chat shows one chip instead of a queued bubble
    // that looks like something the operator typed.
    this.shim.sendMessage({
      customType: "mcp-recovery",
      content: `${MCP_STATUS_HEAD}\n${text}`,
      display: true,
      details: details as DurableExtensionMessage["details"],
    });
  }

  setSubmit(sink: DurableExtensionSink | undefined): void {
    this.shim.setMessageSink(sink);
  }

  /** Observes MCP event batches and mcp_events tool results. Never includes secrets. */
  setObserver(observer: Parameters<DurableExtensionShim["setObserver"]>[0]): void {
    this.observer = observer;
    this.shim.setObserver(observer);
    if (observer === undefined) return;
    // Restore runs before the feed exists. Replay its subscribe results now so
    // /api/state has the real subscription ids and stored cursors immediately.
    for (const notice of this.pendingNotices.splice(0)) {
      try {
        observer(notice);
      } catch (error) {
        console.error("[mcp] restored subscription notice failed", error);
      }
    }
  }

  /**
   * Subscribe again to every persisted active/reconnecting entry. A recent
   * cursor resumes where pi stopped; a backlog older than the restore grace
   * window starts in now and is reported as one gap. pi-mcp-events resolves
   * its own subscription id; the mapping is kept so a cursor advance still
   * targets the persisted entry. Failures stay in `pendingRestore` and are
   * retried when the server answers.
   */
  async restoreSubscriptions(): Promise<RestoredMcpSubscription[]> {
    if (this.subscriptionStore === undefined) return [];
    const records = await this.subscriptionStore.read();
    const already = new Set([...this.restored.values()].map((record) => recordKey(record)));
    for (const record of records) {
      if (!subscriptionEnabled(record.status) || record.enabled === false) continue;
      if (record.status !== "active" && record.status !== "reconnecting") continue;
      const key = recordKey(record);
      if (already.has(key) || this.isSubscriptionDropped(recordStableId(record))) continue;
      this.pendingRestore.set(key, record);
    }
    await Promise.all(
      [...this.pendingRestore.values()].map((record) => this.restoreSubscription(record)),
    );
    return this.restoredSubscriptions;
  }

  /** A rejected restore is terminal for this process, including watchdog retries. */
  isSubscriptionDropped(stableId: string): boolean {
    return this.dropped.has(stableId);
  }

  /**
   * Stop a live adapter stream and mark the durable entry cancelled. `liveId`
   * is the current adapter id when the caller knows it from the feed; the
   * restored map covers subscriptions opened at boot. Repeating the call is
   * harmless and still returns the existing cancelled record.
   */
  async cancelSubscription(
    stableId: string,
    liveIds?: string | readonly string[],
  ): Promise<McpSubscriptionRecord | null> {
    const ids = new Set<string>();
    if (typeof liveIds === "string") {
      if (liveIds.length > 0) ids.add(liveIds);
    } else if (liveIds !== undefined) {
      for (const id of liveIds) if (id.length > 0) ids.add(id);
    }
    for (const [id, record] of this.restored) {
      if (recordStableId(record) === stableId) ids.add(id);
    }
    for (const [key, record] of this.pendingRestore) {
      if (recordStableId(record) === stableId) this.pendingRestore.delete(key);
    }
    for (const id of ids) {
      try {
        await this.shim.callTool("mcp_events", {
          action: "unsubscribe",
          subscription_id: id,
        });
      } catch (error) {
        console.warn(`mcp: could not stop subscription ${stableId}`, error);
      }
      this.restored.delete(id);
    }
    const cancelled = await this.subscriptionStore?.cancel(stableId);
    return cancelled ?? null;
  }

  /** Alternate name for `cancelSubscription`, kept for callers that think in identity. */
  cancelByStableId(
    stableId: string,
    liveIds?: string | readonly string[],
  ): Promise<McpSubscriptionRecord | null> {
    return this.cancelSubscription(stableId, liveIds);
  }

  private deliverNotice(notice: ExtensionNotice): void {
    if (this.observer === undefined) {
      this.pendingNotices.push(notice);
      return;
    }
    try {
      this.observer(notice);
    } catch (error) {
      console.error("[mcp] subscription notice failed", error);
    }
  }

  /** Ask the server whether the persisted cursor still belongs to a live subscription. */
  private async probeRestore(record: McpSubscriptionRecord): Promise<RestoreProbe> {
    let probeFailure: unknown;
    try {
      const response = await this.pollEvents(
        record.server,
        record.name,
        record.cursor,
        RESTORE_PROBE_MAX_EVENTS,
      );
      const backlog = pollBacklog(response, this.startedAt);
      // Only what the poll actually shows decides staleness. An idle
      // subscription legitimately has an old lastEventAt while its cursor is
      // current; treating that as a backlog would throw away the position and
      // report a gap for events that do not exist.
      return {
        missing: false,
        cursor: polledEventCursor(response) ?? record.cursor,
        stale: backlog.stale,
        backlog,
      };
    } catch (error) {
      if (isUnknownSubscriptionError(error)) {
        return { missing: true, cursor: record.cursor, stale: false, reason: errorText(error) };
      }
      probeFailure = error;
    }
    // Older servers may not implement events/poll. Their catalog still tells us
    // whether the stream name itself disappeared.
    try {
      const catalog = await this.listEventNames(record.server, record.name);
      if (!catalog.names.includes(record.name)) {
        return {
          missing: true,
          cursor: record.cursor,
          stale: false,
          reason: `event ${record.name} is not in the server catalog`,
        };
      }
      return { missing: false, cursor: record.cursor, stale: false, catalogPaged: catalog.paged };
    } catch (error) {
      if (isUnknownSubscriptionError(error)) {
        return { missing: true, cursor: record.cursor, stale: false, reason: errorText(error) };
      }
      throw probeFailure ?? error;
    }
  }

  private async dropRestoredSubscription(
    record: McpSubscriptionRecord,
    key: string,
    reason: string,
  ): Promise<void> {
    const stableId = recordStableId(record);
    this.dropped.add(key);
    this.dropped.add(stableId);
    this.pendingRestore.delete(key);
    await this.subscriptionStore?.cancel(stableId).catch(() => {});
    console.warn(`mcp: dropped restored subscription ${record.server}/${record.name}: ${reason}`);
  }

  /**
   * One durable gap record for a backlog this process deliberately did not
   * replay. It is status text, not an event chip: the model learns that events
   * were missed, without receiving days of history as individual deliveries.
   */
  private noteRestoreGap(record: McpSubscriptionRecord, backlog: RestoreBacklog): void {
    const stableId = recordStableId(record);
    if (this.restoreGaps.has(stableId)) return;
    this.restoreGaps.add(stableId);
    const from = record.cursor;
    const missedSince = record.lastEventAt ?? "unknown";
    const at = new Date().toISOString();
    const count = backlog.count;
    // A truncated probe counted only its first page, so say "at least".
    const label = count > 0 ? `${count}${backlog.truncated ? "+" : ""}` : "Some";
    const text = `${label} events were missed while pi was not running (from ${
      from ?? "no position"
    } since ${missedSince}).`;
    console.log(`mcp: ${record.server}/${record.name} did not replay its old backlog; ${text}`);
    this.shim.sendMessage({
      customType: "mcp-events-gap",
      content: `${MCP_STATUS_HEAD}\n${text}`,
      display: true,
      details: {
        kind: "restore-gap",
        server: record.server,
        name: record.name,
        from,
        missedSince,
        at,
        count,
        truncated: backlog.truncated,
      } as DurableExtensionMessage["details"],
    });
  }

  private async restoreSubscription(record: McpSubscriptionRecord): Promise<boolean> {
    const key = recordKey(record);
    const stableId = recordStableId(record);
    if (this.isSubscriptionDropped(stableId) || this.restoring.has(key)) return false;
    this.restoring.add(key);
    try {
      const probe = await this.probeRestore(record);
      if (probe.missing) {
        await this.dropRestoredSubscription(
          record,
          key,
          probe.reason ?? "the server no longer knows this subscription",
        );
        return false;
      }
      // A paged catalog is the restore-after-paging path: a real stored
      // position is the stream's resume point. A zero cursor is never handed
      // to the transport, even on that fallback.
      const stale = probe.stale && probe.catalogPaged !== true;
      const cursor =
        probe.catalogPaged === true && hasPosition(record.cursor)
          ? record.cursor
          : stale
            ? null
            : hasPosition(record.cursor)
              ? record.cursor
              : null;
      logStartFromNow(record, cursor);
      if (stale) {
        console.log(
          `mcp: starting ${record.server}/${record.name} from now; its backlog predates this process`,
        );
      }
      const result = await this.shim.callTool("mcp_events", {
        action: "subscribe",
        server: record.server,
        name: record.name,
        arguments: record.arguments,
        cursor,
      });
      const details = isRecord(result.details) ? result.details : undefined;
      if (result.isError === true) {
        throw new Error(
          details !== undefined && typeof details.error === "string"
            ? details.error
            : "subscription failed",
        );
      }
      const raw =
        details !== undefined && isRecord(details.subscription) ? details.subscription : undefined;
      if (raw === undefined || typeof raw.id !== "string") {
        throw new Error("subscription result has no id");
      }
      const subscription = {
        id: raw.id,
        server: typeof raw.server === "string" ? raw.server : record.server,
        name: typeof raw.name === "string" ? raw.name : record.name,
        status: typeof raw.status === "string" ? raw.status : record.status,
        arguments: isRecord(raw.arguments) ? raw.arguments : record.arguments,
        cursor: positionCursor(raw.cursor, cursor),
      };
      const restored: McpSubscriptionRecord = {
        ...record,
        stableId,
        id: subscription.id,
        cursor: subscription.cursor,
        status: subscription.status,
        enabled: subscriptionEnabled(subscription.status),
        updatedAt: new Date().toISOString(),
      };
      this.restored.set(subscription.id, restored);
      this.pendingRestore.delete(key);
      console.log(
        `mcp: restored subscription ${record.server}/${record.name} at ${subscription.cursor ?? "null"}`,
      );
      // Record the skipped window only after the new cursor is live, so a
      // failed restore cannot claim a gap it did not actually start from.
      if (stale && probe.backlog !== undefined) this.noteRestoreGap(record, probe.backlog);
      this.deliverNotice({
        customType: "mcp-events-tool",
        details: {
          args: {
            action: "subscribe",
            server: record.server,
            name: record.name,
            arguments: record.arguments,
            cursor,
            restored: true,
          },
          result: {
            subscription: {
              ...subscription,
              stableId,
              deliveredEventIds: record.deliveredEventIds ?? [],
            },
          },
        },
      });
      void this.subscriptionStore?.record(restored).catch(() => {});
      return true;
    } catch {
      // Keep the entry. A protocol connection for this server retries it.
      return false;
    } finally {
      this.restoring.delete(key);
    }
  }

  private async restorePendingFor(server: string): Promise<void> {
    for (const record of [...this.pendingRestore.values()]) {
      if (record.server !== server) continue;
      if (this.isSubscriptionDropped(recordStableId(record))) {
        this.pendingRestore.delete(recordKey(record));
        continue;
      }
      await this.restoreSubscription(record);
    }
  }

  install(registry: Parameters<DurableExtensionShim["install"]>[0]): void {
    this.shim.install(registry);
  }

  async protocolConnection(name: string): Promise<{
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
    // protocol connection is a live probe of the same definition, so clear
    // every failure for this server instead of writing a stale array once.
    this.markConnected(name);
    // A server that was unavailable during the boot probe can now restore its
    // deferred subscriptions. The delay keeps the current subscribe first.
    setTimeout(() => {
      void this.restorePendingFor(name);
    }, 0).unref?.();
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
      transport: checkEventNotifications(watched, name, undefined, (traffic) => {
        if (traffic.subscriptionId === undefined) return;
        this.deliverNotice({
          customType: "mcp-events-traffic",
          details: {
            subscription_id: traffic.subscriptionId,
            server: name,
            method: traffic.method,
            cursor: traffic.cursor,
            timestamp: traffic.at,
          },
        });
      }),
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
    for (const session of this.pollSessions.values()) session.close();
    this.pollSessions.clear();
    this.protocol.dispose();
    await Promise.allSettled(
      [...this.protocolConnections].map(async ({ client, transport, controller }) => {
        controller.abort();
        await client.close().catch(() => {});
        await transport.close().catch(() => {});
      }),
    );
    this.protocolConnections.clear();
    for (const connection of new Set(this.directSubscriptions.values())) connection.close();
    this.directSubscriptions.clear();
    await Promise.allSettled([...this.channels.values()].map((channel) => channel.close()));
    await this.subscriptionStore?.close().catch(() => {});
    this.shim.close();
  }
}

export async function startMcpRuntime(options: McpRuntimeOptions = {}): Promise<McpRuntime> {
  return McpRuntime.start(options);
}
