import type { StreamFrame } from "../shared/types.js";

/** One server-sent event frame. Event names are the browser protocol in `src/client/use-chat.ts`. */
export type SseFrame = StreamFrame;
