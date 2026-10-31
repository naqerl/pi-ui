/**
 * Background job results and MCP events reach the transcript as messages the agent
 * already reads. These helpers recognise them: the activity page shows job results,
 * and the chat shows MCP events as a one-line notice instead of a bubble. The text
 * sent to the model is unchanged.
 */

import { toIsoTimestamp } from "./time.js";

export interface JobNoticeDetails {
  kind: "job";
  id: string;
  name: string;
  command: string;
  status: "exited" | "failed" | "cancelled" | "lost";
  exitCode: number | null;
  signal: string | null;
  duration: string | null;
  /** The last lines of output, or "" when it printed nothing. */
  output: string;
  summary: string;
}

export interface McpNoticeEvent {
  server: string;
  name: string;
  timestamp: string | null;
  id: string | null;
  subscriptionId: string | null;
  data: unknown;
}

export interface McpNoticeStatus {
  server: string;
  name: string;
  status: string;
  error: string | null;
}

export interface McpNoticeDetails {
  kind: "mcp";
  servers: string[];
  events: McpNoticeEvent[];
  statuses: McpNoticeStatus[];
  dropped: number;
  summary: string;
}

/** A memory file written by the memory_write tool. */
export interface MemoryNoticeDetails {
  kind: "memory";
  /** Memory-relative path, such as topics/projects/widget.md. */
  path: string;
  /** The written body, capped before it is stored. */
  text: string;
  /** True when the body was longer than the stored cap. */
  truncated: boolean;
  summary: string;
}

/** The restart note recorded for an interrupted run. */
export interface InterruptedNoticeDetails {
  kind: "interrupted";
  note: string;
  /** True when the run was stopped deliberately before the restart. */
  stopped: boolean;
  /** The note is the summary, so old callers can read either field. */
  summary?: string;
}

export type ChatNotice =
  | JobNoticeDetails
  | McpNoticeDetails
  | InterruptedNoticeDetails
  | MemoryNoticeDetails;

const JOB_HEAD = /^\[background job (\S+) finished\] (\S+) (.+?): (.*)$/;
const MCP_EVENTS_HEAD = "MCP event data follows.";
const MCP_STATUS_HEAD = "MCP subscription status follows.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function parseJob(lines: string[]): JobNoticeDetails | null {
  const head = JOB_HEAD.exec(lines[0] ?? "");
  if (head === null) return null;
  const [, id = "", , state = "", name = ""] = head;
  let status: JobNoticeDetails["status"] = "failed";
  let exitCode: number | null = null;
  let signal: string | null = null;
  let duration: string | null = /after (.+)$/.exec(state)?.[1] ?? null;
  const exited = /^exited (-?\d+) after /.exec(state);
  if (exited !== null) {
    exitCode = Number(exited[1]);
    status = exitCode === 0 ? "exited" : "failed";
  } else if (state.startsWith("cancelled")) {
    status = "cancelled";
  } else if (state.startsWith("lost")) {
    status = "lost";
    duration = null;
  } else {
    signal = /^failed \((\S+)\)/.exec(state)?.[1] ?? null;
  }
  let command = name;
  let output = "";
  for (let index = 1; index < lines.length; index++) {
    const line = lines[index] ?? "";
    if (line.startsWith("Command: ")) command = line.slice("Command: ".length);
    else if (line === "Last output:" && lines[index + 1] === "```") {
      const end = lines.lastIndexOf("```");
      if (end > index + 1) output = lines.slice(index + 2, end).join("\n");
      index = Math.max(index, end);
    }
  }
  const after = duration === null ? "" : ` · ${duration}`;
  const reason = exitCode !== null ? ` exit ${exitCode}` : signal !== null ? ` ${signal}` : "";
  const summary =
    status === "exited"
      ? `job ${name} finished ✓${duration === null ? "" : ` ${duration}`}`
      : status === "cancelled"
        ? `job ${name} cancelled${after}`
        : status === "lost"
          ? `job ${name} lost on restart`
          : `job ${name} failed ✗${reason}${after}`;
  return { kind: "job", id, name, command, status, exitCode, signal, duration, output, summary };
}

