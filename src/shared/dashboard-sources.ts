/**
 * The dashboard source registry. A source turns live data into JSON; widgets
 * render that JSON through their mapping, exactly like a poll or pushed value.
 * Builtin pi-ui data is registered here so it has no separate rendering path.
 */
import {
  type BuiltinJob,
  type BuiltinSession,
  DashboardError,
  MCP_EVENT_WIDGET_LIMIT,
  type StatusState,
  subscriptionHealth,
  subscriptionLabel,
} from "./dashboard.js";
import { formatDurationMinutes } from "./time.js";
import type {
  ContextUsage,
  McpEventsState,
  McpStatus,
  TaskDurationStats,
  TaskReopenStats,
  UsageSummary,
} from "./types.js";

export const BUILTIN_SOURCES = [
  "tokens",
  "context",
  "cache",
  "mcp",
  "mcp_events",
  "jobs",
  "session",
  "task_reopens",
  "task_durations",
] as const;
export type BuiltinName = (typeof BUILTIN_SOURCES)[number];

export interface SourceContext {
  usage: UsageSummary | null;
  context: ContextUsage | null;
  mcp: McpStatus;
  mcpEvents: McpEventsState;
  jobs: BuiltinJob[];
  session: BuiltinSession;
  taskReopens?: TaskReopenStats;
  taskDurations?: TaskDurationStats;
  /** Client-only display hook; the server deliberately leaves timestamps raw. */
  formatTime?: (timestamp: string) => string;
}

/** Compatibility name for the live data a builtin source reads. */
export type BuiltinInputs = SourceContext;

export interface SourceSpec {
  name: string;
  /** What the source offers and the shape of its payload, for discovery. */
  describe: string;
  kind?: "builtin" | "poll" | "static";
  /** A small, real payload with the source's shape. */
  sample: unknown;
  read(ctx: SourceContext): Promise<unknown>;
}

const sources = new Map<string, SourceSpec>();

export function registerSource(spec: SourceSpec): void {
  if (spec.name.trim() === "") throw new DashboardError("A source needs a name.");
  if (sources.has(spec.name)) {
    throw new DashboardError(`Source "${spec.name}" is already registered.`);
  }
  sources.set(spec.name, spec);
}

export function listSources(): SourceSpec[] {
  return [...sources.values()];
}

export function hasSource(name: string): boolean {
  return sources.has(name);
}

export async function readSource(name: string, ctx: SourceContext): Promise<unknown> {
  const spec = sources.get(name);
  if (spec === undefined) {
    throw new DashboardError(
      `Unknown source "${name}"; use one of ${[...sources.keys()].join(", ")}.`,
    );
  }
  return spec.read(ctx);
}

function emptyContext(): SourceContext {
  return {
    usage: null,
    context: null,
    mcp: { servers: [], unavailable: [] },
    mcpEvents: { subscriptions: [], events: [], notice: null, revision: 0 },
    jobs: [],
    session: { conversationId: "", model: null, run: "idle" },
  };
}

const LIVE_SUBSCRIPTION = new Set(["opening", "active", "reconnecting"]);

function subscriptionState(status: string): StatusState {
  if (LIVE_SUBSCRIPTION.has(status)) return status === "active" ? "ok" : "warn";
  return status === "stopped" ? "warn" : "error";
}

function exact(count: number): string {
  return Math.max(0, Math.round(count)).toLocaleString("en-US");
}

function percent(value: number): string {
  const scaled = value * 100;
  return `${scaled >= 10 || scaled === 0 ? Math.round(scaled) : scaled.toFixed(1)}%`;
}

const unavailable = (reason: string) => `unavailable · ${reason}`;

/** Share of prompt tokens served from the provider cache. Null before any model call. */
export function cacheHitRate(usage: UsageSummary): number | null {
  const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
  if (prompt <= 0) return null;
  return usage.cacheRead / prompt;
}

function costText(usage: UsageSummary | null): string {
  const called = usage !== null && usage.input + usage.output + usage.cacheRead > 0;
  if (usage === null || !called) return unavailable("no model call yet");
  if (usage.cost > 0) return `$${usage.cost.toFixed(usage.cost < 1 ? 4 : 2)}`;
  return unavailable("provider reports no price");
}

