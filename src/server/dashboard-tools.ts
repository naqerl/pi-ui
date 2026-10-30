import {
  defineTool,
  type ToolExecutionResult,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { BUILTIN_SOURCES, WIDGET_KINDS, WIDGET_SPANS } from "../shared/dashboard.js";
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
- sparkline: value (a number; its poll/push history is drawn) or series (array of numbers), label
- markdown: text* (markdown; raw HTML is shown as text)
- status: items (array) with label, state, detail, key per item; or a single state* and label. States: ok/running/up/healthy… = green, warn/starting/off/pending… = amber, anything else = red.
list, table and status also take empty (text shown when there are no items).`;

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
      description: `Arrange the dashboard page: ordered sections with optional titles, each an ordered list of widget ids with a width. span is ${WIDGET_SPANS.join(", ")} of a row; on a phone every widget is full width. Every id must exist; widgets you leave out are added in a last section.`,
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
