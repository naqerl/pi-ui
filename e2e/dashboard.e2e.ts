import assert from "node:assert/strict";
import { test } from "@e2e-dev/web";
import { expect, type JsonValue } from "e2e";
import { DEFAULT_DASHBOARD } from "../src/shared/dashboard-default.js";
import { BUILTIN_SOURCES } from "../src/shared/dashboard-sources.js";

const defaultIds = DEFAULT_DASHBOARD.widgets.map((widget) => widget.id);
type DashboardRead = {
  polling: boolean;
  widgets: { id: string }[];
  values: Record<string, { updatedAt?: string; error?: string; view?: unknown }>;
};

async function readDashboard(browser: {
  evaluate<T>(fn: () => Promise<T> | T): Promise<T>;
}): Promise<DashboardRead> {
  return browser.evaluate(async () => {
    const res = await fetch("/api/dashboard");
    return (await res.json()) as DashboardRead;
  });
}

test("sources are discoverable and reset restores the committed default board", async ({
  app,
  browser,
}) => {
  await browser.setViewport({ width: 390, height: 844 });
  await app.open("/");
  const sources = (await browser.evaluate(async () => {
    const response = await fetch("/api/dashboard/sources");
    if (!response.ok) throw new Error(`sources failed: ${response.status}`);
    return (await response.json()) as unknown as JsonValue;
  })) as unknown as {
    sources: { name: string; description: string; sample?: unknown }[];
  };
  assert.deepEqual(
    sources.sources.map((source) => source.name).sort(),
    [...BUILTIN_SOURCES].sort(),
  );
  for (const source of sources.sources) {
    assert.notEqual(source.description.trim(), "", `${source.name} has a description`);
    assert.notEqual(source.sample, undefined, `${source.name} has a sample`);
  }

  // Delete a builtin and add an unrelated widget, then reset.
  await browser.evaluate(async () => {
    const removed = await fetch("/api/dashboard/widgets/context", { method: "DELETE" });
    if (!removed.ok) throw new Error(`delete failed: ${removed.status}`);
    const response = await fetch("/api/dashboard/reset", { method: "POST" });
    if (!response.ok) throw new Error(`reset failed: ${response.status}`);
    return (await response.json()) as unknown as JsonValue;
  });
  await expect
    .poll(async () => (await readDashboard(browser)).widgets.map((widget) => widget.id))
    .toEqual(defaultIds);
  const state = (await browser.evaluate(async () => {
    const response = await fetch("/api/dashboard");
    return (await response.json()) as unknown as JsonValue;
  })) as unknown as {
    layout: { sections: { title?: string; widgets: { id: string }[] }[] };
  };
  assert.deepEqual(
    state.layout.sections.map((section) => section.title),
    DEFAULT_DASHBOARD.sections.map((section) => section.title),
  );
  assert.deepEqual(
    state.layout.sections.flatMap((section) => section.widgets.map((slot) => slot.id)),
    defaultIds,
  );
});
