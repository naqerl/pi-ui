import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import type { Context } from "hono";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { OperatorNoticeRecord } from "../shared/notices.js";
import { MCP_EVENTS_HEAD } from "../shared/notices.js";
import { parseCompletion } from "../shared/tasks.js";
import type { TaskCompletion, TaskLedger, TaskStatus } from "../shared/types.js";
import { installBillionContextInline } from "./billion-context.js";
import { ChatService } from "./chat-service.js";
import { DashboardManager } from "./dashboard.js";
import type { DiagramBridge } from "./diagram-tools.js";
import { DiagramStore } from "./diagrams.js";
import { JobManager, jobNotice } from "./jobs.js";
import { McpEventFeed } from "./mcp-events.js";
import { MAX_MEDIA_BYTES, MediaError, MediaStore, parseAttachmentIds } from "./media.js";
import { composeInstructions, SnapshotCache, SnapshotController } from "./memory/snapshot.js";
import { MemoryStore } from "./memory/store.js";
import type { MemoryWriteRecord } from "./memory/tools.js";
import { createModelCatalog } from "./models.js";
import type { OperatorBridge } from "./operator-tools.js";
import { buildPiSystemPrompt } from "./pi.js";
import {
  closePush,
  configurePush,
  notify,
  pushPublicKey,
  pushStatus,
  subscribePush,
  unsubscribePush,
} from "./push.js";
import { type DurableSessionOptions, openDurableSession, SESSION_CONTEXT } from "./session.js";
import { StreamHub } from "./stream-hub.js";
import { TaskActivityTracker } from "./task-activity.js";
import type { TaskBridge } from "./task-tools.js";
import { TaskError, TaskStore } from "./tasks.js";
import { liveDataDirInTestError } from "./test-mode.js";
import { injectTheme, resolveTheme, themeManifest, writeThemeSlug } from "./themes.js";
import { windowRequestFromQuery } from "./transcript-window.js";
import { readAppVersion } from "./version-notice.js";

const here = dirname(fileURLToPath(import.meta.url));
const builtClientDir = resolve(here, "../client");
const fallbackClientDir = resolve(process.cwd(), "dist/client");
const clientDir = existsSync(resolve(builtClientDir, "index.html"))
  ? builtClientDir
  : fallbackClientDir;

const cwd = resolve(process.env.PI_CWD?.trim() || process.cwd());
const dataDir = resolve(cwd, process.env.DATA_DIR?.trim() || "data");
const testModeDataDirError = liveDataDirInTestError(dataDir);
if (testModeDataDirError !== null) {
  console.error(`pi-ui: ${testModeDataDirError}`);
  process.exit(1);
}
configurePush(dataDir);
const themeFile = resolve(dataDir, "theme.json");
const taskStore = new TaskStore(resolve(dataDir, "tasks.json"));
const media = new MediaStore(resolve(dataDir, "media"));
const diagrams = new DiagramStore(resolve(dataDir, "diagrams"));
await taskStore.load();
const taskActivity = new TaskActivityTracker(resolve(dataDir, "task-activity.json"));
await taskActivity.load();
taskActivity.observeLedger(taskStore.ledger().tasks);
/** The ledger as clients see it: tasks plus what the runs measured for them. */
function taskView(ledger: TaskLedger = taskStore.ledger()): TaskLedger {
  return { ...ledger, activity: taskActivity.view() };
}
await diagrams.load();
const taskBridge: TaskBridge = {
  store: taskStore,
  media,
  publish() {},
};
const operatorNotices: {
  current?: (record: OperatorNoticeRecord) => void | Promise<void>;
} = {};
const operatorBridge: OperatorBridge = {
  notify: (notification) => notify(notification),
  recordNotice: (record) => operatorNotices.current?.(record),
};
const diagramBridge: DiagramBridge = {
  store: diagrams,
  publish() {},
};
if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
  throw new Error(`PI_CWD is not a directory: ${cwd}`);
}
const jobs = new JobManager(dataDir, cwd);
await jobs.load();
const dashboardMinInterval = Number(process.env.PI_DASHBOARD_MIN_INTERVAL_MS);
const dashboard = new DashboardManager(dataDir, {
  ...(Number.isFinite(dashboardMinInterval) && dashboardMinInterval > 0
    ? { minIntervalMs: dashboardMinInterval }
    : {}),
});
await dashboard.load();

