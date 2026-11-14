import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import type { Context } from "hono";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { OperatorNoticeRecord, TaskDecisionNoticeRecord } from "../shared/notices.js";
import { boundMcpEventBatch, isMcpNotice } from "../shared/notices.js";
import { PAGE_IDS, PAGE_PATHS } from "../shared/pages.js";
import {
  isActiveStatus,
  parseCompletion,
  parseReleaseReason,
  parseReopenReason,
  TASK_ATTACHMENTS_MAX,
  TASK_BODY_MAX_LENGTH,
} from "../shared/tasks.js";
import type { TaskCompletion, TaskLedger, TaskStatus } from "../shared/types.js";
import { installBillionContextInline } from "./billion-context.js";
import {
  ChatService,
  mcpDeliveryTexts,
  mcpEventEnvelope,
  mcpRestoreDeliveryTexts,
} from "./chat-service.js";
import { DashboardError, DashboardManager } from "./dashboard.js";
import { DelegateManager } from "./delegates.js";
import type { DiagramBridge } from "./diagram-tools.js";
import { DiagramStore } from "./diagrams.js";
import { JobError, JobManager, jobNotice } from "./jobs.js";
import { McpEventFeed } from "./mcp-events.js";
import { McpIntake, McpOutbox } from "./mcp-outbox.js";
import { acceptMcpStatusNotice } from "./mcp-status-intake.js";
import {
  MAX_MEDIA_BYTES,
  MediaError,
  MediaStore,
  parseAttachmentIds,
  validateAttachmentIds,
} from "./media.js";
import { composeInstructions, SnapshotCache, SnapshotController } from "./memory/snapshot.js";
import { MemoryStore } from "./memory/store.js";
import type { MemoryWriteRecord } from "./memory/tools.js";
import { createModelCatalog } from "./models.js";
import type { OperatorBridge } from "./operator-tools.js";
import { buildPiSystemPrompt } from "./pi.js";
import {
  clearPushSink,
  closePush,
  configurePush,
  e2ePushSinkEnabled,
  notify,
  pushPublicKey,
  pushStatus,
  readPushSink,
  subscribePush,
  unsubscribePush,
} from "./push.js";
import { type DurableSessionOptions, openDurableSession, SESSION_CONTEXT } from "./session.js";
import { StreamHub } from "./stream-hub.js";
import { TaskActivityTracker } from "./task-activity.js";
import { TaskAgentError, TaskAgentManager, type TaskAgentSession } from "./task-agent.js";
import type { TaskBridge } from "./task-tools.js";
import { TaskError, TaskStore, taskDurationStats, taskReopenStats } from "./tasks.js";
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
const operatorNotices: {
  current?: (record: OperatorNoticeRecord) => void | Promise<void>;
} = {};
const taskNotices: {
  current?: (record: TaskDecisionNoticeRecord) => void | Promise<void>;
} = {};
const taskStore = new TaskStore(resolve(dataDir, "tasks.json"), {
  notice: (record) => taskNotices.current?.(record),
});
const media = new MediaStore(resolve(dataDir, "media"));
const diagrams = new DiagramStore(resolve(dataDir, "diagrams"));
await taskStore.load();
const taskActivity = new TaskActivityTracker(
  resolve(dataDir, "task-activity.json"),
  Date.now,
  (taskId, at) => {
    void taskStore.noteWorked(taskId, at).catch((error: unknown) => {
      console.error(`[pi] could not record work on task ${taskId}:`, error);
    });
  },
);
await taskActivity.load();
taskActivity.observeLedger(taskStore.ledger().tasks);
/** Filled once the task-agent manager exists; before that no plan run can be live. */
let planningTaskIds = (): string[] => [];
/** The ledger as clients see it: tasks plus what the runs measured and planned for them. */
function taskView(ledger: TaskLedger = taskStore.ledger()): TaskLedger {
  const planning = planningTaskIds();
  const live = new Set(planning);
  return {
    ...ledger,
    planning,
    tasks: ledger.tasks.map((task) => ({
      ...task,
      planning: live.has(task.id) && (isActiveStatus(task.status) || task.status === "planning"),
    })),
    activity: taskActivity.view(),
    reopenStats: taskReopenStats(ledger.tasks),
  };
}
await diagrams.load();
const taskBridge: TaskBridge = {
  store: taskStore,
  media,
  publish() {},
};
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
const delegates = new DelegateManager({
  dataDir,
  cwd,
  models: catalog.runtime,
  model: catalog.model,
});
await delegates.load();
const memory = new MemoryStore(resolve(dataDir, "memory"));
await memory.ensure();
const memorySnapshot = new SnapshotCache();
const memoryWrites: { current?: (record: MemoryWriteRecord) => void | Promise<void> } = {};
const memoryBlock = await memorySnapshot.get(memory, "first_turn");
const baseInstructions = `${await buildPiSystemPrompt(cwd, catalog.runtime)}

Tasks are a shared todo ledger on the tasks page. You can list them with task_list, mark one done with task_done (with evidence a reviewer can check), reopen a done task with task_reopen when the operator says it is still wrong, edit a title, body or project with task_edit, and create a blocker for one with task_block. Every task needs human approval: write down work you think is worth doing with propose_task, and a human can approve it from the tasks page. A proposal is not a task and does not appear in task_list; use task_proposals to read the waiting proposals. A done blocker does not block. A task with an open subtask cannot be marked done. You cannot add a task that blocks nothing or delete one. Keep the task you are doing in the working state with task_working: while exactly one task is working, the tools you call are measured against its time and cost. If no task or several tasks are working, calls are not charged to any task. When the work is parked — queued, scheduled or waiting on another task — or when a working claim turns out to be wrong, release it with task_release and a reason; never use a release as a way to stop tracking real work. A released task is open again and no longer counts as working.

Draw a diagram into the chat with draw_diagram (Mermaid source) and revise it later with replace_diagram and the id from the first result. If a diagram fails to parse, fix it in place with edit_diagram and the id it already has instead of redrawing the whole body. The drawing is part of your reply; do not repeat its source in your text.

Long-running shell commands (builds, test suites, servers) can run in the background with job_start; list them with job_list, read their output with job_output, and stop one with job_cancel. When a job ends on its own you receive a message with its exit status and last output, so you do not need to poll.

For a self-contained investigation, review or implementation that should not use this conversation's context, hand it to a sub-agent with acp_delegate (roles: reviewer, researcher, worker, planner, oracle). It runs in a clean context and writes its answer to a result file; acp_delegate_wait blocks for the result, acp_delegate_cancel stops a run, and a finished run also sends one notice chip. Give a delegate every path, goal and constraint it needs because it cannot see this chat.

The dashboard page (the Stats tab, left of chat) is yours to arrange for the user: dashboard_get shows it, dashboard_upsert adds or changes a widget (built-in pi-ui stats, a poll script that fetches JSON, or data you push with dashboard_push), dashboard_remove deletes one and dashboard_layout places them. Widgets only display data. Poll scripts read secrets from env; never put a token in a widget.`;
const instructions = composeInstructions(baseInstructions, memoryBlock);
const taskAgentPrompt = buildPiSystemPrompt(cwd, catalog.runtime, ["read", "bash"]);
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
  delegates,
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
/** The browser suite may read the live instructions and drive a memory checkpoint. */
const e2eMemoryHook = process.env.PI_E2E_DATA_DIR !== undefined;
const hub = new StreamHub();
taskBridge.publish = (ledger) => {
  taskActivity.observeLedger(ledger.tasks);
  hub.broadcast({ event: "tasks", data: taskView(ledger) });
  dashboard.broadcast();
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
  () => {
    const activity = taskActivity.view();
    return taskStore.ledger().tasks.map((task) => {
      if (task.status !== "open") return task;
      const outcome = activity.traces[task.id]?.lastRun?.outcome;
      return outcome === "running" || outcome === "ok"
        ? { ...task, status: "working" as const }
        : task;
    });
  },
  dataDir,
  boot.repairDurableState,
);
operatorNotices.current = (record) => chat.recordOperatorNotice(record);
taskNotices.current = (record) => chat.recordTaskDecision(record);
memoryWrites.current = (record) =>
  chat.recordMemoryWrite(record).catch((error: unknown) => {
    console.error("[pi] memory write notice failed", error);
  });
