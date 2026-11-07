import {
  defineTool,
  type ToolExecutionResult,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { Type } from "typebox";
import {
  DELEGATE_ROLE_NAMES,
  DelegateError,
  type DelegateManager,
  type DelegateRole,
  MAX_CONCURRENT_DELEGATES,
  MAX_DELEGATE_DEPTH,
} from "./delegates.js";

const DEFAULT_WAIT_MS = 10_000;
const MAX_WAIT_MS = 300_000;
const SYNC_WAIT_MS = 24 * 60 * 60 * 1_000;

function text(value: string, isError = false): ToolExecutionResult {
  return { output: [{ type: "text", text: value }], ...(isError ? { isError: true } : {}) };
}

function failure(error: unknown): ToolExecutionResult {
  return text(
    error instanceof DelegateError ? error.message : `Delegate tool failed: ${String(error)}`,
    true,
  );
}

function waitTimeout(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_WAIT_MS;
  const ms = value < 1_000 ? value * 1_000 : value;
  return Math.min(MAX_WAIT_MS, Math.max(1_000, ms));
}

function runText(
  run: Awaited<ReturnType<DelegateManager["start"]>>,
  result: string,
  failed: boolean,
): string {
  const state =
    run.status === "completed"
      ? "completed"
      : run.status === "cancelled"
        ? "cancelled"
        : run.status === "failed"
          ? "FAILED"
          : run.status;
  return [
    `Delegate ${run.agent} (runId \`${run.id}\`) ${state} after ${run.duration}.`,
    `Task: ${run.taskFirstLine}`,
    `Result: ${run.resultPath}`,
    `Activity: ${run.activityPath}`,
    ...(run.usage === undefined
      ? []
      : [
          `Tokens: ${run.usage.input.toLocaleString()} in, ${run.usage.output.toLocaleString()} out.`,
        ]),
    ...(failed && run.error !== undefined ? [`Error: ${run.error}`] : []),
    result.trim().length > 0 ? `\n${result.trim()}` : "",
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}

/**
 * The model-facing delegate surface. The role table and caps live in `delegates.ts`; this module
 * only maps the documented parameters onto it.
 */
export function createAcpDelegateTools(
  manager: DelegateManager,
  depth: number,
  onFinish?: (text: string) => void | Promise<void>,
): ToolRegistration[] {
  const roleList = DELEGATE_ROLE_NAMES.map((role) => {
    const readOnly = role !== "worker";
    return `  • ${role} — ${readOnly ? "read-only" : "may edit files"}`;
  }).join("\n");
  return [
    defineTool({
      name: "acp_delegate",
      description: `Hand a self-contained task to a fresh sub-agent in a clean context. It never sees this conversation, so include every path, goal and constraint it needs.

Roles:
${roleList}

Behavior:
• async=true (default): returns immediately with a run id. A completion or failure notice is injected into the chat when it finishes; read the result file for details.
• async=false: blocks until the run finishes and returns its result here.
• Extra runs queue in launch order when ${MAX_CONCURRENT_DELEGATES} delegates are already running. Delegates cannot nest past depth ${MAX_DELEGATE_DEPTH}.
• timeoutMinutes sets a hard wall-clock limit for this run (default 30 minutes, capped at 24 hours).
• This pi-ui implementation runs the delegate as an independent in-process durable session, not a separate pi process. It has no resumeFrom/showThinking parameters; re-dispatch instead of resuming. Its context and token usage stay separate from this conversation.`,
      parameters: Type.Object({
        agent: Type.String({
          description: `Role of the delegate. One of: ${DELEGATE_ROLE_NAMES.join(", ")}.`,
        }),
        task: Type.String({
          description: "The self-contained task to hand off. Must be non-empty.",
        }),
        cwd: Type.Optional(
          Type.String({
            description: "Working directory for the delegate (default: the project dir).",
          }),
        ),
        model: Type.Optional(
          Type.String({
            description: 'Model override as "provider/id". Default: this conversation\'s model.',
          }),
        ),
        thinkingLevel: Type.Optional(
          Type.String({ description: "off|minimal|low|medium|high|xhigh|max" }),
        ),
        async: Type.Optional(
          Type.Boolean({
            description:
              "If true (default), return a run id immediately. If false, block for the result.",
          }),
        ),
        timeoutMinutes: Type.Optional(
          Type.Number({ description: "Hard wall-clock timeout in minutes. Default 30; max 1440." }),
        ),
      }),
      async execute(args) {
        try {
          const run = await manager.start({
            agent: args.agent as DelegateRole,
            task: args.task,
            ...(args.cwd === undefined ? {} : { cwd: args.cwd }),
            ...(args.model === undefined ? {} : { model: args.model }),
            ...(args.thinkingLevel === undefined ? {} : { thinkingLevel: args.thinkingLevel }),
            ...(args.async === undefined ? {} : { async: args.async }),
            ...(args.timeoutMinutes === undefined ? {} : { timeoutMinutes: args.timeoutMinutes }),
            depth,
            notify: args.async !== false,
            ...(onFinish === undefined ? {} : { onFinish }),
          });
          if (args.async === false) {
            const waited = await manager.wait(run.id, SYNC_WAIT_MS);
            return text(
              runText(waited.run, waited.result, waited.run.status === "failed"),
              waited.run.status === "failed",
            );
          }
          return text(
            [
              `Delegated to ${run.agent} (runId \`${run.id}\`).`,
              `Task: ${run.taskFirstLine}`,
              `Status: ${run.status === "queued" ? "queued" : "running"}.`,
              `Result: ${run.resultPath}`,
              `Activity: ${run.activityPath}`,
              `A completion notice will arrive when it finishes. Call acp_delegate_wait({ runId: "${run.id}" }) to block for the result, or continue other work.`,
            ].join("\n"),
          );
        } catch (error) {
          return failure(error);
        }
      },
    }),
    defineTool({
      name: "acp_delegate_wait",
      description:
        "Block until an acp_delegate run finishes or the timeout elapses, then return its result and file paths. A timeout is not an error: the run keeps going and a completion notice still arrives later. Default timeout 10s; max 300s. Values below 1000 are treated as seconds.",
      parameters: Type.Object({
        runId: Type.String({ description: "The runId returned by acp_delegate." }),
        timeout: Type.Optional(
          Type.Integer({
            description: "Maximum time to block, in milliseconds. Default 10000; max 300000.",
          }),
        ),
      }),
      async execute(args) {
        try {
          const waited = await manager.wait(args.runId, waitTimeout(args.timeout));
          if (waited.timedOut) {
            return text(
              `Wait timed out after ${Math.round(waitTimeout(args.timeout) / 1_000)}s — delegate \`${args.runId}\` is still ${waited.run.status}. Do not poll; a completion notice will be injected when it finishes. Result file: ${waited.run.resultPath}`,
            );
          }
          return text(
            runText(waited.run, waited.result, waited.run.status === "failed"),
            waited.run.status === "failed",
          );
        } catch (error) {
          return failure(error);
        }
      },
    }),
    defineTool({
      name: "acp_delegate_cancel",
      description:
        "Stop a queued or running delegate by runId. Whatever it produced stays readable in its result and activity files.",
      parameters: Type.Object({
        runId: Type.String({ description: "The runId returned by acp_delegate." }),
      }),
      async execute(args) {
        try {
          const run = manager.cancel(args.runId);
          return text(
            [
              `Delegate ${run.agent} (runId \`${run.id}\`) is ${run.status}.`,
              `Result: ${run.resultPath}`,
              `Activity: ${run.activityPath}`,
            ].join("\n"),
          );
        } catch (error) {
          return failure(error);
        }
      },
    }),
  ];
}