const port = Number(process.env.PORT || 8787);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  throw new Error(`Invalid PORT: ${process.env.PORT}`);
}

// Install billion-context before the durable harness exists, so the first
// provider request already goes through the in-process wire engine.
process.env.BILI_PI_INLINE ??= "1";
const bili = await installBillionContextInline({
  currentPath: resolve(cwd, process.env.DATA_DIR?.trim() || "data", "current.json"),
});

const catalog = await createModelCatalog();
const memory = new MemoryStore(resolve(dataDir, "memory"));
await memory.ensure();
const memorySnapshot = new SnapshotCache();
const memoryWrites: { current?: (record: MemoryWriteRecord) => void } = {};
const memoryBlock = await memorySnapshot.get(memory, "first_turn");
const baseInstructions = `${await buildPiSystemPrompt(cwd, catalog.runtime)}

Tasks are a shared todo ledger on the tasks page. You can list them with task_list, mark one done with task_done (with evidence a reviewer can check), and create a blocker for one with task_block. Every task needs human approval: write down work you think is worth doing with propose_task, and a human can approve it from the tasks page. A proposal is not a task and does not appear in task_list; use task_proposals to read the waiting proposals. A done blocker does not block. A task with an open subtask cannot be marked done. You cannot add a task that blocks nothing, reopen a task, or delete one. Every tool takes an optional piuiTaskId argument: when a call works on a task, set it to that task's id so the tasks page shows the task as being worked on and measures its time and cost; leave it out for work that is not part of a task.

Draw a diagram into the chat with draw_diagram (Mermaid source) and revise it later with replace_diagram and the id from the first result. The drawing is part of your reply; do not repeat its source in your text.

Long-running shell commands (builds, test suites, servers) can run in the background with job_start; list them with job_list, read their output with job_output, and stop one with job_cancel. When a job ends on its own you receive a message with its exit status and last output, so you do not need to poll.

The dashboard page (the Stats tab, left of chat) is yours to arrange for the user: dashboard_get shows it, dashboard_upsert adds or changes a widget (built-in pi-ui stats, a poll script that fetches JSON, or data you push with dashboard_push), dashboard_remove deletes one and dashboard_layout places them. Widgets only display data. Poll scripts read secrets from env; never put a token in a widget.`;
const instructions = composeInstructions(baseInstructions, memoryBlock);
const boot = await openDurableSession({
  cwd,
  models: catalog.runtime as unknown as DurableSessionOptions["models"],
  instructions,
  model:
    catalog.model === undefined
      ? undefined
      : { provider: catalog.model.provider, modelId: catalog.model.id },
  keepStoredModel: (ref) => catalog.runtime.getModel(ref.provider, ref.modelId) !== undefined,
  bili,
  tasks: taskBridge,
  jobs,
  dashboard,
  memory: {
    store: memory,
    snapshot: memorySnapshot,
    onWrite: (record) => memoryWrites.current?.(record),
  },
  diagrams: diagramBridge,
  operator: operatorBridge,
});
const activeModel =
  boot.model === undefined
    ? undefined
    : catalog.runtime.getModel(boot.model.provider, boot.model.modelId);
