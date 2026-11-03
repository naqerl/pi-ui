import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  ComposedChart,
  Line,
  LineChart,
  ReferenceLine,
  XAxis,
  YAxis,
} from "recharts";
import {
  type BuiltinInputs,
  builtinData,
  type ChartFormat,
  type ChartSeries,
  type DashboardState,
  renderWidget,
  type SparklineChart,
  type SparklineSeries,
  type StatusState,
  type Widget,
  type WidgetSpan,
  type WidgetValue,
  type WidgetView,
} from "../shared/dashboard";
import { formatDateTime, formatTime } from "../shared/time";
import type { ContextUsage, McpEventsState, McpStatus, UsageSummary } from "../shared/types";
import {
  type ChartConfig,
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from "./components/ui/chart";
import { getDashboard, setDashboard, subscribeDashboard } from "./dashboard-store";
import { haptic } from "./haptics";
import { Markdown } from "./markdown";

export interface ChatStats {
  usage: UsageSummary | null;
  context: ContextUsage | null;
  mcp: McpStatus;
  mcpEvents: McpEventsState;
}

const SPAN_CLASS: Record<WidgetSpan, string> = {
  full: "sm:col-span-6",
  half: "sm:col-span-3",
  third: "sm:col-span-2",
};

const HEARTBEAT_MS = 20_000;

/** Explains what the token rows count, shown above the token widget's rows. */
const TOKENS_NOTE =
  "Totals cover this conversation. Input excludes cached tokens; cache hit is cache read over all prompt tokens.";

function viewerId(): string {
  const key = "pi-dashboard-viewer";
  try {
    const stored = sessionStorage.getItem(key);
    if (stored) return stored;
    const id = crypto.randomUUID();
    sessionStorage.setItem(key, id);
    return id;
  } catch {
    return `v-${Math.random().toString(36).slice(2)}`;
  }
}

/** Tells the server whether this tab shows the dashboard; poll widgets run only while one does. */
function useViewerReport(active: boolean): void {
  const viewer = useMemo(viewerId, []);
  useEffect(() => {
    const report = (visible: boolean, beacon = false) => {
      const body = JSON.stringify({ viewer, visible });
      if (beacon && typeof navigator.sendBeacon === "function") {
        navigator.sendBeacon("/api/dashboard/viewer", body);
        return;
      }
      void fetch("/api/dashboard/viewer", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        keepalive: true,
      }).catch(() => {});
    };
    let timer: number | undefined;
    const sync = () => {
      const visible = active && document.visibilityState === "visible";
      window.clearInterval(timer);
      timer = undefined;
      report(visible);
      if (visible) timer = window.setInterval(() => report(true), HEARTBEAT_MS);
    };
    const hide = () => report(false, true);
    sync();
    document.addEventListener("visibilitychange", sync);
    window.addEventListener("pagehide", hide);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", sync);
      window.removeEventListener("pagehide", hide);
      if (active) report(false);
    };
  }, [active, viewer]);
}

const DOT: Record<StatusState, string> = {
  ok: "bg-emerald-500",
  warn: "bg-amber-500",
  error: "bg-red-500",
};

function Value({ text }: { text: string }) {
  if (text.startsWith("unavailable ·")) {
    return (
      <span className="text-muted-foreground" data-unavailable="">
        {text}
      </span>
    );
  }
  return <>{text}</>;
}

const CHART_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
];

type SparklineView = Extract<WidgetView, { kind: "sparkline" }>;

interface DrawnSeries {
  /** A CSS-safe key, never the user-supplied series key. */
  id: string;
  label: string;
  color: string;
  type: "area" | "line" | "bar";
  dashed: boolean;
  fillOpacity: number;
  stack?: string;
  points: (number | null)[];
}

