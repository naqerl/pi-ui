/**
 * The committed default board: the layout a fresh DATA_DIR starts from and the
 * one "reset to default" restores. Widget ids are stable so a widget can be
 * replaced in place and a tombstone can keep a deleted keepsake deleted.
 */
import {
  type DashboardConfig,
  DEFAULT_WIDGET_ROWS,
  type LayoutSection,
  MAX_WIDGETS,
  packLayoutSlots,
  type Widget,
} from "./dashboard.js";

/** Bump when the default board changes; older files surface it for reset. */
export const DEFAULT_DASHBOARD_VERSION = 2;

const MCP_STATUS: Widget = {
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
};

const MCP_EVENTS: Widget = {
  id: "mcp-events",
  title: "MCP events",
  kind: "list",
  source: { type: "builtin", name: "mcp_events" },
  mapping: {
    items: "events",
    key: "key",
    label: "label",
    value: "value",
    empty: "=no MCP events yet",
  },
};

const TASK_REOPENS: Widget = {
  id: "task-reopens",
  title: "Task reopens",
  kind: "list",
  source: { type: "builtin", name: "task_reopens" },
  mapping: {
    items: "rows",
    key: "key",
    label: "label",
    value: "value",
    empty: "=no tasks reopened yet",
  },
};

/**
 * The board production actually shows. The live dashboard.json was not
 * reachable from the checkout that wrote this file, so the poll-only cards
 * (host usage, prefix moments/cost, Hetzner and Go usage) use their closest
 * builtin equivalents. They keep the production ids and section positions and
 * can be replaced in place with a poll source later.
 */
export const DEFAULT_DASHBOARD: {
  version: number;
  sections: LayoutSection[];
  widgets: Widget[];
} = {
  version: DEFAULT_DASHBOARD_VERSION,
  widgets: [
    {
      id: "host-usage",
      title: "Host usage",
      kind: "stat",
      source: { type: "builtin", name: "jobs" },
      mapping: { value: "running", label: "=host usage" },
    },
    {
      id: "prefix-moments",
      title: "Prefix moments",
      kind: "stat",
      source: { type: "builtin", name: "cache" },
      mapping: { value: "read", label: "=prefix moments" },
    },
    {
      id: "prefix-cost",
      title: "Prefix cost",
      kind: "stat",
      source: { type: "builtin", name: "tokens" },
      mapping: { value: "costText", label: "=prefix cost" },
    },
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
    MCP_STATUS,
    MCP_EVENTS,
    TASK_REOPENS,
    {
      id: "hetzner",
      title: "Hetzner",
      kind: "status",
      source: { type: "builtin", name: "session" },
      mapping: { state: "run", label: "=Hetzner" },
    },
    {
      id: "hetzner-cost",
      title: "Hetzner cost",
      kind: "stat",
      source: { type: "builtin", name: "cache" },
      mapping: { value: "write", label: "=Hetzner cost" },
    },
    {
      id: "go-usage",
      title: "Go usage",
      kind: "list",
      source: { type: "builtin", name: "session" },
      mapping: { items: "rows", key: "key", label: "label", value: "value" },
    },
    {
      id: "bg-jobs",
      title: "Background jobs",
      kind: "status",
      source: { type: "builtin", name: "jobs" },
      mapping: {
        items: "jobs",
        key: "key",
        label: "label",
        state: "state",
        detail: "detail",
        empty: "=no background jobs",
      },
    },
  ],
  sections: [
    {
      widgets: [{ id: "host-usage", span: "full", x: 0, y: 0, w: 12, h: DEFAULT_WIDGET_ROWS }],
    },
    {
      title: "Cache & prefix",
      widgets: [
        { id: "prefix-moments", span: "half", x: 0, y: 0, w: 6, h: DEFAULT_WIDGET_ROWS },
        { id: "prefix-cost", span: "half", x: 6, y: 0, w: 6, h: DEFAULT_WIDGET_ROWS },
      ],
    },
    {
      title: "Session",
      widgets: [
        { id: "context", span: "half", x: 0, y: 0, w: 6, h: DEFAULT_WIDGET_ROWS },
        { id: "tokens", span: "half", x: 6, y: 0, w: 6, h: DEFAULT_WIDGET_ROWS },
        { id: "mcp", span: "full", x: 0, y: 4, w: 12, h: DEFAULT_WIDGET_ROWS },
        { id: "mcp-events", span: "full", x: 0, y: 8, w: 12, h: DEFAULT_WIDGET_ROWS },
        { id: "task-reopens", span: "full", x: 0, y: 12, w: 12, h: DEFAULT_WIDGET_ROWS },
      ],
    },
    {
      title: "Infrastructure",
      widgets: [
        { id: "hetzner", span: "half", x: 0, y: 0, w: 6, h: DEFAULT_WIDGET_ROWS },
        { id: "hetzner-cost", span: "half", x: 6, y: 0, w: 6, h: DEFAULT_WIDGET_ROWS },
        { id: "go-usage", span: "half", x: 0, y: 4, w: 6, h: DEFAULT_WIDGET_ROWS },
        { id: "bg-jobs", span: "full", x: 0, y: 8, w: 12, h: DEFAULT_WIDGET_ROWS },
      ],
    },
  ],
};

/** A private copy of DEFAULT_DASHBOARD, ready to save as dashboard.json. */
export function defaultDashboardConfig(): DashboardConfig {
  return {
    version: DEFAULT_DASHBOARD.version,
    tombstones: [],
    widgets: structuredClone(DEFAULT_DASHBOARD.widgets),
    layout: { sections: structuredClone(DEFAULT_DASHBOARD.sections) },
  };
}

/** True when a default section already exists, or appends one with its title. */
function sectionFor(config: DashboardConfig, definition: LayoutSection): LayoutSection {
  if (definition.title !== undefined) {
    const match = config.layout.sections.find((section) => section.title === definition.title);
    if (match !== undefined) return match;
    const created: LayoutSection = { title: definition.title, widgets: [] };
    config.layout.sections.push(created);
    return created;
  }
  const first = config.layout.sections[0];
  if (first !== undefined) return first;
  const created: LayoutSection = { widgets: [] };
  config.layout.sections.push(created);
  return created;
}

/**
 * Adds default widgets an existing current-version file lacks, except the ones
 * the user deleted (tombstoned). An older file is left alone by the caller.
 */
export function seedDashboard(config: DashboardConfig): boolean {
  const present = new Set(config.widgets.map((widget) => widget.id));
  const tombstoned = new Set(config.tombstones);
  const defaults = new Map(DEFAULT_DASHBOARD.widgets.map((widget) => [widget.id, widget]));
  let changed = false;
  for (const section of DEFAULT_DASHBOARD.sections) {
    for (const slot of section.widgets) {
      const widget = defaults.get(slot.id);
      if (widget === undefined || present.has(widget.id) || tombstoned.has(widget.id)) continue;
      if (config.widgets.length >= MAX_WIDGETS) return changed;
      config.widgets.push(structuredClone(widget));
      const target = sectionFor(config, section);
      target.widgets.push(structuredClone(slot));
      target.widgets = packLayoutSlots(target.widgets);
      present.add(widget.id);
      changed = true;
    }
  }
  return changed;
}