if (activeModel !== undefined) {
  bili.setModelMetadata({
    model: activeModel.id,
    contextWindow: activeModel.contextWindow,
    maxOutput: activeModel.maxTokens,
  });
  if (
    catalog.model === undefined ||
    catalog.model.provider !== activeModel.provider ||
    catalog.model.id !== activeModel.id
  ) {
    console.log(
      `[pi] model: ${activeModel.provider}/${activeModel.id} (kept from the conversation)`,
    );
  }
}
const memoryCheckpoints = new SnapshotController(
  memory,
  baseInstructions,
  async (next) => {
    await boot.conversation.configure({ instructions: next }, SESSION_CONTEXT);
  },
  memorySnapshot,
  instructions,
);
const hub = new StreamHub();
taskBridge.publish = (ledger) => {
  taskActivity.observeLedger(ledger.tasks);
  hub.broadcast({ event: "tasks", data: taskView(ledger) });
};
// Tool calls arrive in bursts; one refresh per half second keeps the tasks page live enough.
let activityTimer: NodeJS.Timeout | undefined;
taskActivity.onChange(() => {
  if (activityTimer !== undefined) return;
  activityTimer = setTimeout(() => {
    activityTimer = undefined;
    hub.broadcast({ event: "tasks", data: taskView() });
  }, 500);
  activityTimer.unref?.();
});
diagramBridge.publish = (diagram) => {
  hub.broadcast({ event: "diagram", data: { id: diagram.id, revision: diagram.revision } });
};
const chat = new ChatService(
  boot.harness,
  boot.conversation,
  hub,
  activeModel?.contextWindow,
  boot.interrupted,
  boot.runMarkerStore,
  boot.runMarker,
  () => boot.mcp.status,
  catalog.runtime,
  activeModel,
  bili,
  media,
  async (reason) => {
    await memoryCheckpoints.refresh(reason);
  },
  (id) => diagrams.ref(id)?.revision,
  () => taskStore.ledger().tasks,
  dataDir,
);
operatorNotices.current = (record) => chat.recordOperatorNotice(record);
memoryWrites.current = (record) => {
  void chat.recordMemoryWrite(record).catch((error: unknown) => {
    console.error("[pi] memory write notice failed", error);
  });
};
const events = new McpEventFeed(boot.mcp.subscriptionRegistry);
await events.hydrate();
chat.setEventFeed(events);
chat.setTaskActivity(taskActivity);
boot.mcp.setObserver((notice) => {
  const previous = events.state;
  const changed = events.ingest(notice);
  // A protocol connection can clear a boot failure, so keep the live status
  // in every tab instead of leaving the snapshot from startup on screen.
  hub.broadcast({ event: "mcp.status", data: boot.mcp.status });
  if (events.state.revision !== previous.revision) {
    // A replay can change the visible log without being news, so broadcast
    // any state change but only submit a turn when `changed` says it is new.
    hub.broadcast({ event: "mcp.events", data: events.state });
  }
  if (!changed) {
    // A pure replay has no chat notice. Do not submit its extension message,
    // or it would wake the model for history that was already announced.
    return notice.customType === "mcp-events" ? false : undefined;
  }
  return undefined;
});
await chat.start();
function builtinJobs() {
  return jobs.list().map((job) => ({
    id: job.id,
    name: job.name,
    status: job.status,
    exitCode: job.exitCode,
    startedAt: job.startedAt,
    endedAt: job.endedAt,
  }));
}
function builtinSession() {
  const model = chat.currentModel();
  return {
    conversationId: String(boot.conversation.id),
    model: model === null ? null : `${model.provider}/${model.id}`,
    run: chat.getRunStatus().state,
  };
}
dashboard.setHost({
  async builtinInputs() {
    const stats = await chat.statsSnapshot();
    return {
      usage: stats.usage,
      context: stats.context,
      mcp: stats.mcp,
      mcpEvents: chat.mcpEventsState(),
      jobs: builtinJobs(),
      session: builtinSession(),
    };
  },
  builtinsLite: () => ({ jobs: builtinJobs(), session: builtinSession() }),
  notify(text) {
    void chat.submit(text, "queue").catch((error: unknown) => {
      console.error("[pi] dashboard message failed", error);
    });
  },
  broadcast(state) {
    hub.broadcast({ event: "dashboard", data: state });
  },
});
jobs.onChange(() => dashboard.broadcast());
jobs.setNotifier((job, tail) => {
  void chat.submitJobNotice(jobNotice(job, tail)).catch((error: unknown) => {
    console.error(`[pi] background job ${job.id} message failed`, error);
  });
});
jobs.setQuietNotifier((job, tail) => {
  void chat.recordNotice(jobNotice(job, tail)).catch((error: unknown) => {
    console.error(`[pi] background job ${job.id} notice failed`, error);
  });
});
boot.mcp.setSubmit((text, options) => {
  const deliverAs = options.deliverAs === "steer" ? "steer" : "queue";
  const submission = text.startsWith(MCP_EVENTS_HEAD)
    ? chat.submitMcpEventNotice(text, options.deliverAs)
    : chat.submit(text, deliverAs);
  void submission.catch((error: unknown) => {
    console.error("[pi] MCP event message failed", error);
  });
});

