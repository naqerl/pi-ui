export const PLAN_TASK_DRAFT_KEY = "pi-ui:plan-task-draft";

type SessionStore = Pick<Storage, "getItem" | "setItem">;

function browserSession(): SessionStore | undefined {
  try {
    return typeof sessionStorage === "undefined" ? undefined : sessionStorage;
  } catch {
    return undefined;
  }
}

export function readPlanTaskDraft(storage: SessionStore | undefined = browserSession()): boolean {
  try {
    return storage?.getItem(PLAN_TASK_DRAFT_KEY) !== "0";
  } catch {
    return true;
  }
}

export function writePlanTaskDraft(
  value: boolean,
  storage: SessionStore | undefined = browserSession(),
): void {
  try {
    storage?.setItem(PLAN_TASK_DRAFT_KEY, value ? "1" : "0");
  } catch {}
}