function formatChartValue(
  value: unknown,
  format: ChartFormat | undefined,
  currency: string,
): string {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) return String(value);
  switch (format) {
    case "currency":
      return `${number < 0 ? "-" : ""}${currency}${Math.round(Math.abs(number)).toLocaleString()}`;
    case "percent": {
      const scaled = number !== 0 && Math.abs(number) <= 1 ? number * 100 : number;
      return `${Math.round(scaled).toLocaleString()}%`;
    }
    case "bytes": {
      const units = ["B", "KB", "MB", "GB", "TB"];
      let scaled = Math.abs(number);
      let unit = 0;
      while (scaled >= 1024 && unit < units.length - 1) {
        scaled /= 1024;
        unit += 1;
      }
      const text =
        unit === 0 ? Math.round(scaled).toLocaleString() : scaled.toFixed(1).replace(/\.0$/, "");
      return `${number < 0 ? "-" : ""}${text} ${units[unit]}`;
    }
    default:
      return number.toLocaleString();
  }
}

function resolveSeries(view: SparklineView, chart: SparklineChart | undefined): DrawnSeries[] {
  const dataSeries: SparklineSeries[] =
    view.series !== undefined && view.series.length > 0
      ? view.series
      : view.points === undefined
        ? []
        : [{ key: "value", points: view.points }];
  const specs: ChartSeries[] =
    chart?.series !== undefined && chart.series.length > 0
      ? chart.series
      : dataSeries.map((series) => ({ key: series.key, label: series.label }));
  return specs
    .map((spec, index) => {
      const data =
        dataSeries.find((series) => series.key === spec.key) ??
        (dataSeries.length === 1 && specs.length === 1 ? dataSeries[0] : undefined);
      const single = dataSeries.length === 1 && specs.length === 1;
      return {
        id: `s${index}`,
        label: spec.label ?? data?.label ?? spec.key,
        color:
          spec.color ??
          (single ? chart?.color : undefined) ??
          CHART_COLORS[index % CHART_COLORS.length],
        type: spec.type ?? chart?.type ?? "area",
        dashed: spec.dashed ?? false,
        fillOpacity: spec.fillOpacity ?? 0.35,
        ...(spec.stack === undefined ? {} : { stack: spec.stack }),
        points: data?.points ?? [],
      };
    })
    .filter((series) => series.points.length >= 2);
}

