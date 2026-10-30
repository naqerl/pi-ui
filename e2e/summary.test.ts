import assert from "node:assert/strict";
import { mock, test } from "node:test";
import type {
  Api,
  AssistantMessage,
  Context,
  Model,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { type SummaryRuntime, setSummaryModel, summarizeReply } from "../src/server/summary.js";

const model = { id: "fake-summary", provider: "fake" } as unknown as Model<Api>;
const longText = "x".repeat(600);

function reply(text: string): AssistantMessage {
  return { content: [{ type: "text", text }] } as AssistantMessage;
}

function runtime(complete: SummaryRuntime["completeSimple"]): SummaryRuntime {
  return { completeSimple: complete };
}

function configured(complete: SummaryRuntime["completeSimple"]): void {
  setSummaryModel(runtime(complete), model);
}

test("returns null without calling the model for a short reply", async () => {
  let calls = 0;
  configured(async () => {
    calls += 1;
    return reply("too late");
  });

  assert.equal(await summarizeReply("a short reply"), null);
  assert.equal(calls, 0);
});

test("returns null when the model call fails", async () => {
  configured(async () => {
    throw new Error("provider down");
  });

  assert.equal(await summarizeReply(longText), null);
});

test("returns null after the 20 second timeout", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    // The stub ignores the abort signal: the race must still settle at 20 seconds.
    configured(
      async (_model, _context: Context, _options?: SimpleStreamOptions) =>
        await new Promise<AssistantMessage>(() => undefined),
    );

    const pending = summarizeReply(longText);
    await mock.timers.tick(20_000);
    assert.equal(await pending, null);
  } finally {
    mock.timers.reset();
    setSummaryModel(undefined, undefined);
  }
});

test("returns the model's two-sentence answer", async () => {
  configured(async () => reply("  The assistant explained the change.  It also ran the checks. "));

  assert.equal(
    await summarizeReply(longText),
    "The assistant explained the change. It also ran the checks.",
  );
});
