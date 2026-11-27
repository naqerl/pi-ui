import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { BotInput, BotPatch } from "./bot-body.js";
import { type BotSeed, DEFAULT_BOTS, isBotToolName } from "./bot-defaults.js";
import { BotError, DuplicateBotIdError, UnknownBotError } from "./bot-error.js";

export interface BotDefinition {
  readonly id: string;
  readonly name: string;
  readonly systemPrompt: string;
  readonly tools: readonly string[];
  readonly model?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface BotStoreOptions {
  readonly now?: () => Date;
  /** Bots written to a fresh file. Defaults to the shipped Job hunter. */
  readonly seed?: readonly BotSeed[];
  /**
   * Runs after the complete document is on disk and before its rename. Tests use
   * it to fail a write at the last moment and prove the old document survives.
   */
  readonly beforeRename?: () => void | Promise<void>;
}

const BOT_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const NAME_MAX = 80;
const PROMPT_MAX = 100_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function clone(bot: BotDefinition): BotDefinition {
  return { ...bot, tools: [...bot.tools] };
}

function errorCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === "string" ? error.code : undefined;
}

/**
 * Write a complete JSON document beside its destination, then rename it into
 * place. A reader therefore sees the old document or the new one, never a
 * half-written mix, and a failed write leaves the destination untouched.
 */
export async function writeJsonAtomic(
  path: string,
  text: string,
  options: { beforeRename?: () => void | Promise<void> } = {},
): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(temporary, text, "utf8");
    await options.beforeRename?.();
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

function normalizeId(value: string): string {
  const id = value.trim().toLowerCase();
  if (!BOT_ID.test(id)) {
    throw new BotError(
      "A bot id must be 1-64 lowercase letters, digits, hyphens or underscores",
      400,
      "invalid-id",
    );
  }
  return id;
}

function normalizeName(value: string): string {
  const name = value.trim();
  if (name.length === 0) throw new BotError("A bot name is required", 400, "invalid-bot");
  if (name.length > NAME_MAX) {
    throw new BotError(`A bot name must be at most ${NAME_MAX} characters`, 400, "invalid-bot");
  }
  return name;
}

function normalizePrompt(value: string): string {
  const prompt = value.trim();
  if (prompt.length === 0) throw new BotError("A system prompt is required", 400, "invalid-bot");
  if (prompt.length > PROMPT_MAX) {
    throw new BotError(
      `A system prompt must be at most ${PROMPT_MAX} characters`,
      400,
      "invalid-bot",
    );
  }
  return prompt;
}

function normalizeTools(value: readonly string[]): string[] {
  const tools: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item.trim().length === 0) {
      throw new BotError("Every tool must be a non-empty name", 400, "invalid-bot");
    }
    const name = item.trim();
    if (!isBotToolName(name)) {
      throw new BotError(`Unknown bot tool "${name}"`, 400, "unknown-tool");
    }
    if (!tools.includes(name)) tools.push(name);
  }
  return tools;
}

function normalizeModel(value: string | null | undefined): string | undefined {
  if (value === undefined || value === null) return undefined;
  const model = value.trim();
  return model.length === 0 ? undefined : model;
}

interface NormalizedInput {
  readonly id?: string;
  readonly name: string;
  readonly systemPrompt: string;
  readonly tools: string[];
  readonly model?: string;
}

function normalizeInput(input: BotInput): NormalizedInput {
  const model = normalizeModel(input.model);
  return {
    ...(input.id === undefined ? {} : { id: normalizeId(input.id) }),
    name: normalizeName(input.name),
    systemPrompt: normalizePrompt(input.systemPrompt),
    tools: normalizeTools(input.tools),
    ...(model === undefined ? {} : { model }),
  };
}

function idFromName(name: string, existing: ReadonlySet<string>): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "bot";
  if (!existing.has(base)) return base;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!existing.has(candidate)) return candidate;
  }
}

function readStoredDefinition(value: unknown): BotDefinition | undefined {
  if (!isRecord(value)) return undefined;
  if (
    typeof value.id !== "string" ||
    typeof value.name !== "string" ||
    typeof value.systemPrompt !== "string" ||
    !Array.isArray(value.tools)
  ) {
    return undefined;
  }
  let id: string;
  let name: string;
  let systemPrompt: string;
  try {
    id = normalizeId(value.id);
    name = normalizeName(value.name);
    systemPrompt = normalizePrompt(value.systemPrompt);
  } catch {
    return undefined;
  }
  const tools = value.tools
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => item.trim());
  const createdAt =
    typeof value.createdAt === "string" ? value.createdAt : new Date().toISOString();
  const updatedAt = typeof value.updatedAt === "string" ? value.updatedAt : createdAt;
  return {
    id,
    name,
    systemPrompt,
    tools: [...new Set(tools)],
    ...(typeof value.model === "string" && value.model.length > 0 ? { model: value.model } : {}),
    createdAt,
    updatedAt,
  };
}