function WidgetSparkline({ view, chart }: { view: SparklineView; chart?: SparklineChart }) {
  const chartId = useId().replace(/:/g, "");
  const series = resolveSeries(view, chart);
  if (series.length === 0) {
    return <div className="h-10 text-muted-foreground">collecting…</div>;
  }
  const height = chart?.height ?? 40;
  const showTooltip = chart?.showTooltip ?? false;
  const domain: [number | string, number | string] =
    chart?.yDomain === undefined || chart.yDomain === "auto"
      ? ["dataMin", "dataMax"]
      : chart.yDomain;
  const sourceLabels = view.labels ?? chart?.x?.labels;
  const longest = Math.max(...series.map((item) => item.points.length));
  const labels = sourceLabels?.slice(0, longest);
  const data = Array.from({ length: longest }, (_, index) => {
    const row: Record<string, string | number | null> = {
      label: labels?.[index] ?? String(index),
    };
    for (const item of series) row[item.id] = item.points[index] ?? null;
    return row;
  });
  const config: ChartConfig = Object.fromEntries(
    series.map((item) => [item.id, { label: item.label, color: item.color }]),
  );
  const gradientId = (index: number) => `spark-${chartId}-${index}`;
  const gradient = (
    <defs>
      {series.map((item, index) =>
        item.type === "area" ? (
          <linearGradient key={item.id} id={gradientId(index)} x1="0" y1="0" x2="0" y2="1">
            <stop
              offset="0%"
              stopColor={`var(--color-${item.id})`}
              stopOpacity={item.fillOpacity}
            />
            <stop offset="100%" stopColor={`var(--color-${item.id})`} stopOpacity={0} />
          </linearGradient>
        ) : null,
      )}
    </defs>
  );
  const xAxis =
    labels === undefined || labels.length === 0 ? (
      <XAxis dataKey="label" hide />
    ) : (
      <XAxis dataKey="label" tickLine={false} axisLine={false} fontSize={10} />
    );
  const yAxis =
    chart?.y?.ticks === undefined ? (
      <YAxis hide domain={domain} />
    ) : (
      <YAxis
        domain={domain}
        tickCount={chart.y.ticks}
        tickFormatter={(value: number) =>
          formatChartValue(value, chart.y?.format, chart.y?.currency ?? "€")
        }
        tickLine={false}
        axisLine={false}
        fontSize={10}
      />
    );
  const tooltip = showTooltip ? (
    <ChartTooltip
      cursor={false}
      content={
        <ChartTooltipContent
          hideLabel
          indicator="line"
          {...(chart?.y?.format === undefined
            ? {}
            : {
                formatter: (value: unknown, name: string | number) => {
                  const key = String(name);
                  const item = series.find((entry) => entry.id === key || entry.label === key);
                  return (
                    <div className="flex w-full items-center justify-between gap-3">
                      <span className="text-muted-foreground">{item?.label ?? key}</span>
                      <span className="font-mono font-medium tabular-nums text-foreground">
                        {formatChartValue(value, chart.y?.format, chart.y?.currency ?? "€")}
                      </span>
                    </div>
                  );
                },
              })}
        />
      }
    />
  ) : null;
  const legend =
    (chart?.legend ?? series.length > 1) ? <ChartLegend content={<ChartLegendContent />} /> : null;
  const references = (chart?.reference ?? []).map((reference) => {
    const color = reference.color ?? "var(--chart-4)";
    return (
      <ReferenceLine
        key={`reference-${reference.value}-${reference.label ?? ""}-${color}`}
        y={reference.value}
        stroke={color}
        strokeDasharray={reference.dashed === false ? undefined : "4 3"}
        label={
          reference.label === undefined
            ? undefined
            : { value: reference.label, position: "insideTopRight", fill: color, fontSize: 10 }
        }
      />
    );
  });
  const types = new Set(series.map((item) => item.type));
  const type = types.size === 1 ? series[0]?.type : undefined;
  const parts = series.map((item, index) => {
    const color = `var(--color-${item.id})`;
    if (item.type === "bar") {
      return (
        <Bar
          key={item.id}
          dataKey={item.id}
          name={item.label}
          fill={color}
          {...(item.stack === undefined ? {} : { stackId: item.stack })}
          isAnimationActive={false}
        />
      );
    }
    if (item.type === "line") {
      return (
        <Line
          key={item.id}
          type="monotone"
          dataKey={item.id}
          name={item.label}
          stroke={color}
          strokeWidth={1.5}
          dot={false}
          strokeDasharray={item.dashed ? "4 3" : undefined}
          {...(item.stack === undefined ? {} : { stackId: item.stack })}
          isAnimationActive={false}
        />
      );
    }
    return (
      <Area
        key={item.id}
        type="monotone"
        dataKey={item.id}
        name={item.label}
        stroke={color}
        strokeWidth={1.5}
        fill={`url(#${gradientId(index)})`}
        dot={false}
        strokeDasharray={item.dashed ? "4 3" : undefined}
        {...(item.stack === undefined ? {} : { stackId: item.stack })}
        isAnimationActive={false}
      />
    );
  });
  const props = {
    data,
    margin: { top: 2, right: 0, bottom: 0, left: 0 },
  };
  const hasReference = (chart?.reference?.length ?? 0) > 0;
  return (
    <ChartContainer
      config={config}
      className="aspect-auto w-full min-w-0"
      style={{ height }}
      aria-hidden={showTooltip ? undefined : true}
    >
      {hasReference || types.size > 1 ? (
        <ComposedChart {...props}>
          {gradient}
          {xAxis}
          {yAxis}
          {tooltip}
          {legend}
          {references}
          {parts}
        </ComposedChart>
      ) : type === "bar" ? (
        <BarChart {...props}>
          {gradient}
          {xAxis}
          {yAxis}
          {tooltip}
          {legend}
          {parts}
        </BarChart>
      ) : type === "line" ? (
        <LineChart {...props}>
          {gradient}
          {xAxis}
          {yAxis}
          {tooltip}
          {legend}
          {parts}
        </LineChart>
      ) : (
        <AreaChart {...props}>
          {gradient}
          {xAxis}
          {yAxis}
          {tooltip}
          {legend}
          {parts}
        </AreaChart>
      )}
    </ChartContainer>
  );
}

