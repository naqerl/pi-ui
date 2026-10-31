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

function description(state: PushRowState): string {
  switch (state) {
    case "unsupported":
      return "Push needs a secure context (HTTPS or localhost).";
    case "checking":
      return "Checking notification support…";
    case "granted":
      return "Notifications on";
    case "denied":
      return "Notifications blocked in the browser";
    case "default":
      return "Get a system notification when pi needs you.";
  }
}

/** One card-styled row, so its height does not jump when the state changes. */
export function PushSettingsRow({
  state,
  busy = false,
  onEnable,
  onDisable,
}: PushSettingsRowProps) {
  const canEnable = state === "default" && onEnable !== undefined;
  const canDisable = state === "granted" && onDisable !== undefined;
  return (
    <div
      data-testid="push-settings-row"
      data-state={state}
      className="ink-line theme-radius flex min-h-[64px] items-center gap-3 border bg-surface px-3 py-2"
    >
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm">Notifications</p>
        <p className="line-clamp-2 min-h-[2.4em] text-[11px] leading-snug text-muted-foreground">
          {description(state)}
        </p>
      </div>
      <div className="flex w-[8.5rem] shrink-0 justify-end">
        {canEnable && (
          <button
            type="button"
            disabled={busy}
            onClick={onEnable}
            className="theme-radius border border-border bg-foreground px-2.5 py-1 text-xs font-medium text-background transition-colors hover:bg-foreground/90 disabled:opacity-50"
          >
            {busy ? "Enabling…" : "Enable notifications"}
          </button>
        )}
        {canDisable && (
          <button
            type="button"
            disabled={busy}
            onClick={onDisable}
            className="theme-radius border border-border bg-background px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-50"
          >
            {busy ? "Turning off…" : "Turn off"}
          </button>
        )}
        {!canEnable && !canDisable && (
          <span
            aria-hidden="true"
            className={cn("block h-7 w-full", state === "granted" ? "bg-transparent" : "")}
          />
        )}
      </div>
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
