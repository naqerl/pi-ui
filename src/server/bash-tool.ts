import { open } from "node:fs/promises";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { JobError, type JobManager, type JobOwner } from "./jobs.js";

/** The foreground window a bash command gets before it becomes a background job. */
export const BASH_HANDOFF_MS = 120_000;

/** How often the tool reads new bytes from the job log while it waits. */
const POLL_MS = 200;
/** Bytes read from the log per chunk; a poll repeats until the file is drained. */
const READ_CHUNK_BYTES = 64 * 1024;

export interface TimedBashOptions {
  /** Override the foreground window. Defaults to PI_BASH_HANDOFF_MS, then BASH_HANDOFF_MS. */
  handoffMs?: number;
  /** Which conversation hears about the job once it is handed over. */
  owner?: JobOwner;
}

const shellStructuredOutputSchema = Type.Object({
  output: Type.String(),
  truncated: Type.Boolean(),
  fullOutputPath: Type.Optional(Type.String()),
  exitCode: Type.Union([Type.Number(), Type.Null()]),
  jobId: Type.Optional(Type.String()),
});

function positive(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** The call's working directory, as the harness environment reports it. */
function requireCwd(api: { readonly env?: { readonly cwd: string } }): string {
  if (api.env === undefined) throw new Error("No execution environment is configured");
  return api.env.cwd;
}

/** The configured foreground window: the option, PI_BASH_HANDOFF_MS, or the default. */
export function bashHandoffMs(options: TimedBashOptions = {}): number {
  const configured = Number(process.env.PI_BASH_HANDOFF_MS);
  return positive(options.handoffMs) ?? positive(configured) ?? BASH_HANDOFF_MS;
}

function windowText(ms: number): string {
  if (ms >= 60_000) {
    const minutes = ms / 60_000;
    return `${Number.isInteger(minutes) ? minutes : minutes.toFixed(1)} minute${minutes === 1 ? "" : "s"}`;
  }
  const seconds = ms / 1000;
  return `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)} second${seconds === 1 ? "" : "s"}`;
}

/** The one handoff notice: it is the tool output tail and the warning diagnostic. */
export function bashHandoffNotice(
  jobId: string,
  options: { stopped?: boolean; handoffMs?: number } = {},
): string {
  const first = options.stopped
    ? `[pi-ui] The run was stopped; this command continues as background job ${jobId}.`
    : `[pi-ui] This command has run for ${windowText(options.handoffMs ?? BASH_HANDOFF_MS)} and continues as background job ${jobId}.`;
  return [
    first,
    `You will be told when it ends. Read it with job_output id=${jobId}, stop it with job_cancel id=${jobId}.`,
  ].join("\n");
}

/** Reads every byte appended to the log since `offset`. */
async function readNewBytes(
  path: string,
  offset: number,
): Promise<{ bytes: Buffer; next: number }> {
  const handle = await open(path, "r");
  try {
    const chunks: Buffer[] = [];
    let next = offset;
    for (;;) {
      const buffer = Buffer.alloc(READ_CHUNK_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, next);
      if (bytesRead === 0) break;
      chunks.push(buffer.subarray(0, bytesRead));
      next += bytesRead;
      if (bytesRead < buffer.length) break;
    }
    return { bytes: Buffer.concat(chunks), next };
  } finally {
    await handle.close();
  }
}

/**
 * The chat and plan `bash` tool. It waits up to the handoff window for a command, streaming its
 * log into the tool result. A command still running at the end of the window is promoted to a
 * visible background job and the tool returns at once; Stop only ends the turn, so it promotes
 * the same way rather than killing the process group. There is no timeout argument.
 */
export function createTimedBashTool(
  jobs: JobManager,
  options: TimedBashOptions = {},
): ToolRegistration {
  const handoffMs = bashHandoffMs(options);
  return defineTool({
    name: "bash",
    description: `Execute a bash command in the current working directory. Returns combined stdout and stderr. Every command gets ${windowText(handoffMs)} in the foreground. If it is still running then, it continues as a background job: you get the output so far and a job id, and the command keeps running. You are told when it ends, so do not poll; read it with job_output id=<id> and stop it with job_cancel id=<id>. There is no timeout parameter, so a command you wanted bounded keeps waiting for the window and then runs until you cancel it.`,
    parameters: Type.Object({
      command: Type.String({ description: "Bash command to execute." }),
    }),
    structuredOutputSchema: shellStructuredOutputSchema,
    outputLimits: { retain: "tail" },
    async execute(args, api, context) {
      let jobId: string | undefined;
      let stopped = false;
      let timer: NodeJS.Timeout | undefined;
      let inflight: Promise<void> = Promise.resolve();
      let offset = 0;
      let pending = "";
      const decoder = new TextDecoder("utf-8");

      const emitLines = (): void => {
        const newline = pending.lastIndexOf("\n");
        if (newline < 0) return;
        const chunk = pending.slice(0, newline + 1);
        pending = pending.slice(newline + 1);
        if (chunk.length > 0) api.output(chunk);
      };

      const drain = async (final: boolean): Promise<void> => {
        if (jobId === undefined) return;
        const read = await readNewBytes(jobs.logPath(jobId), offset);
        offset = read.next;
        if (read.bytes.length > 0) pending += decoder.decode(read.bytes, { stream: true });
        if (final) pending += decoder.decode();
        emitLines();
        if (final && pending.length > 0) {
          api.output(pending);
          pending = "";
        }
      };

      const schedule = (): void => {
        if (stopped) return;
        timer = setTimeout(() => {
          inflight = drain(false)
            .catch(() => undefined)
            .then(() => schedule());
        }, POLL_MS);
        timer.unref();
      };

      try {
        const cwd = requireCwd(api);
        const job = jobs.begin({
          command: args.command,
          cwd,
          origin: "bash",
          owner: options.owner ?? { kind: "chat" },
        });
        jobId = job.id;
        schedule();

        const outcome = await jobs.waitForExit(job.id, handoffMs, context.abortSignal);
        stopped = true;
        if (timer !== undefined) clearTimeout(timer);
        await inflight;
        await drain(true);

        if (outcome.exited) {
          const finished = jobs.get(job.id);
          const exitCode = finished.exitCode;
          await jobs.discard(job.id);
          const retained = api.retainedOutput();
          const structuredOutput = {
            output: retained.text,
            truncated: retained.truncated,
            exitCode,
          };
          if (exitCode === 0) return { structuredOutput };
          return {
            structuredOutput,
            isError: true,
            diagnostics: [
              {
                severity: "error",
                code: "exit_code",
                message:
                  exitCode === null
                    ? `Command failed${finished.signal === null ? "" : ` (${finished.signal})`}`
                    : `Command exited with code ${exitCode}`,
              },
            ],
          };
        }

        const promoted = jobs.promote(job.id);
        const notice = bashHandoffNotice(promoted.id, {
          ...(context.abortSignal?.aborted ? { stopped: true } : {}),
          handoffMs,
        });
        // The notice is part of the tail the model reads, so append it before reading
        // the retained output. Discarding the hidden log now would lose the notice.
        api.output(`\n${notice}`);
        const retained = api.retainedOutput();
        return {
          structuredOutput: {
            output: retained.text,
            truncated: retained.truncated,
            exitCode: null,
            jobId: promoted.id,
          },
          diagnostics: [{ severity: "warn", code: "bash_handoff", message: notice }],
        };
      } catch (error) {
        if (jobId === undefined) {
          return {
            output: [
              {
                type: "text",
                text:
                  error instanceof JobError ? error.message : `Bash tool failed: ${String(error)}`,
              },
            ],
            isError: true,
          };
        }
        throw error;
      } finally {
        stopped = true;
        if (timer !== undefined) clearTimeout(timer);
        // api.output rejects once the invocation ends; no poll may outlive it.
        await inflight.catch(() => undefined);
      }
    },
  });
}
