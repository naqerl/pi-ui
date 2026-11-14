import { test } from "@e2e-dev/web";
import { expect } from "e2e";

test("a failed run shows a thin dismissible error header without another action", async ({
  app,
  browser,
  screen,
}) => {
  await app.open("/");
  const composer = screen.getByRole("textbox", "Message");
  await composer.fill("DELEGATE_FAIL");
  await screen.getByRole("button", "Send").tap();

  const header = screen.getByTestId("run-error-header");
  await expect(header).toBeVisible({ timeout: 30_000 });
  await expect(screen.getByTestId("run-error-class")).toHaveText(/Error$/);
  const placement = await browser.evaluate(() => {
    const element = document.querySelector<HTMLElement>('[data-testid="run-error-header"]');
    if (element === null) return null;
    return {
      position: getComputedStyle(element).position,
      height: element.getBoundingClientRect().height,
      color: getComputedStyle(element.querySelector<HTMLElement>("div") ?? element).color,
    };
  });
  expect(placement?.position).toBe("absolute");
  expect(placement?.height ?? 99).toBeLessThan(40);
  // The danger token supplies the colour; the literal red is not in the header.
  expect(placement?.color).not.toBe("rgb(255, 0, 0)");

  await screen.getByTestId("run-error-open").tap();
  await expect(screen.getByTestId("run-error-dialog")).toBeVisible();
  await expect(screen.getByTestId("run-error-dialog")).toContainText(/DELEGATE_FAIL|failure/i);
  await browser.keyboard.press("Escape");
  await expect(screen.getByTestId("run-error-dialog")).toHaveCount(0);

  // It stays until acknowledged, then the server clears it and no refresh brings it back.
  await screen.getByTestId("run-error-dismiss").tap();
  await expect(header).toHaveCount(0);
  await expect.poll(async () => screen.getByTestId("run-error-header").count()).toBe(0);
});
