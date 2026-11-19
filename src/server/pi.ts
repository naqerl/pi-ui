import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { TASK_ID_PARAM } from "./task-attribution.js";

const TOOLS = ["read", "bash", "edit", "write"];

export async function buildPiSystemPrompt(
  cwd: string,
  modelRuntime: ModelRuntime,
  tools: readonly string[] = TOOLS,
): Promise<string> {
  const agentDir = getAgentDir();
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,

    noExtensions: true,
    disabledBuiltinExtensions: ["mcp", "codemode", "tool_search"],
  });
  await resourceLoader.reload();

  const sessionManager = SessionManager.inMemory(cwd, {});
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    sessionManager,
    resourceLoader,
    modelRuntime,
    tools: [...tools],
  });

  try {
    return session.systemPrompt;
  } finally {
    session.dispose();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function formatToolArguments(value: unknown): string {
  if (value === undefined) return "{}";

  if (isRecord(value) && TASK_ID_PARAM in value) {
    const { [TASK_ID_PARAM]: _tag, ...rest } = value;
    value = rest;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function formatToolResult(result: unknown): string {
  if (typeof result === "string") return result;
  if (isRecord(result) && Array.isArray(result.content)) {
    const parts: string[] = [];
    for (const block of result.content) {
      if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
        parts.push(block.text);
      }
    }
    if (parts.length > 0) return parts.join("\n");
  }
  if (isRecord(result) && typeof result.output === "string") return result.output;
  if (isRecord(result) && Array.isArray(result.output)) return formatToolResult(result.output);
  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return String(result);
  }
}

export function formatToolDetails(details: unknown): string | undefined {
  if (details === undefined || details === null) return undefined;
  if (typeof details === "string") return details;
  try {
    return JSON.stringify(details, null, 2);
  } catch {
    return String(details);
  }
}
