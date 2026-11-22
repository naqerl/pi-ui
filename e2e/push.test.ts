import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import vm from "node:vm";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  base64UrlToUint8Array,
  PUSH_ROW_STATES,
  type PushRowState,
  PushSettingsRow,
} from "../src/client/PushSettings.js";
import { ChatService } from "../src/server/chat-service.js";
import {
  configurePush,
  createPushService,
  loadOrCreateVapidKeys,
  MAX_BODY_CHARS,
  normalizePushClient,
  type PushClient,
  type PushClientDevice,
  type PushClientMode,
  type PushNotification,
  type PushSubscriptionRecord,
  PushSubscriptionStore,
  pushClientFromRequest,
  pushDeviceFromUserAgent,
  resetPushServiceForTests,
  withPushClient,
} from "../src/server/push.js";
import {
  RUN_ERROR_PUSH_BODY_CHARS,
  RUN_ERROR_PUSH_WINDOW_MS,
  RunErrorNotifier,
  runErrorNotification,
} from "../src/server/run-push.js";
import { TaskStore } from "../src/server/tasks.js";
import { PAGE_PATHS, pageIdFromPath } from "../src/shared/pages.js";
import type { RunError } from "../src/shared/types.js";

async function tempDir(t: { after: (fn: () => Promise<void>) => void }): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pi-push-"));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

function clampBody(value: string): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  return oneLine.length <= MAX_BODY_CHARS ? oneLine : `${oneLine.slice(0, MAX_BODY_CHARS - 1)}…`;
}

function subscription(endpoint = "https://push.example/one"): PushSubscriptionRecord {
  return {
    endpoint,
    keys: { p256dh: "p256dh-key", auth: "auth-secret" },
    createdAt: "2026-10-30T10:00:00.000Z",
    lastOkAt: null,
  };
}

function client(device: PushClientDevice, mode: PushClientMode): PushClient {
  return { device, mode };
}

type ErrorChat = {
  runState: string;
  runStopped: boolean;
  runReleased: boolean;
  runError: RunError | null;
  noteRunError(errorClass: string, message: string, detail?: string): void;
  clearRunError(errorClass?: string): void;
  setRunState(state: "idle" | "running" | "interrupted"): void;
  stop(): Promise<void>;
  handleEvent(
    event:
      | {
          type: "tool_execution_start";
          toolCallId: string;
          toolName: string;
          args: unknown;
        }
      | {
          type: "tool_execution_end";
          toolCallId: string;
          toolName: string;
          args?: unknown;
          result?: { isError?: boolean; output?: string };
        },
  ): Promise<void>;
};

function makeErrorChat(notifier: Pick<RunErrorNotifier, "deliver">): {
  chat: ChatService;
  internal: ErrorChat;
} {
  const conversation = {
    id: 1,
    submit: async () => ({ id: 1 }),
    abort: async () => "aborted",
  };
  const chat = new ChatService(
    {} as never,
    conversation as never,
    { broadcast() {} } as never,
    undefined,
    false,
    { clear: async () => undefined, write: async () => undefined } as never,
    undefined,
    { servers: [], unavailable: [] },
    {} as never,
    undefined,
    {} as never,
    {} as never,
    async () => undefined,
    () => undefined,
    () => [],
    undefined,
    undefined,
    notifier,
  );
  return { chat, internal: chat as unknown as ErrorChat };
}

async function settlePush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

test("a run error pushes once, repeats inside the window coalesce, and a new message pushes", async () => {
  const sent: PushNotification[] = [];
  let now = 1_000;
  const notifier = new RunErrorNotifier({ now: () => now, notify: (item) => sent.push(item) });
  const { chat, internal } = makeErrorChat(notifier);
  try {
    internal.noteRunError("ModelError", "the provider returned an empty answer");
    await settlePush();
    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.title, "Turn failed in chat");
    assert.equal(sent[0]?.body, "the provider returned an empty answer");
    assert.equal(sent[0]?.url, PAGE_PATHS.chat);

    // The same sequence is never announced twice, even when its detail changes.
    internal.noteRunError("ModelError", "the provider returned an empty answer", "more detail");
    await settlePush();
    assert.equal(sent.length, 1);

    // A later run with the same text inside the window is still one notification.
    internal.clearRunError();
    internal.noteRunError("ModelError", "the provider returned an empty answer");
    await settlePush();
    assert.equal(sent.length, 1);

    // Past the window, the same error is news again; a different one always is.
    now += RUN_ERROR_PUSH_WINDOW_MS;
    internal.clearRunError();
    internal.noteRunError("ModelError", "the provider returned an empty answer");
    await settlePush();
    assert.equal(sent.length, 2);

    internal.clearRunError();
    internal.noteRunError("ProviderError", "the provider kept failing");
    await settlePush();
    assert.equal(sent.length, 3);
    assert.equal(sent[2]?.body, "the provider kept failing");
    assert.ok((sent[2]?.body ?? "").length <= RUN_ERROR_PUSH_BODY_CHARS);
  } finally {
    await chat.close();
  }
});

