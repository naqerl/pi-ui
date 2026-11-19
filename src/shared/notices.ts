import { toIsoTimestamp } from "./time.js";

export interface JobNoticeDetails {
  kind: "job";
  id: string;
  name: string;
  command: string;
  status: "running" | "exited" | "failed" | "cancelled" | "lost";
  exitCode: number | null;
  signal: string | null;
  duration: string | null;
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
  raw?: string;
}

export interface MemoryNoticeDetails {
  kind: "memory";
  path: string;
  text: string;
  truncated: boolean;
  summary: string;
}

export interface MemoryDeltaTopic {
  path: string;
  title: string;
  chars: number;
  updated: string;
  readonly [key: string]: string | number;
}

export interface MemoryDeltaDetails {
  kind: "memory-delta";
  topics: MemoryDeltaTopic[];
  summary: string;
}

export interface IdleNoticeDetails {
  kind: "idle";
  text: string;
  taskIds: string[];
  summary: string;
  stale?: true;
  closed?: true;
}

export interface OperatorNoticeRecord {
  title: string;
  body: string;
  reason: string;
}

export interface OperatorNoticeDetails extends OperatorNoticeRecord {
  kind: "operator";
  summary: string;
}

export type TaskProposalDecision = "approved" | "declined";

export interface TaskDecisionNoticeRecord extends OperatorNoticeRecord {
  proposalId: string;
  taskId: string;
  taskTitle: string;
  decision: TaskProposalDecision;
}

export interface TaskDecisionNoticeDetails extends TaskDecisionNoticeRecord {
  kind: "decision";
  text: string;
  summary: string;
}

export interface DelegateNoticeDetails {
  kind: "delegate";
  runId: string;
  agent: string;
  status: "completed" | "failed" | "cancelled";
  task: string;
  resultPath: string;
  activityPath: string;
  duration: string | null;
  tokens: { input: number; output: number } | null;
  error: string | null;
  excerpt: string | null;
  summary: string;
}

export interface InterruptedNoticeDetails {
  kind: "interrupted";
  note: string;
  stopped: boolean;
  summary?: string;
}

export type ChatNotice =
  | JobNoticeDetails
  | McpNoticeDetails
  | DelegateNoticeDetails
  | InterruptedNoticeDetails
  | MemoryNoticeDetails
  | MemoryDeltaDetails
  | IdleNoticeDetails
  | OperatorNoticeDetails
  | TaskDecisionNoticeDetails;

