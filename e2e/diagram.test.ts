import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { AssistantEntry, type EntryRecord, ToolResultEntry } from "@earendil-works/pi-durable";
import { renderDiagram } from "../src/client/diagram-render.js";
import { createDiagramTools } from "../src/server/diagram-tools.js";
import {
  DiagramError,
  DiagramStore,
  encodeDiagramId,
  isDiagramId,
  MAX_DIAGRAM_BYTES,
  newDiagramId,
  safeSvgDocument,
} from "../src/server/diagrams.js";
import { buildTranscript } from "../src/server/session.js";
import { windowTranscript } from "../src/server/transcript-window.js";
import { DIAGRAM_ID_PATTERN } from "../src/shared/diagrams.js";

let directory = "";
let store: DiagramStore;

const diagramDir = () => join(directory, "diagrams");

function textOf(
  result: Awaited<ReturnType<ReturnType<typeof createDiagramTools>[number]["execute"]>>,
) {
  const part = result.output?.find((item) => item.type === "text");
  return {
    text: part !== undefined && part.type === "text" ? part.text : "",
    isError: result.isError === true,
  };
}

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "pi-ui-diagrams-"));
  store = new DiagramStore(diagramDir());
  await store.load();
});

after(async () => {
  await rm(directory, { recursive: true, force: true });
});

test("diagram ids are stable lowercase base32", () => {
  assert.equal(encodeDiagramId(new Uint8Array(7)), "aaaaaaaaaa");
  assert.equal(
    encodeDiagramId(new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff])),
    "7777777777",
  );
  const ids = new Set(Array.from({ length: 200 }, () => newDiagramId()));
  assert.equal(ids.size, 200);
  for (const id of ids) {
    assert.equal(id.length, 10);
    assert.match(id, DIAGRAM_ID_PATTERN);
    assert.ok(isDiagramId(id));
  }
  assert.equal(isDiagramId("ABCDEFGHIJ"), false);
  assert.equal(isDiagramId("abc"), false);
});

test("store creates a file with the documented shape", async () => {
  const diagram = await store.create("flowchart LR\n  A --> B", "mermaid");
  assert.equal(diagram.revision, 1);
  assert.equal(diagram.format, "mermaid");
  assert.match(diagram.id, DIAGRAM_ID_PATTERN);
  const raw = JSON.parse(await readFile(join(diagramDir(), `${diagram.id}.json`), "utf8"));
  assert.deepEqual(Object.keys(raw).sort(), [
    "createdAt",
    "format",
    "id",
    "revision",
    "source",
    "updatedAt",
  ]);
  assert.equal(raw.source, "flowchart LR\n  A --> B");
});

test("replace bumps the revision and survives a reload", async () => {
  const created = await store.create("flowchart LR\n  A --> B");
  const replaced = await store.replace(created.id, "flowchart LR\n  A --> C");
  assert.equal(replaced.revision, 2);
  assert.equal(replaced.createdAt, created.createdAt);
  assert.equal(store.get(created.id)?.source, "flowchart LR\n  A --> C");

  const reopened = new DiagramStore(diagramDir());
  await reopened.load();
  assert.equal(reopened.get(created.id)?.revision, 2);
  assert.equal(reopened.ref(created.id)?.revision, 2);
});

test("replace refuses an unknown id and oversize source is refused", async () => {
  await assert.rejects(
    () => store.replace("zzzzzzzzzz", "flowchart LR\n  A --> B"),
    (error: unknown) => error instanceof DiagramError && error.status === 404,
  );
  const big = "x".repeat(MAX_DIAGRAM_BYTES + 1);
  await assert.rejects(
    () => store.create(big),
    (error: unknown) =>
      error instanceof DiagramError && error.status === 413 && /20 kB/.test(error.message),
  );
  assert.equal(store.get("zzzzzzzzzz"), undefined);
});

test("the bundled Mermaid renderer draws SVG and explains bad source", () => {
  const valid = renderDiagram("flowchart LR\n  A[Draw] --> B[Revise]");
  assert.equal(valid.ok, true);
  if (valid.ok) {
    assert.match(valid.svg, /^<svg/);
    assert.match(valid.svg, /Draw/);
  }

  const invalid = renderDiagram("this is not a diagram");
  assert.equal(invalid.ok, false);
  if (!invalid.ok) assert.match(invalid.message, /No diagram type detected/i);
});

test("an SVG-looking Mermaid source is never returned verbatim", async () => {
  const malicious =
    '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><img src="x" onerror="document.title=\'pwned\'"></foreignObject></svg>';
  const diagram = await store.create(malicious);
  assert.equal(await store.svg(diagram), undefined);

  const safe = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>';
  assert.equal(safeSvgDocument(safe), safe);
  assert.equal(safeSvgDocument(malicious), undefined);
  assert.equal(safeSvgDocument("<svg><script>alert(1)</script></svg>"), undefined);
  assert.equal(safeSvgDocument('<svg><image href="javascript:alert(1)"/></svg>'), undefined);
  assert.equal(safeSvgDocument('<svg><a href="&#106;avascript:alert(1)">x</a></svg>'), undefined);
  assert.equal(safeSvgDocument('<svg><g onload="alert(1)"/></svg>'), undefined);

  const stored = await store.create(safe, "svg");
  assert.equal(await store.svg(stored), safe);
});