void bili
  .registerIdentity(String(boot.conversation.id))
  .then((registered) => {
    if (registered) {
      console.log(`billion-context: registered conversation ${boot.conversation.id}`);
    }
  })
  .catch((error: unknown) => {
    console.warn(`billion-context: identity registration failed: ${String(error)}`);
  });

const app = new Hono();

app.get("/api/health", async (c) => c.json({ ok: true, version: await readAppVersion() }));

app.get("/api/push/key", async (c) => c.json({ key: await pushPublicKey() }));

app.post("/api/push/subscribe", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.text("Expected a JSON body", 400);
  }
  const record = await subscribePush(body);
  if (record === null) return c.text("endpoint and keys are required", 400);
  return c.json({ ok: true });
});

app.delete("/api/push/subscribe", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.text("Expected a JSON body", 400);
  }
  const endpoint =
    typeof body === "object" &&
    body !== null &&
    "endpoint" in body &&
    typeof body.endpoint === "string"
      ? body.endpoint.trim()
      : "";
  if (endpoint.length === 0) return c.text("endpoint is required", 400);
  await unsubscribePush(endpoint);
  return c.json({ ok: true });
});

app.get("/api/push/status", async (c) => c.json(await pushStatus()));

app.get("/api/themes", async (c) => c.json((await resolveTheme(themeFile)).themes));

app.get("/api/models", async (c) => c.json(await chat.modelsView()));

app.post("/api/model", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.text("Expected a JSON body", 400);
  }
  const provider =
    typeof body === "object" &&
    body !== null &&
    "provider" in body &&
    typeof body.provider === "string"
      ? body.provider.trim()
      : "";
  const id =
    typeof body === "object" && body !== null && "id" in body && typeof body.id === "string"
      ? body.id.trim()
      : "";
  if (provider.length === 0 || id.length === 0) return c.text("provider and id are required", 400);
  try {
    const selected = await chat.setModel(provider, id);
    if (selected === undefined) return c.text("Unknown model", 404);
    return c.json(selected);
  } catch (error) {
    console.error("[pi] model switch failed", error);
    return c.text("Could not switch model", 500);
  }
});

app.post("/api/theme", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.text("Expected a JSON body", 400);
  }
  const slug =
    typeof body === "object" && body !== null && "slug" in body && typeof body.slug === "string"
      ? body.slug
      : "";
  const { themes } = await resolveTheme(themeFile);
  const theme = themes.themes.find((item) => item.slug === slug);
  if (theme === undefined) return c.text("Unknown theme", 404);
  await writeThemeSlug(themeFile, theme.slug);
  const data = { slug: theme.slug, colors: theme.colors };
  hub.broadcast({ event: "theme", data });
  return c.json(data);
});

