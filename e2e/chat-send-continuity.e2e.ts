import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, test } from "@e2e-dev/web";
import { expect, type JsonValue } from "e2e";

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function openChat(
  app: { open: (path: string) => Promise<void> },
  browser: Browser,
): Promise<void> {
  await browser.addInitScript(`
    (() => {
      if (!("serviceWorker" in navigator)) return;
      Object.defineProperty(navigator.serviceWorker, "register", {
        configurable: true,
        value: async () => undefined,
      });
    })();
  `);
  await app.open("/");
}

/** Holds one state snapshot so it can land after a send has already painted its row. */
async function installStaleSnapshot(browser: Browser) {
  const stale = await browser.evaluate(async () => {
    const response = await fetch("/api/state", { cache: "no-store" });
    return (await response.json()) as JsonValue;
  });
  let serve = false;
  let served = false;
  await browser.route("**/api/state**", async (route) => {
    if (!serve) {
      await route.continue();
      return;
    }
    served = true;
    await route.fulfill({ json: stale });
  });
  return {
    async push(): Promise<void> {
      serve = true;
      served = false;
      await browser.evaluate(() => {
        window.dispatchEvent(new Event("focus"));
        return true;
      });
      const deadline = Date.now() + 5_000;
      while (!served && Date.now() < deadline) await sleep(25);
      expect(served).toBe(true);
      await sleep(200);
    },
    stop(): void {
      serve = false;
    },
  };
}

/** The message id of the first row matching a pending variant and the send text. */
function pendingRowId(browser: Browser, selector: string, text: string): Promise<string> {
  return browser.evaluate(
    ({ selector, needle }: { selector: string; needle: string }) => {
      const row = [...document.querySelectorAll<HTMLElement>(selector)].find((candidate) =>
        (candidate.textContent ?? "").includes(needle),
      );
      return row?.getAttribute("data-message-id") ?? "";
    },
    { selector, needle: text },
  );
}

function slowToolCall(release: string): string {
  const wait = `for i in $(seq 600); do [ -e '${release}' ] && break; sleep 0.1; done; echo released`;
  return `TOOLCALLS ${JSON.stringify([{ name: "bash", arguments: { command: wait } }])}`;
}

test("a sent bubble keeps its row from optimistic paint through a stale state push", async ({
  app,
  browser,
  screen,
}) => {
  await openChat(app, browser);
  const composer = screen.getByRole("textbox", "Message");
  await expect(composer).toBeVisible({ timeout: 30_000 });

  // A snapshot read before this send is still a valid server answer. Hold one
  // so it can land after the send commits, like a slow state read would.
  const stale = await installStaleSnapshot(browser);
  const text = `continuous send ${Date.now()}`;
  await browser.evaluate((needle: string) => {
    const state = { started: false, id: "", gaps: 0 };
    const target = window as unknown as {
      __sendWatch?: typeof state;
      __sendWatchObserver?: MutationObserver;
    };
    target.__sendWatch = state;
    const check = () => {
      const rows = [...document.querySelectorAll<HTMLElement>('[data-role="user"]')].filter((row) =>
        (row.textContent ?? "").includes(needle),
      );
      if (!state.started) {
        if (rows.length === 0) return;
        state.started = true;
        state.id = rows[0]?.getAttribute("data-message-id") ?? "";
        return;
      }
      const held =
        state.id === ""
          ? 0
          : document.querySelectorAll(`[data-message-id="${CSS.escape(state.id)}"]`).length;
      if (held !== 1) state.gaps += 1;
    };
    const observer = new MutationObserver(check);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    target.__sendWatchObserver = observer;
    check();
    return true;
  }, text);

  await composer.fill(text);
  await screen.getByRole("button", { name: "Send" }).tap();
  await expect(composer).toHaveValue("");
  await expect(screen.getByText(`Echo: ${text}`, { exact: false })).toBeVisible({
    timeout: 15_000,
  });
  await expect(browser.locator('[data-role="user"]').filter({ hasText: text })).toHaveCount(1);

  const painted = await browser.evaluate(() => {
    const target = window as unknown as {
      __sendWatch?: { started: boolean; id: string; gaps: number };
    };
    const state = target.__sendWatch;
    return {
      started: state?.started ?? false,
      id: state?.id ?? "",
      gaps: state?.gaps ?? -1,
    };
  });
  expect(painted.started).toBe(true);
  expect(painted.id).not.toBe("");
  await expect(browser.locator(`[data-message-id="${painted.id}"]`)).toHaveCount(1);

  // The late snapshot has no row for this send. It must not retire the bubble.
  await stale.push();
  await expect(browser.locator(`[data-message-id="${painted.id}"]`)).toHaveCount(1);
  await expect(browser.locator('[data-role="user"]').filter({ hasText: text })).toHaveCount(1);

  stale.stop();
  await browser.evaluate(() => {
    window.dispatchEvent(new Event("focus"));
    return true;
  });
  await expect(browser.locator(`[data-message-id="${painted.id}"]`)).toHaveCount(1);

  const watch = await browser.evaluate(() => {
    const target = window as unknown as {
      __sendWatch?: { started: boolean; id: string; gaps: number };
      __sendWatchObserver?: MutationObserver;
    };
    target.__sendWatchObserver?.disconnect();
    const state = target.__sendWatch;
    return {
      started: state?.started ?? false,
      id: state?.id ?? "",
      gaps: state?.gaps ?? -1,
    };
  });
  // The row kept the id it was painted with and never dropped to zero.
  expect(watch.id).toBe(painted.id);
  expect(watch.gaps, JSON.stringify(watch)).toBe(0);
});

