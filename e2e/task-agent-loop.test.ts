import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  AssistantEntry,
  type EntryRecord,
  type ToolExecutionResult,
  type ToolHookCall,
  type ToolHooks,
} from "@earendil-works/pi-durable";
import {
  createIdentityFetch,
  installBillionContextInline,
  type ObservedRequest,
  withConversationIdentity,
  withoutConversationIdentity,
} from "../src/server/billion-context.js";
import { createModelCatalog } from "../src/server/models.js";
import { buildTranscript } from "../src/server/session.js";
import {
  canonicalArguments,
  DurableTaskAgentSession,
  planCompactionPolicy,
  repetitionFingerprint,
  RepetitionGuard,
  type RepetitionStop,
  repetitionStopText,
  repetitionWarning,
  TaskAgentManager,
  taskAgentHarnessSettings,
  visibleTaskAgentMessages,
} from "../src/server/task-agent.js";
import { TaskStore } from "../src/server/tasks.js";
import { annotateProviderLoopGuard, isProviderLoopGuard } from "../src/shared/loop-guard.js";
import { DEFAULT_NEW_TASK_TITLE } from "../src/shared/tasks.js";
import type { ChatMessage } from "../src/shared/types.js";

let callSeq = 0;

/** A model-issued tool call, as the harness hands it to `beforeTool`/`afterTool`. */
function toolCall(args: unknown, name = "bash"): ToolHookCall {
  callSeq += 1;
  return {
    type: "toolCall",
    id: `call-${callSeq}`,
    name,
    arguments: args,
  } as unknown as ToolHookCall;
}

/** A settled result in the shape the harness hands `afterTool`: its output is materialised. */
function settled(text = "ok"): ToolExecutionResult {
  return { output: [{ type: "text", text }] };
}

type Block = { type: string; text?: string };

function resultText(result: { output?: readonly Block[] }): string {
  return (result.output ?? [])
    .map((block) => (block.type === "text" ? (block.text ?? "") : ""))
    .join("\n");
}

async function eventually<T>(
  read: () => Promise<T | null | undefined>,
  label: string,
  attempts = 200,
): Promise<T> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const value = await read();
    if (value !== null && value !== undefined && value !== false) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`timed out waiting for ${label}`);
}

test("two calls that differ only in argument key order are one fingerprint", () => {
  assert.equal(
    canonicalArguments({ b: { d: 3, c: [1, 2] }, a: 1 }),
    canonicalArguments({ a: 1, b: { c: [1, 2], d: 3 } }),
  );
  assert.equal(
    repetitionFingerprint("bash", { command: "ls", timeoutMs: 1 }),
    repetitionFingerprint("bash", { timeoutMs: 1, command: "ls" }),
  );
  assert.notEqual(
    repetitionFingerprint("bash", { command: "ls" }),
    repetitionFingerprint("bash", { command: "ls " }),
  );
  assert.notEqual(
    repetitionFingerprint("read", { path: "a" }),
    repetitionFingerprint("bash", { path: "a" }),
  );
  // A fingerprint must never throw: cycles and unsupported values are rendered.
  const cyclic: Record<string, unknown> = { name: "loop" };
  cyclic.self = cyclic;
  assert.match(canonicalArguments(cyclic), /circular/);
});