function jobState(job: BuiltinJob): StatusState {
  if (job.status === "running") return "ok";
  if (job.status === "exited") return job.exitCode === 0 ? "ok" : "error";
  if (job.status === "failed") return "error";
  return "warn";
}

function tokensData({ usage }: SourceContext): unknown {
  const none = unavailable("no snapshot yet");
  const hit = usage === null ? null : cacheHitRate(usage);
  return {
    input: usage?.input ?? null,
    output: usage?.output ?? null,
    cacheRead: usage?.cacheRead ?? null,
    cacheWrite: usage?.cacheWrite ?? null,
    totalTokens: usage?.totalTokens ?? null,
    cost: usage?.cost ?? null,
    costText: costText(usage),
    rows: [
      { key: "input", label: "in", value: usage === null ? none : exact(usage.input) },
      { key: "output", label: "out", value: usage === null ? none : exact(usage.output) },
      {
        key: "cache-read",
        label: "cache read",
        value: usage === null ? none : exact(usage.cacheRead),
      },
      {
        key: "cache-write",
        label: "cache write",
        value: usage === null ? none : exact(usage.cacheWrite),
      },
      {
        key: "cache-hit",
        label: "cache hit",
        value: hit === null ? unavailable("no model call yet") : percent(hit),
      },
      { key: "cost", label: "cost", value: costText(usage) },
    ],
  };
}

function contextData({ context }: SourceContext): unknown {
  let text: string;
  if (context === null) text = unavailable("no snapshot yet");
  else if (context.tokens === 0) text = unavailable("no model call yet");
  else if (context.window === null || context.percent === null) {
    text = `${exact(context.tokens)} tokens · ${unavailable("model window unknown")}`;
  } else text = `${exact(context.tokens)} / ${exact(context.window)} · ${context.percent}%`;
  return {
    tokens: context?.tokens ?? null,
    window: context?.window ?? null,
    percent: context !== null && context.tokens > 0 ? context.percent : null,
    text,
  };
}

function cacheData({ usage }: SourceContext): unknown {
  const hit = usage === null ? null : cacheHitRate(usage);
  return {
    read: usage?.cacheRead ?? null,
    write: usage?.cacheWrite ?? null,
    hitRate: hit,
    hitPercent: hit === null ? null : Math.round(hit * 1000) / 10,
    text: hit === null ? unavailable("no model call yet") : percent(hit),
  };
}

function mcpData({ mcp, mcpEvents }: SourceContext): unknown {
  const subscriptions = mcpEvents.subscriptions.map((item) => ({
    item,
    health: subscriptionHealth(item),
  }));
  const live = subscriptions.filter(({ health }) => health === "active");
  const problems = subscriptions.filter(
    ({ health }) => health === "stalled" || health === "recovering" || health === "dead",
  );
  return {
    count: mcp.servers.length,
    unavailable: mcp.unavailable,
    servers: mcp.servers.map((server) => {
      const subscribed = live
        .filter(({ item }) => item.server === server.name)
        .map(({ item }) => subscriptionLabel(item));
      const broken = problems
        .filter(({ item }) => item.server === server.name)
        .map(({ item, health }) => {
          const label = subscriptionLabel(item);
          const reason = item.lastError ?? item.lastReconnectReason ?? item.endReason;
          return `${label}: ${health}${reason === undefined ? "" : ` · ${reason}`}`;
        });
      const base = server.available
        ? server.tools.length === 0
          ? "no tools"
          : `${server.tools.length} tool${server.tools.length === 1 ? "" : "s"}`
        : server.authRejected
          ? "auth rejected"
          : unavailable("server unreachable");
      const detail =
        server.available && broken.length > 0
          ? `${base} · ${broken.join(", ")}`
          : subscribed.length === 0
            ? base
            : `${base} · subscribed: ${subscribed.join(", ")}`;
      return {
        key: `mcp-${server.name}`,
        name: server.name,
        available: server.available,
        authRejected: server.authRejected,
        tools: server.tools.length,
        subscriptions: subscribed,
        problems: broken,
        state: server.available
          ? broken.length > 0
            ? "warn"
            : "ok"
          : server.authRejected
            ? "warn"
            : "error",
        detail,
      };
    }),
  };
}

