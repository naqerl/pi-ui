import { join } from "node:path";

export const BOT_TOOL_CATALOG = [
  "read",
  "propose_task",
  "task_list",
  "task_proposals",
  "task_view",
  "task_depends",
  "task_done",
  "task_reopen",
  "task_working",
  "task_release",
  "task_edit",
  "task_block",
] as const;

export type BotToolName = (typeof BOT_TOOL_CATALOG)[number];

const BOT_TOOL_SET: ReadonlySet<string> = new Set(BOT_TOOL_CATALOG);

export function isBotToolName(name: string): name is BotToolName {
  return BOT_TOOL_SET.has(name);
}

export interface BotSeed {
  readonly id: string;
  readonly name: string;
  readonly systemPrompt: string;
  readonly tools: readonly string[];
  readonly model?: string;
}

export const JOB_HUNTER_TOOLS = ["propose_task", "task_list", "task_view"] as const;

export const JOB_HUNTER_PROMPT = `You are Job hunter, a bot that finds worthwhile work in this repository and proposes it as tasks for the operator to approve.

Read the ledger with task_list, and open a task with task_view when its title is not enough. Look for real, unfinished work: a failing check, a missing test, a stale document, a small repair that makes the product work better. Prefer a few concrete proposals over a long speculative list.

Use propose_task with the complete prompt for one unit of work. The prompt is the task body and must stand on its own: say what to change, where, and how to tell it worked. Do not propose the same work twice, and do not propose something the ledger already covers.

You may call propose_task only to write. Never claim a task was approved, started, completed or assigned; the operator approves and runs it from the tasks page. Answer with a short summary of what you proposed and why.`;

export const DEFAULT_BOTS: readonly BotSeed[] = [
  {
    id: "job-hunter",
    name: "Job hunter",
    systemPrompt: JOB_HUNTER_PROMPT,
    tools: [...JOB_HUNTER_TOOLS],
  },
];

export interface BotChatPaths {
  readonly dir: string;
  readonly databasePath: string;
  readonly currentPath: string;
  readonly identity: string;
}

export function botChatPaths(dataDir: string, botId: string): BotChatPaths {
  const dir = join(dataDir, "bots", botId);
  return {
    dir,
    databasePath: join(dir, "pi.sqlite3"),
    currentPath: join(dir, "current.json"),
    identity: botConversationIdentity(botId),
  };
}

export function botConversationIdentity(botId: string): string {
  return `bot:${botId}`;
}
