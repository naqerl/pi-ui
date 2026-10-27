import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { getAgentDir, ModelRuntime } from "@earendil-works/pi-coding-agent";

export interface ModelCatalog {
  readonly runtime: ModelRuntime;
  readonly agentDir: string;
  readonly model: Model<Api> | undefined;
}

/**
 * Build the same model catalog pi uses. This follows the installed coding agent's
 * `dist/core/model-runtime.js`: `ModelRuntime.create()` reads `auth.json` from
 * `PI_CODING_AGENT_DIR` (default `~/.pi/agent`), applies optional
 * `models-store.json` overrides and `models.json` provider config, and composes
 * the built-in pi-ai provider catalog. `PI_OFFLINE` disables catalog refreshes.
 */
export async function createModelCatalog(): Promise<ModelCatalog> {
  const agentDir = getAgentDir();
  const runtime = await ModelRuntime.create();
  const available = await runtime.getAvailable();
  const model = selectModel(runtime, available);

  if (available.length === 0) {
    console.warn(
      `[pi] no model credentials found in ${join(agentDir, "auth.json")}; ` +
        "the server will start, but model requests will fail until credentials are configured",
    );
  }

  if (model === undefined) {
    console.warn("[pi] no model is available; model requests will fail until one is configured");
  } else if (!runtime.hasConfiguredAuth(model.provider)) {
    console.warn(
      `[pi] ${model.provider}/${model.id} has no credentials in ${join(agentDir, "auth.json")}; ` +
        "model requests will fail with an authentication error",
    );
  } else {
    console.log(`[pi] model: ${model.provider}/${model.id}`);
  }

  const modelError = runtime.getError();
  if (modelError) console.warn(`[pi] model catalog: ${modelError}`);

  return { runtime, agentDir, model };
}

function selectModel(
  runtime: ModelRuntime,
  available: readonly Model<Api>[],
): Model<Api> | undefined {
  const provider = process.env.PI_PROVIDER?.trim();
  const requested = process.env.PI_MODEL?.trim();

  if (requested) {
    const found = findRequestedModel(runtime, requested, provider);
    if (found) return found;
    console.warn(
      `[pi] PI_MODEL="${requested}"${provider ? ` for provider ${provider}` : ""} not found in the catalog`,
    );
  }

  if (provider) {
    const fromProvider = (available.length > 0 ? available : runtime.getModels()).find(
      (candidate) => candidate.provider === provider,
    );
    if (fromProvider) return fromProvider;
    console.warn(`[pi] no model found for PI_PROVIDER="${provider}"`);
  }

  // pi's fallback is the first available model with valid credentials. Without
  // credentials, keeping the first catalog model lets the provider produce the
  // real authentication error instead of failing before a request is made.
  return available[0] ?? runtime.getModels()[0];
}

function findRequestedModel(
  runtime: ModelRuntime,
  requested: string,
  provider: string | undefined,
): Model<Api> | undefined {
  if (provider) {
    const direct = runtime.getModel(provider, requested);
    if (direct) return direct;
  }

  const slash = requested.indexOf("/");
  if (slash > 0) {
    const direct = runtime.getModel(requested.slice(0, slash), requested.slice(slash + 1));
    if (direct) return direct;
  }

  const matches = runtime.getModels().filter((model) => model.id === requested);
  return matches.find((model) => model.provider === provider) ?? matches[0];
}
