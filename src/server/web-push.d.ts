declare module "web-push" {
  export interface PushSubscription {
    endpoint: string;
    keys: { p256dh: string; auth: string };
  }

  export interface VapidDetails {
    subject: string;
    publicKey: string;
    privateKey: string;
  }

  export interface SendResult {
    statusCode: number;
    body: string;
    headers: Record<string, string>;
  }

  export interface RequestOptions {
    vapidDetails?: VapidDetails;
    TTL?: number;
    timeout?: number;
    headers?: Record<string, string>;
  }

  export class WebPushError extends Error {
    statusCode: number;
    body?: string;
  }

  export function sendNotification(
    subscription: PushSubscription,
    payload?: string | Buffer,
    options?: RequestOptions,
  ): Promise<SendResult>;

  export function setVapidDetails(subject: string, publicKey: string, privateKey: string): void;

  interface WebPush {
    sendNotification: typeof sendNotification;
    setVapidDetails: typeof setVapidDetails;
    WebPushError: typeof WebPushError;
  }

  const webpush: WebPush;
  export default webpush;
}