const events = new McpEventFeed(boot.mcp.subscriptionRegistry, {
  startedAt: boot.mcp.startedAt,
});
await events.hydrate();
chat.setEventFeed(events);
chat.setTaskActivity(taskActivity);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
let forgetMcpGeneration: ((stableId: string) => void) | undefined;
const drainGenerationClears = (): void => {
  if (forgetMcpGeneration === undefined) return;
  for (const stableId of events.takeGenerationClears()) forgetMcpGeneration(stableId);
};
const generationRefreshes = new Map<string, Promise<void>>();
/** An adapter reconnect can reuse its protocol session; refresh before its events. */
const refreshGeneration = (server: string): Promise<void> => {
  const existing = generationRefreshes.get(server);
  if (existing !== undefined) return existing;
  const run = (async () => {
    const generation = await boot.mcp.generationFor(server);
    if (generation === undefined) return;
    const previous = events.state;
    events.ingest({
      customType: "mcp-events-generation",
      details: { server, generation },
    });
    drainGenerationClears();
    if (events.state.revision !== previous.revision) {
      hub.broadcast({ event: "mcp.events", data: events.state });
    }
  })().catch((error: unknown) => {
    console.warn(`[mcp] could not refresh generation for ${server}`, error);
  });
  generationRefreshes.set(server, run);
  void run.finally(() => {
    if (generationRefreshes.get(server) === run) generationRefreshes.delete(server);
  });
  return run;
};
const refreshGenerationForStatus = (notice: { customType?: string; details?: unknown }): void => {
  if (
    notice.customType !== "mcp-events-status" ||
    !isRecord(notice.details) ||
    !Array.isArray(notice.details.subscriptions)
  ) {
    return;
  }
  const servers = new Set<string>();
  for (const item of notice.details.subscriptions) {
    if (!isRecord(item) || typeof item.server !== "string") continue;
    if (item.status !== "reconnecting" && item.status !== "active") continue;
    servers.add(item.server);
  }
  for (const server of servers) void refreshGeneration(server);
};
boot.mcp.setObserver((notice) => {
  // Event batches cross the durable outbox boundary in the message sink below.
  // Never advance delivered IDs/cursors before their retryable text is on disk.
  if (notice.customType === "mcp-events") return;
  const previous = events.state;
  const changed = events.ingest(notice);
  drainGenerationClears();
  refreshGenerationForStatus(notice);
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
const taskAgents = new TaskAgentManager({
  dataDir,
  cwd,
  models: catalog.runtime,
  model: catalog.model,
  media,
  store: taskStore,
  publish: (ledger) => {
    taskBridge.publish(ledger);
  },
  relay: (taskId, frame) => {
    hub.broadcast({ event: "task.chat", data: { taskId, event: frame.event, data: frame.data } });
  },
  onRunState: () => {
    hub.broadcast({ event: "tasks", data: taskView() });
  },
  baseInstructions: await taskAgentPrompt,
  memory: { store: memory, snapshot: memorySnapshot },
});
planningTaskIds = () => taskAgents.planningTaskIds();
function builtinJobs() {
  return jobs.list().map((job) => ({
    id: job.id,
    name: job.name,
    status: job.status,
    exitCode: job.exitCode,
    startedAt: job.startedAt,
    endedAt: job.endedAt,
    command: job.command,
    cwd: job.cwd,
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
      taskReopens: taskReopenStats(taskStore.ledger().tasks),
      taskDurations: taskDurationStats(taskStore.ledger().tasks),
    };
  },
  builtinsLite: () => ({
    jobs: builtinJobs(),
    session: builtinSession(),
    taskReopens: taskReopenStats(taskStore.ledger().tasks),
    taskDurations: taskDurationStats(taskStore.ledger().tasks),
  }),
  notify(text) {
    void chat.submit(text, "queue").catch((error: unknown) => {
      console.error("[pi] dashboard message failed", error);
    });
  },
  broadcast(state) {
    hub.broadcast({ event: "dashboard", data: state });
  },
});
jobs.onChange(() => {
  dashboard.broadcast();
  hub.broadcast({ event: "jobs", data: builtinJobs() });
});
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
delegates.setNotifier((text) => chat.submitDelegateNotice(text));
delegates.onChange(() => hub.broadcast({ event: "delegates", data: delegates.list() }));
const mcpOutbox = new McpOutbox(resolve(dataDir, "mcp-outbox.json"), (item) =>
  chat.submitMcpDelivery(item),
);
await mcpOutbox.load();
forgetMcpGeneration = (stableId) => {
  void mcpOutbox.forgetStable(stableId).catch((error: unknown) => {
    console.error(`[mcp] could not clear stale generation for ${stableId}`, error);
  });
};
drainGenerationClears();
const mcpIntake = new McpIntake();
boot.mcp.setSubmit((text, options) => {
  const envelope = mcpEventEnvelope(text);
  if (envelope !== null) {
    mcpIntake.enqueue(async () => {
      // A reconnect status may have started a generation read. Let it finish
      // before judging novelty, so the renumbered first event uses the new key.
      const eventServers = new Set<string>();
      for (const item of envelope.items) {
        if (isRecord(item) && typeof item.server === "string") eventServers.add(item.server);
      }
      const refreshes = [...eventServers].flatMap((server) => {
        const pending = generationRefreshes.get(server);
        return pending === undefined ? [] : [pending];
      });
      if (refreshes.length > 0) await Promise.all(refreshes);
      // A stream can hand over its adapter's retained history, and a subscribe
      // can hand us a retained history. Age first, then bound: an old sibling
      // must not occupy a slot or evict a fresh event. The feed applies the same
      // gate again when it ingests the original batch, so its gap count matches.
      const aged = events.filterStaleEvents(envelope.items, false);
      const batch = boundMcpEventBatch(aged.items);
      const dropped = envelope.dropped + aged.dropped + batch.dropped;
      const novel = events
        .novelEvents(batch.items)
        .filter((item) => !mcpOutbox.has(events.eventKey(item)));
      const boundedNovel = boundMcpEventBatch(novel);
      const deliveryDropped = dropped + boundedNovel.dropped;
      // A batch made only of events older than the grace has no news to report.
      // The feed still records the gap and the debug log, but the stream's old
      // history must not create a chat entry (or a turn) on its own.
      const staleOnly = envelope.dropped === 0 && aged.dropped > 0 && aged.items.length === 0;
      // Persist a gap-only batch when something other than age was dropped:
      // missing data must stay visible in chat too.
      if (!staleOnly && (boundedNovel.items.length > 0 || deliveryDropped > 0)) {
        // Adapter items have no generation of their own. Carry the current one
        // into the delivery copy so outbox merges cannot fold a new epoch into
        // an old pending text just because the cursor text is the same.
        const deliveryItems = boundedNovel.items.map((item) => events.withEventGeneration(item));
        // A restore may be replaying a continuous backlog. Give it one bounded
        // chip plus a gap instead of one busy delivery per replayed event; the
        // outbox merger cannot be relied on when batches arrive continuously.
        const restored = events.isRestoreBatch(deliveryItems);
        const texts = restored
          ? mcpRestoreDeliveryTexts({
              ...envelope,
              items: deliveryItems,
              dropped: deliveryDropped,
            })
          : mcpDeliveryTexts(
              { ...envelope, items: deliveryItems, dropped: deliveryDropped },
              chat.getState() === "running",
            );
        await mcpOutbox.enqueueMany(
          texts,
          boundedNovel.items.map((item) => events.eventKey(item)),
        );
      }
      events.ingest({
        customType: "mcp-events",
        details: { events: envelope.items, dropped_events: envelope.dropped },
      });
      hub.broadcast({ event: "mcp.events", data: events.state });
      mcpOutbox.start();
    });
    return;
  }
  if (isMcpNotice(text)) {
    // The observer above already ingested this notice. A status that names no
    // tracked subscription is not news about this app: the adapter mints a new
    // id per connection, so a dead pre-restart generation must stay silent even
    // when it is the same stream. With no id to attribute, the existing
    // `(server, name)` supersession rule still decides. Only authentic notices
    // reach the outbox.
    const delivered = acceptMcpStatusNotice(events, text, options.details, options.customType);
    if (delivered === null) return;
    mcpIntake.enqueue(async () => {
      await mcpOutbox.enqueue(delivered);
      mcpOutbox.start();
    });
  } else {
    void chat
      .submit(text, options.deliverAs === "steer" ? "steer" : "queue")
      .catch((error: unknown) => console.error("[pi] MCP message failed", error));
  }
});
mcpOutbox.start();

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

// The browser suite has no real push service. In its shards the server records
// each delivered payload here, and the test asserts what the notification said.
if (e2ePushSinkEnabled()) {
  const sink = () => {
    const notifications = readPushSink();
    return { notifications, records: notifications, pushes: notifications };
  };
  const clear = (c: Context) => {
    clearPushSink();
    return c.json({ ok: true });
  };
  app.get("/api/e2e/push", (c) => c.json(sink()));
  app.delete("/api/e2e/push", clear);
  app.post("/api/e2e/push/clear", clear);
  app.get("/api/e2e/push-sink", (c) => c.json(sink()));
  app.delete("/api/e2e/push-sink", clear);
  app.get("/api/push/sink", (c) => c.json(sink()));
  app.delete("/api/push/sink", clear);
  app.get("/api/test/push", (c) => c.json(sink()));
  app.delete("/api/test/push", clear);
}

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

app.post("/api/run/error/dismiss", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    body = undefined;
  }
  const id =
    typeof body === "object" && body !== null && "id" in body && typeof body.id === "string"
      ? body.id
      : undefined;
  chat.dismissRunError(id);
  return c.json({ ok: true, runError: chat.getRunStatus().runError ?? null });
});

