import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  type Conversation,
  type ConversationId,
  createRegistry,
  defineExtension,
  type Harness,
  Harness as HarnessImpl,
  type ModelRef,
  type Submission,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { ActivityItem, BotSummary, ChatMessage } from "../shared/types.js";
import { withConversationIdentity } from "./billion-context.js";
import { botChatPaths, botConversationIdentity } from "./bot-defaults.js";
import { BotError } from "./bot-error.js";
import { createBotToolGuard } from "./bot-guard.js";
import { botTools } from "./bot-tools.js";
import type { BotDefinition, BotStore } from "./bots.js";
import { buildTranscript, readTranscriptEntries, SESSION_CONTEXT } from "./session.js";
import { taskAgentHarnessSettings } from "./task-agent.js";
import type { TaskBridge } from "./task-tools.js";

export interface BotChatSnapshot {
  readonly botId: string;
  readonly messages: ChatMessage[];
  readonly activity: ActivityItem[];
  readonly running: boolean;
  /** The last failed answer, until the next successful turn. */
  readonly error?: string;
}

export interface BotChatManagerOptions {
  readonly dataDir: string;
  readonly cwd: string;
  readonly bots: BotStore;
  /** The ledger tools and the proposal submitter a bot may be granted. */
  readonly tasks: TaskBridge;
  readonly models: ModelRuntime;
  readonly model?: Model<Api>;
  /** Called when a bot's working state or newest message changes. */
  readonly onChange?: () => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** The newest non-empty row, so one blank error row cannot hide the last real message. */
function newestMessageText(messages: readonly ChatMessage[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const text = messages[index]?.text.trim() ?? "";
    if (text !== "") return text;
  }
  return null;
}

async function readConversationId(path: string): Promise<ConversationId | undefined> {
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
  try {
    const value: unknown = JSON.parse(contents);
    if (
      isRecord(value) &&
      typeof value.conversationId === "number" &&
      Number.isSafeInteger(value.conversationId) &&
      value.conversationId > 0
    ) {
      return value.conversationId as ConversationId;
    }
  } catch {
    // Replace a malformed pointer on the next create.
  }
  return undefined;
}

async function writeConversationId(path: string, conversationId: ConversationId): Promise<void> {
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify({ conversationId })}\n`, "utf8");
  await rename(temporary, path);
}

/** One bot's durable conversation, with its own system prompt and tool allowance. */
class BotChatSession {
  private running = false;
  private error: string | undefined;
  private lastMessage: string | null;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly bot: BotDefinition,
    private readonly harness: Harness,
    private readonly conversation: Conversation,
    private readonly onChange: (summary: BotSummary) => void,
    lastMessage: string | null = null,
  ) {
    this.lastMessage = lastMessage;
  }

  async snapshot(): Promise<BotChatSnapshot> {
    const entries = await readTranscriptEntries(this.conversation);
    const built = buildTranscript(entries);
    this.lastMessage = newestMessageText(built.messages);
    this.onChange(this.summary());
    return {
      botId: this.bot.id,
      messages: built.messages,
      activity: built.activity,
      running: this.running,
      ...(this.error === undefined ? {} : { error: this.error }),
    };
  }

  private summary(): BotSummary {
    return {
      id: this.bot.id,
      name: this.bot.name,
      lastMessage: this.lastMessage,
      working: this.running,
    };
  }

  /** Place one message and return the snapshot; the answer settles in the background. */
  send(text: string): Promise<BotChatSnapshot> {
    const work = this.chain.then(
      () => this.start(text),
      () => this.start(text),
    );
    this.chain = work.then(
      () => undefined,
      () => undefined,
    );
    return work;
  }

  private async start(text: string): Promise<BotChatSnapshot> {
    const message = text.trim();
    if (message.length === 0) throw new BotError("Message text is required", 400, "invalid-body");
    if (this.running) throw new BotError("The bot is still answering", 409, "busy");
    this.running = true;
    this.error = undefined;
    this.onChange(this.summary());
    const identity = botConversationIdentity(this.bot.id);
    let submission: Submission;
    try {
      submission = await withConversationIdentity(identity, () =>
        this.conversation.submit(
          { type: "input", content: message, whenBusy: "followUp" },
          SESSION_CONTEXT,
        ),
      );
    } catch (error) {
      this.running = false;
      this.onChange(this.summary());
      throw error;
    }
    void this.settle(submission, identity);
    return this.snapshot();
  }

  private async settle(submission: Submission, identity: string): Promise<void> {
    try {
      const settled = await withConversationIdentity(identity, () =>
        submission.wait(SESSION_CONTEXT),
      );
      if (settled.status === "unanswered") {
        const detail =
          settled.detail === undefined
            ? ""
            : typeof settled.detail === "string"
              ? settled.detail
              : (JSON.stringify(settled.detail) ?? "");
        this.error = detail.length === 0 ? settled.reason : `${settled.reason}: ${detail}`;
      }
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    } finally {
      this.running = false;
      this.onChange(this.summary());
      await this.snapshot().catch(() => undefined);
    }
  }

  async close(): Promise<void> {
    await this.harness.close(SESSION_CONTEXT).catch(() => undefined);
  }
}

/**
 * Opens one agent core per bot on its own durable database, so a restart resumes
 * that bot's transcript and no bot can read another bot's conversation.
 */
export class BotChatManager {
  private readonly sessions = new Map<string, Promise<BotChatSession>>();
  private readonly known = new Map<string, BotSummary>();
  private readonly summaryDir: string;
  private readonly summaryPath: string;
  private writes: Promise<void> = Promise.resolve();

  constructor(private readonly options: BotChatManagerOptions) {
    this.summaryDir = join(options.dataDir, "bots");
    this.summaryPath = join(this.summaryDir, "summaries.json");
  }

  /** Restores newest messages persisted by an earlier process, before the dashboard reads. */
  async hydrate(): Promise<void> {
    await this.writes;
    let raw: string;
    try {
      raw = await readFile(this.summaryPath, "utf8");
    } catch (error) {
      if (!(isRecord(error) && error.code === "ENOENT")) {
        console.error("[bots] could not read persisted newest messages", error);
      }
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      console.error("[bots] persisted newest messages are not valid JSON", error);
      return;
    }
    const items = isRecord(parsed) && Array.isArray(parsed.bots) ? parsed.bots : [];
    for (const item of items) {
      if (!isRecord(item)) continue;
      const id = typeof item.id === "string" ? item.id.trim().toLowerCase() : "";
      const lastMessage = item.lastMessage;
      if (id === "" || (lastMessage !== null && typeof lastMessage !== "string")) continue;
      const bot = this.options.bots.get(id);
      if (bot === undefined) continue;
      this.known.set(bot.id, {
        id: bot.id,
        name: bot.name,
        lastMessage,
        working: false,
      });
    }
  }

  async snapshot(botId: string): Promise<BotChatSnapshot> {
    return (await this.session(botId)).snapshot();
  }

  /** Reads every open transcript so the dashboard's newest-message column is current. */
  async summaries(): Promise<BotSummary[]> {
    await Promise.all(
      [...this.sessions.values()].map(async (pending) => {
        const session = await pending.catch(() => undefined);
        await session?.snapshot().catch(() => undefined);
      }),
    );
    return this.briefs();
  }

  /** A synchronous view for dashboard broadcasts; open transcripts update it on snapshot. */
  briefs(): BotSummary[] {
    return this.options.bots.list().map((bot) => {
      const known = this.known.get(bot.id);
      return known === undefined
        ? { id: bot.id, name: bot.name, lastMessage: null, working: false }
        : { ...known, name: bot.name };
    });
  }

  async send(botId: string, text: string): Promise<BotChatSnapshot> {
    return (await this.session(botId)).send(text);
  }

  /** Drop a stale prompt/model/tool config; the next request reopens the same transcript. */
  async reconfigure(botId: string): Promise<void> {
    const key = botId.trim().toLowerCase();
    const pending = this.sessions.get(key);
    this.sessions.delete(key);
    if (pending === undefined) return;
    const session = await pending.catch(() => undefined);
    await session?.close();
  }

  async close(): Promise<void> {
    const pending = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(
      pending.map(async (item) => {
        const session = await item.catch(() => undefined);
        await session?.close();
      }),
    );
    await this.writes;
  }

  private remember(summary: BotSummary): void {
    const previous = this.known.get(summary.id);
    if (
      previous !== undefined &&
      previous.name === summary.name &&
      previous.lastMessage === summary.lastMessage &&
      previous.working === summary.working
    ) {
      return;
    }
    this.known.set(summary.id, summary);
    if (previous?.lastMessage !== summary.lastMessage) this.persist();
    this.options.onChange?.();
  }

  private persist(): void {
    const ids = new Set(this.options.bots.list().map((bot) => bot.id));
    const bots = [...this.known.values()]
      .filter(({ id }) => ids.has(id))
      .map(({ id, lastMessage }) => ({ id, lastMessage }));
    const payload = `${JSON.stringify({ version: 1, bots })}\n`;
    this.writes = this.writes
      .then(async () => {
        await mkdir(this.summaryDir, { recursive: true });
        const temporary = `${this.summaryPath}.tmp-${process.pid}`;
        await writeFile(temporary, payload, "utf8");
        await rename(temporary, this.summaryPath);
      })
      .catch((error: unknown) => {
        console.error("[bots] could not persist newest messages", error);
      });
  }

  private session(botId: string): Promise<BotChatSession> {
    const bot = this.options.bots.get(botId);
    if (bot === undefined) throw new BotError(`Unknown bot "${botId}"`, 404, "unknown-bot");
    const existing = this.sessions.get(bot.id);
    if (existing !== undefined) return existing;
    let opening: Promise<BotChatSession>;
    opening = this.open(bot).catch((error: unknown) => {
      if (this.sessions.get(bot.id) === opening) this.sessions.delete(bot.id);
      throw error;
    });
    this.sessions.set(bot.id, opening);
    return opening;
  }

  private modelOf(bot: BotDefinition): Model<Api> | undefined {
    if (bot.model === undefined) return this.options.model;
    const slash = bot.model.indexOf("/");
    if (slash > 0 && slash < bot.model.length - 1) {
      const found = this.options.models.getModel(
        bot.model.slice(0, slash),
        bot.model.slice(slash + 1),
      );
      if (found !== undefined) return found;
    }
    console.warn(`[bots] ${bot.id} names unknown model "${bot.model}"; using the default`);
    return this.options.model;
  }

  private async open(bot: BotDefinition): Promise<BotChatSession> {
    const paths = botChatPaths(this.options.dataDir, bot.id);
    await mkdir(paths.dir, { recursive: true });
    const storage = await openNodeSqliteStorage(paths.databasePath);
    const registry = createRegistry<ToolRegistration>();
    const tools = botTools(this.options.tasks);
    registry.install(defineExtension({ name: "bot-tools", tools }));
    registry.install(createBotToolGuard(bot));
    const resolved = this.modelOf(bot);
    const model: ModelRef | undefined =
      resolved === undefined ? undefined : { provider: resolved.provider, modelId: resolved.id };
    const harness = await HarnessImpl.open(
      storage,
      {
        models: this.options.models as unknown as Parameters<typeof HarnessImpl.open>[1]["models"],
        registry,
        env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? this.options.cwd }),
        settings: taskAgentHarnessSettings(process.env, resolved?.contextWindow),
        onReport: (report) => console.error(`[bots] harness report (${report.kind})`, report.error),
      },
      SESSION_CONTEXT,
    );
    try {
      const savedId = await readConversationId(paths.currentPath);
      let conversation: Conversation | undefined =
        savedId === undefined
          ? undefined
          : ((await harness.conversation(savedId, SESSION_CONTEXT)) ?? undefined);
      if (conversation === undefined) {
        conversation = await harness.createConversation(
          {
            ownership: { kind: "ownerless" },
            agent: {
              cwd: this.options.cwd,
              instructions: bot.systemPrompt,
              ...(model === undefined ? {} : { model }),
              tools,
            },
          },
          SESSION_CONTEXT,
        );
        await writeConversationId(paths.currentPath, conversation.id);
      } else {
        await conversation.configure(
          {
            cwd: this.options.cwd,
            instructions: bot.systemPrompt,
            ...(model === undefined ? {} : { model }),
            tools,
          },
          SESSION_CONTEXT,
        );
      }
      return new BotChatSession(
        bot,
        harness,
        conversation,
        (summary) => {
          this.remember(summary);
        },
        this.known.get(bot.id)?.lastMessage ?? null,
      );
    } catch (error) {
      await harness.close(SESSION_CONTEXT).catch(() => undefined);
      throw error;
    }
  }
}