function mcpEventsData({ mcpEvents, formatTime }: SourceContext): unknown {
  const { events, subscriptions } = mcpEvents;
  const recent = events.slice(-MCP_EVENT_WIDGET_LIMIT).reverse();
  const health = subscriptions.map((item) => subscriptionHealth(item));
  return {
    total: events.length,
    live: [
      ...new Set(
        subscriptions
          .filter((_item, index) => health[index] === "active")
          .map((item) => item.server),
      ),
    ],
    problems: subscriptions
      .filter((_item, index) => {
        const state = health[index];
        return state === "stalled" || state === "recovering" || state === "dead";
      })
      .map((item) => ({
        server: item.server,
        label: subscriptionLabel(item),
        state: subscriptionHealth(item),
        reason: item.lastError ?? item.lastReconnectReason ?? item.endReason ?? null,
      })),
    latest: recent[0] === undefined ? null : `new event from ${recent[0].server}`,
    events: recent.map((event) => {
      const formatted = formatTime?.(event.timestamp);
      const clock = formatted === undefined || formatted === "" ? null : formatted;
      return {
        key: `mcp-event-${event.id}`,
        id: event.id,
        server: event.server,
        name: event.name,
        timestamp: event.timestamp,
        time: clock ?? event.timestamp,
        summary: event.summary,
        ...(event.replayed === true ? { replayed: true } : {}),
        label: `${event.server} · ${event.name}`,
        value:
          clock === null
            ? event.summary
            : event.summary.length > 0
              ? `${clock} · ${event.summary}`
              : clock,
      };
    }),
    subscriptions: subscriptions.map((item) => {
      const health = subscriptionHealth(item);
      const warning = health === "stalled" || health === "recovering" || health === "dead";
      const reason = item.lastError ?? item.lastReconnectReason ?? item.endReason;
      const cursor = item.cursor ?? null;
      return {
        key: `mcp-sub-${item.id}`,
        id: item.id,
        stableId: item.stableId,
        server: item.server,
        name: item.name,
        title: item.title ?? null,
        status: item.status,
        state: warning ? "warn" : subscriptionState(item.status),
        cursor,
        label: subscriptionLabel(item),
        detail: warning
          ? `${health}${reason === undefined ? "" : ` · ${reason}`}`
          : cursor === null
            ? item.status
            : `${item.status} · cursor ${cursor}`,
      };
    }),
  };
}

function jobsData({ jobs }: SourceContext): unknown {
  const items = [...jobs].reverse();
  return {
    total: items.length,
    running: items.filter((job) => job.status === "running").length,
    jobs: items.map((job) => ({
      ...job,
      key: `job-${job.id}`,
      label: `${job.id} ${job.name}`,
      state: jobState(job),
      detail: job.status === "exited" ? `exited ${job.exitCode ?? "?"}` : job.status,
    })),
  };
}

function taskReopensData({ taskReopens }: SourceContext): unknown {
  const summary = taskReopens ?? {
    totalReopenedTasks: 0,
    totalReopens: 0,
    reopensThisWeek: 0,
    projects: [],
  };
  const projects = summary.projects.map((item) => ({
    key: item.project ?? "none",
    project: item.project ?? "No project",
    label: item.project ?? "No project",
    reopenedTasks: item.reopenedTasks,
    reopens: item.reopens,
    reopensThisWeek: item.reopensThisWeek,
    value: `${item.reopenedTasks} task${item.reopenedTasks === 1 ? "" : "s"} · ${item.reopensThisWeek} this week`,
  }));
  return {
    totalReopenedTasks: summary.totalReopenedTasks,
    totalReopened: summary.totalReopenedTasks,
    totalReopens: summary.totalReopens,
    reopensThisWeek: summary.reopensThisWeek,
    rows: [
      {
        key: "all",
        project: "All projects",
        label: "All projects",
        reopenedTasks: summary.totalReopenedTasks,
        reopens: summary.totalReopens,
        reopensThisWeek: summary.reopensThisWeek,
        value: `${summary.totalReopenedTasks} task${summary.totalReopenedTasks === 1 ? "" : "s"} · ${summary.reopensThisWeek} this week`,
      },
      ...projects,
    ],
    projects,
  };
}

