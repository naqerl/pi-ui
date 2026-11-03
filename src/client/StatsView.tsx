import {
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { Layout } from "react-grid-layout";
import GridLayout from "react-grid-layout";
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
import "react-grid-layout/css/styles.css";
import "react-resizable/css/styles.css";
import {
  type BuiltinInputs,
  builtinData,
  type ChartFormat,
  type ChartSeries,
  type DashboardLayout,
  type DashboardState,
  DEFAULT_WIDGET_ROWS,
  GRID_COLUMNS,
  type LayoutSection,
  type LayoutSlot,
  MAX_SECTIONS,
  packLayoutSlots,
  renderWidget,
  type SparklineChart,
  type SparklineSeries,
  type StatusState,
  spanForWidth,
  type Widget,
  type WidgetValue,
  type WidgetView,
  widthForSpan,
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

const HEARTBEAT_MS = 20_000;

/** Explains what the token rows count, shown above the token widget's rows. */
const TOKENS_NOTE =
  "Totals cover this conversation. Input excludes cached tokens; cache hit is cache read over all prompt tokens.";

const LAYOUT_DEBOUNCE_MS = 600;
const GRID_MARGIN = 12;
const GRID_ROW_HEIGHT = 44;

interface GridGesture {
  kind: "drag" | "resize";
  pointerId: number;
  sectionIndex: number;
  widgetId: string;
  startX: number;
  startY: number;
  gridWidth: number;
  origin: LayoutSlot;
  base: DashboardLayout;
  moved: boolean;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function cardAtPoint(
  point: { x: number; y: number },
  excludeId: string,
): { id: string; sectionIndex: number; element: HTMLElement } | null {
  for (const target of document.elementsFromPoint(point.x, point.y)) {
    const card = target.closest<HTMLElement>("[data-widget-id]");
    const id = card?.dataset.widgetId;
    if (card === null || card === undefined || id === undefined || id === excludeId) continue;
    const section = card.closest<HTMLElement>("[data-section-index]");
    const index = Number(section?.dataset.sectionIndex);
    if (Number.isInteger(index)) return { id, sectionIndex: index, element: card };
  }
  return null;
}

function reorderInSection(
  layout: DashboardLayout,
  sectionIndex: number,
  movedId: string,
  targetId: string,
  y: number,
  target: HTMLElement,
): DashboardLayout {
  const next = structuredClone(layout);
  const section = next.sections[sectionIndex];
  if (section === undefined) return layout;
  const from = section.widgets.findIndex((slot) => slot.id === movedId);
  const targetIndex = section.widgets.findIndex((slot) => slot.id === targetId);
  if (from < 0 || targetIndex < 0) return layout;
  const box = target.getBoundingClientRect();
  let at = targetIndex + (y > box.top + box.height / 2 ? 1 : 0);
  const [moved] = section.widgets.splice(from, 1);
  if (moved === undefined) return layout;
  if (from < at) at -= 1;
  section.widgets.splice(at, 0, moved);
  section.widgets = packSection(section.widgets, true);
  return next;
}

function moveBetweenSections(
  layout: DashboardLayout,
  sourceIndex: number,
  destinationIndex: number,
  widgetId: string,
  target: HTMLElement,
  y: number,
): DashboardLayout {
  const next = structuredClone(layout);
  const source = next.sections[sourceIndex];
  const destination = next.sections[destinationIndex];
  if (source === undefined || destination === undefined) return layout;
  const from = source.widgets.findIndex((slot) => slot.id === widgetId);
  if (from < 0) return layout;
  const [moved] = source.widgets.splice(from, 1);
  if (moved === undefined) return layout;
  const at = insertionIndex(target, destination.widgets, y);
  destination.widgets.splice(at, 0, {
    id: moved.id,
    span: moved.span,
    w: slotWidth(moved),
    h: slotHeight(moved),
  });
  source.widgets = packSection(source.widgets, true);
  destination.widgets = packSection(destination.widgets, true);
  return next;
}

function useDesktopGrid(): boolean {
  const query = "(min-width: 768px)";
  const [desktop, setDesktop] = useState(
    () => typeof window === "undefined" || window.matchMedia(query).matches,
  );
  useEffect(() => {
    const media = window.matchMedia(query);
    const sync = () => setDesktop(media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);
  return desktop;
}

function useGridWidth(enabled: boolean): {
  ref: RefObject<HTMLDivElement | null>;
  width: number;
} {
  const ref = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(960);
  useEffect(() => {
    if (!enabled) return;
    const node = ref.current;
    if (node === null) return;
    const measure = () => {
      const next = node.getBoundingClientRect().width;
      if (next > 0) setWidth(next);
    };
    measure();
    const observer = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect.width ?? 0;
      if (next > 0) setWidth(next);
    });
    observer.observe(node);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [enabled]);
  return { ref, width };
}

function slotWidth(slot: LayoutSlot): number {
  return Math.max(1, Math.min(GRID_COLUMNS, slot.w ?? widthForSpan(slot.span)));
}

function slotHeight(slot: LayoutSlot): number {
  return Math.max(1, Math.min(100, slot.h ?? DEFAULT_WIDGET_ROWS));
}

/** Packs a section top-left. `reset` ignores stored coordinates, for structural moves. */
function packSection(slots: LayoutSlot[], reset = false): LayoutSlot[] {
  return packLayoutSlots(slots, reset);
}

function normalizeLayout(layout: DashboardLayout): DashboardLayout {
  return {
    sections: layout.sections.map((section) => ({
      ...section,
      widgets: packSection(section.widgets),
    })),
  };
}

function gridLayout(section: LayoutSection): Layout[] {
  return section.widgets.map((slot) => ({
    i: slot.id,
    x: slot.x ?? 0,
    y: slot.y ?? 0,
    w: slotWidth(slot),
    h: slotHeight(slot),
    minW: 2,
    minH: 2,
    maxH: 24,
  }));
}

/** The section under the pointer, ignoring the section the dragged card came from. */
function sectionAtPoint(
  point: { x: number; y: number },
  sourceIndex: number,
): { index: number; element: HTMLElement } | null {
  for (const element of document.elementsFromPoint(point.x, point.y)) {
    const section = element.closest<HTMLElement>("[data-section-index]");
    if (section === null) continue;
    const index = Number(section.dataset.sectionIndex);
    if (Number.isInteger(index) && index !== sourceIndex) {
      return { index, element: section };
    }
  }
  return null;
}

function insertionIndex(element: HTMLElement, widgets: LayoutSlot[], y: number): number {
  const cards = [...element.querySelectorAll<HTMLElement>("[data-widget-id]")];
  for (const card of cards) {
    const box = card.getBoundingClientRect();
    if (y < box.top + box.height / 2) {
      const id = card.dataset.widgetId;
      const index = widgets.findIndex((slot) => slot.id === id);
      if (index >= 0) return index;
    }
  }
  return widgets.length;
}

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
  draggable,
  onRemove,
}: {
  widget: Widget;
  view: WidgetView | undefined;
  value: WidgetValue | undefined;
  /** Desktop grids get a drag handle; phones stay a plain stack. */
  draggable: boolean;
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
      className="theme-radius relative flex h-full min-w-0 flex-col border border-border/70 bg-surface px-3 py-2 font-mono text-xs"
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
        <div className="flex min-w-0 items-start gap-1">
          {draggable ? (
            <button
              type="button"
              className="dashboard-drag-handle theme-radius -my-0.5 shrink-0 cursor-grab touch-none px-1 text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
              aria-label={`Move ${widget.title}`}
              title="Drag to move; use the corner to resize"
              data-testid={`widget-${widget.id}-drag`}
              onClick={(event) => event.stopPropagation()}
            >
              ⠿
            </button>
          ) : null}
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
        </div>
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
      <div className="min-h-0 flex-1 overflow-y-auto">
        {note === undefined ? null : (
          <p
            className="pb-1 text-[10px] leading-4 text-muted-foreground [overflow-wrap:anywhere]"
            data-testid={`widget-${widget.id}-note`}
          >
            {note}
          </p>
        )}
        {view !== undefined ? (
          <ViewBody id={widget.id} view={view} chart={widget.chart} />
        ) : (
          <p className="py-2 text-muted-foreground [overflow-wrap:anywhere]">
            {error ??
              (widget.source.type === "static" ? "waiting for data" : "waiting for the first poll")}
          </p>
        )}
      </div>
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

function sectionKey(index: number): string {
  return `section-${index}`;
}

function SectionTitle({
  title,
  onRename,
}: {
  title: string | undefined;
  onRename: (text: string) => void;
}) {
  const [draft, setDraft] = useState(title ?? "");
  const cancel = useRef(false);
  useEffect(() => {
    setDraft(title ?? "");
  }, [title]);
  const field = (
    <input
      type="text"
      className="min-w-0 flex-1 bg-transparent font-mono text-xs font-semibold text-foreground outline-none [overflow-wrap:anywhere]"
      aria-label="Section title"
      data-testid="section-title"
      placeholder="Untitled section"
      value={draft}
      onChange={(event) => setDraft(event.currentTarget.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          event.currentTarget.blur();
        } else if (event.key === "Escape") {
          cancel.current = true;
          setDraft(title ?? "");
          event.currentTarget.blur();
        }
      }}
      onBlur={(event) => {
        if (cancel.current) {
          cancel.current = false;
          setDraft(title ?? "");
          return;
        }
        onRename(event.currentTarget.value);
      }}
    />
  );
  const className =
    "theme-radius flex items-center border border-border/70 bg-surface px-2 py-1 pr-20";
  if (title === undefined) {
    return <div className={`${className} text-muted-foreground`}>{field}</div>;
  }
  return (
    <h2 className={className}>
      <span className="sr-only">{title}</span>
      {field}
    </h2>
  );
}

function SectionGrid({
  index,
  section,
  byId,
  values,
  inputs,
  desktop,
  onRemove,
}: {
  index: number;
  section: LayoutSection;
  byId: Map<string, Widget>;
  values: DashboardState["values"];
  inputs: BuiltinInputs;
  desktop: boolean;
  onRemove: (id: string) => void;
}) {
  const { ref: gridRef, width } = useGridWidth(desktop);
  const visible = section.widgets.filter((slot) => byId.has(slot.id));
  const items = useMemo(() => gridLayout({ ...section, widgets: visible }), [section, visible]);
  const cards = visible.map((slot) => {
    const widget = byId.get(slot.id) as Widget;
    const stored = values[widget.id];
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
        className="relative h-full min-w-0"
        data-widget-id={widget.id}
        data-span={slot.span}
      >
        <WidgetCard
          widget={widget}
          view={view}
          value={value}
          draggable={desktop}
          onRemove={onRemove}
        />
        {desktop ? (
          <button
            type="button"
            className="react-resizable-handle react-resizable-handle-se dashboard-resize-handle"
            aria-label={`Resize ${widget.title}`}
            title="Drag to resize"
            data-testid={`widget-${widget.id}-resize`}
            style={{ display: "block", opacity: 1 }}
          />
        ) : null}
      </div>
    );
  });

  if (!desktop) {
    return (
      <div className="grid grid-cols-1 gap-4" data-testid={`dashboard-stack-${index}`}>
        {cards}
      </div>
    );
  }

  return (
    <div ref={gridRef} className="dashboard-grid min-w-0" data-testid={`dashboard-grid-${index}`}>
      <GridLayout
        width={width}
        layout={items}
        cols={GRID_COLUMNS}
        rowHeight={GRID_ROW_HEIGHT}
        margin={[GRID_MARGIN, GRID_MARGIN]}
        containerPadding={[0, 0]}
        compactType={null}
        isDraggable={false}
        isResizable={false}
      >
        {cards}
      </GridLayout>
    </div>
  );
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
  const desktop = useDesktopGrid();
  useViewerReport(active);
  const pageRef = useRef<HTMLDivElement | null>(null);
  const [layout, setLayout] = useState<DashboardLayout | null>(null);
  const layoutJson = useRef("");
  const confirmed = useRef<DashboardLayout | null>(null);
  const dirty = useRef(false);
  const pending = useRef<DashboardLayout | null>(null);
  const saveTimer = useRef<number | undefined>(undefined);
  const saving = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

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

  useEffect(() => {
    if (dashboard === null) return;
    const incoming = normalizeLayout(dashboard.layout);
    const json = JSON.stringify(incoming);
    if (!dirty.current && json !== layoutJson.current) {
      layoutJson.current = json;
      confirmed.current = incoming;
      setLayout(incoming);
    }
  }, [dashboard]);

  const flushPatch = useCallback(async (keepalive = false) => {
    if (saveTimer.current !== undefined) {
      window.clearTimeout(saveTimer.current);
      saveTimer.current = undefined;
    }
    if (saving.current) return;
    const body = pending.current;
    if (body === null) return;
    saving.current = true;
    pending.current = null;
    try {
      const response = await fetch("/api/dashboard/layout", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sections: body.sections }),
        keepalive,
      });
      if (!response.ok) throw new Error(await response.text());
      const state = (await response.json()) as DashboardState;
      if (pending.current !== null || !mounted.current) return;
      const saved = normalizeLayout(state.layout);
      dirty.current = false;
      confirmed.current = saved;
      layoutJson.current = JSON.stringify(saved);
      setLayout(saved);
      setDashboard({ ...state, layout: saved });
    } catch {
      if (pending.current === null && mounted.current) {
        dirty.current = false;
        const fallback = confirmed.current;
        if (fallback !== null) {
          layoutJson.current = JSON.stringify(fallback);
          setLayout(fallback);
        }
      }
    } finally {
      saving.current = false;
      // A newer layout was committed while this request was in flight. Send it
      // only after the previous one settles, so the server cannot apply the
      // writes out of order and leave an older section title or span behind.
      if (pending.current !== null && mounted.current) void flushPatch(keepalive);
    }
  }, []);

  const commitLayout = useCallback(
    (next: DashboardLayout) => {
      const normalized = normalizeLayout(next);
      dirty.current = true;
      layoutJson.current = JSON.stringify(normalized);
      setLayout(normalized);
      pending.current = normalized;
      if (saveTimer.current !== undefined) window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(() => {
        saveTimer.current = undefined;
        void flushPatch();
      }, LAYOUT_DEBOUNCE_MS);
    },
    [flushPatch],
  );

  useEffect(() => {
    const flush = () => {
      if (pending.current !== null) void flushPatch(true);
    };
    window.addEventListener("pagehide", flush);
    return () => window.removeEventListener("pagehide", flush);
  }, [flushPatch]);

  const layoutRef = useRef<DashboardLayout | null>(null);
  layoutRef.current = layout;

  // Drag and resize are pointer-native, because the grid's drag handles must
  // work with mouse, touch and the synthetic pointer events in the browser
  // suite. No layout is persisted until the gesture ends.
  useEffect(() => {
    const root = pageRef.current;
    if (root === null) return;
    let gesture: GridGesture | null = null;
    let removeListeners: (() => void) | null = null;

    const endGesture = (event: PointerEvent) => {
      const active = gesture;
      if (active === null || event.pointerId !== active.pointerId) return;
      event.preventDefault();
      removeListeners?.();
      gesture = null;
      const current = layoutRef.current ?? active.base;
      let next = current;
      const point = { x: event.clientX, y: event.clientY };
      if (active.kind === "drag") {
        const otherSection = sectionAtPoint(point, active.sectionIndex);
        if (otherSection !== null) {
          next = moveBetweenSections(
            current,
            active.sectionIndex,
            otherSection.index,
            active.widgetId,
            otherSection.element,
            point.y,
          );
        } else {
          const card = cardAtPoint(point, active.widgetId);
          if (card !== null && card.sectionIndex === active.sectionIndex) {
            next = reorderInSection(
              current,
              active.sectionIndex,
              active.widgetId,
              card.id,
              point.y,
              card.element,
            );
          }
        }
      }
      commitLayout(next);
    };

    const moveGesture = (event: PointerEvent) => {
      const active = gesture;
      if (active === null || event.pointerId !== active.pointerId) return;
      event.preventDefault();
      const colPitch =
        (active.gridWidth - GRID_MARGIN * (GRID_COLUMNS - 1)) / GRID_COLUMNS + GRID_MARGIN;
      const rowPitch = GRID_ROW_HEIGHT + GRID_MARGIN;
      const dx = Math.round((event.clientX - active.startX) / colPitch);
      const dy = Math.round((event.clientY - active.startY) / rowPitch);
      if (dx === 0 && dy === 0) return;
      const next = structuredClone(active.base);
      const section = next.sections[active.sectionIndex];
      const slot = section?.widgets.find((item) => item.id === active.widgetId);
      if (section === undefined || slot === undefined) return;
      const originX = active.origin.x ?? 0;
      const originY = active.origin.y ?? 0;
      const originW = slotWidth(active.origin);
      const originH = slotHeight(active.origin);
      if (active.kind === "drag") {
        const x = clamp(originX + dx, 0, GRID_COLUMNS - originW);
        const y = Math.max(0, originY + dy);
        if (slot.x === x && slot.y === y) return;
        slot.x = x;
        slot.y = y;
      } else {
        const rawWidth = clamp(originW + dx, 2, GRID_COLUMNS - originX);
        // The page exposes three widths; snap a resize to the nearest one so
        // the stored w and span never disagree.
        const snapped = rawWidth >= 10 ? 12 : rawWidth >= 5 ? 6 : 4;
        const w = Math.min(snapped, GRID_COLUMNS - originX);
        const h = clamp(originH + dy, 2, 24);
        if (slot.w === w && slot.h === h) return;
        slot.w = w;
        slot.h = h;
        slot.span = spanForWidth(w);
      }
      active.moved = true;
      layoutRef.current = next;
      setLayout(next);
    };

    const onPointerDown = (event: PointerEvent) => {
      if (event.pointerType === "mouse" && event.button !== 0) return;
      const target = event.target instanceof Element ? event.target : null;
      const dragHandle = target?.closest<HTMLElement>(".dashboard-drag-handle");
      const resizeHandle = target?.closest<HTMLElement>(".dashboard-resize-handle");
      const handle = dragHandle ?? resizeHandle;
      if (handle === null || handle === undefined) return;
      const card = handle.closest<HTMLElement>("[data-widget-id]");
      const section = handle.closest<HTMLElement>("[data-section-index]");
      const widgetId = card?.dataset.widgetId;
      const sectionIndex = Number(section?.dataset.sectionIndex);
      const current = layoutRef.current;
      if (card === null || card === undefined || widgetId === undefined || current === null) return;
      if (!Number.isInteger(sectionIndex)) return;
      const slot = current.sections[sectionIndex]?.widgets.find((item) => item.id === widgetId);
      const grid = section?.querySelector<HTMLElement>(".dashboard-grid");
      if (slot === undefined || grid === null || grid === undefined) return;
      event.preventDefault();
      event.stopPropagation();
      removeListeners?.();
      gesture = {
        kind: dragHandle !== null && dragHandle !== undefined ? "drag" : "resize",
        pointerId: event.pointerId,
        sectionIndex,
        widgetId,
        startX: event.clientX,
        startY: event.clientY,
        gridWidth: grid.getBoundingClientRect().width,
        origin: { ...slot },
        base: structuredClone(current),
        moved: false,
      };
      window.addEventListener("pointermove", moveGesture, true);
      window.addEventListener("pointerup", endGesture, true);
      window.addEventListener("pointercancel", endGesture, true);
      removeListeners = () => {
        window.removeEventListener("pointermove", moveGesture, true);
        window.removeEventListener("pointerup", endGesture, true);
        window.removeEventListener("pointercancel", endGesture, true);
        removeListeners = null;
      };
      try {
        handle.setPointerCapture(event.pointerId);
      } catch {
        // Synthetic pointer events do not own a capturable pointer.
      }
    };

    root.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      root.removeEventListener("pointerdown", onPointerDown, true);
      removeListeners?.();
    };
  }, [commitLayout]);

  const remove = useCallback(async (id: string) => {
    const response = await fetch(`/api/dashboard/widgets/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }).catch(() => null);
    if (response?.ok) {
      haptic([12, 40, 12]);
      setDashboard((await response.json()) as DashboardState);
    }
  }, []);

  const addSection = useCallback(() => {
    const current = layout;
    if (current === null || current.sections.length >= MAX_SECTIONS) return;
    const next = structuredClone(current);
    next.sections.push({ title: "New section", widgets: [] });
    commitLayout(next);
  }, [commitLayout, layout]);

  const renameSection = useCallback(
    (index: number, text: string) => {
      const current = layout;
      if (current === null) return;
      const next = structuredClone(current);
      const section = next.sections[index];
      if (section === undefined) return;
      const title = text.trim().slice(0, 60);
      if (title === "") delete section.title;
      else section.title = title;
      if (JSON.stringify(next) === JSON.stringify(current)) return;
      commitLayout(next);
    },
    [commitLayout, layout],
  );

  const deleteSection = useCallback(
    (index: number) => {
      const current = layout;
      if (current === null || current.sections.length <= 1) return;
      const next = structuredClone(current);
      const [removed] = next.sections.splice(index, 1);
      if (removed === undefined) return;
      const target = index > 0 ? index - 1 : 0;
      next.sections[target]?.widgets.push(...removed.widgets);
      next.sections = next.sections.map((section) => ({
        ...section,
        widgets: packSection(section.widgets, true),
      }));
      commitLayout(next);
    },
    [commitLayout, layout],
  );

  const inputs: BuiltinInputs = {
    usage: stats.usage,
    context: stats.context,
    mcp: stats.mcp,
    mcpEvents: stats.mcpEvents,
    jobs: dashboard?.builtins.jobs ?? [],
    session: dashboard?.builtins.session ?? { conversationId: "", model: null, run: "idle" },
  };
  const byId = new Map((dashboard?.widgets ?? []).map((widget) => [widget.id, widget]));
  const viewLayout = layout ?? (dashboard === null ? null : normalizeLayout(dashboard.layout));

  return (
    <div
      ref={pageRef}
      className="h-full overflow-x-hidden overflow-y-auto"
      data-testid="stats-page"
    >
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
        {viewLayout === null ? null : (
          <div className="flex justify-end">
            <button
              type="button"
              className="theme-radius border border-border/70 bg-surface px-2 py-1 font-mono text-xs text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
              data-testid="dashboard-add-section"
              disabled={viewLayout.sections.length >= MAX_SECTIONS}
              onClick={addSection}
            >
              Add section
            </button>
          </div>
        )}
        {viewLayout?.sections.map((section, index) => (
          <div
            key={sectionKey(index)}
            className="relative flex flex-col gap-2"
            data-testid="dashboard-section"
            data-section-index={index}
          >
            <SectionTitle title={section.title} onRename={(text) => renameSection(index, text)} />
            <div className="absolute top-1 right-1 z-10 flex items-center gap-1">
              <button
                type="button"
                className="theme-radius border border-border/70 bg-surface px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground hover:bg-foreground/10 hover:text-foreground disabled:opacity-40"
                aria-label={`Delete section ${index + 1}`}
                data-testid={`section-delete-${index}`}
                disabled={viewLayout.sections.length <= 1}
                onClick={() => deleteSection(index)}
              >
                ✕
              </button>
            </div>
            <SectionGrid
              index={index}
              section={section}
              byId={byId}
              values={dashboard?.values ?? {}}
              inputs={inputs}
              desktop={desktop}
              onRemove={remove}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
