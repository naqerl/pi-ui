import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  type BuiltinInputs,
  builtinData,
  type DashboardState,
  renderWidget,
  type StatusState,
  type Widget,
  type WidgetSpan,
  type WidgetValue,
  type WidgetView,
} from "../shared/dashboard";
import type { ContextUsage, McpEventsState, McpStatus, UsageSummary } from "../shared/types";
import { getDashboard, setDashboard, subscribeDashboard } from "./dashboard-store";
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

function Sparkline({ points }: { points: number[] }) {
  if (points.length < 2) {
    return <div className="h-10 text-muted-foreground">collecting…</div>;
  }
  const min = Math.min(...points);
  const max = Math.max(...points);
  const range = max - min || 1;
  const step = 100 / (points.length - 1);
  const path = points
    .map(
      (point, index) =>
        `${(index * step).toFixed(2)},${(38 - ((point - min) / range) * 36).toFixed(2)}`,
    )
    .join(" ");
  return (
    <svg viewBox="0 0 100 40" preserveAspectRatio="none" className="h-10 w-full" aria-hidden="true">
      <polyline
        points={path}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
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

function ViewBody({ id, view }: { id: string; view: WidgetView }) {
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
          <Sparkline points={view.points} />
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
          navigator.vibrate?.(10);
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
              : `updated ${new Date(value.updatedAt).toLocaleString()}`
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
        <ViewBody id={widget.id} view={view} />
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
    return { view: renderWidget(widget, builtinData(widget.source.name, inputs)) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/** The dashboard page: widgets the agent arranged, rendered from builtin stats, polls or pushed data. */
export function StatsView({
  stats,
  ready,
  active,
  headerClearance,
  footerClearance,
}: {
  stats: ChatStats;
  ready: boolean;
  /** True while the dashboard is the current page. */
  active: boolean;
  headerClearance: number;
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
    if (response?.ok) setDashboard((await response.json()) as DashboardState);
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
        style={{ paddingTop: headerClearance + 16, paddingBottom: footerClearance + 16 }}
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