app.get("/api/state", async (c) => {
  const snapshot = await chat.getSnapshot(windowRequestFromQuery(c.req.query()));
  const live = e2eMemoryHook ? await boot.conversation.agent(SESSION_CONTEXT) : undefined;
  return c.json({
    ...snapshot,
    tasks: taskView(),
    delegates: delegates.list(),
    jobs: builtinJobs(),
    ...(live?.instructions === undefined ? {} : { instructions: live.instructions }),
  });
});

app.get("/api/delegates", (c) => c.json(delegates.list()));

app.get("/api/jobs", (c) => c.json(builtinJobs()));

app.get("/api/jobs/:id", (c) => {
  const id = c.req.param("id");
  const job = jobs.list().find((item) => item.id === id);
  return job === undefined ? c.notFound() : c.json(job);
});

app.get("/api/jobs/:id/output", async (c) => {
  const tail = Number(c.req.query("tail"));
  try {
    return c.json(
      await jobs.output(c.req.param("id"), {
        tail: Number.isFinite(tail) && tail > 0 ? tail : 100,
      }),
    );
  } catch (error) {
    if (error instanceof JobError) return c.json({ error: error.message }, 404);
    throw error;
  }
});

app.get("/api/delegates/:id/result", async (c) => {
  const text = await delegates.read(c.req.param("id"), "result");
  if (text === undefined) return c.notFound();
  return c.text(text, 200, { "Cache-Control": "no-store" });
});