test("the same failure in a later turn is news again after the window", async () => {
  const sent: PushNotification[] = [];
  let now = 1_000;
  const notifier = new RunErrorNotifier({ now: () => now, notify: (item) => sent.push(item) });
  const { chat, internal } = makeErrorChat(notifier);
  try {
    internal.noteRunError("ModelError", "the same failure every turn");
    await settlePush();
    assert.equal(sent.length, 1);

    // The old header is still shown, but a new turn makes the same text a new failure.
    now += RUN_ERROR_PUSH_WINDOW_MS;
    internal.setRunState("running");
    internal.setRunState("idle");
    internal.noteRunError("ModelError", "the same failure every turn");
    await settlePush();
    assert.equal(sent.length, 2);
  } finally {
    await chat.close();
  }
});

test("an idle connection error is not a failed turn", async () => {
  const sent: PushNotification[] = [];
  const notifier = new RunErrorNotifier({ notify: (item) => sent.push(item) });
  const { chat, internal } = makeErrorChat(notifier);
  try {
    internal.noteRunError("ConnectionError", "Lost the connection to the agent; reconnecting.");
    internal.noteRunError("ConnectionError", "Could not reconnect to the agent.");
    await settlePush();
    assert.equal(sent.length, 0);
  } finally {
    await chat.close();
  }
});

test("a failure waits for its run to settle and a retried one never rings", async () => {
  const sent: PushNotification[] = [];
  const notifier = new RunErrorNotifier({ notify: (item) => sent.push(item) });
  const { chat, internal } = makeErrorChat(notifier);
  try {
    internal.runState = "running";
    internal.noteRunError("ModelError", "a transient provider failure");
    await settlePush();
    assert.equal(sent.length, 0, "a failure while running is not the turn's outcome yet");

    // The retry clears it before the run ends, so it never becomes a phone notification.
    internal.clearRunError();
    internal.setRunState("idle");
    await settlePush();
    assert.equal(sent.length, 0);

    internal.runState = "running";
    internal.noteRunError("ModelError", "the run's final failure");
    await settlePush();
    assert.equal(sent.length, 0);
    internal.setRunState("idle");
    await settlePush();
    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.body, "the run's final failure");
  } finally {
    await chat.close();
  }
});

test("a deliberate stop or successful release of this run's task keeps the failure off the phone", async () => {
  const sent: PushNotification[] = [];
  const notifier = new RunErrorNotifier({ notify: (item) => sent.push(item) });
  const { chat, internal } = makeErrorChat(notifier);
  try {
    internal.setRunState("running");
    await internal.stop();
    internal.noteRunError("ModelError", "stopped from the chat");
    await settlePush();
    assert.equal(sent.length, 0);

    internal.setRunState("running");
    await internal.handleEvent({
      type: "tool_execution_start",
      toolCallId: "working-1",
      toolName: "task_working",
      args: { id: "t1" },
    });
    await internal.handleEvent({
      type: "tool_execution_start",
      toolCallId: "release-1",
      toolName: "task_release",
      args: { id: "t1", reason: "parked" },
    });
    await internal.handleEvent({
      type: "tool_execution_end",
      toolCallId: "release-1",
      toolName: "task_release",
      args: { id: "t1", reason: "parked" },
      result: { isError: false, output: "t1 open" },
    });
    internal.setRunState("idle");
    internal.noteRunError("ModelError", "released work");
    await settlePush();
    assert.equal(sent.length, 0);
  } finally {
    await chat.close();
  }
});

