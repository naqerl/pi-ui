import { test } from "@e2e-dev/web";
import { expect } from "e2e";

const lastAssistant = () =>
  [...document.querySelectorAll<HTMLElement>('[data-role="assistant"]')].at(-1)?.textContent ?? "";

for (const width of [390, 1280]) {
  test(`a background job tells the agent when it finishes (${width}px)`, async ({
    app,
    browser,
    screen,
  }) => {
    await browser.setViewport({ width, height: width === 390 ? 844 : 900 });
    await app.open("/");
    const marker = `job-output-${width}`;
    await screen.getByRole("textbox", "Message").fill(`JOBSTART sleep 1; echo ${marker}; exit 4`);
    await screen.getByRole("button", "Send").tap();
    await expect
      .poll(
        () =>
          browser.evaluate(
            (text) =>
              [...document.querySelectorAll('[data-role="assistant"]')].some(
                (node) =>
                  node.textContent?.includes("Tool result: Started j") &&
                  node.textContent.includes(text),
              ),
            marker,
          ),
        { timeout: 15_000 },
      )
      .toBe(true);
    // The finish notice arrives as a new turn; the fake model echoes it back.
    await expect
      .poll(() => browser.evaluate(lastAssistant), { timeout: 20_000 })
      .toContain("[background job");
    const reply = await browser.evaluate(lastAssistant);
    expect(reply).toContain("exited 4");
    expect(reply).toContain(marker);
  });
}
