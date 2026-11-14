import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, test } from "@e2e-dev/web";
import { expect, type JsonValue } from "e2e";

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
