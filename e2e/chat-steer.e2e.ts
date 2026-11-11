import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "@e2e-dev/web";
import { expect, type JsonValue } from "e2e";

test("shows one Stop while the field is empty, then one Steer while it has text", async ({
  app,
  browser,
  screen,
}) => {
  await app.open("/");
  const composer = screen.getByRole("textbox", "Message");
  const sendMark = await browser.evaluate(() => {
    const button = document.querySelector('button[aria-label="Send"]');
    const mark = button?.querySelector("svg");
    if (button == null || mark == null) return null;
    const box = mark.getBoundingClientRect();
    return {
      width: box.width,
      height: box.height,
      background: getComputedStyle(button).backgroundColor,
    };
  });
  expect(sendMark).not.toBeNull();
  expect(sendMark?.width).toBeGreaterThan(0);
  expect(sendMark?.width).toBeCloseTo(sendMark?.height ?? -1, 0);
  expect(
    sendMark?.background === "transparent" || sendMark?.background === "rgba(0, 0, 0, 0)",
  ).toBe(true);
  await composer.fill("SLOW response please");
  await screen.getByRole("button", "Send").tap();

  await expect(screen.getByRole("button", "Stop")).toHaveCount(1);
  await expect(screen.getByRole("button", "Stop")).toBeVisible();
  await expect(screen.getByRole("button", "Steer")).toHaveCount(0);
  const stopMark = await browser.evaluate(() => {
    const button = document.querySelector('button[aria-label="Stop"]');
    const mark = button?.querySelector("svg");
    const circle = mark?.querySelector("circle");
    const square = mark?.querySelector("rect");
    if (mark === null || mark === undefined || circle === null || circle === undefined) return null;
    if (square === null || square === undefined) return null;
    return {
      circle: getComputedStyle(circle).fill,
      ink: getComputedStyle(mark).color,
      square: getComputedStyle(square).fill,
    };
  });
  expect(stopMark).not.toBeNull();
  expect(stopMark?.circle).toBe(stopMark?.ink);
  expect(stopMark?.square).toBe("rgb(255, 255, 255)");
  const stopSize = await browser.evaluate(() => {
    const mark = document.querySelector('button[aria-label="Stop"] svg');
    if (mark == null) return null;
    const box = mark.getBoundingClientRect();
    return { width: box.width, height: box.height };
  });
  expect(stopSize?.width).toBeCloseTo(sendMark?.width ?? -1, 0);
  expect(stopSize?.height).toBeCloseTo(sendMark?.height ?? -1, 0);

  await expect(composer).toHaveAttribute("placeholder", "Message pi");
  await expect(screen.getByTestId("header-activity")).toHaveText("working");
  await expect(screen.getByTestId("working-detail")).toHaveCount(0);
  await expect(screen.getByTestId("working-status")).toHaveAttribute("data-open", "true");
  const status = await browser.evaluate(() => {
    const header = document.querySelector("header");
    const dock = document.querySelector("[data-testid=composer-dock]");
    const working = document.querySelector("[data-testid=working-status]");
    const dots = document.querySelector("[data-testid=page-dots]");
    const gear = document.querySelector("[data-pi-menu]");
    if (
      !(dock instanceof HTMLElement) ||
      !(working instanceof HTMLElement) ||
      !(dots instanceof HTMLElement) ||
      !(gear instanceof HTMLElement)
    ) {
      return null;
    }
    return {
      noHeader: header === null,
      inDock: dock.contains(working) && dock.contains(dots) && dock.contains(gear),
      statusLeftOfDots: working.getBoundingClientRect().right <= dots.getBoundingClientRect().left,
      gearRightOfDots: gear.getBoundingClientRect().left >= dots.getBoundingClientRect().right,
      gearLabel: gear.getAttribute("aria-label"),
    };
  });
  expect(status).not.toBeNull();
  expect(status?.noHeader).toBe(true);
  expect(status?.inDock).toBe(true);
  expect(status?.statusLeftOfDots).toBe(true);
  expect(status?.gearRightOfDots).toBe(true);
  expect(status?.gearLabel).toBe("Settings");

  await composer.fill("typed while running");
  await expect(screen.getByRole("button", "Stop")).toHaveCount(0);
  await expect(screen.getByRole("button", "Steer")).toHaveCount(1);
  await expect(screen.getByRole("button", "Steer")).toBeVisible();
  await expect(screen.getByRole("button", "Queue")).toHaveCount(0);

  await composer.fill("");
  await expect(screen.getByRole("button", "Stop")).toHaveCount(1);
  await expect(screen.getByRole("button", "Steer")).toHaveCount(0);
  await screen.getByRole("button", "Stop").tap();
  await expect(screen.getByRole("button", "Stop")).toHaveCount(0);
  await expect(screen.getByRole("button", "Send")).toHaveCount(1);
  await expect(screen.getByTestId("working-status")).toHaveAttribute("data-open", "false");
  await expect(screen.getByTestId("working-status")).toHaveText("idle");
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
    await expect(screen.getByText("Hold Steer to queue without interrupting the run.")).toHaveCount(
      0,
    );
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
    const element = [...document.querySelectorAll<HTMLElement>('[data-pending-steer="true"]')].find(
      (bubble) => (bubble.textContent ?? "").includes(needle),
    );
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

    const pendingRowId = () =>
      browser.evaluate((needle: string) => {
        const row = [...document.querySelectorAll<HTMLElement>('[data-pending-steer="true"]')].find(
          (candidate) => (candidate.textContent ?? "").includes(needle),
        );
        return row?.getAttribute("data-message-id") ?? "";
      }, text);
    // Wait for the send response to replace the optimistic copy with the tracked steer.
    const optimisticId = await pendingRowId();
    await expect.poll(async () => (await pendingRowId()) !== optimisticId).toBe(true);

    // A snapshot read while the steer is still pending is a valid server answer.
    const stale = await browser.evaluate(async () => {
      const response = await fetch("/api/state", { cache: "no-store" });
      return (await response.json()) as JsonValue;
    });
    let serveStale = false;
    let served = 0;
    await browser.route("**/api/state**", async (route) => {
      if (!serveStale) {
        await route.continue();
        return;
      }
      served += 1;
      await route.fulfill({ json: stale });
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
