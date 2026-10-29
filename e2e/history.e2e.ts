import { test } from "@e2e-dev/web";
import { expect } from "e2e";

/** Sends one BULK prompt straight to the API and waits for its whole reply. */
async function sendBulk(turn: number) {
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const response = await fetch("/api/message", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: `BULK ${turn} please`, mode: "queue" }),
  });
  if (!response.ok) return false;
  for (let attempt = 0; attempt < 300; attempt++) {
    await sleep(50);
    const state = await (await fetch("/api/state?limit=4")).json();
    if (
      state.run === "idle" &&
      state.messages.some((message: { text: string }) => message.text.includes(`Bulk end ${turn}`))
    ) {
      return true;
    }
  }
  return false;
}

function bubbleCount() {
  return document.querySelectorAll("[data-message-id]").length;
}

/** Scrolls to the top and reports the first bubble that starts inside the scroller. */
function scrollToTopAndPick() {
  const main = document.querySelector<HTMLElement>("main");
  if (main === null) return null;
  main.scrollTop = 0;
  const top = main.getBoundingClientRect().top;
  const first = [...document.querySelectorAll<HTMLElement>("[data-message-id]")].find(
    (element) => element.getBoundingClientRect().top >= top,
  );
  if (first === undefined) return null;
  (window as unknown as { __anchor: string }).__anchor = first.dataset.messageId ?? "";
  return Math.round(first.getBoundingClientRect().top);
}

function anchorTop() {
  const id = (window as unknown as { __anchor: string }).__anchor;
  const element = document.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(id)}"]`);
  return element === null ? null : Math.round(element.getBoundingClientRect().top);
}

for (const width of [390, 1280]) {
  test(`loads the latest page first and older pages on scroll up at ${width}px`, async ({
    app,
    browser,
    screen,
  }) => {
    await browser.setViewport({ width, height: 844 });
    await app.open("/");
    const base = width * 1000;
    for (let turn = 1; turn <= 24; turn++) {
      expect(await browser.evaluate(sendBulk, base + turn)).toBe(true);
    }

    await app.open("/");
    await expect(screen.getByText("Earlier messages", { exact: true })).toBeVisible({
      timeout: 15_000,
    });
    const first = await browser.evaluate(bubbleCount);
    // One page: thirty messages, stretched back to the user message that starts the run.
    expect(first).toBeGreaterThanOrEqual(30);
    expect(first).toBeLessThanOrEqual(32);

    let before = await browser.evaluate(scrollToTopAndPick);
    expect(before).not.toBeNull();
    for (let attempt = 0; attempt < 100; attempt++) {
      if ((await browser.evaluate(bubbleCount)) > first) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
      // Nudge the sentinel again in case the first scroll landed before it observed.
      if (attempt % 20 === 19) before = await browser.evaluate(scrollToTopAndPick);
    }
    expect(await browser.evaluate(bubbleCount)).toBeGreaterThan(first);
    await new Promise((resolve) => setTimeout(resolve, 300));
    // The message the reader was looking at did not move.
    const after = await browser.evaluate(anchorTop);
    expect(after).not.toBeNull();
    expect(Math.abs((after ?? 0) - (before ?? 0))).toBeLessThanOrEqual(2);
  });
}
