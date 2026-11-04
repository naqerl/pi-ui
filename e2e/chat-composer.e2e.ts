import { test } from "@e2e-dev/web";
import { expect } from "e2e";

test("switches the model from the pi menu", async ({ app, browser, screen }) => {
  await app.open("/");
  const before = await browser.evaluate(async () => {
    const response = await fetch("/api/models", { cache: "no-store" });
    return (await response.json()) as {
      current: { id: string } | null;
      models: Array<{ id: string }>;
    };
  });
  expect(before.current?.id).toBe("e2e-model");
  expect(before.models.map((item) => item.id).sort()).toEqual(["e2e-model", "e2e-other"]);

  await screen.getByRole("button", "Settings").tap();
  await expect(screen.getByRole("menuitem", { name: /^Model/ })).toBeVisible();
  await screen.getByRole("menuitem", { name: /^Model/ }).tap();
  await expect(screen.getByRole("menuitemradio", { name: /E2E Other/ })).toBeVisible();
  await screen.getByRole("menuitemradio", { name: /E2E Other/ }).tap();

  await expect
    .poll(async () =>
      browser.evaluate(async () => {
        const body = (await (await fetch("/api/models", { cache: "no-store" })).json()) as {
          current: { id: string } | null;
        };
        return body.current?.id ?? "";
      }),
    )
    .toBe("e2e-other");

  const contextWindow = await browser.evaluate(async () => {
    const state = (await (await fetch("/api/state", { cache: "no-store" })).json()) as {
      context: { window: number | null };
    };
    return state.context.window;
  });
  expect(contextWindow).toBe(8192);

  await app.open("/");
  await screen.getByRole("button", "Settings").tap();
  await expect(screen.getByRole("menuitem", { name: /e2e-other/ })).toBeVisible();

  const restored = await browser.evaluate(async () => {
    const response = await fetch("/api/model", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "e2e", id: "e2e-model" }),
    });
    return response.ok;
  });
  expect(restored).toBe(true);
});

test("hydrates the chat after a failed first fetch and refreshes on focus", async ({
  app,
  browser,
  screen,
}) => {
  const timestamp = new Date().toISOString();
  let version = 0;
  let stateRequests = 0;
  const snapshot = (text: string) => ({
    conversationId: "hydrate-e2e",
    messages: [{ id: `hydrate-${version}`, role: "assistant", text, timestamp, order: 1 }],
    activity: [],
    run: "idle",
    queue: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 },
    context: { tokens: 0, window: null, percent: null },
  });

  // No stream to rescue the first load: the retry has to fetch the state again.
  await browser.route("**/api/stream", async (route) => route.abort());
  await browser.route("**/api/state**", async (route) => {
    stateRequests += 1;
    if (stateRequests === 1) {
      await route.fulfill({ status: 503, body: "starting" });
      return;
    }
    await route.fulfill({
      json: snapshot(version === 0 ? "First hydration" : "Refreshed on focus"),
    });
  });

  await app.open("/");
  await expect(screen.getByText("First hydration", { exact: true })).toBeVisible({
    timeout: 10_000,
  });
  expect(stateRequests).toBeGreaterThan(1);

  version = 1;
  await browser.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(screen.getByText("Refreshed on focus", { exact: true })).toBeVisible({
    timeout: 10_000,
  });
});

/** Draw a small PNG in the page and hand it to the composer's file input. */
async function attachImage(browser: { evaluate: <T>(fn: () => T | Promise<T>) => Promise<T> }) {
  return browser.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 40;
    const context = canvas.getContext("2d");
    if (context === null) return false;
    context.fillStyle = "#e11d48";
    context.fillRect(0, 0, 64, 40);
    context.fillStyle = "#0ea5e9";
    context.fillRect(16, 8, 32, 24);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (blob === null) return false;
    const transfer = new DataTransfer();
    transfer.items.add(new File([blob], `shot-${Math.random()}.png`, { type: "image/png" }));
    const inputs = [...document.querySelectorAll<HTMLInputElement>("[data-testid=attach-input]")];
    const input = inputs.find((item) => item.closest("[aria-hidden=true]") === null) ?? inputs[0];
    if (input === undefined) return false;
    input.files = transfer.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  });
}

