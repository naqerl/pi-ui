import { test } from "@e2e-dev/web";
import { expect } from "e2e";

test("answers with a live model", async ({ app, screen }) => {
  test.skip(process.env.PI_E2E_LIVE !== "1", "set PI_E2E_LIVE=1 to run the live-model spec");
  await app.open("/");
  const composer = screen.getByRole("textbox", "Message");
  await composer.fill("Reply with exactly: live-ok");
  await screen.getByRole("button", "Send").tap();
  await expect(screen.getByText("live-ok", { exact: false })).toBeVisible({ timeout: 60_000 });
});