test("a queued follow-up keeps its pending row through a stale state push", async ({
  app,
  browser,
  screen,
}) => {
  await openChat(app, browser);
  const release = join(tmpdir(), `pi-ui-continuity-queue-${randomUUID()}`);
  try {
    const composer = screen.getByRole("textbox", "Message");
    await composer.fill(slowToolCall(release));
    await screen.getByRole("button", { name: "Send" }).tap();
    await expect(screen.getByRole("button", { name: "Stop" })).toBeVisible({ timeout: 15_000 });

    const stale = await installStaleSnapshot(browser);
    const text = `queued through a stale push ${Date.now()}`;
    const key = `continuity-queue-${Date.now()}`;
    await browser.evaluate(
      async ({ text, key }: { text: string; key: string }) => {
        await fetch("/api/message", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text, mode: "queue", queueKey: key }),
        });
        return true;
      },
      { text, key },
    );
    const pending = browser.locator('[data-pending-queue="true"]').filter({ hasText: text });
    await expect(pending).toHaveCount(1);
    const id = await pendingRowId(browser, '[data-pending-queue="true"]', text);
    expect(id).not.toBe("");

    await stale.push();
    await expect(browser.locator(`[data-message-id="${id}"]`)).toHaveCount(1);
    await expect(pending).toHaveCount(1);
    await expect(browser.locator('[data-role="user"]').filter({ hasText: text })).toHaveCount(1);

    stale.stop();
    await browser.evaluate(() => {
      window.dispatchEvent(new Event("focus"));
      return true;
    });
    await expect(browser.locator(`[data-message-id="${id}"]`)).toHaveCount(1);
  } finally {
    writeFileSync(release, "");
    await browser.evaluate(async () => {
      await fetch("/api/stop", { method: "POST" });
      return true;
    });
  }
});

test("a steer keeps its pending row through a stale state push", async ({
  app,
  browser,
  screen,
}) => {
  await openChat(app, browser);
  const release = join(tmpdir(), `pi-ui-continuity-steer-${randomUUID()}`);
  try {
    const composer = screen.getByRole("textbox", "Message");
    await composer.fill(slowToolCall(release));
    await screen.getByRole("button", { name: "Send" }).tap();
    await expect(screen.getByRole("button", { name: "Stop" })).toBeVisible({ timeout: 15_000 });

    const stale = await installStaleSnapshot(browser);
    const text = `steer through a stale push ${Date.now()}`;
    await composer.fill(text);
    await screen.getByRole("button", { name: "Steer" }).tap();
    const pending = browser.locator('[data-pending-steer="true"]').filter({ hasText: text });
    await expect(pending).toHaveCount(1);
    const paintedId = await pendingRowId(browser, '[data-pending-steer="true"]', text);
    expect(paintedId).not.toBe("");
    // Wait for the response to replace the optimistic copy with the tracked steer.
    await expect
      .poll(
        async () =>
          (await pendingRowId(browser, '[data-pending-steer="true"]', text)) !== paintedId,
      )
      .toBe(true);
    const id = await pendingRowId(browser, '[data-pending-steer="true"]', text);
    expect(id).not.toBe("");

    await stale.push();
    await expect(browser.locator(`[data-message-id="${id}"]`)).toHaveCount(1);
    await expect(pending).toHaveCount(1);

    stale.stop();
    await browser.evaluate(() => {
      window.dispatchEvent(new Event("focus"));
      return true;
    });
    await expect(browser.locator(`[data-message-id="${id}"]`)).toHaveCount(1);
  } finally {
    writeFileSync(release, "");
    await browser.evaluate(async () => {
      await fetch("/api/stop", { method: "POST" });
      return true;
    });
  }
});
