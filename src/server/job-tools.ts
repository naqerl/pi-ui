import {
  defineTool,
  type ToolExecutionResult,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { createReadTool } from "@earendil-works/pi-durable/tools";
import { Type } from "typebox";
import { describeJob, JobError, type JobManager } from "./jobs.js";

function text(value: string, isError = false): ToolExecutionResult {
  return { output: [{ type: "text", text: value }], ...(isError ? { isError: true } : {}) };
}

function failure(error: unknown): ToolExecutionResult {
  return text(
    error instanceof JobError ? error.message : `Job tool failed: ${String(error)}`,
    true,
  );
}

const read = createReadTool();

function noOutput(value: string): ToolExecutionResult {
  return { output: [{ type: "text", text: value }], structuredOutput: "" };
}

function isMissingLog(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "not_found";
}

export function createJobTools(jobs: JobManager): ToolRegistration[] {
  return [
    defineTool({
      name: "job_start",
      description:
        "Start a shell command in the background (bash -lc, in the working directory) and return at once with its job id. Use it for builds, test suites, servers or anything that takes longer than a few seconds. Output goes to a log you can read with job_output. When the job ends on its own you get a message with its exit status and last output lines, so do not poll; end your turn or keep working. Set notify to false for a long-lived process such as a dev server.",
      parameters: Type.Object({
        command: Type.String({ description: "Shell command to run." }),
        name: Type.Optional(Type.String({ description: "Short label shown in job_list." })),
        notify: Type.Optional(
          Type.Boolean({ description: "Message you when the job ends. Default true." }),
        ),
      }),
      async execute(args) {
        try {
          const job = jobs.start(args);
          return text(
            `Started ${job.id} (pid ${job.pid ?? "unknown"}): ${job.name}\n${
              job.notify
                ? "You will get a message when it ends."
                : "No message when it ends; check it with job_list."
            }`,
          );
        } catch (error) {
          return failure(error);
        }
      },
    }),
    defineTool({
      name: "job_list",
      description: "List background jobs with their id, status, exit code, duration and label.",
      parameters: Type.Object({}),
      async execute() {
        const list = jobs.list();
        if (list.length === 0) return text("No background jobs.");
        return text(list.map((job) => describeJob(job)).join("\n"));
      },
    }),
    defineTool({
      ...read,
      prepareArguments: undefined,
      name: "job_output",
      description:
        "Read a background job's log — everything the command wrote to stdout and stderr — exactly like the read tool, but by job id instead of a path. `offset` is a 1-indexed line, `limit` caps the lines returned, and the text truncates at 2000 lines or 50 KB with the offset that continues. The log grows while the job runs and stays after it ends; output survives a server restart. Use job_list for status and exit code.",
      parameters: Type.Object({
        id: Type.String({ description: "Job id from job_start or job_list." }),
        offset: Type.Optional(
          Type.Number({ description: "Line number to start reading from (1-indexed)." }),
        ),
        limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read." })),
      }),
      async execute(args, api, context) {
        const { id, offset, limit } = args;
        let path: string;
        try {
          path = jobs.logPath(id);
        } catch (error) {
          return failure(error);
        }
        try {
          const result = await read.execute(
            {
              path,
              ...(offset === undefined ? {} : { offset }),
              ...(limit === undefined ? {} : { limit }),
            },
            api,
            context,
          );
          return (result.output ?? []).length === 0
            ? { ...result, ...noOutput(`Job ${id} has no output yet.`) }
            : result;
        } catch (error) {
          if (isMissingLog(error)) return noOutput(`Job ${id} has no output yet.`);
          const message = error instanceof Error ? error.message : String(error);
          return text(`Job ${id}: ${message}`, true);
        }
      },
    }),
    defineTool({
      name: "job_cancel",
      description:
        "Stop a running background job and the processes it started (SIGTERM, then SIGKILL after 5 seconds). A cancelled job sends no completion message.",
      parameters: Type.Object({
        id: Type.String({ description: "Job id from job_start or job_list." }),
      }),
      async execute(args) {
        try {
          const job = jobs.cancel(args.id);
          return text(describeJob(job));
        } catch (error) {
          return failure(error);
        }
      },
    }),
  ];
}
