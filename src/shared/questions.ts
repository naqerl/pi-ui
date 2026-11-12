import type {
  AnsweredQuestionItem,
  TaskQuestion,
  TaskQuestionAnswer,
  TaskQuestionKind,
  TaskQuestionOption,
} from "./types.js";

export type QuestionParseResult =
  | { ok: true; questions: TaskQuestion[] }
  | { ok: false; error: string };

export type AnswerParseResult =
  | { ok: true; answers: TaskQuestionAnswer[] }
  | { ok: false; error: string };

const KINDS = new Set<TaskQuestionKind>(["single", "multi", "text"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function parseOptions(value: unknown, id: string): TaskQuestionOption[] | string {
  if (!Array.isArray(value) || value.length === 0) {
    return `Question "${id}" needs at least one option`;
  }
  const options: TaskQuestionOption[] = [];
  const values = new Set<string>();
  for (const [index, raw] of value.entries()) {
    if (!isRecord(raw)) return `Question "${id}" option ${index + 1} must be an object`;
    const optionValue = text(raw.value);
    const label = text(raw.label);
    if (optionValue.length === 0) {
      return `Question "${id}" option ${index + 1} needs a value`;
    }
    if (label.length === 0) return `Question "${id}" option "${optionValue}" needs a label`;
    if (values.has(optionValue)) {
      return `Question "${id}" repeats option value "${optionValue}"`;
    }
    values.add(optionValue);
    const detail = text(raw.detail);
    options.push({
      value: optionValue,
      label,
      ...(detail.length === 0 ? {} : { detail }),
    });
  }
  return options;
}

/** Validate the model-supplied question list before it reaches the panel or the store. */
export function parseTaskQuestions(value: unknown): QuestionParseResult {
  if (!Array.isArray(value) || value.length === 0) {
    return { ok: false, error: "questions must be a non-empty list" };
  }
  const questions: TaskQuestion[] = [];
  const ids = new Set<string>();
  for (const [index, raw] of value.entries()) {
    if (!isRecord(raw)) return { ok: false, error: `questions[${index}] must be an object` };
    const id = text(raw.id);
    if (id.length === 0) return { ok: false, error: `questions[${index}] needs an id` };
    if (ids.has(id)) return { ok: false, error: `Duplicate question id "${id}"` };
    ids.add(id);
    const prompt = text(raw.prompt);
    if (prompt.length === 0) {
      return { ok: false, error: `Question "${id}" needs a prompt` };
    }
    if (typeof raw.kind !== "string" || !KINDS.has(raw.kind as TaskQuestionKind)) {
      return {
        ok: false,
        error: `Question "${id}" has an unknown kind ${JSON.stringify(raw.kind)}; use single, multi or text`,
      };
    }
    const kind = raw.kind as TaskQuestionKind;
    if (raw.allowOther !== undefined && typeof raw.allowOther !== "boolean") {
      return { ok: false, error: `Question "${id}" allowOther must be a boolean` };
    }
    let options: TaskQuestionOption[] | undefined;
    if (kind === "single" || kind === "multi") {
      const parsed = parseOptions(raw.options, id);
      if (typeof parsed === "string") return { ok: false, error: parsed };
      options = parsed;
    } else if (raw.options !== undefined) {
      const parsed = parseOptions(raw.options, id);
      if (typeof parsed === "string") return { ok: false, error: parsed };
      options = parsed;
    }
    questions.push({
      id,
      prompt,
      kind,
      ...(options === undefined ? {} : { options }),
      ...(raw.allowOther === true ? { allowOther: true } : {}),
    });
  }
  return { ok: true, questions };
}

function optionValues(question: TaskQuestion): Set<string> {
  return new Set((question.options ?? []).map((option) => option.value));
}

export function questionAnswerReady(
  question: TaskQuestion,
  answer: Pick<TaskQuestionAnswer, "values" | "text"> | undefined,
): boolean {
  if (answer === undefined) return false;
  const note = answer.text.trim();
  if (question.kind === "text") return note.length > 0;
  const valid = optionValues(question);
  const values = answer.values.filter((value) => valid.has(value));
  if (question.kind === "single") {
    return values.length === 1 || (question.allowOther === true && note.length > 0);
  }
  return values.length > 0 || (question.allowOther === true && note.length > 0);
}

/** Validate submitted answers against the pending questions, preserving question order. */
export function parseTaskQuestionAnswers(
  questions: readonly TaskQuestion[],
  value: unknown,
): AnswerParseResult {
  if (!Array.isArray(value)) return { ok: false, error: "answers must be a list" };
  const byId = new Map(questions.map((question) => [question.id, question]));
  const submitted = new Map<string, TaskQuestionAnswer>();
  for (const [index, raw] of value.entries()) {
    if (!isRecord(raw)) return { ok: false, error: `answers[${index}] must be an object` };
    const id = text(raw.id);
    if (id.length === 0) return { ok: false, error: `answers[${index}] needs a question id` };
    const question = byId.get(id);
    if (question === undefined) {
      return { ok: false, error: `Answer "${id}" does not match a waiting question` };
    }
    if (submitted.has(id)) return { ok: false, error: `Answer "${id}" was submitted twice` };
    const rawValues = raw.values === undefined ? [] : raw.values;
    if (!Array.isArray(rawValues) || rawValues.some((item) => typeof item !== "string")) {
      return { ok: false, error: `Answer "${id}" values must be a list of strings` };
    }
    if (raw.text !== undefined && typeof raw.text !== "string") {
      return { ok: false, error: `Answer "${id}" text must be a string` };
    }
    const values = rawValues.map((item) => item.trim());
    if (new Set(values).size !== values.length) {
      return { ok: false, error: `Answer "${id}" repeats a value` };
    }
    const valid = optionValues(question);
    const unknown = values.find((item) => !valid.has(item));
    if (unknown !== undefined) {
      return { ok: false, error: `Answer "${id}" has unknown option "${unknown}"` };
    }
    if (question.kind === "single" && values.length > 1) {
      return { ok: false, error: `Answer "${id}" may choose only one option` };
    }
    if (question.kind === "text" && values.length > 0) {
      return { ok: false, error: `Answer "${id}" is free text, not a choice` };
    }
    submitted.set(id, { id, values, text: typeof raw.text === "string" ? raw.text.trim() : "" });
  }
  const answers: TaskQuestionAnswer[] = [];
  for (const question of questions) {
    const answer = submitted.get(question.id);
    if (answer === undefined) {
      return { ok: false, error: `Question "${question.id}" needs an answer` };
    }
    if (!questionAnswerReady(question, answer)) {
      return { ok: false, error: `Question "${question.id}" needs an answer` };
    }
    answers.push(answer);
  }
  return { ok: true, answers };
}

/** Map answers to readable labels for the transcript block and the one-line summary. */
export function questionAnswerItems(
  questions: readonly TaskQuestion[],
  answers: readonly TaskQuestionAnswer[],
): AnsweredQuestionItem[] {
  const byId = new Map(answers.map((answer) => [answer.id, answer]));
  return questions.map((question) => {
    const answer = byId.get(question.id);
    const values = answer?.values ?? [];
    const labels = (question.options ?? [])
      .filter((option) => values.includes(option.value))
      .map((option) => option.label);
    return {
      id: question.id,
      prompt: question.prompt,
      kind: question.kind,
      values,
      labels,
      text: answer?.text ?? "",
    };
  });
}

/** One line for the agent's tool result: what the operator chose. */
export function taskQuestionAnswerSummary(items: readonly AnsweredQuestionItem[]): string {
  const count = items.length;
  const choices = items.map((item) => {
    const choice = item.labels.length > 0 ? item.labels.join(", ") : item.text;
    return `${item.prompt} = ${choice.length === 0 ? "(blank)" : choice}`;
  });
  const line = `Answered ${count} question${count === 1 ? "" : "s"}: ${choices.join("; ")}`;
  return line.replace(/\s+/g, " ").trim();
}

/** The JSON half of the tool result, kept separate so the summary stays one line. */
export function taskQuestionAnswerPayload(
  items: readonly AnsweredQuestionItem[],
  answers: readonly TaskQuestionAnswer[],
): string {
  return JSON.stringify({
    answers: answers.map((answer) => ({
      id: answer.id,
      values: answer.values,
      text: answer.text,
    })),
    items: items.map((item) => ({
      id: item.id,
      prompt: item.prompt,
      labels: item.labels,
      text: item.text,
    })),
  });
}
