import { AsyncLocalStorage } from "node:async_hooks";
import { accessSync, constants, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

export const BILLION_CONTEXT_INLINE_ORIGIN = "http://billion-context.inline";

const INTERCEPT_FLAG = Symbol.for("billion-context.native-fetch-intercept");
const PLUGIN_AGENT = "pi";
const PLUGIN_CONTEXT_WINDOW_HEADER = "x-bili-plugin-context-window";
const PLUGIN_MAX_OUTPUT_HEADER = "x-bili-plugin-max-output";
const PLUGIN_MODEL_HEADER = "x-bili-plugin-model";
const REQUEST_TIMEOUT_MS = 5_000;
const MAX_OBSERVED_REQUESTS = 32;

const MODEL_API_SUFFIX =
  /(?:^|\/)(?:v\d+\/)?(?:messages|chat\/completions|completions|responses|conversations)\/?$|(?:^|\/)models\/[^/:?]+:(?:streamGenerateContent|generateContent|countTokens)$/;

export interface ObservedRequest {
  readonly url: string;
  readonly method: string;
  readonly conversationId: string | undefined;
  readonly conversationHeader: string | undefined;
}

export interface BiliToolDefinition {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: unknown;
}

export interface BiliToolResult {
  readonly text: string;
  readonly failed: boolean;
}

export interface BiliModelMetadata {
  readonly model?: string;
  readonly contextWindow?: number;
  readonly maxOutput?: number;
}

export interface BiliStatus extends Record<string, unknown> {
  readonly requests?: number;
  readonly contextTokens?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cachedTokens?: number;
}

export interface BillionContextInline {
  readonly enabled: boolean;
  readonly origin: string;
  readonly hadChain: boolean;
  readonly observed: readonly ObservedRequest[];
  readonly fetch: typeof globalThis.fetch;
  currentConversationId(): string | undefined;
  setModelMetadata(metadata: BiliModelMetadata): void;
  setConversationIdentity(conversationId: string | undefined): void;
  registerIdentity(conversationId?: string): Promise<boolean>;
  manifest(signal?: AbortSignal): Promise<readonly BiliToolDefinition[] | undefined>;
  status(conversationId: string, signal?: AbortSignal): Promise<BiliStatus | undefined>;
  callTool(
    conversationId: string,
    tool: string,
    args: unknown,
    signal?: AbortSignal,
  ): Promise<BiliToolResult>;
}

export interface InstallOptions {
  readonly currentPath: string;
}

let installed: BillionContextInline | undefined;

const conversationScope = new AsyncLocalStorage<string | typeof NO_IDENTITY>();

const NO_IDENTITY = Symbol("pi-ui.no-conversation-identity");

export function withConversationIdentity<T>(conversationId: string | undefined, run: () => T): T {
  if (conversationId === undefined || conversationId.length === 0) return run();
  return conversationScope.run(conversationId, run);
}

export function withoutConversationIdentity<T>(run: () => T): T {
  return conversationScope.run(NO_IDENTITY, run);
}

export function conversationIdentitySuppressed(): boolean {
  return conversationScope.getStore() === NO_IDENTITY;
}

export async function installBillionContextInline(
  options: InstallOptions,
): Promise<BillionContextInline> {
  if (installed !== undefined) return installed;

  process.env.BILI_PI_INLINE ??= "1";

  if (process.env.PORT === "0" && process.env.ACP_PORT === undefined) {
    process.env.ACP_PORT = "8787";
  }

  const hadChain = (globalThis as unknown as Record<symbol, unknown>)[INTERCEPT_FLAG] === true;
  if (hadChain) {
    console.warn(
      "[pi] billion-context: a native fetch chain was already installed; reusing it and wrapping it with the pi-ui identity header",
    );
  }

  if (process.env.NODE_TEST_CONTEXT !== undefined) {
    console.warn("[pi] billion-context: NODE_TEST_CONTEXT is set; inline engine disabled");
    installed = createDisabled(hadChain, options.currentPath);
    return installed;
  }

  if (process.env.BILLION_CONTEXT_PLUGIN === "0" || process.env.BILI_NATIVE_PI === "0") {
    console.warn(
      "[pi] billion-context: BILLION_CONTEXT_PLUGIN=0 or BILI_NATIVE_PI=0; inline engine disabled",
    );
    installed = createDisabled(hadChain, options.currentPath);
    return installed;
  }

  ensureBillionContextDirs();

  const inlineFetch = hadChain ? globalThis.fetch : await importPiNativeAndCaptureInlineFetch();
  let fallbackConversationId: string | undefined;
  let overrideConversationId: string | undefined;

  const currentConversationId = (): string | undefined => {
    const scoped = conversationScope.getStore();
    if (scoped === NO_IDENTITY) return undefined;
    return (
      scoped ??
      overrideConversationId ??
      readConversationId(options.currentPath) ??
      fallbackConversationId
    );
  };

  const observed: ObservedRequest[] = [];
  const modelMetadata: { model?: string; contextWindow?: number; maxOutput?: number } = {};
  const wrapped = createIdentityFetch(inlineFetch, currentConversationId, observed, modelMetadata);

  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    enumerable: true,
    writable: true,
    value: wrapped,
  });

  const baseUrl = (): string =>
    process.env.BILLION_CONTEXT_PROXY?.trim() || BILLION_CONTEXT_INLINE_ORIGIN;

  const bridge: BillionContextInline = {
    enabled: true,
    origin: BILLION_CONTEXT_INLINE_ORIGIN,
    hadChain,
    observed,
    fetch: wrapped,
    currentConversationId,
    setModelMetadata(metadata) {
      if (typeof metadata.model === "string" && metadata.model.length > 0) {
        modelMetadata.model = metadata.model;
      }
      if (isPositiveNumber(metadata.contextWindow)) {
        modelMetadata.contextWindow = Math.floor(metadata.contextWindow);
      }
      if (isPositiveNumber(metadata.maxOutput)) {
        modelMetadata.maxOutput = Math.floor(metadata.maxOutput);
      }
    },
    setConversationIdentity(conversationId) {
      overrideConversationId =
        conversationId === undefined || conversationId.length === 0 ? undefined : conversationId;
    },
    async registerIdentity(conversationId?: string): Promise<boolean> {
      const id = conversationId ?? currentConversationId();
      if (id === undefined || id.length === 0) {
        console.warn("[pi] billion-context: no conversation id to register yet");
        return false;
      }
      fallbackConversationId = id;
      try {
        const response = await wrapped(`${baseUrl()}/__bili/plugin/register`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ conversationId: id, agent: PLUGIN_AGENT, identity: true }),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return true;
      } catch (error) {
        const code = errorCode(error);
        if (
          code === "ECONNREFUSED" ||
          code === "ENOTFOUND" ||
          errorMessage(error).includes("404")
        ) {
          console.warn(
            `[pi] billion-context: identity registration unavailable (${errorMessage(error)}); model requests remain uncompressed`,
          );
        } else {
          console.warn(
            `[pi] billion-context: identity registration failed: ${errorMessage(error)}`,
          );
        }
        return false;
      }
    },
    async manifest(signal?: AbortSignal): Promise<readonly BiliToolDefinition[] | undefined> {
      try {
        const response = await wrapped(`${baseUrl()}/__bili/plugin/manifest`, {
          signal: signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const manifest: unknown = await response.json();
        return biliToolsFromManifest(manifest);
      } catch (error) {
        console.warn(`[pi] billion-context: manifest unavailable: ${errorMessage(error)}`);
        return undefined;
      }
    },
    async status(conversationId: string, signal?: AbortSignal): Promise<BiliStatus | undefined> {
      try {
        const url = `${baseUrl()}/__bili/plugin/status?conversationId=${encodeURIComponent(conversationId)}`;
        const response = await wrapped(url, {
          signal: signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (!response.ok) return undefined;
        const value: unknown = await response.json();
        return isRecord(value) ? (value as BiliStatus) : undefined;
      } catch {
        return undefined;
      }
    },
    async callTool(
      conversationId: string,
      tool: string,
      args: unknown,
      signal?: AbortSignal,
    ): Promise<BiliToolResult> {
      const response = await wrapped(`${baseUrl()}/__bili/plugin/tool`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ conversationId, tool, args: args ?? {} }),
        signal: signal ?? AbortSignal.timeout(60_000),
      });
      const value: unknown = await response.json().catch(() => undefined);
      if (!response.ok || !isRecord(value) || value.ok !== true) {
        const detail = isRecord(value) && typeof value.error === "string" ? value.error : "";
        throw new Error(
          `bili tool ${tool} failed (${response.status})${detail.length > 0 ? `: ${detail}` : ""}`,
        );
      }
      const text =
        typeof value.result === "string"
          ? value.result
          : value.result === undefined
            ? ""
            : JSON.stringify(value.result);
      return {
        text,
        failed: value.outcome === "failure" || value.outcome === "refused",
      };
    },
  };

  installed = bridge;
  return bridge;
}

