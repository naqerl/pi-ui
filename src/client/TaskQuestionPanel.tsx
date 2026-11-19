import { useEffect, useState } from "react";
import { questionAnswerReady } from "../shared/questions";
import type { TaskQuestion, TaskQuestionAnswer, TaskQuestionSet } from "../shared/types";
import { Button } from "./components/ui/button";
import { cn } from "./lib/utils";

type Draft = Pick<TaskQuestionAnswer, "values" | "text">;
type Drafts = Record<string, Draft>;

function blankDrafts(questions: readonly TaskQuestion[]): Drafts {
  return Object.fromEntries(questions.map((question) => [question.id, { values: [], text: "" }]));
}

function mergedDrafts(current: Drafts, questions: readonly TaskQuestion[]): Drafts {
  return Object.fromEntries(
    questions.map((question) => [question.id, current[question.id] ?? { values: [], text: "" }]),
  );
}

function otherAnswers(
  question: TaskQuestion,
  draft: Pick<TaskQuestionAnswer, "values" | "text">,
): boolean {
  return question.kind !== "text" && question.allowOther === true && draft.text.trim().length > 0;
}

function OptionRow({
  question,
  option,
  checked,
  disabled,
  multi,
  onToggle,
}: {
  question: TaskQuestion;
  option: NonNullable<TaskQuestion["options"]>[number];
  checked: boolean;
  disabled: boolean;
  multi: boolean;
  onToggle: () => void;
}) {
  return (
    <label
      className={cn(
        "flex items-start gap-lg py-sm text-sm leading-5 text-foreground",
        disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer",
        "has-[:focus-visible]:outline has-[:focus-visible]:outline-1 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-foreground",
      )}
    >
      <input
        type={multi ? "checkbox" : "radio"}
        name={`question-${question.id}`}
        value={option.value}
        checked={checked}
        disabled={disabled}
        aria-label={option.label}
        data-testid={`question-${question.id}-${option.value}`}
        onChange={onToggle}
        className="mt-sm size-4 shrink-0 accent-foreground"
      />
      <span className="min-w-0">
        <span className="block [overflow-wrap:anywhere]">{option.label}</span>
        {option.detail !== undefined && option.detail.length > 0 && (
          <span className="mt-xs block text-xs leading-4 text-muted-foreground [overflow-wrap:anywhere]">
            {option.detail}
          </span>
        )}
      </span>
    </label>
  );
}

export function TaskQuestionPanel({
  set,
  onAnswer,
}: {
  set: TaskQuestionSet;
  onAnswer: (setId: string, answers: TaskQuestionAnswer[]) => Promise<boolean>;
}) {
  const [state, setState] = useState(() => ({
    setId: set.id,
    drafts: blankDrafts(set.questions),
  }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setState((current) =>
      current.setId === set.id
        ? { setId: set.id, drafts: mergedDrafts(current.drafts, set.questions) }
        : { setId: set.id, drafts: blankDrafts(set.questions) },
    );
    setError(null);
  }, [set.id, set.questions]);

  const drafts = state.setId === set.id ? state.drafts : blankDrafts(set.questions);
  const ready = set.questions.every((question) =>
    questionAnswerReady(question, drafts[question.id]),
  );

  const update = (id: string, change: (draft: Draft) => Draft) => {
    setState((current) => ({
      setId: current.setId,
      drafts: {
        ...current.drafts,
        [id]: change(current.drafts[id] ?? { values: [], text: "" }),
      },
    }));
  };

  const toggle = (question: TaskQuestion, value: string) => {
    update(question.id, (draft) => {
      if (otherAnswers(question, draft)) return draft;
      if (question.kind === "single") return { ...draft, values: [value] };
      const values = draft.values.includes(value)
        ? draft.values.filter((item) => item !== value)
        : [...draft.values, value];
      return { ...draft, values };
    });
  };

  const updateText = (question: TaskQuestion, text: string) => {
    update(question.id, (draft) =>
      question.kind !== "text" && text.trim().length > 0
        ? { values: [], text }
        : { ...draft, text },
    );
  };

  const submit = async () => {
    if (busy || !ready) return;
    setBusy(true);
    setError(null);
    const answers = set.questions.map((question) => {
      const draft = drafts[question.id] ?? { values: [], text: "" };
      return {
        id: question.id,
        values: otherAnswers(question, draft) ? [] : draft.values,
        text: draft.text,
      };
    });
    const ok = await onAnswer(set.id, answers);
    setBusy(false);
    if (!ok) setError("Could not send the answers. Try again.");
  };

  return (
    <form
      data-testid="task-questions-panel"
      data-set-id={set.id}
      className="theme-radius flex w-full shrink-0 flex-col border border-border/70 bg-surface text-sm text-foreground"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className="flex flex-col gap-xs border-b border-border/70 bg-surface px-xl py-xl">
        <h3 className="text-sm font-medium leading-5">Questions</h3>
        <p className="text-xs leading-4 text-muted-foreground">
          Answer every question, then send the set back to the planning agent.
        </p>
      </div>

      <div className="flex flex-col gap-xl px-xl pt-xl">
        {set.questions.map((question) => {
          const draft = drafts[question.id] ?? { values: [], text: "" };
          const multi = question.kind === "multi";
          const disabled = otherAnswers(question, draft);
          return (
            <fieldset
              key={question.id}
              data-testid={`task-question-${question.id}`}
              className="flex min-w-0 flex-col gap-lg border-t border-border/70 pt-xl first:border-t-0 first:pt-0"
            >
              <legend className="min-w-0 float-left w-full text-sm font-medium leading-5 [overflow-wrap:anywhere]">
                {question.prompt}
              </legend>
              {question.kind === "text" ? (
                <textarea
                  aria-label={question.prompt}
                  data-testid={`question-${question.id}-text`}
                  rows={2}
                  value={draft.text}
                  onChange={(event) => updateText(question, event.target.value)}
                  placeholder="Type your answer"
                  className="theme-radius w-full resize-y border border-border/70 bg-background px-lg py-md text-sm leading-5 text-foreground outline-none focus-visible:ring-1 focus-visible:ring-foreground"
                />
              ) : (
                <div className="flex flex-col gap-xs">
                  {(question.options ?? []).map((option) => (
                    <OptionRow
                      key={option.value}
                      question={question}
                      option={option}
                      checked={draft.values.includes(option.value)}
                      disabled={disabled}
                      multi={multi}
                      onToggle={() => toggle(question, option.value)}
                    />
                  ))}
                </div>
              )}
              {question.kind !== "text" && question.allowOther === true && (
                <input
                  type="text"
                  aria-label={`${question.prompt} free text`}
                  data-testid={`question-${question.id}-other`}
                  value={draft.text}
                  onChange={(event) => updateText(question, event.target.value)}
                  placeholder="Other (optional)"
                  className="theme-radius w-full border border-border/70 bg-background px-lg py-md text-sm leading-5 text-foreground outline-none focus-visible:ring-1 focus-visible:ring-foreground"
                />
              )}
            </fieldset>
          );
        })}

        {error !== null && (
          <p role="alert" className="text-xs leading-4 text-destructive">
            {error}
          </p>
        )}
      </div>

      <div className="mt-sm border-t border-border/70 bg-surface px-xl py-lg">
        <Button
          type="submit"
          data-testid="task-questions-send"
          disabled={busy || !ready}
          className="w-full sm:w-auto sm:self-end"
        >
          {busy ? "Sending…" : "Send answers"}
        </Button>
      </div>
    </form>
  );
}