test("the server renders an SVG once and caches it beside the diagram", async () => {
  const diagram = await store.create("flowchart LR\n  A[Cached] --> B[Next]");
  const first = await store.svg(diagram);
  assert.equal(typeof first, "string");
  if (first === undefined) return;
  assert.match(first, /^<svg/);
  assert.match(first, /Cached/);

  const cacheName = (await readdir(diagramDir())).find(
    (name) => name.startsWith(`${diagram.id}.r1`) && name.endsWith(".svg"),
  );
  assert.ok(cacheName);
  assert.equal(await readFile(join(diagramDir(), cacheName), "utf8"), first);
  assert.equal(await store.svg(diagram), first);

  const replaced = await store.replace(diagram.id, "flowchart LR\n  A[Fresh] --> B[Next]");
  const next = await store.svg(replaced);
  assert.equal(typeof next, "string");
  if (next === undefined) return;
  assert.match(next, /Fresh/);
  assert.notEqual(next, first);
  assert.equal((await readdir(diagramDir())).includes(cacheName), false);
});

test("diagram tools draw, replace, and fail readably", async () => {
  const published: string[] = [];
  const tools = new Map(
    createDiagramTools({
      store,
      publish: (diagram) => published.push(diagram.id),
    }).map((tool) => [tool.name, tool]),
  );
  const call = (name: string, args: Record<string, unknown>) => {
    const tool = tools.get(name);
    assert.ok(tool);
    return tool.execute(args as never, {} as never, {} as never);
  };

  const drawn = await call("draw_diagram", {
    source: "flowchart LR\n  A --> B",
    title: "Flow",
  });
  const drawnText = textOf(drawn);
  assert.equal(drawnText.isError, false);
  const details = drawn.details as { diagram: { id: string; revision: number }; title: string };
  assert.match(details.diagram.id, DIAGRAM_ID_PATTERN);
  assert.equal(details.diagram.revision, 1);
  assert.equal(details.title, "Flow");
  assert.match(drawnText.text, new RegExp(`/api/diagrams/${details.diagram.id}`));

  const replaced = await call("replace_diagram", {
    id: details.diagram.id,
    source: "flowchart LR\n  A --> C",
  });
  assert.equal(textOf(replaced).isError, false);
  assert.equal((replaced.details as { diagram: { revision: number } }).diagram.revision, 2);

  const unknown = textOf(
    await call("replace_diagram", { id: "zzzzzzzzzz", source: "flowchart LR" }),
  );
  assert.equal(unknown.isError, true);
  assert.match(unknown.text, /Unknown diagram/);

  const oversize = textOf(
    await call("draw_diagram", { source: "x".repeat(MAX_DIAGRAM_BYTES + 1) }),
  );
  assert.equal(oversize.isError, true);
  assert.match(oversize.text, /20 kB/);
  assert.deepEqual(published, [details.diagram.id, details.diagram.id]);
});

function toolResult(id: number, toolName: string, details: unknown): EntryRecord {
  return {
    id,
    kind: ToolResultEntry.kind,
    model: [
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName,
        content: [{ type: "text", text: "saved" }],
        details,
        isError: false,
        timestamp: 1_700_000_000_000,
      },
    ],
  } as unknown as EntryRecord;
}

function toolCall(id: number, name: string): EntryRecord {
  return {
    id,
    kind: AssistantEntry.kind,
    model: [
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call-1", name, arguments: { source: "flowchart LR" } }],
        timestamp: 1_700_000_000_000,
      },
    ],
  } as unknown as EntryRecord;
}

test("a diagram message part survives the snapshot with only id and revision", () => {
  const id = "abcdefghij";
  const details = { diagram: { id, revision: 1 }, title: "Flow" };
  const built = buildTranscript(
    [toolCall(41, "draw_diagram"), toolResult(42, "draw_diagram", details)],
    undefined,
    (candidate) => (candidate === id ? 4 : undefined),
  );
  assert.equal(built.messages.length, 1);
  const message = built.messages[0];
  assert.equal(message.role, "assistant");
  assert.equal(message.text, "Flow");
  assert.deepEqual(message.parts, [{ kind: "diagram", diagram: { id, revision: 4 } }]);

  const snapshot = JSON.parse(JSON.stringify(windowTranscript(built))) as {
    messages: Array<{ parts?: unknown }>;
  };
  assert.deepEqual(snapshot.messages[0]?.parts, [
    { kind: "diagram", diagram: { id, revision: 4 } },
  ]);
  assert.equal(JSON.stringify(snapshot.messages).includes("flowchart"), false);
});

test("a replace result raises the revision without adding a second diagram bubble", () => {
  const id = "abcdefghij";
  const built = buildTranscript(
    [
      toolCall(41, "replace_diagram"),
      toolResult(42, "replace_diagram", { diagram: { id, revision: 2 } }),
    ],
    undefined,
    () => 2,
  );
  assert.equal(built.messages.length, 0);
  assert.equal(built.activity.length, 1);
});
