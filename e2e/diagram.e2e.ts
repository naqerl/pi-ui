import { test } from "@e2e-dev/web";
import { expect } from "e2e";

test("draws a diagram and replaces it in the original message", async ({
  app,
  screen,
  browser,
}) => {
  await app.open("/");
  const composer = screen.getByRole("textbox", "Message");
  const draw = [
    {
      name: "draw_diagram",
      arguments: {
        source: "flowchart LR\n  A[Draw] --> B[Revise]",
        title: "Flow",
      },
    },
  ];
  await composer.fill(`TOOLCALLS ${JSON.stringify(draw)}`);
  await screen.getByRole("button", "Send").tap();
  await expect(screen.getByTestId("diagram")).toBeVisible({ timeout: 30_000 });
  await expect(screen.getByTestId("diagram")).toHaveAttribute("data-revision", "1");
  await expect(browser.locator("[data-testid=diagram] svg")).toBeVisible({ timeout: 30_000 });
  const id = await browser.evaluate(
    () => document.querySelector("[data-testid=diagram]")?.getAttribute("data-diagram-id") ?? null,
  );
  expect(id).not.toBeNull();
  const svgText = await browser.evaluate(
    () => document.querySelector("[data-testid=diagram] svg")?.textContent ?? "",
  );
  expect(svgText).toContain("Draw");

  const replace = [
    {
      name: "replace_diagram",
      arguments: {
        id,
        source: "flowchart LR\n  A[Draw] --> C[Changed]",
      },
    },
  ];
  await composer.fill(`TOOLCALLS ${JSON.stringify(replace)}`);
  await screen.getByRole("button", "Send").tap();
  await expect(screen.getByTestId("diagram")).toHaveAttribute("data-revision", "2", {
    timeout: 30_000,
  });
  await expect(browser.locator("[data-testid=diagram] svg")).toBeVisible({ timeout: 30_000 });
  const changed = await browser.evaluate(
    () => document.querySelector("[data-testid=diagram] svg")?.textContent ?? "",
  );
  expect(changed).toContain("Changed");
});

test("an invalid diagram is an error card with the parser's message", async ({
  app,
  screen,
  browser,
}) => {
  await app.open("/");
  const composer = screen.getByRole("textbox", "Message");
  const draw = [{ name: "draw_diagram", arguments: { source: "this is not a diagram" } }];
  await composer.fill(`TOOLCALLS ${JSON.stringify(draw)}`);
  await screen.getByRole("button", "Send").tap();
  await expect(browser.locator("[data-testid=diagram-error]")).toContainText(
    "No diagram type detected",
    { timeout: 30_000 },
  );
  await expect(browser.locator("[data-testid=diagram] pre")).toContainText("this is not a diagram");
});

test("an SVG-looking source falls back to an error card instead of executing markup", async ({
  app,
  browser,
  screen,
}) => {
  await app.open("/");
  await browser.evaluate(() => {
    document.title = "diagram-xss-guard";
    return true;
  });
  const source =
    '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><img src="x" onerror="document.title=\'pwned\'"></foreignObject></svg>';
  const draw = [{ name: "draw_diagram", arguments: { source } }];
  const composer = screen.getByRole("textbox", "Message");
  await composer.fill(`TOOLCALLS ${JSON.stringify(draw)}`);
  await screen.getByRole("button", "Send").tap();

  await expect(browser.locator("[data-testid=diagram-error]").last()).toContainText(
    "No diagram type detected",
    { timeout: 30_000 },
  );
  await expect(browser.locator("[data-testid=diagram] foreignObject")).toHaveCount(0);
  expect(await browser.title()).toBe("diagram-xss-guard");

  const id = await browser.evaluate(() => {
    const diagrams = [...document.querySelectorAll("[data-testid=diagram]")];
    return diagrams.at(-1)?.getAttribute("data-diagram-id") ?? "";
  });
  const payload = await browser.evaluate(async (diagramId) => {
    const response = await fetch(`/api/diagrams/${diagramId}`);
    return (await response.json()) as { source: string; svg?: string };
  }, id);
  expect(payload.source).toBe(source);
  expect(payload.svg).toBeUndefined();
});

