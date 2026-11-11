import type { ChatMessage, Task } from "../shared/types";

export const FIXTURE_PLAN_ID = "fixture-plan";
export const FIXTURE_BLOCKER_ID = "fixture-blocker";
export const FIXTURE_SUB_A_ID = "fixture-sub-a";
export const FIXTURE_SUB_B_ID = "fixture-sub-b";

const CREATED = "2026-11-11T09:14:00.000Z";
const SUB_DONE = "2026-11-11T15:40:00.000Z";

const PLAN_BODY = `## Goal

Break the task details pane into cards so a phone can scan the title, the plan, and blockers without fighting the planning chat.

\`\`\`mermaid
flowchart LR
  composer[Composer] --> task[Task]
  task --> agent[Plan agent]
  agent --> design[Design]
  design --> review[Review]
\`\`\`

The body stays editable, and the mermaid figure uses the same diagram pipeline as chat.
`;

function base(partial: Partial<Task> & Pick<Task, "id" | "title" | "status">): Task {
  return {
    parentId: null,
    blockedBy: [],
    createdAt: CREATED,
    completedAt: null,
    completion: null,
    createdBy: "operator",
    project: "pi-ui",
    ...partial,
  };
}

export function fixtureTasks(): Task[] {
  return [
    base({
      id: FIXTURE_BLOCKER_ID,
      title: "Ship the mobile navigation overhaul",
      status: "open",
      body: "Finish the navigation pass before the details redesign lands.",
    }),
    base({
      id: FIXTURE_PLAN_ID,
      title:
        "Design a card-based task details view that stays readable on a 390px phone and does not waste the desktop composer column",
      status: "open",
      blockedBy: [FIXTURE_BLOCKER_ID],
      body: PLAN_BODY,
    }),
    base({
      id: FIXTURE_SUB_A_ID,
      title: "Write the interaction notes",
      status: "open",
      parentId: FIXTURE_PLAN_ID,
    }),
    base({
      id: FIXTURE_SUB_B_ID,
      title: "Review the mermaid flow",
      status: "done",
      parentId: FIXTURE_PLAN_ID,
      completedAt: SUB_DONE,
      completion: { evidence: "The mermaid figure renders with the shared pipeline." },
    }),
  ];
}

export function mergeFixtureTasks(tasks: Task[]): Task[] {
  const incoming = new Set(tasks.map((task) => task.id));
  const extra = fixtureTasks().filter((task) => !incoming.has(task.id));
  return [...extra, ...tasks];
}

export const FIXTURE_CHAT: ChatMessage[] = [
  {
    id: "fixture-msg-1",
    role: "user",
    text: "Draft a plan for the card-based task details view. Keep every current function.",
    timestamp: "2026-11-11T16:02:00.000Z",
    order: 1,
  },
  {
    id: "fixture-msg-2",
    role: "assistant",
    text: "I would split the pane into a header card, a plan card for the markdown and mermaid, a relationships card for blockers and subtasks, and a planning chat card with its own input. Actions stay together so they remain easy to hit on a phone.",
    timestamp: "2026-11-11T16:02:08.000Z",
    order: 2,
  },
  {
    id: "fixture-msg-3",
    role: "user",
    text: "Show the flow in the task body, and keep the composer in the list column on desktop.",
    timestamp: "2026-11-11T16:03:10.000Z",
    order: 3,
  },
  {
    id: "fixture-msg-4",
    role: "assistant",
    text: "The mermaid in the body now shows composer to task to plan agent to design to review. On a wide screen the new-task composer stays docked under the list, so the details column can use the full remaining height.",
    timestamp: "2026-11-11T16:03:22.000Z",
    order: 4,
  },
];