function createDisabled(hadChain: boolean, currentPath: string): BillionContextInline {
  const noTools = async (): Promise<undefined> => undefined;
  let overrideConversationId: string | undefined;
  return {
    enabled: false,
    origin: BILLION_CONTEXT_INLINE_ORIGIN,
    hadChain,
    observed: [],
    fetch: globalThis.fetch,
    currentConversationId: () =>
      conversationIdentitySuppressed()
        ? undefined
        : (overrideConversationId ?? readConversationId(currentPath)),
    setModelMetadata: () => {},
    setConversationIdentity(conversationId) {
      overrideConversationId =
        conversationId === undefined || conversationId.length === 0 ? undefined : conversationId;
    },
    registerIdentity: async () => false,
    manifest: noTools,
    status: async () => undefined,
    callTool: async () => {
      throw new Error("billion-context is disabled");
    },
  };
}

async function importPiNativeAndCaptureInlineFetch(): Promise<typeof globalThis.fetch> {
  const captures: Array<typeof globalThis.fetch> = [];
  const realDefineProperty = Object.defineProperty;

  Object.defineProperty = function definePropertyCapturingFetch(
    target: object,
    property: PropertyKey,
    attributes: PropertyDescriptor,
  ): object {
    const result = realDefineProperty(target, property, attributes);
    if (target === globalThis && property === "fetch" && typeof attributes.get === "function") {
      try {
        const candidate: unknown = attributes.get();
        if (typeof candidate === "function") captures.push(candidate as typeof globalThis.fetch);
      } catch {}
    }
    return result;
  } as typeof Object.defineProperty;

  try {
    const require = createRequire(import.meta.url);
    const packageJson = require.resolve("billion-context/package.json");
    const entry = join(dirname(packageJson), "dist", "agent", "pi-native.js");
    await import(pathToFileURL(entry).href);
  } finally {
    Object.defineProperty = realDefineProperty;
  }

  const inlineFetch =
    captures[0] ??
    ((globalThis as unknown as Record<symbol, unknown>)[INTERCEPT_FLAG] === true
      ? globalThis.fetch
      : undefined);
  if (inlineFetch === undefined) {
    throw new Error("billion-context did not install its inline fetch transport");
  }
  return inlineFetch;
}

