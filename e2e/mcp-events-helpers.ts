export type Page = {
  evaluate: <T, A = undefined>(fn: (arg: A) => T | Promise<T>, arg?: A) => Promise<T>;
};

export interface EventsRead {
  events: Array<{ id: string; server: string; name: string }>;
  subscriptions: Array<{ id: string; name: string; status: string; cursor: string | null }>;
  notice: string | null;
}

export const mcpEvents = (browser: Page) =>
  browser.evaluate(async () => {
    const res = await fetch("/api/state");
    return ((await res.json()) as { mcpEvents: EventsRead }).mcpEvents;
  });

export const hubSubscription = async (browser: Page) =>
  (await mcpEvents(browser)).subscriptions.find((item) => item.name === "stub-hub");

export const burstNotices = (browser: Page) =>
  browser.evaluate(async () => {
    const res = await fetch("/api/state");
    const state = (await res.json()) as {
      run?: string;
      messages?: Array<{
        notice?: { kind?: string; summary?: string; events?: Array<{ id?: string | null }> };
      }>;
    };
    return {
      run: state.run ?? "",
      notices: (state.messages ?? [])
        .filter((message) => message.notice?.kind === "mcp")
        .map((message) => ({
          summary: message.notice?.summary ?? "",
          ids: (message.notice?.events ?? []).map((event) => event.id ?? ""),
        })),
    };
  });

export const chipCount = (browser: Page, label: string) =>
  browser.evaluate((text) => {
    return [...document.querySelectorAll<HTMLElement>('[data-testid="queued-notice-chip"]')].filter(
      (node) => (node.textContent ?? "").includes(text),
    ).length;
  }, label);

export const chatState = (browser: Page) =>
  browser.evaluate(async () => {
    const res = await fetch("/api/state");
    const state = (await res.json()) as {
      run?: string;
      messages?: Array<{ role?: string; text?: string; notice?: { kind?: string } }>;
    };
    return {
      run: state.run ?? "",
      messages: (state.messages ?? []).map((message) => ({
        role: message.role ?? "",
        text: message.text ?? "",
        noticeKind: message.notice?.kind ?? "",
      })),
    };
  });