app.get("/api/delegates/:id/activity", async (c) => {
  const text = await delegates.read(c.req.param("id"), "activity");
  if (text === undefined) return c.notFound();
  return c.text(text, 200, { "Cache-Control": "no-store" });
});

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

app.get("/api/dashboard/sources", async (c) => {
  try {
    return c.json({ sources: await dashboard.sources() });
  } catch (error) {
    console.error("[pi] dashboard sources failed", error);
    return c.text("Could not list dashboard sources", 500);
  }
});

app.post("/api/dashboard/reset", async (c) => {
  try {
    return c.json(await dashboard.reset());
  } catch (error) {
    console.error("[pi] dashboard reset failed", error);
    return c.text("Could not reset the dashboard", 500);
  }
});

app.patch("/api/dashboard/layout", async (c) => {
  let body: unknown;
  try {
    body = JSON.parse(await c.req.text());
  } catch {
    return c.text("Expected a JSON body", 400);
  }
  try {
    await dashboard.setLayout(body);
    return c.json(dashboard.state());
  } catch (error) {
    if (error instanceof DashboardError) return c.text(error.message, 400);
    console.error("[pi] dashboard layout failed", error);
    return c.text("Could not save the dashboard layout", 500);
  }
});

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

function taskAgentFailure(c: Context, error: unknown) {
  if (error instanceof TaskAgentError) return c.text(error.message, error.status as 400);
  if (error instanceof TaskError) return c.text(error.message, error.status as 400);
  if (error instanceof MediaError) return c.text(error.message, error.status as 400);
  console.error("[pi] task agent failed", error);
  return c.text("Could not update the task agent", 500);
}

