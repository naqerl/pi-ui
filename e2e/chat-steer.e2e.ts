import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, test } from "@e2e-dev/web";
import { expect, type JsonValue, type Screen } from "e2e";

/** Leave the shared app idle before a test acts; an earlier Stop may still be folding a steer. */
async function settleComposer(screen: Screen) {
  const send = screen.getByRole("button", { name: "Send" });
  const stop = screen.getByRole("button", { name: "Stop" });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 150));
    if ((await stop.count()) > 0) {
      await stop.tap();
      continue;
    }
    if ((await send.count()) > 0) {
      // The first paint shows Send before the snapshot can report a live run.
      await new Promise((resolve) => setTimeout(resolve, 300));
      if ((await stop.count()) === 0) return;
    }
  }
  await expect(send).toBeVisible({ timeout: 30_000 });
}

describe("steer reconciliation against one shared app", { serial: true }, () => {
  beforeEach(async ({ browser }) => {
    await browser.unrouteAll();
  });

  test("steers a running turn from the button and from Enter", async ({ app, screen }) => {
    await app.open("/");
    const composer = screen.getByRole("textbox", "Message");
    await composer.fill("SLOW response please");
    await screen.getByRole("button", "Send").tap();
    await expect(screen.getByRole("button", "Stop")).toBeVisible();

    try {
      await composer.fill("steer from the button");
      await expect(composer).toHaveAttribute("placeholder", "Message pi");
      await expect(
        screen.getByText("Hold Steer to queue without interrupting the run."),
      ).toHaveCount(0);
      await screen.getByRole("button", "Steer").tap();

      await expect(composer).toHaveValue("");
      await expect(screen.getByText("steer from the button", { exact: true })).toBeVisible();
      await expect(screen.getByRole("button", "Queue")).toHaveCount(0);
      await expect(screen.getByRole("button", "cancel")).toHaveCount(0);

      await composer.fill("steer from enter");
      await composer.press("Enter");
      await expect(composer).toHaveValue("");
      await expect(screen.getByText("steer from enter", { exact: true })).toBeVisible();
      await expect(screen.getByRole("button", "Queue")).toHaveCount(0);
    } finally {
      const stop = screen.getByRole("button", "Stop");
      if ((await stop.count()) > 0) await stop.tap();
      await expect(screen.getByRole("button", { name: "Send" })).toBeVisible({ timeout: 15_000 });
    }
  });

  test("keeps an accepted steer visible until its transcript entry arrives", async ({
    app,
    browser,
    screen,
  }) => {
    await app.open("/");
    const tag = Date.now();
    const release = join(tmpdir(), `pi-ui-chat-steer-${tag}-${randomUUID()}`);
    const wait = `for i in $(seq 600); do [ -e '${release}' ] && break; sleep 0.1; done; echo released`;
    const calls = [{ name: "bash", arguments: { command: wait } }];
    const composer = screen.getByRole("textbox", "Message");
    await composer.fill(`TOOLCALLS ${JSON.stringify(calls)}`);
    await screen.getByRole("button", "Send").tap();
    await expect(screen.getByRole("button", "Stop")).toBeVisible();

    const text = `chat steer ${tag}`;
    await composer.fill(text);
    await composer.press("Enter");
    const pending = browser.locator('[data-pending-steer="true"]').filter({ hasText: text });
    await expect(pending).toBeVisible();
    const pendingText = await browser.evaluate((needle) => {
      const element = [
        ...document.querySelectorAll<HTMLElement>('[data-pending-steer="true"]'),
      ].find((bubble) => (bubble.textContent ?? "").includes(needle));
      return (element?.textContent ?? "").toLowerCase();
    }, text);
    expect(pendingText.includes("steer · pending")).toBe(true);

    // The tool waits for the release file, so the steer cannot be consumed yet.
    await new Promise((resolve) => setTimeout(resolve, 250));
    await expect(pending).toBeVisible();

    // Watch the DOM across the handoff: there must be no moment where neither the pending
    // bubble nor the delivered steer bubble carries the message.
    await browser.evaluate((needle) => {
      const watch = { gap: false };
      const target = window as unknown as {
        __steerWatch?: { gap: boolean };
        __steerObserver?: MutationObserver;
      };
      target.__steerWatch = watch;
      const check = () => {
        const bubbles = [...document.querySelectorAll<HTMLElement>("[data-message-id]")];
        const visible = (isPending: boolean) =>
          bubbles.some(
            (element) =>
              (element.dataset.pendingSteer === "true") === isPending &&
              element.dataset.steerError !== "true" &&
              (element.textContent ?? "").includes(needle),
          );
        if (!visible(true) && !visible(false)) watch.gap = true;
      };
      const observer = new MutationObserver(check);
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });
      target.__steerObserver = observer;
      check();
      return true;
    }, text);

    writeFileSync(release, "");
    await expect(screen.getByText(`Echo: ${text}`, { exact: false })).toBeVisible({
      timeout: 20_000,
    });
    await expect(screen.getByRole("button", "Send")).toBeVisible({ timeout: 15_000 });
    await expect(pending).toHaveCount(0);

    const delivered = browser.locator('[data-role="user"]').filter({ hasText: text });
    await expect(delivered).toBeVisible();
    const deliveredText = await browser.evaluate((needle) => {
      const element = [...document.querySelectorAll<HTMLElement>('[data-role="user"]')].find(
        (bubble) =>
          bubble.dataset.pendingSteer !== "true" && (bubble.textContent ?? "").includes(needle),
      );
      return (element?.textContent ?? "").toLowerCase();
    }, text);
    expect(deliveredText.includes("steer")).toBe(true);
    expect(deliveredText.includes("pending")).toBe(false);
    expect(deliveredText.includes("dropped")).toBe(false);

    const gap = await browser.evaluate(() => {
      const target = window as unknown as {
        __steerWatch?: { gap: boolean };
        __steerObserver?: MutationObserver;
      };
      target.__steerObserver?.disconnect();
      return target.__steerWatch?.gap ?? false;
    });
    expect(gap).toBe(false);
  });

  test("Stop folds pending steers into one message for the next turn", async ({
    app,
    browser,
    screen,
  }) => {
    await app.open(`/?page=chat&fresh=${Date.now()}`);
    await settleComposer(screen);
    const composer = screen.getByRole("textbox", "Message");
    await composer.fill("SLOW response please");
    await screen.getByRole("button", "Send").tap();
    await expect(screen.getByRole("button", "Stop")).toBeVisible();

    const tag = Date.now();
    const first = `folded first ${tag}`;
    const second = `folded second ${tag}`;
    await composer.fill(first);
    await composer.press("Enter");
    await composer.fill(second);
    await composer.press("Enter");
    const pending = browser.locator('[data-pending-steer="true"]');
    await expect(pending).toHaveCount(2);

    await screen.getByRole("button", "Stop").tap();
    await expect(pending).toHaveCount(0, { timeout: 15_000 });
    const merged = browser
      .locator('[data-role="user"]')
      .filter({ hasText: first })
      .filter({ hasText: second });
    await expect(merged).toHaveCount(1, { timeout: 15_000 });
    await expect(browser.locator('[data-steer-error="true"]')).toHaveCount(0);
    await expect(screen.getByText("steer · dropped", { exact: false })).toHaveCount(0);
    await expect(screen.getByRole("button", "Send")).toBeVisible({ timeout: 15_000 });
  });

  test("right-click deletes one pending steer from its menu", async ({ app, browser, screen }) => {
    await app.open(`/?page=chat&fresh=${Date.now()}`);
    await settleComposer(screen);
    const composer = screen.getByRole("textbox", "Message");
    await composer.fill("SLOW response please");
    await screen.getByRole("button", "Send").tap();
    await expect(screen.getByRole("button", "Stop")).toBeVisible();

    const text = `delete steer ${Date.now()}`;
    try {
      await composer.fill(text);
      await composer.press("Enter");
      const pending = browser.locator('[data-pending-steer="true"]').filter({ hasText: text });
      const tracked = await browser.evaluate(async (needle: string) => {
        const deadline = performance.now() + 10_000;
        while (performance.now() < deadline) {
          const response = await fetch("/api/state", { cache: "no-store" });
          if (response.ok) {
            const snapshot = (await response.json()) as {
              steers?: { id?: string; text?: string }[];
            };
            const item = snapshot.steers?.find((steer) => steer.text === needle);
            if (item?.id !== undefined) return item.id;
          }
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        return null;
      }, text);
      expect(tracked).toBeTruthy();
      const messageId = `steer-pending-${tracked ?? ""}`;
      await expect(pending).toHaveAttribute("data-message-id", messageId);

      await browser.evaluate((id: string) => {
        document
          .querySelector(`[data-message-id="${id}"]`)
          ?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
        return true;
      }, messageId);
      await expect(screen.getByTestId("pending-message-menu")).toBeVisible();
      await screen.getByTestId("pending-menu-delete-steer").tap();

      await expect(pending).toHaveCount(0);
      await expect(browser.locator('[data-steer-error="true"]')).toHaveCount(0);
      await expect(composer).toHaveValue("");
    } finally {
      const stop = screen.getByRole("button", "Stop");
      if ((await stop.count()) > 0) await stop.tap();
    }
  });

  test("a touch long-press opens the same delete menu", async ({ app, browser, screen }) => {
    await browser.addInitScript(() => {
      Object.defineProperty(navigator, "maxTouchPoints", { configurable: true, value: 5 });
      Object.defineProperty(window, "ontouchstart", { configurable: true, value: null });
    });
    await app.open(`/?page=chat&fresh=${Date.now()}`);
    await settleComposer(screen);
    const composer = screen.getByRole("textbox", "Message");
    await composer.fill("SLOW response please");
    await screen.getByRole("button", "Send").tap();
    await expect(screen.getByRole("button", "Stop")).toBeVisible();

    const text = `hold steer ${Date.now()}`;
    try {
      await composer.fill(text);
      await composer.press("Enter");
      const pending = browser.locator('[data-pending-steer="true"]').filter({ hasText: text });
      const tracked = await browser.evaluate(async (needle: string) => {
        const deadline = performance.now() + 10_000;
        while (performance.now() < deadline) {
          const response = await fetch("/api/state", { cache: "no-store" });
          if (response.ok) {
            const snapshot = (await response.json()) as {
              steers?: { id?: string; text?: string }[];
            };
            const item = snapshot.steers?.find((steer) => steer.text === needle);
            if (item?.id !== undefined) return item.id;
          }
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        return null;
      }, text);
      expect(tracked).toBeTruthy();
      const messageId = `steer-pending-${tracked ?? ""}`;
      await expect(pending).toHaveAttribute("data-message-id", messageId);

      await browser.evaluate((id: string) => {
        const element = document.querySelector<HTMLElement>(`[data-message-id="${id}"]`);
        if (element === null) return false;
        const box = element.getBoundingClientRect();
        element.dispatchEvent(
          new PointerEvent("pointerdown", {
            bubbles: true,
            cancelable: true,
            pointerId: 1,
            pointerType: "touch",
            isPrimary: true,
            clientX: box.left + 20,
            clientY: box.top + 10,
          }),
        );
        return true;
      }, messageId);
      await new Promise((resolve) => setTimeout(resolve, 700));
      await browser.evaluate((id: string) => {
        const element = document.querySelector<HTMLElement>(`[data-message-id="${id}"]`);
        element?.dispatchEvent(
          new PointerEvent("pointerup", {
            bubbles: true,
            cancelable: true,
            pointerId: 1,
            pointerType: "touch",
            isPrimary: true,
          }),
        );
        return true;
      }, messageId);

      await expect(screen.getByTestId("pending-message-menu")).toBeVisible();
      await screen.getByTestId("pending-menu-delete-steer").tap();
      await expect(pending).toHaveCount(0);
      await expect(browser.locator('[data-steer-error="true"]')).toHaveCount(0);
      await expect(composer).toHaveValue("");
    } finally {
      const stop = screen.getByRole("button", "Stop");
      if ((await stop.count()) > 0) await stop.tap();
    }
  });
  test("does not revive a consumed steer from a snapshot read before delivery", async ({
    app,
    browser,
    screen,
  }) => {
    await app.open("/");
    const tag = Date.now();
    const release = join(tmpdir(), `pi-ui-steer-snapshot-${tag}-${randomUUID()}`);
    const wait = `for i in $(seq 600); do [ -e '${release}' ] && break; sleep 0.1; done; echo released`;
    const calls = [{ name: "bash", arguments: { command: wait } }];
    const composer = screen.getByRole("textbox", "Message");
    try {
      await composer.fill(`TOOLCALLS ${JSON.stringify(calls)}`);
      await screen.getByRole("button", "Send").tap();
      await expect(screen.getByRole("button", "Stop")).toBeVisible();

      const text = `steer stale snapshot ${tag}`;
      await composer.fill(text);
      await composer.press("Enter");
      const pending = browser.locator('[data-pending-steer="true"]').filter({ hasText: text });
      await expect(pending).toHaveCount(1);

      // Read the snapshot only once the server tracks the steer, so it is a valid
      // pre-delivery answer rather than racing the send response.
      const stale = (await browser.evaluate(async (needle: string) => {
        const deadline = performance.now() + 10_000;
        while (performance.now() < deadline) {
          const response = await fetch("/api/state", { cache: "no-store" });
          if (response.ok) {
            const snapshot = (await response.json()) as {
              steers?: { id?: string; text?: string }[];
            };
            if (snapshot.steers?.some((steer) => steer.text === needle)) {
              return snapshot as unknown as JsonValue;
            }
          }
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        return null;
      }, text)) as { steers?: { id?: string; text?: string }[] } | null;
      expect(stale).not.toBeNull();
      const tracked = stale?.steers?.find((steer) => steer.text === text);
      expect(tracked?.id).toBeTruthy();
      await expect(pending).toHaveAttribute(
        "data-message-id",
        `steer-pending-${tracked?.id ?? ""}`,
      );

      let serveStale = false;
      let served = 0;
      await browser.route("**/api/state**", async (route) => {
        if (!serveStale) {
          await route.continue();
          return;
        }
        served += 1;
        await route.fulfill({ json: stale as JsonValue });
      });

      writeFileSync(release, "");
      const delivered = browser.locator('[data-role="user"]').filter({ hasText: text });
      await expect(pending).toHaveCount(0, { timeout: 20_000 });
      await expect(delivered).toHaveCount(1);

      // The steer is already in the transcript. The older snapshot still lists it as
      // pending; its stale revision must not put that pending bubble back.
      serveStale = true;
      await browser.evaluate(() => {
        window.dispatchEvent(new Event("focus"));
        return true;
      });
      await expect.poll(() => served).toBeGreaterThan(0);
      await new Promise((resolve) => setTimeout(resolve, 250));
      await expect(pending).toHaveCount(0);
      await expect(delivered).toHaveCount(1);
    } finally {
      writeFileSync(release, "");
      await browser.evaluate(async () => {
        await fetch("/api/stop", { method: "POST" });
        return true;
      });
    }
  });
});
