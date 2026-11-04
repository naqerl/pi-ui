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
            body: JSON.stringify({ text: request.text, mode: "queue", queueKey: request.queueKey }),
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

type Bubble = { text: string; pending: boolean; role: string };
type Browser = { evaluate: <T>(fn: () => T) => Promise<T> };

/** The page's visible text runs in document order. */
async function textRuns(browser: Browser): Promise<string[]> {
  return browser.evaluate(() => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const runs: string[] = [];
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const text = node.textContent?.trim();
      if (text) runs.push(text);
    }
    return runs;
  });
}

/** Where the last answer starts; markdown can split it over several text nodes. */
function lastEcho(runs: string[]): number {
  for (let index = runs.length - 1; index >= 0; index -= 1) {
    if (runs[index]?.startsWith("Echo")) return index;
  }
  return -1;
}

async function bubbles(browser: { evaluate: <T>(fn: () => T) => Promise<T> }): Promise<Bubble[]> {
  return browser.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>("[data-message-id]")].map((element) => ({
      text: element.textContent ?? "",
      pending: element.dataset.pendingSteer === "true",
      role: element.dataset.role ?? "",
    })),
  );
}

// Steers sent during a tool call go in together right after it, in the order sent, and show in
// the transcript where they went in. Before, durable placed one per turn boundary, so the second
// steer started a run of its own after the answer to the first.
test("steers sent during a tool call all arrive right after it, in order", async ({
  app,
  browser,
  screen,
}) => {
  await app.open("/");
  const tag = Date.now();
  // The tool waits until the test has seen both steers pending, however slow the machine.
  const release = join(tmpdir(), `pi-ui-steers-${tag}-${randomUUID()}`);
  const wait = `for i in $(seq 600); do [ -e '${release}' ] && break; sleep 0.1; done; echo released`;
  const calls = [{ name: "bash", arguments: { command: wait } }];
  const composer = screen.getByRole("textbox", "Message");
  await composer.fill(`TOOLCALLS ${JSON.stringify(calls)}`);
  await screen.getByRole("button", "Send").tap();
  await expect(screen.getByRole("button", "Stop")).toBeVisible();

  await composer.fill(`alpha ${tag}`);
  await composer.press("Enter");
  await composer.fill(`beta ${tag}`);
  await composer.press("Enter");

  // Waiting for the tool: both show as pending steers below the run's work.
  await expect
    .poll(async () => (await bubbles(browser)).filter((item) => item.pending).length)
    .toBe(2);
  const pending = (await bubbles(browser)).slice(-2);
  expect(pending[0]?.text).toContain(`alpha ${tag}`);
  expect(pending[1]?.text).toContain(`beta ${tag}`);
  expect(pending[0]?.text).toContain("steer · pending");
  writeFileSync(release, "");

  // Both go in after the tool round; the model answers them in the same run.
  await expect(screen.getByText(`Echo: beta ${tag}`, { exact: false })).toBeVisible({
    timeout: 20_000,
  });
  await expect(screen.getByRole("button", "Send")).toBeVisible({ timeout: 15_000 });
  await expect(screen.getByText(`Echo: alpha ${tag}`, { exact: false })).toHaveCount(0);
  const final = await bubbles(browser);
  expect(final.some((item) => item.pending)).toBe(false);
  const alpha = final.find((item) => item.text.includes(`alpha ${tag}`));
  expect(alpha?.text).toContain("steer");
  expect(alpha?.text).not.toContain("pending");
  const runs = await textRuns(browser);
  const index = (needle: string) => runs.findIndex((run) => run.startsWith(needle));
  expect(index("1 tool call")).toBeGreaterThan(-1);
  expect(index("1 tool call")).toBeLessThan(index(`alpha ${tag}`));
  expect(index(`alpha ${tag}`)).toBeLessThan(index(`beta ${tag}`));
  expect(index(`beta ${tag}`)).toBeLessThan(lastEcho(runs));

  // A reload shows the same order from the server.
  await app.open("/");
  await expect(screen.getByText(`Echo: beta ${tag}`, { exact: false })).toBeVisible();
  const reloaded = await textRuns(browser);
  const at = (needle: string) => reloaded.findIndex((run) => run.startsWith(needle));
  expect(at(`alpha ${tag}`)).toBeGreaterThan(-1);
  expect(at(`alpha ${tag}`)).toBeLessThan(at(`beta ${tag}`));
  expect(at(`beta ${tag}`)).toBeLessThan(lastEcho(reloaded));
});

test("ArrowUp in an empty composer takes back the newest pending steer", async ({
  app,
  browser,
  screen,
}) => {
  await app.open("/");
  const tag = Date.now();
  const composer = screen.getByRole("textbox", "Message");
  await composer.fill("SLOW response please");
  await screen.getByRole("button", "Send").tap();
  await expect(screen.getByRole("button", "Stop")).toBeVisible();

  try {
    await composer.fill(`first ${tag}`);
    await composer.press("Enter");
    await composer.fill(`second ${tag}`);
    await composer.press("Enter");
    await expect
      .poll(async () => (await bubbles(browser)).filter((item) => item.pending).length)
      .toBe(2);

    await composer.press("ArrowUp");
    await expect(composer).toHaveValue(`second ${tag}`);
    await expect
      .poll(async () => (await bubbles(browser)).filter((item) => item.pending).length)
      .toBe(1);
    const left = (await bubbles(browser)).filter((item) => item.pending);
    expect(left[0]?.text).toContain(`first ${tag}`);

    // With text in the composer ArrowUp is the caret's again.
    await composer.press("ArrowUp");
    await expect(composer).toHaveValue(`second ${tag}`);
    await expect
      .poll(async () => (await bubbles(browser)).filter((item) => item.pending).length)
      .toBe(1);

    await composer.fill("");
    await composer.press("ArrowUp");
    await expect(composer).toHaveValue(`first ${tag}`);
    await expect
      .poll(async () => (await bubbles(browser)).filter((item) => item.pending).length)
      .toBe(0);

    // The server dropped them too: another tab sees none.
    const state = await browser.evaluate(async () => {
      const response = await fetch("/api/state");
      const snapshot = (await response.json()) as { steers?: unknown[] };
      return { steers: snapshot.steers?.length ?? -1 };
    });
    expect(state.steers).toBe(0);

    // Sending it again makes it pending again.
    await composer.press("Enter");
    await expect(composer).toHaveValue("");
    await expect
      .poll(async () => (await bubbles(browser)).filter((item) => item.pending).length)
      .toBe(1);
  } finally {
    const stop = screen.getByRole("button", "Stop");
    if ((await stop.count()) > 0) await stop.tap();
  }
  await expect(screen.getByRole("button", "Send")).toBeVisible();
  await expect(screen.getByText(`Echo: second ${tag}`, { exact: false })).toHaveCount(0);
});
