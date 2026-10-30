import { test } from "@e2e-dev/web";
import { expect } from "e2e";

// A model stream that stays open without output (SLOW holds it with keepalives) used to show a
// bare "working" with nothing moving. The strip now counts the run's time, says how long the
// agent has been quiet, and the server's watchdog leaves a run durable still has running.
test("a quiet run shows a moving clock and how long it has been quiet", async ({ app, screen }) => {
  await app.open("/");
  const composer = screen.getByRole("textbox", "Message");
  await composer.fill("SLOW response please");
  await screen.getByRole("button", "Send").tap();
  const activity = screen.getByTestId("header-activity");
  await expect(screen.getByRole("button", "Stop")).toBeVisible();

  try {
    await expect(activity).toHaveText(/^working · \d+s$/);
    const first = await activity.textContent();
    await expect.poll(() => activity.textContent(), { timeout: 5_000 }).not.toBe(first);

    // PI_UI_QUIET_AFTER_MS is 3s in e2e; the watchdog checks durable and keeps the live run.
    await expect(activity).toHaveText(/^working · \d+s · no output for \d+s$/, {
      timeout: 15_000,
    });
    await expect(screen.getByTestId("working-status")).toHaveAttribute("data-open", "true");
    await new Promise((resolve) => setTimeout(resolve, 4_000));
    await expect(screen.getByRole("button", "Stop")).toBeVisible();
    await expect(screen.getByTestId("working-status")).toHaveAttribute("data-open", "true");
  } finally {
    const stop = screen.getByRole("button", "Stop");
    if ((await stop.count()) > 0) await stop.tap();
  }
  await expect(screen.getByTestId("working-status")).toHaveAttribute("data-open", "false");
  await expect(screen.getByRole("button", "Send")).toBeVisible();
});
