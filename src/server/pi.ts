import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  type SessionEntry,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

const TOOLS = ["read", "bash", "edit", "write"];

export type PiSession = Awaited<ReturnType<typeof createAgentSession>>["session"];

function findModel(session: PiSession, spec: string) {
  const runtime = session.modelRuntime;
  const slash = spec.indexOf("/");
  if (slash > 0) {
    return runtime.getModel(spec.slice(0, slash), spec.slice(slash + 1));
  }

  const models = runtime.getModels().filter((model) => model.id === spec);
  const currentProvider = session.model?.provider;
  return models.find((model) => model.provider === currentProvider) ?? models[0];
}

export async function createPiSession(cwd: string, history: SessionEntry[]): Promise<PiSession> {
  const agentDir = getAgentDir();
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    noExtensions: true,
    disabledBuiltinExtensions: ["mcp", "codemode", "tool_search"],
  });
  await resourceLoader.reload();

  const sessionManager = SessionManager.inMemory(cwd, {}, history);
  const { session, modelFallbackMessage } = await createAgentSession({
    cwd,
    agentDir,
    sessionManager,
    resourceLoader,
    tools: TOOLS,
  });

  if (modelFallbackMessage) {
    console.warn(`[pi] ${modelFallbackMessage}`);
  }

  const requestedModel = process.env.PI_MODEL?.trim();
  if (requestedModel) {
    const model = findModel(session, requestedModel);
    if (!model) {
      console.warn(`[pi] PI_MODEL="${requestedModel}" not found; using the configured default`);
    } else if (session.model?.provider === model.provider && session.model.id === model.id) {
      // Already the resolved default for this environment.
    } else {
      try {
        await session.setModel(model);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        console.warn(`[pi] could not select PI_MODEL="${requestedModel}": ${reason}`);
      }
    }
  }

  return session;
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
  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return String(result);
  }
}