app.get("/api/state", async (c) =>
  c.json({
    ...(await chat.getSnapshot(windowRequestFromQuery(c.req.query()))),
    tasks: taskView(),
  }),
);

const MCP_SUBSCRIPTIONS_PATH = "/api/mcp/subscriptions/";

function stableIdFromPath(path: string): string {
  const raw = path.startsWith(MCP_SUBSCRIPTIONS_PATH)
    ? path.slice(MCP_SUBSCRIPTIONS_PATH.length)
    : "";
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

app.delete("/api/mcp/subscriptions/*", async (c) => {
  const stableId = stableIdFromPath(c.req.path);
  if (stableId.length === 0) return c.text("stableId is required", 400);
  const live = events.findByStableId(stableId);
  const liveIds = events.adapterIdsForStableId(stableId);
  const cancelled = await boot.mcp.cancelSubscription(stableId, liveIds);
  events.cancel(stableId);
  if (cancelled === null && live === undefined) {
    return c.text("Unknown subscription", 404);
  }
  hub.broadcast({ event: "mcp.events", data: events.state });
  return c.json({
    ok: true,
    stableId,
    cancelled: true,
    id: events.findByStableId(stableId)?.id ?? null,
  });
});

app.get("/api/history", async (c) => {
  const request = windowRequestFromQuery(c.req.query());
  if (request.before === undefined) return c.text("before is required", 400);
  return c.json(await chat.getHistory(request));
});

app.get("/api/tasks", (c) => c.json(taskView()));

app.get("/api/dashboard", (c) => c.json(dashboard.state()));

app.delete("/api/dashboard/widgets/:id", async (c) => {
  try {
    await dashboard.remove(c.req.param("id"));
    return c.json(dashboard.state());
  } catch (error) {
    return c.text(error instanceof Error ? error.message : String(error), 404);
  }
});

app.post("/api/dashboard/viewer", async (c) => {
  let body: unknown;
  try {
    // sendBeacon posts text/plain, so parse the raw text.
    body = JSON.parse(await c.req.text());
  } catch {
    return c.text("Expected a JSON body", 400);
  }
  const viewer =
    typeof body === "object" && body !== null && "viewer" in body && typeof body.viewer === "string"
      ? body.viewer.trim().slice(0, 80)
      : "";
  const visible =
    typeof body === "object" && body !== null && "visible" in body && body.visible === true;
  if (viewer.length === 0) return c.text("viewer is required", 400);
  dashboard.setViewer(viewer, visible);
  return c.json({ polling: dashboard.polling() });
});

function publishTasks(ledger: TaskLedger) {
  taskBridge.publish(ledger);
  return taskView(ledger);
}

function taskFailure(c: Context, error: unknown) {
  if (error instanceof TaskError) return c.text(error.message, error.status as 400);
  if (error instanceof MediaError)
    return c.text(error.message, error.status === 404 ? 400 : error.status);
  console.error("[pi] tasks failed", error);
  return c.text("Could not update tasks", 500);
}

app.post("/api/tasks", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.text("Expected a JSON body", 400);
  }
  const title =
    typeof body === "object" && body !== null && "title" in body && typeof body.title === "string"
      ? body.title
      : "";
  const parentId =
    typeof body === "object" && body !== null && "parentId" in body ? body.parentId : null;
  if (parentId !== null && typeof parentId !== "string")
    return c.text("parentId must be a string", 400);
  const proposed =
    typeof body === "object" && body !== null && "propose" in body && body.propose === true;
  const rationale =
    typeof body === "object" &&
    body !== null &&
    "rationale" in body &&
    typeof body.rationale === "string"
      ? body.rationale
      : "";
  try {
    const attachments = parseAttachmentIds(
      media,
      typeof body === "object" && body !== null && "attachments" in body
        ? body.attachments
        : undefined,
    );
    for (const id of attachments) await media.read(id);
    if (proposed) {
      return c.json(publishTasks(await taskStore.propose(title, rationale, attachments)), 201);
    }
    return c.json(publishTasks(await taskStore.create(title, parentId, attachments)), 201);
  } catch (error) {
    return taskFailure(c, error);
  }
});

