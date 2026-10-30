/**
 * The agent-editable dashboard: widget config, the path mapper that turns
 * source data into a widget's view, token masking, and the builtin sources.
 * Shared by the server (poll and static widgets) and the client (builtins).
 */
import type { ContextUsage, McpStatus, UsageSummary } from "./types.js";

export const WIDGET_KINDS = ["stat", "list", "table", "sparkline", "markdown", "status"] as const;
export type WidgetKind = (typeof WIDGET_KINDS)[number];

export const BUILTIN_SOURCES = ["tokens", "context", "cache", "mcp", "jobs", "session"] as const;
export type BuiltinName = (typeof BUILTIN_SOURCES)[number];

export const WIDGET_SPANS = ["full", "half", "third"] as const;
export type WidgetSpan = (typeof WIDGET_SPANS)[number];

export type WidgetSource =
  | { type: "builtin"; name: BuiltinName }
  | {
      type: "poll";
      /** Body of an async function `(fetch, env, prev, log)` that returns JSON. */
      script: string;
      intervalSec?: number;
      timeoutSec?: number;
    }
  | { type: "static" };

/** Field name → path expression, a `=literal`, or (table `columns`) header → path. */
export type WidgetMapping = Record<string, string | Record<string, string>>;

export interface Widget {
  id: string;
  title: string;
  kind: WidgetKind;
  source: WidgetSource;
  mapping: WidgetMapping;
}

export interface LayoutSlot {
  id: string;
  span: WidgetSpan;
}

export interface LayoutSection {
  title?: string;
  widgets: LayoutSlot[];
}

export interface DashboardLayout {
  sections: LayoutSection[];
}

export interface DashboardConfig {
  version: 1;
  widgets: Widget[];
  layout: DashboardLayout;
}

export type StatusState = "ok" | "warn" | "error";

export type WidgetView =
  | {
      kind: "stat";
      value: string;
      label?: string;
      delta?: string;
      trend?: "up" | "down" | "flat";
      unit?: string;
      /** 0–100, drawn as a meter. */
      progress?: number;
    }
  | { kind: "list"; items: { key?: string; label: string; value?: string }[]; empty?: string }
  | { kind: "table"; columns: string[]; rows: string[][]; empty?: string }
  | { kind: "sparkline"; points: number[]; value?: string; label?: string }
  | { kind: "markdown"; text: string }
  | {
      kind: "status";
      items: { key?: string; label: string; state: StatusState; detail?: string }[];
      empty?: string;
    };

export interface WidgetValue {
  view?: WidgetView;
  error?: string;
  updatedAt?: string;
  /** Polls failed in a row; the last good view is kept. */
  failures: number;
}

export interface BuiltinJob {
  id: string;
  name: string;
  status: string;
  exitCode: number | null;
  startedAt: string;
  endedAt: string | null;
}

export interface BuiltinSession {
  conversationId: string;
  model: string | null;
  run: string;
}

/** The `dashboard` stream frame and `GET /api/dashboard`. Poll scripts are not sent. */
export interface DashboardState {
  widgets: Widget[];
  layout: DashboardLayout;
  values: Record<string, WidgetValue>;
  builtins: { jobs: BuiltinJob[]; session: BuiltinSession };
  /** True while some client has the dashboard open, so polls run. */
  polling: boolean;
}

export const MAX_WIDGETS = 40;
export const MAX_POLL_WIDGETS = 10;
export const MAX_ROWS = 200;
export const MAX_COLUMNS = 12;
export const MAX_CELL = 400;
export const HISTORY_POINTS = 30;

export class DashboardError extends Error {}

// ---------- path expressions ----------

type Step = { t: "key"; k: string } | { t: "index"; i: number } | { t: "each" };

/**
 * Parses `a.b`, `a[]`, `a[].b`, `a[0]`, `a[-1]`, `["odd key"]`, with an optional
 * leading `$`. `$` or an empty path is the whole value.
 */
