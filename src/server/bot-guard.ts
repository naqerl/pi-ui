import {
  defineExtension,
  type Extension,
  hook,
  type ToolHookCall,
  type ToolRegistration,
  ToolTask,
} from "@earendil-works/pi-durable";
import { BotToolNotAllowedError } from "./bot-error.js";
import type { BotDefinition } from "./bots.js";

/**
 * The per-bot allowance, installed as a tool hook. The bot lane offers the whole
 * catalog so a model can attempt a tool outside its list; this hook refuses that
 * call by name instead of leaving the model with a tool that silently vanished.
 */
export class BotToolAllowance {
  private readonly allowed: ReadonlySet<string>;

  constructor(private readonly bot: Pick<BotDefinition, "id" | "tools">) {
    this.allowed = new Set(bot.tools);
  }

  /** The named refusal for a tool outside the allowance, or undefined for an allowed one. */
  check(toolName: string): BotToolNotAllowedError | undefined {
    if (this.allowed.has(toolName)) return undefined;
    return new BotToolNotAllowedError(this.bot.id, toolName, this.bot.tools);
  }

  assert(toolName: string): void {
    const refusal = this.check(toolName);
    if (refusal !== undefined) throw refusal;
  }

  /** Block the call before it runs and hand the model the refusal text. */
  beforeTool(call: Pick<ToolHookCall, "name">): { block: string } | undefined {
    const refusal = this.check(call.name);
    return refusal === undefined ? undefined : { block: refusal.message };
  }

  extension(): Extension<ToolRegistration> {
    return defineExtension({
      name: "bot-tool-allowance",
      hooks: [
        hook(ToolTask, {
          beforeTool: (call) => this.beforeTool(call),
        }),
      ],
    });
  }
}

export function createBotToolGuard(
  bot: Pick<BotDefinition, "id" | "tools">,
): Extension<ToolRegistration> {
  return new BotToolAllowance(bot).extension();
}
