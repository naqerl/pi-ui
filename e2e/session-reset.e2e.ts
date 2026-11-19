import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, test } from "@e2e-dev/web";
import { expect, type Screen } from "e2e";

async function openChat(
  app: { open: (path: string) => Promise<void> },
  browser: { addInitScript: (script: () => void) => Promise<void> },
  path = "/",
) {
  await browser.addInitScript(() => {
    if (!("serviceWorker" in navigator)) return;
    Object.defineProperty(navigator.serviceWorker, "register", {
      configurable: true,
      value: async () => undefined,
    });
  });
  await app.open(path);
}

async function resetFromSettings(screen: Screen) {
  await screen.getByRole("button", "Settings").tap();
  await screen.getByTestId("reset-session").tap();
}

async function snapshot(browser: { evaluate: <T>(fn: () => Promise<T>) => Promise<T> }) {
  return browser.evaluate(async () => {
    const response = await fetch("/api/state", { cache: "no-store" });
    return (await response.json()) as {
      messages?: { kind?: string; text?: string }[];
      activity?: unknown[];
      resetAt?: string;
    };
  });
}

describe("session reset", () => {
  beforeEach(async ({ browser }) => {
    await browser.unrouteAll();
    await browser.setViewport({ width: 1280, height: 900 });
  });

  test("an idle reset leaves one reset row and an empty activity list", async ({
    app,
    browser,
    screen,
  }) => {
    await openChat(app, browser);
    const text = `before session reset ${Date.now()}`;
    const composer = screen.getByRole("textbox", "Message");
    await composer.fill(text);
    await screen.getByRole("button", "Send").tap();
    await expect(screen.getByText(`Echo: ${text}`, { exact: false })).toBeVisible({
      timeout: 15_000,
    });

    await resetFromSettings(screen);

    const reset = browser.locator('[data-testid="session-reset"]');
    await expect(reset).toHaveCount(1);
    await expect(reset).toContainText("Session context reset");
    await expect(screen.getByText("Session context reset", { exact: true })).toBeVisible();
    await expect(screen.getByText(`Echo: ${text}`, { exact: false })).toHaveCount(0);
    await expect(browser.locator("[data-message-id]")).toHaveCount(1);

    const state = await snapshot(browser);
    expect(state.messages?.map((message) => message.kind)).toEqual(["session-reset"]);
    expect(state.messages?.[0]?.text).toBe("Session context reset");
    expect(state.activity ?? []).toHaveLength(0);
    expect(Number.isFinite(Date.parse(state.resetAt ?? ""))).toBe(true);
  });

  test("a reset during a live run waits for the post-tools boundary", async ({
    app,
    browser,
    screen,
  }) => {
    await openChat(app, browser);
    const tag = Date.now();
    const release = join(tmpdir(), `pi-ui-session-reset-${tag}-${randomUUID()}`);
    const wait = `for i in $(seq 600); do [ -e '${release}' ] && break; sleep 0.1; done; echo released`;
    const calls = [{ name: "bash", arguments: { command: wait } }];
    const composer = screen.getByRole("textbox", "Message");
    try {
      await composer.fill(`TOOLCALLS ${JSON.stringify(calls)}`);
      await screen.getByRole("button", { name: "Send" }).tap();
      await expect(screen.getByRole("button", { name: "Stop" })).toBeVisible();
      await expect(browser.locator('[data-testid="run-info"]')).toBeVisible({ timeout: 15_000 });
      await expect(browser.locator('[data-testid="session-reset"]')).toHaveCount(0);

      await resetFromSettings(screen);
      await new Promise((resolve) => setTimeout(resolve, 500));
      await expect(screen.getByRole("button", { name: "Stop" })).toBeVisible();
      await expect(browser.locator('[data-testid="session-reset"]')).toHaveCount(0);

      writeFileSync(release, "");
      const reset = browser.locator('[data-testid="session-reset"]');
      await expect(reset).toHaveCount(1, { timeout: 20_000 });
      await expect(reset).toContainText("Session context reset");
      await expect(screen.getByRole("button", { name: "Send" })).toBeVisible({
        timeout: 20_000,
      });
      await expect(browser.locator("[data-message-id]")).toHaveCount(1);
      await expect(screen.getByTestId("run-error-message")).toHaveCount(0);
      expect((await snapshot(browser)).activity ?? []).toHaveLength(0);
    } finally {
      writeFileSync(release, "");
      await browser.evaluate(async () => {
        await fetch("/api/stop", { method: "POST" });
        return true;
      });
    }
  });

  test("a second tab that missed the frame reconciles from resetAt", async ({
    app,
    browser,
    screen,
  }) => {
    await openChat(app, browser);
    const text = `second tab ${Date.now()}`;
    const composer = screen.getByRole("textbox", "Message");
    await composer.fill(text);
    await screen.getByRole("button", { name: "Send" }).tap();
    await expect(screen.getByText(`Echo: ${text}`, { exact: false })).toBeVisible({
      timeout: 15_000,
    });

    await browser.route("**/api/stream", async (route) => {
      await route.abort();
    });
    await browser.evaluate(() => {
      const host = window as typeof window & { __secondTab?: Window | null };
      host.__secondTab = null;
      const button = document.createElement("button");
      button.id = "open-second-tab";
      button.textContent = "open second tab";
      button.style.cssText =
        "position:fixed;top:8px;left:8px;z-index:2147483647;padding:8px;background:white;color:black;border:1px solid black;";
      button.addEventListener("click", () => {
        host.__secondTab = window.open("/", "pi-ui-second-tab");
      });
      document.body.appendChild(button);
      return true;
    });
    await browser.locator("#open-second-tab").click();

    const child = (needle: string, wantReset: boolean) =>
      browser.evaluate(
        async ({ needle, wantReset }) => {
          const host = window as typeof window & { __secondTab?: Window | null };
          const tab = host.__secondTab;
          if (!tab) return { open: false, stale: false, reset: false };
          const deadline = performance.now() + 20_000;
          while (performance.now() < deadline) {
            try {
              const doc = tab.document;
              const transcript = doc.body?.textContent ?? "";
              const reset = doc.querySelectorAll('[data-testid="session-reset"]').length;
              const stale = transcript.includes(needle);
              if (
                doc.readyState === "complete" &&
                ((wantReset && reset === 1) || (!wantReset && stale))
              ) {
                return { open: true, stale, reset };
              }
            } catch {}
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          return { open: true, stale: false, reset: 0 };
        },
        { needle, wantReset },
      );

    await expect.poll(async () => (await child(text, false)).stale, { timeout: 20_000 }).toBe(true);
    expect((await child(text, false)).reset).toBe(0);

    await resetFromSettings(screen);
    await expect(browser.locator('[data-testid="session-reset"]')).toHaveCount(1);
    expect((await child(text, false)).stale).toBe(true);

    await browser.evaluate(() => {
      const host = window as typeof window & { __secondTab?: Window | null };
      host.__secondTab?.dispatchEvent(new Event("focus"));
      return true;
    });
    await expect.poll(async () => (await child(text, true)).reset, { timeout: 20_000 }).toBe(1);
    expect((await child(text, true)).stale).toBe(false);

    await browser.evaluate(() => {
      const host = window as typeof window & { __secondTab?: Window | null };
      host.__secondTab?.location.reload();
      return true;
    });
    await expect.poll(async () => (await child(text, true)).reset, { timeout: 20_000 }).toBe(1);
    expect((await child(text, true)).stale).toBe(false);

    await browser.evaluate(() => {
      const host = window as typeof window & { __secondTab?: Window | null };
      host.__secondTab?.close();
      return true;
    });
  });
});
