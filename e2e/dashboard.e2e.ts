import { test } from "@e2e-dev/web";
import { expect } from "e2e";

// Poll scripts the fake model hands to dashboard_upsert. They call the fake
// Hetzner API on the fake model server ({{FAKE_HTTP}}) with env.HCLOUD_TOKEN.
const serversScript = `const res = await fetch("{{FAKE_HTTP}}/hetzner/v1/servers", {
  headers: { Authorization: \`Bearer \${env.HCLOUD_TOKEN}\` },
});
if (!res.ok) throw new Error(\`Hetzner API \${res.status}\`);
const { servers } = await res.json();
log("servers", servers.length);
return servers.map((s) => ({
  name: s.name,
  status: s.status,
  type: s.server_type.name,
  ip: s.public_net.ipv4.ip,
}));`;

const costScript = `const res = await fetch("{{FAKE_HTTP}}/hetzner/v1/servers", {
  headers: { Authorization: \`Bearer \${env.HCLOUD_TOKEN}\` },
});
if (!res.ok) throw new Error(\`Hetzner API \${res.status}\`);
const { servers } = await res.json();
const total = servers.reduce(
  (sum, s) => sum + Number(s.server_type.prices[0].price_monthly.gross),
  0,
);
return { total: \`€\${total.toFixed(2)}\`, servers: \`\${servers.length} servers\` };`;

const createCalls = [
  {
    name: "dashboard_upsert",
    arguments: {
      id: "hetzner-servers",
      title: "Live servers",
      kind: "table",
      source: { type: "poll", script: serversScript, intervalSec: 0.5 },
      mapping: {
        rows: "$",
        columns: { Name: "name", Status: "status", Type: "type", IP: "ip" },
      },
    },
  },
  {
    name: "dashboard_upsert",
    arguments: {
      id: "hetzner-cost",
      title: "Hetzner monthly cost",
      kind: "stat",
      source: { type: "poll", script: costScript, intervalSec: 0.5 },
      mapping: { value: "total", label: "servers" },
    },
  },
  {
    name: "dashboard_layout",
    arguments: {
      sections: [
        {
          title: "Hetzner",
          widgets: [
            { id: "hetzner-cost", span: "third" },
            { id: "context", span: "third" },
            { id: "tokens", span: "third" },
            { id: "hetzner-servers", span: "full" },
          ],
        },
        { title: "Agent", widgets: [{ id: "mcp", span: "full" }] },
      ],
    },
  },
];

const resetCalls = [
  { name: "dashboard_remove", arguments: { id: "hetzner-servers" } },
  {
    name: "dashboard_layout",
    arguments: {
      sections: [
        {
          widgets: [
            { id: "context", span: "full" },
            { id: "tokens", span: "full" },
            { id: "mcp", span: "full" },
            { id: "mcp-events", span: "full" },
          ],
        },
      ],
    },
  },
];

type DashboardRead = {
  polling: boolean;
  widgets: { id: string }[];
  values: Record<string, { updatedAt?: string; error?: string }>;
};

async function readDashboard(browser: {
  evaluate<T>(fn: () => Promise<T> | T): Promise<T>;
}): Promise<DashboardRead> {
  return browser.evaluate(async () => {
    const res = await fetch("/api/dashboard");
    return (await res.json()) as DashboardRead;
  });
}

const lastAssistant = () =>
  [...document.querySelectorAll<HTMLElement>('[data-role="assistant"]')].at(-1)?.textContent ?? "";