async function attachmentStatuses(browser: {
  evaluate: <T>(fn: () => T | Promise<T>) => Promise<T>;
}) {
  return browser.evaluate(() =>
    [...document.querySelectorAll("[data-testid=composer-attachments] li")].map(
      (item) => item.getAttribute("data-status") ?? "",
    ),
  );
}

async function waitReady(browser: { evaluate: <T>(fn: () => T | Promise<T>) => Promise<T> }) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const statuses = await attachmentStatuses(browser);
    if (statuses.length > 0 && statuses.every((status) => status === "ready")) return statuses;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return attachmentStatuses(browser);
}

for (const width of [390, 1280]) {
  test(`sends an image with a message at ${width}px`, async ({ app, browser, screen }) => {
    await browser.setViewport({ width, height: 844 });
    await app.open("/");
    const composer = screen.getByRole("textbox", "Message");
    await expect(composer).toBeVisible();
    await expect(screen.getByRole("button", "Attach image")).toBeVisible();

    expect(await attachImage(browser)).toBe(true);
    expect(await waitReady(browser)).toEqual(["ready"]);

    // The plus sits left of the text field, and the preview stays inside the composer.
    const layout = await browser.evaluate(() => {
      const plus = document.querySelector('button[aria-label="Attach image"]');
      const field = document.querySelector('textarea[aria-label="Message"]');
      const strip = document.querySelector("[data-testid=composer-attachments]");
      const form = field?.closest("form") ?? field?.parentElement?.parentElement ?? null;
      if (plus === null || field === null || strip === null || form === null) return null;
      const p = plus.getBoundingClientRect();
      const f = field.getBoundingClientRect();
      const s = strip.getBoundingClientRect();
      const box = form.getBoundingClientRect();
      return {
        plusLeftOfField: p.right <= f.left + 1,
        stripAboveField: s.bottom <= f.top + 1,
        stripInside: s.left >= box.left - 1 && s.right <= box.right + 1,
        overflow: document.documentElement.scrollWidth - window.innerWidth,
      };
    });
    expect(layout).toEqual({
      plusLeftOfField: true,
      stripAboveField: true,
      stripInside: true,
      overflow: 0,
    });

    await composer.fill(`what is in this picture ${width}`);
    await screen.getByRole("button", "Send").tap();
    await expect(
      screen.getByText(`Echo: what is in this picture ${width} [images: 1]`, { exact: false }),
    ).toBeVisible({ timeout: 15_000 });
    expect(await attachmentStatuses(browser)).toEqual([]);

    const shown = await browser.evaluate(async () => {
      const images = [
        ...document.querySelectorAll<HTMLImageElement>("[data-testid=message-attachments] img"),
      ];
      const last = images.at(-1);
      if (last === undefined) return null;
      if (!last.complete) await new Promise((resolve) => last.addEventListener("load", resolve));
      const rect = last.getBoundingClientRect();
      const bubble = last.closest("[data-testid=message-attachments]")?.parentElement;
      return {
        src: new URL(last.src).pathname.startsWith("/api/media/"),
        loaded: last.naturalWidth === 64,
        fits:
          bubble !== null &&
          bubble !== undefined &&
          rect.right <= bubble.getBoundingClientRect().right + 1,
      };
    });
    expect(shown).toEqual({ src: true, loaded: true, fits: true });

    const stored = await browser.evaluate(async () => {
      const state = (await (await fetch("/api/state", { cache: "no-store" })).json()) as {
        messages: { role: string; text: string; attachments?: { mimeType: string }[] }[];
      };
      const mine = state.messages.filter((item) => item.role === "user").at(-1);
      return { text: mine?.text ?? "", types: (mine?.attachments ?? []).map((a) => a.mimeType) };
    });
    expect(stored).toEqual({ text: `what is in this picture ${width}`, types: ["image/png"] });
  });
}

