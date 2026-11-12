import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { defineEntry } from "@earendil-works/pi-durable";
import {
  parseTaskQuestionAnswers,
  parseTaskQuestions,
  questionAnswerItems,
  taskQuestionAnswerSummary,
} from "../shared/questions.js";
import type {
  AnsweredQuestionItem,
  TaskQuestion,
  TaskQuestionAnswerRecord,
  TaskQuestionKind,
  TaskQuestionSet,
} from "../shared/types.js";
import { TaskError } from "./tasks.js";

const MAX_ANSWERED_HISTORY = 20;

interface StoredQuestions {
  pending: TaskQuestionSet | null;
  answered: TaskQuestionAnswerRecord[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function sameQuestion(left: TaskQuestion, right: TaskQuestion): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function readSet(value: unknown): TaskQuestionSet | null {
  if (!isRecord(value)) return null;
  const id = typeof value.id === "string" ? value.id : "";
  const taskId = typeof value.taskId === "string" ? value.taskId : "";
  const createdAt = typeof value.createdAt === "string" ? value.createdAt : "";
  const parsed = parseTaskQuestions(value.questions);
  if (id.length === 0 || taskId.length === 0 || createdAt.length === 0 || !parsed.ok) return null;
  return {
    id,
    taskId,
    createdAt,
    questions: parsed.questions,
    ...(typeof value.askedBy === "string" ? { askedBy: value.askedBy } : {}),
  };
}

function readRecord(value: unknown): TaskQuestionAnswerRecord | null {
  if (!isRecord(value)) return null;
  const setId = typeof value.setId === "string" ? value.setId : "";
  const taskId = typeof value.taskId === "string" ? value.taskId : "";
  const answeredAt = typeof value.answeredAt === "string" ? value.answeredAt : "";
  const parsedQuestions = parseTaskQuestions(value.questions);
  const parsedAnswers = parsedQuestions.ok
    ? parseTaskQuestionAnswers(parsedQuestions.questions, value.answers)
    : { ok: false as const, error: "" };
  if (
    setId.length === 0 ||
    taskId.length === 0 ||
    answeredAt.length === 0 ||
    !parsedQuestions.ok ||
    !parsedAnswers.ok
  ) {
    return null;
  }
  return {
    setId,
    taskId,
    answeredAt,
    questions: parsedQuestions.questions,
    answers: parsedAnswers.answers,
    ...(typeof value.askedBy === "string" ? { askedBy: value.askedBy } : {}),
  };
}

function readState(value: unknown): StoredQuestions {
  if (!isRecord(value)) return { pending: null, answered: [] };
  const pending = value.pending === null ? null : readSet(value.pending);
  const answered = Array.isArray(value.answered)
    ? value.answered
        .map(readRecord)
        .filter((record): record is TaskQuestionAnswerRecord => record !== null)
        .slice(-MAX_ANSWERED_HISTORY)
    : [];
  return { pending, answered };
}

export interface QuestionAnswerResult {
  set: TaskQuestionSet;
  record: TaskQuestionAnswerRecord;
  items: AnsweredQuestionItem[];
  summary: string;
}

/**
 * The pending question set for one task. It lives in the task agent's directory, next to its
 * conversation, so a reload and a server restart both see the same unanswered questions.
 */
export class TaskQuestionsStore {
  private state: StoredQuestions = { pending: null, answered: [] };
  private loading: Promise<void> | undefined;
  private lock: Promise<unknown> = Promise.resolve();
  private readonly waiters = new Map<string, Set<(result: QuestionAnswerResult) => void>>();

  constructor(private readonly path: string) {}

  load(): Promise<void> {
    this.loading ??= this.read();
    return this.loading;
  }

  private async read(): Promise<void> {
    try {
      const contents = await readFile(this.path, "utf8");
      this.state = readState(JSON.parse(contents) as unknown);
    } catch (error) {
      if (isRecord(error) && error.code === "ENOENT") return;
      console.error("[task-questions] could not read pending questions", error);
    }
  }

  private async save(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.tmp-${process.pid}`;
    await writeFile(temporary, `${JSON.stringify(this.state)}\n`, "utf8");
    await rename(temporary, this.path);
  }

  private async mutate<T>(change: () => Promise<T> | T): Promise<T> {
    const run = this.lock.then(async () => {
      await this.load();
      const result = await change();
      await this.save();
      return result;
    });
    this.lock = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async pending(): Promise<TaskQuestionSet | null> {
    await this.load();
    return this.state.pending === null ? null : clone(this.state.pending);
  }

  async answeredBy(askedBy: string): Promise<QuestionAnswerResult | null> {
    await this.load();
    const record = this.state.answered.find((item) => item.askedBy === askedBy);
    if (record === undefined) return null;
    return this.result(record);
  }

  private result(record: TaskQuestionAnswerRecord): QuestionAnswerResult {
    const items = questionAnswerItems(record.questions, record.answers);
    return {
      set: {
        id: record.setId,
        taskId: record.taskId,
        createdAt: record.answeredAt,
        questions: clone(record.questions),
        ...(record.askedBy === undefined ? {} : { askedBy: record.askedBy }),
      },
      record: clone(record),
      items,
      summary: taskQuestionAnswerSummary(items),
    };
  }

  /** Add questions, merging into the one pending set instead of replacing it. */
  async add(
    taskId: string,
    questions: readonly TaskQuestion[],
    askedBy?: string,
  ): Promise<{ set: TaskQuestionSet; added: number }> {
    return this.mutate(() => {
      const current = this.state.pending;
      if (current !== null && askedBy !== undefined && current.askedBy === askedBy) {
        const replay = questions.every((question) =>
          current.questions.some((existing) => sameQuestion(existing, question)),
        );
        if (replay) return { set: clone(current), added: 0 };
      }
      const existingIds = new Set((current?.questions ?? []).map((question) => question.id));
      for (const question of questions) {
        if (existingIds.has(question.id)) {
          throw new TaskError(`Question id "${question.id}" is already waiting`, 400);
        }
      }
      const set: TaskQuestionSet =
        current === null
          ? {
              id: randomUUID(),
              taskId,
              createdAt: new Date().toISOString(),
              questions: [],
              ...(askedBy === undefined ? {} : { askedBy }),
            }
          : clone(current);
      set.questions.push(...clone(questions));
      if (askedBy !== undefined && set.askedBy === undefined) set.askedBy = askedBy;
      this.state.pending = set;
      return { set: clone(set), added: questions.length };
    });
  }

  async waitForAnswers(setId: string, signal?: AbortSignal): Promise<QuestionAnswerResult> {
    await this.load();
    const existing = this.state.answered.find((record) => record.setId === setId);
    if (existing !== undefined) return this.result(existing);
    return new Promise((resolve, reject) => {
      const listeners = this.waiters.get(setId) ?? new Set();
      const finish = (result: QuestionAnswerResult) => {
        listeners.delete(finish);
        if (listeners.size === 0) this.waiters.delete(setId);
        signal?.removeEventListener("abort", abort);
        resolve(result);
      };
      const abort = () => {
        listeners.delete(finish);
        if (listeners.size === 0) this.waiters.delete(setId);
        reject(signal?.reason ?? new Error("Question wait aborted"));
      };
      if (signal?.aborted === true) {
        abort();
        return;
      }
      listeners.add(finish);
      this.waiters.set(setId, listeners);
      signal?.addEventListener("abort", abort, { once: true });
    });
  }

  /** Record answers, clear the pending set, and keep a bounded history for replay. */
  async answer(setId: string, answers: unknown): Promise<QuestionAnswerResult> {
    return this.mutate(() => {
      const pending = this.state.pending;
      if (pending === null || pending.id !== setId) {
        throw new TaskError("This question set is no longer waiting for answers", 409);
      }
      const parsed = parseTaskQuestionAnswers(pending.questions, answers);
      if (!parsed.ok) throw new TaskError(parsed.error, 400);
      const record: TaskQuestionAnswerRecord = {
        setId: pending.id,
        taskId: pending.taskId,
        answeredAt: new Date().toISOString(),
        questions: clone(pending.questions),
        answers: clone(parsed.answers),
        ...(pending.askedBy === undefined ? {} : { askedBy: pending.askedBy }),
      };
      this.state.pending = null;
      this.state.answered.push(record);
      if (this.state.answered.length > MAX_ANSWERED_HISTORY) {
        this.state.answered.splice(0, this.state.answered.length - MAX_ANSWERED_HISTORY);
      }
      return this.result(record);
    });
  }

  /** Wake the tool that is waiting on this set, after its transcript row is committed. */
  resolve(setId: string, result: QuestionAnswerResult): void {
    const listeners = this.waiters.get(setId);
    if (listeners === undefined) return;
    this.waiters.delete(setId);
    for (const listener of [...listeners]) listener(result);
  }
}

type QuestionAnswerEntryItem = {
  id: string;
  prompt: string;
  kind: TaskQuestionKind;
  values: string[];
  labels: string[];
  text: string;
};

export type TaskQuestionAnswerEntryData = {
  setId: string;
  taskId: string;
  text: string;
  answers: QuestionAnswerEntryItem[];
  createdAt: string;
};

/** The operator's choices, rendered in the planning transcript as a card (and never as JSON). */
export const TaskQuestionAnswerEntry = defineEntry<TaskQuestionAnswerEntryData>(
  "ui.task-question-answers",
);
