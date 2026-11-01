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

/** The transcript ids currently rendered, in DOM order. */
function renderedMessageIds() {
  return [...document.querySelectorAll<HTMLElement>("[data-message-id]")].map(
    (element) => element.dataset.messageId ?? "",
  );
}

/** The chat transcript in server order, without the job results the chat moves to activity. */
async function transcriptMessageIds() {
  const response = await fetch("/api/state?from=0");
  const state = (await response.json()) as {
    messages: { id: string; notice?: { kind?: string; label?: unknown } | null }[];
  };
  return state.messages
    .filter((message) => {
      const notice = message.notice;
      if (notice === null || notice === undefined) return true;
      const queued = "label" in notice && typeof notice.label === "string";
      return queued || notice.kind !== "job";
    })
    .map((message) => message.id);
}

function scrollToTop() {
  const main = document.querySelector<HTMLElement>("main");
  if (main === null) return false;
  main.scrollTop = 0;
  return true;
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
    const first = await browser.evaluate(renderedMessageIds);
    const transcript = await browser.evaluate(transcriptMessageIds);
    // The first paint is the newest window, not the whole transcript.
    expect(first.length).toBeGreaterThan(0);
    expect(first.length).toBeLessThan(transcript.length);
    expect(first).toEqual(transcript.slice(-first.length));
    expect(new Set(first).size).toBe(first.length);

    expect(await browser.evaluate(scrollToTop)).toBe(true);
    for (let attempt = 0; attempt < 100; attempt++) {
      if ((await browser.evaluate(renderedMessageIds)).length > first.length) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
      // Nudge the sentinel again in case the first scroll landed before it observed.
      if (attempt % 20 === 19) await browser.evaluate(scrollToTop);
    }
    const loaded = await browser.evaluate(renderedMessageIds);
    expect(loaded.length).toBeGreaterThan(first.length);
    const full = await browser.evaluate(transcriptMessageIds);
    // The older page is prepended: what is loaded stays an ordered suffix of the
    // transcript, keeps the newest page at the end, and has no duplicate ids.
    expect(loaded).toEqual(full.slice(-loaded.length));
    expect(loaded.slice(-first.length)).toEqual(first);
    expect(new Set(loaded).size).toBe(loaded.length);
  });
}
