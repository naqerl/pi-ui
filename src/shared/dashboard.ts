import type { BuiltinName } from "./dashboard-sources.js";
import type { TaskDurationStats, TaskReopenStats, UsageSummary } from "./types.js";

export const WIDGET_KINDS = ["stat", "list", "table", "sparkline", "markdown", "status"] as const;
export type WidgetKind = (typeof WIDGET_KINDS)[number];

export const WIDGET_SPANS = ["full", "half", "third"] as const;
export type WidgetSpan = (typeof WIDGET_SPANS)[number];

export const CHART_TYPES = ["area", "line", "bar"] as const;
export type ChartType = (typeof CHART_TYPES)[number];

export const CHART_FORMATS = ["number", "currency", "percent", "bytes"] as const;
export type ChartFormat = (typeof CHART_FORMATS)[number];

export interface ChartSeries {
  key: string;
  label?: string;

  color?: string;
  type?: ChartType;
  dashed?: boolean;

  fillOpacity?: number;
  stack?: string;
}

export interface ChartReference {
  value: number;
  label?: string;

  color?: string;

  dashed?: boolean;
}

export interface SparklineChart {
  type?: ChartType;

  color?: string;
  height?: number;

  legend?: boolean;
  showTooltip?: boolean;
  yDomain?: [number, number] | "auto";
  y?: { format?: ChartFormat; ticks?: number; currency?: string };
  x?: { labels?: string[]; format?: string };
  series?: ChartSeries[];
  reference?: ChartReference[];
}

export interface SparklineSeries {
  key: string;
  label?: string;
  points: (number | null)[];
}

export const SPAN_COLUMNS: Record<WidgetSpan, number> = { full: 12, half: 6, third: 4 };
export const GRID_COLUMNS = 12;
export const DEFAULT_WIDGET_ROWS = 4;

export function widthForSpan(span: WidgetSpan): number {
  return SPAN_COLUMNS[span];
}

export function spanForWidth(width: number): WidgetSpan {
  if (width >= 10) return "full";
  if (width >= 5) return "half";
  return "third";
}

export function packLayoutSlots(slots: readonly LayoutSlot[], reset = false): LayoutSlot[] {
  const occupied = new Set<string>();
  const placed: LayoutSlot[] = [];
  const fits = (x: number, y: number, w: number, h: number): boolean => {
    for (let row = y; row < y + h; row += 1) {
      for (let column = x; column < x + w; column += 1) {
        if (occupied.has(`${column}:${row}`)) return false;
      }
    }
    return true;
  };
  const take = (x: number, y: number, w: number, h: number): void => {
    for (let row = y; row < y + h; row += 1) {
      for (let column = x; column < x + w; column += 1) occupied.add(`${column}:${row}`);
    }
  };
  const firstFit = (fromY: number, w: number, h: number): { x: number; y: number } => {
    for (let row = Math.max(0, Math.round(fromY)); row < 10_000; row += 1) {
      for (let column = 0; column <= GRID_COLUMNS - w; column += 1) {
        if (fits(column, row, w, h)) return { x: column, y: row };
      }
    }
    return { x: 0, y: Math.max(0, Math.round(fromY)) };
  };
  for (const slot of slots) {
    const w = Math.max(1, Math.min(GRID_COLUMNS, slot.w ?? widthForSpan(slot.span)));
    const h = Math.max(1, Math.min(100, slot.h ?? DEFAULT_WIDGET_ROWS));
    let x = reset ? undefined : slot.x;
    let y = reset ? undefined : slot.y;
    if (x !== undefined && y !== undefined) {
      x = Math.max(0, Math.min(GRID_COLUMNS - w, Math.round(x)));
      y = Math.max(0, Math.round(y));
    }
    if (x === undefined || y === undefined || !fits(x, y, w, h)) {
      const next = firstFit(y ?? 0, w, h);
      x = next.x;
      y = next.y;
    }
    take(x, y, w, h);
    placed.push({ ...slot, span: spanForWidth(w), x, y, w, h });
  }
  return placed.sort((a, b) => (a.y ?? 0) - (b.y ?? 0) || (a.x ?? 0) - (b.x ?? 0));
}

export type WidgetSource =
  | { type: "builtin"; name: BuiltinName }
  | {
      type: "poll";

      script: string;
      intervalSec?: number;
      timeoutSec?: number;
    }
  | { type: "static" };

export type WidgetMapping = Record<string, string | Record<string, string>>;

