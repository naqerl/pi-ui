import { Badge } from "./components/ui/badge";
import { cn } from "./lib/utils";

/** The compact chip that says this task's plan agent has a live run right now. */
export function TaskPlanningBadge({ testId, className }: { testId: string; className?: string }) {
  return (
    <Badge
      variant="outline"
      data-testid={testId}
      title="The plan agent is running"
      className={cn(
        "border-border/70 px-1.5 text-[10px] font-normal leading-4 text-muted-foreground",
        className,
      )}
    >
      Planning
    </Badge>
  );
}

/** The compact chip that says the plan agent is waiting for an answer on this task. */
export function TaskQuestionsBadge({
  testId,
  count,
  className,
}: {
  testId: string;
  count: number;
  className?: string;
}) {
  return (
    <Badge
      variant="outline"
      data-testid={testId}
      title={`${count} question${count === 1 ? "" : "s"} waiting for an answer`}
      className={cn(
        "border-border/70 px-1.5 text-[10px] font-normal leading-4 text-muted-foreground",
        className,
      )}
    >
      {count} question{count === 1 ? "" : "s"}
    </Badge>
  );
}
