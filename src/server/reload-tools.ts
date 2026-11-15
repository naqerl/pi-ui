import {
  defineTool,
  type ToolExecutionResult,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { Type } from "typebox";

export const RELOAD_TARGETS = ["mcp", "prompt", "models", "all"] as const;
export type ReloadTarget = (typeof RELOAD_TARGETS)[number];

export interface ReloadTargetOutcome {
  readonly ok: boolean;
  readonly details: Record<string, unknown>;
  readonly errors?: readonly string[];
}

export interface ReloadSummary {
  readonly target: ReloadTarget;
  readonly ok: boolean;
  readonly details: Record<string, unknown>;
  readonly errors: string[];
}

export interface ReloadHooks {
  readonly mcp: () => Promise<ReloadTargetOutcome>;
  readonly prompt?: () => Promise<ReloadTargetOutcome>;
  readonly models?: () => Promise<ReloadTargetOutcome>;
}

const TARGET_ORDER = ["mcp", "prompt", "models"] as const;
type IndividualTarget = (typeof TARGET_ORDER)[number];

function targetOutcome(target: IndividualTarget, hooks: ReloadHooks): Promise<ReloadTargetOutcome> {
  const run = hooks[target];
  if (run === undefined) {
    return Promise.resolve({
      ok: false,
      details: {},
      errors: [`reload target "${target}" is not available in this session`],
    });
  }
  return run();
}

async function runTarget(
  target: IndividualTarget,
  hooks: ReloadHooks,
): Promise<ReloadTargetOutcome> {
  try {
    return await targetOutcome(target, hooks);
  } catch (error) {
    return {
      ok: false,
      details: {},
      errors: [error instanceof Error ? error.message : String(error)],
    };
  }
}

function json(value: unknown, isError = false): ToolExecutionResult {
  return {
    output: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    details: value as ToolExecutionResult["details"],
    ...(isError ? { isError: true } : {}),
  };
}

/**
 * The agent-facing reload tool. It never restarts the process, and a second
 * call made while one is running reports `busy` instead of racing it.
 */
export function createReloadTool(hooks: ReloadHooks): ToolRegistration {
  let running = false;

  return defineTool({
    name: "reload",
    description:
      "Re-read the files that define this running session and apply them without restarting the process. target=mcp re-reads mcp.json and reconnects only changed servers (adds new ones, drops removed ones, leaves unchanged connections alone, and keeps the old connection if a reconnect fails); target=prompt rebuilds this session's instructions, including the current memory snapshot, for the next turn without touching other sessions; target=models re-reads the model catalog so a newly added model appears; all runs those three in order and reports each one separately even if another fails. Concurrent calls return busy. The tool only reads config files; it never writes them or restarts anything.",
    parameters: Type.Object({
      target: Type.Optional(
        Type.Union(
          [
            Type.Literal("mcp"),
            Type.Literal("prompt"),
            Type.Literal("models"),
            Type.Literal("all"),
          ],
          {
            description: "What to re-read: mcp, prompt, models or all. Default all.",
          },
        ),
      ),
    }),
    async execute(args) {
      const target: ReloadTarget = args.target ?? "all";
      if (running) {
        const summary: ReloadSummary = {
          target,
          ok: false,
          details: { busy: true },
          errors: ["reload is already running; this call did not start"],
        };
        return json(summary, true);
      }

      running = true;
      try {
        if (target !== "all") {
          const outcome = await runTarget(target, hooks);
          const summary: ReloadSummary = {
            target,
            ok: outcome.ok,
            details: outcome.details,
            errors: [...(outcome.errors ?? [])],
          };
          return json(summary, !summary.ok);
        }

        const details: Record<string, unknown> = {};
        const errors: string[] = [];
        let ok = true;
        for (const name of TARGET_ORDER) {
          const outcome = await runTarget(name, hooks);
          details[name] = {
            ok: outcome.ok,
            ...outcome.details,
            errors: [...(outcome.errors ?? [])],
          };
          if (!outcome.ok) {
            ok = false;
            for (const error of outcome.errors ?? []) errors.push(`${name}: ${error}`);
          }
        }
        const summary: ReloadSummary = { target, ok, details, errors };
        return json(summary, !ok);
      } finally {
        running = false;
      }
    },
  });
}
