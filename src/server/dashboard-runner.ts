import { Worker } from "node:worker_threads";

export interface PollRun {
  script: string;
  prev: unknown;
  env: Readonly<Record<string, string>>;
  timeoutMs: number;
  maxBytes: number;
}

export type PollOutcome =
  | { ok: true; value: unknown; bytes: number; logs: string[]; ms: number }
  | { ok: false; error: string; logs: string[]; ms: number };

export type PollRunner = (run: PollRun) => Promise<PollOutcome>;

const MAX_LOG_LINES = 40;
const MAX_LOG_LINE = 400;

// Runs in its own worker thread: a hung or crashing script cannot block or
// take down the server, and terminate() stops even a busy loop.
const WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const logs = [];
const show = (value) => {
  if (typeof value === "string") return value;
  try { return JSON.stringify(value); } catch { return String(value); }
};
const log = (...parts) => {
  if (logs.length >= ${MAX_LOG_LINES}) return;
  logs.push(parts.map(show).join(" ").slice(0, ${MAX_LOG_LINE}));
};
const env = Object.freeze({ ...workerData.env });
const AsyncFunction = (async () => {}).constructor;
(async () => {
  try {
    const run = new AsyncFunction("fetch", "env", "prev", "log", workerData.script);
    const value = await run(fetch, env, workerData.prev, log);
    const json = JSON.stringify(value === undefined ? null : value);
    if (json === undefined) throw new Error("the script returned something that is not JSON");
    const bytes = Buffer.byteLength(json);
    if (bytes > workerData.maxBytes) {
      throw new Error("the result is " + bytes + " bytes; the cap is " + workerData.maxBytes + ". Return only the fields the widget shows.");
    }
    parentPort.postMessage({ ok: true, json, bytes, logs });
  } catch (error) {
    const message = error && typeof error === "object" && "message" in error ? String(error.message) : String(error);
    parentPort.postMessage({ ok: false, error: message, logs });
  }
})();
`;

/** Runs one poll script in a fresh worker thread with a timeout and an output cap. */
export const runPollScript: PollRunner = (run) =>
  new Promise((resolve) => {
    const started = Date.now();
    let settled = false;
    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: {
        script: run.script,
        prev: run.prev ?? null,
        env: { ...run.env },
        maxBytes: run.maxBytes,
      },
      resourceLimits: { maxOldGenerationSizeMb: 96, maxYoungGenerationSizeMb: 16 },
      stdout: true,
      stderr: true,
    });
    // Script console output is not part of the result; drain and drop it.
    worker.stdout.resume();
    worker.stderr.resume();
    const finish = (outcome: PollOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      resolve(outcome);
    };
    const timer = setTimeout(() => {
      finish({
        ok: false,
        error: `timed out after ${Math.round(run.timeoutMs / 100) / 10}s`,
        logs: [],
        ms: Date.now() - started,
      });
    }, run.timeoutMs);
    worker.on(
      "message",
      (message: {
        ok: boolean;
        json?: string;
        bytes?: number;
        error?: string;
        logs?: string[];
      }) => {
        const logs = Array.isArray(message.logs) ? message.logs : [];
        if (message.ok && typeof message.json === "string") {
          try {
            finish({
              ok: true,
              value: JSON.parse(message.json),
              bytes: message.bytes ?? message.json.length,
              logs,
              ms: Date.now() - started,
            });
          } catch (error) {
            finish({
              ok: false,
              error: `bad JSON: ${String(error)}`,
              logs,
              ms: Date.now() - started,
            });
          }
        } else
          finish({
            ok: false,
            error: message.error ?? "the script failed",
            logs,
            ms: Date.now() - started,
          });
      },
    );
    worker.on("error", (error) => {
      finish({
        ok: false,
        error: `the script crashed: ${error.message}`,
        logs: [],
        ms: Date.now() - started,
      });
    });
    worker.on("exit", (code) => {
      finish({
        ok: false,
        error: `the script exited (${code}) without a result`,
        logs: [],
        ms: Date.now() - started,
      });
    });
  });
