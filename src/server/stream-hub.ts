import type { SseFrame } from "./sse.js";

export interface StreamClient {
  send(frame: SseFrame): Promise<void>;
}

export class StreamHub {
  private readonly clients = new Set<StreamClient>();

  add(client: StreamClient): void {
    this.clients.add(client);
  }

  remove(client: StreamClient): void {
    this.clients.delete(client);
  }

  broadcast(frames: SseFrame | SseFrame[]): void {
    const list = Array.isArray(frames) ? frames : [frames];
    for (const client of this.clients) {
      void this.deliver(client, list);
    }
  }

  private async deliver(client: StreamClient, frames: SseFrame[]): Promise<void> {
    try {
      for (const frame of frames) {
        await client.send(frame);
      }
    } catch {
      this.clients.delete(client);
    }
  }
}
