import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  BUILTIN_SOURCES,
  type BuiltinInputs,
  type BuiltinJob,
  type BuiltinName,
  type BuiltinSession,
  builtinData,
  type DashboardConfig,
  DashboardError,
  type DashboardLayout,
  type DashboardState,
  defaultDashboard,
  HISTORY_POINTS,
  type LayoutSection,
  MAX_POLL_WIDGETS,
  MAX_WIDGETS,
  maskDeep,
  maskSecrets,
  renderWidget,
  upgradeDashboard,
  validateMapping,
  viewNumber,
  WIDGET_KINDS,
  WIDGET_SPANS,
  type Widget,
  type WidgetKind,
  type WidgetMapping,
  type WidgetSource,
  type WidgetSpan,
  type WidgetValue,
  type WidgetView,
} from "../shared/dashboard.js";
import { type PollOutcome, type PollRunner, runPollScript } from "./dashboard-runner.js";

export { DashboardError };

/** What the dashboard needs from the rest of the server. Set once the chat is up. */
export interface DashboardHost {
  builtinInputs(): Promise<BuiltinInputs>;
  builtinsLite(): { jobs: BuiltinJob[]; session: BuiltinSession };
  notify(text: string): void;
  broadcast(state: DashboardState): void;
}

export interface DashboardOptions {
  /** Shortest poll interval. 30s; tests lower it. */
  minIntervalMs?: number;
  /** How long a client's "dashboard is open" report lasts without a refresh. */
  viewerTtlMs?: number;
  runner?: PollRunner;
  env?: Record<string, string | undefined>;
  /** Cap on a poll result or pushed data, as JSON bytes. */
  maxBytes?: number;
  now?: () => number;
}

interface RuntimeValue extends WidgetValue {
  data?: unknown;
  history: number[];
  lastRunAt?: number;
  notified?: boolean;
  logs?: string[];
}

export interface WidgetResult {
  widget: Widget;
  view?: WidgetView;
  error?: string;
  updatedAt?: string;
  /** Start of the source data, for writing the mapping. */
  sample?: string;
  logs?: string[];
  notes: string[];
  polling: boolean;
}

export const FAILURES_BEFORE_BACKOFF = 5;
export const DEFAULT_INTERVAL_SEC = 60;
const DEFAULT_TIMEOUT_SEC = 10;
const MAX_TIMEOUT_SEC = 30;
const MAX_BACKOFF_MS = 60 * 60 * 1000;
const MAX_SCRIPT = 20_000;
const SAMPLE_CHARS = 2_000;
const SECRET_NAME = /TOKEN|SECRET|PASSW|API_?KEY|PRIVATE|CREDENTIAL|AUTH|SESSION|COOKIE/i;
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseSource(input: unknown, minIntervalSec: number, notes: string[]): WidgetSource {
  let source = input;
  if (typeof source === "string") {
    const [type, name] = source.split(":", 2);
    source = { type, ...(name === undefined ? {} : { name }) };
  }
  if (!isRecord(source)) throw new DashboardError("source must be an object with a type.");
  switch (source.type) {
    case "builtin": {
      const name = source.name;
      if (typeof name !== "string" || !(BUILTIN_SOURCES as readonly string[]).includes(name)) {
        throw new DashboardError(
          `builtin source name must be one of ${BUILTIN_SOURCES.join(", ")}.`,
        );
      }
      return { type: "builtin", name: name as BuiltinName };
    }
    case "static":
      return { type: "static" };
    case "poll": {
      const script = source.script;
      if (typeof script !== "string" || script.trim() === "") {
        throw new DashboardError(
          "A poll source needs a script: the body of an async function that returns JSON.",
        );
      }
      if (script.length > MAX_SCRIPT)
        throw new DashboardError(`The script is over ${MAX_SCRIPT} characters.`);
      let intervalSec = DEFAULT_INTERVAL_SEC;
      if (source.intervalSec !== undefined) {
        if (typeof source.intervalSec !== "number" || !Number.isFinite(source.intervalSec)) {
          throw new DashboardError("intervalSec must be a number.");
        }
        intervalSec = Math.round(source.intervalSec * 1000) / 1000;
      }
      if (intervalSec < minIntervalSec) {
        notes.push(`intervalSec raised to the ${minIntervalSec}s minimum.`);
        intervalSec = minIntervalSec;
      }
      let timeoutSec = DEFAULT_TIMEOUT_SEC;
      if (source.timeoutSec !== undefined) {
        if (typeof source.timeoutSec !== "number" || !Number.isFinite(source.timeoutSec)) {
          throw new DashboardError("timeoutSec must be a number.");
        }
        timeoutSec = Math.min(MAX_TIMEOUT_SEC, Math.max(1, Math.round(source.timeoutSec)));
      }
      return { type: "poll", script, intervalSec, timeoutSec };
    }
    default:
      throw new DashboardError('source.type must be "builtin", "poll" or "static".');
  }
}

