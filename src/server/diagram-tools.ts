import {
  defineTool,
  type ToolExecutionResult,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { DIAGRAM_FORMAT } from "../shared/diagrams.js";
import type { Diagram } from "./diagrams.js";
import { DiagramError, type DiagramStore, MAX_DIAGRAM_BYTES } from "./diagrams.js";

/** The diagram store and the hook that tells open browsers a drawing changed. */
export interface DiagramBridge {
  readonly store: DiagramStore;
  publish(diagram: Diagram): void;
}

const titleSchema = Type.Optional(
  Type.String({
    description: "Short label shown above the drawing. Keep it under a sentence.",
    maxLength: 200,
  }),
);

const sourceSchema = Type.String({
  description: `Mermaid diagram source. At most ${MAX_DIAGRAM_BYTES / 1024} kB.`,
});

function failure(error: unknown): ToolExecutionResult {
  const message =
    error instanceof DiagramError
      ? error.message
      : `The diagram could not be saved: ${error instanceof Error ? error.message : String(error)}`;
  return { output: [{ type: "text", text: message }], isError: true };
}

function saved(diagram: Diagram, title?: string): ToolExecutionResult {
  const url = `/api/diagrams/${diagram.id}`;
  return {
    output: [
      {
        type: "text",
        text: JSON.stringify({
          id: diagram.id,
          url,
          revision: diagram.revision,
          ...(title === undefined ? {} : { title }),
        }),
      },
    ],
    details: {
      diagram: { id: diagram.id, revision: diagram.revision },
      ...(title === undefined ? {} : { title }),
    },
  };
}

/**
 * Draws a diagram and revises one by id. The chat renders it from the stored source; only the
 * `{id, revision}` part goes into the transcript, so a replace updates the original message.
 */
export function createDiagramTools(bridge: DiagramBridge): ToolRegistration[] {
  return [
    defineTool({
      name: "draw_diagram",
      description:
        "Draw a Mermaid diagram in the chat and return its id. Use it for flows, sequences, states, classes, ER and other diagrams. The chat shows the drawing as part of your reply. Save the id from the result so you can revise it later with replace_diagram.",
      parameters: Type.Object({
        source: sourceSchema,
        title: titleSchema,
      }),
      async execute(args) {
        try {
          const diagram = await bridge.store.create(args.source, DIAGRAM_FORMAT);
          bridge.publish(diagram);
          return saved(diagram, typeof args.title === "string" ? args.title.trim() : undefined);
        } catch (error) {
          return failure(error);
        }
      },
    }),
    defineTool({
      name: "replace_diagram",
      description:
        "Replace a diagram drawn earlier with new Mermaid source. The message that showed the old drawing now shows the new one, and the revision increases. Use the id from draw_diagram or an earlier replace_diagram result.",
      parameters: Type.Object({
        id: Type.String({ description: "Diagram id returned by draw_diagram." }),
        source: sourceSchema,
      }),
      async execute(args) {
        try {
          const diagram = await bridge.store.replace(args.id, args.source);
          bridge.publish(diagram);
          return saved(diagram);
        } catch (error) {
          return failure(error);
        }
      },
    }),
  ];
}
