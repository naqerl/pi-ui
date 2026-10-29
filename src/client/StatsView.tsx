import type { ContextUsage, McpStatus, UsageSummary } from "../shared/types";

export interface ChatStats {
  usage: UsageSummary | null;
  context: ContextUsage | null;
  mcp: McpStatus;
}

/** Share of prompt tokens served from the provider cache. Null before any model call. */
export function cacheHitRate(usage: UsageSummary): number | null {
  const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
  if (prompt <= 0) return null;
  return usage.cacheRead / prompt;
}

function percent(value: number): string {
  const scaled = value * 100;
  return `${scaled >= 10 || scaled === 0 ? Math.round(scaled) : scaled.toFixed(1)}%`;
}

function exact(count: number): string {
  return Math.max(0, Math.round(count)).toLocaleString("en-US");
}

function Unavailable({ reason }: { reason: string }) {
  return (
    <span className="text-muted-foreground" data-unavailable="">
      unavailable · {reason}
    </span>
  );
}

function Row({
  label,
  testId,
  children,
}: {
  label: string;
  testId: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 py-2"
      data-testid={testId}
    >
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-right [overflow-wrap:anywhere]">{children}</dd>
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section
      aria-label={title}
      className="theme-radius min-w-0 border border-border/70 bg-surface px-3 py-2 font-mono text-xs"
    >
      <h2 className="pb-1 text-[11px] uppercase tracking-wide text-muted-foreground">{title}</h2>
      {children}
    </section>
  );
}

function ContextMeter({ context }: { context: ContextUsage }) {
  if (context.window === null || context.percent === null) {
    return (
      <span>
        {exact(context.tokens)} tokens · <Unavailable reason="model window unknown" />
      </span>
    );
  }
  return (
    <span className="flex flex-col items-end gap-1">
      <span>
        {exact(context.tokens)} / {exact(context.window)} · {context.percent}%
      </span>
      <span
        className="block h-1 w-32 max-w-full bg-foreground/15"
        aria-hidden="true"
        data-testid="context-bar"
      >
        <span className="block h-full bg-foreground" style={{ width: `${context.percent}%` }} />
      </span>
    </span>
  );
}

/** Conversation numbers from the server snapshot. Anything the server cannot report says so. */
export function StatsView({
  stats,
  ready,
  headerClearance,
  footerClearance,
}: {
  stats: ChatStats;
  ready: boolean;
  headerClearance: number;
  footerClearance: number;
}) {
  const { usage, context, mcp } = stats;
  const hit = usage === null ? null : cacheHitRate(usage);
  const called = usage !== null && usage.input + usage.output + usage.cacheRead > 0;
  return (
    <div className="h-full overflow-x-hidden overflow-y-auto" data-testid="stats-page">
      <div
        className="mx-auto flex w-full max-w-[72ch] flex-col gap-4 px-4"
        style={{ paddingTop: headerClearance + 16, paddingBottom: footerClearance + 16 }}
      >
        {!ready && <p className="font-mono text-xs text-muted-foreground">Loading…</p>}
        <Card title="Context">
          <dl className="divide-y divide-border/50">
            <Row label="size" testId="stat-context">
              {context === null ? (
                <Unavailable reason="no snapshot yet" />
              ) : context.tokens === 0 ? (
                <Unavailable reason="no model call yet" />
              ) : (
                <ContextMeter context={context} />
              )}
            </Row>
          </dl>
        </Card>
        <Card title="Tokens">
          <dl className="divide-y divide-border/50">
            <Row label="in" testId="stat-input">
              {usage === null ? <Unavailable reason="no snapshot yet" /> : exact(usage.input)}
            </Row>
            <Row label="out" testId="stat-output">
              {usage === null ? <Unavailable reason="no snapshot yet" /> : exact(usage.output)}
            </Row>
            <Row label="cache read" testId="stat-cache-read">
              {usage === null ? <Unavailable reason="no snapshot yet" /> : exact(usage.cacheRead)}
            </Row>
            <Row label="cache write" testId="stat-cache-write">
              {usage === null ? <Unavailable reason="no snapshot yet" /> : exact(usage.cacheWrite)}
            </Row>
            <Row label="cache hit" testId="stat-cache-hit">
              {hit === null ? (
                <Unavailable reason="no model call yet" />
              ) : (
                <span title="cache read ÷ (input + cache read + cache write)">{percent(hit)}</span>
              )}
            </Row>
            <Row label="cost" testId="stat-cost">
              {usage === null || !called ? (
                <Unavailable reason="no model call yet" />
              ) : usage.cost > 0 ? (
                `$${usage.cost.toFixed(usage.cost < 1 ? 4 : 2)}`
              ) : (
                <Unavailable reason="provider reports no price" />
              )}
            </Row>
          </dl>
        </Card>
        <Card title="MCP">
          {mcp.servers.length === 0 ? (
            <p className="py-2 text-muted-foreground" data-testid="stat-mcp-empty">
              no MCP servers configured
            </p>
          ) : (
            <ul className="divide-y divide-border/50">
              {mcp.servers.map((server) => (
                <li
                  key={server.name}
                  data-testid={`stat-mcp-${server.name}`}
                  className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-4 py-2"
                >
                  <span className="min-w-0 [overflow-wrap:anywhere]">
                    <span aria-hidden="true">{server.available ? "● " : "○ "}</span>
                    {server.name}
                  </span>
                  <span className="text-muted-foreground">
                    {server.available
                      ? `connected · ${server.tools.length} tool${server.tools.length === 1 ? "" : "s"}`
                      : server.authRejected
                        ? "auth rejected"
                        : "unavailable"}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <p className="px-1 font-mono text-[10px] leading-4 text-muted-foreground">
          Totals cover this conversation. Input excludes cached tokens; cache hit is cache read over
          all prompt tokens.
        </p>
      </div>
    </div>
  );
}
