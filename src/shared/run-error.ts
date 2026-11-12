import type { RunError } from "./types.js";

/** One line is enough for the header; the full provider text stays in the dialog. */
const SUMMARY_LIMIT = 160;

const NO_MODEL_MESSAGE =
  "pi has no model configured for this conversation. Add provider credentials to " +
  "PI_CODING_AGENT_DIR/auth.json, then send the message again.";

/** A deliberate stop or reset is not a failure the operator needs to dismiss. */
const SILENT_REASONS = new Set(["aborted", "reset", "merged_into_mcp_notice"]);

function detailText(detail: unknown): string | undefined {
  if (typeof detail === "string") {
    const text = detail.trim();
    return text.length === 0 ? undefined : text;
  }
  if (detail === undefined || detail === null) return undefined;
  try {
    return JSON.stringify(detail);
  } catch {
    return String(detail);
  }
}

function summary(text: string): string {
  const line =
    text
      .split(/\r?\n/)
      .find((candidate) => candidate.trim().length > 0)
      ?.replace(/\s+/g, " ")
      .trim() ?? text.replace(/\s+/g, " ").trim();
  if (line.length === 0) return "The plan run failed.";
  return line.length <= SUMMARY_LIMIT ? line : `${line.slice(0, SUMMARY_LIMIT - 1)}…`;
}

/**
 * The error the plan chat shows when a run settles without an answer.
 *
 * `id` is supplied by the caller so it can tie the row to the task and durable
 * submission; the reason vocabulary matches `steerDropReason`.
 */
export function runErrorFromUnanswered(
  reason: string,
  detail?: unknown,
  id?: string,
): RunError | null {
  const text = detailText(detail);
  const errorId = id ?? `task-run-error-${Date.now().toString(36)}`;
  const at = new Date().toISOString();
  switch (reason) {
    case "model_error": {
      const full = text ?? "The model request failed.";
      return {
        id: errorId,
        class: "ModelError",
        message: summary(full),
        detail: full,
        at,
      };
    }
    case "no_model": {
      const full = text ?? NO_MODEL_MESSAGE;
      return {
        id: errorId,
        class: "NoModelError",
        message: summary(full),
        detail: full,
        at,
      };
    }
    default: {
      if (SILENT_REASONS.has(reason)) return null;
      const full = text ?? `The plan run ended without an answer (${reason}).`;
      return {
        id: errorId,
        class: "RunError",
        message: summary(full),
        detail: full,
        at,
      };
    }
  }
}

/** True only when an explicit dismiss id targets the run error currently shown. */
export function runErrorMatchesDismissal(
  id: string | undefined,
  runError: RunError | null,
): boolean {
  return id !== undefined && runError !== null && id === runError.id;
}