app.post("/api/tasks", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.text("Expected a JSON body", 400);
  }
  const rawTitle =
    typeof body === "object" && body !== null && "title" in body ? body.title : undefined;
  if (rawTitle !== undefined && typeof rawTitle !== "string") {
    return c.text("title must be a string", 400);
  }
  const title = rawTitle ?? "";
  if (title.trim().length === 0) return c.text("Task title is required", 400);
  const parentId =
    typeof body === "object" && body !== null && "parentId" in body ? body.parentId : null;
  if (parentId !== null && typeof parentId !== "string")
    return c.text("parentId must be a string", 400);
  const proposed =
    typeof body === "object" && body !== null && "propose" in body && body.propose === true;
  const requestedStatus =
    typeof body === "object" && body !== null && "status" in body ? body.status : undefined;
  if (
    requestedStatus !== undefined &&
    requestedStatus !== "open" &&
    requestedStatus !== "backlog" &&
    requestedStatus !== "planning"
  ) {
    return c.text('Status must be "open", "backlog" or "planning"', 400);
  }
  const planFlag =
    typeof body === "object" && body !== null && "plan" in body ? body.plan : undefined;
  if (planFlag !== undefined && typeof planFlag !== "boolean") {
    return c.text("plan must be a boolean", 400);
  }
  const plan = planFlag === true || requestedStatus === "planning";
  const backlogFlag =
    typeof body === "object" && body !== null && "backlog" in body ? body.backlog : undefined;
  if (backlogFlag !== undefined && typeof backlogFlag !== "boolean") {
    return c.text("backlog must be a boolean", 400);
  }
  const backlog = backlogFlag === true || requestedStatus === "backlog";
  const project =
    typeof body === "object" && body !== null && "project" in body ? body.project : undefined;
  if (project !== undefined && project !== null && typeof project !== "string")
    return c.text("project must be a string or null", 400);
  const rationale =
    typeof body === "object" &&
    body !== null &&
    "rationale" in body &&
    typeof body.rationale === "string"
      ? body.rationale
      : "";
  const taskBody =
    typeof body === "object" && body !== null && "body" in body ? body.body : undefined;
  if (taskBody !== undefined) {
    if (typeof taskBody !== "string") return c.text("body must be a string", 400);
    if (taskBody.trim().length > TASK_BODY_MAX_LENGTH) {
      return c.text(`body must be at most ${TASK_BODY_MAX_LENGTH} characters`, 400);
    }
  }
  const draftBody = plan && taskBody === undefined ? title : taskBody;
  if (draftBody !== taskBody && (draftBody ?? "").trim().length > TASK_BODY_MAX_LENGTH) {
    return c.text(`body must be at most ${TASK_BODY_MAX_LENGTH} characters`, 400);
  }
  try {
    const attachments = parseAttachmentIds(
      media,
      typeof body === "object" && body !== null && "attachments" in body
        ? body.attachments
        : undefined,
    );
    for (const id of attachments) await media.read(id);
    if (proposed) {
      return c.json(
        publishTasks(
          await taskStore.propose(title, rationale, attachments, project, taskBody, "operator"),
        ),
        201,
      );
    }
    if (plan) {
      const { ledger, task: created } = await taskStore.createWithResult(
        title,
        parentId,
        attachments,
        project,
        draftBody,
        { status: "planning" },
      );
      publishTasks(ledger);
      try {
        await taskAgents.submit(created.id, created.body ?? title);
      } catch (error) {
        // The draft still exists; its chat shows the failed run instead of losing the task.
        console.error(`[pi] could not start the plan run for ${created.id}`, error);
      }
      return c.json(taskView(), 201);
    }
    return c.json(
      publishTasks(
        await taskStore.create(
          title,
          parentId,
          attachments,
          project,
          taskBody,
          backlog ? { backlog: true } : { status: "open" },
        ),
      ),
      201,
    );
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
  const patch: {
    title?: string;
    body?: string;
    status?: TaskStatus;
    blockedBy?: string[];
    completion?: TaskCompletion;
    project?: string | null;
    attachments?: string[];
    reopenReason?: string;
    releaseReason?: string;
  } = {};
  if ("title" in body) {
    if (typeof body.title !== "string") return c.text("title must be a string", 400);
    if (body.title.trim().length === 0) return c.text("title must not be empty", 400);
    patch.title = body.title;
  }
  if ("body" in body) {
    if (typeof body.body !== "string") return c.text("body must be a string", 400);
    if (body.body.trim().length > TASK_BODY_MAX_LENGTH) {
      return c.text(`body must be at most ${TASK_BODY_MAX_LENGTH} characters`, 400);
    }
    patch.body = body.body;
  }
  if ("project" in body) {
    if (body.project !== null && typeof body.project !== "string")
      return c.text("project must be a string or null", 400);
    patch.project = body.project;
  }
  if ("attachments" in body) {
    try {
      patch.attachments = await validateAttachmentIds(
        media,
        body.attachments,
        TASK_ATTACHMENTS_MAX,
      );
    } catch (error) {
      return taskFailure(c, error);
    }
  }
  if ("status" in body) {
    if (
      body.status !== "open" &&
      body.status !== "working" &&
      body.status !== "done" &&
      body.status !== "proposed" &&
      body.status !== "backlog"
    ) {
      return c.text('Status must be "open", "working", "done", "proposed" or "backlog"', 400);
    }
    patch.status = body.status;
  }
  if ("reopenReason" in body) {
    const parsed = parseReopenReason(body.reopenReason);
    if (!parsed.ok) return c.text(parsed.error, 400);
    patch.reopenReason = parsed.reason;
  }
  if ("releaseReason" in body) {
    const parsed = parseReleaseReason(body.releaseReason);
    if (!parsed.ok) return c.text(parsed.error, 400);
    patch.releaseReason = parsed.reason;
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
    const id = c.req.param("id");
    const ledger = await taskStore.update(id, patch);
    if (ledger.tasks.find((task) => task.id === id)?.status === "done") {
      await taskAgents.stopRun(id).catch((error: unknown) => {
        console.error(`[pi] could not stop the task agent for ${id}`, error);
      });
    }
    return c.json(publishTasks(ledger));
  } catch (error) {
    return taskFailure(c, error);
  }
});