export function createIdentityFetch(
  inlineFetch: typeof globalThis.fetch,
  currentConversationId: () => string | undefined,
  observed: ObservedRequest[],
  modelMetadata: {
    readonly model?: string;
    readonly contextWindow?: number;
    readonly maxOutput?: number;
  },
): typeof globalThis.fetch {
  return async function piUiBillionContextFetch(input, init) {
    const url = fetchUrlOf(input);
    if (url === undefined) return inlineFetch(input, init);

    const inline = url.startsWith(`${BILLION_CONTEXT_INLINE_ORIGIN}/`);
    const model = !inline && isModelApiUrl(url);
    if (!inline && !model) return inlineFetch(input, init);

    if (conversationIdentitySuppressed()) return inlineFetch(input, init);

    const conversationId = currentConversationId();
    const identity: Record<string, string> = {
      "x-bili-plugin": PLUGIN_AGENT,
      "x-bili-plugin-agent": PLUGIN_AGENT,
    };
    if (conversationId !== undefined) identity["x-bili-plugin-conversation"] = conversationId;
    if (model) {
      if (modelMetadata.model !== undefined) {
        identity[PLUGIN_MODEL_HEADER] = modelMetadata.model;
      }
      if (modelMetadata.contextWindow !== undefined) {
        identity[PLUGIN_CONTEXT_WINDOW_HEADER] = String(modelMetadata.contextWindow);
      }
      if (modelMetadata.maxOutput !== undefined) {
        identity[PLUGIN_MAX_OUTPUT_HEADER] = String(modelMetadata.maxOutput);
      }
    }

    const targetUrl = model ? `${BILLION_CONTEXT_INLINE_ORIGIN}/bili/${url}` : url;
    const targeted = model ? withUrl(input, init, targetUrl) : { input, init };
    const stamped = withHeaders(targeted.input, targeted.init, identity);

    observed.push({
      url: targetUrl,
      method: fetchMethodOf(input, init),
      conversationId,
      conversationHeader: identity["x-bili-plugin-conversation"],
    });
    if (observed.length > MAX_OBSERVED_REQUESTS) observed.shift();

    return inlineFetch(stamped.input, stamped.init);
  };
}

