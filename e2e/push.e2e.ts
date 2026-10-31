import { test } from "@e2e-dev/web";
import { expect } from "e2e";

test("the notifications row fits the popover and keeps its height from off to on", async ({
  app,
  browser,
  screen,
}) => {
  await browser.addInitScript(() => {
    const storageKey = "e2e-push-subscribed";
    let subscribed = localStorage.getItem(storageKey) === "1";
    const endpoint = "https://push.example/e2e-row";
    const keys = { p256dh: "B".repeat(65), auth: "auth-token" };
    const subscription = () => ({
      endpoint,
      keys,
      toJSON: () => ({ endpoint, keys }),
      unsubscribe: async () => {
        subscribed = false;
        localStorage.removeItem(storageKey);
        return true;
      },
    });
    const registration = {
      pushManager: {
        getSubscription: async () => (subscribed ? subscription() : null),
        subscribe: async () => {
          subscribed = true;
          localStorage.setItem(storageKey, "1");
          return subscription();
        },
      },
    };
    Object.defineProperty(window, "PushManager", { configurable: true, value: class {} });
    Object.defineProperty(window, "Notification", {
      configurable: true,
      value: { permission: "default", requestPermission: async () => "granted" },
    });
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: {
        getRegistration: async () => registration,
        ready: Promise.resolve(registration),
        register: async () => registration,
      },
    });
  });

  await browser.setViewport({ width: 320, height: 844 });
  await app.open("/");
  await expect(screen.getByRole("textbox", "Message")).toBeVisible();
  await screen.getByRole("button", { name: "Settings" }).tap();

  const row = screen.getByTestId("push-settings-row");
  const toggle = screen.getByTestId("push-toggle");
  await expect(row).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-checked", "false");

  const read = () =>
    browser.evaluate(() => {
      const menu = document.querySelector<HTMLElement>('[role="menu"]');
      const rowElement = document.querySelector<HTMLElement>('[data-testid="push-settings-row"]');
      const status = document.querySelector<HTMLElement>('[data-testid="push-status"]');
      const toggleElement = document.querySelector<HTMLElement>('[data-testid="push-toggle"]');
      if (menu === null || rowElement === null || status === null || toggleElement === null) {
        return null;
      }
      const themeButton = menu.querySelector<HTMLElement>('button[role="menuitem"]');
      const modelButton = menu.querySelectorAll<HTMLElement>('button[role="menuitem"]')[1];
      const title = rowElement.querySelector<HTMLElement>("p");
      const themeLabel = themeButton?.querySelector<HTMLElement>("span") ?? null;
      const modelValue = modelButton?.querySelectorAll<HTMLElement>("span")[1] ?? null;
      if (title === null || themeLabel === null || modelValue === null) return null;

      const lines = (element: HTMLElement) => {
        const lineHeight = Number.parseFloat(getComputedStyle(element).lineHeight);
        return lineHeight > 0 ? Math.round(element.getBoundingClientRect().height / lineHeight) : 1;
      };
      const menuBox = menu.getBoundingClientRect();
      const rowBox = rowElement.getBoundingClientRect();
      const toggleBox = toggleElement.getBoundingClientRect();
      const titleBox = title.getBoundingClientRect();
      const titleStyle = getComputedStyle(title);
      const statusStyle = getComputedStyle(status);
      const themeStyle = getComputedStyle(themeLabel);
      const modelStyle = getComputedStyle(modelValue);
      return {
        viewport: window.innerWidth,
        menuWidth: menuBox.width,
        menuInside: menuBox.left >= 0 && menuBox.right <= window.innerWidth && menuBox.width <= 288,
        rowHeight: rowBox.height,
        rowFits: rowElement.scrollWidth <= rowElement.clientWidth + 1,
        titleLines: lines(title),
        titleFits: title.scrollWidth <= title.clientWidth + 1,
        statusLines: lines(status),
        titleLeft: Math.round(titleBox.left - menuBox.left),
        themeLeft: Math.round(themeLabel.getBoundingClientRect().left - menuBox.left),
        titleFont: titleStyle.fontSize,
        themeFont: themeStyle.fontSize,
        titleColor: titleStyle.color,
        themeColor: themeStyle.color,
        statusFont: statusStyle.fontSize,
        modelFont: modelStyle.fontSize,
        statusColor: statusStyle.color,
        modelColor: modelStyle.color,
        toggleWidth: toggleBox.width,
        toggleHeight: toggleBox.height,
        toggleOnRight:
          toggleBox.right <= rowBox.right + 1 && toggleBox.left > rowBox.left + rowBox.width / 2,
        checked: toggleElement.getAttribute("aria-checked"),
        disabled: toggleElement.hasAttribute("disabled"),
      };
    });

  for (const width of [320, 390]) {
    await browser.setViewport({ width, height: 844 });
    const off = await read();
    expect(off).not.toBeNull();
    if (off === null) return;
    expect(off.viewport).toBe(width);
    expect(off.menuInside).toBe(true);
    expect(off.menuWidth).toBeLessThanOrEqual(288);
    expect(off.rowFits).toBe(true);
    expect(off.titleLines).toBe(1);
    expect(off.titleFits).toBe(true);
    expect(off.statusLines).toBe(1);
    expect(off.titleLeft).toBe(off.themeLeft);
    expect(off.titleFont).toBe(off.themeFont);
    expect(off.titleColor).toBe(off.themeColor);
    expect(off.statusFont).toBe(off.modelFont);
    expect(off.statusColor).toBe(off.modelColor);
    expect(off.toggleWidth).toBeGreaterThanOrEqual(44);
    expect(off.toggleHeight).toBeGreaterThanOrEqual(44);
    expect(off.toggleOnRight).toBe(true);
    expect(off.checked).toBe("false");
    expect(off.disabled).toBe(false);

    await toggle.tap();
    await expect(row).toHaveAttribute("data-state", "granted");
    await expect(toggle).toHaveAttribute("aria-checked", "true");

    const on = await read();
    expect(on).not.toBeNull();
    if (on === null) return;
    expect(on.statusLines).toBe(1);
    expect(on.rowHeight).toBe(off.rowHeight);
    expect(on.checked).toBe("true");
    expect(on.disabled).toBe(false);

    await toggle.tap();
    await expect(row).toHaveAttribute("data-state", "default");
    await expect(toggle).toHaveAttribute("aria-checked", "false");
  }
});