test("sends an image without text and removes a preview", async ({ app, browser, screen }) => {
  await browser.setViewport({ width: 390, height: 844 });
  await app.open("/");
  await expect(screen.getByRole("textbox", "Message")).toBeVisible();

  expect(await attachImage(browser)).toBe(true);
  expect(await attachImage(browser)).toBe(true);
  expect(await waitReady(browser)).toEqual(["ready", "ready"]);
  await screen.getByRole("button", "Remove attachment 2").tap();
  expect(await attachmentStatuses(browser)).toEqual(["ready"]);

  await screen.getByRole("button", "Send").tap();
  await expect(screen.getByText("Echo:  [images: 1]", { exact: false })).toBeVisible({
    timeout: 15_000,
  });
});

test("attaches an image to a new task", async ({ app, browser, screen }) => {
  await browser.setViewport({ width: 390, height: 844 });
  await app.open("/?page=tasks");
  const field = screen.getByRole("textbox", "New task");
  await expect(field).toBeVisible();
  await expect(screen.getByRole("button", "Attach image to task")).toBeVisible();

  expect(await attachImage(browser)).toBe(true);
  expect(await waitReady(browser)).toEqual(["ready"]);
  // A task still needs a title.
  expect(
    await browser.evaluate(
      () =>
        document.querySelector<HTMLButtonElement>('button[aria-label="Add task"]')?.disabled ??
        null,
    ),
  ).toBe(true);

  await field.fill("Fix the layout in this screenshot");
  await screen.getByRole("button", "Add task").tap();
  // Scope to the list: the composer draft still carries the title until the
  // create round-trip resolves, so a page-wide text match can see both.
  await expect(
    screen.getByTestId("task-list").getByText("Fix the layout in this screenshot", { exact: true }),
  ).toBeVisible();
  // Rows stay slim; the attachment shows in the task's detail.
  await screen.getByRole("button", "Open Fix the layout in this screenshot").tap();
  await expect(screen.getByTestId("task-attachments")).toBeVisible();

  const task = await browser.evaluate(async () => {
    const ledger = (await (await fetch("/api/tasks", { cache: "no-store" })).json()) as {
      tasks: { title: string; attachments?: string[] }[];
    };
    const found = ledger.tasks.find((item) => item.title === "Fix the layout in this screenshot");
    const image = document.querySelector<HTMLImageElement>("[data-testid=task-attachments] img");
    return {
      count: found?.attachments?.length ?? 0,
      shown: image !== null && new URL(image.src).pathname.startsWith("/api/media/"),
    };
  });
  expect(task).toEqual({ count: 1, shown: true });
});

test("validates media uploads and attachment ids", async ({ app, browser }) => {
  await app.open("/");
  const result = await browser.evaluate(async () => {
    const text = await fetch("/api/media", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "not an image",
    });
    const empty = await fetch("/api/media", {
      method: "POST",
      headers: { "Content-Type": "image/png" },
      body: new Uint8Array(),
    });
    const fake = await fetch("/api/media", {
      method: "POST",
      headers: { "Content-Type": "image/png" },
      body: "<html>not a png</html>",
    });
    const unknown = await fetch("/api/message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "hi", attachments: [`${"0".repeat(32)}.png`] }),
    });
    const bad = await fetch("/api/message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "hi", attachments: ["../../etc/passwd"] }),
    });
    const missing = await fetch(`/api/media/${"0".repeat(32)}.png`);
    return [text.status, empty.status, fake.status, unknown.status, bad.status, missing.status];
  });
  expect(result).toEqual([415, 400, 400, 400, 400, 404]);
});

