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