test("the agent builds dashboard widgets that render at 1280px and 390px", async ({
  app,
  browser,
  screen,
}) => {
  await browser.setViewport({ width: 1280, height: 900 });
  await app.open("/");
  await screen.getByRole("textbox", "Message").fill(`TOOLCALLS ${JSON.stringify(createCalls)}`);
  await screen.getByRole("button", "Send").tap();
  await expect
    .poll(() => browser.evaluate(lastAssistant), { timeout: 20_000 })
    .toContain("Tool result:");

  await screen.getByRole("tab", "Stats").tap();
  await expect(screen.getByText("Live servers", { exact: true })).toBeVisible();
  await expect(screen.getByText("€16.67", { exact: false })).toBeVisible();

  const layout = () =>
    browser.evaluate(() => {
      const page = document.querySelector("[data-testid=stats-page]");
      const box = (id: string) => {
        const rect = document
          .querySelector(`[data-testid="widget-${id}"]`)
          ?.getBoundingClientRect();
        return rect === undefined
          ? null
          : {
              top: rect.top,
              bottom: rect.bottom,
              left: rect.left,
              right: rect.right,
              width: rect.width,
            };
      };
      const table = document.querySelector("[data-testid=widget-hetzner-servers] table");
      const cards = [...(page?.querySelectorAll("section") ?? [])];
      return {
        sections: [...document.querySelectorAll("[data-testid=dashboard-section] > h2")].map(
          (h) => h.textContent,
        ),
        cost: document.querySelector("[data-testid=stat-hetzner-cost] dd")?.textContent ?? null,
        costLabel:
          document.querySelector("[data-testid=stat-hetzner-cost] dt")?.textContent ?? null,
        header: [...(table?.querySelectorAll("th") ?? [])].map((th) => th.textContent),
        rows: [...(table?.querySelectorAll("tbody tr") ?? [])].map((tr) =>
          [...tr.querySelectorAll("td")].map((td) => td.textContent),
        ),
        cost_box: box("hetzner-cost"),
        context_box: box("context"),
        servers_box: box("hetzner-servers"),
        overflow: page === null ? true : page.scrollWidth > page.clientWidth,
        inside: cards.every(
          (card) => card.getBoundingClientRect().right <= window.innerWidth + 0.5,
        ),
        token: document.body.textContent?.includes("e2e-hcloud-token") ?? false,
      };
    });

  const wide = await layout();
  expect(wide.sections).toEqual(["Hetzner", "Agent"]);
  expect(wide.cost).toContain("€16.67");
  expect(wide.costLabel).toBe("3 servers");
  expect(wide.header).toEqual(["Name", "Status", "Type", "IP"]);
  expect(wide.rows).toEqual([
    ["web-1", "running", "cx22", "203.0.113.101"],
    ["db-1", "running", "cx32", "203.0.113.102"],
    ["worker-1", "off", "cx22", "203.0.113.103"],
  ]);
  expect(wide.overflow).toBe(false);
  expect(wide.inside).toBe(true);
  expect(wide.token).toBe(false);
  // Thirds sit side by side on wide screens; the full-width table goes below.
  expect(wide.cost_box && wide.context_box).toBeTruthy();
  if (wide.cost_box && wide.context_box && wide.servers_box) {
    expect(Math.abs(wide.cost_box.top - wide.context_box.top)).toBeLessThan(2);
    expect(wide.context_box.left).toBeGreaterThan(wide.cost_box.right - 1);
    expect(wide.servers_box.top).toBeGreaterThan(wide.cost_box.bottom - 1);
    expect(wide.servers_box.width).toBeGreaterThan(wide.cost_box.width * 2);
  }

  await browser.setViewport({ width: 390, height: 844 });
  await expect
    .poll(async () => {
      const narrow = await layout();
      return (
        narrow.cost_box !== null &&
        narrow.context_box !== null &&
        narrow.context_box.top > narrow.cost_box.bottom - 1
      );
    })
    .toBe(true);
  const narrow = await layout();
  expect(narrow.overflow).toBe(false);
  expect(narrow.inside).toBe(true);
  expect(narrow.rows.length).toBe(3);

  // Leaving the page tells the server right away, so the next test starts unwatched.
  await screen.getByRole("tab", "Chat").tap();
  await expect.poll(async () => (await readDashboard(browser)).polling).toBe(false);
});

test("polls run only while the dashboard is visible, and widgets can be removed", async ({
  app,
  browser,
  screen,
}) => {
  await browser.setViewport({ width: 390, height: 844 });
  await app.open("/?page=stats");
  await expect(screen.getByText("Live servers", { exact: true })).toBeVisible();

  // Visible: the servers widget keeps refreshing.
  await expect.poll(async () => (await readDashboard(browser)).polling).toBe(true);
  const first = (await readDashboard(browser)).values["hetzner-servers"]?.updatedAt;
  await expect
    .poll(async () => (await readDashboard(browser)).values["hetzner-servers"]?.updatedAt, {
      timeout: 10_000,
    })
    .not.toBe(first);

  // Hidden: once no client shows the page, polling stops and values stay put.
  await screen.getByRole("tab", "Chat").tap();
  await expect
    .poll(async () => (await readDashboard(browser)).polling, { timeout: 5_000 })
    .toBe(false);
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  const parked = (await readDashboard(browser)).values["hetzner-servers"]?.updatedAt;
  await new Promise((resolve) => setTimeout(resolve, 2_500));
  expect((await readDashboard(browser)).values["hetzner-servers"]?.updatedAt).toBe(parked);

  // Back on the page: polling resumes.
  await screen.getByRole("tab", "Stats").tap();
  await expect.poll(async () => (await readDashboard(browser)).polling).toBe(true);
  await expect
    .poll(async () => (await readDashboard(browser)).values["hetzner-servers"]?.updatedAt, {
      timeout: 10_000,
    })
    .not.toBe(parked);

  // The user removes a widget from its menu.
  await screen.getByRole("button", "Hetzner monthly cost menu").tap();
  await screen.getByRole("menuitem", "Remove widget").tap();
  await expect
    .poll(() =>
      browser.evaluate(() => document.querySelector("[data-testid=widget-hetzner-cost]") === null),
    )
    .toBe(true);
  expect((await readDashboard(browser)).widgets.map((w) => w.id)).not.toContain("hetzner-cost");

  // The agent removes the other one and restores the default layout.
  await screen.getByRole("tab", "Chat").tap();
  await screen.getByRole("textbox", "Message").fill(`TOOLCALLS ${JSON.stringify(resetCalls)}`);
  await screen.getByRole("button", "Send").tap();
  await expect
    .poll(async () => (await readDashboard(browser)).widgets.map((w) => w.id), {
      timeout: 20_000,
    })
    .toEqual(["context", "tokens", "mcp", "mcp-events"]);
});
