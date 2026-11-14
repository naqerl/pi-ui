import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, test } from "@e2e-dev/web";
import { expect } from "e2e";

describe("queued follow-ups against one shared app", { serial: true }, () => {
  beforeEach(async ({ browser }) => {
    await browser.unrouteAll();
  });

  test("shows queued follow-ups immediately, cancels one, and keeps the survivor's id", async ({
    app,
    browser,
    screen,
  }) => {
    await app.open("/");
    const tag = Date.now();
    const release = join(tmpdir(), `pi-ui-chat-queue-${tag}-${randomUUID()}`);
    const wait = `for i in $(seq 600); do [ -e '${release}' ] && break; sleep 0.1; done; echo released`;
    const calls = [{ name: "bash", arguments: { command: wait } }];
    const composer = screen.getByRole("textbox", "Message");
    await composer.fill(`TOOLCALLS ${JSON.stringify(calls)}`);
    await screen.getByRole("button", "Send").tap();
    await expect(screen.getByRole("button", "Stop")).toBeVisible();

    const first = `queued first ${tag}`;
    const second = `queued second ${tag}`;
    const queued = await browser.evaluate(
      async ({ texts }: { texts: string[] }) => {
        const answers = [];
        for (const text of texts) {
          const response = await fetch("/api/message", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text, mode: "queue" }),
          });
          answers.push(await response.json());
        }
        return answers as { queued: boolean; placed: boolean; queue: { id: string }[] }[];
      },
      { texts: [first, second] },
    );
    expect(queued.every((item) => item.queued && !item.placed)).toBe(true);

    const pending = browser.locator('[data-pending-queue="true"]');
    await expect(pending).toHaveCount(2);
    await expect(pending.nth(0)).toContainText(first);
    await expect(pending.nth(1)).toContainText(second);
    const ids = await browser.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('[data-pending-queue="true"]')].map((bubble) =>
        bubble.getAttribute("data-message-id"),
      ),
    );
    expect(ids[0]).not.toBeNull();
    expect(ids[1]).not.toBeNull();

    // Cancelling the first removes exactly that bubble and leaves the second in order.
    await pending.nth(0).getByRole("button", { name: "cancel" }).tap();
    await expect(pending).toHaveCount(1);
    await expect(pending.nth(0)).toContainText(second);

    // Watch the handoff: the bubble must never vanish between pending and placed.
    await browser.evaluate((needle: string) => {
      const watch = { gap: false };
      const target = window as unknown as {
        __queueWatch?: { gap: boolean };
        __queueObserver?: MutationObserver;
      };
      target.__queueWatch = watch;
      const check = () => {
        const bubbles = [...document.querySelectorAll<HTMLElement>("[data-message-id]")];
        if (!bubbles.some((bubble) => (bubble.textContent ?? "").includes(needle))) {
          watch.gap = true;
        }
      };
      const observer = new MutationObserver(check);
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });
      target.__queueObserver = observer;
      check();
      return true;
    }, second);

    writeFileSync(release, "");
    await expect(screen.getByText(`Echo: ${second}`, { exact: false })).toBeVisible({
      timeout: 20_000,
    });
    await expect(screen.getByRole("button", { name: "Send" })).toBeVisible({ timeout: 15_000 });
    await expect(pending).toHaveCount(0);
    await expect(screen.getByText(first, { exact: true })).toHaveCount(0);
    const survivorId = ids[1] as string;
    await expect(browser.locator(`[data-message-id="${survivorId}"]`)).toHaveCount(1);
    await expect(browser.locator('[data-role="user"]').filter({ hasText: second })).toHaveCount(1);
    const gap = await browser.evaluate(() => {
      const target = window as unknown as {
        __queueWatch?: { gap: boolean };
        __queueObserver?: MutationObserver;
      };
      target.__queueObserver?.disconnect();
      return target.__queueWatch?.gap ?? false;
    });
    expect(gap).toBe(false);
  });

  test("keeps the client key on a send that loses the start race", async ({
    app,
    browser,
    screen,
  }) => {
    await app.open("/");
    await expect(screen.getByRole("button", { name: "Send" })).toBeVisible({ timeout: 15_000 });
    const tag = Date.now();
    const first = { text: `parallel A ${tag}`, queueKey: `race-a-${tag}` };
    const second = { text: `parallel B ${tag}`, queueKey: `race-b-${tag}` };
    const answers = await browser.evaluate(
      async ({ requests }: { requests: { text: string; queueKey: string }[] }) => {
        return Promise.all(
          requests.map(async (request) => {
            const response = await fetch("/api/message", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                text: request.text,
                mode: "queue",
                queueKey: request.queueKey,
              }),
            });
            return {
              request,
              body: (await response.json()) as {
                queued: boolean;
                placed: boolean;
                queue: { id: string; text: string; key?: string }[];
              },
            };
          }),
        );
      },
      { requests: [first, second] },
    );

    const queued = answers.filter((answer) => answer.body.queued);
    expect(queued.length).toBeGreaterThanOrEqual(1);
    for (const answer of queued) {
      const item = answer.body.queue.find((candidate) => candidate.text === answer.request.text);
      expect(item?.key).toBe(answer.request.queueKey);
    }
    for (const request of [first, second]) {
      await expect(
        browser.locator('[data-role="user"]').filter({ hasText: request.text }),
      ).toHaveCount(1);
    }

    await browser.evaluate(async () => {
      await fetch("/api/stop", { method: "POST" });
      return true;
    });
    await expect(screen.getByRole("button", { name: "Send" })).toBeVisible({ timeout: 15_000 });
  });

  test("keeps the composer focused after send on a coarse-pointer mobile viewport", async ({
    app,
    browser,
    screen,
  }) => {
    await browser.setViewport({ width: 390, height: 844 });
    await browser.addInitScript(`
    (() => {
      const original = window.matchMedia.bind(window);
      window.matchMedia = (query) => {
        if (query !== "(pointer: coarse)") return original(query);
        return {
          matches: true,
          media: query,
          onchange: null,
          addListener() {},
          removeListener() {},
          addEventListener() {},
          removeEventListener() {},
          dispatchEvent() { return false; },
        };
      };
    })();
  `);
    await app.open("/");
    const composer = screen.getByRole("textbox", "Message");
    await composer.fill("MOBILE blur");
    await composer.press("Enter");

    await expect(screen.getByText("Echo: MOBILE blur", { exact: false })).toBeVisible({
      timeout: 15_000,
    });
    const activeTag = await browser.evaluate(() => document.activeElement?.tagName ?? "");
    expect(activeTag).toBe("TEXTAREA");
  });
});
