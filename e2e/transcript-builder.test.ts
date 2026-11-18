import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AssistantEntry,
  type EntryRecord,
  ResetEntry,
  ToolResultEntry,
  UserEntry,
} from "@earendil-works/pi-durable";
import {
  buildTranscript,
  INTERRUPTED_RUN_RESTART_NOTE,
  TranscriptBuilder,
} from "../src/server/session.js";

const diagramId = "abcdefghij";

/** An MCP status notice the parser recognises: a head line plus its JSON payload. */
function mcpStatus(status: string): string {
  return [
    "MCP subscription status follows.",
    JSON.stringify({ subscriptions: [{ server: "tracer", name: "session", status }] }),
  ].join("\n");
}

/** A sequence that exercises every row kind, every retroactive update and the reset cut. */
function conversation(): EntryRecord[] {
  const entries: unknown[] = [
    { id: 10, kind: UserEntry.kind, model: [{ role: "user", content: "hello", timestamp: 1 }] },
    {
      id: 11,
      kind: AssistantEntry.kind,
      model: [
        {
          role: "assistant",
          content: [
            { type: "text", text: "drawing it" },
            { type: "toolCall", id: "call-1", name: "draw_diagram", arguments: { source: "x" } },
          ],
          timestamp: 2,
        },
      ],
    },
    {
      id: 12,
      kind: ToolResultEntry.kind,
      model: [
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "draw_diagram",
          content: [{ type: "text", text: "drawn" }],
          details: { diagram: { id: diagramId, revision: 1 }, title: "Flow" },
          timestamp: 3,
        },
      ],
    },
    {
      id: 13,
      kind: "ui.queue",
      data: { key: "queue-1", createdAt: "2026-01-01T00:00:00.000Z" },
      model: [{ role: "user", content: "queued input", timestamp: 4 }],
    },
    {
      // A decision shares the queued copy's key, so the copy must not also show.
      id: 14,
      kind: "ui.task-decision",
      data: {
        proposalId: "p1",
        taskId: "t1",
        taskTitle: "Ship it",
        decision: "approved",
        text: "Approved",
        queueKey: "queue-1",
        createdAt: "2026-01-01T00:00:01.000Z",
      },
    },
    {
      id: 15,
      kind: "ui.mcp-notice",
      data: {
        noticeId: "notice-1",
        key: "mcp/status",
        text: mcpStatus("connected"),
        at: "2026-01-01T00:00:02.000Z",
        createdAt: "2026-01-01T00:00:02.000Z",
      },
      model: [{ role: "user", content: mcpStatus("connected"), timestamp: 5 }],
    },
    {
      id: 16,
      kind: "ui.mcp-notice",
      data: {
        noticeId: "notice-1",
        key: "mcp/status",
        text: mcpStatus("connected, list refreshed"),
        at: "2026-01-01T00:00:03.000Z",
        createdAt: "2026-01-01T00:00:03.000Z",
      },
    },
    {
      id: 17,
      kind: AssistantEntry.kind,
      model: [
        {
          role: "assistant",
          content: [{ type: "text", text: "cut off here" }],
          timestamp: 6,
        },
      ],
    },
    {
      id: 18,
      kind: "ui.run-interrupted",
      data: {
        markerKey: "run-1",
        partialEntryId: 17,
        note: INTERRUPTED_RUN_RESTART_NOTE,
        stopped: false,
        createdAt: "2026-01-01T00:00:04.000Z",
      },
    },
  ];
  return entries as EntryRecord[];
}

test("appending one entry at a time equals the whole-list build", () => {
  const entries = conversation();
  const whole = buildTranscript(entries);
  const builder = new TranscriptBuilder();
  const incremental = [];
  for (const entry of entries) {
    builder.append(entry);
    incremental.push(structuredClone(builder.build()));
  }

  // Every prefix must match the same prefix built from scratch, not just the last one.
  for (let end = 1; end <= entries.length; end++) {
    assert.deepEqual(incremental[end - 1], buildTranscript(entries.slice(0, end)));
  }
  assert.deepEqual(incremental.at(-1), whole);
});

test("a later MCP notice updates the one row its group already shows", () => {
  const transcript = buildTranscript(conversation());
  const notices = transcript.messages.filter((message) => message.id === "m-15");
  assert.equal(notices.length, 1);
  assert.equal(notices[0]?.text, mcpStatus("connected, list refreshed"));
  assert.equal(notices[0]?.timestamp, "2026-01-01T00:00:03.000Z");
});

test("a decision drops the queued copy it shares a key with", () => {
  const transcript = buildTranscript(conversation());
  // The notice owns the shared id; the queued input must not also show as a user message.
  const shared = transcript.messages.filter((message) => message.id === "m-queue-1");
  assert.equal(shared.length, 1);
  assert.equal(shared[0]?.notice?.kind, "decision");
  assert.equal(
    transcript.messages.some((message) => message.text === "queued input"),
    false,
  );
});

test("an interrupt marks the reply it cut off as partial", () => {
  const transcript = buildTranscript(conversation());
  const partial = transcript.messages.find((message) => message.id === "m-17");
  assert.equal(partial?.partial, true);
});

test("a replaced drawing raises the revision of the row already shown", () => {
  let revision = 1;
  const builder = new TranscriptBuilder(undefined, (id) =>
    id === diagramId ? revision : undefined,
  );
  for (const entry of conversation()) builder.append(entry);

  const before = builder.build().messages.find((message) => message.id === "m-12");
  assert.equal(before?.parts?.[0]?.kind === "diagram" ? before.parts[0].diagram.revision : 0, 1);

  revision = 2;
  assert.equal(builder.refreshDiagrams(), true);
  const after = builder.build().messages.find((message) => message.id === "m-12");
  assert.equal(after?.parts?.[0]?.kind === "diagram" ? after.parts[0].diagram.revision : 0, 2);
  // A second pass with nothing moved must not report a change.
  assert.equal(builder.refreshDiagrams(), false);
});

test("a reset hides everything the transcript showed before it", () => {
  const transcript = buildTranscript([
    { id: 1, kind: UserEntry.kind, model: [{ role: "user", content: "gone", timestamp: 1 }] },
    { id: 2, kind: ResetEntry.kind, model: [{ role: "system", content: "", timestamp: 2 }] },
    { id: 3, kind: UserEntry.kind, model: [{ role: "user", content: "kept", timestamp: 3 }] },
  ] as unknown as EntryRecord[]);

  assert.equal(
    transcript.messages.some((message) => message.text === "gone"),
    false,
  );
  assert.equal(
    transcript.messages.some((message) => message.text === "kept"),
    true,
  );
  assert.equal(
    transcript.messages.some((message) => message.kind === "session-reset"),
    true,
  );
});
