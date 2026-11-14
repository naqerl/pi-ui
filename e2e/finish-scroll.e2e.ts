import { test } from "@e2e-dev/web";
import { expect } from "e2e";

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
  await screen.getByTestId("latest-button").tap();

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
  // Earlier messages and lazily loaded images can land above the reader; the transcript keeps
  // what is read in place while they do, so check the row in view, not the raw scroll offset.
  const reading = await browser.evaluate(async () => {
    const main = document.querySelector<HTMLElement>("main");
    if (main === null) return null;
    await Promise.all(
      [...main.querySelectorAll("img")].map((img) =>
        img.complete
          ? null
          : new Promise((resolve) => img.addEventListener("load", resolve, { once: true })),
      ),
    );
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const top = main.getBoundingClientRect().top;
    const rows = [...(main.firstElementChild?.children ?? [])] as HTMLElement[];
    const row = rows.find((item) => item.getBoundingClientRect().top >= top - 1);
    if (row === undefined) return null;
    row.dataset.reading = "";
    return {
      offset: Math.round(row.getBoundingClientRect().top - top),
      atEnd: main.scrollHeight - main.scrollTop - main.clientHeight < 4,
    };
  });
  expect(reading?.atEnd).toBe(false);
  await expect(screen.getByRole("button", "Send")).toBeVisible({ timeout: 20_000 });
  await new Promise((resolve) => setTimeout(resolve, 400));
  const after = await browser.evaluate(() => {
    const main = document.querySelector<HTMLElement>("main");
    const row = document.querySelector<HTMLElement>("[data-reading]");
    if (main === null || row === null) return null;
    return Math.round(row.getBoundingClientRect().top - main.getBoundingClientRect().top);
  });
  expect(after).not.toBeNull();
  expect(Math.abs((after ?? 0) - (reading?.offset ?? 0))).toBeLessThanOrEqual(2);
});
