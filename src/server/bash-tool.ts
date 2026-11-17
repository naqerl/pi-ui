import { open, stat } from "node:fs/promises";
import {
  defineTool,
  type ToolExecutionResult,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { Type } from "typebox";
import type { JobManager, JobOwner } from "./jobs.js";

/** How long a `bash` call owns the foreground before the command becomes a background job. */
export const BASH_HANDOFF_MS = 120_000;
/** How often the foreground call reads the job log. */
const POLL_MS = 200;
/** Most bytes one poll reads; the next poll continues from there. */
const READ_CHUNK_BYTES = 64 * 1024;
/** Most bytes one read of the final bounded window returns. */
const FINAL_CHUNK_BYTES = 4 * 1024 * 1024;
/** Most bytes of the log the final read returns: enough for the retained tail. */
const FINAL_TAIL_BYTES = 256 * 1024;
/** Bytes inspected to start the final tail on a line or character boundary. */
const TAIL_ALIGN_BYTES = 64 * 1024;
/** Most characters kept while waiting for a newline, so a huge line cannot grow memory. */
const MAX_PENDING_CHARS = 64 * 1024;

export const TIMED_BASH_DESCRIPTION =
  "Every command gets 120 seconds. One still running then keeps running as a background job — you are told when it ends, so do not poll; cancel it with job_cancel.";

const bashParameters = Type.Object({
  command: Type.String({ description: "Bash command to execute" }),
});

const bashStructuredOutput = Type.Object({
  output: Type.String({
    description: "Combined stdout and stderr: the retained tail, as the model sees it",
  }),
  truncated: Type.Boolean({ description: "Whether earlier output was dropped" }),
  fullOutputPath: Type.Optional(
    Type.String({ description: "The job log with the complete output, when it was spilled" }),
  ),
  exitCode: Type.Union([Type.Number(), Type.Null()]),
  jobId: Type.Optional(Type.String({ description: "Background job id after a handoff" })),
});

/** The notice that replaces a foreground result once the command continues as a job. */
export function bashHandoffNotice(jobId: string, aborted = false): string {
  const first = aborted
    ? `[pi-ui] The run was stopped; this command continues as background job ${jobId}.`
    : `[pi-ui] This command has run for 2 minutes and continues as background job ${jobId}.`;
  return [
    first,
    `You will be told when it ends. Read it with job_output id=${jobId}, stop it with job_cancel id=${jobId}.`,
  ].join("\n");
}

function configuredHandoffMs(): number {
  const raw = process.env.PI_BASH_HANDOFF_MS;
  if (raw === undefined || raw.trim().length === 0) return BASH_HANDOFF_MS;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : BASH_HANDOFF_MS;
}

interface LogRead {
  bytes: Buffer;
  size: number;
}

async function readLog(path: string, offset: number): Promise<LogRead> {
  let size = 0;
  try {
    size = (await stat(path)).size;
  } catch {
    return { bytes: Buffer.alloc(0), size: 0 };
  }
  const length = Math.min(size - offset, READ_CHUNK_BYTES);
  if (length <= 0) return { bytes: Buffer.alloc(0), size };
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    return { bytes: buffer.subarray(0, bytesRead), size };
  } finally {
    await handle.close();
  }
}

/** The log size at this instant, or undefined when it cannot be read. */
async function logSize(path: string): Promise<number | undefined> {
  try {
    return (await stat(path)).size;
  } catch {
    return undefined;
  }
}

/**
 * A `bash` tool with one rule: wait 120 seconds, then hand the command to a background job.
 * The command is spawned by JobManager, so at the handoff nothing has been killed. Output is
 * streamed from the job log through the usual retained tail; the log becomes the job's output.
 */
