import {
  defineTool,
  type ToolExecutionResult,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { TIMED_BASH_DESCRIPTION } from "./bash-tool.js";
import { DelegateError, type DelegateManager, MAX_CONCURRENT_DELEGATES } from "./delegates.js";

function text(value: string, isError = false): ToolExecutionResult {
  return { output: [{ type: "text", text: value }], ...(isError ? { isError: true } : {}) };
}

function failure(error: unknown): ToolExecutionResult {
  return text(
    error instanceof DelegateError ? error.message : `Delegate tool failed: ${String(error)}`,
    true,
  );
}

function started(run: Awaited<ReturnType<DelegateManager["start"]>>): string {
  return [
    `Sub-agent \`${run.id}\` is ${run.status}.`,
    `Prompt: ${run.taskFirstLine}`,
    `Result: ${run.resultPath}`,
    `Activity: ${run.activityPath}`,
    "It keeps running after this call. End your turn. A chip arrives when it finishes. Do not poll or wait.",
  ].join("\n");
}

/**
 * The model-facing sub-agent surface. A call returns as soon as the prompt is accepted.
 * The chat is told the result later, as one chip, and can continue the same session.
 */
export function createAcpDelegateTools(manager: DelegateManager): ToolRegistration[] {
  return [
    defineTool({
      name: "acp_delegate",
      description: `Hand local work that is not a zeroshot job (config, files, host commands) to a sub-agent and return immediately.

The sub-agent cannot see this chat, so put every path, goal, and constraint in the prompt. It has read, bash, edit, write, job_list, job_output, and job_cancel. ${TIMED_BASH_DESCRIPTION}

The call returns a run id. The work continues after it, for as long as the turn takes. End your turn. A chip arrives when the turn finishes. Do not poll and do not wait. Extra prompts queue when ${MAX_CONCURRENT_DELEGATES} sub-agents are already running.

To give the same sub-agent a follow-up, call acp_delegate_continue with the run id. Do not start a second sub-agent to continue the first.`,
      parameters: Type.Object({
        prompt: Type.String({
          description: "The whole brief. Must be non-empty. The sub-agent cannot see this chat.",
        }),
        cwd: Type.Optional(
          Type.String({
            description: "Working directory for the sub-agent. Default: the project directory.",
          }),
        ),
      }),
      async execute(args) {
        try {
          const run = await manager.start({
            prompt: args.prompt,
            ...(args.cwd === undefined ? {} : { cwd: args.cwd }),
          });
          return text(started(run));
        } catch (error) {
          return failure(error);
        }
      },
    }),
    defineTool({
      name: "acp_delegate_continue",
      description:
        "Send a follow-up prompt to an existing sub-agent and return immediately. Use the run id from acp_delegate or from its chip. Refuses a run that is still queued or running: wait for the chip, then call again. Refuses a closed run: start a new one with acp_delegate. Do not poll or wait.",
      parameters: Type.Object({
        runId: Type.String({ description: "The run id returned by acp_delegate." }),
        prompt: Type.String({
          description: "The follow-up. The sub-agent still has its earlier turns.",
        }),
      }),
      async execute(args) {
        try {
          const run = await manager.continue(args.runId, args.prompt);
          return text(started(run));
        } catch (error) {
          return failure(error);
        }
      },
    }),
    defineTool({
      name: "acp_delegate_cancel",
      description:
        "Stop the current turn of a queued or running sub-agent. The session stays, so acp_delegate_continue can still use the run id. A cancelled turn also sends one chip.",
      parameters: Type.Object({
        runId: Type.String({ description: "The run id returned by acp_delegate." }),
      }),
      async execute(args) {
        try {
          const run = manager.cancel(args.runId);
          return text(
            [
              `Sub-agent \`${run.id}\` is ${run.status}.`,
              `Result: ${run.resultPath}`,
              `Activity: ${run.activityPath}`,
              run.status === "idle"
                ? "The session is still there. acp_delegate_continue can give it a follow-up."
                : "The turn is stopping. A chip arrives when it has stopped.",
            ].join("\n"),
          );
        } catch (error) {
          return failure(error);
        }
      },
    }),
  ];
}