export interface Widget {
  id: string;
  title: string;
  kind: WidgetKind;
  source: WidgetSource;
  mapping: WidgetMapping;

  chart?: SparklineChart;
}

export interface LayoutSlot {
  id: string;
  span: WidgetSpan;

  x?: number;
  y?: number;
  w?: number;
  h?: number;
}

export interface LayoutSection {
  title?: string;
  widgets: LayoutSlot[];
}

export interface DashboardLayout {
  sections: LayoutSection[];
}

export interface DashboardConfig {
  version: number;

  tombstones: string[];

  defaultVersion?: number;
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

      progress?: number;
    }
  | { kind: "list"; items: { key?: string; label: string; value?: string }[]; empty?: string }
  | { kind: "table"; columns: string[]; rows: string[][]; empty?: string }
  | {
      kind: "sparkline";

      points?: (number | null)[];

      series?: SparklineSeries[];
      labels?: string[];
      value?: string;
      label?: string;
    }
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

  failures: number;
}

export interface BuiltinJob {
  id: string;
  name: string;
  status: string;
  exitCode: number | null;
  startedAt: string;
  endedAt: string | null;

  command?: string;
  cwd?: string;
}

export interface BuiltinSession {
  conversationId: string;
  model: string | null;
  run: string;
}

export interface DashboardState {
  widgets: Widget[];
  layout: DashboardLayout;
  values: Record<string, WidgetValue>;
  builtins: {
    jobs: BuiltinJob[];
    session: BuiltinSession;
    taskReopens?: TaskReopenStats;
    taskDurations?: TaskDurationStats;
  };

  polling: boolean;

  defaultVersion?: number;
}

export const MAX_WIDGETS = 40;
export const MAX_POLL_WIDGETS = 10;
export const MAX_SECTIONS = 12;
export const MAX_ROWS = 200;
export const MAX_COLUMNS = 12;
export const MAX_CELL = 400;
export const HISTORY_POINTS = 30;

export class DashboardError extends Error {}

type Step = { t: "key"; k: string } | { t: "index"; i: number } | { t: "each" };

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
  "stalled",
  "recovering",
  "dead",
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