app.delete("/api/tasks/:id", async (c) => {
  try {
    const id = c.req.param("id");
    const ledger = await taskStore.remove(id);
    // Close the planning session in the background so deleting a task
    // stays a ledger write, even if the harness is still shutting down.
    void taskAgents.remove(id).catch((error: unknown) => {
      console.error(`[pi] could not remove the task agent for ${id}`, error);
    });
    return c.json(publishTasks(ledger));
  } catch (error) {
    return taskFailure(c, error);
  }
});

app.get("/api/tasks/:id/chat", async (c) => {
  try {
    return c.json(await taskAgents.snapshot(c.req.param("id")));
  } catch (error) {
    return taskAgentFailure(c, error);
  }
});

app.post("/api/tasks/:id/chat", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.text("Expected a JSON body", 400);
  }
  const record = typeof body === "object" && body !== null ? body : {};
  const text = "text" in record && typeof record.text === "string" ? record.text : "";
  const mode = "mode" in record && record.mode === "steer" ? "steer" : "queue";
  const queueKey =
    "queueKey" in record && typeof record.queueKey === "string" && record.queueKey.length > 0
      ? record.queueKey
      : undefined;
  let attachments: string[] = [];
  try {
    attachments = parseAttachmentIds(
      media,
      "attachments" in record ? record.attachments : undefined,
    );
    for (const id of attachments) await media.read(id);
  } catch (error) {
    return taskAgentFailure(c, error);
  }
  try {
    return c.json(await taskAgents.send(c.req.param("id"), text, attachments, mode, queueKey), 202);
  } catch (error) {
    return taskAgentFailure(c, error);
  }
});