test("a failed or unrelated release leaves a real failure on the push path", async () => {
  const sent: PushNotification[] = [];
  const notifier = new RunErrorNotifier({ notify: (item) => sent.push(item) });
  const { chat, internal } = makeErrorChat(notifier);
  try {
    internal.setRunState("running");
    await internal.handleEvent({
      type: "tool_execution_start",
      toolCallId: "working-1",
      toolName: "task_working",
      args: { id: "t1" },
    });
    await internal.handleEvent({
      type: "tool_execution_start",
      toolCallId: "release-1",
      toolName: "task_release",
      args: { id: "t1" },
    });
    await internal.handleEvent({
      type: "tool_execution_end",
      toolCallId: "release-1",
      toolName: "task_release",
      args: { id: "t1" },
      result: { isError: true, output: "Only a working task can be released" },
    });
    internal.setRunState("idle");
    internal.noteRunError("ModelError", "a real failure after a failed release");
    await settlePush();
    assert.equal(sent.length, 1);

    internal.setRunState("running");
    await internal.handleEvent({
      type: "tool_execution_start",
      toolCallId: "working-2",
      toolName: "task_working",
      args: { id: "t1" },
    });
    await internal.handleEvent({
      type: "tool_execution_start",
      toolCallId: "release-2",
      toolName: "task_release",
      args: { id: "t2" },
    });
    await internal.handleEvent({
      type: "tool_execution_end",
      toolCallId: "release-2",
      toolName: "task_release",
      args: { id: "t2" },
      result: { isError: false, output: "t2 open" },
    });
    internal.setRunState("idle");
    internal.noteRunError("ModelError", "a real failure after another task's release");
    await settlePush();
    assert.equal(sent.length, 2);
  } finally {
    await chat.close();
  }
});

test("the VAPID key pair is generated once, persisted at 0600 and stable across starts", async (t) => {
  const dir = await tempDir(t);
  const first = await loadOrCreateVapidKeys(dir);
  const mode = (await stat(join(dir, "push-vapid.json"))).mode & 0o777;
  assert.equal(mode, 0o600);

  const point = Buffer.from(first.publicKey, "base64url");
  assert.equal(point.length, 65);
  assert.equal(point[0], 0x04);

  const second = await loadOrCreateVapidKeys(dir);
  assert.equal(second.publicKey, first.publicKey);
  assert.equal(second.privateKey, first.privateKey);
});

test("adding the same endpoint twice replaces it, and delete is idempotent", async (t) => {
  const dir = await tempDir(t);
  const store = new PushSubscriptionStore(dir, { throttleMs: 0 });
  await store.subscribe(subscription());
  await store.subscribe({ ...subscription(), keys: { p256dh: "new", auth: "new" } });
  const records = await store.read();
  assert.equal(records.length, 1);
  assert.equal(records[0]?.keys.p256dh, "new");

  assert.equal(await store.remove(records[0]?.endpoint ?? ""), true);
  assert.equal(await store.remove(records[0]?.endpoint ?? ""), false);
  assert.deepEqual(await store.read(), []);
  await store.close();
});

test("a corrupt registry logs one line, starts empty and is rewritten on the next subscribe", async (t) => {
  const dir = await tempDir(t);
  const file = join(dir, "push-subscriptions.json");
  await writeFile(file, "{ not json", "utf8");
  const lines: string[] = [];
  const store = new PushSubscriptionStore(dir, { throttleMs: 0, log: (line) => lines.push(line) });
  assert.deepEqual(await store.read(), []);
  assert.equal(lines.length, 1);
  assert.match(lines[0] ?? "", /corrupt subscription registry/);

  await store.subscribe(subscription());
  await store.flush();
  const saved = JSON.parse(await readFile(file, "utf8")) as {
    subscriptions: PushSubscriptionRecord[];
  };
  assert.equal(saved.subscriptions.length, 1);
  assert.equal(saved.subscriptions[0]?.endpoint, subscription().endpoint);
  await store.close();
});

test("a client subscribe replaces its device class and leaves the other class alone", async (t) => {
  const dir = await tempDir(t);
  const store = new PushSubscriptionStore(dir, { throttleMs: 0 });
  assert.equal(
    await store.subscribe({
      ...subscription("https://push.example/phone-app"),
      client: client("mobile", "app"),
    }),
    0,
  );
  assert.equal(
    await store.subscribe({
      ...subscription("https://push.example/laptop"),
      client: client("desktop", "browser"),
    }),
    0,
  );
  assert.equal(
    await store.subscribe({
      ...subscription("https://push.example/phone-tab"),
      client: client("mobile", "browser"),
    }),
    1,
  );

  const records = await store.read();
  assert.deepEqual(records.map((record) => record.endpoint).sort(), [
    "https://push.example/laptop",
    "https://push.example/phone-tab",
  ]);
  const phone = records.find((record) => record.client?.device === "mobile");
  assert.deepEqual(phone?.client, { device: "mobile", mode: "browser" });
  await store.close();
});