export function createTimedBashTool(
  jobs: JobManager,
  options: { handoffMs?: number; owner?: JobOwner } = {},
): ToolRegistration {
  const handoffMs = options.handoffMs ?? configuredHandoffMs();
  const owner = options.owner ?? { kind: "chat" };
  return defineTool({
    name: "bash",
    description: TIMED_BASH_DESCRIPTION,
    parameters: bashParameters,
    structuredOutputSchema: bashStructuredOutput,
    outputLimits: { retain: "tail" },
    async execute(args, api, context) {
      if (api.env === undefined) throw new Error("No execution environment is configured");
      const cwd = api.env.cwd;
      const job = jobs.begin({
        command: args.command,
        cwd,
        owner,
        origin: "bash",
      });
      const path = jobs.logPath(job.id);
      const decoder = new TextDecoder("utf-8");
      let offset = 0;
      let pending = "";
      let stopped = false;
      let outputClosed = false;
      let skippedOutput = false;

      const emit = (text: string): void => {
        if (text.length === 0 || outputClosed) return;
        try {
          api.output(text);
        } catch {
          // The invocation may have ended; stop writing but keep the final result.
          outputClosed = true;
        }
      };
      const appendPending = (text: string): void => {
        pending += text;
        if (pending.length > MAX_PENDING_CHARS) {
          let from = pending.length - MAX_PENDING_CHARS;
          const code = pending.charCodeAt(from);
          // Keep a surrogate pair together when trimming the retained remainder.
          if (code >= 0xdc00 && code <= 0xdfff) from += 1;
          pending = pending.slice(from);
          skippedOutput = true;
        }
      };
      const emitCompleteLines = (): void => {
        const end = pending.lastIndexOf("\n");
        if (end < 0) return;
        const ready = pending.slice(0, end + 1);
        pending = pending.slice(end + 1);
        emit(ready);
      };
      const drain = async (final: boolean, target?: number): Promise<void> => {
        try {
          if (!final) {
            const { bytes } = await readLog(path, offset);
            if (bytes.length === 0) return;
            offset += bytes.length;
            appendPending(decoder.decode(bytes, { stream: true }));
            emitCompleteLines();
            return;
          }
          // A handoff (or a shell whose descendants keep writing) must not chase a
          // moving log forever. The complete log stays on disk for job_output and
          // fullOutputPath; the foreground only needs its bounded tail.
          if (target === undefined) return;
          let position = offset;
          if (target - position > FINAL_TAIL_BYTES) {
            position = target - FINAL_TAIL_BYTES;
            skippedOutput = true;
            pending = "";
            decoder.decode();
          }
          const handle = await open(path, "r");
          try {
            if (position > offset) {
              // Start after a newline when one exists in the probe, otherwise after
              // any UTF-8 continuation bytes, so the tail never starts mid-character.
              const probeLength = Math.min(target - position, TAIL_ALIGN_BYTES);
              const probe = Buffer.alloc(probeLength);
              const { bytesRead } = await handle.read(probe, 0, probeLength, position);
              const newline = probe.subarray(0, bytesRead).indexOf(0x0a);
              if (newline >= 0) {
                position += newline + 1;
              } else {
                let skip = 0;
                while (skip < bytesRead) {
                  const byte = probe[skip];
                  if (byte === undefined || (byte & 0xc0) !== 0x80) break;
                  skip += 1;
                }
                position += skip;
              }
            }
            while (position < target) {
              const length = Math.min(target - position, FINAL_CHUNK_BYTES);
              const buffer = Buffer.alloc(length);
              const { bytesRead } = await handle.read(buffer, 0, length, position);
              if (bytesRead === 0) break;
              position += bytesRead;
              appendPending(decoder.decode(buffer.subarray(0, bytesRead), { stream: true }));
              emitCompleteLines();
            }
            offset = position;
          } finally {
            await handle.close();
          }
        } finally {
          if (final) {
            appendPending(decoder.decode());
            emit(pending);
            pending = "";
          }
        }
      };

      let chain: Promise<void> = Promise.resolve();
      const schedule = (final: boolean, target?: number): Promise<void> => {
        chain = chain
          .then(async () => {
            if (!final && stopped) return;
            await drain(final, target);
          })
          .catch(() => undefined);
        return chain;
      };
      const timer = setInterval(() => {
        void schedule(false);
      }, POLL_MS);
      timer.unref?.();

      try {
        const outcome = await jobs.waitForExit(job.id, handoffMs, context.abortSignal);
        stopped = true;
        clearInterval(timer);
        // Freeze the final read at the size observed now, so a still-running command
        // cannot keep the turn open. The flush happens even if this read fails.
        const finalSize = await logSize(path);
        await schedule(true, finalSize);

        if (outcome.exited) {
          const ended = jobs.get(job.id);
          const retained = api.retainedOutput();
          const truncated = retained.truncated || skippedOutput;
          const exitCode = ended.exitCode ?? (ended.status === "exited" ? 0 : 1);
          await jobs.discard(job.id, { keepLog: truncated });
          const structuredOutput = {
            output: retained.text,
            truncated,
            ...(truncated ? { fullOutputPath: path } : {}),
            exitCode,
          };
          if (exitCode === 0) return { structuredOutput };
          const failed = {
            severity: "error" as const,
            code: "exit_code",
            message: `Command exited with code ${exitCode}`,
          };
          return { structuredOutput, isError: true, diagnostics: [failed] };
        }

        const promoted = jobs.promote(job.id);
        const notice = bashHandoffNotice(promoted.id, context.abortSignal?.aborted === true);
        // Append before reading the retained tail, or a long output would push the
        // notice out of the window the model receives.
        emit(`\n${notice}`);
        const retained = api.retainedOutput();
        const handoffDiagnostic = {
          severity: "warn" as const,
          code: "bash_handoff",
          message: notice,
        };
        const truncated = retained.truncated || skippedOutput;
        const structuredOutput = {
          output: retained.text,
          truncated,
          ...(truncated ? { fullOutputPath: jobs.logPath(promoted.id) } : {}),
          exitCode: null,
          jobId: promoted.id,
        };
        const result: ToolExecutionResult = {
          structuredOutput,
          isError: false,
          diagnostics: [handoffDiagnostic],
        };
        return result;
      } finally {
        stopped = true;
        clearInterval(timer);
      }
    },
  });
}