/** Checks and normalizes a widget from the agent or from disk. */
export function parseWidget(input: unknown, minIntervalSec: number, notes: string[] = []): Widget {
  if (!isRecord(input)) throw new DashboardError("A widget must be an object.");
  const id = typeof input.id === "string" ? input.id.trim() : "";
  if (!ID.test(id)) {
    throw new DashboardError(
      "id must be 1–48 letters, digits, - or _, starting with a letter or digit.",
    );
  }
  const title = typeof input.title === "string" ? input.title.trim() : "";
  if (title === "" || title.length > 80) throw new DashboardError("title must be 1–80 characters.");
  const kind = input.kind;
  if (typeof kind !== "string" || !(WIDGET_KINDS as readonly string[]).includes(kind)) {
    throw new DashboardError(`kind must be one of ${WIDGET_KINDS.join(", ")}.`);
  }
  const source = parseSource(input.source, minIntervalSec, notes);
  const mappingInput = input.mapping ?? {};
  if (!isRecord(mappingInput)) throw new DashboardError("mapping must be an object.");
  const mapping = mappingInput as WidgetMapping;
  validateMapping(kind as WidgetKind, mapping);
  return { id, title, kind: kind as WidgetKind, source, mapping };
}

/** Checks a layout against the widget ids; widgets it leaves out go in a last section. */
export function parseLayout(
  input: unknown,
  ids: readonly string[],
  notes: string[] = [],
): DashboardLayout {
  if (!isRecord(input) || !Array.isArray(input.sections)) {
    throw new DashboardError("layout needs sections: [{ title?, widgets: [{ id, span? }] }].");
  }
  if (input.sections.length > 12) throw new DashboardError("Use at most 12 sections.");
  const known = new Set(ids);
  const placed = new Set<string>();
  const sections: LayoutSection[] = input.sections.map((section, index) => {
    if (!isRecord(section) || !Array.isArray(section.widgets)) {
      throw new DashboardError(`Section ${index + 1} needs a widgets array.`);
    }
    const title = section.title;
    if (title !== undefined && (typeof title !== "string" || title.length > 60)) {
      throw new DashboardError(
        `Section ${index + 1} title must be a string of up to 60 characters.`,
      );
    }
    const widgets = section.widgets.map((slot) => {
      const entry = typeof slot === "string" ? { id: slot } : slot;
      if (!isRecord(entry) || typeof entry.id !== "string") {
        throw new DashboardError(`Section ${index + 1} has a slot without an id.`);
      }
      const id = entry.id.trim();
      if (!known.has(id)) {
        throw new DashboardError(`Unknown widget "${id}". Widgets: ${ids.join(", ") || "none"}.`);
      }
      if (placed.has(id)) throw new DashboardError(`Widget "${id}" is placed twice.`);
      placed.add(id);
      const span = entry.span ?? "full";
      if (typeof span !== "string" || !(WIDGET_SPANS as readonly string[]).includes(span)) {
        throw new DashboardError(`span must be ${WIDGET_SPANS.join(", ")}.`);
      }
      return { id, span: span as WidgetSpan };
    });
    const trimmed = typeof title === "string" ? title.trim() : "";
    return trimmed === "" ? { widgets } : { title: trimmed, widgets };
  });
  const missing = ids.filter((id) => !placed.has(id));
  if (missing.length > 0) {
    sections.push({ widgets: missing.map((id) => ({ id, span: "full" as const })) });
    notes.push(`Not placed, so added at the end: ${missing.join(", ")}.`);
  }
  return { sections: sections.filter((section) => section.widgets.length > 0 || section.title) };
}

function stripScript(widget: Widget): Widget {
  if (widget.source.type !== "poll") return widget;
  return { ...widget, source: { ...widget.source, script: "" } };
}