const JOB_HEAD = /^\[background job (\S+) finished\] (\S+) (.+?): (.*)$/;
const DELEGATE_HEAD =
  /^\[acp_delegate (completed|FAILED[^\]]*)\] \*\*(.+?)\*\* \(runId `([^`]+)`\) (completed|failed) after (.+?)\.$/;
const DELEGATE_TURN_HEAD =
  /^\[acp_delegate (completed|FAILED[^\]]*|cancelled)\] run `([^`]+)` (finished|failed|cancelled) after (.+?)\.$/;
export const MCP_EVENTS_HEAD = "MCP event data follows.";
export const MCP_EVENTS_TRAILER =
  "This is a background MCP event notification, not a user message. Do not reply to it, do not summarise it, and never repeat its JSON. If it needs action, act; otherwise continue silently.";
export const MCP_STATUS_HEAD = "MCP subscription status follows.";
export const MAX_PENDING_MCP_EVENTS = 50;
const IDLE_HEAD = /^You have been idle for \d+ minutes and (\d+) task\(s\) are open: ([^.]+)\./;
const IDLE_STATUS_HEAD = /(?:^|\. )Status check for tasks marked working: ([^.]+)\./;
const IDLE_BLOCKED_HEAD = /^You have been idle for \d+ minutes\. Nothing is unblocked: (.+)\.$/;
const IDLE_ACTUALIZE_HEAD =
  /Actualize these tasks\. These tasks were marked as working, but nothing has touched them for over an hour: ([\s\S]+?)\. For each one, confirm/;
const IDLE_MEMORY_HEAD =
  /You closed (.+?) since the last nudge and have not written anything durable about (?:it|them)\./;
const IDLE_MEMORY_NAMES = /(?:^|,\s*)([^\s,]+)\s+"[^"]*"/g;
const STALE_RUN_HEAD =
  /^Tasks? (.+?) (?:has|have) had no tool call for \d+ minutes\. Confirm whether .*\bupdate the task ledger accordingly\.$/;
const TASK_APPROVED_HEAD =
  /^Task proposal (\S+) was approved and is now task (\S+): ([\s\S]*?)\.\nYou may start working on it now; it is no longer waiting for approval\.$/;
const TASK_DECLINED_HEAD =
  /^Task proposal (\S+) was declined: ([\s\S]*?)\.\nDo not start work on it and do not propose it again\.$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface BoundedMcpEventBatch {
  readonly items: unknown[];
  readonly dropped: number;
}

export function boundMcpEventBatch(items: readonly unknown[]): BoundedMcpEventBatch {
  const seen = new Set<string>();
  const distinct: unknown[] = [];
  for (const [index, item] of items.entries()) {
    let key = `item:${index}:${JSON.stringify(item)}`;
    if (isRecord(item) && isRecord(item.event)) {
      const event = item.event;
      if (typeof event.eventId === "string" || typeof event.eventId === "number") {
        key = JSON.stringify([
          typeof item.server === "string" ? item.server : "",
          typeof event.name === "string" ? event.name : "event",
          event.eventId,
        ]);
      }
    }
    if (seen.has(key)) continue;
    seen.add(key);
    distinct.push(item);
  }
  if (distinct.length <= MAX_PENDING_MCP_EVENTS) {
    return { items: [...items], dropped: 0 };
  }
  return {
    items: distinct.slice(-MAX_PENDING_MCP_EVENTS),
    dropped: distinct.length - MAX_PENDING_MCP_EVENTS,
  };
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function withoutMcpTrailer(body: string): string {
  const trimmed = body.trimEnd();
  if (!trimmed.endsWith(MCP_EVENTS_TRAILER)) return trimmed;
  return trimmed.slice(0, -MCP_EVENTS_TRAILER.length).trimEnd();
}

export function parseMcpEventPayload(body: string): Record<string, unknown> | null {
  try {
    const payload: unknown = JSON.parse(withoutMcpTrailer(body));
    return isRecord(payload) ? payload : null;
  } catch {
    return null;
  }
}

function echoText(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

export function isMcpEventEcho(value: string, latestNotice: string | null = null): boolean {
  const trimmed = value.trim();
  if (trimmed.startsWith(MCP_EVENTS_HEAD)) {
    const newline = trimmed.indexOf("\n");
    if (newline >= 0) {
      const payload = parseMcpEventPayload(trimmed.slice(newline + 1));
      if (payload !== null && Array.isArray(payload.events)) return true;
    }
  }
  return latestNotice !== null && echoText(trimmed) === echoText(latestNotice);
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

function parseDelegate(lines: string[]): DelegateNoticeDetails | null {
  const modern = DELEGATE_TURN_HEAD.exec(lines[0] ?? "");
  if (modern !== null) return parseModernDelegate(lines, modern);
  const head = DELEGATE_HEAD.exec(lines[0] ?? "");
  if (head === null) return null;
  const [, marker = "", agent = "", runId = "", outcome = "", duration = ""] = head;
  const status: DelegateNoticeDetails["status"] =
    outcome === "completed" ? "completed" : marker.startsWith("FAILED") ? "failed" : "cancelled";
  const fields = delegateFields(lines.slice(1));
  const state = status === "completed" ? "finished" : status === "failed" ? "FAILED" : "cancelled";
  return {
    kind: "delegate",
    runId,
    agent,
    status,
    task: fields.task,
    resultPath: fields.resultPath,
    activityPath: fields.activityPath,
    duration: duration.length === 0 ? null : duration,
    tokens: fields.tokens,
    error: fields.error,
    excerpt: fields.excerpt,
    summary: `delegate ${agent} · ${state}`,
  };
}

function parseModernDelegate(lines: string[], head: RegExpExecArray): DelegateNoticeDetails {
  const [, marker = "", runId = "", verb = "", duration = ""] = head;
  const status: DelegateNoticeDetails["status"] =
    verb === "finished"
      ? "completed"
      : verb === "cancelled" || !marker.startsWith("FAILED")
        ? "cancelled"
        : "failed";
  const fields = delegateFields(lines.slice(1));
  const state = status === "completed" ? "finished" : status === "failed" ? "FAILED" : "cancelled";
  return {
    kind: "delegate",
    runId,
    agent: "subagent",
    status,
    task: fields.task,
    resultPath: fields.resultPath,
    activityPath: fields.activityPath,
    duration: duration.length === 0 ? null : duration,
    tokens: fields.tokens,
    error: fields.error,
    excerpt: fields.excerpt,
    summary: `subagent · ${state}`,
  };
}

function delegateFields(lines: readonly string[]): {
  task: string;
  resultPath: string;
  activityPath: string;
  error: string | null;
  tokens: DelegateNoticeDetails["tokens"];
  excerpt: string | null;
} {
  let task = "";
  let resultPath = "";
  let activityPath = "";
  let error: string | null = null;
  let tokens: DelegateNoticeDetails["tokens"] = null;
  const excerptLines: string[] = [];
  let inExcerpt = false;
  for (const line of lines) {
    if (inExcerpt) {
      if (line.startsWith("Continue this sub-agent") || line.startsWith("This sub-agent did not")) {
        break;
      }
      excerptLines.push(line);
      continue;
    }
    if (line === "Excerpt:") {
      inExcerpt = true;
      continue;
    }
    if (line.startsWith("Prompt: ")) task = line.slice("Prompt: ".length);
    else if (line.startsWith("Task: ")) task = line.slice("Task: ".length);
    else if (line.startsWith("Result: ")) resultPath = line.slice("Result: ".length);
    else if (line.startsWith("Activity: ")) activityPath = line.slice("Activity: ".length);
    else if (line.startsWith("Error: ")) error = line.slice("Error: ".length);
    else {
      const usage = /^Tokens: ([\d,]+) in, ([\d,]+) out\.$/.exec(line);
      if (usage !== null) {
        tokens = {
          input: Number(usage[1]?.replaceAll(",", "") ?? 0),
          output: Number(usage[2]?.replaceAll(",", "") ?? 0),
        };
      }
    }
  }
  const excerpt = excerptLines.join("\n").trim();
  return {
    task,
    resultPath,
    activityPath,
    error,
    tokens,
    excerpt: excerpt.length > 0 ? excerpt : null,
  };
}

function mcpSummary(servers: string[], label: string): string {
  if (servers.length === 1) return `MCP ${servers[0]}: ${label}`;
  return `MCP ${servers.join(", ")}: ${label}`;
}

function actualizeIds(named: string): string[] {
  const ids: string[] = [];
  for (const match of named.matchAll(/(?:^|,\s*)([^\s,]+)\s+—\s+/g)) {
    const id = match[1];
    if (id !== undefined && id.length > 0) ids.push(id);
  }
  return ids;
}

function memoryClosureIds(body: string): string[] {
  const head = IDLE_MEMORY_HEAD.exec(body);
  if (head === null) return [];
  const ids: string[] = [];
  for (const match of (head[1] ?? "").matchAll(IDLE_MEMORY_NAMES)) {
    const id = match[1];
    if (id !== undefined && id.length > 0) ids.push(id);
  }
  return ids;
}

function parseIdle(body: string): IdleNoticeDetails | null {
  const text = body.trim();
  const ids = (value: string | undefined) => {
    if (value === undefined) return [];
    return value
      .split(",")
      .map((id) => id.trim())
      .filter((id) => id.length > 0);
  };
  const stale = STALE_RUN_HEAD.exec(text);
  if (stale !== null) {
    const taskIds = ids(stale[1]);
    if (taskIds.length === 0) return null;
    return {
      kind: "idle",
      text,
      taskIds,
      summary: `status check · ${taskIds.join(", ")}`,
      stale: true,
    };
  }
  const actualize = IDLE_ACTUALIZE_HEAD.exec(text);
  const actualizeTaskIds = actualize === null ? [] : actualizeIds(actualize[1] ?? "");
  const closureIds = memoryClosureIds(text);
  const head = text.split("\n", 1)[0] ?? "";
  const match = IDLE_HEAD.exec(head);
  const status = IDLE_STATUS_HEAD.exec(head);
  if (match !== null || status !== null) {
    const openIds = ids(match?.[2]);
    const workingIds = ids(status?.[1]);
    const taskIds = [...new Set([...openIds, ...workingIds, ...actualizeTaskIds, ...closureIds])];
    if (taskIds.length === 0) return null;
    return {
      kind: "idle",
      text,
      taskIds,
      summary:
        openIds.length > 0
          ? `idle · ${openIds.length} task(s) open: ${openIds.join(", ")}`
          : `idle · ${workingIds.length} task(s) working: ${workingIds.join(", ")}`,
    };
  }
  const blocked = IDLE_BLOCKED_HEAD.exec(head);
  if (blocked === null) {
    const taskIds = [...new Set([...actualizeTaskIds, ...closureIds])];
    if (taskIds.length === 0) return null;
    if (actualizeTaskIds.length === 0) {
      return {
        kind: "idle",
        text,
        taskIds,
        summary: `idle · ${taskIds.length} task(s) closed: ${taskIds.join(", ")}`,
        closed: true,
      };
    }
    return {
      kind: "idle",
      text,
      taskIds,
      summary: `idle · ${actualizeTaskIds.length} task(s) working: ${actualizeTaskIds.join(", ")}`,
    };
  }
  const waits = (blocked[1] ?? "")
    .split(";")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (waits.length === 0) return null;
  const taskIds = waits
    .map((entry) => /^(\S+) waits on\b/.exec(entry)?.[1])
    .filter((id): id is string => id !== undefined);
  return {
    kind: "idle",
    text,
    taskIds: [...new Set([...taskIds, ...actualizeTaskIds, ...closureIds])],
    summary: `idle · nothing unblocked: ${waits.join("; ")}`,
  };
}

function unparsedMcp(body: string): McpNoticeDetails {
  return {
    kind: "mcp",
    servers: [],
    events: [],
    statuses: [],
    dropped: 0,
    summary: "/mcp",
    raw: body,
  };
}

function parseMcp(body: string, status: boolean): McpNoticeDetails {
  const newline = body.indexOf("\n");
  if (newline < 0) return unparsedMcp(body);
  const payload = parseMcpEventPayload(body.slice(newline + 1));
  if (payload === null) return unparsedMcp(body);
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
  if (events.length === 0 && statuses.length === 0) return unparsedMcp(body);
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

export const MEMORY_NOTICE_TEXT_LIMIT = 2_000;

export function memoryNoticeSummary(path: string): string {
  return `memory · ${path}`;
}

export function memoryDeltaSummary(topics: readonly MemoryDeltaTopic[]): string {
  if (topics.length === 1) return `memory updated · ${topics[0]?.path ?? ""}`;
  return `memory updated · ${topics.length} topics`;
}

export function operatorNoticeSummary(title: string): string {
  return `operator · ${title}`;
}

export function taskDecisionPrompt(record: TaskDecisionNoticeRecord): string {
  if (record.decision === "approved") {
    return `Task proposal ${record.proposalId} was approved and is now task ${record.taskId}: ${record.taskTitle}.\nYou may start working on it now; it is no longer waiting for approval.`;
  }
  return `Task proposal ${record.proposalId} was declined: ${record.taskTitle}.\nDo not start work on it and do not propose it again.`;
}

export function taskDecisionSummary(
  record: Pick<TaskDecisionNoticeRecord, "proposalId" | "taskId" | "taskTitle" | "decision">,
): string {
  return record.decision === "approved"
    ? `proposal ${record.proposalId} approved as ${record.taskId} · ${record.taskTitle}`
    : `proposal ${record.proposalId} declined · ${record.taskTitle}`;
}

function parseTaskDecision(body: string): TaskDecisionNoticeDetails | null {
  const text = body.trim();
  const approved = TASK_APPROVED_HEAD.exec(text);
  const declined = approved === null ? TASK_DECLINED_HEAD.exec(text) : null;
  const match = approved ?? declined;
  if (match === null) return null;
  const proposalId = match[1] ?? "";
  const taskId = approved === null ? proposalId : (match[2] ?? proposalId);
  const taskTitle = match[approved === null ? 2 : 3] ?? "";
  if (proposalId.length === 0 || taskId.length === 0 || taskTitle.length === 0) return null;
  const decision: TaskProposalDecision = approved === null ? "declined" : "approved";
  return {
    kind: "decision",
    proposalId,
    taskId,
    taskTitle,
    decision,
    title: approved === null ? "Proposal declined" : "Proposal approved",
    body: `${approved === null ? "Proposal declined" : "Proposal approved"}: ${taskTitle}`,
    reason: "A human made this decision on the tasks page.",
    text,
    summary: taskDecisionSummary({ proposalId, taskId, taskTitle, decision }),
  };
}

export function memoryNoticeText(value: string): { text: string; truncated: boolean } {
  if (value.length <= MEMORY_NOTICE_TEXT_LIMIT) return { text: value, truncated: false };
  return { text: value.slice(0, MEMORY_NOTICE_TEXT_LIMIT), truncated: true };
}

export function memoryUndoPrompt(path: string): string {
  return `Undo the memory write to ${path} — restore the previous content of that file and confirm.`;
}

export function isMcpNotice(message: string): boolean {
  return message.startsWith(MCP_EVENTS_HEAD) || message.startsWith(MCP_STATUS_HEAD);
}

export function parseNotice(message: string): ChatNotice | null {
  if (message.startsWith("[background job ")) return parseJob(message.split("\n"));
  if (message.startsWith("[acp_delegate ")) return parseDelegate(message.split("\n"));
  if (message.startsWith(MCP_EVENTS_HEAD)) return parseMcp(message, false);
  if (message.startsWith(MCP_STATUS_HEAD)) return parseMcp(message, true);
  if (message.startsWith("Task proposal ")) return parseTaskDecision(message);
  if (
    message.startsWith("You have been idle for ") ||
    message.startsWith("You closed ") ||
    message.startsWith("Task ") ||
    message.startsWith("Tasks ")
  ) {
    return parseIdle(message);
  }
  return null;
}