test("the notifications row fits the popover and keeps its height from off to on", async ({
  app,
  browser,
  screen,
}) => {
  await browser.addInitScript(() => {
    const storageKey = "e2e-push-subscribed";
    let subscribed = localStorage.getItem(storageKey) === "1";
    const endpoint = "https://push.example/e2e-row";
    const keys = { p256dh: "B".repeat(65), auth: "auth-token" };
    const subscription = () => ({
      endpoint,
      keys,
      toJSON: () => ({ endpoint, keys }),
      unsubscribe: async () => {
        subscribed = false;
        localStorage.removeItem(storageKey);
        return true;
      },
    });
    const registration = {
      pushManager: {
        getSubscription: async () => (subscribed ? subscription() : null),
        subscribe: async () => {
          subscribed = true;
          localStorage.setItem(storageKey, "1");
          return subscription();
        },
      },
    };
    Object.defineProperty(window, "PushManager", { configurable: true, value: class {} });
    Object.defineProperty(window, "Notification", {
      configurable: true,
      value: { permission: "default", requestPermission: async () => "granted" },
    });
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: {
        getRegistration: async () => registration,
        ready: Promise.resolve(registration),
        register: async () => registration,
      },
    });
  });

  await browser.setViewport({ width: 320, height: 844 });
  await app.open("/");
  await expect(screen.getByRole("textbox", "Message")).toBeVisible();
  await screen.getByRole("button", { name: "Settings" }).tap();

  const row = screen.getByTestId("push-settings-row");
  const toggle = screen.getByTestId("push-toggle");
  await expect(row).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-checked", "false");

  const read = () =>
    browser.evaluate(() => {
      const menu = document.querySelector<HTMLElement>('[role="menu"]');
      const rowElement = document.querySelector<HTMLElement>('[data-testid="push-settings-row"]');
      const status = document.querySelector<HTMLElement>('[data-testid="push-status"]');
      const toggleElement = document.querySelector<HTMLElement>('[data-testid="push-toggle"]');
      if (menu === null || rowElement === null || status === null || toggleElement === null) {
        return null;
      }
      const themeButton = menu.querySelector<HTMLElement>('button[role="menuitem"]');
      const modelButton = menu.querySelectorAll<HTMLElement>('button[role="menuitem"]')[1];
      const title = rowElement.querySelector<HTMLElement>("p");
      const themeLabel = themeButton?.querySelector<HTMLElement>("span") ?? null;
      const modelValue = modelButton?.querySelectorAll<HTMLElement>("span")[1] ?? null;
      if (title === null || themeLabel === null || modelValue === null) return null;

      const lines = (element: HTMLElement) => {
        const lineHeight = Number.parseFloat(getComputedStyle(element).lineHeight);
        return lineHeight > 0 ? Math.round(element.getBoundingClientRect().height / lineHeight) : 1;
      };
      const menuBox = menu.getBoundingClientRect();
      const rowBox = rowElement.getBoundingClientRect();
      const toggleBox = toggleElement.getBoundingClientRect();
      const titleBox = title.getBoundingClientRect();
      const titleStyle = getComputedStyle(title);
      const statusStyle = getComputedStyle(status);
      const themeStyle = getComputedStyle(themeLabel);
      const modelStyle = getComputedStyle(modelValue);
      return {
        viewport: window.innerWidth,
        menuWidth: menuBox.width,
        menuInside: menuBox.left >= 0 && menuBox.right <= window.innerWidth && menuBox.width <= 288,
        rowHeight: rowBox.height,
        rowFits: rowElement.scrollWidth <= rowElement.clientWidth + 1,
        titleLines: lines(title),
        titleFits: title.scrollWidth <= title.clientWidth + 1,
        statusLines: lines(status),
        titleLeft: Math.round(titleBox.left - menuBox.left),
        themeLeft: Math.round(themeLabel.getBoundingClientRect().left - menuBox.left),
        titleFont: titleStyle.fontSize,
        themeFont: themeStyle.fontSize,
        titleColor: titleStyle.color,
        themeColor: themeStyle.color,
        statusFont: statusStyle.fontSize,
        modelFont: modelStyle.fontSize,
        statusColor: statusStyle.color,
        modelColor: modelStyle.color,
        toggleWidth: toggleBox.width,
        toggleHeight: toggleBox.height,
        toggleOnRight:
          toggleBox.right <= rowBox.right + 1 && toggleBox.left > rowBox.left + rowBox.width / 2,
        checked: toggleElement.getAttribute("aria-checked"),
        disabled: toggleElement.hasAttribute("disabled"),
      };
    });

  for (const width of [320, 390]) {
    await browser.setViewport({ width, height: 844 });
    const off = await read();
    expect(off).not.toBeNull();
    if (off === null) return;
    expect(off.viewport).toBe(width);
    expect(off.menuInside).toBe(true);
    expect(off.menuWidth).toBeLessThanOrEqual(288);
    expect(off.rowFits).toBe(true);
    expect(off.titleLines).toBe(1);
    expect(off.titleFits).toBe(true);
    expect(off.statusLines).toBe(1);
    expect(off.titleLeft).toBe(off.themeLeft);
    expect(off.titleFont).toBe(off.themeFont);
    expect(off.titleColor).toBe(off.themeColor);
    expect(off.statusFont).toBe(off.modelFont);
    expect(off.statusColor).toBe(off.modelColor);
    expect(off.toggleWidth).toBeGreaterThanOrEqual(44);
    expect(off.toggleHeight).toBeGreaterThanOrEqual(44);
    expect(off.toggleOnRight).toBe(true);
    expect(off.checked).toBe("false");
    expect(off.disabled).toBe(false);

    await toggle.tap();
    await expect(row).toHaveAttribute("data-state", "granted");
    await expect(toggle).toHaveAttribute("aria-checked", "true");

    const on = await read();
    expect(on).not.toBeNull();
    if (on === null) return;
    expect(on.statusLines).toBe(1);
    expect(on.rowHeight).toBe(off.rowHeight);
    expect(on.checked).toBe("true");
    expect(on.disabled).toBe(false);

    await toggle.tap();
    await expect(row).toHaveAttribute("data-state", "default");
    await expect(toggle).toHaveAttribute("aria-checked", "false");
  }
});

