import { Badge } from "./components/ui/badge";
import { cn } from "./lib/utils";

export function TaskPlanningBadge({ testId, className }: { testId: string; className?: string }) {
  return (
    <Badge
      variant="outline"
      data-testid={testId}
      title="The plan agent is running"
      className={cn(
        "border-border/70 px-md text-[10px] font-normal leading-4 text-muted-foreground",
        className,
      )}
    >
      Planning
    </Badge>
  );
}
