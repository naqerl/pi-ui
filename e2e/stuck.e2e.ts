import { test } from "@e2e-dev/web";
import { expect } from "e2e";

// A model stream that stays open without output (SLOW holds it with keepalives) used to make the
// dock count the run's time and say how long the agent had been quiet. The strip now stays on the
// animation and the word working, while the server's watchdog still keeps a live run durable has.
test("a quiet run keeps just the animation and the word working", async ({ app, screen }) => {
  await app.open("/");
  const composer = screen.getByRole("textbox", "Message");
  await composer.fill("SLOW response please");
  await screen.getByRole("button", "Send").tap();
  const activity = screen.getByTestId("header-activity");
  await expect(screen.getByRole("button", "Stop")).toBeVisible();

  try {
    await expect(activity).toHaveText("working");
    await expect(screen.getByTestId("working-detail")).toHaveCount(0);

    // PI_UI_QUIET_AFTER_MS is 3s in e2e; the watchdog checks durable and keeps the live run.
    await new Promise((resolve) => setTimeout(resolve, 4_000));
    await expect(activity).toHaveText("working");
    await expect(activity).not.toHaveText(/output|\d/);
    await expect(screen.getByTestId("working-detail")).toHaveCount(0);
    await expect(screen.getByTestId("working-status")).toHaveAttribute("data-open", "true");
    await expect(screen.getByRole("button", "Stop")).toBeVisible();
  } finally {
    const stop = screen.getByRole("button", "Stop");
    if ((await stop.count()) > 0) await stop.tap();
  }
  await expect(screen.getByTestId("working-status")).toHaveAttribute("data-open", "false");
  await expect(screen.getByRole("button", "Send")).toBeVisible();
});