export function parsePath(path: string): Step[] {
  let source = path.trim();
  if (source === "$" || source === "") return [];
  if (source.startsWith("$.")) source = source.slice(2);
  else if (source.startsWith("$[")) source = source.slice(1);
  const steps: Step[] = [];
  let index = 0;
  let expectSegment = true;
  while (index < source.length) {
    const char = source[index];
    if (char === "[") {
      const end = source.indexOf("]", index);
      if (end < 0) throw new DashboardError(`Unclosed [ in path "${path}".`);
      const inner = source.slice(index + 1, end).trim();
      if (inner === "") steps.push({ t: "each" });
      else if (/^-?\d+$/.test(inner)) steps.push({ t: "index", i: Number(inner) });
      else if (/^(["']).*\1$/.test(inner)) steps.push({ t: "key", k: inner.slice(1, -1) });
      else throw new DashboardError(`Bad [${inner}] in path "${path}".`);
      index = end + 1;
      expectSegment = false;
    } else if (char === ".") {
      if (expectSegment) throw new DashboardError(`Empty segment in path "${path}".`);
      index += 1;
      expectSegment = true;
      if (index >= source.length) throw new DashboardError(`Path "${path}" ends with a dot.`);
    } else {
      if (!expectSegment) throw new DashboardError(`Missing dot before "${char}" in "${path}".`);
      let end = index;
      while (end < source.length && source[end] !== "." && source[end] !== "[") end += 1;
      steps.push({ t: "key", k: source.slice(index, end).trim() });
      index = end;
      expectSegment = false;
    }
  }
  return steps;
}

/** Reads a path. Any `[]` makes the result an array, one entry per element. */
export function evalPath(data: unknown, path: string): unknown {
  let values: unknown[] = [data];
  let multi = false;
  for (const step of parsePath(path)) {
    const next: unknown[] = [];
    for (const value of values) {
      if (step.t === "each") {
        if (Array.isArray(value)) next.push(...value);
        continue;
      }
      if (step.t === "index") {
        next.push(Array.isArray(value) ? value.at(step.i) : undefined);
        continue;
      }
      if (Array.isArray(value) && step.k === "length") next.push(value.length);
      else if (value !== null && typeof value === "object" && Object.hasOwn(value, step.k)) {
        next.push((value as Record<string, unknown>)[step.k]);
      } else next.push(undefined);
    }
    if (step.t === "each") multi = true;
    values = next;
  }
  return multi ? values : values[0];
}

/** A mapping field: `=text` is a literal, anything else a path. */
export function resolveField(data: unknown, field: string | undefined): unknown {
  if (field === undefined) return undefined;
  if (field.startsWith("=")) return field.slice(1);
  return evalPath(data, field);
}

export function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return String(value);
    return value.toLocaleString("en-US", { maximumFractionDigits: 4 });
  }
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "string")
    return value.length > MAX_CELL ? `${value.slice(0, MAX_CELL)}…` : value;
  const json = JSON.stringify(value) ?? String(value);
  return json.length > MAX_CELL ? `${json.slice(0, MAX_CELL)}…` : json;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value.replace(/[,_\s]/g, ""));
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function asArray(value: unknown, field: string, path?: string): unknown[] {
  const where = path === undefined ? `"${field}"` : `${field} "${path}"`;
  if (value === null) return [];
  if (value === undefined) throw new DashboardError(`${where} matched nothing in the data.`);
  if (!Array.isArray(value)) throw new DashboardError(`${where} must point at an array.`);
  return value;
}

const OK_STATES = new Set([
  "ok",
  "up",
  "running",
  "healthy",
  "success",
  "succeeded",
  "active",
  "available",
  "connected",
  "online",
  "passing",
  "green",
  "true",
  "yes",
]);
const WARN_STATES = new Set([
  "warn",
  "warning",
  "starting",
  "stopping",
  "pending",
  "degraded",
  "initializing",
  "migrating",
  "rebuilding",
  "queued",
  "off",
  "unknown",
  "yellow",
]);

export function normalizeState(value: unknown): StatusState {
  const text = String(value ?? "")
    .trim()
    .toLowerCase();
  if (OK_STATES.has(text)) return "ok";
  if (WARN_STATES.has(text)) return "warn";
  return "error";
}

function optionalText(data: unknown, field: string | undefined): string | undefined {
  const value = resolveField(data, field);
  return value === undefined || value === null ? undefined : formatValue(value);
}

