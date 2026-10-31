import { test } from "@e2e-dev/web";
import { expect } from "e2e";

/** Where the start of the last reply (or the run info row above it) sits in the transcript. */
function replyPosition() {
  const bubbles = [...document.querySelectorAll<HTMLElement>('[data-role="assistant"]')];
  const bubble = bubbles.at(-1);
  const main = document.querySelector<HTMLElement>("main");
  if (bubble === undefined || main === null) return null;
  const previous = bubble.previousElementSibling;
  const target =
    previous instanceof HTMLElement && previous.dataset.testid === "run-info" ? previous : bubble;
  return {
    gap: Math.round(target.getBoundingClientRect().top - main.getBoundingClientRect().top),
    atEnd: main.scrollHeight - main.scrollTop - main.clientHeight < 4,
    latest: [...document.querySelectorAll("button")].some(
      (button) => button.textContent?.trim() === "↓ latest",
    ),
  };
}

for (const width of [390, 1280]) {
  test(`shows a finished reply from its start at ${width}px`, async ({ app, browser, screen }) => {
    await browser.setViewport({ width, height: 844 });
    await app.open("/");
    const composer = screen.getByRole("textbox", "Message");
    await composer.fill(`LONG answer please ${width}`);
    await screen.getByRole("button", "Send").tap();
    const latestReply = browser.locator('[data-role="assistant"]').last();
    await expect(
      latestReply.getByText("Paragraph 40 of a long answer", { exact: false }),
    ).toBeVisible({
      timeout: 15_000,
    });
    await expect(screen.getByRole("button", "Send")).toBeVisible({ timeout: 15_000 });
    await new Promise((resolve) => setTimeout(resolve, 400));
    const position = await browser.evaluate(replyPosition);
    expect(position).not.toBeNull();
    // 16px below the top of the transcript, like the first message in a fresh transcript.
    expect(Math.abs((position?.gap ?? 0) - 16)).toBeLessThanOrEqual(2);
    expect(position?.atEnd).toBe(false);
    expect(position?.latest).toBe(true);

    await screen.getByRole("button", "↓ latest").tap();
    const after = await browser.evaluate(replyPosition);
    expect(after?.atEnd).toBe(true);
  });
}

test("leaves the scroll alone when the reader scrolled away during the run", async ({
  app,
  browser,
  screen,
}) => {
  await browser.setViewport({ width: 390, height: 844 });
  await app.open("/");
  // Enough history above to scroll into.
  const composer = screen.getByRole("textbox", "Message");
  await composer.fill("LONG warm up");
  await screen.getByRole("button", "Send").tap();
  await expect(screen.getByRole("button", "Send")).toBeVisible({ timeout: 15_000 });
  await new Promise((resolve) => setTimeout(resolve, 400));
  await screen.getByRole("button", "↓ latest").tap();

  await composer.fill("LONGDRIP reply while I read");
  await screen.getByRole("button", "Send").tap();
  // Wait until the slow reply is streaming.
  await expect(screen.getByText("LONGDRIP reply while I read", { exact: true })).toBeVisible();
  await new Promise((resolve) => setTimeout(resolve, 800));
  expect(
    await browser.evaluate(
      () =>
        document.querySelector('button[aria-label="Stop"], button[aria-label="Steer"]') !== null,
    ),
  ).toBe(true);
  const scrolled = await browser.evaluate(() => {
    const main = document.querySelector<HTMLElement>("main");
    if (main === null) return -1;
    main.scrollTop = 200;
    main.dispatchEvent(new Event("scroll"));
    return main.scrollTop;
  });
  expect(scrolled).toBe(200);
  // Images from earlier tests load lazily once scrolled near, and the transcript keeps what is
  // read in place while they grow, so measure from where the scroll settles.
  const reading = await browser.evaluate(async () => {
    const main = document.querySelector<HTMLElement>("main");
    if (main === null) return -1;
    await Promise.all(
      [...main.querySelectorAll("img")].map((img) =>
        img.complete
          ? null
          : new Promise((resolve) => img.addEventListener("load", resolve, { once: true })),
      ),
    );
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return main.scrollTop;
  });
  expect(reading).toBeGreaterThan(100);
  await expect(screen.getByRole("button", "Send")).toBeVisible({ timeout: 20_000 });
  await new Promise((resolve) => setTimeout(resolve, 400));
  const top = await browser.evaluate(
    () => document.querySelector<HTMLElement>("main")?.scrollTop ?? -1,
  );
  expect(Math.abs(top - reading)).toBeLessThanOrEqual(2);
});