function publicValue(value: RuntimeValue | undefined): WidgetValue {
  if (value === undefined) return { failures: 0 };
  return {
    failures: value.failures,
    ...(value.view === undefined ? {} : { view: value.view }),
    ...(value.error === undefined ? {} : { error: value.error }),
    ...(value.updatedAt === undefined ? {} : { updatedAt: value.updatedAt }),
  };
}

/** Widget config, poll scheduling and last values for the dashboard page. */
export class DashboardManager {
  private config: DashboardConfig = defaultDashboard();
  private readonly values = new Map<string, RuntimeValue>();
  private readonly viewers = new Map<string, number>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly inflight = new Map<string, Promise<PollOutcome>>();
  private readonly generations = new Map<string, number>();
  private host: DashboardHost | undefined;
  private sweep: NodeJS.Timeout | undefined;
  private stateTimer: NodeJS.Timeout | undefined;
  private writes: Promise<void> = Promise.resolve();
  private active = false;
  private readonly configPath: string;
  private readonly statePath: string;
  private readonly minIntervalMs: number;
  private readonly viewerTtlMs: number;
  private readonly runner: PollRunner;
  private readonly env: Record<string, string>;
  private readonly secrets: string[];
  private readonly maxBytes: number;
  private readonly now: () => number;

