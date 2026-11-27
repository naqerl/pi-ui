export type BotErrorCode =
  | "duplicate-id"
  | "unknown-bot"
  | "invalid-id"
  | "invalid-body"
  | "invalid-bot"
  | "unknown-tool"
  | "id-immutable"
  | "busy"
  | "tool-not-allowed";

export class BotError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: BotErrorCode,
  ) {
    super(message);
    this.name = "BotError";
  }
}

export class DuplicateBotIdError extends BotError {
  constructor(readonly botId: string) {
    super(`A bot with id "${botId}" already exists`, 409, "duplicate-id");
    this.name = "DuplicateBotIdError";
  }
}

export class UnknownBotError extends BotError {
  constructor(readonly botId: string) {
    super(`Unknown bot "${botId}"`, 404, "unknown-bot");
    this.name = "UnknownBotError";
  }
}

export class BotToolNotAllowedError extends BotError {
  readonly allowed: readonly string[];

  constructor(
    readonly botId: string,
    readonly toolName: string,
    allowed: readonly string[],
  ) {
    const list = allowed.length === 0 ? "none" : allowed.join(", ");
    super(
      `Bot "${botId}" is not allowed to call ${toolName}; its tools are: ${list}.`,
      403,
      "tool-not-allowed",
    );
    this.name = "BotToolNotAllowedError";
    this.allowed = [...allowed];
  }
}

export function assertBotToolAllowed(
  bot: { readonly id: string; readonly tools: readonly string[] },
  toolName: string,
): void {
  if (!bot.tools.includes(toolName)) {
    throw new BotToolNotAllowedError(bot.id, toolName, bot.tools);
  }
}