function stringField(mapping: WidgetMapping, name: string): string | undefined {
  const value = mapping[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new DashboardError(`Mapping "${name}" must be a string.`);
  return value;
}

/** Required mapping fields per kind; the rest are optional. */
export const KIND_FIELDS: Record<WidgetKind, { required: string[][]; optional: string[] }> = {
  stat: { required: [["value"]], optional: ["label", "delta", "unit", "progress"] },
  list: { required: [["items"]], optional: ["key", "label", "value", "empty"] },
  table: { required: [["columns"]], optional: ["rows", "empty"] },
  sparkline: { required: [["value", "series"]], optional: ["label"] },
  markdown: { required: [["text"]], optional: [] },
  status: { required: [["items", "state"]], optional: ["key", "label", "detail", "empty"] },
};

/** Checks a mapping's fields and path syntax for its kind. Throws a DashboardError. */
export function validateMapping(kind: WidgetKind, mapping: WidgetMapping): void {
  const spec = KIND_FIELDS[kind];
  const allowed = new Set([...spec.required.flat(), ...spec.optional]);
  for (const [name, value] of Object.entries(mapping)) {
    if (!allowed.has(name)) {
      throw new DashboardError(`"${name}" is not a ${kind} field; use ${[...allowed].join(", ")}.`);
    }
    if (name === "columns") {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new DashboardError('"columns" must be an object of header → path.');
      }
      const entries = Object.entries(value);
      if (entries.length === 0 || entries.length > MAX_COLUMNS) {
        throw new DashboardError(`A table needs 1–${MAX_COLUMNS} columns.`);
      }
      for (const [, path] of entries) {
        if (typeof path !== "string") throw new DashboardError("Column paths must be strings.");
        if (!path.startsWith("=")) parsePath(path);
      }
      continue;
    }
    if (typeof value !== "string") throw new DashboardError(`Mapping "${name}" must be a string.`);
    if (value.length > 300) throw new DashboardError(`Mapping "${name}" is too long.`);
    if (!value.startsWith("=")) parsePath(value);
  }
  for (const choice of spec.required) {
    if (!choice.some((name) => mapping[name] !== undefined)) {
      throw new DashboardError(`A ${kind} widget needs mapping "${choice.join('" or "')}".`);
    }
  }
}