test("a client subscribe collapses unattributed records into one device class", async (t) => {
  const dir = await tempDir(t);
  const file = join(dir, "push-subscriptions.json");
  const store = new PushSubscriptionStore(dir, { throttleMs: 0 });
  await store.subscribe(subscription("https://push.example/old-brave"));
  await store.subscribe(subscription("https://push.example/old-app"));

  assert.equal(
    await store.subscribe({
      ...subscription("https://push.example/new-app"),
      client: client("mobile", "app"),
    }),
    2,
  );
  const records = await store.read();
  assert.equal(records.length, 1);
  assert.equal(records[0]?.endpoint, "https://push.example/new-app");
  assert.deepEqual(records[0]?.client, { device: "mobile", mode: "app" });

  await store.flush();
  const saved = JSON.parse(await readFile(file, "utf8")) as {
    version: number;
    subscriptions: PushSubscriptionRecord[];
  };
  assert.equal(saved.version, 1);
  assert.equal(saved.subscriptions.length, 1);
  await store.close();
});

test("a legacy body without a client block keeps every endpoint and fans out", async (t) => {
  const dir = await tempDir(t);
  const sent: string[] = [];
  const service = createPushService({
    dataDir: dir,
    throttleMs: 0,
    send: async (target) => {
      sent.push(target.endpoint);
      return { statusCode: 201 };
    },
  });
  await service.subscribe(subscription("https://push.example/legacy-one"));
  await service.subscribe(subscription("https://push.example/legacy-two"));
  assert.equal((await service.status()).subscriptions, 2);

  await service.notify({ title: "New message", url: "/" });
  assert.deepEqual(sent.sort(), [
    "https://push.example/legacy-one",
    "https://push.example/legacy-two",
  ]);
  await service.close();
});

test("the registry keeps records whose client block is malformed", async (t) => {
  const dir = await tempDir(t);
  const file = join(dir, "push-subscriptions.json");
  await writeFile(
    file,
    JSON.stringify({
      version: 1,
      subscriptions: [
        subscription("https://push.example/legacy"),
        {
          ...subscription("https://push.example/tablet"),
          client: { device: "tablet", mode: "app" },
        },
        { ...subscription("https://push.example/no-device"), client: { mode: "app" } },
        { ...subscription("https://push.example/no-mode"), client: { device: "mobile" } },
      ],
    }),
    "utf8",
  );
  const store = new PushSubscriptionStore(dir, { throttleMs: 0 });
  const records = await store.read();
  assert.equal(records.length, 4);
  assert.ok(records.every((record) => record.client === undefined));
  await store.close();
});

test("status lists device and mode but never an endpoint or key", async (t) => {
  const dir = await tempDir(t);
  const service = createPushService({ dataDir: dir, throttleMs: 0 });
  await service.subscribe({
    ...subscription("https://push.example/phone"),
    client: client("mobile", "app"),
  });
  await service.subscribe({
    ...subscription("https://push.example/laptop"),
    client: client("desktop", "browser"),
  });

  const status = await service.status();
  assert.equal(status.enabled, true);
  assert.equal(status.subscriptions, 2);
  assert.deepEqual(status.records, [
    { device: "mobile", mode: "app" },
    { device: "desktop", mode: "browser" },
  ]);
  assert.doesNotMatch(JSON.stringify(status), /endpoint|p256dh|auth-secret/);
  await service.close();
});

