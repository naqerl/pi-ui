import {
  defineTool,
  type ToolExecutionResult,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { Type } from "typebox";
import {
  BUILTIN_SOURCES,
  CHART_FORMATS,
  CHART_TYPES,
  WIDGET_KINDS,
  WIDGET_SPANS,
} from "../shared/dashboard.js";
import { DashboardError, type DashboardManager } from "./dashboard.js";

function text(value: string, isError = false): ToolExecutionResult {
  return { output: [{ type: "text", text: value }], ...(isError ? { isError: true } : {}) };
}

function json(value: unknown, isError = false): ToolExecutionResult {
  return text(JSON.stringify(value, null, 1), isError);
}

function failure(error: unknown): ToolExecutionResult {
  return text(
    error instanceof DashboardError ? error.message : `Dashboard tool failed: ${String(error)}`,
    true,
  );
}

const KINDS_DOC = `Kinds and their mapping fields (* required):
- stat: value*, label, delta (number or "+3"; shows a trend arrow), unit, progress (0-100 meter)
- list: items* (array), key, label, value (paths relative to each item)
- table: columns* ({"Header": "path"}), rows (array; column paths are then relative to each row; without rows, column paths are absolute arrays zipped together)
- sparkline: value (a number; its poll/push history is drawn) or series (an array of numbers, an object of named number arrays, or [{key, label?, points: (number|null)[]}]), labels (optional x tick labels), label. Optional chart below; it leaves the data mapping unchanged and cannot run code.
- markdown: text* (markdown; raw HTML is shown as text)
- status: items (array) with label, state, detail, key per item; or a single state* and label. States: ok/running/up/healthy… = green, warn/starting/off/pending… = amber, anything else = red.
list, table and status also take empty (text shown when there are no items).`;

const CHART_DOC = `Sparkline chart spec (all keys except series/reference are optional):
{type (area|line|bar, default area for every series), color (legacy single-series colour), height (12-400, default 40), legend (default true when more than one series), showTooltip, yDomain ([min,max] or "auto"), y {format: number|currency|percent|bytes, ticks: 0-10, currency: symbol (default €)}, x {labels: string[], format}, series: [{key (1-64 chars), label (≤40), color, type, dashed, fillOpacity (0-1, area default 0.35), stack (≤24)}] (1-6), reference: [{value, label, color, dashed}] (0-4)}.
Colours default to var(--chart-1) through var(--chart-6), cycling by series index. A reference line defaults to var(--chart-4) and dashed. Series keys index the mapped series data. Colours must be var(--token) references or color-mix(in srgb, …) expressions built from them; literal colours are rejected.
Examples:
- two curves, projection dashed: mapping {series:"series", labels:"labels"}, data {series:{actual:[1,4,7], projection:[2,5,9]}, labels:["Mon","Tue","Wed"]}, chart {type:"line", x:{labels:["Mon","Tue","Wed"]}, series:[{key:"actual",label:"Actual",color:"var(--chart-1)"},{key:"projection",label:"Projection",color:"var(--chart-2)",dashed:true}]}
- stacked bars: mapping {series:"series"}, data {series:{used:[2,3],free:[5,4]}}, chart {type:"bar", series:[{key:"used",label:"Used",stack:"cost"},{key:"free",label:"Free",stack:"cost"}]}
- threshold line: mapping {series:"spend"}, data {spend:[12,18,31]}, chart {type:"area", y:{format:"currency",ticks:4}, reference:[{value:25,label:"Budget",color:"var(--chart-4)"}]}`;

const MAPPING_DOC = `Mapping values are path expressions into the source data: "a.b", "servers[].name" (one value per element), "items[0]", "items[-1]", "$" for the whole value, "list.length". A value starting with "=" is a literal: "label": "=servers".`;

const SOURCE_DOC = `Sources:
- {"type":"builtin","name":one of ${BUILTIN_SOURCES.join(", ")}}: live pi-ui data. Call dashboard_upsert with a builtin source to see its fields in "sample".
- {"type":"poll","script":"…","intervalSec":60,"timeoutSec":10}: script is the body of an async function (fetch, env, prev, log) that returns JSON. env is the read-only server environment: read tokens from it (e.g. env.HCLOUD_TOKEN), never write them into the script. prev is the last result; log(...) lines come back from dashboard_upsert. Runs in an isolated worker, at least every 30s, only while the dashboard page is open; 10 poll widgets at most, results capped at 128 KB, so return only what the widget shows. A failure keeps the last good value with an error badge; after 5 failures in a row polling backs off and you get one message.
- {"type":"static"}: data you send with dashboard_push.`;

/** Tools that let the agent build the dashboard page. Not deferred. */
export function createDashboardTools(dashboard: DashboardManager): ToolRegistration[] {
  return [
    defineTool({
      name: "dashboard_get",
      description:
        "Read the dashboard page (the page left of chat): its sections, each widget's config, span, last rendered value, error and updatedAt, and whether polling is active (someone has the page open). The user can remove widgets from the page; this shows the current state.",
      parameters: Type.Object({}),
      async execute() {
        try {
          return json(await dashboard.describe());
        } catch (error) {
          return failure(error);
        }
      },
    }),
    defineTool({
      name: "dashboard_upsert",
      description: `Add a widget to the dashboard page or replace one with the same id, then render it once and return the view, any error, a sample of the source data and the script's log lines, so you can fix the mapping or script and call again. New widgets go at the end of the last section; place them with dashboard_layout. Widgets show data only: no buttons, no custom HTML or JS in the page.

${SOURCE_DOC}

${KINDS_DOC}

${CHART_DOC}

${MAPPING_DOC}`,
      parameters: Type.Object({
        id: Type.String({ description: "Stable id: letters, digits, - or _." }),
        title: Type.String({ description: "Card title." }),
        kind: Type.Union(
          WIDGET_KINDS.map((kind) => Type.Literal(kind)),
          { description: "How the data is drawn." },
        ),
        source: Type.Object(
          {
            type: Type.Union([
              Type.Literal("builtin"),
              Type.Literal("poll"),
              Type.Literal("static"),
            ]),
            name: Type.Optional(
              Type.Union(
                BUILTIN_SOURCES.map((name) => Type.Literal(name)),
                {
                  description: "builtin source name.",
                },
              ),
            ),
            script: Type.Optional(
              Type.String({
                description: "poll: async function body (fetch, env, prev, log) returning JSON.",
              }),
            ),
            intervalSec: Type.Optional(
              Type.Number({ description: "poll: seconds between runs, at least 30. Default 60." }),
            ),
            timeoutSec: Type.Optional(
              Type.Number({ description: "poll: per-run timeout, 1-30. Default 10." }),
            ),
          },
          { description: "Where the data comes from." },
        ),
        mapping: Type.Record(
          Type.String(),
          Type.Union([Type.String(), Type.Record(Type.String(), Type.String())]),
          {
            description:
              "Widget field → path expression or =literal; table columns is header → path.",
          },
        ),
        chart: Type.Optional(
          Type.Object(
            {
              type: Type.Optional(
                Type.Union(
                  CHART_TYPES.map((type) => Type.Literal(type)),
                  { description: "Default series type: area, line or bar. Default area." },
                ),
              ),
              color: Type.Optional(
                Type.String({
                  description:
                    "Legacy single-series colour; series[i].color wins. Usually var(--chart-1…6).",
                }),
              ),
              height: Type.Optional(
                Type.Number({ description: "Chart height in pixels, 12-400. Default 40." }),
              ),
              legend: Type.Optional(
                Type.Boolean({
                  description: "Show a legend. Default true when there is more than one series.",
                }),
              ),
              yDomain: Type.Optional(
                Type.Union(
                  [
                    Type.Array(Type.Number(), {
                      minItems: 2,
                      maxItems: 2,
                      description: "Two numbers: [min, max].",
                    }),
                    Type.Literal("auto"),
                  ],
                  {
                    // A tuple schema (`items: [A, B]`) is rejected by the model provider, so the
                    // pair is described as a two-element array of numbers instead.
                    description: 'Fixed y-axis range as [min, max], or "auto".',
                  },
                ),
              ),
              y: Type.Optional(
                Type.Object(
                  {
                    format: Type.Optional(
                      Type.Union(
                        CHART_FORMATS.map((format) => Type.Literal(format)),
                        { description: "number, currency, percent or bytes." },
                      ),
                    ),
                    ticks: Type.Optional(
                      Type.Number({
                        minimum: 0,
                        maximum: 10,
                        description: "Show the y axis with this many ticks.",
                      }),
                    ),
                    currency: Type.Optional(
                      Type.String({
                        description: "Currency symbol for format currency. Default €.",
                      }),
                    ),
                  },
                  { description: "Y-axis formatting and ticks." },
                ),
              ),
              x: Type.Optional(
                Type.Object(
                  {
                    labels: Type.Optional(
                      Type.Array(Type.String(), {
                        description: "X tick labels, index-aligned with the points.",
                      }),
                    ),
                    format: Type.Optional(
                      Type.String({ description: "Optional x label format name." }),
                    ),
                  },
                  { description: "X-axis labels." },
                ),
              ),
              series: Type.Optional(
                Type.Array(
                  Type.Object({
                    key: Type.String({ description: "Key in the mapped series data." }),
                    label: Type.Optional(
                      Type.String({ description: "Legend and tooltip name; defaults to key." }),
                    ),
                    color: Type.Optional(
                      Type.String({ description: "CSS color or var(--chart-N)." }),
                    ),
                    type: Type.Optional(
                      Type.Union(
                        CHART_TYPES.map((type) => Type.Literal(type)),
                        { description: "This series' type; defaults to chart.type." },
                      ),
                    ),
                    dashed: Type.Optional(
                      Type.Boolean({ description: "Draw this series dashed." }),
                    ),
                    fillOpacity: Type.Optional(
                      Type.Number({
                        minimum: 0,
                        maximum: 1,
                        description: "Area fill opacity, 0-1. Default 0.35.",
                      }),
                    ),
                    stack: Type.Optional(
                      Type.String({ description: "Equal stack ids stack together." }),
                    ),
                  }),
                  { minItems: 1, maxItems: 6, description: "One to six series." },
                ),
              ),
              reference: Type.Optional(
                Type.Array(
                  Type.Object({
                    value: Type.Number({ description: "Y value of the line." }),
                    label: Type.Optional(Type.String({ description: "Text beside the line." })),
                    color: Type.Optional(
                      Type.String({ description: "Theme token. Default var(--chart-4)." }),
                    ),
                    dashed: Type.Optional(
                      Type.Boolean({ description: "Draw dashed. Default true." }),
                    ),
                  }),
                  { minItems: 0, maxItems: 4, description: "Zero to four reference lines." },
                ),
              ),
              showTooltip: Type.Optional(
                Type.Boolean({ description: "Show a tooltip on hover. Default false." }),
              ),
            },
            { description: "Sparkline presentation only; data still comes from mapping." },
          ),
        ),
      }),
      async execute(args) {
        try {
          const result = await dashboard.upsert(args);
          return json(
            {
              id: result.widget.id,
              ...(result.view === undefined ? {} : { view: result.view }),
              ...(result.error === undefined ? {} : { error: result.error }),
              ...(result.updatedAt === undefined ? {} : { updatedAt: result.updatedAt }),
              ...(result.sample === undefined ? {} : { sample: result.sample }),
              ...(result.logs === undefined ? {} : { logs: result.logs }),
              ...(result.notes.length === 0 ? {} : { notes: result.notes }),
              polling: result.polling,
            },
            result.error !== undefined,
          );
        } catch (error) {
          return failure(error);
        }
      },
    }),
    defineTool({
      name: "dashboard_remove",
      description: "Remove a widget from the dashboard page by id.",
      parameters: Type.Object({ id: Type.String({ description: "Widget id." }) }),
      async execute(args) {
        try {
          await dashboard.remove(args.id);
          return text(`Removed ${args.id.trim()}.`);
        } catch (error) {
          return failure(error);
        }
      },
    }),
    defineTool({
      name: "dashboard_push",
      description:
        "Send data to a static widget; its mapping reads it like a poll result. Numbers kept by stat or sparkline widgets build the sparkline history. Returns the rendered view or the mapping error.",
      parameters: Type.Object({
        id: Type.String({ description: "Id of a widget with a static source." }),
        data: Type.Unknown({ description: "Any JSON value, up to 128 KB." }),
      }),
      async execute(args) {
        try {
          const result = await dashboard.push(args.id, args.data);
          return json(
            {
              id: result.widget.id,
              ...(result.view === undefined ? {} : { view: result.view }),
              ...(result.error === undefined ? {} : { error: result.error }),
            },
            result.error !== undefined,
          );
        } catch (error) {
          return failure(error);
        }
      },
    }),
    defineTool({
      name: "dashboard_layout",
      description: `Arrange the dashboard page: ordered sections with optional titles, each an ordered list of widget ids with a width. span is ${WIDGET_SPANS.join(", ")} of a row (full = 12, half = 6, third = 4 columns); on a phone every widget is full width. x, y, w and h are optional 12-column grid coordinates; the UI writes the same shape after a drag or resize, so omit them to let the server pack the section. Every id must exist; widgets you leave out are added in a last section.`,
      parameters: Type.Object({
        sections: Type.Array(
          Type.Object({
            title: Type.Optional(Type.String({ description: "Section heading." })),
            widgets: Type.Array(
              Type.Object({
                id: Type.String(),
                span: Type.Optional(
                  Type.Union(
                    WIDGET_SPANS.map((span) => Type.Literal(span)),
                    { description: "Default full." },
                  ),
                ),
                order: Type.Optional(
                  Type.Number({
                    description: "Position inside the section; default is array order.",
                  }),
                ),
                x: Type.Optional(
                  Type.Number({ description: "Column 0-11 in the 12-column grid." }),
                ),
                y: Type.Optional(Type.Number({ description: "Row in the 12-column grid." })),
                w: Type.Optional(Type.Number({ description: "Width in columns, 1-12." })),
                h: Type.Optional(Type.Number({ description: "Height in grid rows." })),
              }),
            ),
          }),
        ),
      }),
      async execute(args) {
        try {
          const result = await dashboard.setLayout(args);
          return json({
            layout: result.layout,
            ...(result.notes.length === 0 ? {} : { notes: result.notes }),
          });
        } catch (error) {
          return failure(error);
        }
      },
    }),
  ];
}
