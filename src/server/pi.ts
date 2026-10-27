import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

const TOOLS = ["read", "bash", "edit", "write"];

/**
 * Build the system prompt with the same coding-agent path as before the move to
 * pi-durable, then keep it as the conversation's durable `instructions`.
 *
 * `src/server/pi.ts` previously let `createAgentSession` build this prompt. The
 * durable harness renders instructions as the final prompt section, so only the
 * session layer changed; the prompt text still comes from the installed coding
 * agent and includes its tool descriptions, docs pointers, cwd, project context,
 * and skills.
 */
export async function buildPiSystemPrompt(
  cwd: string,
  modelRuntime: ModelRuntime,
): Promise<string> {
  const agentDir = getAgentDir();
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    // The durable registry owns tools now. No coding-agent extensions, MCP, or
    // codemode are loaded into this prompt-building session.
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
    tools: TOOLS,
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
