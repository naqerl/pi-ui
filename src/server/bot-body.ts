import { BotError } from "./bot-error.js";

export interface BotInput {
  readonly id?: string;
  readonly name: string;
  readonly systemPrompt: string;
  readonly tools: readonly string[];
  readonly model?: string | null;
}

export interface BotPatch {
  readonly id?: string;
  readonly name?: string;
  readonly systemPrompt?: string;
  readonly tools?: readonly string[];
  readonly model?: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new BotError(`${key} must be a string`, 400, "invalid-body");
  }
  return value;
}

function readTools(record: Record<string, unknown>): readonly string[] | undefined {
  const value = record.tools;
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new BotError("tools must be an array of strings", 400, "invalid-body");
  }
  return value as string[];
}

function readModel(record: Record<string, unknown>): string | null | undefined {
  const value = record.model;
  if (value === undefined || value === null) return value;
  if (typeof value !== "string") {
    throw new BotError("model must be a string or null", 400, "invalid-body");
  }
  return value;
}

function bodyRecord(body: unknown): Record<string, unknown> {
  if (!isRecord(body)) throw new BotError("Expected a JSON object", 400, "invalid-body");
  return body;
}

export function botInputFromBody(body: unknown): BotInput {
  const record = bodyRecord(body);
  const id = readField(record, "id");
  const name = readField(record, "name");
  const systemPrompt = readField(record, "systemPrompt");
  const tools = readTools(record);
  const model = readModel(record);
  return {
    ...(id === undefined ? {} : { id }),
    name: name ?? "",
    systemPrompt: systemPrompt ?? "",
    tools: tools ?? [],
    ...(model === undefined ? {} : { model }),
  };
}

export function botPatchFromBody(body: unknown): BotPatch {
  const record = bodyRecord(body);
  const id = readField(record, "id");
  const name = readField(record, "name");
  const systemPrompt = readField(record, "systemPrompt");
  const tools = readTools(record);
  const model = readModel(record);
  return {
    ...(id === undefined ? {} : { id }),
    ...(name === undefined ? {} : { name }),
    ...(systemPrompt === undefined ? {} : { systemPrompt }),
    ...(tools === undefined ? {} : { tools }),
    ...(model === undefined ? {} : { model }),
  };
}