test("the third identical call warns, the fifth is refused before it runs, and a real wait starts over", () => {
  const stops: RepetitionStop[] = [];
  let clock = 0;
  let duration = 0;
  const guard = new RepetitionGuard({
    now: () => clock,
    onStop: (stop) => {
      stops.push(stop);
    },
  });
  guard.setAvailable(["bash"]);

  // One call as the harness runs it: the hook pair either blocks it or settles it.
  const run = (args: unknown) => {
    const call = toolCall(args);
    const blocked = guard.beforeTool(call);
    if (blocked !== undefined) return { call, block: blocked.block, result: undefined };
    clock += duration;
    const result = guard.afterTool(call, settled("streamed bash output"));
    return { call, block: undefined, result };
  };

  const first = run({ command: "true" });
  const second = run({ command: "true" });
  // The third call ran five seconds: a wait or a poll is real work, so it never warns,
  // and the identical call after it starts the count over.
  duration = 5_000;
  const slow = run({ command: "true" });
  duration = 0;
  const afterSlow = run({ command: "true" });
  const secondAgain = run({ command: "true" });
  const third = run({ command: "true" });
  const fourth = run({ command: "true" });
  const fifth = run({ command: "true" });

  assert.doesNotMatch(resultText(first.result ?? {}), /\[pi-ui\]/);
  assert.doesNotMatch(resultText(second.result ?? {}), /\[pi-ui\]/);
  assert.equal(slow.block, undefined, "a five-second call is never refused");
  assert.doesNotMatch(resultText(slow.result ?? {}), /\[pi-ui\]/);
  assert.doesNotMatch(
    resultText(afterSlow.result ?? {}),
    /\[pi-ui\]/,
    "a five-second call starts over",
  );
  assert.doesNotMatch(resultText(secondAgain.result ?? {}), /\[pi-ui\]/);
  // The streamed output survives the warning: the hook appends, it never rebuilds.
  assert.match(resultText(third.result ?? {}), /streamed bash output/);
  assert.ok(resultText(third.result ?? {}).includes(repetitionWarning("bash")));
  assert.match(resultText(third.result ?? {}), /3rd identical bash call/);
  assert.match(resultText(third.result ?? {}), /refuse the call and stop this run/);
  assert.doesNotMatch(resultText(fourth.result ?? {}), /\[pi-ui\]/, "the warning is appended once");

  // The fifth call is refused before it runs: it never reaches a tool, it gets no result,
  // and the reason is the sentence the run ends with.
  assert.equal(fifth.result, undefined);
  assert.equal(fifth.block, repetitionStopText("bash", 5, ["bash"]));
  assert.match(fifth.block ?? "", /bash was called 5 times in a row/);
  assert.match(fifth.block ?? "", /tools available: bash/);
  assert.match(fifth.block ?? "", /Send a message to continue/);
  assert.equal(stops.length, 1);
  assert.equal(stops[0]?.toolName, "bash");
  assert.equal(stops[0]?.count, 5);
  assert.equal(stops[0]?.message, fifth.block);

  // A refused call is not warned on top of its refusal.
  assert.equal(guard.afterTool(fifth.call, settled()), undefined);
});

test("a different call starts the count again, so only a run of identical calls is a loop", () => {
  const guard = new RepetitionGuard();
  const run = (args: unknown) => {
    const call = toolCall(args);
    guard.beforeTool(call);
    return guard.afterTool(call, settled());
  };

  run({ command: "a" });
  run({ command: "a" });
  const other = run({ command: "b" });
  const again = run({ command: "b" });
  const third = run({ command: "b" });

  assert.doesNotMatch(
    resultText(other ?? {}),
    /\[pi-ui\]/,
    "a different call starts the count again",
  );
  assert.doesNotMatch(resultText(again ?? {}), /\[pi-ui\]/);
  assert.match(resultText(third ?? {}), /3rd identical bash call/);

  // Key order is not a difference: the same arguments in another order are the same call.
  const reordered = run({ command: "b", timeoutMs: 1 });
  const ordered = run({ timeoutMs: 1, command: "b" });
  assert.doesNotMatch(resultText(reordered ?? {}), /\[pi-ui\]/);
  assert.doesNotMatch(resultText(ordered ?? {}), /\[pi-ui\]/);

  // A new run never inherits the previous run's count.
  guard.reset();
  assert.doesNotMatch(resultText(run({ command: "b" }) ?? {}), /\[pi-ui\]/);
});

test("the guard is an installed extension with tool hooks, and names only the offered tools", () => {
  const guard = new RepetitionGuard();
  const extension = guard.extension();
  assert.equal(extension.name, "task-agent-repetition-guard");
  assert.deepEqual(
    extension.hooks?.map((registration) => registration.task),
    ["pi.tool"],
  );
  const hooks = extension.hooks?.[0]?.handlers as Partial<ToolHooks>;
  assert.equal(typeof hooks.beforeTool, "function");
  assert.equal(typeof hooks.afterTool, "function");

  // The lane narrows the list to the tools the model is actually offered, so a refusal
  // never names a registry tool the plan prompt does not carry.
  guard.setAvailable(["bash", "read", "bash"]);
  assert.deepEqual(guard.available(), ["bash", "read"]);
  // Before the lane sets it, a refusal names no tool rather than inventing one.
  assert.deepEqual(new RepetitionGuard().available(), []);
});