function mcpSummary(servers: string[], label: string): string {
  if (servers.length === 1) return `MCP ${servers[0]}: ${label}`;
  return `MCP ${servers.join(", ")}: ${label}`;
}

function parseMcp(body: string, status: boolean): McpNoticeDetails | null {
  const newline = body.indexOf("\n");
  if (newline < 0) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(body.slice(newline + 1));
  } catch {
    return null;
  }
  if (!isRecord(payload)) return null;
  const servers: string[] = [];
  const addServer = (server: string) => {
    if (!servers.includes(server)) servers.push(server);
  };
  const events: McpNoticeEvent[] = [];
  const statuses: McpNoticeStatus[] = [];
  if (!status && Array.isArray(payload.events)) {
    for (const item of payload.events) {
      if (!isRecord(item) || typeof item.server !== "string") continue;
      const event = isRecord(item.event) ? item.event : {};
      addServer(item.server);
      const timestamp = text(event.timestamp);
      events.push({
        server: item.server,
        // A multiplexed stream carries the kind in data.kind (`hub.job` on a `hub` stream).
        name: (isRecord(event.data) ? text(event.data.kind) : null) || text(event.name) || "event",
        timestamp: timestamp === null ? null : toIsoTimestamp(timestamp),
        id: text(event.eventId),
        subscriptionId: text(item.subscription_id),
        data: event.data,
      });
    }
  }
  if (status && Array.isArray(payload.subscriptions)) {
    for (const item of payload.subscriptions) {
      if (!isRecord(item) || typeof item.server !== "string") continue;
      addServer(item.server);
      statuses.push({
        server: item.server,
        name: text(item.name) ?? "subscription",
        status: text(item.status) ?? "changed",
        error: text(item.error),
      });
    }
  }
  const droppedValue = status ? payload.dropped_statuses : payload.dropped_events;
  const dropped = typeof droppedValue === "number" ? droppedValue : 0;
  if (events.length === 0 && statuses.length === 0) return null;
  let label: string;
  if (status) {
    const first = statuses[0];
    label =
      statuses.length === 1 && first !== undefined
        ? `${first.name} ${first.status}`
        : `${statuses.length} subscription changes`;
  } else {
    const first = events[0];
    const names = new Set(events.map((event) => event.name));
    label =
      events.length === 1 && first !== undefined
        ? `${first.name} event`
        : names.size === 1 && first !== undefined
          ? `${events.length} ${first.name} events`
          : `${events.length} events`;
  }
  return { kind: "mcp", servers, events, statuses, dropped, summary: mcpSummary(servers, label) };
}

/** Longest memory body a chip keeps; the rest stays on disk only. */
export const MEMORY_NOTICE_TEXT_LIMIT = 2_000;

export function memoryNoticeSummary(path: string): string {
  return `memory · ${path}`;
}

/** Caps the text stored with a memory chip, telling the panel when it was cut. */
export function memoryNoticeText(value: string): { text: string; truncated: boolean } {
  if (value.length <= MEMORY_NOTICE_TEXT_LIMIT) return { text: value, truncated: false };
  return { text: value.slice(0, MEMORY_NOTICE_TEXT_LIMIT), truncated: true };
}

/** The steer a reader sends from a memory chip's Undo button. */
export function memoryUndoPrompt(path: string): string {
  return `Undo the memory write to ${path} — restore the previous content of that file and confirm.`;
}

/** The notice a message stands for, or null for an ordinary message. */
export function parseNotice(message: string): ChatNotice | null {
  if (message.startsWith("[background job ")) return parseJob(message.split("\n"));
  if (message.startsWith(MCP_EVENTS_HEAD)) return parseMcp(message, false);
  if (message.startsWith(MCP_STATUS_HEAD)) return parseMcp(message, true);
  return null;
}