app.patch("/api/tasks/:id", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.text("Expected a JSON body", 400);
  }
  if (typeof body !== "object" || body === null) return c.text("Expected a JSON body", 400);
  const patch: { status?: TaskStatus; blockedBy?: string[]; completion?: TaskCompletion } = {};
  if ("status" in body) {
    if (body.status !== "open" && body.status !== "done" && body.status !== "proposed") {
      return c.text('Status must be "open", "done" or "proposed"', 400);
    }
    patch.status = body.status;
  }
  // Evidence is optional here: a human ticking a task off may have nothing to point at.
  if ("completion" in body && body.completion !== null && body.completion !== undefined) {
    if (patch.status !== "done") return c.text('completion requires status "done"', 400);
    const parsed = parseCompletion(body.completion);
    if (!parsed.ok) return c.text(parsed.error, 400);
    patch.completion = parsed.completion;
  }
  if ("blockedBy" in body) {
    if (!Array.isArray(body.blockedBy)) return c.text("blockedBy must be a list of task ids", 400);
    patch.blockedBy = body.blockedBy.filter((id): id is string => typeof id === "string");
    if (patch.blockedBy.length !== body.blockedBy.length) {
      return c.text("blockedBy must be a list of task ids", 400);
    }
  }
  try {
    return c.json(publishTasks(await taskStore.update(c.req.param("id"), patch)));
  } catch (error) {
    return taskFailure(c, error);
  }
});

app.delete("/api/tasks/:id", async (c) => {
  try {
    return c.json(publishTasks(await taskStore.remove(c.req.param("id"))));
  } catch (error) {
    return taskFailure(c, error);
  }
});

app.post("/api/message", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.text("Expected a JSON body", 400);
  }
  const text =
    typeof body === "object" && body !== null && "text" in body && typeof body.text === "string"
      ? body.text.trim()
      : "";
  let attachments: string[];
  try {
    attachments = parseAttachmentIds(
      media,
      typeof body === "object" && body !== null && "attachments" in body
        ? body.attachments
        : undefined,
    );
  } catch (error) {
    if (error instanceof MediaError) return c.text(error.message, error.status as 400);
    throw error;
  }
  if (text.length === 0 && attachments.length === 0) {
    return c.text("Message text is required", 400);
  }
  const rawMode =
    typeof body === "object" && body !== null && "mode" in body ? body.mode : undefined;
  if (rawMode !== undefined && rawMode !== "queue" && rawMode !== "steer") {
    return c.text('Mode must be "queue" or "steer"', 400);
  }
  const mode = rawMode === "steer" ? "steer" : "queue";

  try {
    return c.json(await chat.submit(text, mode, { attachments }), 202);
  } catch (error) {
    if (error instanceof MediaError)
      return c.text(error.status === 404 ? "Unknown attachment" : error.message, 400);
    throw error;
  }
});

