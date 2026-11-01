import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "@e2e-dev/web";
import { expect } from "e2e";

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

test("blurs the composer after send on a coarse-pointer mobile viewport", async ({
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
  expect(activeTag).not.toBe("TEXTAREA");
});

test("keeps the composer height and bottom edge when the viewport height changes", async ({
  app,
  browser,
  screen,
}) => {
  await app.open("/");
  const composer = screen.getByRole("textbox", "Message");
  const before = await composer.boundingBox();
  expect(before).not.toBeNull();

  await browser.setViewport({ width: 390, height: 500 });
  const geometry = await browser.evaluate(async () => {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
    const element = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]');
    if (element === null) return null;
    const box = element.getBoundingClientRect();
    const footer = document.querySelector('[data-testid="composer-dock"]')?.getBoundingClientRect();
    return {
      height: box.height,
      bottom: box.bottom,
      viewportHeight: window.innerHeight,
      viewportWidth: window.innerWidth,
      footerLeft: footer?.left ?? null,
      footerRight: footer?.right ?? null,
      endTop: (() => {
        const main = document.querySelector("main");
        const content = main?.firstElementChild;
        if (main == null || content == null) return null;
        return Number.parseFloat(getComputedStyle(content).paddingTop);
      })(),
      endBottom: (() => {
        const main = document.querySelector("main");
        const content = main?.firstElementChild;
        if (main == null || content == null || footer == null) return null;
        const mainBox = main.getBoundingClientRect();
        return (
          Number.parseFloat(getComputedStyle(content).paddingBottom) - (mainBox.bottom - footer.top)
        );
      })(),
    };
  });

  expect(geometry).not.toBeNull();
  expect(geometry?.height ?? 0).toBeCloseTo(before?.height ?? 0, 0);
  expect(geometry?.bottom ?? 0).toBeLessThanOrEqual((geometry?.viewportHeight ?? 0) + 1);
  expect(Math.abs(geometry?.footerLeft ?? 1)).toBeLessThanOrEqual(1);
  expect(
    Math.abs((geometry?.footerRight ?? 0) - (geometry?.viewportWidth ?? 0)),
  ).toBeLessThanOrEqual(1);
  expect(geometry?.endTop ?? 0).toBeCloseTo(16, 0);
  expect(geometry?.endBottom ?? 0).toBeCloseTo(16, 0);
});