test("the subscribe body gets a server-derived device and only a valid mode", () => {
  const body = { ...subscription("https://push.example/phone"), client: { mode: "app" } };
  assert.deepEqual(withPushClient(body, "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)"), {
    ...body,
    client: { device: "mobile", mode: "app" },
  });
  assert.deepEqual(withPushClient(body, "Mozilla/5.0 (X11; Linux x86_64)"), {
    ...body,
    client: { device: "desktop", mode: "app" },
  });

  const legacy = subscription("https://push.example/legacy");
  assert.equal(withPushClient(legacy, "Mozilla/5.0 (X11; Linux x86_64)"), legacy);
  const malformed = { ...legacy, client: { mode: "window" } };
  assert.equal(withPushClient(malformed, "Mozilla/5.0 (X11; Linux x86_64)"), malformed);

  assert.equal(pushDeviceFromUserAgent("Mozilla/5.0 (Android 15; Mobile)"), "mobile");
  assert.equal(pushDeviceFromUserAgent("Mozilla/5.0 (iPad; CPU OS 18_0)"), "mobile");
  assert.equal(pushDeviceFromUserAgent("Mozilla/5.0 (Macintosh)"), "desktop");
  assert.equal(pushDeviceFromUserAgent(undefined), "desktop");
  assert.deepEqual(pushClientFromRequest({ mode: "browser" }, "Mozilla/5.0 (Linux; Android 15)"), {
    device: "mobile",
    mode: "browser",
  });
  assert.equal(pushClientFromRequest({ mode: "standalone" }, "Mozilla/5.0"), null);
  assert.equal(normalizePushClient({ device: "mobile", mode: "app" })?.mode, "app");
  assert.equal(normalizePushClient({ device: "watch", mode: "app" }), null);
});

test("notify marks a delivered subscription and drops an endpoint the push service says is gone", async (t) => {
  const dir = await tempDir(t);
  const lines: string[] = [];
  const sent: string[] = [];
  const service = createPushService({
    dataDir: dir,
    throttleMs: 0,
    log: (line) => lines.push(line),
    send: async (target) => {
      sent.push(target.endpoint);
      if (target.endpoint.endsWith("/gone")) {
        throw Object.assign(new Error("Gone"), { statusCode: 410 });
      }
      return { statusCode: 201 };
    },
  });
  await service.subscribe(subscription());
  await service.subscribe(subscription("https://push.example/gone"));

  await service.notify({ title: "job build finished", body: "built in 3s", url: "/activity" });
  assert.deepEqual(sent.sort(), ["https://push.example/gone", "https://push.example/one"]);
  const records = await service.store.read();
  assert.equal(records.length, 1);
  assert.equal(records[0]?.endpoint, "https://push.example/one");
  assert.notEqual(records[0]?.lastOkAt, null);
  assert.deepEqual(lines, []);
  await service.close();
});

test("another delivery failure is logged once, swallowed, and keeps the subscription", async (t) => {
  const dir = await tempDir(t);
  const lines: string[] = [];
  const service = createPushService({
    dataDir: dir,
    throttleMs: 0,
    log: (line) => lines.push(line),
    send: async () => {
      throw Object.assign(new Error("service unavailable"), { statusCode: 503 });
    },
  });
  await service.subscribe(subscription());

  await service.notify({ title: "MCP event", body: "new event", url: "/activity" });
  assert.equal(lines.length, 1);
  assert.match(lines[0] ?? "", /could not notify/);
  assert.equal((await service.status()).subscriptions, 1);
  await service.close();
});