export const KIND_FIELDS: Record<WidgetKind, { required: string[][]; optional: string[] }> = {
  stat: { required: [["value"]], optional: ["label", "delta", "unit", "progress"] },
  list: { required: [["items"]], optional: ["key", "label", "value", "empty"] },
  table: { required: [["columns"]], optional: ["rows", "empty"] },
  sparkline: { required: [["value", "series"]], optional: ["label", "labels"] },
  markdown: { required: [["text"]], optional: [] },
  status: { required: [["items", "state"]], optional: ["key", "label", "detail", "empty"] },
};

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
      const labelsPath = stringField(mapping, "labels");
      const valuePath = stringField(mapping, "value");
      const mappedValue = valuePath === undefined ? undefined : resolveField(data, valuePath);
      const mappedText =
        typeof mappedValue === "string"
          ? mappedValue === ""
            ? undefined
            : formatValue(mappedValue)
          : typeof mappedValue === "number"
            ? formatValue(mappedValue)
            : undefined;
      const label = optionalText(data, stringField(mapping, "label"));
      if (seriesPath !== undefined) {
        const raw = resolveField(data, seriesPath);
        const labels =
          labelsPath === undefined
            ? undefined
            : asArray(resolveField(data, labelsPath), "labels", labelsPath)
                .map((item) => formatValue(item))
                .slice(-MAX_ROWS);
        const shared = {
          kind: "sparkline" as const,
          ...(label === undefined ? {} : { label }),
        };
        if (Array.isArray(raw) && raw.every((item) => !isRecord(item))) {
          const points = raw
            .map(asNumber)
            .filter((point): point is number => point !== undefined)
            .slice(-MAX_ROWS);
          const last = points.at(-1);
          const headline =
            valuePath === undefined
              ? last === undefined
                ? undefined
                : formatValue(last)
              : mappedText;
          return {
            ...shared,
            points,
            ...(labels === undefined || labels.length === 0
              ? {}
              : { labels: labels.slice(0, points.length) }),
            ...(headline === undefined ? {} : { value: headline }),
          };
        }
        const series = namedSeries(raw, seriesPath);
        const longest = Math.max(0, ...series.map((item) => item.points.length));
        const last = lastPoint(series[0]?.points);
        const headline =
          valuePath === undefined
            ? last === undefined
              ? undefined
              : formatValue(last)
            : mappedText;
        return {
          ...shared,
          series,
          ...(labels === undefined || labels.length === 0
            ? {}
            : { labels: labels.slice(0, longest) }),
          ...(headline === undefined ? {} : { value: headline }),
        };
      }
      const current = asNumber(mappedValue);
      return {
        kind: "sparkline",
        points: [...history, ...(current === undefined ? [] : [current])].slice(-HISTORY_POINTS),
        ...(mappedValue === "" ? {} : { value: formatValue(mappedValue) }),
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function namedSeries(raw: unknown, path: string): SparklineSeries[] {
  if (Array.isArray(raw)) {
    return raw.map((item, index) => {
      if (!isRecord(item) || typeof item.key !== "string" || !Array.isArray(item.points)) {
        throw new DashboardError(
          `series "${path}"[${index}] must be { key, label?, points: (number | null)[] }.`,
        );
      }
      const key = item.key.trim();
      if (key === "") throw new DashboardError(`series "${path}"[${index}].key is empty.`);
      return {
        key,
        ...(typeof item.label === "string" && item.label.trim() !== ""
          ? { label: item.label.trim() }
          : {}),
        points: item.points
          .map((point: unknown) => (point === null ? null : (asNumber(point) ?? null)))
          .slice(-MAX_ROWS),
      };
    });
  }
  if (isRecord(raw)) {
    return Object.entries(raw).map(([key, value]) => {
      if (!Array.isArray(value)) {
        throw new DashboardError(`series "${path}.${key}" must be an array of numbers.`);
      }
      return {
        key,
        points: value
          .map(asNumber)
          .filter((point): point is number => point !== undefined)
          .slice(-MAX_ROWS),
      };
    });
  }
  throw new DashboardError(`series "${path}" must point at an array or an object of arrays.`);
}

function lastPoint(points: (number | null)[] | undefined): number | undefined {
  if (points === undefined) return undefined;
  for (let index = points.length - 1; index >= 0; index -= 1) {
    const point = points[index];
    if (point !== null && point !== undefined) return point;
  }
  return undefined;
}

function withDetail(detail: string | undefined): { detail?: string } {
  return detail === undefined ? {} : { detail };
}

function emptyText(data: unknown, mapping: WidgetMapping): { empty?: string } {
  const empty = optionalText(data, stringField(mapping, "empty"));
  return empty === undefined ? {} : { empty };
}

export function viewNumber(widget: Widget, data: unknown): number | undefined {
  if (widget.kind !== "stat" && widget.kind !== "sparkline") return undefined;
  const field = widget.mapping.value;
  if (typeof field !== "string") return undefined;
  return asNumber(resolveField(data, field));
}

const MASK = "••••";

const SECRET_PATTERNS: RegExp[] = [
  /\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  /\b(?:gh[pousr]_|github_pat_|sk-|sk_live_|sk_test_|rk_live_|xox[abprs]-|glpat-|AKIA|AIza)[A-Za-z0-9_-]{8,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g,
];
const LONG_RUN = /[A-Za-z0-9_+/-]{32,}={0,2}/g;

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

export function maskView(view: WidgetView): WidgetView {
  return maskDeep(view);
}

export const MCP_EVENT_LIMIT = 20;

export const MCP_EVENT_WIDGET_LIMIT = 3;

export function subscriptionHealth(item: {
  status: string;
  state?: string;
}): "active" | "stalled" | "recovering" | "dead" | "cancelled" {
  if (
    item.state === "active" ||
    item.state === "stalled" ||
    item.state === "recovering" ||
    item.state === "dead" ||
    item.state === "cancelled"
  ) {
    return item.state;
  }
  if (item.status === "cancelled" || item.status === "stopped" || item.status === "ended") {
    return "cancelled";
  }
  if (item.status === "failed") return "stalled";
  if (item.status === "opening" || item.status === "reconnecting") return "recovering";
  return "active";
}

export function subscriptionLabel(item: {
  title?: string;
  stableId?: string;
  name: string;
  arguments?: Record<string, unknown>;
}): string {
  if (item.title !== undefined) return item.title;
  if (Object.keys(item.arguments ?? {}).length > 0) return item.stableId ?? item.name;
  return item.name;
}

export function cacheHitRate(usage: UsageSummary): number | null {
  const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
  if (prompt <= 0) return null;
  return usage.cacheRead / prompt;
}
