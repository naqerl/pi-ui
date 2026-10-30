import { test } from "@e2e-dev/web";
import { expect } from "e2e";

test("rebuilds the dither after the browser drops its WebGL context", async ({
  app,
  browser,
  screen,
}) => {
  await app.open("/");
  await expect(screen.getByRole("button", "Settings")).toBeVisible();
  await expect
    .poll(() =>
      browser.evaluate(() => document.querySelector('[data-testid="shader-bg"] canvas') !== null),
    )
    .toBe(true);

  // What a phone does to a backgrounded installed app under GPU memory pressure.
  const dropped = await browser.evaluate(() => {
    const host = document.querySelector<HTMLElement>('[data-testid="shader-bg"]');
    const canvas = host?.querySelector("canvas");
    const gl = canvas?.getContext("webgl2");
    const lose = gl?.getExtension("WEBGL_lose_context");
    if (!host || !canvas || !gl || !lose) return null;
    (window as unknown as { droppedCanvas?: HTMLCanvasElement }).droppedCanvas = canvas;
    lose.loseContext();
    return host.dataset.shaderGeneration ?? "";
  });
  if (dropped === null) return; // No WebGL in this browser: nothing to recover.
  expect(dropped).toBe("0");

  await expect
    .poll(() =>
      browser.evaluate(() => {
        const host = document.querySelector<HTMLElement>('[data-testid="shader-bg"]');
        const canvas = host?.querySelector("canvas") ?? null;
        const old = (window as unknown as { droppedCanvas?: HTMLCanvasElement }).droppedCanvas;
        const gl = canvas?.getContext("webgl2") ?? null;
        return {
          generation: host?.dataset.shaderGeneration ?? "",
          replaced: canvas !== null && canvas !== old,
          live: gl !== null && !gl.isContextLost(),
        };
      }),
    )
    .toEqual({ generation: "1", replaced: true, live: true });

  // While it recovers, the host shows the page color rather than a blank canvas.
  const paint = await browser.evaluate(() => {
    const host = document.querySelector<HTMLElement>('[data-testid="shader-bg"]');
    const probe = document.createElement("span");
    probe.style.backgroundColor = host?.dataset.shaderColorBack ?? "";
    document.body.append(probe);
    const back = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return { host: host === null ? "" : getComputedStyle(host).backgroundColor, back };
  });
  expect(paint.host).toBe(paint.back);
});