function taskDurationsData({ taskDurations }: SourceContext): unknown {
  const summary = taskDurations ?? {
    count: 0,
    avgMinutes: 0,
    p50Minutes: 0,
    p90Minutes: 0,
    longestMinutes: 0,
    projects: [],
  };
  const projects = summary.projects.map((item) => ({
    key: item.project === "(none)" ? "none" : item.project,
    project: item.project,
    label: item.project,
    count: item.count,
    avgMinutes: item.avgMinutes,
    p90Minutes: item.p90Minutes,
    value: `${item.count} task${item.count === 1 ? "" : "s"} · avg ${formatDurationMinutes(item.avgMinutes)} · p90 ${formatDurationMinutes(item.p90Minutes)}`,
  }));
  return {
    total: summary.count,
    p50: summary.p50Minutes,
    p90: summary.p90Minutes,
    avg: summary.avgMinutes,
    rows:
      summary.count === 0
        ? []
        : [
            {
              key: "p50",
              label: "p50",
              value: formatDurationMinutes(summary.p50Minutes),
            },
            {
              key: "p90",
              label: "p90",
              value: formatDurationMinutes(summary.p90Minutes),
            },
            {
              key: "avg",
              label: "avg",
              value: formatDurationMinutes(summary.avgMinutes),
            },
            ...projects,
          ],
  };
}

const TASK_DURATIONS_SAMPLE = taskDurationsData({
  ...emptyContext(),
  taskDurations: {
    count: 3,
    avgMinutes: 90,
    p50Minutes: 60,
    p90Minutes: 180,
    longestMinutes: 180,
    projects: [{ project: "pi-ui", count: 3, avgMinutes: 90, p90Minutes: 180 }],
  },
});

function sessionData({ session }: SourceContext): unknown {
  return {
    ...session,
    rows: [
      { key: "session-model", label: "model", value: session.model ?? "unknown" },
      { key: "session-run", label: "run", value: session.run },
      { key: "session-id", label: "conversation", value: session.conversationId },
    ],
  };
}

function registerBuiltin(
  name: BuiltinName,
  describe: string,
  read: (ctx: SourceContext) => unknown,
  sample?: unknown,
): void {
  registerSource({
    name,
    describe,
    kind: "builtin",
    sample: sample ?? read(emptyContext()),
    async read(ctx) {
      return read(ctx);
    },
  });
}

registerBuiltin(
  "tokens",
  "Token usage for the current conversation: input, output, cache read/write, total, cost and a rows[] list ready for a list widget.",
  tokensData,
);
registerBuiltin(
  "context",
  "Context-window use: tokens, window, percent and a formatted text field, with null percent before the first model call.",
  contextData,
);
registerBuiltin(
  "cache",
  "Prompt-cache use: read, write, hitRate (0..1), hitPercent and a formatted text field.",
  cacheData,
);
registerBuiltin(
  "mcp",
  "Configured MCP servers: count, unavailable names and servers[] with name, availability, tool count, subscriptions, state and detail.",
  mcpData,
);
registerBuiltin(
  "mcp_events",
  "Recent MCP activity: total, live servers, problems, the last 3 events newest first, and subscriptions with their health.",
  mcpEventsData,
);
registerBuiltin(
  "jobs",
  "Background jobs: total, running count and jobs[] with id, name, status, exit code, state and detail.",
  jobsData,
);
registerBuiltin(
  "session",
  "The current session: conversationId, model, run state and rows[] ready for a list widget.",
  sessionData,
);
registerBuiltin(
  "task_reopens",
  "Task reopen counts: total reopened tasks and reopens this week, plus rows[] grouped by project.",
  taskReopensData,
);
registerBuiltin(
  "task_durations",
  "Closed-task durations: count, p50, p90 and average minutes, plus rows[] with p50, p90, avg and one project row each.",
  taskDurationsData,
  TASK_DURATIONS_SAMPLE,
);