/** Builds a widget's view from its source data. `history` is earlier numeric values. */
export function renderWidget(widget: Widget, data: unknown, history: number[] = []): WidgetView {
  const { mapping } = widget;
  switch (widget.kind) {
    case "stat": {
      const value = resolveField(data, stringField(mapping, "value"));
      const deltaRaw = resolveField(data, stringField(mapping, "delta"));
      const deltaNumber = asNumber(deltaRaw);
      const progress = asNumber(resolveField(data, stringField(mapping, "progress")));
      const view: WidgetView = { kind: "stat", value: formatValue(value) };
      const label = optionalText(data, stringField(mapping, "label"));
      if (label !== undefined) view.label = label;
      const unit = optionalText(data, stringField(mapping, "unit"));
      if (unit !== undefined) view.unit = unit;
      if (deltaRaw !== undefined && deltaRaw !== null) {
        const text = formatValue(deltaRaw);
        view.delta =
          deltaNumber !== undefined && deltaNumber > 0 && !text.startsWith("+") ? `+${text}` : text;
        const sign = deltaNumber ?? (text.startsWith("-") ? -1 : text.startsWith("+") ? 1 : 0);
        view.trend = sign > 0 ? "up" : sign < 0 ? "down" : "flat";
      }
      if (progress !== undefined) view.progress = Math.max(0, Math.min(100, progress));
      return view;
    }
    case "list": {
      const items = asArray(
        resolveField(data, stringField(mapping, "items")),
        "items",
        stringField(mapping, "items"),
      ).slice(0, MAX_ROWS);
      const label = stringField(mapping, "label");
      const value = stringField(mapping, "value");
      const key = stringField(mapping, "key");
      return {
        kind: "list",
        items: items.map((item) => {
          const row: { key?: string; label: string; value?: string } = {
            label: formatValue(label === undefined ? item : resolveField(item, label)),
          };
          const rowValue = optionalText(item, value);
          if (rowValue !== undefined) row.value = rowValue;
          const rowKey = optionalText(item, key);
          if (rowKey !== undefined) row.key = rowKey;
          return row;
        }),
        ...emptyText(data, mapping),
      };
    }
    case "table": {
      const columns = mapping.columns as Record<string, string>;
      const headers = Object.keys(columns);
      const rowsPath = stringField(mapping, "rows");
      let rows: string[][];
      if (rowsPath !== undefined) {
        rows = asArray(resolveField(data, rowsPath), "rows", rowsPath)
          .slice(0, MAX_ROWS)
          .map((row) => headers.map((header) => formatValue(resolveField(row, columns[header]))));
      } else {
        const cells = headers.map((header) => {
          const value = resolveField(data, columns[header]);
          return Array.isArray(value) ? value : [value];
        });
        const count = Math.min(MAX_ROWS, Math.max(0, ...cells.map((column) => column.length)));
        rows = Array.from({ length: count }, (_, index) =>
          cells.map((column) => formatValue(column[index])),
        );
      }
      return { kind: "table", columns: headers, rows, ...emptyText(data, mapping) };
    }
    case "sparkline": {
      const seriesPath = stringField(mapping, "series");
      const label = optionalText(data, stringField(mapping, "label"));
      if (seriesPath !== undefined) {
        const points = asArray(resolveField(data, seriesPath), "series", seriesPath)
          .map(asNumber)
          .filter((point): point is number => point !== undefined)
          .slice(-MAX_ROWS);
        const last = points.at(-1);
        return {
          kind: "sparkline",
          points,
          ...(last === undefined ? {} : { value: formatValue(last) }),
          ...(label === undefined ? {} : { label }),
        };
      }
      const raw = resolveField(data, stringField(mapping, "value"));
      const current = asNumber(raw);
      return {
        kind: "sparkline",
        points: [...history, ...(current === undefined ? [] : [current])].slice(-HISTORY_POINTS),
        value: formatValue(raw),
        ...(label === undefined ? {} : { label }),
      };
    }
    case "markdown": {
      const text = resolveField(data, stringField(mapping, "text"));
      const body = typeof text === "string" ? text : formatValue(text);
      return { kind: "markdown", text: body.slice(0, 20_000) };
    }
    case "status": {
      const itemsPath = stringField(mapping, "items");
      const label = stringField(mapping, "label");
      const state = stringField(mapping, "state");
      const detail = stringField(mapping, "detail");
      const key = stringField(mapping, "key");
      if (itemsPath === undefined) {
        return {
          kind: "status",
          items: [
            {
              label: optionalText(data, label) ?? widget.title,
              state: normalizeState(resolveField(data, state)),
              ...withDetail(optionalText(data, detail)),
            },
          ],
        };
      }
      const items = asArray(resolveField(data, itemsPath), "items", itemsPath).slice(0, MAX_ROWS);
      return {
        kind: "status",
        items: items.map((item) => {
          const rowKey = optionalText(item, key);
          return {
            ...(rowKey === undefined ? {} : { key: rowKey }),
            label: formatValue(label === undefined ? item : resolveField(item, label)),
            state: normalizeState(state === undefined ? item : resolveField(item, state)),
            ...withDetail(optionalText(item, detail)),
          };
        }),
        ...emptyText(data, mapping),
      };
    }
  }
}

function withDetail(detail: string | undefined): { detail?: string } {
  return detail === undefined ? {} : { detail };
}

function emptyText(data: unknown, mapping: WidgetMapping): { empty?: string } {
  const empty = optionalText(data, stringField(mapping, "empty"));
  return empty === undefined ? {} : { empty };
}

/** The number a stat or sparkline shows, kept as history for sparklines. */
export function viewNumber(widget: Widget, data: unknown): number | undefined {
  if (widget.kind !== "stat" && widget.kind !== "sparkline") return undefined;
  const field = widget.mapping.value;
  if (typeof field !== "string") return undefined;
  return asNumber(resolveField(data, field));
}

// ---------- masking ----------

const MASK = "••••";

const SECRET_PATTERNS: RegExp[] = [
  /\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  /\b(?:gh[pousr]_|github_pat_|sk-|sk_live_|sk_test_|rk_live_|xox[abprs]-|glpat-|AKIA|AIza)[A-Za-z0-9_-]{8,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g,
];
const LONG_RUN = /[A-Za-z0-9_+/-]{32,}={0,2}/g;

/**
 * Hides token-looking text: known secret values, auth headers, well-known
 * key prefixes, JWTs, and long runs that mix upper case, lower case and
 * digits. Plain hex (hashes, ids) and ordinary words are left alone.
 */
export function maskSecrets(text: string, secrets: readonly string[] = []): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length >= 8 && out.includes(secret)) out = out.split(secret).join(MASK);
  }
  out = out.replace(SECRET_PATTERNS[0], (_, scheme: string) => `${scheme} ${MASK}`);
  for (const pattern of SECRET_PATTERNS.slice(1)) out = out.replace(pattern, MASK);
  return out.replace(LONG_RUN, (run) =>
    /[a-z]/.test(run) && /[A-Z]/.test(run) && /\d/.test(run) && !/^[0-9a-fA-F]+$/.test(run)
      ? MASK
      : run,
  );
}