  constructor(dataDir: string, options: DashboardOptions = {}) {
    this.configPath = join(dataDir, "dashboard.json");
    this.statePath = join(dataDir, "dashboard-state.json");
    this.minIntervalMs = options.minIntervalMs ?? 30_000;
    this.viewerTtlMs = options.viewerTtlMs ?? 45_000;
    this.runner = options.runner ?? runPollScript;
    this.maxBytes = options.maxBytes ?? 128 * 1024;
    this.now = options.now ?? Date.now;
    const env = options.env ?? process.env;
    this.env = Object.fromEntries(
      Object.entries(env).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
    this.secrets = Object.entries(this.env)
      .filter(([name, value]) => SECRET_NAME.test(name) && value.length >= 8)
      .map(([, value]) => value)
      .sort((a, b) => b.length - a.length);
  }

  private get minIntervalSec(): number {
    return Math.max(0.001, this.minIntervalMs / 1000);
  }

  /** Reads dashboard.json, or seeds it with the builtin stats widgets. */
  async load(): Promise<void> {
    await mkdir(dirname(this.configPath), { recursive: true });
    let raw: string | undefined;
    try {
      raw = await readFile(this.configPath, "utf8");
    } catch {
      raw = undefined;
    }
    if (raw === undefined) {
      this.config = defaultDashboard();
      await this.saveConfig();
    } else {
      let upgraded = false;
      try {
        const parsed = JSON.parse(raw) as {
          widgets?: unknown[];
          layout?: unknown;
          seeded?: unknown;
        };
        const widgets: Widget[] = [];
        for (const item of Array.isArray(parsed.widgets) ? parsed.widgets : []) {
          try {
            widgets.push(parseWidget(item, 1));
          } catch (error) {
            console.error("[pi] dashboard: skipped a bad widget", error);
          }
        }
        let layout: DashboardLayout;
        try {
          layout = parseLayout(
            parsed.layout ?? { sections: [] },
            widgets.map((widget) => widget.id),
          );
        } catch {
          layout = parseLayout(
            { sections: [] },
            widgets.map((widget) => widget.id),
          );
        }
        // Files from before the seed marker hold the first set of defaults.
        const seeded =
          typeof parsed.seeded === "number" && Number.isInteger(parsed.seeded) ? parsed.seeded : 1;
        this.config = { version: 1, seeded, widgets, layout };
        upgraded = upgradeDashboard(this.config);
      } catch (error) {
        console.error("[pi] dashboard.json is not valid JSON; using the default dashboard", error);
        this.config = defaultDashboard();
      }
      if (upgraded) await this.saveConfig();
    }
    try {
      const state = JSON.parse(await readFile(this.statePath, "utf8")) as {
        values?: Record<string, RuntimeValue>;
      };
      for (const [id, value] of Object.entries(state.values ?? {})) {
        if (!this.config.widgets.some((widget) => widget.id === id) || !isRecord(value)) continue;
        this.values.set(id, {
          ...value,
          failures: typeof value.failures === "number" ? value.failures : 0,
          history: Array.isArray(value.history)
            ? value.history.filter((n) => typeof n === "number")
            : [],
        });
      }
    } catch {
      // No saved values yet.
    }
  }

  setHost(host: DashboardHost | undefined): void {
    this.host = host;
  }

  widgets(): Widget[] {
    return this.config.widgets.map((widget) => structuredClone(widget));
  }

  layout(): DashboardLayout {
    return structuredClone(this.config.layout);
  }

  /** True while some client has the dashboard open. */
  polling(): boolean {
    const now = this.now();
    for (const [id, expires] of this.viewers) if (expires <= now) this.viewers.delete(id);
    return this.viewers.size > 0;
  }

  /** A client reports whether it shows the dashboard. Polls run only while one does. */
  setViewer(id: string, visible: boolean): void {
    const viewer = id.trim().slice(0, 80);
    if (viewer === "") return;
    if (visible) this.viewers.set(viewer, this.now() + this.viewerTtlMs);
    else this.viewers.delete(viewer);
    this.syncPolling();
  }

  private syncPolling(): void {
    const polling = this.polling();
    if (polling && this.sweep === undefined) {
      this.sweep = setInterval(
        () => this.syncPolling(),
        Math.max(250, Math.floor(this.viewerTtlMs / 3)),
      );
      this.sweep.unref?.();
    }
    if (!polling && this.sweep !== undefined) {
      clearInterval(this.sweep);
      this.sweep = undefined;
    }
    if (polling === this.active) return;
    this.active = polling;
    if (polling) for (const widget of this.config.widgets) this.schedule(widget.id);
    else for (const id of [...this.timers.keys()]) this.clearTimer(id);
    this.broadcast();
  }

  /** The stream frame. Poll scripts stay on the server. */
  state(): DashboardState {
    return {
      widgets: this.config.widgets.map(stripScript),
      layout: this.layout(),
      values: Object.fromEntries(
        this.config.widgets
          .filter((widget) => widget.source.type !== "builtin")
          .map((widget) => [widget.id, publicValue(this.values.get(widget.id))]),
      ),
      builtins: this.host?.builtinsLite() ?? {
        jobs: [],
        session: { conversationId: "", model: null, run: "idle" },
      },
      polling: this.polling(),
    };
  }

  /** What dashboard_get returns: layout, widgets and each one's current value. */
  async describe(): Promise<{
    polling: boolean;
    layout: DashboardLayout;
    widgets: Array<
      Widget & {
        span: WidgetSpan;
        section: number;
        value?: WidgetView;
        error?: string;
        updatedAt?: string;
        failures: number;
      }
    >;
  }> {
    const inputs = this.host === undefined ? undefined : await this.host.builtinInputs();
    const placement = new Map<string, { span: WidgetSpan; section: number }>();
    this.config.layout.sections.forEach((section, index) => {
      for (const slot of section.widgets)
        placement.set(slot.id, { span: slot.span, section: index });
    });
    const widgets = this.config.widgets
      .map((widget) => {
        const place = placement.get(widget.id) ?? { span: "full" as const, section: -1 };
        let value: WidgetValue;
        if (widget.source.type === "builtin") {
          value = this.builtinValue(widget, inputs);
        } else value = publicValue(this.values.get(widget.id));
        return {
          ...structuredClone(widget),
          ...place,
          failures: value.failures,
          ...(value.view === undefined ? {} : { value: value.view }),
          ...(value.error === undefined ? {} : { error: value.error }),
          ...(value.updatedAt === undefined ? {} : { updatedAt: value.updatedAt }),
        };
      })
      .sort((a, b) => this.order(a.id) - this.order(b.id));
    return { polling: this.polling(), layout: this.layout(), widgets };
  }

  private order(id: string): number {
    let index = 0;
    for (const section of this.config.layout.sections) {
      for (const slot of section.widgets) {
        if (slot.id === id) return index;
        index += 1;
      }
    }
    return Number.MAX_SAFE_INTEGER;
  }

  private builtinValue(widget: Widget, inputs: BuiltinInputs | undefined): WidgetValue {
    if (widget.source.type !== "builtin" || inputs === undefined) {
      return { failures: 0, error: "no live data yet" };
    }
    try {
      return {
        failures: 0,
        view: renderWidget(widget, builtinData(widget.source.name, inputs)),
        updatedAt: new Date(this.now()).toISOString(),
      };
    } catch (error) {
      return { failures: 0, error: `mapping: ${messageOf(error)}` };
    }
  }

  /** Adds or replaces a widget and renders it once, so the agent sees the result. */
  async upsert(input: unknown): Promise<WidgetResult> {
    const notes: string[] = [];
    const widget = parseWidget(input, this.minIntervalSec, notes);
    const index = this.config.widgets.findIndex((item) => item.id === widget.id);
    const existing = index < 0 ? undefined : this.config.widgets[index];
    if (existing === undefined && this.config.widgets.length >= MAX_WIDGETS) {
      throw new DashboardError(
        `The dashboard holds at most ${MAX_WIDGETS} widgets; remove one first.`,
      );
    }
    if (widget.source.type === "poll") {
      const polls = this.config.widgets.filter(
        (item) => item.source.type === "poll" && item.id !== widget.id,
      ).length;
      if (polls >= MAX_POLL_WIDGETS) {
        throw new DashboardError(
          `At most ${MAX_POLL_WIDGETS} poll widgets; remove one or use static.`,
        );
      }
    }
    const sourceChanged =
      existing === undefined ||
      existing.kind !== widget.kind ||
      JSON.stringify(existing.source) !== JSON.stringify(widget.source);
    if (existing === undefined) {
      this.config.widgets.push(widget);
      const sections = this.config.layout.sections;
      if (sections.length === 0) sections.push({ widgets: [] });
      sections[sections.length - 1].widgets.push({ id: widget.id, span: "full" });
      notes.push("Added at the end of the last section; use dashboard_layout to move it.");
    } else this.config.widgets[index] = widget;
    this.bump(widget.id);
    this.clearTimer(widget.id);
    const keepStatic = existing?.source.type === "static" && widget.source.type === "static";
    if (sourceChanged && !keepStatic) this.values.delete(widget.id);
    await this.saveConfig();

    let result: WidgetResult;
    if (widget.source.type === "poll") {
      const outcome = await this.poll(widget.id, { initial: true });
      const value = this.values.get(widget.id);
      result = {
        widget,
        ...this.valueFields(value),
        ...(outcome.ok ? { sample: sampleOf(this.values.get(widget.id)?.data) } : {}),
        ...(outcome.logs.length > 0 ? { logs: outcome.logs.map((line) => this.mask(line)) } : {}),
        notes,
        polling: this.polling(),
      };
      if (!this.polling()) notes.push("Polling is paused until someone opens the dashboard page.");
      this.schedule(widget.id);
    } else if (widget.source.type === "static") {
      const value = this.values.get(widget.id);
      if (value?.data !== undefined) this.rerender(widget, value);
      else notes.push("No data yet; send it with dashboard_push.");
      this.saveStateSoon();
      result = {
        widget,
        ...this.valueFields(this.values.get(widget.id)),
        notes,
        polling: this.polling(),
      };
    } else {
      const inputs = this.host === undefined ? undefined : await this.host.builtinInputs();
      const value = this.builtinValue(widget, inputs);
      result = {
        widget,
        ...this.valueFields({ ...value, history: [] }),
        ...(inputs === undefined
          ? {}
          : { sample: sampleOf(builtinData(widget.source.name, inputs)) }),
        notes,
        polling: this.polling(),
      };
    }
    this.broadcast();
    return result;
  }

  private valueFields(
    value: RuntimeValue | undefined,
  ): Pick<WidgetResult, "view" | "error" | "updatedAt"> {
    if (value === undefined) return {};
    return {
      ...(value.view === undefined ? {} : { view: value.view }),
      ...(value.error === undefined ? {} : { error: value.error }),
      ...(value.updatedAt === undefined ? {} : { updatedAt: value.updatedAt }),
    };
  }

  private rerender(widget: Widget, value: RuntimeValue): void {
    try {
      value.view = renderWidget(widget, value.data, value.history.slice(0, -1));
      value.error = undefined;
    } catch (error) {
      value.error = `mapping: ${messageOf(error)}`;
    }
  }

  async remove(id: string): Promise<void> {
    const key = id.trim();
    const index = this.config.widgets.findIndex((widget) => widget.id === key);
    if (index < 0) throw new DashboardError(`Unknown widget "${key}".`);
    this.config.widgets.splice(index, 1);
    for (const section of this.config.layout.sections) {
      section.widgets = section.widgets.filter((slot) => slot.id !== key);
    }
    this.config.layout.sections = this.config.layout.sections.filter(
      (section) => section.widgets.length > 0,
    );
    this.clearTimer(key);
    this.bump(key);
    this.values.delete(key);
    await this.saveConfig();
    this.saveStateSoon();
    this.broadcast();
  }

  /** Data for a static widget. */
  async push(id: string, data: unknown): Promise<WidgetResult> {
    const widget = this.config.widgets.find((item) => item.id === id.trim());
    if (widget === undefined) throw new DashboardError(`Unknown widget "${id}".`);
    if (widget.source.type !== "static") {
      throw new DashboardError(
        `"${widget.id}" has a ${widget.source.type} source; only static widgets take pushed data.`,
      );
    }
    const json = JSON.stringify(data ?? null);
    if (Buffer.byteLength(json) > this.maxBytes) {
      throw new DashboardError(
        `The data is over ${this.maxBytes} bytes; push only what the widget shows.`,
      );
    }
    const masked = maskDeep(JSON.parse(json) as unknown, this.secrets);
    const value = this.values.get(widget.id) ?? { failures: 0, history: [] };
    value.data = masked;
    try {
      value.view = renderWidget(widget, masked, value.history);
      value.error = undefined;
      const number = viewNumber(widget, masked);
      if (number !== undefined) value.history = [...value.history, number].slice(-HISTORY_POINTS);
    } catch (error) {
      value.error = `mapping: ${messageOf(error)}`;
    }
    value.updatedAt = new Date(this.now()).toISOString();
    this.values.set(widget.id, value);
    this.saveStateSoon();
    this.broadcast();
    return { widget, ...this.valueFields(value), notes: [], polling: this.polling() };
  }

  async setLayout(input: unknown): Promise<{ layout: DashboardLayout; notes: string[] }> {
    const notes: string[] = [];
    const layout = parseLayout(
      input,
      this.config.widgets.map((widget) => widget.id),
      notes,
    );
    this.config.layout = layout;
    await this.saveConfig();
    this.broadcast();
    return { layout: this.layout(), notes };
  }

  /** Re-sends the frame, e.g. when jobs or the session change. */
  broadcast(): void {
    this.host?.broadcast(this.state());
  }

  dispose(): void {
    for (const id of [...this.timers.keys()]) this.clearTimer(id);
    if (this.sweep !== undefined) clearInterval(this.sweep);
    this.sweep = undefined;
    this.viewers.clear();
    this.active = false;
  }

  /** Lets pending writes land; for tests and shutdown. */
  async flush(): Promise<void> {
    if (this.stateTimer !== undefined) {
      clearTimeout(this.stateTimer);
      this.stateTimer = undefined;
      this.queueWrite(this.statePath, () => this.serializeState());
    }
    await this.writes;
    await Promise.all(this.inflight.values());
  }

  private bump(id: string): void {
    this.generations.set(id, (this.generations.get(id) ?? 0) + 1);
  }

  private clearTimer(id: string): void {
    const timer = this.timers.get(id);
    if (timer !== undefined) clearTimeout(timer);
    this.timers.delete(id);
  }

  private intervalMs(widget: Widget, failures: number): number {
    if (widget.source.type !== "poll") return Number.POSITIVE_INFINITY;
    const base = Math.max(
      this.minIntervalMs,
      (widget.source.intervalSec ?? DEFAULT_INTERVAL_SEC) * 1000,
    );
    if (failures < FAILURES_BEFORE_BACKOFF) return base;
    return Math.min(MAX_BACKOFF_MS, base * 2 ** (failures - FAILURES_BEFORE_BACKOFF + 1));
  }

  private schedule(id: string): void {
    this.clearTimer(id);
    if (!this.polling()) return;
    const widget = this.config.widgets.find((item) => item.id === id);
    if (widget === undefined || widget.source.type !== "poll") return;
    const value = this.values.get(id);
    const due = (value?.lastRunAt ?? 0) + this.intervalMs(widget, value?.failures ?? 0);
    const timer = setTimeout(
      () => {
        this.timers.delete(id);
        if (!this.polling()) return;
        void this.poll(id).finally(() => {
          if (!this.timers.has(id)) this.schedule(id);
        });
      },
      Math.max(0, due - this.now()),
    );
    timer.unref?.();
    this.timers.set(id, timer);
  }

  private mask(text: string): string {
    return maskSecrets(text, this.secrets);
  }

  /** Runs a poll widget's script once and records the outcome. */
  private poll(id: string, options: { initial?: boolean } = {}): Promise<PollOutcome> {
    const running = this.inflight.get(id);
    if (running !== undefined && !options.initial) return running;
    const widget = this.config.widgets.find((item) => item.id === id);
    if (widget === undefined || widget.source.type !== "poll") {
      return Promise.resolve({ ok: false, error: "not a poll widget", logs: [], ms: 0 });
    }
    const source = widget.source;
    const generation = this.generations.get(id) ?? 0;
    const previous = this.values.get(id);
    const run = this.runner({
      script: source.script,
      prev: previous?.data ?? null,
      env: this.env,
      timeoutMs: (source.timeoutSec ?? DEFAULT_TIMEOUT_SEC) * 1000,
      maxBytes: this.maxBytes,
    }).then((outcome) => {
      if ((this.generations.get(id) ?? 0) === generation) this.record(widget, outcome);
      return outcome;
    });
    const tracked = run.finally(() => {
      if (this.inflight.get(id) === tracked) this.inflight.delete(id);
    });
    this.inflight.set(id, tracked);
    return tracked;
  }

  private record(widget: Widget, outcome: PollOutcome): void {
    const value: RuntimeValue = this.values.get(widget.id) ?? { failures: 0, history: [] };
    const now = this.now();
    value.lastRunAt = now;
    value.logs = outcome.logs.map((line) => this.mask(line));
    let error: string | undefined;
    if (outcome.ok) {
      const data = maskDeep(outcome.value, this.secrets);
      value.data = data;
      try {
        value.view = renderWidget(widget, data, value.history);
        const number = viewNumber(widget, data);
        if (number !== undefined) value.history = [...value.history, number].slice(-HISTORY_POINTS);
        value.updatedAt = new Date(now).toISOString();
      } catch (mappingError) {
        error = `mapping: ${messageOf(mappingError)}`;
      }
    } else error = outcome.error;
    if (error === undefined) {
      value.failures = 0;
      value.error = undefined;
      value.notified = false;
    } else {
      value.failures += 1;
      value.error = this.mask(error);
      if (value.failures >= FAILURES_BEFORE_BACKOFF && !value.notified) {
        value.notified = true;
        const wait = Math.round(this.intervalMs(widget, value.failures) / 1000);
        this.host?.notify(
          `[pi-ui dashboard] Widget "${widget.id}" (${widget.title}) failed ${value.failures} polls in a row. Last error: ${value.error}\nIt keeps showing its last good value and now retries every ${wait}s. Fix it with dashboard_upsert or remove it with dashboard_remove.`,
        );
      }
    }
    this.values.set(widget.id, value);
    this.saveStateSoon();
    this.broadcast();
  }

  private saveConfig(): Promise<void> {
    const text = `${JSON.stringify(this.config, null, 2)}\n`;
    return this.queueWrite(this.configPath, () => text);
  }

  private serializeState(): string {
    const values: Record<string, Omit<RuntimeValue, "notified" | "logs">> = {};
    for (const [id, value] of this.values) {
      const { notified: _notified, logs: _logs, ...rest } = value;
      values[id] = rest;
    }
    return `${JSON.stringify({ values })}\n`;
  }

  private saveStateSoon(): void {
    if (this.stateTimer !== undefined) return;
    this.stateTimer = setTimeout(() => {
      this.stateTimer = undefined;
      void this.queueWrite(this.statePath, () => this.serializeState());
    }, 500);
    this.stateTimer.unref?.();
  }

  private queueWrite(path: string, text: () => string): Promise<void> {
    const write = this.writes.then(async () => {
      const temp = `${path}.${process.pid}.tmp`;
      await writeFile(temp, text(), "utf8");
      await rename(temp, path);
    });
    this.writes = write.catch((error: unknown) => {
      console.error(`[pi] dashboard: could not write ${path}`, error);
    });
    return this.writes;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sampleOf(data: unknown): string | undefined {
  if (data === undefined) return undefined;
  const json = JSON.stringify(data, null, 1) ?? "null";
  return json.length > SAMPLE_CHARS
    ? `${json.slice(0, SAMPLE_CHARS)}\n… (${json.length} chars)`
    : json;
}
