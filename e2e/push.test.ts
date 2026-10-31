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
  createPushService,
  loadOrCreateVapidKeys,
  type PushSubscriptionRecord,
  PushSubscriptionStore,
} from "../src/server/push.js";

async function tempDir(t: { after: (fn: () => Promise<void>) => void }): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pi-push-"));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
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

function render(state: PushRowState): string {
  return renderToStaticMarkup(
    createElement(PushSettingsRow, {
      state,
      onEnable: () => {},
      onDisable: () => {},
    }),
  );
}

test("the settings row renders all five states from props alone", () => {
  assert.equal(PUSH_ROW_STATES.length, 5);
  const markup = new Map(PUSH_ROW_STATES.map((state) => [state, render(state)]));
  assert.match(markup.get("unsupported") ?? "", /secure context \(HTTPS or localhost\)/);
  assert.match(markup.get("checking") ?? "", /Checking notification support/);
  assert.match(markup.get("default") ?? "", /Enable notifications/);
  assert.match(markup.get("granted") ?? "", /Notifications on/);
  assert.match(markup.get("granted") ?? "", /Turn off/);
  assert.match(markup.get("denied") ?? "", /Notifications blocked in the browser/);
  assert.doesNotMatch(markup.get("denied") ?? "", /Enable notifications/);
});

test("the VAPID base64url key becomes the bytes pushManager expects", () => {
  assert.deepEqual([...base64UrlToUint8Array("AQID")], [1, 2, 3]);
});