function isPositiveNumber(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function biliToolsFromManifest(manifest: unknown): readonly BiliToolDefinition[] | undefined {
  if (!isRecord(manifest) || !isRecord(manifest.tools)) return undefined;
  const anthropic = manifest.tools.anthropic;
  if (!Array.isArray(anthropic)) return undefined;

  const tools: BiliToolDefinition[] = [];
  for (const entry of anthropic) {
    if (!isRecord(entry) || typeof entry.name !== "string" || entry.name.length === 0) continue;
    tools.push({
      name: entry.name,
      description: typeof entry.description === "string" ? entry.description : undefined,
      inputSchema: entry.input_schema ??
        entry.inputSchema ??
        entry.parameters ?? { type: "object", properties: {} },
    });
  }
  return tools.length > 0 ? tools : undefined;
}

function ensureBillionContextDirs(): void {
  if (
    process.env.XDG_CONFIG_HOME !== undefined ||
    process.env.XDG_DATA_HOME !== undefined ||
    process.env.XDG_STATE_HOME !== undefined
  ) {
    return;
  }

  try {
    accessSync(homedir(), constants.W_OK);
    return;
  } catch {}

  const agentDir = process.env.PI_CODING_AGENT_DIR?.trim();
  if (agentDir === undefined || agentDir.length === 0) return;
  try {
    mkdirSync(agentDir, { recursive: true });
    accessSync(agentDir, constants.W_OK);
  } catch {
    return;
  }

  const base = join(agentDir, "billion-context");
  process.env.XDG_CONFIG_HOME = join(base, "config");
  process.env.XDG_DATA_HOME = join(base, "data");
  process.env.XDG_STATE_HOME = join(base, "state");
  console.warn(`[pi] billion-context: $HOME is not writable; using ${base} for engine state`);
}

const BILI_IDENTITY_FILE = "bili-identity.json";

export function biliIdentityForHead(
  currentPath: string,
  durableId: string,
  headMarkerId: string,
): string {
  const path = join(dirname(currentPath), BILI_IDENTITY_FILE);
  const existing = readBiliIdentity(path);
  if (
    existing !== undefined &&
    existing.durableId === durableId &&
    existing.headMarkerId === headMarkerId &&
    existing.biliId.length > 0
  ) {
    return existing.biliId;
  }
  const biliId = `${durableId}@${headMarkerId}`;
  try {
    writeFileSync(path, `${JSON.stringify({ durableId, headMarkerId, biliId })}\n`);
  } catch (error) {
    console.warn(
      `[pi] billion-context: could not store the conversation identity: ${errorMessage(error)}`,
    );
  }
  return biliId;
}

function readBiliIdentity(
  path: string,
): { durableId: string; headMarkerId: string; biliId: string } | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isRecord(parsed)) return undefined;
    const { durableId, headMarkerId, biliId } = parsed;
    if (
      typeof durableId !== "string" ||
      typeof headMarkerId !== "string" ||
      typeof biliId !== "string"
    ) {
      return undefined;
    }
    return { durableId, headMarkerId, biliId };
  } catch {
    return undefined;
  }
}

function readConversationId(path: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isRecord(parsed)) return undefined;
    const value = parsed.conversationId;
    if (typeof value === "string" && value.length > 0) return value;
    if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  } catch {}
  return undefined;
}

function isModelApiUrl(url: string): boolean {
  if (!/^https?:\/\//i.test(url)) return false;
  if (url.includes("/__bili/") || url.includes("/__acp/")) return false;
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split("/").filter((segment) => segment.length > 0);
    if (segments[0] === "bili") return false;
    const pathname = parsed.pathname.replace(/\/+$/, "");
    return MODEL_API_SUFFIX.test(pathname);
  } catch {
    return false;
  }
}

function fetchUrlOf(input: Parameters<typeof fetch>[0]): string | undefined {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  if (input instanceof Request) return input.url;
  return undefined;
}

function fetchMethodOf(input: Parameters<typeof fetch>[0], init?: RequestInit): string {
  if (typeof init?.method === "string") return init.method.toUpperCase();
  if (input instanceof Request) return input.method.toUpperCase();
  return "GET";
}

function withUrl(
  input: Parameters<typeof fetch>[0],
  init: RequestInit | undefined,
  url: string,
): { input: Parameters<typeof fetch>[0]; init: RequestInit | undefined } {
  if (input instanceof Request) {
    return { input: new Request(url, input), init };
  }
  return { input: url, init };
}

function withHeaders(
  input: Parameters<typeof fetch>[0],
  init: RequestInit | undefined,
  extra: Record<string, string>,
): { input: Parameters<typeof fetch>[0]; init: RequestInit | undefined } {
  if (Object.keys(extra).length === 0) return { input, init };

  if (input instanceof Request) {
    try {
      for (const [name, value] of Object.entries(extra)) input.headers.set(name, value);
      if (init?.headers === undefined) return { input, init };
    } catch {}
  }

  if (init?.headers !== undefined) {
    const headers = new Headers(init.headers);
    for (const [name, value] of Object.entries(extra)) headers.set(name, value);
    return { input, init: { ...init, headers } };
  }
  return { input, init: { ...init, headers: extra } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | undefined {
  if (isRecord(error) && typeof error.code === "string") return error.code;
  if (isRecord(error) && isRecord(error.cause) && typeof error.cause.code === "string") {
    return error.cause.code;
  }
  return undefined;
}
