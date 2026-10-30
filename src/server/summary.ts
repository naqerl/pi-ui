import type {
  Api,
  AssistantMessage,
  Context,
  Model,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { SUMMARY_MAX_CHARACTERS, SUMMARY_MIN_CHARACTERS } from "../shared/types.js";

const SUMMARY_TIMEOUT_MS = 20_000;
const SUMMARY_MAX_TOKENS = 120;

const SUMMARY_PROMPT =
  "Summarise this assistant reply in at most two sentences. No preamble, no bullet points, no code. If it is not a substantive reply, answer with a single word: skip.";

/** The part of `ModelRuntime` a summary needs; tests can pass a small stub instead. */
export interface SummaryRuntime {
  completeSimple(
    model: Model<Api>,
    context: Context,
    options?: SimpleStreamOptions,
  ): Promise<AssistantMessage>;
}

interface SummaryModel {
  runtime: SummaryRuntime;
  model: Model<Api>;
}

let activeModel: SummaryModel | undefined;

/** Set from the conversation's model plumbing, and cleared when no model is configured. */
export function setSummaryModel(
  runtime: SummaryRuntime | undefined,
  model: Model<Api> | undefined,
) {
  activeModel = runtime === undefined || model === undefined ? undefined : { runtime, model };
}

/** Successful summaries and skips, keyed by message id, so a reload does not ask again. */
const summaryCache = new Map<string, string | null>();
const pending = new Map<string, Promise<string | null>>();

/** `undefined` when this message has not been tried, `null` when it was skipped or failed. */
export function cachedSummary(messageId: string): string | null | undefined {
  return summaryCache.get(messageId);
}

export function isSummarizableText(text: string): boolean {
  const length = text.trim().length;
  return length >= SUMMARY_MIN_CHARACTERS && length <= SUMMARY_MAX_CHARACTERS;
}

function assistantText(message: AssistantMessage): string {
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Asks the configured model for a two-sentence summary. Any missing configuration,
 * error, timeout, empty answer or explicit `skip` becomes null; a turn never sees it.
 */
export async function summarizeReply(text: string): Promise<string | null> {
  if (!isSummarizableText(text)) return null;
  const configured = activeModel;
  if (configured === undefined) return null;

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("summary timed out"));
    }, SUMMARY_TIMEOUT_MS);
    timer.unref?.();
  });
  try {
    const message = await Promise.race([
      configured.runtime.completeSimple(
        configured.model,
        {
          systemPrompt: SUMMARY_PROMPT,
          messages: [{ role: "user", content: text, timestamp: Date.now() }],
        },
        { maxTokens: SUMMARY_MAX_TOKENS, signal: controller.signal },
      ),
      timeout,
    ]);
    const summary = assistantText(message);
    if (summary.length === 0 || /^skip[.!]?$/i.test(summary)) return null;
    return summary;
  } catch {
    return null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** One summary per message id, shared by the automatic pass, the endpoint and reloads. */
export function summaryForMessage(messageId: string, text: string): Promise<string | null> {
  if (summaryCache.has(messageId)) return Promise.resolve(summaryCache.get(messageId) ?? null);
  const existing = pending.get(messageId);
  if (existing !== undefined) return existing;

  const request = summarizeReply(text)
    .then((summary) => {
      summaryCache.set(messageId, summary);
      return summary;
    })
    .catch(() => null)
    .finally(() => {
      pending.delete(messageId);
    });
  pending.set(messageId, request);
  return request;
}
