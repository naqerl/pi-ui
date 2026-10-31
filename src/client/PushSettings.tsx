import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "./lib/utils";

/**
 * The five states the settings row can show. The render path reads only these
 * props: permission, service-worker and push-manager lookups happen in the
 * connected component's effects and click handlers.
 */
export type PushRowState = "checking" | "unsupported" | "default" | "granted" | "denied";

export const PUSH_ROW_STATES: readonly PushRowState[] = [
  "checking",
  "unsupported",
  "default",
  "granted",
  "denied",
];

export interface PushSettingsRowProps {
  readonly state: PushRowState;
  readonly busy?: boolean;
  readonly onEnable?: () => void;
  readonly onDisable?: () => void;
}

function status(state: PushRowState, busy: boolean): string {
  if (busy) return "Busy — updating notification settings…";
  switch (state) {
    case "unsupported":
      return "Unsupported — push needs HTTPS or localhost";
    case "checking":
      return "Busy — checking notification support…";
    case "granted":
      return "On — notifications are enabled";
    case "denied":
      return "Denied — notifications are blocked in the browser";
    case "default":
      return "Off — get notified when pi needs you";
  }
}

/**
 * One compact menu row: the same title, type scale and padding as Theme and
 * Model, with the switch on the right and a single status line underneath.
 * The row itself carries no card because its menu neighbours do not.
 */
export function PushSettingsRow({
  state,
  busy = false,
  onEnable,
  onDisable,
}: PushSettingsRowProps) {
  const on = state === "granted";
  const action = on ? onDisable : onEnable;
  const disabled = busy || state === "checking" || state === "unsupported" || state === "denied";
  return (
    <div
      data-testid="push-settings-row"
      data-state={state}
      className="flex w-full min-w-0 items-center gap-3 px-3 py-2"
    >
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm">Notifications</p>
        <p
          data-testid="push-status"
          className="truncate text-[11px] leading-4 text-muted-foreground"
        >
          {status(state, busy)}
        </p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label="Notifications"
        data-testid="push-toggle"
        disabled={disabled}
        onClick={action}
        className="group grid size-11 shrink-0 place-items-center transition-opacity disabled:cursor-not-allowed disabled:opacity-50"
      >
        <span
          aria-hidden="true"
          className={cn(
            "relative block h-5 w-9 rounded-full border transition-colors",
            on
              ? "border-foreground bg-foreground"
              : "border-foreground/40 bg-transparent group-hover:border-foreground",
          )}
        >
          <span
            className={cn(
              "absolute top-0.5 left-0.5 size-4 rounded-full transition-transform",
              on ? "translate-x-4 bg-background" : "bg-foreground/60 group-hover:bg-foreground",
            )}
          />
        </span>
      </button>
    </div>
  );
}

/** Converts the base64url VAPID key into the bytes `applicationServerKey` expects. */
export function base64UrlToUint8Array(value: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const normalized = (value + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(normalized);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let index = 0; index < raw.length; index++) {
    bytes[index] = raw.charCodeAt(index);
  }
  return bytes;
}

function supported(): boolean {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

async function currentSubscription(): Promise<PushSubscription | null> {
  const registration = await navigator.serviceWorker.getRegistration();
  if (registration === undefined) return null;
  return registration.pushManager.getSubscription();
}

/**
 * Reads the browser state once, then enables or disables push. Only the pure
 * row above is rendered; every browser API call lives in an effect or handler.
 */
export function PushSettings() {
  const [state, setState] = useState<PushRowState>("checking");
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);

  const refresh = useCallback(async () => {
    if (!supported()) {
      if (alive.current) setState("unsupported");
      return;
    }
    if (Notification.permission === "denied") {
      if (alive.current) setState("denied");
      return;
    }
    try {
      const subscription = await currentSubscription();
      if (!alive.current) return;
      setState(subscription === null ? "default" : "granted");
    } catch {
      if (alive.current) setState("default");
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    void refresh();
    return () => {
      alive.current = false;
    };
  }, [refresh]);

  const enable = useCallback(async () => {
    if (!supported()) {
      setState("unsupported");
      return;
    }
    setBusy(true);
    try {
      const permission = await Notification.requestPermission();
      if (permission === "denied") {
        setState("denied");
        return;
      }
      if (permission !== "granted") {
        setState("default");
        return;
      }

      const response = await fetch("/api/push/key", { cache: "no-store" });
      if (!response.ok) throw new Error("could not read the push key");
      const data = (await response.json()) as { key?: unknown };
      if (typeof data.key !== "string" || data.key.length === 0) {
        throw new Error("the push key is missing");
      }

      const registration = await navigator.serviceWorker.ready;
      let subscription = await registration.pushManager.getSubscription();
      if (subscription === null) {
        subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: base64UrlToUint8Array(data.key),
        });
      }
      const posted = await fetch("/api/push/subscribe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(subscription.toJSON()),
      });
      if (!posted.ok) throw new Error("could not store the push subscription");
      if (alive.current) setState("granted");
    } catch {
      if (alive.current) setState("default");
    } finally {
      if (alive.current) setBusy(false);
    }
  }, []);

  const disable = useCallback(async () => {
    setBusy(true);
    try {
      const subscription = await currentSubscription();
      if (subscription !== null) {
        const endpoint = subscription.endpoint;
        await subscription.unsubscribe();
        await fetch("/api/push/subscribe", {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ endpoint }),
        });
      }
      if (alive.current) setState("default");
    } catch {
      if (alive.current) setState("default");
    } finally {
      if (alive.current) setBusy(false);
    }
  }, []);

  return (
    <PushSettingsRow
      state={state}
      busy={busy}
      onEnable={() => void enable()}
      onDisable={() => void disable()}
    />
  );
}