/**
 * The bot ledger: one JSON document, written whole and atomically. Every
 * mutation is serialized, so two concurrent creates cannot both claim one id.
 */
export class BotStore {
  private bots: BotDefinition[] = [];
  private chain: Promise<unknown> = Promise.resolve();
  private readonly now: () => Date;
  private readonly seed: readonly BotSeed[];
  private readonly beforeRename: (() => void | Promise<void>) | undefined;

  constructor(
    private readonly file: string,
    options: BotStoreOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.seed = options.seed ?? DEFAULT_BOTS;
    this.beforeRename = options.beforeRename;
  }

  /** Read bots.json, or write the shipped definitions when it does not exist yet. */
  async load(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.file, "utf8");
    } catch (error) {
      if (errorCode(error) !== "ENOENT") {
        console.error("[pi] bots.json could not be read; starting with no bots", error);
        return;
      }
      const stamp = this.stamp();
      this.bots = this.seed.map((seed) => {
        const model = normalizeModel(seed.model);
        return {
          id: normalizeId(seed.id),
          name: normalizeName(seed.name),
          systemPrompt: normalizePrompt(seed.systemPrompt),
          tools: normalizeTools(seed.tools),
          ...(model === undefined ? {} : { model }),
          createdAt: stamp,
          updatedAt: stamp,
        };
      });
      await this.persist(this.bots);
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      console.error("[pi] bots.json is not valid JSON; starting with no bots", error);
      return;
    }
    const items = isRecord(parsed) && Array.isArray(parsed.bots) ? parsed.bots : [];
    const bots: BotDefinition[] = [];
    for (const item of items) {
      const bot = readStoredDefinition(item);
      if (bot === undefined) {
        console.error("[pi] bots.json: skipped a malformed bot");
        continue;
      }
      if (bots.some((existing) => existing.id === bot.id)) {
        console.error(`[pi] bots.json: skipped duplicate bot id "${bot.id}"`);
        continue;
      }
      bots.push(bot);
    }
    this.bots = bots;
  }

  list(): BotDefinition[] {
    return this.bots.map(clone);
  }

  get(id: string): BotDefinition | undefined {
    const key = id.trim().toLowerCase();
    const bot = this.bots.find((item) => item.id === key);
    return bot === undefined ? undefined : clone(bot);
  }

  create(input: BotInput): Promise<BotDefinition> {
    return this.serialized(async () => {
      const normalized = normalizeInput(input);
      const id =
        normalized.id ?? idFromName(normalized.name, new Set(this.bots.map((item) => item.id)));
      if (this.bots.some((item) => item.id === id)) throw new DuplicateBotIdError(id);
      const stamp = this.stamp();
      const bot: BotDefinition = {
        id,
        name: normalized.name,
        systemPrompt: normalized.systemPrompt,
        tools: normalized.tools,
        ...(normalized.model === undefined ? {} : { model: normalized.model }),
        createdAt: stamp,
        updatedAt: stamp,
      };
      const next = [...this.bots, bot];
      await this.persist(next);
      this.bots = next;
      return clone(bot);
    });
  }

  update(id: string, patch: BotPatch): Promise<BotDefinition> {
    return this.serialized(async () => {
      const key = id.trim().toLowerCase();
      const index = this.bots.findIndex((item) => item.id === key);
      if (index < 0) throw new UnknownBotError(key);
      const current = this.bots[index] as BotDefinition;
      if (patch.id !== undefined && normalizeId(patch.id) !== current.id) {
        throw new BotError("A bot's id cannot change", 400, "id-immutable");
      }
      const model =
        patch.model === undefined ? current.model : (normalizeModel(patch.model) ?? undefined);
      const next: BotDefinition = {
        id: current.id,
        name: patch.name === undefined ? current.name : normalizeName(patch.name),
        systemPrompt:
          patch.systemPrompt === undefined
            ? current.systemPrompt
            : normalizePrompt(patch.systemPrompt),
        tools: patch.tools === undefined ? [...current.tools] : normalizeTools(patch.tools),
        ...(model === undefined ? {} : { model }),
        createdAt: current.createdAt,
        updatedAt: this.stamp(),
      };
      const copy = this.bots.slice();
      copy[index] = next;
      await this.persist(copy);
      this.bots = copy;
      return clone(next);
    });
  }

  private stamp(): string {
    const date = this.now();
    return Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString();
  }

  private serialized<T>(work: () => Promise<T>): Promise<T> {
    const run = this.chain.then(work, work);
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private persist(bots: readonly BotDefinition[]): Promise<void> {
    const text = `${JSON.stringify(
      { version: 1, bots: bots.map((bot) => ({ ...bot, tools: [...bot.tools] })) },
      null,
      2,
    )}\n`;
    return writeJsonAtomic(this.file, text, {
      ...(this.beforeRename === undefined ? {} : { beforeRename: this.beforeRename }),
    });
  }
}