const at = new Date(Date.UTC(2026, 0, 1, 12, 0, 0)).toISOString();

const ledger = {
  revision: 1,
  tasks: [
    {
      id: "p1",
      title: "Clean the cache",
      status: "proposed",
      parentId: null,
      blockedBy: [],
      createdAt: at,
      proposedAt: at,
      rationale: "The cache keeps stale entries for a whole day.",
      completedAt: null,
      completion: null,
    },
  ],
};

const snapshot = {
  conversationId: "haptics-e2e",
  messages: [],
  activity: [],
  run: "idle",
  queue: [],
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 },
  context: { tokens: 0, window: null, percent: null },
  tasks: ledger,
};

test("vibrates once for an approval and not for the selected tab", async ({
  app,
  browser,
  screen,
}) => {
  await browser.addInitScript(() => {
    let calls = 0;
    Object.defineProperty(navigator, "vibrate", {
      configurable: true,
      value: () => {
        calls += 1;
        (window as unknown as { __vibrationCalls?: number }).__vibrationCalls = calls;
        return true;
      },
    });
  });
  await browser.emulateMedia({ reducedMotion: "no-preference" });
  await browser.route("**/api/tasks/**", async (route) => {
    await route.fulfill({ json: ledger });
  });
  await browser.route("**/api/state**", async (route) => {
    await route.fulfill({ json: snapshot });
  });
  await browser.setViewport({ width: 390, height: 844 });
  await app.open("/?page=tasks");

  const calls = () =>
    browser.evaluate(
      () => (window as unknown as { __vibrationCalls?: number }).__vibrationCalls ?? 0,
    );
  expect(await calls()).toBe(0);

  await screen.getByRole("button", { name: "Approve Clean the cache" }).tap();
  await expect.poll(calls).toBe(1);

  await screen.getByRole("tab", "Tasks").tap();
  await browser.evaluate(async () => {
    await new Promise<void>((resolve) => {
      window.setTimeout(resolve, 80);
    });
    return true;
  });
  expect(await calls()).toBe(1);
});
