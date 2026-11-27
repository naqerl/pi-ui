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

export class BotToolAllowance {
  private readonly allowed: ReadonlySet<string>;

  constructor(private readonly bot: Pick<BotDefinition, "id" | "tools">) {
    this.allowed = new Set(bot.tools);
  }

  check(toolName: string): BotToolNotAllowedError | undefined {
    if (this.allowed.has(toolName)) return undefined;
    return new BotToolNotAllowedError(this.bot.id, toolName, this.bot.tools);
  }

  assert(toolName: string): void {
    const refusal = this.check(toolName);
    if (refusal !== undefined) throw refusal;
  }

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