function withTestMode(
  t: { after: (fn: () => void) => void },
  overrides: Record<string, string> = {},
): void {
  const keys = ["NODE_ENV", "PI_E2E_ALLOW_REAL_PUSH"];
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  process.env.NODE_ENV = "test";
  delete process.env.PI_E2E_ALLOW_REAL_PUSH;
  for (const [key, value] of Object.entries(overrides)) process.env[key] = value;
  t.after(() => {
    for (const key of keys) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

test("a test-mode push service refuses a real endpoint", async (t) => {
  withTestMode(t);
  const dir = await tempDir(t);
  const lines: string[] = [];
  const sent: string[] = [];
  const service = createPushService({
    dataDir: dir,
    throttleMs: 0,
    log: (line) => lines.push(line),
    send: async (_target, payload) => {
      sent.push(payload);
      return { statusCode: 201 };
    },
  });
  await service.subscribe(subscription("https://fcm.googleapis.com/fcm/send/abc"));

  await assert.rejects(
    () => service.notify({ title: "Tidy the ledger", body: "never leaves the process" }),
    /fcm\.googleapis\.com/,
  );
  assert.deepEqual(sent, []);
  assert.equal(lines.length, 1);
  assert.match(lines[0] ?? "", /fcm\.googleapis\.com/);
  await service.close();
});

test("a test-mode push service still delivers to an allowlisted host", async (t) => {
  withTestMode(t);
  const dir = await tempDir(t);
  const sent: string[] = [];
  const service = createPushService({
    dataDir: dir,
    throttleMs: 0,
    send: async (_target, payload) => {
      sent.push(payload);
      return { statusCode: 201 };
    },
  });
  await service.subscribe(subscription("https://push.example/one"));

  const delivered = await service.notify({ title: "Tidy the ledger", body: "fixture only" });
  assert.equal(delivered, 1);
  assert.equal(sent.length, 1);
  await service.close();
});

test("PI_E2E_ALLOW_REAL_PUSH=1 lifts the guard", async (t) => {
  withTestMode(t, { PI_E2E_ALLOW_REAL_PUSH: "1" });
  const dir = await tempDir(t);
  const sent: string[] = [];
  const service = createPushService({
    dataDir: dir,
    throttleMs: 0,
    send: async (_target, payload) => {
      sent.push(payload);
      return { statusCode: 201 };
    },
  });
  await service.subscribe(subscription("https://fcm.googleapis.com/fcm/send/abc"));

  const delivered = await service.notify({ title: "Tidy the ledger", body: "attempted" });
  assert.equal(delivered, 1);
  assert.equal(sent.length, 1);
  await service.close();
});

test("creating a proposal sends one push with its title, id and tasks url", async (t) => {
  const dir = await tempDir(t);
  const sent: string[] = [];
  const service = configurePush({
    dataDir: dir,
    throttleMs: 0,
    send: async (_target, payload) => {
      sent.push(payload);
      return { statusCode: 201 };
    },
  });
  await service.subscribe(subscription());

  try {
    const store = new TaskStore(join(dir, "tasks.json"));
    await store.load();
    const title = `Tidy the ledger ${"with a very long explanation ".repeat(8)}`;
    const ledger = await store.propose(
      title,
      "The repeated cleanup costs more than the change and makes reviews noisy.",
    );
    const proposal = ledger.tasks[0];
    assert.ok(proposal);

    assert.equal(sent.length, 1);
    const payload = JSON.parse(sent[0] ?? "{}") as Record<string, unknown>;
    assert.equal(payload.title, "New proposal");
    assert.equal(payload.body, clampBody(title));
    assert.equal(payload.tag, proposal.id);
    assert.equal(payload.url, PAGE_PATHS.tasks);
    assert.equal(pageIdFromPath(String(payload.url)), "tasks");
    assert.ok(String(payload.body).length <= MAX_BODY_CHARS);
  } finally {
    await service.close();
    resetPushServiceForTests();
  }
});

test("marking a task done sends one push only on the transition", async (t) => {
  const dir = await tempDir(t);
  const sent: string[] = [];
  const service = configurePush({
    dataDir: dir,
    throttleMs: 0,
    send: async (_target, payload) => {
      sent.push(payload);
      return { statusCode: 201 };
    },
  });
  await service.subscribe(subscription());

  try {
    const store = new TaskStore(join(dir, "tasks.json"));
    await store.load();
    const task = (await store.create("Ship the modal", null)).tasks[0];
    assert.ok(task);
    const completion = { evidence: "e2e/push.test.ts" };

    await store.update(task.id, { status: "done", completion });
    assert.equal(sent.length, 1);
    const payload = JSON.parse(sent[0] ?? "{}") as Record<string, unknown>;
    assert.equal(payload.title, "Task done");
    assert.equal(payload.body, "Ship the modal");
    assert.equal(payload.tag, task.id);
    assert.equal(payload.url, PAGE_PATHS.tasks);
    assert.equal(pageIdFromPath(String(payload.url)), "tasks");

    await store.update(task.id, { status: "done", completion });
    assert.equal(sent.length, 1);
  } finally {
    await service.close();
    resetPushServiceForTests();
  }
});

test("marking a task working sends one push only on the transition", async (t) => {
  const dir = await tempDir(t);
  const sent: string[] = [];
  const service = configurePush({
    dataDir: dir,
    throttleMs: 0,
    send: async (_target, payload) => {
      sent.push(payload);
      return { statusCode: 201 };
    },
  });
  await service.subscribe(subscription());

  try {
    const store = new TaskStore(join(dir, "tasks.json"));
    await store.load();
    const task = (await store.create("Ship the modal", null)).tasks[0];
    assert.ok(task);

    await store.update(task.id, { status: "working" });
    assert.equal(sent.length, 1);
    const payload = JSON.parse(sent[0] ?? "{}") as Record<string, unknown>;
    assert.equal(payload.title, "Task started");
    assert.equal(payload.body, "Ship the modal");
    assert.equal(payload.tag, task.id);
    assert.equal(payload.url, PAGE_PATHS.tasks);
    assert.equal(pageIdFromPath(String(payload.url)), "tasks");
    assert.ok(String(payload.body).length <= MAX_BODY_CHARS);

    await store.update(task.id, { status: "working" });
    assert.equal(sent.length, 1);

    await store.update(task.id, { title: "Ship the modal, redesigned" });
    assert.equal(sent.length, 1);

    const dependency = (await store.create("Follow-up", null)).tasks.find(
      (item) => item.title === "Follow-up",
    );
    assert.ok(dependency);
    await store.update(task.id, { blockedBy: [dependency.id] });
    assert.equal(sent.length, 1);

    await store.update(task.id, { status: "working", title: "Ship the modal again" });
    assert.equal(sent.length, 1);
  } finally {
    await service.close();
    resetPushServiceForTests();
  }
});

test("the worker stays quiet only while a client is focused", async () => {
  const source = await readFile(new URL("../public/sw.js", import.meta.url), "utf8");
  const sandbox = {
    self: { addEventListener() {}, clients: {}, registration: {} },
    caches: {},
    Response,
  };
  vm.createContext(sandbox);
  vm.runInContext(`${source}\n;globalThis.__shouldNotify = shouldNotify;`, sandbox);
  const shouldNotify = (sandbox as { __shouldNotify?: (clients: unknown) => boolean })
    .__shouldNotify;
  assert.equal(typeof shouldNotify, "function");
  assert.equal(shouldNotify?.([{ focused: true }]), false);
  assert.equal(shouldNotify?.([{ focused: false }]), true);
  assert.equal(shouldNotify?.([]), true);
});

interface PushEvent {
  data: { json: () => unknown };
  waitUntil: (promise: Promise<void>) => void;
}

async function loadPushWorker(clients: readonly unknown[]): Promise<{
  push: (event: PushEvent) => void;
  shown: Array<{ title: string; options: Record<string, unknown> }>;
}> {
  const source = await readFile(new URL("../public/sw.js", import.meta.url), "utf8");
  const listeners = new Map<string, (event: PushEvent) => void>();
  const shown: Array<{ title: string; options: Record<string, unknown> }> = [];
  const sandbox = {
    self: {
      addEventListener(type: string, listener: (event: PushEvent) => void) {
        listeners.set(type, listener);
      },
      clients: { matchAll: async () => clients },
      registration: {
        showNotification: async (title: string, options: Record<string, unknown>) => {
          shown.push({ title, options });
        },
      },
    },
    caches: {},
    Response,
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  const push = listeners.get("push");
  assert.equal(typeof push, "function");
  return { push: push as (event: PushEvent) => void, shown };
}

async function deliverPush(push: (event: PushEvent) => void, payload: unknown): Promise<void> {
  let pending: Promise<void> | undefined;
  push({
    data: { json: () => payload },
    waitUntil(promise) {
      pending = promise;
    },
  });
  assert.ok(pending);
  await pending;
}

test("the service worker shows a push once and carries no messaging SDK", async () => {
  const source = await readFile(new URL("../public/sw.js", import.meta.url), "utf8");
  assert.equal(source.match(/showNotification\(/g)?.length, 1);
  assert.doesNotMatch(source, /importScripts\s*\(/);
  assert.doesNotMatch(source, /onBackgroundMessage/);

  const pushHandler = source.indexOf('addEventListener("push"');
  const notification = source.indexOf("showNotification(");
  const clickHandler = source.indexOf('addEventListener("notificationclick"');
  assert.ok(pushHandler >= 0);
  assert.ok(notification > pushHandler);
  assert.ok(notification < clickHandler);
});

test("a run-error push stays silent while a client is focused", async () => {
  const payload = runErrorNotification({ message: "the provider refused the request" });
  const focused = await loadPushWorker([{ focused: true }]);
  await deliverPush(focused.push, payload);
  assert.equal(focused.shown.length, 0);

  const background = await loadPushWorker([{ focused: false }]);
  await deliverPush(background.push, payload);
  assert.equal(background.shown.length, 1);
  assert.equal(background.shown[0]?.title, "Turn failed in chat");
  assert.equal(background.shown[0]?.options.body, "the provider refused the request");
  assert.equal(
    (background.shown[0]?.options.data as { url?: unknown } | undefined)?.url,
    PAGE_PATHS.chat,
  );
});

interface ClickEvent {
  notification: { close: () => void; data: { url: string } };
  waitUntil: (promise: Promise<void>) => void;
}

async function loadClickWorker(clients: readonly unknown[]): Promise<{
  click: (event: ClickEvent) => void;
  opened: string[];
}> {
  const source = await readFile(new URL("../public/sw.js", import.meta.url), "utf8");
  const listeners = new Map<string, (event: ClickEvent) => void>();
  const opened: string[] = [];
  const sandbox = {
    self: {
      addEventListener(type: string, listener: (event: ClickEvent) => void) {
        listeners.set(type, listener);
      },
      clients: {
        matchAll: async () => clients,
        openWindow: async (url: string) => {
          opened.push(url);
          return {};
        },
      },
      registration: {},
    },
    caches: {},
    Response,
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  const click = listeners.get("notificationclick");
  assert.equal(typeof click, "function");
  return { click: click as (event: ClickEvent) => void, opened };
}

async function clickNotification(click: (event: ClickEvent) => void, url: string): Promise<void> {
  let pending: Promise<void> | undefined;
  click({
    notification: { close() {}, data: { url } },
    waitUntil(promise) {
      pending = promise;
    },
  });
  assert.ok(pending);
  await pending;
}

test("a notification click focuses and navigates an open client", async () => {
  const calls: string[] = [];
  const { click, opened } = await loadClickWorker([
    {
      focused: false,
      focus: async () => {
        calls.push("focus");
      },
      navigate: async (url: string) => {
        calls.push(`navigate:${url}`);
      },
    },
  ]);

  await clickNotification(click, "/tasks");

  assert.deepEqual(calls, ["focus", "navigate:/tasks"]);
  assert.deepEqual(opened, []);
});

test("a notification click opens the page when no client is open", async () => {
  const { click, opened } = await loadClickWorker([]);

  await clickNotification(click, "/chat");

  assert.deepEqual(opened, ["/chat"]);
});

function render(state: PushRowState, busy = false): string {
  return renderToStaticMarkup(
    createElement(PushSettingsRow, {
      state,
      busy,
      onEnable: () => {},
      onDisable: () => {},
    }),
  );
}

function assertSwitch(
  markup: string,
  expected: { checked: string; disabled: boolean; status: string },
): void {
  assert.match(markup, /role="switch"/);
  assert.match(markup, /aria-label="Notifications"/);
  assert.match(markup, new RegExp(`aria-checked="${expected.checked}"`));
  assert.equal(markup.includes('disabled=""'), expected.disabled);
  assert.match(markup, new RegExp(expected.status));
}

test("off: the labelled switch can turn notifications on", () => {
  assert.equal(PUSH_ROW_STATES.length, 5);
  assertSwitch(render("default"), {
    checked: "false",
    disabled: false,
    status: "Off — get notified when pi needs you",
  });
});

test("on: the labelled switch can turn notifications off", () => {
  assertSwitch(render("granted"), {
    checked: "true",
    disabled: false,
    status: "On — notifications are enabled",
  });
});

test("busy: the labelled switch stays disabled while the change is pending", () => {
  assertSwitch(render("default", true), {
    checked: "false",
    disabled: true,
    status: "Busy — updating notification settings",
  });
  assertSwitch(render("checking"), {
    checked: "false",
    disabled: true,
    status: "Busy — checking notification support",
  });
});

test("denied: the labelled switch is disabled and the status says why", () => {
  assertSwitch(render("denied"), {
    checked: "false",
    disabled: true,
    status: "Denied — notifications are blocked in the browser",
  });
});

test("unsupported: the labelled switch is disabled until push is available", () => {
  assertSwitch(render("unsupported"), {
    checked: "false",
    disabled: true,
    status: "Unsupported — push needs HTTPS or localhost",
  });
});

test("the VAPID base64url key becomes the bytes pushManager expects", () => {
  assert.deepEqual([...base64UrlToUint8Array("AQID")], [1, 2, 3]);
});
