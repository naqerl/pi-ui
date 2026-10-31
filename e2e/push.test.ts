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
import {
  configurePush,
  createPushService,
  loadOrCreateVapidKeys,
  MAX_BODY_CHARS,
  type PushSubscriptionRecord,
  PushSubscriptionStore,
  resetPushServiceForTests,
} from "../src/server/push.js";
import { TaskStore } from "../src/server/tasks.js";

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
    assert.equal(payload.url, "/tasks");
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
    const completion = {
      timeSpentMinutes: 25,
      timeSpentText: "25m",
      tokens: 120,
      evidence: "e2e/push.test.ts",
    };

    await store.update(task.id, { status: "done", completion });
    assert.equal(sent.length, 1);
    const payload = JSON.parse(sent[0] ?? "{}") as Record<string, unknown>;
    assert.equal(payload.title, "Task done");
    assert.equal(payload.body, "Ship the modal");
    assert.equal(payload.tag, task.id);
    assert.equal(payload.url, "/tasks");

    await store.update(task.id, { status: "done", completion });
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
