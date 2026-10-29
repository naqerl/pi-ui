import {
  defineTool,
  type ToolExecutionResult,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
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

/** Tools for long shell commands that should not hold up the turn. Not deferred. */
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
      name: "job_output",
      description:
        "Read a background job's combined stdout and stderr. By default returns the last 100 lines; pass tail for more or fewer lines, or offset (a byte position, e.g. the `next` value from an earlier read) to page forward from there. At most 20000 characters per read.",
      parameters: Type.Object({
        id: Type.String({ description: "Job id from job_start or job_list." }),
        tail: Type.Optional(Type.Number({ description: "Lines from the end. Default 100." })),
        offset: Type.Optional(
          Type.Number({ description: "Byte offset to read forward from instead of the tail." }),
        ),
      }),
      async execute(args) {
        try {
          const read = await jobs.output(args.id, {
            ...(args.offset === undefined ? {} : { offset: args.offset }),
            ...(args.tail === undefined ? {} : { tail: args.tail }),
          });
          const header = `${describeJob(read.job)}\nbytes ${read.from}-${read.next} of ${read.size}${
            read.truncated ? " (more exists; page with offset)" : ""
          } next=${read.next}`;
          return text(`${header}\n${read.text.length > 0 ? read.text : "(no output)"}`);
        } catch (error) {
          return failure(error);
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