test("opens a wide diagram full screen to zoom, pan, fit and close without moving the chat", async ({
  app,
  browser,
  screen,
}) => {
  await browser.setViewport({ width: 390, height: 844 });
  await app.open("/");
  const composer = screen.getByRole("textbox", "Message");
  const steps = Array.from({ length: 8 }, (_, index) => `S${index}[Step ${index + 1}]`);
  const source = [
    "flowchart LR",
    ...steps.slice(1).map((step, index) => `  S${index} --> ${step}`),
  ].join("\n");
  const draw = [{ name: "draw_diagram", arguments: { source, title: "Wide flow" } }];
  await composer.fill(`TOOLCALLS ${JSON.stringify(draw)}`);
  await screen.getByRole("button", "Send").tap();

  const openButton = browser.locator('[data-testid="diagram"] [data-testid="diagram-open"]').last();
  await expect(openButton).toBeVisible({ timeout: 30_000 });
  await expect(screen.getByRole("button", "Send")).toBeVisible({ timeout: 30_000 });
  await new Promise((resolve) => setTimeout(resolve, 400));

  const layout = () =>
    browser.evaluate(() => {
      const composer = document.querySelector<HTMLTextAreaElement>(
        'textarea[aria-label="Message"]',
      );
      const messages = [...document.querySelectorAll<HTMLElement>("[data-message-id]")];
      const last = messages.at(-1) ?? null;
      const main = document.querySelector<HTMLElement>("main");
      const box = (element: HTMLElement | null) => {
        if (element === null) return null;
        const rect = element.getBoundingClientRect();
        return { top: rect.top, left: rect.left, width: rect.width, height: rect.height };
      };
      return {
        composer: box(composer),
        last: box(last),
        scrollTop: main?.scrollTop ?? -1,
        atEnd: main === null ? false : main.scrollHeight - main.scrollTop - main.clientHeight <= 48,
      };
    });
  const before = await layout();
  expect(before.composer).not.toBeNull();
  expect(before.last).not.toBeNull();

  await openButton.tap();
  await expect(screen.getByTestId("diagram-viewer")).toBeVisible();
  await expect
    .poll(() =>
      browser.evaluate(
        () =>
          document.querySelector<HTMLElement>('[data-testid="diagram-viewer-surface"]')?.dataset
            .zoom ?? "",
      ),
    )
    .toBe("1.000");
  await new Promise((resolve) => setTimeout(resolve, 150));

  const dialogBox = await browser.evaluate(() => {
    const dialog = document.querySelector<HTMLDialogElement>('[data-testid="diagram-viewer"]');
    if (dialog === null) return null;
    const rect = dialog.getBoundingClientRect();
    return {
      open: dialog.open,
      left: rect.left,
      right: window.innerWidth - rect.right,
      top: rect.top,
      bottom: window.innerHeight - rect.bottom,
    };
  });
  expect(dialogBox?.open).toBe(true);
  expect(dialogBox?.left ?? 0).toBeGreaterThan(0);
  expect(dialogBox?.right ?? 0).toBeGreaterThan(0);
  expect(dialogBox?.top ?? 0).toBeGreaterThan(0);
  expect(dialogBox?.bottom ?? 0).toBeGreaterThan(0);

  const surfaceTransform = () =>
    browser.evaluate(
      () =>
        document.querySelector<HTMLElement>('[data-testid="diagram-viewer-surface"]')?.style
          .transform ?? "",
    );
  const initialTransform = await surfaceTransform();

  await screen.getByRole("button", { name: "Zoom in" }).tap();
  await expect
    .poll(() =>
      browser.evaluate(
        () =>
          document.querySelector<HTMLElement>('[data-testid="diagram-viewer-surface"]')?.dataset
            .zoom ?? "",
      ),
    )
    .toBe("1.250");
  const zoomedTransform = await surfaceTransform();
  expect(zoomedTransform).not.toBe(initialTransform);

  const stage = screen.getByTestId("diagram-viewer-stage");
  const stageBox = await stage.boundingBox();
  expect(stageBox).not.toBeNull();
  if (stageBox !== null) {
    const x = stageBox.x + stageBox.width / 2;
    const y = stageBox.y + stageBox.height / 2;
    await browser.mouse.move(x, y);
    await browser.mouse.down();
    await browser.mouse.move(x + 35, y + 20);
    await browser.mouse.move(x + 70, y + 40);
    await browser.mouse.up();
  }
  const pannedTransform = await surfaceTransform();
  expect(pannedTransform).not.toBe(zoomedTransform);

  await screen.getByRole("button", { name: "Fit diagram" }).tap();
  await expect
    .poll(() =>
      browser.evaluate(
        () =>
          document.querySelector<HTMLElement>('[data-testid="diagram-viewer-surface"]')?.dataset
            .zoom ?? "",
      ),
    )
    .toBe("1.000");
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(await surfaceTransform()).toBe(initialTransform);

  await screen.getByTestId("diagram-viewer-close").tap();
  await expect(screen.getByTestId("diagram-viewer")).toHaveCount(0);
  await new Promise((resolve) => setTimeout(resolve, 200));

  const after = await layout();
  expect(after.scrollTop).toBe(before.scrollTop);
  expect(after.atEnd).toBe(before.atEnd);
  expect(after.composer?.top ?? -1).toBeCloseTo(before.composer?.top ?? -2, 0);
  expect(after.composer?.left ?? -1).toBeCloseTo(before.composer?.left ?? -2, 0);
  expect(after.composer?.width ?? -1).toBeCloseTo(before.composer?.width ?? -2, 0);
  expect(after.composer?.height ?? -1).toBeCloseTo(before.composer?.height ?? -2, 0);
  expect(after.last?.top ?? -1).toBeCloseTo(before.last?.top ?? -2, 0);
  expect(after.last?.left ?? -1).toBeCloseTo(before.last?.left ?? -2, 0);
  expect(after.last?.width ?? -1).toBeCloseTo(before.last?.width ?? -2, 0);
});