/** Masks every string in a JSON value, keys included. */
export function maskDeep<T>(value: T, secrets: readonly string[] = []): T {
  if (typeof value === "string") return maskSecrets(value, secrets) as T;
  if (Array.isArray(value)) return value.map((item) => maskDeep(item, secrets)) as T;
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        maskSecrets(key, secrets),
        maskDeep(item, secrets),
      ]),
    ) as T;
  }
  return value;
}

/** Masks the strings in a view, for anything shown on the page. */
export function maskView(view: WidgetView): WidgetView {
  return maskDeep(view);
}

// ---------- builtin sources ----------

export interface BuiltinInputs {
  usage: UsageSummary | null;
  context: ContextUsage | null;
  mcp: McpStatus;
  jobs: BuiltinJob[];
  session: BuiltinSession;
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

/** Live data pi-ui already has, as plain JSON a widget mapping can read. */
export function builtinData(name: BuiltinName, inputs: BuiltinInputs): unknown {
  const { usage, context, mcp } = inputs;
  switch (name) {
    case "tokens": {
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
    case "context": {
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
    case "cache": {
      const hit = usage === null ? null : cacheHitRate(usage);
      return {
        read: usage?.cacheRead ?? null,
        write: usage?.cacheWrite ?? null,
        hitRate: hit,
        hitPercent: hit === null ? null : Math.round(hit * 1000) / 10,
        text: hit === null ? unavailable("no model call yet") : percent(hit),
      };
    }
    case "mcp":
      return {
        count: mcp.servers.length,
        unavailable: mcp.unavailable,
        servers: mcp.servers.map((server) => ({
          key: `mcp-${server.name}`,
          name: server.name,
          available: server.available,
          authRejected: server.authRejected,
          tools: server.tools.length,
          state: server.available ? "ok" : server.authRejected ? "warn" : "error",
          detail: server.available
            ? `connected · ${server.tools.length} tool${server.tools.length === 1 ? "" : "s"}`
            : server.authRejected
              ? "auth rejected"
              : "unavailable",
        })),
      };
    case "jobs": {
      const jobs = [...inputs.jobs].reverse();
      return {
        total: jobs.length,
        running: jobs.filter((job) => job.status === "running").length,
        jobs: jobs.map((job) => ({
          ...job,
          key: `job-${job.id}`,
          label: `${job.id} ${job.name}`,
          state: jobState(job),
          detail: job.status === "exited" ? `exited ${job.exitCode ?? "?"}` : job.status,
        })),
      };
    }
    case "session":
      return {
        ...inputs.session,
        rows: [
          { key: "session-model", label: "model", value: inputs.session.model ?? "unknown" },
          { key: "session-run", label: "run", value: inputs.session.run },
          { key: "session-id", label: "conversation", value: inputs.session.conversationId },
        ],
      };
  }
}

/** The stats page as widgets: what a new dashboard starts with. */
export function defaultDashboard(): DashboardConfig {
  return {
    version: 1,
    widgets: [
      {
        id: "context",
        title: "Context",
        kind: "stat",
        source: { type: "builtin", name: "context" },
        mapping: { value: "text", label: "=size", progress: "percent" },
      },
      {
        id: "tokens",
        title: "Tokens",
        kind: "list",
        source: { type: "builtin", name: "tokens" },
        mapping: { items: "rows", key: "key", label: "label", value: "value" },
      },
      {
        id: "mcp",
        title: "MCP",
        kind: "status",
        source: { type: "builtin", name: "mcp" },
        mapping: {
          items: "servers",
          key: "key",
          label: "name",
          state: "state",
          detail: "detail",
          empty: "=no MCP servers configured",
        },
      },
    ],
    layout: {
      sections: [
        {
          widgets: [
            { id: "context", span: "full" },
            { id: "tokens", span: "full" },
            { id: "mcp", span: "full" },
          ],
        },
      ],
    },
  };
}