app.post("/api/tasks/:id/chat/queue/:queueId", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    body = undefined;
  }
  const action =
    typeof body === "object" && body !== null && "action" in body ? body.action : undefined;
  const queueId = c.req.param("queueId");
  try {
    if (action === "steer") {
      const response = await taskAgents.steerQueued(c.req.param("id"), queueId);
      if (response === null) return c.text("Unknown queued message", 404);
      return c.json(response);
    }
    const snapshot = await taskAgents.cancelQueued(c.req.param("id"), queueId);
    return c.json({
      queue: snapshot.queue ?? [],
      steers: snapshot.steers ?? [],
      queueRevision: snapshot.queueRevision ?? 0,
    });
  } catch (error) {
    return taskAgentFailure(c, error);
  }
});

app.post("/api/tasks/:id/chat/steer/:steerId", async (c) => {
  try {
    const result = await taskAgents.unsendSteer(c.req.param("id"), c.req.param("steerId"));
    if (result === null) return c.text("Unknown steer", 404);
    return c.json({
      steer: result.steer,
      steers: result.snapshot.steers ?? [],
      queueRevision: result.snapshot.queueRevision ?? 0,
    });
  } catch (error) {
    return taskAgentFailure(c, error);
  }
});

app.get("/api/tasks/:id/questions", async (c) => {
  try {
    const session = await taskAgents.ensure(c.req.param("id"));
    return c.json({ questions: (await session.pendingQuestions?.()) ?? null });
  } catch (error) {
    return taskAgentFailure(c, error);
  }
});

async function answerTaskQuestions(c: Context) {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.text("Expected a JSON body", 400);
  }
  if (typeof body !== "object" || body === null) return c.text("Expected a JSON body", 400);
  const setId =
    "setId" in body && typeof body.setId === "string"
      ? body.setId
      : "id" in body && typeof body.id === "string"
        ? body.id
        : "";
  if (setId.length === 0) return c.text("setId is required", 400);
  if (!("answers" in body) || !Array.isArray(body.answers)) {
    return c.text("answers must be a list", 400);
  }
  try {
    return c.json(await taskAgents.answerQuestions(c.req.param("id") ?? "", setId, body.answers));
  } catch (error) {
    return taskAgentFailure(c, error);
  }
}

app.post("/api/tasks/:id/questions/answer", (c) => answerTaskQuestions(c));
app.post("/api/tasks/:id/questions", (c) => answerTaskQuestions(c));

app.post("/api/tasks/:id/chat/stop", async (c) => {
  try {
    const id = c.req.param("id");
    await taskAgents.ensure(id);
    await taskAgents.stopRun(id);
    return c.json(await taskAgents.snapshot(id));
  } catch (error) {
    return taskAgentFailure(c, error);
  }
});

