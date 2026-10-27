/** One server-sent event frame. Event names are the browser protocol in `src/client/use-chat.ts`. */
export interface SseFrame {
  event: string;
  data: unknown;
}