app.post("/api/media", async (c) => {
  const mimeType = (c.req.header("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  const declared = Number(c.req.header("content-length") ?? "0");
  if (declared > MAX_MEDIA_BYTES) return c.text("An image can be at most 10 MB", 413);
  try {
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    return c.json(await media.save(bytes, mimeType), 201);
  } catch (error) {
    if (error instanceof MediaError) return c.text(error.message, error.status);
    throw error;
  }
});

app.get("/api/diagrams/:id", async (c) => {
  const diagram = diagrams.get(c.req.param("id"));
  if (diagram === undefined) return c.notFound();
  const svg = await diagrams.svg(diagram);
  return c.json({ ...diagram, ...(svg === undefined ? {} : { svg }) }, 200, {
    "Cache-Control": "no-store",
  });
});

app.get("/api/media/:id", async (c) => {
  try {
    const { bytes, mimeType } = await media.read(c.req.param("id"));
    return c.body(new Uint8Array(bytes), 200, {
      "Content-Type": mimeType,
      "Cache-Control": "private, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
    });
  } catch (error) {
    if (error instanceof MediaError) return c.notFound();
    throw error;
  }
});

app.post("/api/queue/:id", async (c) => {
  const id = c.req.param("id");
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.text("Expected a JSON body", 400);
  }
  const action =
    typeof body === "object" && body !== null && "action" in body ? body.action : undefined;
  if (action === "cancel") {
    const ok = await chat.cancelQueued(id);
    if (!ok) return c.notFound();
    return c.json({ ok: true, queue: (await chat.getSnapshot()).queue });
  }
  if (action === "steer") {
    const result = await chat.steerQueued(id);
    if (result === null) return c.notFound();
    return c.json(result, 202);
  }
  return c.text('Action must be "cancel" or "steer"', 400);
});

// Takes back a steer the run has not reached yet; a delivered one is in the transcript and stays.
app.post("/api/steer/:id", async (c) => {
  const id = c.req.param("id");
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.text("Expected a JSON body", 400);
  }
  const action =
    typeof body === "object" && body !== null && "action" in body ? body.action : undefined;
  if (action !== "unsend") return c.text('Action must be "unsend"', 400);
  const steer = await chat.unsendSteer(id);
  if (steer === null) return c.text("The steer was already delivered", 409);
  return c.json({ ok: true, steer, steers: chat.getRunStatus().steers ?? [] });
});

app.post("/api/stop", async (c) => {
  await chat.stop();
  return c.json({ ok: true, queue: (await chat.getSnapshot()).queue });
});

app.get("/api/stream", (c) => {
  return streamSSE(c, async (stream) => {
    let tail = Promise.resolve();
    const enqueue = (write: () => Promise<unknown>): Promise<void> => {
      const run = tail.then(write).then(() => undefined);
      tail = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    };
    const client = {
      send: (frame: { event: string; data: unknown }) =>
        enqueue(() => stream.writeSSE({ event: frame.event, data: JSON.stringify(frame.data) })),
    };
    hub.add(client);

    const heartbeat = setInterval(() => {
      void enqueue(() => stream.write(": heartbeat\n\n"));
    }, 20_000);

    const closed = new Promise<void>((resolveClosed) => {
      stream.onAbort(resolveClosed);
      if (c.req.raw.signal.aborted) {
        resolveClosed();
      } else {
        c.req.raw.signal.addEventListener("abort", () => resolveClosed(), { once: true });
      }
    });

    try {
      try {
        const { active } = await resolveTheme(themeFile);
        if (active !== null) {
          await client.send({ event: "theme", data: { slug: active.slug, colors: active.colors } });
        }
      } catch (error) {
        console.error("[pi] theme snapshot failed", error);
      }
      await client.send({ event: "run.state", data: chat.getRunStatus() });
      await client.send({ event: "tasks", data: taskView() });
      await client.send({ event: "dashboard", data: dashboard.state() });
      const currentModel = chat.currentModel();
      if (currentModel !== null) {
        await client.send({ event: "model", data: currentModel });
      }
      for (const frame of chat.replayFrames()) {
        await client.send(frame);
      }
      await closed;
    } finally {
      clearInterval(heartbeat);
      hub.remove(client);
    }
  });
});

function sharedText(title: string, text: string, url: string): string {
  const body = text.trim() || title.trim();
  const link = url.trim();
  if (body.length > 0 && link.length > 0) {
    return body.includes(link) ? body : `${body}\n${link}`;
  }
  return body || link;
}

async function submitShared(c: Context, title: string, text: string, url: string) {
  const message = sharedText(title, text, url);
  if (message.length === 0) return c.redirect("/", 303);
  await chat.submit(message);
  return c.redirect("/", 303);
}