app.post("/api/tasks/:id/chat/error/dismiss", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    body = undefined;
  }
  const errorId =
    typeof body === "object" && body !== null && "id" in body && typeof body.id === "string"
      ? body.id
      : undefined;
  try {
    return c.json(await taskAgents.dismissError(c.req.param("id"), errorId));
  } catch (error) {
    return taskAgentFailure(c, error);
  }
});

app.get("/api/tasks/:id/chat/stream", (c) => {
  c.header("X-Accel-Buffering", "no");
  const id = c.req.param("id");
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
    let session: TaskAgentSession;
    try {
      session = await taskAgents.ensure(id);
    } catch (error) {
      const message = error instanceof TaskAgentError ? error.message : "Unknown task";
      await stream.writeSSE({ event: "error", data: JSON.stringify({ error: message }) });
      return;
    }
    session.hub.add(client);
    const heartbeat = setInterval(() => {
      void enqueue(async () => {
        await stream.write(": heartbeat\n\n");
        await stream.writeSSE({
          event: "liveness",
          data: JSON.stringify({ at: new Date().toISOString() }),
        });
      });
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
      await client.send({ event: "liveness", data: { at: new Date().toISOString() } });
      for (const frame of session.replayFrames()) {
        await client.send(frame);
      }
      await closed;
    } finally {
      clearInterval(heartbeat);
      session.hub.remove(client);
    }
  });
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
  const rawQueueKey =
    typeof body === "object" && body !== null && "queueKey" in body ? body.queueKey : undefined;
  if (
    rawQueueKey !== undefined &&
    (typeof rawQueueKey !== "string" ||
      rawQueueKey.length === 0 ||
      rawQueueKey.length > 128 ||
      !/^[A-Za-z0-9._:-]+$/.test(rawQueueKey))
  ) {
    return c.text("queueKey must be a short stable identifier", 400);
  }

  try {
    return c.json(
      await chat.submit(text, mode, {
        attachments,
        ...(typeof rawQueueKey === "string" ? { queueKey: rawQueueKey } : {}),
      }),
      202,
    );
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
    const snapshot = await chat.getSnapshot();
    return c.json({ ok: true, queue: snapshot.queue, queueRevision: snapshot.queueRevision });
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
  const status = chat.getRunStatus();
  return c.json({
    ok: true,
    steer,
    steers: status.steers ?? [],
    queueRevision: status.queueRevision,
  });
});

app.post("/api/stop", async (c) => {
  await chat.stop();
  return c.json({ ok: true, queue: (await chat.getSnapshot()).queue });
});

app.get("/api/stream", (c) => {
  // State changes are written as they happen. A buffering reverse proxy would otherwise
  // hold a small frame until the next heartbeat, so tell it not to buffer this stream.
  c.header("X-Accel-Buffering", "no");
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

    // Keepalive only: a change is pushed by its own `hub.broadcast`, not by this tick.
    const heartbeat = setInterval(() => {
      // The event, not the comment alone, tells the browser the server's own
      // liveness is still current and clears a stale connection header.
      void enqueue(async () => {
        await stream.write(": heartbeat\n\n");
        await stream.writeSSE({
          event: "liveness",
          data: JSON.stringify({ at: new Date().toISOString() }),
        });
      });
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
      await client.send({ event: "liveness", data: { at: new Date().toISOString() } });
      await client.send({ event: "run.state", data: chat.getRunStatus() });
      await client.send({ event: "tasks", data: taskView() });
      await client.send({ event: "dashboard", data: dashboard.state() });
      await client.send({ event: "delegates", data: delegates.list() });
      await client.send({ event: "jobs", data: builtinJobs() });
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
// A push carries a page route, so a document request to /tasks or /chat must
// boot the app shell and let the client pager take over. A task detail route is
// the path alias of the task-plan hash route. Unknown paths still fall through
// to serveStatic and a real 404.
app.get("/tasks/:id", serveIndex);
app.get("/tasks/:id/", serveIndex);
for (const id of PAGE_IDS) {
  const path = PAGE_PATHS[id];
  app.get(path, serveIndex);
  app.get(`${path}/`, serveIndex);
}

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
    ...boot.delegateTools,
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
  await mcpIntake.close();
  await mcpOutbox.close();
  chat.beginShutdown();
  await taskActivity.flush().catch((error: unknown) => {
    console.error("[pi] could not save task activity", error);
  });
  dashboard.dispose();
  try {
    await dashboard.flush();
    await taskAgents.close();
    await taskStore.close();
    await chat.close();
    await boot.mcp.close();
    await delegates.shutdown();
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