function Empty({ id, text }: { id: string; text: string | undefined }) {
  return (
    <p className="py-2 text-muted-foreground" data-testid={`stat-${id}-empty`}>
      {text ?? "nothing to show"}
    </p>
  );
}

function rowClass(): string {
  return "flex min-w-0 flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 py-2";
}

function ViewBody({ id, view, chart }: { id: string; view: WidgetView; chart?: SparklineChart }) {
  switch (view.kind) {
    case "stat":
      return (
        <>
          <dl>
            <div className={rowClass()} data-testid={`stat-${id}`}>
              <dt className="shrink-0 text-muted-foreground">{view.label ?? ""}</dt>
              <dd className="min-w-0 text-right [overflow-wrap:anywhere]">
                <Value text={view.value} />
                {view.unit === undefined ? null : (
                  <span className="text-muted-foreground"> {view.unit}</span>
                )}
                {view.delta === undefined ? null : (
                  <span
                    className={
                      view.trend === "up"
                        ? "text-emerald-600"
                        : view.trend === "down"
                          ? "text-red-600"
                          : "text-muted-foreground"
                    }
                    data-testid={`stat-${id}-delta`}
                  >
                    {" "}
                    {view.trend === "up" ? "▲" : view.trend === "down" ? "▼" : "•"} {view.delta}
                  </span>
                )}
              </dd>
            </div>
          </dl>
          {view.progress === undefined ? null : (
            <div className="flex justify-end pb-2">
              <span
                className="block h-1 w-32 max-w-full bg-foreground/15"
                aria-hidden="true"
                data-testid={`${id}-bar`}
              >
                <span
                  className="block h-full bg-foreground"
                  style={{ width: `${view.progress}%` }}
                />
              </span>
            </div>
          )}
        </>
      );
    case "list":
      if (view.items.length === 0) return <Empty id={id} text={view.empty} />;
      return (
        <dl className="divide-y divide-border/50">
          {view.items.map((item, index) => (
            <div
              key={item.key ?? index}
              className={rowClass()}
              {...(item.key === undefined ? {} : { "data-testid": `stat-${item.key}` })}
            >
              <dt className="min-w-0 text-muted-foreground [overflow-wrap:anywhere]">
                {item.label}
              </dt>
              <dd className="min-w-0 text-right [overflow-wrap:anywhere]">
                {item.value === undefined ? null : <Value text={item.value} />}
              </dd>
            </div>
          ))}
        </dl>
      );
    case "status":
      if (view.items.length === 0) return <Empty id={id} text={view.empty} />;
      return (
        <ul className="divide-y divide-border/50">
          {view.items.map((item, index) => (
            <li
              key={item.key ?? index}
              className={rowClass()}
              data-state={item.state}
              {...(item.key === undefined ? {} : { "data-testid": `stat-${item.key}` })}
            >
              <span className="flex min-w-0 items-baseline gap-2 [overflow-wrap:anywhere]">
                <span
                  className={`inline-block size-2 shrink-0 rounded-full ${DOT[item.state]}`}
                  role="img"
                  aria-label={item.state}
                />
                <span className="min-w-0">{item.label}</span>
              </span>
              {item.detail === undefined ? null : (
                <span className="min-w-0 text-muted-foreground [overflow-wrap:anywhere]">
                  <Value text={item.detail} />
                </span>
              )}
            </li>
          ))}
        </ul>
      );
    case "table":
      if (view.rows.length === 0) return <Empty id={id} text={view.empty} />;
      return (
        <div className="max-w-full overflow-x-auto py-1">
          <table className="w-full border-collapse text-left">
            <thead>
              <tr>
                {view.columns.map((column) => (
                  <th
                    key={column}
                    className="whitespace-nowrap border-b border-border/70 py-1 pr-3 font-normal text-muted-foreground"
                  >
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border/50">
              {view.rows.map((row, rowIndex) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity
                <tr key={rowIndex}>
                  {row.map((cell, cellIndex) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: cells follow the columns
                    <td key={cellIndex} className="py-1.5 pr-3 align-top [overflow-wrap:anywhere]">
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "sparkline":
      return (
        <div className="py-2">
          <div className="flex items-baseline justify-between gap-4">
            <span className="text-muted-foreground">{view.label ?? ""}</span>
            <span data-testid={`stat-${id}`}>{view.value ?? ""}</span>
          </div>
          <WidgetSparkline view={view} chart={chart} />
        </div>
      );
    case "markdown":
      return (
        <div className="py-1 font-sans text-sm">
          <Markdown text={view.text} />
        </div>
      );
  }
}

function WidgetCard({
  widget,
  view,
  value,
  onRemove,
}: {
  widget: Widget;
  view: WidgetView | undefined;
  value: WidgetValue | undefined;
  onRemove: (id: string) => void;
}) {
  const [menu, setMenu] = useState(false);
  const press = useRef<{ timer: number; x: number; y: number } | null>(null);
  const cardRef = useRef<HTMLElement | null>(null);
  const error = value?.error;
  const note =
    widget.source.type === "builtin" && widget.source.name === "tokens" ? TOKENS_NOTE : undefined;

  useEffect(() => {
    if (!menu) return;
    const close = (event: Event) => {
      if (event instanceof KeyboardEvent && event.key !== "Escape") return;
      if (event.type === "pointerdown" && cardRef.current?.contains(event.target as Node)) return;
      setMenu(false);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", close);
    };
  }, [menu]);

  const cancelPress = () => {
    if (press.current !== null) window.clearTimeout(press.current.timer);
    press.current = null;
  };

  return (
    <section
      ref={cardRef}
      aria-label={widget.title}
      data-testid={`widget-${widget.id}`}
      data-kind={widget.kind}
      className="theme-radius relative min-w-0 border border-border/70 bg-surface px-3 py-2 font-mono text-xs"
      onPointerDown={(event) => {
        if (event.pointerType !== "touch") return;
        cancelPress();
        const timer = window.setTimeout(() => {
          press.current = null;
          setMenu(true);
          haptic(10);
        }, 550);
        press.current = { timer, x: event.clientX, y: event.clientY };
      }}
      onPointerMove={(event) => {
        const start = press.current;
        if (start !== null && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 10) {
          cancelPress();
        }
      }}
      onPointerUp={cancelPress}
      onPointerCancel={cancelPress}
      onContextMenu={(event) => {
        event.preventDefault();
        setMenu(true);
      }}
    >
      <div className="flex items-start justify-between gap-2 pb-1">
        <h2
          className="min-w-0 text-[11px] uppercase tracking-wide text-muted-foreground [overflow-wrap:anywhere]"
          title={
            value?.updatedAt === undefined
              ? undefined
              : `updated ${formatDateTime(value.updatedAt)}`
          }
        >
          {widget.title}
        </h2>
        <span className="flex shrink-0 items-center gap-1">
          {error === undefined ? null : (
            <span
              className="theme-radius border border-red-500/50 px-1 text-[10px] text-red-600"
              title={error}
              data-testid={`widget-${widget.id}-error`}
            >
              {view === undefined ? "error" : "stale"}
            </span>
          )}
          <button
            type="button"
            className="theme-radius -my-1 px-1.5 text-muted-foreground hover:bg-foreground/10"
            aria-label={`${widget.title} menu`}
            aria-haspopup="menu"
            aria-expanded={menu}
            onClick={() => setMenu((open) => !open)}
          >
            ⋯
          </button>
        </span>
      </div>
      {note === undefined ? null : (
        <p
          className="pb-1 text-[10px] leading-4 text-muted-foreground [overflow-wrap:anywhere]"
          data-testid={`widget-${widget.id}-note`}
        >
          {note}
        </p>
      )}
      {menu ? (
        <div
          role="menu"
          className="theme-radius absolute top-7 right-2 z-10 border border-border bg-surface py-1 shadow-lg"
        >
          <button
            type="button"
            role="menuitem"
            className="block w-full px-3 py-1.5 text-left text-red-600 hover:bg-foreground/10"
            onClick={() => {
              setMenu(false);
              onRemove(widget.id);
            }}
          >
            Remove widget
          </button>
        </div>
      ) : null}
      {view !== undefined ? (
        <ViewBody id={widget.id} view={view} chart={widget.chart} />
      ) : (
        <p className="py-2 text-muted-foreground [overflow-wrap:anywhere]">
          {error ??
            (widget.source.type === "static" ? "waiting for data" : "waiting for the first poll")}
        </p>
      )}
    </section>
  );
}

function builtinView(widget: Widget, inputs: BuiltinInputs): { view?: WidgetView; error?: string } {
  if (widget.source.type !== "builtin") return {};
  try {
    return {
      view: renderWidget(
        widget,
        builtinData(widget.source.name, inputs, {
          formatTime: (timestamp) => formatTime(timestamp),
        }),
      ),
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/** The dashboard page: widgets the agent arranged, rendered from builtin stats, polls or pushed data. */
export function StatsView({
  stats,
  ready,
  active,
  footerClearance,
}: {
  stats: ChatStats;
  ready: boolean;
  /** True while the dashboard is the current page. */
  active: boolean;
  footerClearance: number;
}) {
  const dashboard = useSyncExternalStore(subscribeDashboard, getDashboard, getDashboard);
  useViewerReport(active);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    void fetch("/api/dashboard")
      .then((response) => (response.ok ? (response.json() as Promise<DashboardState>) : null))
      .then((state) => {
        if (!cancelled && state !== null) setDashboard(state);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [active]);

  const remove = useCallback(async (id: string) => {
    const response = await fetch(`/api/dashboard/widgets/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }).catch(() => null);
    if (response?.ok) {
      haptic([12, 40, 12]);
      setDashboard((await response.json()) as DashboardState);
    }
  }, []);

  const inputs: BuiltinInputs = {
    usage: stats.usage,
    context: stats.context,
    mcp: stats.mcp,
    mcpEvents: stats.mcpEvents,
    jobs: dashboard?.builtins.jobs ?? [],
    session: dashboard?.builtins.session ?? { conversationId: "", model: null, run: "idle" },
  };
  const byId = new Map((dashboard?.widgets ?? []).map((widget) => [widget.id, widget]));

  return (
    <div className="h-full overflow-x-hidden overflow-y-auto" data-testid="stats-page">
      <div
        className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-4"
        style={{ paddingTop: 16, paddingBottom: footerClearance + 16 }}
      >
        {!ready || dashboard === null ? (
          <p className="font-mono text-xs text-muted-foreground">Loading…</p>
        ) : null}
        {dashboard !== null && dashboard.widgets.length === 0 ? (
          <p className="px-1 font-mono text-xs text-muted-foreground" data-testid="dashboard-empty">
            The dashboard is empty. Ask the agent to add widgets.
          </p>
        ) : null}
        {dashboard?.layout.sections.map((section, index) => {
          const slots = section.widgets.filter((slot) => byId.has(slot.id));
          if (slots.length === 0) return null;
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: sections have no id
            <div key={index} className="flex flex-col gap-2" data-testid="dashboard-section">
              {section.title === undefined ? null : (
                <h2 className="px-1 font-mono text-xs font-semibold text-foreground">
                  {section.title}
                </h2>
              )}
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-6">
                {slots.map((slot) => {
                  const widget = byId.get(slot.id) as Widget;
                  const stored = dashboard.values[widget.id];
                  const live = builtinView(widget, inputs);
                  const view = widget.source.type === "builtin" ? live.view : stored?.view;
                  const value =
                    widget.source.type === "builtin"
                      ? live.error === undefined
                        ? undefined
                        : { failures: 0, error: live.error }
                      : stored;
                  return (
                    <div
                      key={widget.id}
                      className={`min-w-0 ${SPAN_CLASS[slot.span]}`}
                      data-span={slot.span}
                    >
                      <WidgetCard widget={widget} view={view} value={value} onRemove={remove} />
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