app.post("/share", async (c) => {
  const body = await c.req.parseBody();
  return submitShared(
    c,
    typeof body.title === "string" ? body.title : "",
    typeof body.text === "string" ? body.text : "",
    typeof body.url === "string" ? body.url : "",
  );
});

app.get("/share", async (c) => {
  return submitShared(
    c,
    c.req.query("title") ?? "",
    c.req.query("text") ?? "",
    c.req.query("url") ?? "",
  );
});

const indexPath = resolve(clientDir, "index.html");
const serveIndex = async (c: Context) => {
  try {
    let html = await readFile(indexPath, "utf8");
    try {
      const { active } = await resolveTheme(themeFile);
      html = injectTheme(html, active);
    } catch (error) {
      console.error("[pi] theme injection failed", error);
    }
    return c.body(html, 200, {
      "Content-Type": "text/html; charset=UTF-8",
      "Cache-Control": "no-cache",
    });
  } catch {
    return c.text("Client build not found. Run `npm run build` before starting the server.", 503);
  }
};

app.get("/", serveIndex);
app.get("/activity", serveIndex);
app.get("/activity/", serveIndex);
app.get("/events", serveIndex);
app.get("/events/", serveIndex);

app.get("/manifest.webmanifest", async (c) => {
  try {
    let manifest = await readFile(resolve(clientDir, "manifest.webmanifest"), "utf8");
    try {
      manifest = themeManifest(manifest, (await resolveTheme(themeFile)).active);
    } catch (error) {
      console.error("[pi] manifest theme failed", error);
    }
    return c.body(manifest, 200, {
      "Content-Type": "application/manifest+json",
      "Cache-Control": "no-cache",
    });
  } catch {
    return c.notFound();
  }
});

app.get("/sw.js", async (c) => {
  try {
    const worker = await readFile(resolve(clientDir, "sw.js"), "utf8");
    return c.body(worker, 200, {
      "Content-Type": "text/javascript; charset=UTF-8",
      "Cache-Control": "no-cache",
    });
  } catch {
    return c.notFound();
  }
});

app.use("/*", serveStatic({ root: clientDir }));

const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`pi-ui listening on http://localhost:${info.port}`);
  console.log(`working directory: ${cwd}`);
  console.log(`storage: ${boot.databasePath}`);
  console.log(`conversation: ${boot.conversation.id} (${boot.resumed ? "resumed" : "new"})`);
  console.log(`conversation file: ${boot.currentPath}`);
  if (boot.interrupted) {
    console.log(
      boot.runMarker === undefined || boot.runMarker.stopRequested
        ? "previous run was interrupted; partial output was kept"
        : "previous run was interrupted; resuming the turn with pi-durable",
    );
  }
  const toolParts = [
    "read",
    "bash",
    "edit",
    "write",
    ...boot.taskTools,
    ...boot.jobTools,
    ...boot.dashboardTools,
    ...boot.memoryTools,
    ...boot.diagramTools,
    ...boot.operatorTools,
  ];
  if (boot.mcp.toolNames.length > 0) {
    toolParts.push(`${boot.mcp.toolNames.length} MCP tools (${boot.mcp.serverNames.join(", ")})`);
  }
  if (boot.biliTools.length > 0) {
    toolParts.push(`${boot.biliTools.length} billion-context tools (${boot.biliTools.join(", ")})`);
  }
  console.log(`tools: ${toolParts.join(" + ")}`);
});

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  chat.beginShutdown();
  await taskActivity.flush().catch((error: unknown) => {
    console.error("[pi] could not save task activity", error);
  });
  dashboard.dispose();
  try {
    await dashboard.flush();
    await chat.close();
    await boot.mcp.close();
    await boot.harness.close(SESSION_CONTEXT);
    await closePush();
  } catch (error) {
    console.error("[pi] shutdown failed", error);
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2_000).unref();
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