test("the plan harness compacts with pi-durable, scaled to the plan model's window", () => {
  const defaults = taskAgentHarnessSettings({} as NodeJS.ProcessEnv);
  assert.deepEqual(defaults.compaction, {
    enabled: true,
    reserveTokens: 16_384,
    keepRecentTokens: 20_000,
    backgroundTokens: 0,
  });
  assert.deepEqual(planCompactionPolicy(8_192), {
    enabled: true,
    reserveTokens: 1_024,
    keepRecentTokens: 2_048,
    backgroundTokens: 0,
  });
  const large = planCompactionPolicy(1_048_576);
  assert.equal(large.reserveTokens, 16_384);
  assert.equal(large.keepRecentTokens, 20_000);
  // A window too small for both keeps the tail inside the window, or compaction
  // would never be able to run.
  const tiny = planCompactionPolicy(1_200);
  assert.ok(tiny.reserveTokens + tiny.keepRecentTokens < 1_200);
  assert.ok(tiny.keepRecentTokens > 0);
});

test("no plan request carries a billion-context id, even with a chat identity set", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-ui-loop-identity-"));
  try {
    const currentPath = join(directory, "current.json");
    await writeFile(currentPath, JSON.stringify({ conversationId: 42 }), "utf8");
    const bili = await installBillionContextInline({ currentPath });
    bili.setConversationIdentity("chat-9");
    assert.equal(bili.currentConversationId(), "chat-9");

    const scoped: Array<string | undefined> = [];
    withoutConversationIdentity(() => {
      scoped.push(bili.currentConversationId());
    });
    assert.deepEqual(scoped, [undefined]);

    // `current.json` alone must not leak either: that fallback is the whole trap.
    bili.setConversationIdentity(undefined);
    withoutConversationIdentity(() => {
      scoped.push(bili.currentConversationId());
    });
    assert.deepEqual(scoped, [undefined, undefined]);

    const seen: Array<{ url: string; init?: RequestInit }> = [];
    const underlying = (async (input: unknown, init?: RequestInit) => {
      seen.push({ url: String(input), init });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const fetchWithIdentity = createIdentityFetch(
      underlying,
      () => bili.currentConversationId(),
      [],
      { model: "m", contextWindow: 1_000 },
    );

    bili.setConversationIdentity("chat-9");
    await fetchWithIdentity("https://api.example.com/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    const chatHeaders = new Headers(seen[0]?.init?.headers);
    assert.equal(chatHeaders.get("x-bili-plugin-conversation"), "chat-9");
    assert.equal(seen[0]?.url.startsWith("http://billion-context.inline/bili/"), true);

    await withoutConversationIdentity(() =>
      fetchWithIdentity("https://api.example.com/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
      }),
    );
    const planHeaders = new Headers(seen[1]?.init?.headers);
    assert.equal(planHeaders.get("x-bili-plugin-conversation"), null);
    assert.equal(planHeaders.get("x-bili-plugin"), null);
    assert.equal(planHeaders.get("x-bili-plugin-model"), null);
    // Un-stamped requests go straight to the provider: the engine never sees them.
    assert.equal(seen[1]?.url, "https://api.example.com/v1/chat/completions");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

/** A plan conversation with no durable store: enough for the submit/settle paths. */
class LoopConversation {
  readonly appended: unknown[] = [];
  aborted = 0;
  private settle?: (value: unknown) => void;
  private count = 0;

  async submit() {
    this.count += 1;
    return {
      id: this.count,
      status: async () => ({ type: "input", status: "placed", entry: 1 }),
      wait: () =>
        new Promise((resolve) => {
          this.settle = resolve;
        }),
      abort: async () => {
        this.aborted += 1;
        this.settle?.({ type: "input", status: "unanswered", reason: "aborted" });
        return "aborted";
      },
    };
  }

  /** The lane aborts the turn, not one submission: durable's conversation-level abort. */
  async abort() {
    this.aborted += 1;
    this.settle?.({ type: "input", status: "unanswered", reason: "aborted" });
    return "aborted";
  }

  async context() {
    return { entries: [], docs: {} };
  }

  async commit(run: (tx: unknown) => unknown) {
    return run({
      appendEntry: (entry: { kind: string }, _id: number, draft: unknown) => {
        this.appended.push({ kind: entry.kind, draft });
        return { id: 2 };
      },
    });
  }
}

test("a repeated-call stop ends the plan run with a pi-ui error and a transcript row", async () => {
  const conversation = new LoopConversation();
  const session = new DurableTaskAgentSession(
    "taskloop",
    { abortSubmission: async () => "aborted" } as never,
    conversation as never,
  );
  const guard = new RepetitionGuard();
  session.useRepetitionGuard(guard);

  await session.send("start the loop");
  assert.equal(session.running(), true);

  // Five identical calls, as the harness runs them through the guard's hooks: the
  // fifth is blocked before it executes and the lane ends the run.
  for (let index = 0; index < 5; index += 1) {
    const call = toolCall({ command: "true" });
    const blocked = guard.beforeTool(call);
    if (blocked === undefined) guard.afterTool(call, settled());
    else assert.match(blocked.block, /^pi-ui stopped this run: bash was called 5/);
  }

  const snapshot = await eventually(async () => {
    const current = await session.snapshot();
    return (current.runError ?? null) === null ? null : current;
  }, "the repetition run error");

  assert.equal(conversation.aborted, 1);
  assert.equal(snapshot.runError?.class, "RunError");
  assert.match(snapshot.runError?.message ?? "", /^pi-ui stopped this run: bash was called 5/);
  assert.match(snapshot.runError?.message ?? "", /Send a message to continue/);
  assert.equal(snapshot.run, "idle");
  // The stop does not wait on the busy conversation to write its row, so the row lands
  // just after the error rather than blocking the refusal.
  const appended = await eventually(
    async () => (conversation.appended.length === 1 ? conversation.appended : null),
    "the repetition stop row",
  );
  assert.match(JSON.stringify(appended[0]), /pi-ui stopped this run/);

  // The stop is one run error, and the operator can dismiss it.
  await session.dismissError();
  assert.equal((await session.snapshot()).runError, null);
});

test("a provider loop guard is explained in pi-ui's words, never as a settings path", () => {
  const raw =
    "The model stopped because it detected a loop of repeated tool calls. " +
    "Turn this off in Settings › Models › Replies › Stop looping replies.";
  assert.equal(isProviderLoopGuard(raw), true);
  const annotated = annotateProviderLoopGuard(raw);
  assert.match(annotated, /^pi-ui stopped this run: the same tool call kept repeating/);
  assert.match(annotated, /Send a message to continue/);
  assert.doesNotMatch(annotated, /Settings/);
  assert.doesNotMatch(annotated, /Replies/);

  const named = annotateProviderLoopGuard('The run repeated tool "bash" 5 times in a row.');
  assert.match(named, /the bash tool call repeated 5 times in a row/);

  assert.equal(isProviderLoopGuard("the model returned a 400"), false);

  // The plan transcript rephrases the row itself, not only the run error above it.
  const row: ChatMessage = {
    id: "m-1",
    role: "assistant",
    text: raw,
    timestamp: "2025-01-01T00:00:00.000Z",
    order: 1,
    isError: true,
  };
  const ordinary: ChatMessage = { ...row, id: "m-2", text: "the model returned a 400" };
  const [visible] = visibleTaskAgentMessages([row, ordinary]);
  assert.doesNotMatch(visible?.text ?? "", /Settings/);
  assert.match(visible?.text ?? "", /^pi-ui stopped this run:/);
  assert.equal(visibleTaskAgentMessages([ordinary])[0]?.text, "the model returned a 400");

  // An answer that merely talks about repeating tool calls is prose, not a stop: only a
  // failed row can carry the provider's guard, so only a failed row is rewritten.
  const prose = "The agent stops repeating tool calls once the file is written.";
  const answer: ChatMessage = { ...row, id: "m-3", isError: false, text: prose };
  assert.equal(isProviderLoopGuard(prose), false);
  assert.equal(visibleTaskAgentMessages([answer])[0]?.text, prose);

  // Both lanes render rows through the one transcript builder, so the chat bubble is
  // rewritten there too: a provider error is shown as pi-ui's own sentence.
  const chat = buildTranscript([
    {
      id: 7,
      kind: AssistantEntry.kind,
      model: [{ role: "assistant", content: [], errorMessage: raw, timestamp: 2 }],
    } as unknown as EntryRecord,
  ]).messages;
  assert.equal(chat.length, 1);
  assert.match(chat[0]?.text ?? "", /^pi-ui stopped this run:/);
  assert.doesNotMatch(chat[0]?.text ?? "", /Settings/);
  assert.equal(chat[0]?.isError, true);
});

/**
 * A scripted model: every request is answered with the same `bash` call until the
 * test flips it to a plain answer, so a run can only end when pi-ui stops it.
 */
interface ScriptedModel {
  readonly port: number;
  readonly requests: Array<{ headers: IncomingMessage["headers"]; body: string }>;
  readonly origin: string;
  answerWithText(): void;
  close(): Promise<void>;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function event(res: ServerResponse, payload: unknown): void {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function chunk(content: string, finishReason: string | null = null): unknown {
  return {
    id: "chatcmpl-loop",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "loop-model",
    choices: [
      {
        index: 0,
        delta: content.length > 0 ? { role: "assistant", content } : {},
        finish_reason: finishReason,
      },
    ],
  };
}

interface ScriptedModelOptions {
  /** Start in answer mode instead of emitting the tool call. */
  readonly answerFirst?: boolean;
  /** The plain answer every non-tool request gets. */
  readonly answer?: string;
}

const LOOP_ANSWER = "The loop stopped; this is a normal answer.";

async function startScriptedModel(
  command: string,
  options: ScriptedModelOptions = {},
): Promise<ScriptedModel> {
  const requests: ScriptedModel["requests"] = [];
  const answer = options.answer ?? LOOP_ANSWER;
  const state = { toolCalls: options.answerFirst !== true };
  const server: Server = createServer(async (req, res) => {
    if (req.method !== "POST" || req.url?.endsWith("/chat/completions") !== true) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "not found" } }));
      return;
    }
    requests.push({ headers: req.headers, body: await readBody(req) });
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    if (state.toolCalls) {
      event(res, {
        id: "chatcmpl-loop",
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: "loop-model",
        choices: [
          {
            index: 0,
            delta: {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: `call_loop_${requests.length}`,
                  type: "function",
                  function: { name: "bash", arguments: JSON.stringify({ command }) },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      });
      event(res, chunk("", "tool_calls"));
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }
    for (const piece of answer.match(/.{1,16}/gs) ?? []) {
      event(res, chunk(piece));
    }
    event(res, chunk("", "stop"));
    res.write("data: [DONE]\n\n");
    res.end();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      resolve();
    });
  });
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  return {
    port: address.port,
    requests,
    origin: `http://127.0.0.1:${address.port}`,
    answerWithText: () => {
      state.toolCalls = false;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      }),
  };
}

test("a scripted plan model loops four times, is stopped by pi-ui, and continues on a message", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-ui-loop-e2e-"));
  const agentDir = join(directory, "agent");
  await mkdir(agentDir, { recursive: true });
  const hitsPath = join(directory, "hits.txt");
  const command = `echo hit >> ${JSON.stringify(hitsPath)}`;
  const model = await startScriptedModel(command);
  // The production identity wrapper, installed for this run. A plan request that still
  // carried a billion-context id would be stamped and redirected into the inline engine,
  // so the zero observations asserted below mean the plan lane ran outside it — not that
  // no wrapper exists in this process.
  const previousFetch = globalThis.fetch;
  const identitySeen: ObservedRequest[] = [];
  const leaked: string[] = [];
  // The engine transport answers its own origin and delegates everything else to the
  // real fetch, so an un-stamped plan request still reaches the scripted model while a
  // stamped one lands in `leaked` instead of arriving there.
  const engineFetch: typeof globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith("http://billion-context.inline/")) return previousFetch(input, init);
    leaked.push(url);
    return new Response("{}", { status: 200 });
  };
  globalThis.fetch = createIdentityFetch(
    engineFetch,
    () => "chat-conversation-1",
    identitySeen,
    { model: "loop/loop-model", contextWindow: 200_000, maxOutput: 1_024 },
  );
  // Control: outside the plan scope the same wrapper stamps and redirects, so the empty
  // `leaked` asserted after the run cannot pass because the wrapper is inert.
  await withConversationIdentity("chat-conversation-1", () =>
    globalThis
      .fetch(`${model.origin}/v1/chat/completions`, { method: "POST", body: "{}" })
      .then(() => undefined),
  );
  assert.equal(identitySeen.at(-1)?.conversationHeader, "chat-conversation-1");
  assert.deepEqual(leaked, [
    `http://billion-context.inline/bili/${model.origin}/v1/chat/completions`,
  ]);
  identitySeen.length = 0;
  leaked.length = 0;
  const previous = {
    agentDir: process.env.PI_CODING_AGENT_DIR,
    model: process.env.PI_MODEL,
    offline: process.env.PI_OFFLINE,
  };
  const store = new TaskStore(join(directory, "tasks.json"));
  let manager: TaskAgentManager | undefined;
  try {
    await store.load();
    await writeFile(
      join(agentDir, "models.json"),
      JSON.stringify(
        {
          providers: {
            loop: {
              baseUrl: `${model.origin}/v1`,
              api: "openai-completions",
              apiKey: "loop",
              models: [
                {
                  id: "loop-model",
                  name: "Loop Model",
                  reasoning: false,
                  input: ["text"],
                  contextWindow: 200_000,
                  maxTokens: 1_024,
                },
              ],
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.PI_MODEL = "loop/loop-model";
    process.env.PI_OFFLINE = "1";

    const catalog = await createModelCatalog();
    assert.ok(catalog.model, "the scripted model must be selectable");

    manager = new TaskAgentManager({
      dataDir: directory,
      cwd: directory,
      models: catalog.runtime,
      model: catalog.model,
      store,
      publish: () => {},
      baseInstructions: "You are a plan agent.",
    });
    const created = (await store.create(DEFAULT_NEW_TASK_TITLE, null)).tasks.find(
      (task) => task.title === DEFAULT_NEW_TASK_TITLE,
    );
    assert.ok(created);

    const session = await manager.ensure(created.id);
    const send = session.send?.bind(session);
    assert.ok(send !== undefined, "a durable plan session has the shared chat core's send");
    await send("repeat the same call until pi-ui stops you", [], "queue");

    const stopped = await eventually(async () => {
      const snapshot = await session.snapshot();
      return (snapshot.runError ?? null) === null ? null : snapshot;
    }, "the pi-ui repetition stop", 1_500);

    assert.equal(stopped.runError?.class, "RunError");
    assert.match(stopped.runError?.message ?? "", /pi-ui stopped this run: bash was called 5/);
    assert.match(stopped.runError?.message ?? "", /tools available/);

    // The refused call never ran: exactly four identical commands reached the shell.
    const hits = (await readFile(hitsPath, "utf8")).trim().split("\n");
    assert.equal(hits.length, 4);

    // The warning reached the model with the third result, before the refusal. The stop
    // may land before or after the harness records the blocked call, so the request count
    // is a floor: no request exists whose only effect could be a fifth identical call.
    assert.ok(model.requests.length >= 5, "the run stopped after the fifth request");
    assert.match(model.requests[3]?.body ?? "", /3rd identical bash call/);

    // The plan lane carries no billion-context identity on any request, and the live
    // wrapper never stamped one: nothing was observed and nothing was redirected into
    // the engine, while the scripted model did receive every turn.
    assert.deepEqual(identitySeen, []);
    assert.deepEqual(leaked, []);
    for (const request of model.requests) {
      assert.equal(request.headers["x-bili-plugin-conversation"], undefined);
      assert.equal(request.headers["x-bili-plugin"], undefined);
      assert.equal(request.headers["x-bili-plugin-model"], undefined);
      // The plan lane is bounded by pi-durable's compaction, so the model is never asked
      // to compress its own context.
      assert.doesNotMatch(request.body, /\bcompress\b/i);
    }

    // The stop is explicable in the transcript, not only in the header.
    const notice = await eventually(async () => {
      const snapshot = await session.snapshot();
      return snapshot.messages.find((message) => message.text.includes("pi-ui stopped this run"));
    }, "the pi-ui stop row");
    assert.equal(notice.role, "assistant");
    assert.match(notice.text, /Send a message to continue/);

    // "Send a message to continue" is true: the same conversation runs again.
    model.answerWithText();
    await send("what now?", [], "queue");
    const answered = await eventually(async () => {
      const snapshot = await session.snapshot();
      return (snapshot.runError ?? null) === null &&
        snapshot.messages.some((message) => message.text.includes("this is a normal answer"))
        ? snapshot
        : null;
    }, "the continued turn", 1_500);
    assert.equal(answered.run, "idle");
    assert.ok(answered.messages.some((message) => message.text.includes("pi-ui stopped this run")));
  } finally {
    globalThis.fetch = previousFetch;
    await manager?.close();
    await model.close();
    if (previous.agentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous.agentDir;
    if (previous.model === undefined) delete process.env.PI_MODEL;
    else process.env.PI_MODEL = previous.model;
    if (previous.offline === undefined) delete process.env.PI_OFFLINE;
    else process.env.PI_OFFLINE = previous.offline;
    await rm(directory, { recursive: true, force: true });
  }
});

test("a plan conversation that crosses the window compacts with pi-durable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-ui-loop-compact-"));
  const agentDir = join(directory, "agent");
  await mkdir(agentDir, { recursive: true });
  // Answers of roughly 1_400 tokens, so a few turns cross the 8_192-token window even
  // with the plan instructions in the prompt, while a summary stays small enough that
  // the compacted prompt is well under the window again.
  const answer = Array.from(
    { length: 100 },
    (_, index) => `Sentence ${index} keeps this answer long enough to cross a small window.`,
  ).join(" ");
  const model = await startScriptedModel("true", { answerFirst: true, answer });
  const previous = {
    agentDir: process.env.PI_CODING_AGENT_DIR,
    model: process.env.PI_MODEL,
    offline: process.env.PI_OFFLINE,
  };
  const store = new TaskStore(join(directory, "tasks.json"));
  let manager: TaskAgentManager | undefined;
  try {
    await store.load();
    await writeFile(
      join(agentDir, "models.json"),
      JSON.stringify(
        {
          providers: {
            loop: {
              baseUrl: `${model.origin}/v1`,
              api: "openai-completions",
              apiKey: "loop",
              models: [
                {
                  id: "loop-model",
                  name: "Loop Model",
                  reasoning: false,
                  input: ["text"],
                  contextWindow: 8_192,
                  maxTokens: 1_024,
                },
              ],
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.PI_MODEL = "loop/loop-model";
    process.env.PI_OFFLINE = "1";

    const catalog = await createModelCatalog();
    assert.ok(catalog.model);
    manager = new TaskAgentManager({
      dataDir: directory,
      cwd: directory,
      models: catalog.runtime,
      model: catalog.model,
      store,
      publish: () => {},
      baseInstructions: "You are a plan agent.",
    });
    const created = (await store.create(DEFAULT_NEW_TASK_TITLE, null)).tasks.find(
      (task) => task.title === DEFAULT_NEW_TASK_TITLE,
    );
    assert.ok(created);
    const session = await manager.ensure(created.id);
    const send = session.send?.bind(session);
    assert.ok(send !== undefined);

    for (let turn = 1; turn <= 6; turn += 1) {
      await send(`QUESTION-${turn} plan the next step`, [], "queue");
      await eventually(async () => {
        const snapshot = await session.snapshot();
        return snapshot.run === "idle" &&
          snapshot.messages.some((message) => message.text.includes(`QUESTION-${turn}`))
          ? snapshot
          : null;
      }, `turn ${turn}`, 2_000);
    }

    const snapshot = await session.snapshot();
    // The summary replaced the old prefix: the first turn is gone from the transcript.
    assert.equal(
      snapshot.messages.some((message) => message.text.includes("QUESTION-1 ")),
      false,
    );
    // The newest turn is verbatim, so the conversation continues where it stopped.
    assert.ok(snapshot.messages.some((message) => message.text.includes("QUESTION-6 ")));
    // pi-durable, not billion-context: the model is never asked to compress anything, and
    // the prompt it gets for the last turn no longer carries the compacted first turn.
    for (const request of model.requests) assert.doesNotMatch(request.body, /\bcompress\b/i);
    assert.doesNotMatch(model.requests.at(-1)?.body ?? "", /QUESTION-1 /);
    assert.ok(model.requests.length > 6, "compaction made at least one summarising request");
  } finally {
    await manager?.close();
    await model.close();
    if (previous.agentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous.agentDir;
    if (previous.model === undefined) delete process.env.PI_MODEL;
    else process.env.PI_MODEL = previous.model;
    if (previous.offline === undefined) delete process.env.PI_OFFLINE;
    else process.env.PI_OFFLINE = previous.offline;
    await rm(directory, { recursive: true, force: true });
  }
});
