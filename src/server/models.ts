import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { getAgentDir, ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ModelOption } from "../shared/types.js";

export interface ModelCatalog {
  readonly runtime: ModelRuntime;
  readonly agentDir: string;
  readonly model: Model<Api> | undefined;
}

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

export function modelOption(model: Model<Api>): ModelOption {
  return {
    provider: model.provider,
    id: model.id,
    name: model.name.length > 0 ? model.name : model.id,
  };
}

export interface ModelCatalogReload {
  readonly models: readonly ModelOption[];
  readonly added: readonly ModelOption[];
  readonly removed: readonly ModelOption[];
  readonly errors: readonly string[];
}

export async function reloadModelCatalog(runtime: ModelRuntime): Promise<ModelCatalogReload> {
  const before = await listAvailableModels(runtime);
  const result = await runtime.refresh({ allowNetwork: false });
  const after = await listAvailableModels(runtime);
  const beforeKeys = new Set(before.map((model) => `${model.provider}/${model.id}`));
  const afterKeys = new Set(after.map((model) => `${model.provider}/${model.id}`));
  return {
    models: after,
    added: after.filter((model) => !beforeKeys.has(`${model.provider}/${model.id}`)),
    removed: before.filter((model) => !afterKeys.has(`${model.provider}/${model.id}`)),
    errors: [...result.errors].map(
      ([provider, error]) =>
        `${provider}: ${error instanceof Error ? error.message : String(error)}`,
    ),
  };
}

export async function listAvailableModels(runtime: ModelRuntime): Promise<ModelOption[]> {
  const available = await runtime.getAvailable();
  const seen = new Set<string>();
  const models: ModelOption[] = [];
  for (const model of available) {
    const key = `${model.provider}/${model.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    models.push(modelOption(model));
  }
  models.sort(
    (left, right) =>
      left.provider.localeCompare(right.provider) ||
      left.name.localeCompare(right.name) ||
      left.id.localeCompare(right.id),
  );
  return models;
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
